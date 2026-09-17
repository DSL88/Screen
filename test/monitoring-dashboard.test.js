'use strict';

/**
 * Matriz determinística do motor de avaliação diária e do dashboard gráfico de
 * monitorização (substitui a antiga tabela `monitoring-universe-*`).
 *
 *  (a) DB MOTOR — `evaluateMonitoringAssetsDaily()`: TARGET/STOP/EXPIRADO em
 *      COMPRA e VENDA, pendente e sem histórico, primeiro toque por ordem ASC
 *      na janela de 35 dias, `exit_price`/`exit_date`/`pnl_pct` exatos,
 *      contagens `updatedCount`/`resolvedCount` e idempotência da 2ª execução
 *      (resolvidos não mudam). Os casos de fronteira F1-F11 vivem em
 *      `monitoring-engine-hardening.test.js`.
 *  (b) DB ANALYTICS — `getMonitoringAnalytics()`: KPIs, `avgPnl` só de fechados
 *      com PnL finito, tiers 50-54/55-59/60-64/65-69/70+ (fronteira 54.99 vs
 *      55.0), `sectorFailureAnalysis` ordenado por failRate desc e setor null
 *      agregado em `Geral`; universo vazio a zeros.
 *  (c) IPC/PRELOAD — handlers `evaluate-monitoring-daily`/`get-monitoring-data`
 *      com guarda `!db` e resposta `{ success, analytics }`; métodos
 *      `evaluateMonitoringDaily`/`getMonitoringData` nos 2 bridges.
 *  (d) UI — IDs novos presentes / antigos ausentes; contrato estático de
 *      `renderMonitoringDashboard` (Chart.js opcional, destroy no re-render,
 *      doughnut + barras horizontal, escapeHtml, alias e botão com finally) e
 *      execução pura do render com DOM falso determinístico (KPIs, gráficos,
 *      re-render, XSS e estado vazio).
 *
 * Rede real: nenhuma. SQLite sempre temporário e `QUANT_TRACKER_DB_PATH`
 * apontado para diretório temporário inexistente (os testes nunca escrevem no
 * `quant_tracker.db` canónico).
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
  // ABI nativo indisponível: os testes de DB são marcados como skip.
}

// Isola o sync do tracker canónico: os testes nunca escrevem no quant_tracker.db real.
const NOSYNC_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'test-monitoring-nosync-'));
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
const DAY_MS = 86400000;
const todayIso = () => new Date().toISOString().split('T')[0];
const isoDayOffset = (days) => new Date(Date.now() + days * DAY_MS).toISOString().split('T')[0];

function asset(ticker, overrides = {}) {
  return {
    ticker,
    company_name: `${ticker} Corp`,
    country: 'PT',
    sector: 'Tecnologia',
    direction: 'COMPRA',
    current_price: 100,
    target_price: 110,
    stop_loss: 95,
    win_rate_mc: 60,
    cvar_95: 4,
    graham_score: 55,
    alpha_score: 70,
    ...overrides
  };
}

function insertCandle(db, ticker, date, values) {
  const candle = { open: values.close, high: values.close, low: values.close, volume: 1000, ...values };
  db.db.prepare(
    'INSERT INTO historical_prices (ticker, date, open, high, low, close, volume) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(ticker, date, candle.open, candle.high, candle.low, candle.close, candle.volume);
}

function rowsByTicker(db) {
  const rows = {};
  for (const row of db.db.prepare('SELECT * FROM investment_monitoring_universe').all()) {
    rows[row.ticker] = row;
  }
  return rows;
}

function insertMonitoringRecord(db, row) {
  const record = {
    company_name: row.ticker,
    country: 'PT',
    sector: 'Tecnologia',
    direction: 'COMPRA',
    entry_price: 100,
    target_price: 110,
    stop_loss: 95,
    current_price: 100,
    win_rate_mc: 60,
    cvar_95: 4,
    graham_score: 55,
    alpha_score: 70,
    analysis_date: '2026-01-05',
    status: 'MONITORIZANDO',
    exit_date: null,
    exit_price: null,
    pnl_pct: null,
    ...row
  };
  db.db.prepare(`
    INSERT INTO investment_monitoring_universe (
      ticker, company_name, country, sector, direction,
      entry_price, target_price, stop_loss, current_price,
      win_rate_mc, cvar_95, graham_score, alpha_score, analysis_date,
      status, exit_date, exit_price, pnl_pct
    ) VALUES (
      @ticker, @company_name, @country, @sector, @direction,
      @entry_price, @target_price, @stop_loss, @current_price,
      @win_rate_mc, @cvar_95, @graham_score, @alpha_score, @analysis_date,
      @status, @exit_date, @exit_price, @pnl_pct
    )
  `).run(record);
}

// ── (a) DB MOTOR ───────────────────────────────────────────────────────
test('DB motor: COMPRA/VENDA resolvem TARGET, STOP e EXPIRADO com PnL exato', { skip: !SQLITE_AVAILABLE }, async () => {
  const dir = makeTempDir('test-monitoring-engine-');
  let db;
  try {
    db = new DB(dir);
    await db.init();

    const today = todayIso();
    const oldDate = isoDayOffset(-40);

    // 8 ativos: 1 target, 1 stop, 1 expirado e 1 pendente por direção,
    // mais 1 sem histórico (falha isolada).
    const batch = [
      asset('BUY_TARGET', { direction: 'compra', current_price: 100, target_price: 110, stop_loss: 95, win_rate_mc: 60 }),
      asset('BUY_STOP', { current_price: 100, target_price: 110, stop_loss: 95, win_rate_mc: 55 }),
      asset('BUY_EXP', { current_price: 100, target_price: 200, stop_loss: 10, win_rate_mc: 52 }),
      asset('SELL_TARGET', { direction: 'VENDA', current_price: 100, target_price: 90, stop_loss: 105, win_rate_mc: 65 }),
      asset('SELL_STOP', { direction: 'VENDA', current_price: 100, target_price: 90, stop_loss: 105, win_rate_mc: 61 }),
      asset('SELL_EXP', { direction: 'VENDA', current_price: 100, target_price: 10, stop_loss: 999, win_rate_mc: 57 }),
      asset('BUY_PENDING', { current_price: 100, target_price: 120, stop_loss: 90, win_rate_mc: 58 }),
      asset('NO_HISTORY', { current_price: 50, target_price: 60, stop_loss: 40, win_rate_mc: 53 })
    ];
    assert.equal(db.saveQualifiedToMonitoring(batch), 8);

    // A expiração depende de uma analysis_date com >= 35 dias.
    const setDate = db.db.prepare('UPDATE investment_monitoring_universe SET analysis_date = ? WHERE ticker = ?');
    setDate.run(oldDate, 'BUY_EXP');
    setDate.run(oldDate, 'SELL_EXP');

    // Os tickers de monitorização são normalizados para maiúsculas no save;
    // as velas usam a mesma chave.
    insertCandle(db, 'BUY_TARGET', today, { open: 100, high: 112, low: 99, close: 108 });
    insertCandle(db, 'BUY_STOP', today, { open: 100, high: 101, low: 94, close: 96 });
    // BUY_EXP/SELL_EXP: janela [-40d, -5d]; a vela de hoje fica fora da janela.
    insertCandle(db, 'BUY_EXP', isoDayOffset(-39), { open: 100, high: 101, low: 99, close: 100 });
    insertCandle(db, 'BUY_EXP', isoDayOffset(-5), { open: 100, high: 103, low: 99, close: 101 });
    insertCandle(db, 'BUY_EXP', today, { open: 100, high: 104, low: 99, close: 103 });
    insertCandle(db, 'SELL_TARGET', today, { open: 100, high: 102, low: 89, close: 95 });
    insertCandle(db, 'SELL_STOP', today, { open: 100, high: 106, low: 95, close: 104 });
    insertCandle(db, 'SELL_EXP', isoDayOffset(-39), { open: 100, high: 101, low: 97, close: 100 });
    insertCandle(db, 'SELL_EXP', isoDayOffset(-5), { open: 99, high: 100, low: 96, close: 98 });
    insertCandle(db, 'SELL_EXP', today, { open: 99, high: 100, low: 90, close: 96 });
    insertCandle(db, 'BUY_PENDING', today, { open: 100, high: 104, low: 102, close: 103 });
    // NO_HISTORY fica sem velas de propósito.

    const first = db.evaluateMonitoringAssetsDaily();
    assert.deepEqual(first, { updatedCount: 7, resolvedCount: 6 });

    const rows = rowsByTicker(db);

    // COMPRA target: fecha ao preço-alvo e ganha +10%.
    assert.equal(rows.BUY_TARGET.status, 'TARGET_ATINGIDO');
    assert.equal(rows.BUY_TARGET.exit_price, 110);
    assert.equal(rows.BUY_TARGET.exit_date, today);
    assert.equal(rows.BUY_TARGET.pnl_pct, 10);
    assert.equal(rows.BUY_TARGET.current_price, 108);
    assert.equal(rows.BUY_TARGET.entry_price, 100);
    assert.equal(rows.BUY_TARGET.target_price, 110);
    assert.equal(rows.BUY_TARGET.stop_loss, 95);

    // COMPRA stop: fecha ao preço do stop e perde -5%.
    assert.equal(rows.BUY_STOP.status, 'STOP_ATINGIDO');
    assert.equal(rows.BUY_STOP.exit_price, 95);
    assert.equal(rows.BUY_STOP.exit_date, today);
    assert.equal(rows.BUY_STOP.pnl_pct, -5);

    // COMPRA expirado: fecha ao último close DENTRO da janela (a vela de hoje
    // está fora de [analysis_date, analysis_date+35d]).
    assert.equal(rows.BUY_EXP.status, 'EXPIRADO');
    assert.equal(rows.BUY_EXP.exit_price, 101);
    assert.equal(rows.BUY_EXP.exit_date, isoDayOffset(-5));
    assert.equal(rows.BUY_EXP.pnl_pct, 1);
    assert.equal(rows.BUY_EXP.current_price, 101, 'current_price é o último close da janela');
    assert.equal(rows.BUY_EXP.analysis_date, oldDate, 'analysis_date não é alterada pela avaliação');

    // VENDA target: ganha +10% com a queda.
    assert.equal(rows.SELL_TARGET.status, 'TARGET_ATINGIDO');
    assert.equal(rows.SELL_TARGET.exit_price, 90);
    assert.equal(rows.SELL_TARGET.exit_date, today);
    assert.equal(rows.SELL_TARGET.pnl_pct, 10);

    // VENDA stop: perde -5% com a subida.
    assert.equal(rows.SELL_STOP.status, 'STOP_ATINGIDO');
    assert.equal(rows.SELL_STOP.exit_price, 105);
    assert.equal(rows.SELL_STOP.pnl_pct, -5);

    // VENDA expirado: fecha ao último close da janela, +2%.
    assert.equal(rows.SELL_EXP.status, 'EXPIRADO');
    assert.equal(rows.SELL_EXP.exit_price, 98);
    assert.equal(rows.SELL_EXP.exit_date, isoDayOffset(-5));
    assert.equal(rows.SELL_EXP.pnl_pct, 2);
    assert.equal(rows.SELL_EXP.current_price, 98);

    // Pendente: só atualiza o preço corrente, sem fecho.
    assert.equal(rows.BUY_PENDING.status, 'MONITORIZANDO');
    assert.equal(rows.BUY_PENDING.current_price, 103);
    assert.equal(rows.BUY_PENDING.exit_price, null);
    assert.equal(rows.BUY_PENDING.exit_date, null);
    assert.equal(rows.BUY_PENDING.pnl_pct, null);

    // Sem histórico: ignorado por completo, sem bloquear os restantes.
    assert.equal(rows.NO_HISTORY.status, 'MONITORIZANDO');
    assert.equal(rows.NO_HISTORY.current_price, 50, 'sem velas o preço de entrada não é tocado');
    assert.equal(rows.NO_HISTORY.exit_price, null);
    assert.equal(rows.NO_HISTORY.pnl_pct, null);

    // Idempotência: a 2ª execução só revê o pendente e não altera os resolvidos.
    const resolvedBefore = db.db.prepare(
      "SELECT * FROM investment_monitoring_universe WHERE status != 'MONITORIZANDO' ORDER BY ticker ASC"
    ).all();
    const second = db.evaluateMonitoringAssetsDaily();
    assert.deepEqual(second, { updatedCount: 1, resolvedCount: 0 });
    const resolvedAfter = db.db.prepare(
      "SELECT * FROM investment_monitoring_universe WHERE status != 'MONITORIZANDO' ORDER BY ticker ASC"
    ).all();
    assert.deepEqual(resolvedAfter, resolvedBefore);
    assert.equal(rowsByTicker(db).BUY_PENDING.current_price, 103);
  } finally {
    if (db) db.close();
    removeTempDir(dir);
  }
});

test('DB motor: o primeiro toque por ordem ASC resolve e não é reescrito por toques tardios', { skip: !SQLITE_AVAILABLE }, async () => {
  const dir = makeTempDir('test-monitoring-priority-');
  let db;
  try {
    db = new DB(dir);
    await db.init();

    const analysis = isoDayOffset(-2);
    const firstDay = isoDayOffset(-2);
    const lastDay = todayIso();

    assert.equal(db.saveQualifiedToMonitoring([
      asset('PRI_BUY', { current_price: 100, target_price: 110, stop_loss: 95 }),
      asset('PRI_SELL', { direction: 'VENDA', current_price: 100, target_price: 90, stop_loss: 105 })
    ]), 2);
    const setDate = db.db.prepare('UPDATE investment_monitoring_universe SET analysis_date = ? WHERE ticker = ?');
    setDate.run(analysis, 'PRI_BUY');
    setDate.run(analysis, 'PRI_SELL');

    // No 1º dia só o stop da COMPRA e o target da VENDA são tocados; no dia
    // seguinte o outro lado também é tocado, mas já não reescreve o resultado.
    insertCandle(db, 'PRI_BUY', firstDay, { open: 100, high: 101, low: 94, close: 96 });
    insertCandle(db, 'PRI_BUY', lastDay, { open: 105, high: 112, low: 99, close: 111 });
    insertCandle(db, 'PRI_SELL', firstDay, { open: 100, high: 102, low: 89, close: 95 });
    insertCandle(db, 'PRI_SELL', lastDay, { open: 99, high: 106, low: 94, close: 104 });

    const result = db.evaluateMonitoringAssetsDaily();
    assert.deepEqual(result, { updatedCount: 2, resolvedCount: 2 });

    const rows = rowsByTicker(db);
    assert.equal(rows.PRI_BUY.status, 'STOP_ATINGIDO', 'o stop tocado no 1º dia prevalece');
    assert.equal(rows.PRI_BUY.exit_price, 95);
    assert.equal(rows.PRI_BUY.exit_date, firstDay, 'exit_date é a data da vela do primeiro toque');
    assert.equal(rows.PRI_BUY.pnl_pct, -5);

    assert.equal(rows.PRI_SELL.status, 'TARGET_ATINGIDO', 'o target tocado no 1º dia prevalece');
    assert.equal(rows.PRI_SELL.exit_price, 90);
    assert.equal(rows.PRI_SELL.exit_date, firstDay);
    assert.equal(rows.PRI_SELL.pnl_pct, 10);
  } finally {
    if (db) db.close();
    removeTempDir(dir);
  }
});

test('DB misto: válidos avaliados e persistidos, sem histórico fica pendente', { skip: !SQLITE_AVAILABLE }, async () => {
  const dir = makeTempDir('test-monitoring-mixed-');
  let db;
  try {
    db = new DB(dir);
    await db.init();

    const today = todayIso();
    const batch = [
      asset('MIX_OK', { current_price: 100, target_price: 110, stop_loss: 95, win_rate_mc: 60 }),
      asset('MIX_STOP', { current_price: 50, target_price: 60, stop_loss: 47, win_rate_mc: 55 }),
      asset('MIX_NODATA', { current_price: 30, target_price: 40, stop_loss: 25, win_rate_mc: 52 }),
      { ticker: '   ', current_price: 1, win_rate_mc: 60 },
      null
    ];
    assert.equal(db.saveQualifiedToMonitoring(batch), 3, 'sem ticker efetivo não persiste');

    // Só dois dos três têm cotações; o terceiro "falha" sem afetar os restantes.
    insertCandle(db, 'MIX_OK', today, { open: 100, high: 111, low: 99, close: 109 });
    insertCandle(db, 'MIX_STOP', today, { open: 50, high: 51, low: 46.5, close: 48 });

    const result = db.evaluateMonitoringAssetsDaily();
    assert.deepEqual(result, { updatedCount: 2, resolvedCount: 2 });

    const rows = rowsByTicker(db);
    assert.equal(rows.MIX_OK.status, 'TARGET_ATINGIDO');
    assert.equal(rows.MIX_OK.exit_price, 110);
    assert.equal(rows.MIX_OK.pnl_pct, 10);
    assert.equal(rows.MIX_STOP.status, 'STOP_ATINGIDO');
    assert.equal(rows.MIX_STOP.exit_price, 47);
    assert.equal(rows.MIX_STOP.pnl_pct, -6);
    assert.equal(rows.MIX_NODATA.status, 'MONITORIZANDO');
    assert.equal(rows.MIX_NODATA.current_price, 30);
    assert.equal(rows.MIX_NODATA.exit_price, null);
    assert.equal(rows.MIX_NODATA.pnl_pct, null);
  } finally {
    if (db) db.close();
    removeTempDir(dir);
  }
});

// ── (b) DB ANALYTICS ───────────────────────────────────────────────────
test('DB analytics: KPIs, avgPnl de fechados, tiers (54.99 vs 55.0) e setores', { skip: !SQLITE_AVAILABLE }, async () => {
  const dir = makeTempDir('test-monitoring-analytics-');
  let db;
  try {
    db = new DB(dir);
    await db.init();

    insertMonitoringRecord(db, { ticker: 'T1', sector: 'Tecnologia', status: 'TARGET_ATINGIDO', pnl_pct: 10, win_rate_mc: 52 });
    insertMonitoringRecord(db, { ticker: 'S1', sector: 'Tecnologia', status: 'STOP_ATINGIDO', pnl_pct: -5, win_rate_mc: 54.99 });
    insertMonitoringRecord(db, { ticker: 'T2', sector: 'Financeiro', status: 'TARGET_ATINGIDO', pnl_pct: 8, win_rate_mc: 55.0 });
    insertMonitoringRecord(db, { ticker: 'S2', sector: 'Financeiro', status: 'STOP_ATINGIDO', pnl_pct: -4, win_rate_mc: 57.5 });
    insertMonitoringRecord(db, { ticker: 'S3', sector: 'Financeiro', status: 'STOP_ATINGIDO', pnl_pct: null, win_rate_mc: 64.99 });
    insertMonitoringRecord(db, { ticker: 'T3', sector: 'Energia', status: 'TARGET_ATINGIDO', pnl_pct: 6, win_rate_mc: 62 });
    insertMonitoringRecord(db, { ticker: 'E1', sector: 'Tecnologia', status: 'EXPIRADO', pnl_pct: 1.5, win_rate_mc: 67.5 });
    insertMonitoringRecord(db, { ticker: 'P1', sector: null, status: 'MONITORIZANDO', win_rate_mc: 66 });
    insertMonitoringRecord(db, { ticker: 'P2', sector: null, status: 'MONITORIZANDO', win_rate_mc: 72 });
    insertMonitoringRecord(db, { ticker: 'T4', sector: null, status: 'TARGET_ATINGIDO', pnl_pct: 12, win_rate_mc: 71 });

    const analytics = db.getMonitoringAnalytics();

    assert.deepEqual(analytics.kpis, {
      totalMonitored: 10,
      closedCount: 8,
      targetHits: 4,
      stopHits: 3,
      pendingCount: 2,
      expiredCount: 1,
      hitRate: 50,
      avgPnl: 4.07 // (10 - 5 + 8 - 4 + 6 + 1.5 + 12) / 7; S3 (pnl null) é excluído
    });

    const tiers = Object.fromEntries(analytics.tierAccuracy.map((t) => [t.tier, t]));
    assert.deepEqual(analytics.tierAccuracy.map((t) => t.tier), ['50-54%', '55-59%', '60-64%', '65-69%', '70%+']);

    // Fronteira: 54.99 pertence a 50-54% e 55.0 pertence a 55-59%.
    assert.equal(tiers['50-54%'].totalCount, 2);
    assert.equal(tiers['50-54%'].targetHits, 1);
    assert.equal(tiers['50-54%'].stopHits, 1);
    assert.equal(tiers['50-54%'].realHitRate, 50);
    assert.equal(tiers['55-59%'].totalCount, 2);
    assert.equal(tiers['55-59%'].targetHits, 1);
    assert.equal(tiers['55-59%'].realHitRate, 50);
    assert.equal(tiers['60-64%'].totalCount, 2);
    assert.equal(tiers['60-64%'].resolvedCount, 2);
    assert.equal(tiers['65-69%'].totalCount, 2);
    assert.equal(tiers['65-69%'].resolvedCount, 0, 'EXPIRADO não entra no hit rate do tier');
    assert.equal(tiers['65-69%'].realHitRate, 0);
    assert.equal(tiers['70%+'].totalCount, 2);
    assert.equal(tiers['70%+'].targetHits, 1);
    assert.equal(tiers['70%+'].realHitRate, 100);

    // Setores ordenados por failRate desc; setor null agrega em "Geral".
    assert.deepEqual(analytics.sectorFailureAnalysis.map((s) => s.sector), ['Financeiro', 'Tecnologia', 'Energia', 'Geral']);
    assert.deepEqual(analytics.sectorFailureAnalysis.map((s) => s.failRate), [66.7, 50, 0, 0]);
    const geral = analytics.sectorFailureAnalysis.find((s) => s.sector === 'Geral');
    assert.equal(geral.total, 3);
    assert.equal(geral.targets, 1);
    assert.equal(geral.stops, 0);

    assert.equal(analytics.records.length, 10);
  } finally {
    if (db) db.close();
    removeTempDir(dir);
  }
});

test('DB analytics: universo vazio devolve KPIs a zeros e listas vazias', { skip: !SQLITE_AVAILABLE }, async () => {
  const dir = makeTempDir('test-monitoring-analytics-empty-');
  let db;
  try {
    db = new DB(dir);
    await db.init();

    const analytics = db.getMonitoringAnalytics();
    assert.deepEqual(analytics.kpis, {
      totalMonitored: 0,
      closedCount: 0,
      targetHits: 0,
      stopHits: 0,
      pendingCount: 0,
      expiredCount: 0,
      hitRate: 0,
      avgPnl: 0
    });
    assert.equal(analytics.tierAccuracy.length, 5);
    assert.equal(analytics.tierAccuracy.every((t) => t.totalCount === 0 && t.resolvedCount === 0 && t.realHitRate === 0), true);
    assert.deepEqual(analytics.sectorFailureAnalysis, []);
    assert.deepEqual(analytics.records, []);
  } finally {
    if (db) db.close();
    removeTempDir(dir);
  }
});

// ── (c) IPC / PRELOAD estático ─────────────────────────────────────────
test('IPC/preload: handlers de avaliação/leitura e métodos nos 2 bridges', () => {
  const main = read('main.js');
  const preload = read('preload.js');

  assert.match(main, /ipcMain\.handle\(['"]evaluate-monitoring-daily['"]/);
  assert.match(main, /ipcMain\.handle\(['"]get-monitoring-data['"]/);
  assert.match(main, /db\.evaluateMonitoringAssetsDaily\(\)/);
  assert.match(main, /db\.getMonitoringAnalytics\(\)/);
  assert.match(main, /return \{ success: true, \.\.\.res, analytics \};/);
  assert.match(main, /return \{ success: true, analytics \};/);

  // Guarda !db nos dois handlers (mesmo com o DB por inicializar).
  const evalBlock = main.slice(main.indexOf("ipcMain.handle('evaluate-monitoring-daily'"), main.indexOf("ipcMain.handle('evaluate-monitoring-daily'") + 700);
  assert.match(evalBlock, /if \(!db\)\s*\{/);
  const getBlock = main.slice(main.indexOf("ipcMain.handle('get-monitoring-data'"), main.indexOf("ipcMain.handle('get-monitoring-data'") + 700);
  assert.match(getBlock, /if \(!db\)\s*\{/);

  const evalPattern = /evaluateMonitoringDaily:\s*\(\)\s*=>\s*ipcRenderer\.invoke\(['"]evaluate-monitoring-daily['"]\)/g;
  const getPattern = /getMonitoringData:\s*\(\)\s*=>\s*ipcRenderer\.invoke\(['"]get-monitoring-data['"]\)/g;
  assert.equal((preload.match(evalPattern) || []).length, 2, 'evaluateMonitoringDaily nos 2 bridges');
  assert.equal((preload.match(getPattern) || []).length, 2, 'getMonitoringData nos 2 bridges');
});

// ── (d) UI estático ────────────────────────────────────────────────────
test('UI estático: novos IDs presentes em #tab-portfolio e antigos removidos', () => {
  const html = read('renderer/index.html');
  const rendererJs = read('renderer/renderer.js');

  const newIds = [
    'tab-monitoring-container',
    'btn-run-monitoring-eval',
    'monitoring-table-body',
    'mon-kpi-total',
    'mon-kpi-hitrate',
    'mon-kpi-pnl',
    'mon-kpi-targets',
    'mon-kpi-stops',
    'chart-monitoring-outcomes',
    'chart-monitoring-tiers',
    'chart-monitoring-sectors'
  ];
  for (const id of newIds) {
    assert.match(html, new RegExp(`id=["']${id}["']`), `ID ${id} em falta no HTML`);
  }

  // A secção nova vive dentro de #tab-portfolio (antes de #tab-history).
  const portfolioIdx = html.indexOf('id="tab-portfolio"');
  const containerIdx = html.indexOf('id="tab-monitoring-container"');
  const historyIdx = html.indexOf('id="tab-history"');
  assert.ok(portfolioIdx !== -1 && containerIdx > portfolioIdx && containerIdx < historyIdx);

  const oldIds = [
    'table-monitoring-universe',
    'monitoring-universe-tbody',
    'monitoring-universe-count',
    'btn-refresh-monitoring-universe'
  ];
  for (const id of oldIds) {
    assert.doesNotMatch(html, new RegExp(id), `${id} não pode existir no HTML`);
    assert.doesNotMatch(rendererJs, new RegExp(id), `${id} não pode existir no renderer`);
  }
});

test('UI estático: loadMonitoringTab, alias e botão com finally', () => {
  const rendererJs = read('renderer/renderer.js');

  assert.match(rendererJs, /async function loadMonitoringTab\(\)/);
  assert.match(rendererJs, /api\.getMonitoringData\(\)/);
  assert.match(rendererJs, /renderMonitoringDashboard\(res\.analytics\)/);
  assert.match(rendererJs, /window\.loadMonitoringTab = loadMonitoringTab;/);
  assert.match(rendererJs, /window\.loadMonitoringUniverseData = loadMonitoringTab;/);

  assert.match(rendererJs, /const btnRunMonitoringEval = document\.getElementById\('btn-run-monitoring-eval'\)/);
  assert.match(rendererJs, /btnRunMonitoringEval\.onclick = async \(\) =>/);
  assert.match(rendererJs, /finally\s*\{[^}]*btnRunMonitoringEval\.disabled\s*=\s*false[^}]*\}/);
  assert.match(rendererJs, /btnRunMonitoringEval\.textContent = '🔄 Avaliar Desempenho e Atualizar Cotações'/);

  // Contrato Chart.js do dashboard.
  assert.match(rendererJs, /if \(typeof Chart !== 'undefined'\) \{/);
  assert.match(rendererJs, /if \(chartOutcomes\) chartOutcomes\.destroy\(\)/);
  assert.match(rendererJs, /if \(chartTiers\) chartTiers\.destroy\(\)/);
  assert.match(rendererJs, /if \(chartSectors\) chartSectors\.destroy\(\)/);
  assert.match(rendererJs, /type: 'doughnut'/);
  assert.match(rendererJs, /indexAxis: 'y'/);
});

test('UI estático: renderMonitoringDashboard escapa os campos textuais da tabela', () => {
  const rendererJs = read('renderer/renderer.js');
  const fn = extractFunctionSource(rendererJs, 'renderMonitoringDashboard');

  assert.ok((fn.match(/escapeHtml\(/g) || []).length >= 4, 'analysis_date, ticker, sector e status devem ser escapados');
  assert.match(fn, /\$\{escapeHtml\(r\.analysis_date/);
  assert.match(fn, /\$\{escapeHtml\(r\.ticker/);
  assert.match(fn, /\$\{escapeHtml\(r\.sector/);
  assert.match(fn, /\$\{escapeHtml\(r\.status/);
});

// ── (d) UI funcional (DOM/Chart falsos, determinístico) ────────────────
function extractFunctionSource(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `Função ${name} não encontrada na fonte`);
  let depth = 0;
  let end = -1;
  for (let i = source.indexOf('{', start); i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) { end = i; break; }
    }
  }
  assert.notEqual(end, -1, `Fecho da função ${name} não encontrado`);
  return source.slice(start, end + 1);
}

function createDashboardSandbox({ withChart = true } = {}) {
  const elements = new Map();
  const charts = [];
  const chartConfigs = [];

  const getElement = (id) => {
    if (!elements.has(id)) {
      const el = { id, _text: '', innerHTML: '', getContext: () => ({ canvas: id }) };
      // O DOM real coage textContent para string; o stub replica esse contrato.
      Object.defineProperty(el, 'textContent', {
        get() { return this._text; },
        set(value) { this._text = String(value); }
      });
      elements.set(id, el);
    }
    return elements.get(id);
  };
  const documentStub = { getElementById: getElement };
  const windowStub = {};
  const escapeHtmlStub = (value) => String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

  function ChartStub(ctx, config) {
    this.ctx = ctx;
    this.config = config;
    this.destroyed = false;
    this.destroy = () => { this.destroyed = true; };
    charts.push(this);
    chartConfigs.push(config);
  }

  const source = extractFunctionSource(read('renderer/renderer.js'), 'renderMonitoringDashboard');
  const factory = new Function(
    'window', 'document', 'Chart', 'escapeHtml',
    `"use strict";
     let chartOutcomes = null;
     let chartTiers = null;
     let chartSectors = null;
     ${source}
     return renderMonitoringDashboard;`
  );
  const render = factory(windowStub, documentStub, withChart ? ChartStub : undefined, escapeHtmlStub);
  return { render, elements, charts, chartConfigs, getElement };
}

function dashboardPayload() {
  return {
    kpis: {
      totalMonitored: 4,
      closedCount: 3,
      targetHits: 2,
      stopHits: 1,
      pendingCount: 1,
      expiredCount: 0,
      hitRate: 50,
      avgPnl: -3.2567
    },
    tierAccuracy: [
      { tier: '50-54%', totalCount: 4, resolvedCount: 2, targetHits: 1, stopHits: 1, realHitRate: 50 },
      { tier: '55-59%', totalCount: 0, resolvedCount: 0, targetHits: 0, stopHits: 0, realHitRate: 0 }
    ],
    sectorFailureAnalysis: [
      { sector: '<b>Tec</b>', total: 2, stops: 1, targets: 1, failRate: 50 },
      { sector: 'Energia', total: 2, stops: 1, targets: 1, failRate: 50 }
    ],
    records: [
      {
        analysis_date: '2026-01-02',
        ticker: '<img src=x onerror=alert(1)>',
        sector: null,
        entry_price: 100,
        current_price: 103,
        target_price: 110,
        stop_loss: 95,
        win_rate_mc: 60.25,
        status: '<script>alert(1)</script>',
        pnl_pct: 3.5
      },
      {
        analysis_date: '2026-01-03',
        ticker: 'LOSS',
        sector: 'Energia',
        entry_price: 50,
        current_price: 48,
        target_price: 55,
        stop_loss: 47.5,
        win_rate_mc: 55,
        status: 'STOP_ATINGIDO',
        pnl_pct: -4.2
      },
      {
        analysis_date: '2026-01-04',
        ticker: 'OPEN',
        sector: 'Geral',
        entry_price: 20,
        current_price: 21,
        target_price: 22,
        stop_loss: 19,
        win_rate_mc: 51,
        status: 'MONITORIZANDO',
        pnl_pct: null
      },
      {
        analysis_date: '2026-01-05',
        ticker: 'FLAT',
        sector: 'Geral',
        entry_price: 10,
        current_price: 10,
        target_price: 12,
        stop_loss: 9,
        win_rate_mc: 70,
        status: 'EXPIRADO',
        pnl_pct: 0
      }
    ]
  };
}

test('UI funcional: render escreve KPIs, cria 3 gráficos e escapa a tabela', () => {
  const sandbox = createDashboardSandbox();
  sandbox.render(dashboardPayload());

  assert.equal(sandbox.getElement('mon-kpi-total').textContent, '4');
  assert.equal(sandbox.getElement('mon-kpi-hitrate').textContent, '50.0%');
  assert.equal(sandbox.getElement('mon-kpi-targets').textContent, '2');
  assert.equal(sandbox.getElement('mon-kpi-stops').textContent, '1');
  assert.equal(sandbox.getElement('mon-kpi-pnl').textContent, '-3.26%');

  assert.equal(sandbox.charts.length, 3);
  assert.equal(sandbox.chartConfigs[0].type, 'doughnut');
  assert.deepEqual(sandbox.chartConfigs[0].data.datasets[0].data, [2, 1, 1, 0]);
  assert.equal(sandbox.chartConfigs[1].type, 'bar');
  assert.deepEqual(sandbox.chartConfigs[1].data.labels, ['50-54%', '55-59%']);
  assert.deepEqual(sandbox.chartConfigs[1].data.datasets[0].data, [50, 0]);
  assert.equal(sandbox.chartConfigs[2].type, 'bar');
  assert.equal(sandbox.chartConfigs[2].options.indexAxis, 'y', 'barras de setores são horizontais');

  const tbody = sandbox.getElement('monitoring-table-body').innerHTML;
  assert.match(tbody, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(tbody, /<img src=x/);
  assert.match(tbody, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(tbody, /<script>alert/);
  assert.match(tbody, /Geral/, 'setor null cai em Geral');
  assert.match(tbody, /--/, 'PnL nulo mostra placeholder');
  assert.match(tbody, /\+3\.50%/);
  assert.match(tbody, /-4\.20%/);
  assert.match(tbody, /0\.00%/);
});

test('UI funcional: re-render destrói gráficos anteriores e vazio mostra estado vazio', () => {
  const sandbox = createDashboardSandbox();
  sandbox.render(dashboardPayload());
  sandbox.render(dashboardPayload());

  assert.equal(sandbox.charts.length, 6);
  assert.deepEqual(sandbox.charts.slice(0, 3).map((c) => c.destroyed), [true, true, true]);
  assert.deepEqual(sandbox.charts.slice(3).map((c) => c.destroyed), [false, false, false]);

  sandbox.render({
    kpis: { totalMonitored: 0, hitRate: 0, targetHits: 0, stopHits: 0, pendingCount: 0, expiredCount: 0, avgPnl: 0 },
    tierAccuracy: [],
    sectorFailureAnalysis: [],
    records: []
  });
  assert.match(sandbox.getElement('monitoring-table-body').innerHTML, /Nenhum ativo no universo de monitorização/);
});

test('UI funcional: render tolera Chart.js ausente sem perder os KPIs', () => {
  const sandbox = createDashboardSandbox({ withChart: false });
  sandbox.render(dashboardPayload());

  assert.equal(sandbox.charts.length, 0);
  assert.equal(sandbox.getElement('mon-kpi-total').textContent, '4');
  assert.equal(sandbox.getElement('mon-kpi-hitrate').textContent, '50.0%');
  assert.match(sandbox.getElement('monitoring-table-body').innerHTML, /LOSS/);
});
