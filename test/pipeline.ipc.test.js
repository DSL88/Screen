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

test('auditoria do índice expõe um único handler e preload coerente', () => {
  assert.equal((main.match(/ipcMain\.handle\(['"]audit-index['"]/g) || []).length, 1);
  assert.match(main, /db\.auditIndexStocks\(index\)/);
  assert.match(main, /return \{ ok: true, \.\.\.audit \}/);
  assert.match(preload, /auditIndex:\s*\(indexName\)\s*=>\s*ipcRenderer\.invoke\('audit-index', indexName\)/);
});

test('sync-index-first-records expõe um único handler com progresso e contrato de estado', () => {
  assert.equal((main.match(/ipcMain\.handle\(['"]sync-index-first-records['"]/g) || []).length, 1);
  assert.match(main, /db\.auditIndexStocks\(index\)/);
  assert.match(main, /sendPipelineProgress\(event, 'index-sync-progress'/);
  assert.match(main, /db\.updateStockFirstDate\(ticker, firstDate\)/);
  assert.match(main, /db\.saveHistoricalCandlesFromImport\(ticker, candles\)/);
  assert.match(main, /db\.setFullHistoryFetched\(ticker\)/);
  // Contrato de retorno: status ∈ success | partial | failed | complete
  assert.match(main, /status: finalStatus/);
  assert.match(main, /status: 'complete'/);
  assert.match(main, /status: 'failed'/);
  assert.match(main, /state: finalStatus/);
  assert.match(main, /return \{ ok: true, success: true, status: 'complete'/);
  assert.match(preload, /syncIndexFirstRecords:\s*\(index,\s*operationId\)\s*=>\s*ipcRenderer\.invoke\('sync-index-first-records'/);
  assert.match(preload, /onIndexSyncProgress/);
  assert.match(preload, /'index-sync-progress'/);
});

test('get-distinct-indices expõe um único handler que devolve { ok: true, indices }', () => {
  assert.equal((main.match(/ipcMain\.handle\(['"]get-distinct-indices['"]/g) || []).length, 1);
  assert.match(main, /db\.getAllDistinctIndices\(\)/);
  assert.match(main, /return \{ ok: true, indices \};/);
  // Sem payload; contrato de retorno: sucesso espalha o array, erro normaliza.
  assert.match(main, /return \{ ok: false, error: err\.message \|\| String\(err\) \};/);
  assert.match(preload, /getDistinctIndices:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('get-distinct-indices'\)/);
});

test('update-stock-metadata expõe um único handler que delega em db.updateStockMetadata', () => {
  assert.equal((main.match(/ipcMain\.handle\(['"]update-stock-metadata['"]/g) || []).length, 1);
  assert.match(main, /db\.updateStockMetadata\(ticker, payload && payload\.data\)/);
  // Guarda de ticker em falta antes de tocar na BD.
  assert.match(main, /if \(!ticker\) return \{ ok: false, error: 'missing-ticker' \};/);
  // Contrato de retorno: sucesso espalha o resultado { success, ticker, changes };
  // erro normaliza result.success === false → { ok: false, error }.
  assert.match(main, /if \(!result \|\| result\.success === false\)/);
  assert.match(main, /return \{ ok: true, \.\.\.result \};/);
  assert.match(main, /return \{ ok: false, error: \(result && result\.error\) \|\| 'invalid-input' \};/);
  assert.match(preload, /updateStockMetadata:\s*\(ticker,\s*data\)\s*=>\s*ipcRenderer\.invoke\('update-stock-metadata',\s*\{\s*ticker,\s*data\s*\}\)/);
});

test('sync-audit e sync-start-download expõem contrato de 2 fases separadas', () => {
  assert.equal((main.match(/ipcMain\.handle\(['"]sync-audit['"]/g) || []).length, 1);
  assert.equal((main.match(/ipcMain\.handle\(['"]sync-start-download['"]/g) || []).length, 1);
  assert.match(main, /db\.auditMyListAssets|db\.getMyListAssetsSyncStatus/);
  assert.match(main, /db\.getLastExpectedTradingDay\(\)/);
  assert.match(main, /yahooClient\.fetchLatestCandlesForSingleTicker|yahooClient\.fetchIncrementalCandles/);
  assert.match(main, /db\.saveSingleAssetCandles|db\.saveBulkIncrementalCandles/);
  assert.match(main, /pendingList/);
  assert.match(main, /upToDateList/);
  assert.match(preload, /syncAudit:/);
  assert.match(preload, /syncStartDownload:/);
  assert.match(preload, /'SYNC_RECENT_PROGRESS'/);
});

