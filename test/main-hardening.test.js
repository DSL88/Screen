const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { syncTickersBatch, networkLimit } = require('../src/data/yahooClient');

const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const preload = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
const yahooData = fs.readFileSync(path.join(__dirname, '..', 'src', 'data', 'yahooClient.js'), 'utf8');

const mkCandle = (ticker, date) => ({
  ticker, date, open: 1, high: 1, low: 1, close: 1, volume: 1
});

test('syncTickersBatch com fetchMethod que readquire networkLimit não faz deadlock', async () => {
  const tickers = Array.from({ length: 8 }, (_, i) => `DL${i}`);
  const run = syncTickersBatch(tickers, {
    getLastDate: () => '2020-01-01',
    expectedTradingDay: null,
    fetchMethod: async (ticker) => {
      // Simula as funções de produção (fetchIncrementalYahooHistory):
      // adquirem o networkLimit internamente.
      return await networkLimit(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return [mkCandle(ticker, '2020-01-02')];
      });
    }
  });
  const results = await Promise.race([
    run,
    new Promise((_, reject) => setTimeout(() => reject(new Error('deadlock: p-limit reentrante')), 3000))
  ]);
  assert.equal(results.length, 8);
  assert.equal(results.every((r) => r.status === 'SUCCESS'), true);
});

test('main.js bloqueia navegação e novas janelas', () => {
  assert.match(main, /will-navigate/);
  assert.match(main, /setWindowOpenHandler/);
  assert.match(main, /shell\.openExternal/);
  assert.match(main, /devTools:\s*!app\.isPackaged/);
});

test('main.js limita imports a paths aprovados por dialog', () => {
  assert.match(main, /approvedImportPaths/);
  assert.match(main, /validateImportPath/);
  assert.match(main, /registerApprovedImportPath\(filePath\)/);
  assert.match(main, /MAX_IMPORT_BYTES/);
  assert.match(main, /file-not-approved/);
});

test('main.js valida db:purgeInactive, params:set, ticker:search e registra sync-all-recent-prices', () => {
  assert.match(main, /ipcMain\.handle\('db:purgeInactive'/);
  assert.match(main, /invalid-cutoff/);
  assert.match(main, /invalid-param-key/);
  assert.match(main, /Math\.min\(20, Math\.max\(1, Math\.floor\(parsedLimit\)\)\)/);
  assert.equal((main.match(/ipcMain\.handle\('sync-all-recent-prices'/g) || []).length, 1);
  assert.match(preload, /syncAllRecentPrices:/);
  assert.match(preload, /syncAllListStocks:/);
});

test('main.js não reutiliza networkLimit dentro das tasks do 1º Registo', () => {
  assert.doesNotMatch(main, /pending\.map\(\(stock\)\s*=>\s*yahooClient\.networkLimit/);
  assert.match(main, /firstRecordsLimit/);
  assert.match(yahooData, /const batchLimit = pLimit\(5\)/);
  assert.match(yahooData, /list\.map\(ticker => batchLimit\(async \(\) => \{/);
});
