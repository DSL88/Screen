'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const DB = require('../src/db/database');
const { makeTempDir, removeTempDir } = require('./helpers');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

const OLD_TOOLBAR_IDS = [
  'btn-export-tracker-batch',
  'btn-export-all-tracker',
  'btn-export-split-workflow',
  'tracker-selected-count',
  'total-analyzed-badge',
  'count-remaining',
  'master-table-count',
  'btn-save-all-monitoring',
  'count-all-monitoring'
];

// O UPSERT do Top 20 sincroniza para o quant_tracker.db canónico. Durante os
// testes apontamos essa variável para um caminho inexistente num diretório
// temporário, de modo a nunca escrever na base de dados real do repositório.
const NOSYNC_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'test-toolbar-nosync-'));
const ORIGINAL_QUANT_TRACKER_DB_PATH = process.env.QUANT_TRACKER_DB_PATH;
process.env.QUANT_TRACKER_DB_PATH = path.join(NOSYNC_DIR, 'quant_tracker.db');

test.after(() => {
  if (ORIGINAL_QUANT_TRACKER_DB_PATH === undefined) {
    delete process.env.QUANT_TRACKER_DB_PATH;
  } else {
    process.env.QUANT_TRACKER_DB_PATH = ORIGINAL_QUANT_TRACKER_DB_PATH;
  }
  try {
    removeTempDir(NOSYNC_DIR);
  } catch (_) {}
});

function tableCount(db, table) {
  return db.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
}

function todayIso() {
  return new Date().toISOString().split('T')[0];
}

const MONITORING_ASSETS = [
  {
    ticker: 'aapl',
    company_name: 'Apple Inc.',
    country: 'US',
    sector: 'Technology',
    direction: 'COMPRA',
    current_price: 230.5,
    target_price: 241.56,
    stop_loss: 224.97,
    win_rate_mc: 72.5,
    cvar_95: 3.2,
    graham_score: 78.0,
    alpha_score: 84.5
  },
  {
    ticker: 'MSFT',
    company_name: 'Microsoft Corp.',
    country: 'US',
    sector: 'Technology',
    direction: 'COMPRA',
    current_price: 450.0,
    target_price: 471.6,
    stop_loss: 439.2,
    win_rate_mc: 68.0,
    cvar_95: 2.8,
    graham_score: 82.0,
    alpha_score: 88.0
  },
  {
    ticker: 'NVDA',
    company_name: 'NVIDIA Corp.',
    country: 'US',
    sector: 'Technology',
    direction: 'COMPRA',
    current_price: 130.0,
    target_price: 136.24,
    stop_loss: 126.88,
    win_rate_mc: 75.0,
    cvar_95: 4.1,
    graham_score: 90.0,
    alpha_score: 95.0
  }
];

// ── (a) HTML: contrato estático da toolbar ─────────────────────────────
test('HTML: nova toolbar expõe os IDs canónicos e remove os IDs legados', () => {
  const html = read('renderer/index.html');

  assert.match(html, /id=["']btn-save-top20-tracker["']/);
  assert.match(html, /id=["']btn-save-qualified-monitoring["']/);
  assert.match(html, /id=["']count-qualified-monitoring["']/);
  assert.match(html, /id=["']badge-top-count["']/);

  for (const oldId of OLD_TOOLBAR_IDS) {
    assert.doesNotMatch(
      html,
      new RegExp(`id=["']${oldId}["']`),
      `O ID legado ${oldId} não deve existir no HTML`
    );
  }

  // Checkbox master deve continuar dentro do thead da Tabela Mestra.
  const tableMatch = html.match(/<table[^>]*id=["']table-master-recommendations["'][\s\S]*?<\/table>/);
  assert.ok(tableMatch, 'A tabela mestra (table-master-recommendations) deve existir');
  const theadMatch = tableMatch[0].match(/<thead[\s\S]*?<\/thead>/);
  assert.ok(theadMatch, 'A tabela mestra deve ter um thead');
  assert.match(theadMatch[0], /id=["']checkbox-master-recommendations["']/);
  assert.match(theadMatch[0], /<th[^>]*>\s*<input type="checkbox" id="checkbox-master-recommendations"/);
});

// ── (b) Preload + Main: canais IPC ─────────────────────────────────────
test('Preload: saveQualifiedMonitoring e saveTop20Tracker expostos nos dois bridges', () => {
  const preload = read('preload.js');

  const saveQualifiedPattern = /saveQualifiedMonitoring:\s*\(list\)\s*=>\s*ipcRenderer\.invoke\(['"]save-qualified-monitoring['"],\s*list\)/g;
  const saveTop20Pattern = /saveTop20Tracker:\s*\(top20\)\s*=>\s*ipcRenderer\.invoke\(['"]save-top20-tracker['"],\s*top20\)/g;

  assert.equal(
    (preload.match(saveQualifiedPattern) || []).length,
    2,
    'saveQualifiedMonitoring deve estar no apiBridge e no quantApiBridge'
  );
  assert.equal(
    (preload.match(saveTop20Pattern) || []).length,
    2,
    'saveTop20Tracker deve estar no apiBridge e no quantApiBridge'
  );

  // Métodos/canais antigos deixaram de existir no preload
  assert.doesNotMatch(preload, /saveAllToMonitoring\s*:/);
  assert.doesNotMatch(preload, /save-all-to-monitoring/);
  assert.doesNotMatch(preload, /save-top20-to-tracker/);
});

test('Main: handlers IPC save-qualified-monitoring e save-top20-tracker registados', () => {
  const main = read('main.js');

  assert.match(main, /ipcMain\.handle\(['"]save-qualified-monitoring['"]/);
  assert.match(main, /db\.saveQualifiedToMonitoring\(/);
  assert.match(main, /ipcMain\.handle\(['"]save-top20-tracker['"]/);
  assert.match(main, /db\.saveTop20ToTracker\(/);

  // Canais antigos já não são registados
  assert.doesNotMatch(main, /ipcMain\.handle\(['"]save-all-to-monitoring['"]/);
  assert.doesNotMatch(main, /ipcMain\.handle\(['"]save-top20-to-tracker['"]/);
});

// ── (c) DB isolamento + UPSERT + idempotência + fallbacks ──────────────
test('DB isolamento: saveQualifiedToMonitoring escreve apenas em investment_monitoring_universe', async () => {
  const dir = makeTempDir('test-toolbar-isolation-');
  let db;
  try {
    db = new DB(dir);
    await db.init();

    const inserted = db.saveQualifiedToMonitoring(MONITORING_ASSETS);
    assert.equal(inserted, 3, 'Deve processar 3 ativos');

    assert.equal(tableCount(db, 'investment_monitoring_universe'), 3);
    assert.equal(tableCount(db, 'alphaquant_top20_tracker'), 0, 'Top 20 não pode ser tocado');
    assert.equal(tableCount(db, 'alphaquant_history_tracker'), 0, 'Tracker canónico não pode ser tocado');

    const rows = db.db.prepare('SELECT * FROM investment_monitoring_universe ORDER BY ticker ASC').all();
    assert.equal(rows.length, 3);
    assert.equal(rows[0].ticker, 'AAPL', 'Ticker deve ser normalizado para maiúsculas');
    assert.equal(rows[0].company_name, 'Apple Inc.');
    assert.equal(rows[0].entry_price, 230.5, 'entry_price mapeia current_price');
    assert.equal(rows[0].current_price, 230.5);
    assert.equal(rows[0].target_price, 241.56);
    assert.equal(rows[0].stop_loss, 224.97);
    assert.equal(rows[0].win_rate_mc, 72.5);
    assert.equal(rows[0].graham_score, 78.0);
    assert.equal(rows[0].alpha_score, 84.5);
    assert.equal(rows[0].direction, 'COMPRA');
    assert.equal(rows[0].status, 'MONITORIZANDO');
    assert.equal(rows[0].analysis_date, todayIso());
    assert.equal(rows[2].ticker, 'NVDA');
    assert.equal(rows[2].alpha_score, 95.0);
  } finally {
    if (db) db.close();
    removeTempDir(dir);
  }
});

test('DB idempotência: UPSERT não duplica e atualiza direção/alpha preservando metadata', async () => {
  const dir = makeTempDir('test-toolbar-upsert-');
  let db;
  try {
    db = new DB(dir);
    await db.init();

    const firstCount = db.saveQualifiedToMonitoring([MONITORING_ASSETS[0]]);
    assert.equal(firstCount, 1);
    const before = db.db.prepare('SELECT * FROM investment_monitoring_universe WHERE ticker = ?').get('AAPL');
    assert.ok(before, 'AAPL deve existir após a primeira chamada');

    const secondCount = db.saveQualifiedToMonitoring([
      {
        ticker: 'AAPL',
        company_name: 'Apple Inc. Updated',
        country: 'PT',
        sector: 'Outro',
        direction: 'VENDA',
        current_price: 235.0,
        target_price: 223.72,
        stop_loss: 240.64,
        win_rate_mc: 75.0,
        cvar_95: 3.1,
        graham_score: 80.0,
        alpha_score: 90.0
      }
    ]);
    assert.equal(secondCount, 1, 'Deve processar o UPSERT');
    assert.equal(tableCount(db, 'investment_monitoring_universe'), 1, 'Não pode duplicar ticker/dia');

    const after = db.db.prepare('SELECT * FROM investment_monitoring_universe WHERE ticker = ?').get('AAPL');
    assert.equal(after.id, before.id, 'O UPSERT atualiza a mesma linha');
    assert.equal(after.entry_price, 235.0, 'Preço deve ser atualizado');
    assert.equal(after.direction, 'VENDA', 'Direção deve ser atualizada');
    assert.equal(after.alpha_score, 90.0, 'Alpha score deve ser atualizado');
    assert.equal(after.analysis_date, before.analysis_date);
    assert.equal(after.status, 'MONITORIZANDO', 'status preservado no UPSERT');
    assert.equal(after.created_at, before.created_at, 'created_at preservado no UPSERT');
    assert.equal(after.company_name, 'Apple Inc.', 'company_name não é reescrito pelo UPSERT');

    assert.equal(tableCount(db, 'alphaquant_top20_tracker'), 0);
    assert.equal(tableCount(db, 'alphaquant_history_tracker'), 0);
  } finally {
    if (db) db.close();
    removeTempDir(dir);
  }
});

test('DB: saveQualifiedToMonitoring([]) e (null) devolvem 0 e não escrevem', async () => {
  const dir = makeTempDir('test-toolbar-empty-');
  let db;
  try {
    db = new DB(dir);
    await db.init();

    assert.equal(db.saveQualifiedToMonitoring([]), 0);
    assert.equal(db.saveQualifiedToMonitoring(null), 0);
    assert.equal(db.saveQualifiedToMonitoring(undefined), 0);
    // Os aliases delegam na canónica e mantêm o mesmo contrato
    assert.equal(db.saveAllToMonitoring([]), 0);
    assert.equal(db.saveAllToMonitoring(null), 0);
    assert.equal(db.saveRemainingToMonitoring([]), 0);
    assert.equal(db.saveRemainingToMonitoring(null), 0);
    assert.equal(tableCount(db, 'investment_monitoring_universe'), 0);
    assert.equal(tableCount(db, 'alphaquant_top20_tracker'), 0);
    assert.equal(tableCount(db, 'alphaquant_history_tracker'), 0);
  } finally {
    if (db) db.close();
    removeTempDir(dir);
  }
});

test('DB aliases: saveAllToMonitoring e saveRemainingToMonitoring delegam na canónica', async () => {
  const dir = makeTempDir('test-toolbar-aliases-');
  let db;
  try {
    db = new DB(dir);
    await db.init();

    const viaRemaining = db.saveRemainingToMonitoring([MONITORING_ASSETS[0]]);
    assert.equal(viaRemaining, 1);

    // NOVA SEMÂNTICA (F2): o alias purga o mesmo dia. A segunda chamada
    // substitui o snapshot anterior em vez de acumular (AAPL é removido).
    const viaAll = db.saveAllToMonitoring([MONITORING_ASSETS[1], MONITORING_ASSETS[2]]);
    assert.equal(viaAll, 2);

    assert.equal(tableCount(db, 'investment_monitoring_universe'), 2);
    assert.equal(tableCount(db, 'alphaquant_top20_tracker'), 0);
    assert.equal(tableCount(db, 'alphaquant_history_tracker'), 0);

    const tickers = db.db.prepare('SELECT ticker FROM investment_monitoring_universe ORDER BY ticker ASC').all().map((r) => r.ticker);
    assert.deepEqual(tickers, ['MSFT', 'NVDA'], 'O dia fica exatamente com a última lista do alias');
    assert.equal(db.db.prepare('SELECT COUNT(*) AS n FROM investment_monitoring_universe WHERE ticker = ?').get('AAPL').n, 0);

    const row = db.db.prepare('SELECT * FROM investment_monitoring_universe WHERE ticker = ?').get('NVDA');
    assert.ok(row, 'O alias deve persistir na tabela canónica');
    assert.equal(row.alpha_score, 95.0);
  } finally {
    if (db) db.close();
    removeTempDir(dir);
  }
});

test('DB fallbacks: name/price/signal_direction/winRateMC/quality_score são aceites', async () => {
  const dir = makeTempDir('test-toolbar-fallback-');
  let db;
  try {
    db = new DB(dir);
    await db.init();

    const inserted = db.saveQualifiedToMonitoring([
      {
        ticker: ' fb1 ',
        name: 'Fallback Name',
        price: 12.5,
        signal_direction: 'VENDA',
        winRateMC: 61.5,
        quality_score: 44,
        alpha_score: 33
      }
    ]);
    assert.equal(inserted, 1);

    const row = db.db.prepare('SELECT * FROM investment_monitoring_universe WHERE ticker = ?').get('FB1');
    assert.ok(row, 'Ticker deve ser trimmed e normalizado');
    assert.equal(row.company_name, 'Fallback Name');
    assert.equal(row.entry_price, 12.5, 'price alimenta entry_price');
    assert.equal(row.current_price, 12.5, 'price alimenta current_price');
    assert.equal(row.direction, 'VENDA');
    assert.equal(row.win_rate_mc, 61.5);
    assert.equal(row.graham_score, 44);
    assert.equal(row.alpha_score, 33);
    assert.equal(row.country, 'Global');
    assert.equal(row.sector, 'Geral');
    assert.equal(row.target_price, 0);
    assert.equal(row.stop_loss, 0);
    assert.equal(row.cvar_95, 5);
    assert.equal(row.status, 'MONITORIZANDO');
  } finally {
    if (db) db.close();
    removeTempDir(dir);
  }
});

// ── (d) DB Top 20 ──────────────────────────────────────────────────────
test('DB Top20: saveTop20ToTracker persiste 2 registos com os campos corretos', async () => {
  const dir = makeTempDir('test-toolbar-top20-');
  let db;
  try {
    db = new DB(dir);
    await db.init();

    const saved = db.saveTop20ToTracker([
      {
        ticker: 'nvda',
        company_name: 'NVIDIA Corp',
        country: 'US',
        sector: 'Technology',
        direction: 'COMPRA',
        current_price: 130.0,
        target_price: 136.24,
        stop_loss: 126.88,
        win_rate_mc: 72.5,
        cvar_95: 3.2,
        alpha_score: 95.0
      },
      {
        ticker: 'MSFT',
        name: 'Microsoft Corp',
        country: 'US',
        sector: 'Technology',
        direction: 'COMPRA',
        current_price: 420.0,
        target_price: 440.16,
        stop_loss: 409.92,
        win_rate_mc: 65.0,
        cvar_95: 2.8,
        alpha_score: 88.0
      }
    ]);
    assert.equal(saved, 2);
    assert.equal(tableCount(db, 'alphaquant_top20_tracker'), 2);
    assert.equal(tableCount(db, 'investment_monitoring_universe'), 0, 'Monitorização não pode ser tocada');

    const rows = db.getTop20Tracker();
    assert.equal(rows.length, 2);
    assert.equal(rows[0].ticker, 'NVDA', 'Ticker normalizado e ordenado por alpha_score DESC');
    assert.equal(rows[0].company_name, 'NVIDIA Corp');
    assert.equal(rows[0].country, 'US');
    assert.equal(rows[0].sector, 'Technology');
    assert.equal(rows[0].direction, 'COMPRA');
    assert.equal(rows[0].entry_price, 130.0);
    assert.equal(rows[0].target_price, 136.24);
    assert.equal(rows[0].stop_loss, 126.88);
    assert.equal(rows[0].win_rate_mc, 72.5);
    assert.equal(rows[0].cvar_95, 3.2);
    assert.equal(rows[0].alpha_score, 95.0);
    assert.equal(rows[0].recommendation_date, todayIso());
    assert.equal(rows[0].status, 'PENDENTE');
    assert.equal(rows[1].ticker, 'MSFT');
    assert.equal(rows[1].company_name, 'Microsoft Corp', 'name alimenta company_name');
    assert.equal(rows[1].alpha_score, 88.0);
  } finally {
    if (db) db.close();
    removeTempDir(dir);
  }
});

// ── (e) Renderer: listeners, IPC, finally e contador ───────────────────
test('Renderer: listeners, chamadas IPC, finally e reposição do span count-qualified-monitoring', () => {
  const rendererJs = read('renderer/renderer.js');

  // Listeners dos dois botões novos
  assert.match(rendererJs, /document\.getElementById\(['"]btn-save-top20-tracker['"]\)/);
  assert.match(rendererJs, /document\.getElementById\(['"]btn-save-qualified-monitoring['"]\)/);
  assert.match(rendererJs, /btnSaveTop20\.onclick\s*=\s*async/);
  assert.match(rendererJs, /btnQualifiedMonitoring\.onclick\s*=\s*async/);

  // Chamadas aos canais IPC expostos no preload
  assert.match(rendererJs, /api\.saveTop20Tracker\(top20\)/);
  assert.match(rendererJs, /api\.saveQualifiedMonitoring\(pool\)/);

  // Pool consumido a partir da global definida pelo motor
  assert.match(rendererJs, /window\.currentMonitoringPool/);

  // finally repõe disabled = false em ambos os botões
  assert.match(rendererJs, /finally\s*\{[^}]*btnSaveTop20\.disabled\s*=\s*false[^}]*\}/);
  assert.match(rendererJs, /finally\s*\{[^}]*btnQualifiedMonitoring\.disabled\s*=\s*false[^}]*\}/);

  // O botão verde repõe o span do contador via innerHTML (não pode morrer)
  assert.match(rendererJs, /btnQualifiedMonitoring\.innerHTML\s*=\s*`[^`]*count-qualified-monitoring[^`]*`/);

  // updateExportButtonState continua definido e alimenta o contador
  assert.match(rendererJs, /window\.updateExportButtonState\s*=\s*function/);
  assert.match(rendererJs, /countQualifiedMonitoring\.textContent\s*=\s*\(window\.currentMonitoringPool \|\| \[\]\)\.length/);
});
