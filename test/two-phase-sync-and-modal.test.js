const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

let Sqlite;
let DB;
let SQLITE_AVAILABLE = false;
try {
  Sqlite = require('better-sqlite3');
  DB = require('../src/db/database');
  const probe = new Sqlite(':memory:');
  probe.close();
  SQLITE_AVAILABLE = true;
} catch (_) {
  // Ignora caso SQLite não esteja disponível neste ambiente
}

const { makeCandle, makeTempDir, removeTempDir } = require('./helpers');

function makeDb() {
  const dir = makeTempDir('two-phase-test-');
  const db = new DB(dir);
  db.init();
  return { db, dir };
}

// ══════════════════════════════════════════════════════════════
// 1. FASE 1: AUDITORIA LOCAL INSTANTÂNEA EM SQLITE
// ══════════════════════════════════════════════════════════════

test('auditAllAssetsStatus executa SELECT indexado único e mapeia first_date, last_date e total_candles', { skip: !SQLITE_AVAILABLE }, async () => {
  const { db, dir } = makeDb();
  try {
    db.upsertStock({ ticker: 'AAA', name: 'Ativo AAA', country: 'Portugal', indexName: 'PSI' });
    db.upsertStock({ ticker: 'BBB', name: 'Ativo BBB', country: 'Espanha', indexName: 'IBEX35' });
    db.upsertStock({ ticker: 'CCC', name: 'Ativo CCC', country: 'Portugal', indexName: 'PSI' });

    // Inserir histórico para AAA e BBB, deixando CCC virgem
    db.saveHistoricalCandlesBatch('AAA', [
      makeCandle('AAA', '2022-01-10', 10),
      makeCandle('AAA', '2022-01-11', 11),
      makeCandle('AAA', '2024-06-01', 15)
    ]);
    db.saveHistoricalCandlesBatch('BBB', [
      makeCandle('BBB', '2020-05-01', 20),
      makeCandle('BBB', '2024-06-02', 25)
    ]);

    // Auditoria sem filtro: devolve todos ordenados por ticker
    const auditAll = db.auditAllAssetsStatus();
    assert.equal(auditAll.length, 3);
    assert.equal(auditAll[0].ticker, 'AAA');
    assert.equal(auditAll[0].first_date, '2022-01-10');
    assert.equal(auditAll[0].last_date, '2024-06-01');
    assert.equal(auditAll[0].total_candles, 3);

    assert.equal(auditAll[1].ticker, 'BBB');
    assert.equal(auditAll[1].first_date, '2020-05-01');
    assert.equal(auditAll[1].last_date, '2024-06-02');
    assert.equal(auditAll[1].total_candles, 2);

    assert.equal(auditAll[2].ticker, 'CCC');
    assert.equal(auditAll[2].first_date, null);
    assert.equal(auditAll[2].last_date, null);
    assert.equal(auditAll[2].total_candles, 0);

    // Auditoria com filtro de índice
    const auditPsi = db.auditAllAssetsStatus('PSI');
    assert.equal(auditPsi.length, 2);
    assert.equal(auditPsi[0].ticker, 'AAA');
    assert.equal(auditPsi[1].ticker, 'CCC');

    const auditIbex = db.auditAllAssetsStatus('ibex35');
    assert.equal(auditIbex.length, 1);
    assert.equal(auditIbex[0].ticker, 'BBB');
  } finally {
    db.close();
    removeTempDir(dir);
  }
});

test('saveHistoricalCandlesBatch grava atomicamente array plano de velas', { skip: !SQLITE_AVAILABLE }, async () => {
  const { db, dir } = makeDb();
  try {
    db.upsertStock({ ticker: 'AAA', name: 'Ativo AAA', country: 'Portugal', indexName: 'PSI' });
    db.upsertStock({ ticker: 'BBB', name: 'Ativo BBB', country: 'Espanha', indexName: 'IBEX35' });

    const flatCandles = [
      { ticker: 'AAA', date: '2024-01-02', open: 10, high: 12, low: 9, close: 11, volume: 5000 },
      { ticker: 'AAA', date: '2024-01-03', open: 11, high: 13, low: 10, close: 12, volume: 6000 },
      { ticker: 'BBB', date: '2024-01-02', open: 20, high: 22, low: 19, close: 21, volume: 7000 }
    ];

    const res = db.saveHistoricalCandlesBatch(flatCandles);
    assert.ok(res.changes >= 3);

    const candlesA = db.getLocalHistoricalPrices('AAA');
    assert.equal(candlesA.length, 2);
    const candlesB = db.getLocalHistoricalPrices('BBB');
    assert.equal(candlesB.length, 1);
  } finally {
    db.close();
    removeTempDir(dir);
  }
});

// ══════════════════════════════════════════════════════════════
// 2. FASE 2: ORQUESTRADOR IPC E DOWNLOAD SELETIVO (process-asset-sync)
// ══════════════════════════════════════════════════════════════

test('main.js e preload.js expõem e implementam o contrato process-asset-sync', () => {
  const mainCode = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(mainCode, /ipcMain\.handle\('process-asset-sync'/);
  assert.match(mainCode, /db\.auditAllAssetsStatus/);
  assert.match(mainCode, /db\.saveHistoricalCandlesBatch/);
  assert.match(mainCode, /SYNC_PROGRESS_UPDATE/);

  const preloadCode = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
  assert.match(preloadCode, /'SYNC_PROGRESS_UPDATE'/);
  assert.match(preloadCode, /processAssetSync:\s*\(payload\)\s*=>/);
  assert.match(preloadCode, /onSyncProgressUpdate:\s*\(callback\)\s*=>/);
});

// ══════════════════════════════════════════════════════════════
// 3. UI: FECHO AUTOMÁTICO DO MODAL NO ENTER (renderer.js)
// ══════════════════════════════════════════════════════════════

test('renderer.js define saveModalDataAndClose, closeStockModal e attachModalEnterKeyListeners', () => {
  const rendererCode = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');

  assert.match(rendererCode, /async function saveModalDataAndClose\(\)/);
  assert.match(rendererCode, /function closeStockModal\(\)/);
  assert.match(rendererCode, /function attachModalEnterKeyListeners\(\)/);

  // Validação estrita do comportamento de fecho incondicional e prevenção de default
  assert.match(rendererCode, /event\.key === 'Enter'/);
  assert.match(rendererCode, /event\.preventDefault\(\)/);
  assert.match(rendererCode, /await saveModalDataAndClose\(\)/);
  assert.match(rendererCode, /closeStockModal\(\)/);
});

// ══════════════════════════════════════════════════════════════
// 4. MODAL MANUAL: GRAVAÇÃO SQLITE E ATIVAÇÃO DO ENTER
// ══════════════════════════════════════════════════════════════

test('addOrUpdateStockRecord insere e atualiza ativo com ON CONFLICT', { skip: !SQLITE_AVAILABLE }, async () => {
  const { db, dir } = makeDb();
  try {
    const res1 = db.addOrUpdateStockRecord({
      ticker: '1u1.de',
      name: '1&1 AG',
      country: 'Alemanha',
      index_name: 'DAX40'
    });
    assert.equal(res1.success, true);
    assert.equal(res1.ticker, '1U1.DE');

    const stock1 = db.getStock('1U1.DE');
    assert.ok(stock1);
    assert.equal(stock1.ticker, '1U1.DE');
    assert.equal(stock1.name, '1&1 AG');
    assert.equal(stock1.country, 'Alemanha');
    assert.equal(stock1.index_name, 'DAX40');

    // Atualização com os mesmos ou novos dados
    const res2 = db.addOrUpdateStockRecord({
      ticker: '1U1.DE',
      name: '1&1 AG Atualizada',
      country: 'Alemanha Federal',
      index_name: 'TecDAX'
    });
    assert.equal(res2.success, true);

    const stock2 = db.getStock('1U1.DE');
    assert.equal(stock2.name, '1&1 AG Atualizada');
    assert.equal(stock2.country, 'Alemanha Federal');
    assert.equal(stock2.index_name, 'TecDAX');
  } finally {
    db.close();
    removeTempDir(dir);
  }
});

test('IPC e Preload expõem addStockToWatchlist e add-stock-to-watchlist', () => {
  const mainCode = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(mainCode, /ipcMain\.handle\('add-stock-to-watchlist'/);
  assert.match(mainCode, /db\.addOrUpdateStockRecord/);

  const preloadCode = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
  assert.match(preloadCode, /addStockToWatchlist:\s*\(stockData\)\s*=>\s*ipcRenderer\.invoke\('add-stock-to-watchlist'/);
});

test('Modal manual tem estrutura HTML e lógica no renderer.js com Enter e fecho automático', () => {
  const htmlCode = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
  assert.match(htmlCode, /id="modal-add"/);
  assert.match(htmlCode, /modal-manual-container/);
  assert.match(htmlCode, /name="ticker"/);
  assert.match(htmlCode, /name="name"/);
  assert.match(htmlCode, /name="country"/);
  assert.match(htmlCode, /name="index"/);
  assert.match(htmlCode, /name="new-index"/);
  assert.match(htmlCode, /class="modal-close close-btn"/);
  assert.match(htmlCode, /id="modal-cancel"/);
  assert.match(htmlCode, /id="modal-submit"/);

  const rendererCode = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
  assert.match(rendererCode, /async function submitAndCloseManualStockModal\(\)/);
  assert.match(rendererCode, /function closeManualAddModal\(/);
  assert.match(rendererCode, /function bindManualModalEvents\(\)/);
  assert.match(rendererCode, /function handleModalEnter\(e\)/);
  assert.match(rendererCode, /submitAndCloseManualStockModal\(\)/);
});

// ═══════════════════════════════════════════════════════════
// 5. GESTOR DE ABAS E BLINDAGEM DO ARRANQUE
// ═══════════════════════════════════════════════════════════

test('Gestor central de abas e blindagem do arranque no renderer.js e index.html', () => {
  const htmlCode = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
  assert.match(htmlCode, /class="[^"]*navigation-bar[^"]*"/);
  assert.match(htmlCode, /class="[^"]*nav-tab[^"]*"/);
  assert.match(htmlCode, /class="[^"]*tab-pane[^"]*"/);
  assert.match(htmlCode, /data-tab="alpha-quant-engine"/);
  assert.match(htmlCode, /data-tab="mylist"/);
  assert.match(htmlCode, /data-tab="portfolio"/);
  assert.match(htmlCode, /data-tab="history"/);
  assert.match(htmlCode, /data-tab="simulation"/);
  assert.match(htmlCode, /data-tab="quant-tracker"/);

  const rendererCode = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
  assert.match(rendererCode, /function initTabsNavigation\(\)/);
  assert.match(rendererCode, /function switchTab\(targetTabId(?:,\s*opts)?\)/);
  assert.match(rendererCode, /window\.initTabsNavigation\s*=\s*initTabsNavigation/);
  assert.match(rendererCode, /document\.addEventListener\('DOMContentLoaded'/);
  assert.match(rendererCode, /initTabsNavigation\(\);/);
  assert.match(rendererCode, /bindManualModalEvents\(\);/);
  assert.match(rendererCode, /loadInitialStockData\(\);/);
});


