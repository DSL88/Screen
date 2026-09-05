const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const rootDir = path.resolve(__dirname, '..');

test('HTML: modal-first-record-choice e todos os elementos de UI existem', () => {
  const html = fs.readFileSync(path.join(rootDir, 'renderer', 'index.html'), 'utf-8');

  assert.ok(html.includes('id="modal-first-record-choice"'), 'index.html deve conter modal-first-record-choice');
  assert.ok(html.includes('id="first-record-choice-target"'), 'index.html deve conter first-record-choice-target');
  assert.ok(html.includes('id="target-index-pill-badge"'), 'index.html deve conter target-index-pill-badge');
  assert.ok(html.includes('id="btn-choice-prices-only"'), 'index.html deve conter btn-choice-prices-only');
  assert.ok(html.includes('id="btn-choice-dividends-only"'), 'index.html deve conter btn-choice-dividends-only');
  assert.ok(html.includes('id="btn-choice-both"'), 'index.html deve conter btn-choice-both');
  assert.ok(html.includes('id="choice-modal-progress-box"'), 'index.html deve conter choice-modal-progress-box');
  assert.ok(html.includes('id="choice-modal-status-text"'), 'index.html deve conter choice-modal-status-text');
  assert.ok(html.includes('id="choice-modal-counter"'), 'index.html deve conter choice-modal-counter');
  assert.ok(html.includes('id="choice-modal-progress-bar"'), 'index.html deve conter choice-modal-progress-bar');
  assert.ok(html.includes('id="btn-close-choice-modal"'), 'index.html deve conter btn-close-choice-modal');
  assert.ok(html.includes('id="btn-cancel-choice-modal"'), 'index.html deve conter btn-cancel-choice-modal');
});

test('Renderer: lógica de abertura, fecho e execução em lote no renderer.js', () => {
  const js = fs.readFileSync(path.join(rootDir, 'renderer', 'renderer.js'), 'utf-8');

  assert.ok(js.includes('openFirstRecordChoiceModal'), 'renderer.js deve definir openFirstRecordChoiceModal');
  assert.ok(js.includes('closeFirstRecordChoiceModal'), 'renderer.js deve definir closeFirstRecordChoiceModal');
  assert.ok(js.includes('executeBatchDownload'), 'renderer.js deve definir executeBatchDownload');
  assert.ok(js.includes('PRICES_ONLY'), 'renderer.js deve suportar modo PRICES_ONLY');
  assert.ok(js.includes('DIVIDENDS_ONLY'), 'renderer.js deve suportar modo DIVIDENDS_ONLY');
  assert.ok(js.includes('BOTH'), 'renderer.js deve suportar modo BOTH');
  assert.ok(js.includes('btn-choice-prices-only'), 'renderer.js deve escutar btn-choice-prices-only');
  assert.ok(js.includes('btn-choice-dividends-only'), 'renderer.js deve escutar btn-choice-dividends-only');
  assert.ok(js.includes('btn-choice-both'), 'renderer.js deve escutar btn-choice-both');
  assert.ok(js.includes('onSyncProgressUpdate'), 'renderer.js deve escutar onSyncProgressUpdate');
});

test('Preload: expõe syncIndexDataBatch e onSyncProgressUpdate', () => {
  const preload = fs.readFileSync(path.join(rootDir, 'preload.js'), 'utf-8');

  assert.ok(preload.includes("'sync-index-data-batch'"), 'preload.js deve invocar sync-index-data-batch');
  assert.ok(preload.includes('syncIndexDataBatch:'), 'preload.js deve expor syncIndexDataBatch');
  assert.ok(preload.includes('onSyncProgressUpdate:'), 'preload.js deve expor onSyncProgressUpdate');
  assert.ok(preload.includes("'SYNC_PROGRESS_UPDATE'"), 'preload.js deve tratar evento SYNC_PROGRESS_UPDATE');
});

test('IPC Handlers: sync-index-data-batch registado nos pontos de entrada IPC', () => {
  const mainJs = fs.readFileSync(path.join(rootDir, 'main.js'), 'utf-8');
  const srcMain = fs.readFileSync(path.join(rootDir, 'src', 'main', 'main.js'), 'utf-8');
  const ipcHandlers = fs.readFileSync(path.join(rootDir, 'src', 'ipc', 'ipcHandlers.js'), 'utf-8');

  assert.ok(mainJs.includes("'sync-index-data-batch'"), 'main.js deve registar sync-index-data-batch');
  assert.ok(srcMain.includes("'sync-index-data-batch'"), 'src/main/main.js deve registar sync-index-data-batch');
  assert.ok(ipcHandlers.includes("'sync-index-data-batch'"), 'src/ipc/ipcHandlers.js deve registar sync-index-data-batch');

  // Verifica que emitem SYNC_PROGRESS_UPDATE
  assert.ok(ipcHandlers.includes("'SYNC_PROGRESS_UPDATE'"), 'ipcHandlers deve emitir SYNC_PROGRESS_UPDATE');
});

test('Database: getStocksByIndex recupera ativos para processamento', () => {
  const Database = require(path.join(rootDir, 'src', 'db', 'database.js'));
  const os = require('node:os');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'screen-test-first-choice-'));

  const db = new Database(directory);
  db.init();
  try {
    // Insere ações de teste
    db.upsertStock({ ticker: 'TEST_FC1', name: 'FC Corp 1', indexName: 'TEST_INDEX' });
    db.upsertStock({ ticker: 'TEST_FC2', name: 'FC Corp 2', indexName: 'TEST_INDEX' });
    db.upsertStock({ ticker: 'TEST_FC3', name: 'FC Corp 3', indexName: 'OTHER_INDEX' });

    const filtered = db.getStocksByIndex('TEST_INDEX');
    assert.strictEqual(filtered.length, 2, 'Deve encontrar 2 ativos para TEST_INDEX');
    assert.ok(filtered.some(s => s.ticker === 'TEST_FC1'));
    assert.ok(filtered.some(s => s.ticker === 'TEST_FC2'));

    const allStocks = db.getStocksByIndex(null);
    assert.ok(allStocks.length >= 3, 'Deve encontrar todos os ativos quando indexFilter é nulo');
  } finally {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
