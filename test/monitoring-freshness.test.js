'use strict';

/**
 * Reanálise offline de posições ativas com validação de frescura (My List).
 *
 * Cobre:
 *  (a) DB — `checkMonitoringFreshness()`: compara MAX(date) local dos ativos
 *      em `investment_monitoring_universe` (historical_prices) com a última
 *      sessão útil esperada (`getLastExpectedTradingDay`). Determinístico:
 *      velas antigas (2020) → desatualizado; velas futuras (2099) → fresco;
 *      sem ativos em monitorização → fresco por definição (nada a validar).
 *  (b) DB — reanálise offline (`evaluateMonitoringAssetsDaily`) resolve
 *      TARGET/STOP/EXPIRADO e atualiza `current_price`/`pnl_pct` só com
 *      dados locais.
 *  (c) IPC/PRELOAD estático — handlers `check-monitoring-freshness` e
 *      `reanalyze-monitoring-positions` no main.js (com guarda `!db`) e os
 *      dois métodos expostos nos 2 bridges do preload.js.
 *  (d) RENDERER estático — o clique em "Reanalisar Posições Ativas" invoca
 *      `checkMonitoringFreshness`, interrompe com o alerta exigido quando
 *      `isUpdated === false` e, em caso de sucesso, dispara a reanálise
 *      offline (`reanalyze-monitoring-positions`) — nunca mais o canal de
 *      rede `trade:update`.
 *
 * Rede real: nenhuma. SQLite sempre temporário e `QUANT_TRACKER_DB_PATH`
 * apontado para um diretório temporário.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { makeTempDir, removeTempDir } = require('./helpers');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

let DB = null;
let SQLITE_AVAILABLE = false;
try {
  require('better-sqlite3');
  DB = require('../src/db/database');
  SQLITE_AVAILABLE = true;
} catch (_) {
  // ABI nativo indisponível: os testes de DB ficam em skip.
}

// Isola o sync do tracker canónico: os testes nunca escrevem no quant_tracker.db real.
const NOSYNC_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'test-monitoring-fresh-nosync-'));
const ORIGINAL_QUANT_TRACKER_DB_PATH = process.env.QUANT_TRACKER_DB_PATH;
process.env.QUANT_TRACKER_DB_PATH = path.join(NOSYNC_DIR, 'quant_tracker.db');

test.after(() => {
  if (ORIGINAL_QUANT_TRACKER_DB_PATH === undefined) {
    delete process.env.QUANT_TRACKER_DB_PATH;
  } else {
    process.env.QUANT_TRACKER_DB_PATH = ORIGINAL_QUANT_TRACKER_DB_PATH;
  }
  removeTempDir(NOSYNC_DIR);
});

// ── helpers determinísticos ────────────────────────────────────────────
function insertCandle(db, ticker, date, values) {
  const candle = { open: values.close, high: values.close, low: values.close, volume: 1000, ...values };
  db.db.prepare(
    'INSERT INTO historical_prices (ticker, date, open, high, low, close, volume) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(ticker, date, candle.open, candle.high, candle.low, candle.close, candle.volume);
}

function insertMonitoringRecord(db, row) {
  const record = {
    ticker: 'AAA',
    company_name: 'AAA Corp',
    direction: 'COMPRA',
    entry_price: 100,
    target_price: 110,
    stop_loss: 95,
    current_price: 100,
    analysis_date: '2026-01-05',
    status: 'MONITORIZANDO',
    ...row
  };
  db.db.prepare(`
    INSERT INTO investment_monitoring_universe (
      ticker, company_name, direction, entry_price, target_price, stop_loss,
      current_price, analysis_date, status
    ) VALUES (
      @ticker, @company_name, @direction, @entry_price, @target_price, @stop_loss,
      @current_price, @analysis_date, @status
    )
  `).run(record);
}

// ── (a) checkMonitoringFreshness ───────────────────────────────────────
test('DB freshness: universo vazio devolve isUpdated true e maxStoredDate null', { skip: !SQLITE_AVAILABLE }, async () => {
  const dir = makeTempDir('test-monitoring-fresh-empty-');
  let db;
  try {
    db = new DB(dir);
    await db.init();

    const freshness = db.checkMonitoringFreshness();
    assert.deepEqual(freshness, {
      isUpdated: true,
      maxStoredDate: null,
      expectedDate: db.getLastExpectedTradingDay()
    });
  } finally {
    if (db) db.close();
    removeTempDir(dir);
  }
});

test('DB freshness: cotações desatualizadas → isUpdated false com datas corretas', { skip: !SQLITE_AVAILABLE }, async () => {
  const dir = makeTempDir('test-monitoring-fresh-stale-');
  let db;
  try {
    db = new DB(dir);
    await db.init();

    insertMonitoringRecord(db, { ticker: 'OLD1' });
    insertMonitoringRecord(db, { ticker: 'OLD2' });
    insertCandle(db, 'OLD1', '2020-01-02', { open: 10, high: 11, low: 9, close: 10.5 });
    // OLD2 sem velas não deve impedir o MAX global nem fabricar datas.
    insertCandle(db, 'OLD1', '2020-01-03', { open: 10.5, high: 11, low: 10, close: 10.2 });
    // Vela de ativo fora da monitorização não deve contar para o MAX.
    insertCandle(db, 'OTHER', '2099-12-31', { open: 1, high: 1, low: 1, close: 1 });

    const freshness = db.checkMonitoringFreshness();
    assert.equal(freshness.isUpdated, false);
    assert.equal(freshness.maxStoredDate, '2020-01-03');
    assert.equal(freshness.expectedDate, db.getLastExpectedTradingDay());
    assert.ok(freshness.maxStoredDate < freshness.expectedDate);
  } finally {
    if (db) db.close();
    removeTempDir(dir);
  }
});

test('DB freshness: cotações em dia → isUpdated true', { skip: !SQLITE_AVAILABLE }, async () => {
  const dir = makeTempDir('test-monitoring-fresh-updated-');
  let db;
  try {
    db = new DB(dir);
    await db.init();

    insertMonitoringRecord(db, { ticker: 'NEW1' });
    insertCandle(db, 'NEW1', '2099-12-31', { open: 1, high: 1, low: 1, close: 1 });

    const freshness = db.checkMonitoringFreshness();
    assert.equal(freshness.isUpdated, true);
    assert.equal(freshness.maxStoredDate, '2099-12-31');
    assert.equal(freshness.expectedDate, db.getLastExpectedTradingDay());
  } finally {
    if (db) db.close();
    removeTempDir(dir);
  }
});

test('DB freshness: registos sem velas locais não bloqueiam a reanálise', { skip: !SQLITE_AVAILABLE }, async () => {
  const dir = makeTempDir('test-monitoring-fresh-nocandles-');
  let db;
  try {
    db = new DB(dir);
    await db.init();

    insertMonitoringRecord(db, { ticker: 'NODATA' });

    const freshness = db.checkMonitoringFreshness();
    assert.equal(freshness.isUpdated, true);
    assert.equal(freshness.maxStoredDate, null);
  } finally {
    if (db) db.close();
    removeTempDir(dir);
  }
});

// ── (b) Reanálise 100% offline (motor local) ───────────────────────────
test('DB reanálise offline: só SQLite local — Target/Stop/Expirado e current_price atualizados', { skip: !SQLITE_AVAILABLE }, async () => {
  const dir = makeTempDir('test-monitoring-fresh-engine-');
  let db;
  try {
    db = new DB(dir);
    await db.init();

    // analysis_date antiga (40 dias) com velas locais: window [-40d, -5d].
    const oldDate = new Date(Date.now() - 40 * 86400000).toISOString().split('T')[0];
    insertMonitoringRecord(db, { ticker: 'TGT', entry_price: 100, target_price: 110, stop_loss: 95, analysis_date: oldDate });
    insertMonitoringRecord(db, { ticker: 'STP', entry_price: 100, target_price: 200, stop_loss: 90, analysis_date: oldDate });
    insertMonitoringRecord(db, { ticker: 'EXP', entry_price: 100, target_price: 999, stop_loss: 1, analysis_date: oldDate });

    insertCandle(db, 'TGT', new Date(Date.now() - 39 * 86400000).toISOString().split('T')[0], { open: 100, high: 111, low: 99, close: 105 });
    insertCandle(db, 'STP', new Date(Date.now() - 39 * 86400000).toISOString().split('T')[0], { open: 100, high: 101, low: 89, close: 92 });
    insertCandle(db, 'EXP', new Date(Date.now() - 39 * 86400000).toISOString().split('T')[0], { open: 100, high: 102, low: 98, close: 101 });

    const res = db.evaluateMonitoringAssetsDaily();
    assert.deepEqual(res, { updatedCount: 3, resolvedCount: 3 });

    const rows = {};
    for (const row of db.db.prepare('SELECT * FROM investment_monitoring_universe').all()) {
      rows[row.ticker] = row;
    }
    assert.equal(rows.TGT.status, 'TARGET_ATINGIDO');
    assert.equal(rows.TGT.exit_price, 110);
    assert.equal(rows.STP.status, 'STOP_ATINGIDO');
    assert.equal(rows.STP.exit_price, 90);
    assert.equal(rows.EXP.status, 'EXPIRADO');
    assert.equal(rows.TGT.pnl_pct, 10);
    assert.equal(rows.STP.pnl_pct, -10);
  } finally {
    if (db) db.close();
    removeTempDir(dir);
  }
});

// ── (c) IPC / PRELOAD estático ─────────────────────────────────────────
test('IPC/preload: handlers de frescura e reanálise offline com guarda !db e métodos nos 2 bridges', () => {
  const main = read('main.js');
  const preload = read('preload.js');

  assert.match(main, /ipcMain\.handle\(['"]check-monitoring-freshness['"]/);
  assert.match(main, /ipcMain\.handle\(['"]reanalyze-monitoring-positions['"]/);
  assert.match(main, /db\.checkMonitoringFreshness\(\)/);

  // Reanálise offline = motor local + analytics; sem qualquer rede.
  const reanalyzeBlock = main.slice(
    main.indexOf("ipcMain.handle('reanalyze-monitoring-positions'"),
    main.indexOf("ipcMain.handle('reanalyze-monitoring-positions'") + 700
  );
  assert.match(reanalyzeBlock, /if \(!db\)\s*\{/);
  assert.match(reanalyzeBlock, /db\.evaluateMonitoringAssetsDaily\(\)/);
  assert.match(reanalyzeBlock, /db\.getMonitoringAnalytics\(\)/);
  assert.match(reanalyzeBlock, /return \{ success: true, \.\.\.res, analytics \};/);

  const freshBlock = main.slice(
    main.indexOf("ipcMain.handle('check-monitoring-freshness'"),
    main.indexOf("ipcMain.handle('check-monitoring-freshness'") + 700
  );
  assert.match(freshBlock, /if \(!db\)\s*\{/);
  assert.match(freshBlock, /isUpdated: false/);

  const freshPattern = /checkMonitoringFreshness:\s*\(\)\s*=>\s*ipcRenderer\.invoke\(['"]check-monitoring-freshness['"]\)/g;
  const reanalyzePattern = /reanalyzeMonitoringPositions:\s*\(\)\s*=>\s*ipcRenderer\.invoke\(['"]reanalyze-monitoring-positions['"]\)/g;
  assert.equal((preload.match(freshPattern) || []).length, 2, 'checkMonitoringFreshness nos 2 bridges');
  assert.equal((preload.match(reanalyzePattern) || []).length, 2, 'reanalyzeMonitoringPositions nos 2 bridges');
});

// ── (d) RENDERER estático ──────────────────────────────────────────────
test('Renderer: reanalisarTrades valida frescura, alerta quando desatualizado e usa a reanálise offline', () => {
  const renderer = read('renderer/renderer.js');

  const fnStart = renderer.indexOf('async function reanalisarTrades()');
  assert.ok(fnStart > 0, 'reanalisarTrades existe');
  const fnEnd = renderer.indexOf('async function', fnStart + 10);
  const fn = renderer.slice(fnStart, fnEnd > 0 ? fnEnd : renderer.length);

  // 1) Validação prévia de frescura no clique
  assert.match(fn, /api\.checkMonitoringFreshness\(\)/);
  assert.match(fn, /freshness\.isUpdated === false/);

  // 2) Alerta exigido quando desatualizado (topo + toast)
  assert.match(fn, /Cotações desatualizadas/);
  assert.match(fn, /Última: \$\{freshness\.maxStoredDate \|\| '—'\}/);
  assert.match(fn, /Esperada: \$\{freshness\.expectedDate \|\| '—'\}/);
  assert.match(fn, /aba 'My List' e clica em 'Mais Recente' para sincronizar antes de reanalisar/);
  assert.match(fn, /showToast\(warn/);

  // 3) Sucesso dispara a reanálise offline — nunca mais o canal de rede
  assert.match(fn, /api\.reanalyzeMonitoringPositions\(\)/);
  assert.doesNotMatch(fn, /updateTrades\(\)/);

  // 4) Atualiza tabela e gráficos de desempenho imediatamente
  assert.match(fn, /await loadPortfolio\(\)/);
  assert.match(fn, /renderMonitoringDashboard\(res\.analytics\)/);
});

test('Renderer: index.html mantém o botão "Reanalisar Posições Ativas" ligado a btn-reanalisar', () => {
  const html = read('renderer/index.html');
  assert.match(html, /id="btn-reanalisar"/);
  assert.match(html, /Reanalisar Posições Ativas/);
});
