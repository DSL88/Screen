const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const Database = require('../src/db/database');

function createTempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'markov-mon-reactive-'));
  const db = new Database(dir);
  db.init();
  return { db, dir };
}

function removeTempDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (_) {}
}

function read(rel) {
  return fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf8');
}

test('Database: getAllMonitoringData cria tabela e computa KPIs de investment_monitoring_universe', () => {
  const { db, dir } = createTempDb();
  try {
    // 1. Base vazia
    const emptyResult = db.getAllMonitoringData();
    assert.ok(emptyResult.kpis);
    assert.equal(emptyResult.kpis.totalMonitored, 0);
    assert.equal(emptyResult.kpis.hitRate, '0.0');
    assert.equal(emptyResult.records.length, 0);

    // 2. Gravação de 4 registos com saveQualifiedToMonitoring
    const today = new Date().toISOString().split('T')[0];
    const dummyList = [
      { ticker: 'AAA', current_price: 100, target_price: 110, stop_loss: 95, win_rate_mc: 65, alpha_score: 15 },
      { ticker: 'BBB', current_price: 50, target_price: 55, stop_loss: 48, win_rate_mc: 58, alpha_score: 10 },
      { ticker: 'CCC', current_price: 200, target_price: 220, stop_loss: 190, win_rate_mc: 72, alpha_score: 25 },
      { ticker: 'DDD', current_price: 80, target_price: 88, stop_loss: 76, win_rate_mc: 52, alpha_score: 5 }
    ];

    const saved = db.saveQualifiedToMonitoring(dummyList);
    assert.equal(saved, 4);

    // Simular status diferentes
    db.db.prepare("UPDATE investment_monitoring_universe SET status = 'TARGET_ATINGIDO' WHERE ticker = 'AAA'").run();
    db.db.prepare("UPDATE investment_monitoring_universe SET status = 'STOP_ATINGIDO' WHERE ticker = 'BBB'").run();
    db.db.prepare("UPDATE investment_monitoring_universe SET status = 'EXPIRADO' WHERE ticker = 'CCC'").run();
    // 'DDD' permanece 'MONITORIZANDO'

    const res = db.getAllMonitoringData();
    assert.equal(res.kpis.totalMonitored, 4);
    assert.equal(res.kpis.targetHits, 1);
    assert.equal(res.kpis.stopHits, 1);
    assert.equal(res.kpis.expiredCount, 1);
    assert.equal(res.kpis.pendingCount, 1);
    // closed = 1 + 1 + 1 = 3; targetHits / closed = 1/3 = 33.3%
    assert.equal(res.kpis.hitRate, '33.3');
    assert.equal(res.records.length, 4);
  } finally {
    db.close();
    removeTempDir(dir);
  }
});

test('Main.js: handler get-monitoring-data invoca db.getAllMonitoringData()', () => {
  const main = read('main.js');
  assert.match(main, /ipcMain\.handle\(['"]get-monitoring-data['"]/);
  assert.match(main, /db\.getAllMonitoringData\(\)/);
  assert.match(main, /db\.getMonitoringAnalytics\(\)/);
  assert.match(main, /return\s*\{\s*success:\s*true/);
});

test('Renderer.js: getQualifiedMonitoringList cobre as 3 variáveis de fallback', () => {
  const rendererJs = read('renderer/renderer.js');
  assert.match(rendererJs, /function\s+getQualifiedMonitoringList\s*\(\)/);
  assert.match(rendererJs, /window\.currentMonitoringPool/);
  assert.match(rendererJs, /window\.currentAnalysisRemaining/);
  assert.match(rendererJs, /window\.currentAllAnalyzedAssets/);
});

test('Renderer.js: btn-save-qualified-monitoring valida payload, alerta e recarrega loadMonitoringTabData', () => {
  const rendererJs = read('renderer/renderer.js');
  assert.match(rendererJs, /btnQualifiedMonitoring\.onclick\s*=\s*async/);
  assert.match(rendererJs, /getQualifiedMonitoringList\(\)/);
  assert.match(rendererJs, /⚠️ Nenhum ativo qualificado restante/);
  assert.match(rendererJs, /api\.saveQualifiedMonitoring\(pool\)/);
  assert.match(rendererJs, /loadMonitoringTabData\(\)/);
  assert.match(rendererJs, /finally\s*\{[^}]*btnQualifiedMonitoring\.disabled\s*=\s*false/);
});

test('Renderer.js: loadMonitoringTabData renderiza tabela, KPIs e setupNavigationHooks escuta cliques nas abas', () => {
  const rendererJs = read('renderer/renderer.js');
  assert.match(rendererJs, /async\s+function\s+loadMonitoringTabData\s*\(\)/);
  assert.match(rendererJs, /document\.getElementById\(['"]monitoring-table-body['"]\)/);
  assert.match(rendererJs, /mon-kpi-total/);
  assert.match(rendererJs, /mon-kpi-hitrate/);
  assert.match(rendererJs, /function\s+setupNavigationHooks\s*\(\)/);
  assert.match(rendererJs, /setupNavigationHooks\(\)/);
});

test('IPC dedicado: main.js regista save-monitoring-universe-batch e get-monitoring-universe-records', () => {
  const main = read('main.js');
  assert.match(main, /ipcMain\.handle\(['"]save-monitoring-universe-batch['"]/);
  assert.match(main, /ipcMain\.handle\(['"]get-monitoring-universe-records['"]/);
  assert.match(main, /db\.saveToMonitoringUniverseOnly\(/);
  assert.match(main, /db\.getMonitoringUniverseRecords\(/);
});

test('Preload: exposição dos canais dedicados da Monitorização', () => {
  const preload = read('preload.js');
  assert.match(preload, /saveMonitoringUniverseBatch:\s*\(assets\)\s*=>\s*ipcRenderer\.invoke\(['"]save-monitoring-universe-batch['"],\s*assets\)/);
  assert.match(preload, /getMonitoringUniverseRecords:\s*\(\)\s*=>\s*ipcRenderer\.invoke\(['"]get-monitoring-universe-records['"]\)/);
});

test('Renderer.js: botão da monitorização prioriza o canal dedicado com fallback legado', () => {
  const rendererJs = read('renderer/renderer.js');
  assert.match(rendererJs, /api\.saveMonitoringUniverse\(pool\)/);
  assert.match(rendererJs, /api\.saveMonitoringUniverseBatch\(pool\)/);
  assert.match(rendererJs, /api\.saveQualifiedMonitoring\(pool\)/);
  assert.match(rendererJs, /api\.getMonitoringUniverseRecords\(\)/);
  assert.match(rendererJs, /function\s+bindMonitoringExportButton\s*\(\)/);
  assert.match(rendererJs, /function\s+bindTop20ExportButton\s*\(\)/);
  assert.match(rendererJs, /function\s+renderTrackerView\s*\(\)/);
  assert.match(rendererJs, /function\s+renderMonitoringView\s*\(\)/);
});

test('IPC separado: save-monitoring-universe / get-tracker-table / get-monitoring-table', () => {
  const main = read('main.js');
  assert.match(main, /ipcMain\.handle\(['"]save-monitoring-universe['"]/);
  assert.match(main, /ipcMain\.handle\(['"]get-tracker-table['"]/);
  assert.match(main, /ipcMain\.handle\(['"]get-monitoring-table['"]/);
  assert.match(main, /db\.saveOnlyRemainingToMonitoring\(/);
  assert.match(main, /db\.getTrackerOnlyData\(/);
  assert.match(main, /db\.getMonitoringOnlyData\(/);

  const preload = read('preload.js');
  assert.match(preload, /saveMonitoringUniverse:\s*\(data\)\s*=>\s*ipcRenderer\.invoke\(['"]save-monitoring-universe['"],\s*data\)/);
  assert.match(preload, /getTrackerTable:\s*\(\)\s*=>\s*ipcRenderer\.invoke\(['"]get-tracker-table['"]\)/);
  assert.match(preload, /getMonitoringTable:\s*\(\)\s*=>\s*ipcRenderer\.invoke\(['"]get-monitoring-table['"]\)/);

  const trackerJs = read('renderer/quantTrackerRenderer.js');
  assert.match(trackerJs, /getTrackerTable/);
  assert.match(trackerJs, /buildDashboardFromTop20/);
});

test('DB separação física: Top 20 corta em 20 e nunca toca na monitorização', () => {
  const { db, dir } = createTempDb();
  try {
    const count = (table) => db.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;

    const many = Array.from({ length: 25 }, (_, i) => ({
      ticker: `TOP${String(i).padStart(2, '0')}`,
      current_price: 10 + i,
      target_price: 10.48 + i,
      stop_loss: 9.76 + i,
      win_rate_mc: 70,
      alpha_score: 100 - i
    }));

    const saved = db.saveOnlyTop20ToTracker(many);
    assert.equal(saved, 20, 'Deve cortar rigorosamente nos 20 primeiros');
    assert.equal(count('alphaquant_top20_tracker'), 20);
    assert.equal(count('investment_monitoring_universe'), 0, 'A monitorização não pode ser tocada');
    assert.equal(count('alphaquant_history_tracker'), 0, 'O histórico do tracker não é tocado pelo canal exclusivo');

    const trackerRows = db.getTrackerOnlyData();
    assert.equal(trackerRows.length, 20);
    assert.ok(trackerRows.every((r) => r.ticker.startsWith('TOP')));

    const monitoringRows = db.getMonitoringOnlyData();
    assert.equal(monitoringRows.length, 0);
  } finally {
    db.close();
    removeTempDir(dir);
  }
});

test('DB separação física: monitorização exclusiva não toca nas tabelas do Tracker', () => {
  const { db, dir } = createTempDb();
  try {
    const count = (table) => db.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;

    const saved = db.saveOnlyRemainingToMonitoring([
      { ticker: 'MONA', current_price: 10, target_price: 10.48, stop_loss: 9.76, win_rate_mc: 55, alpha_score: 40 },
      { ticker: 'MONB', current_price: 20, target_price: 20.96, stop_loss: 19.52, win_rate_mc: 52, alpha_score: 35 },
      { ticker: 'MONC', current_price: 30, target_price: 31.44, stop_loss: 29.28, win_rate_mc: 51, alpha_score: 30 }
    ]);

    assert.equal(saved, 3);
    assert.equal(count('investment_monitoring_universe'), 3);
    assert.equal(count('alphaquant_top20_tracker'), 0);
    assert.equal(count('alphaquant_history_tracker'), 0);

    const monitoringRows = db.getMonitoringOnlyData();
    assert.equal(monitoringRows.length, 3);
    assert.deepEqual(monitoringRows.map((r) => r.ticker).sort(), ['MONA', 'MONB', 'MONC']);
    assert.equal(db.getTrackerOnlyData().length, 0);
  } finally {
    db.close();
    removeTempDir(dir);
  }
});


test('DB: saveToMonitoringUniverseOnly grava apenas em investment_monitoring_universe', () => {
  const { db, dir } = createTempDb();
  try {
    const count = (table) => db.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;

    const saved = db.saveToMonitoringUniverseOnly([
      { ticker: 'MON1', current_price: 10, target_price: 10.48, stop_loss: 9.76, win_rate_mc: 60, alpha_score: 30 },
      { ticker: 'MON2', current_price: 20, target_price: 20.96, stop_loss: 19.52, win_rate_mc: 55, alpha_score: 20 }
    ]);

    assert.equal(saved, 2);
    assert.equal(count('investment_monitoring_universe'), 2);
    assert.equal(count('alphaquant_history_tracker'), 0, 'O Tracker canónico não pode ser tocado');
    assert.equal(count('alphaquant_top20_tracker'), 0, 'A tabela Top 20 não pode ser tocada');

    const records = db.getMonitoringUniverseRecords();
    assert.equal(records.length, 2);
    assert.deepEqual(records.map((r) => r.ticker).sort(), ['MON1', 'MON2']);
  } finally {
    db.close();
    removeTempDir(dir);
  }
});

test('DB hygiene: pruneTrackerTablesToLatestTop20 mantém apenas os 20 registos mais recentes', () => {
  const { db, dir } = createTempDb();
  try {
    const insert = db.db.prepare(`
      INSERT INTO alphaquant_history_tracker (
        ticker, direction, entry_price, target_price, stop_loss, recommendation_date
      ) VALUES (?, 'COMPRA', 1, 2, 0.5, '2026-01-01')
    `);
    for (let i = 0; i < 25; i++) insert.run(`H${String(i).padStart(2, '0')}`);

    const result = db.pruneTrackerTablesToLatestTop20();
    assert.equal(result.removedHistory, 5);

    const rows = db.db.prepare('SELECT ticker FROM alphaquant_history_tracker ORDER BY id DESC').all();
    assert.equal(rows.length, 20);
    assert.equal(rows[0].ticker, 'H24', 'O mais recente é preservado');
    assert.equal(rows[19].ticker, 'H05', 'Os 20 mais recentes são preservados');
  } finally {
    db.close();
    removeTempDir(dir);
  }
});

test('DB hygiene: com Top 20 autoritário, o histórico fica ancorado exatamente nos seus tickers', () => {
  const { db, dir } = createTempDb();
  try {
    const insertTop = db.db.prepare(`
      INSERT INTO alphaquant_top20_tracker (
        ticker, direction, entry_price, target_price, stop_loss, recommendation_date
      ) VALUES (?, 'COMPRA', 10, 10.48, 9.76, '2026-02-02')
    `);
    const insertHistory = db.db.prepare(`
      INSERT INTO alphaquant_history_tracker (
        ticker, direction, entry_price, target_price, stop_loss, recommendation_date
      ) VALUES (?, 'COMPRA', 10, 10.48, 9.76, '2026-02-02')
    `);
    for (let i = 1; i <= 3; i++) insertTop.run(`T${i}`);
    for (let i = 0; i <= 5; i++) insertHistory.run(`T${i}`);

    const result = db.pruneTrackerTablesToLatestTop20();
    assert.equal(result.removedHistory, 3);

    const rows = db.db.prepare('SELECT ticker FROM alphaquant_history_tracker ORDER BY ticker ASC').all();
    assert.deepEqual(rows.map((r) => r.ticker), ['T1', 'T2', 'T3']);
  } finally {
    db.close();
    removeTempDir(dir);
  }
});


