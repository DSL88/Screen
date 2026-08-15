const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const preload = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');

test('há um único handler para a operação de primeiras datas', () => {
  assert.equal((main.match(/ipcMain\.handle\(['"]UPDATE_INDEX_FIRST_DATES['"]/g) || []).length, 1);
  assert.equal((main.match(/ipcMain\.handle\(['"]fetch-first-date-index['"]/g) || []).length, 0);
  assert.equal((main.match(/ipcMain\.handle\(['"]sync-index-first-dates['"]/g) || []).length, 0);
  assert.match(preload, /ipcRenderer\.invoke\('UPDATE_INDEX_FIRST_DATES'/);
});

test('cancelamento e progresso final fazem parte do contrato IPC', () => {
  assert.match(main, /ipcMain\.handle\(['"]index:cancel['"]/);
  assert.match(preload, /cancelIndexOperation/);
  assert.match(main, /status: 'done'/);
  assert.match(main, /state: finalStatus/);
});

test('eliminação de índice expõe um único handler e preload coerente', () => {
  assert.equal((main.match(/ipcMain\.handle\(['"]delete-index-with-stocks['"]/g) || []).length, 1);
  assert.match(main, /db\.deleteIndexAndStocks\(indexName\)/);
  assert.match(preload, /deleteIndexWithStocks:\s*\(indexName\)\s*=>\s*ipcRenderer\.invoke\('delete-index-with-stocks', indexName\)/);
});

test('1º Registo expõe um único handler, progresso por ticker e preload coerente', () => {
  assert.equal((main.match(/ipcMain\.handle\(['"]first-registo-index['"]/g) || []).length, 1);
  assert.match(main, /beginPipelineOperation\('first-registo'/);
  assert.match(main, /send\('first-registo-progress'/);
  assert.match(main, /db\.updateStockFirstDate\(/);
  assert.match(main, /db\.saveHistoricalCandlesFromImport\(/);
  assert.match(main, /db\.setFullHistoryFetched\(/);
  assert.match(main, /CHUNK_SIZE\s*=\s*3/);
  assert.match(preload, /firstRegisto:\s*\(index,\s*operationId\)\s*=>\s*ipcRenderer\.invoke\('first-registo-index'/);
  assert.match(preload, /onFirstRegistoProgress/);
  assert.match(preload, /'first-registo-progress'/);
});

test('check-index-status usa o validador completo checkIndexStatus', () => {
  assert.equal((main.match(/ipcMain\.handle\(['"]check-index-status['"]/g) || []).length, 1);
  assert.match(main, /db\.checkIndexStatus\(index\)/);
  assert.match(preload, /checkIndexStatus:\s*\(indexName\)\s*=>\s*ipcRenderer\.invoke\('check-index-status', indexName\)/);
});
