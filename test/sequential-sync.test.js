const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let SQLITE_AVAILABLE = false;
let Database;
try {
  Database = require('../src/db/database');
  const probe = require('better-sqlite3');
  probe(':memory:').close();
  SQLITE_AVAILABLE = true;
} catch (_) {}

function openDatabase() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'screen-seq-sync-test-'));
  const database = new Database(directory);
  database.init();
  return { directory, database };
}

const candle = (ticker, date, close = 100) => ({
  ticker, date, open: close, high: close + 1, low: close - 1, close, volume: 1000
});

test('auditMyListAssets devolve os mesmos dados que getMyListAssetsSyncStatus', { skip: !SQLITE_AVAILABLE }, t => {
  const { directory, database } = openDatabase();
  t.after(() => { database.close(); fs.rmSync(directory, { recursive: true, force: true }); });

  database.upsertStock({ ticker: 'AAPL', name: 'Apple Inc', country: 'US', indexName: 'SP500' });
  database.upsertStock({ ticker: 'MSFT', name: 'Microsoft', country: 'US', indexName: 'SP500' });
  database.upsertStock({ ticker: 'EDP.LS', name: 'EDP', country: 'PT', indexName: 'PSI' });

  database.saveSingleAssetCandles([candle('AAPL', '2024-06-14', 200)]);

  const auditSP500 = database.auditMyListAssets('SP500');
  assert.equal(auditSP500.length, 2);

  const auditALL = database.auditMyListAssets('ALL');
  assert.equal(auditALL.length, 3);

  const byTicker = Object.fromEntries(auditSP500.map(a => [a.ticker, a]));
  assert.equal(byTicker.AAPL.last_date, '2024-06-14');
  assert.equal(byTicker.MSFT.last_date, null);

  const syncStatusSP500 = database.getMyListAssetsSyncStatus('SP500');
  assert.equal(syncStatusSP500.length, 2);
  assert.deepEqual(auditSP500, syncStatusSP500);

  const syncStatusALL = database.getMyListAssetsSyncStatus('ALL');
  assert.equal(syncStatusALL.length, 3);
  assert.deepEqual(auditALL, syncStatusALL);
});

test('saveSingleAssetCandles grava atomicamente via transação', { skip: !SQLITE_AVAILABLE }, t => {
  const { directory, database } = openDatabase();
  t.after(() => { database.close(); fs.rmSync(directory, { recursive: true, force: true }); });

  database.upsertStock({ ticker: 'AAPL', name: 'Apple Inc', country: 'US', indexName: 'SP500' });

  const candles = [
    candle('AAPL', '2024-01-01', 100),
    candle('AAPL', '2024-01-02', 105),
    candle('AAPL', '2024-01-03', 110)
  ];
  const count = database.saveSingleAssetCandles(candles);
  assert.equal(count, 3);

  assert.equal(database.getLastStoredDate('AAPL'), '2024-01-03');

  const summary = database.getHistoricalSummary('AAPL');
  assert.equal(summary.totalCandles, 3);
});

test('saveSingleAssetCandles ignora velas inválidas sem falhar', { skip: !SQLITE_AVAILABLE }, t => {
  const { directory, database } = openDatabase();
  t.after(() => { database.close(); fs.rmSync(directory, { recursive: true, force: true }); });

  database.upsertStock({ ticker: 'TEST', name: 'Test', country: 'US', indexName: 'SP500' });

  const mixed = [
    { ticker: 'TEST', date: '2024-01-01', open: 100, high: 101, low: 99, close: 100, volume: 1000 },
    { ticker: 'TEST', date: '2024-01-02', open: NaN, high: NaN, low: NaN, close: NaN, volume: NaN },
    { ticker: '', date: '2024-01-03', open: 100, high: 101, low: 99, close: 100, volume: 1000 },
    { ticker: 'TEST', date: '2024-01-04', open: 105, high: 106, low: 104, close: 105, volume: 1000 }
  ];

  const count = database.saveSingleAssetCandles(mixed);
  assert.equal(count, 2);

  const total = database.db.prepare('SELECT COUNT(*) AS n FROM historical_prices WHERE ticker = ?').get('TEST').n;
  assert.equal(total, 2);
});

test('saveSingleAssetCandles faz UPSERT sem duplicar', { skip: !SQLITE_AVAILABLE }, t => {
  const { directory, database } = openDatabase();
  t.after(() => { database.close(); fs.rmSync(directory, { recursive: true, force: true }); });

  database.upsertStock({ ticker: 'AAPL', name: 'Apple Inc', country: 'US', indexName: 'SP500' });

  const first = [
    candle('AAPL', '2024-01-01', 100),
    candle('AAPL', '2024-01-02', 105)
  ];
  assert.equal(database.saveSingleAssetCandles(first), 2);

  const second = [
    candle('AAPL', '2024-01-01', 200),
    candle('AAPL', '2024-01-02', 210)
  ];
  assert.equal(database.saveSingleAssetCandles(second), 2);

  const rows = database.db.prepare('SELECT date, close FROM historical_prices WHERE ticker = ? ORDER BY date').all('AAPL');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].close, 200);
  assert.equal(rows[1].close, 210);

  const total = database.db.prepare('SELECT COUNT(*) AS n FROM historical_prices WHERE ticker = ?').get('AAPL').n;
  assert.equal(total, 2);
});

test('fetchLatestCandlesForSingleTicker com dados mockados retorna velas corretas', async () => {
  const axios = require('axios');
  const originalGet = axios.get;
  const { fetchLatestCandlesForSingleTicker } = require('../src/data/yahooClient');

  let capturedUrl = '';
  try {
    axios.get = async (url) => {
      capturedUrl = url;
      return {
        data: {
          chart: {
            result: [
              {
                timestamp: [1704067200, 1704153600],
                indicators: {
                  quote: [
                    {
                      open: [150, 152],
                      high: [155, 157],
                      low: [149, 151],
                      close: [154, 156],
                      volume: [10000, 12000]
                    }
                  ]
                }
              }
            ]
          }
        }
      };
    };

    const candles = await fetchLatestCandlesForSingleTicker('AAPL', '2024-01-01');
    assert.match(capturedUrl, /period1=/);
    assert.equal(candles.length, 2);
    assert.equal(candles[0].ticker, 'AAPL');
    assert.equal(candles[0].close, 154);
    assert.equal(candles[1].ticker, 'AAPL');
    assert.equal(candles[1].close, 156);
    assert.ok(candles[0].date);
    assert.ok(candles[1].date);
  } finally {
    axios.get = originalGet;
  }
});

test('fetchLatestCandlesForSingleTicker devolve [] se já atualizado', async () => {
  const axios = require('axios');
  const originalGet = axios.get;
  const { fetchLatestCandlesForSingleTicker } = require('../src/data/yahooClient');

  let called = false;
  try {
    axios.get = async () => {
      called = true;
      return { data: {} };
    };

    const futureDate = new Date(Date.now() + 86400000 * 2).toISOString().slice(0, 10);
    const result = await fetchLatestCandlesForSingleTicker('AAPL', futureDate);
    assert.deepEqual(result, []);
    assert.equal(called, false);
  } finally {
    axios.get = originalGet;
  }
});

test('fetchLatestCandlesForSingleTicker sem lastDate usa range=5d', async () => {
  const axios = require('axios');
  const originalGet = axios.get;
  const { fetchLatestCandlesForSingleTicker } = require('../src/data/yahooClient');

  let capturedUrl = '';
  try {
    axios.get = async (url) => {
      capturedUrl = url;
      return {
        data: {
          chart: {
            result: [
              {
                timestamp: [1704067200],
                indicators: {
                  quote: [
                    { open: [500], high: [510], low: [495], close: [505], volume: [50000] }
                  ]
                }
              }
            ]
          }
        }
      };
    };

    const candles = await fetchLatestCandlesForSingleTicker('NVDA', null);
    assert.match(capturedUrl, /range=5d/);
    assert.equal(candles.length, 1);
    assert.equal(candles[0].ticker, 'NVDA');
    assert.equal(candles[0].close, 505);
    assert.ok(candles[0].date);
  } finally {
    axios.get = originalGet;
  }
});

test('sync-start-download usa execução sequencial (verificação estática)', () => {
  const mainPath = path.join(__dirname, '..', 'main.js');
  const content = fs.readFileSync(mainPath, 'utf8');

  const fnStart = content.indexOf('sync-start-download');
  assert.ok(fnStart !== -1, 'sync-start-download not found in main.js');

  const fnBlock = content.slice(fnStart, fnStart + 5000);

  assert.ok(!fnBlock.includes('Promise.all(tasks)'), 'should NOT contain Promise.all(tasks)');
  assert.ok(
    /for\s*\(\s*let\s+i\s*=\s*0\s*;\s*i\s*<\s*totalPending/.test(fnBlock),
    'should contain sequential for loop over totalPending'
  );
  assert.ok(fnBlock.includes('sleep(100)'), 'should contain sleep(100) delay');
  assert.ok(
    fnBlock.includes('fetchLatestCandlesForSingleTicker') || fnBlock.includes('fetchIncrementalCandles'),
    'should reference fetchLatestCandlesForSingleTicker or fetchIncrementalCandles'
  );
  assert.ok(
    fnBlock.includes('saveSingleAssetCandles') || fnBlock.includes('saveBulkIncrementalCandles'),
    'should reference saveSingleAssetCandles or saveBulkIncrementalCandles'
  );
});

test('sync-start-download retorna started:true e corre download em background', () => {
  const mainPath = path.join(__dirname, '..', 'main.js');
  const content = fs.readFileSync(mainPath, 'utf8');

  const fnStart = content.indexOf('sync-start-download');
  assert.ok(fnStart !== -1, 'sync-start-download not found in main.js');

  const fnBlock = content.slice(fnStart, fnStart + 5000);

  assert.ok(fnBlock.includes('started: true'), 'should return started:true for immediate response');
  assert.ok(fnBlock.includes('syncRecentInProgress'), 'should use concurrency guard');
  assert.ok(/\(async\s*\(\)\s*=>/.test(fnBlock), 'should use IIFE for background work');
  assert.ok(fnBlock.includes("sendEvent('sync-all-done'"), 'should send done event from background');
  assert.ok(fnBlock.includes("sendEvent('SYNC_RECENT_PROGRESS'"), 'should send progress events from background');
});

test('sync-audit devolve lista de pendentes e em-dia sem HTTP', () => {
  const mainPath = path.join(__dirname, '..', 'main.js');
  const content = fs.readFileSync(mainPath, 'utf8');

  const fnStart = content.indexOf('sync-audit');
  assert.ok(fnStart !== -1, 'sync-audit not found in main.js');

  const fnBlock = content.slice(fnStart, fnStart + 2000);

  assert.ok(fnBlock.includes('pendingList'), 'should return pendingList');
  assert.ok(fnBlock.includes('upToDateList'), 'should return upToDateList');
  assert.ok(fnBlock.includes('pending: pendingList.length'), 'should return pending count');
  assert.ok(fnBlock.includes('upToDate: upToDateList.length'), 'should return upToDate count');
  assert.ok(!fnBlock.includes('yahooClient'), 'should NOT make HTTP calls');
  assert.ok(!fnBlock.includes('fetchLatestCandles'), 'should NOT fetch candles');
});
