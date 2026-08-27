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
} catch (_) {
  // Native addon may be unavailable when Node/Electron ABIs differ.
}

const { isIncrementalUpToDate } = require('../src/utils/dateUtils');

function openDatabase() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'screen-most-recent-test-'));
  const database = new Database(directory);
  database.init();
  return { directory, database };
}

const candle = (ticker, date, close = 100) => ({ ticker, date, open: close, high: close + 1, low: close - 1, close, volume: 1000 });

test('getLastStoredDate devolve MAX(date) e null quando não há velas', { skip: !SQLITE_AVAILABLE }, t => {
  const { directory, database } = openDatabase();
  t.after(() => { database.close(); fs.rmSync(directory, { recursive: true, force: true }); });

  assert.equal(database.getLastStoredDate('AAA'), null);
  database.saveHistoricalCandlesFromImport('AAA', [candle('AAA', '2024-01-01'), candle('AAA', '2024-01-03'), candle('AAA', '2024-01-02')]);
  assert.equal(database.getLastStoredDate('AAA'), '2024-01-03');
});

test('isIncrementalUpToDate compara a última data com o dia esperado', () => {
  assert.equal(isIncrementalUpToDate('2024-06-14', '2024-06-14'), true);
  assert.equal(isIncrementalUpToDate('2024-06-15', '2024-06-14'), true);
  assert.equal(isIncrementalUpToDate('2024-06-13', '2024-06-14'), false);
  assert.equal(isIncrementalUpToDate(null, '2024-06-14'), false);
  assert.equal(isIncrementalUpToDate('2024-06-13', null), false);
});

test('saveHistoricalCandlesBatch grava em lote com UPSERT sem duplicar a chave', { skip: !SQLITE_AVAILABLE }, t => {
  const { directory, database } = openDatabase();
  t.after(() => { database.close(); fs.rmSync(directory, { recursive: true, force: true }); });

  database.upsertStock({ ticker: 'AAA', indexName: 'PSI' });
  const entries = [
    { ticker: 'AAA', candles: [candle('AAA', '2024-06-12', 10), candle('AAA', '2024-06-13', 11)] },
    { ticker: 'AAA', candles: [candle('AAA', '2024-06-14', 12)] }
  ];
  const first = database.saveHistoricalCandlesBatch(entries);
  assert.equal(first.changes, 3);

  const duplicate = database.saveHistoricalCandlesBatch([
    { ticker: 'AAA', candles: [candle('AAA', '2024-06-14', 99)] }
  ]);
  assert.equal(duplicate.changes, 1);
  assert.equal(database.getLocalHistoricalPrices('AAA').filter(c => c.date === '2024-06-14')[0].close, 99);
  assert.equal(database.db.prepare('SELECT COUNT(*) AS n FROM historical_prices WHERE ticker = ?').get('AAA').n, 3);
});

test('fluxo 1º Registo: updateStockFirstDate + histórico desde a origem + setFullHistoryFetched é idempotente', { skip: !SQLITE_AVAILABLE }, t => {
  const { directory, database } = openDatabase();
  t.after(() => { database.close(); fs.rmSync(directory, { recursive: true, force: true }); });

  database.upsertStock({ ticker: 'AAA', name: 'AAA', country: 'Portugal', indexName: 'PSI' });
  database.updateStockFirstDate('AAA', '2010-01-01');
  assert.equal(database.getStockByTicker('AAA').first_date, '2010-01-01');

  const history = [candle('AAA', '2010-01-01', 5), candle('AAA', '2010-01-02', 6)];
  assert.equal(database.saveHistoricalCandlesFromImport('AAA', history).changes, 2);
  database.setFullHistoryFetched('AAA');
  assert.equal(database.getFullHistoryFetched('AAA'), true);

  const summary = database.getHistoricalSummary('AAA');
  assert.equal(summary.firstDate, '2010-01-01');
  assert.equal(summary.hasData, true);
  assert.equal(summary.fullHistoryFetched, true);

  // Re-importar o mesmo histórico não duplica nem perde a marca de completo.
  assert.equal(database.saveHistoricalCandlesFromImport('AAA', history).changes, 0);
  assert.equal(database.getFullHistoryFetched('AAA'), true);
});

test('updateStockFirstDate aceita o ticker em minúsculas e normaliza', { skip: !SQLITE_AVAILABLE }, t => {
  const { directory, database } = openDatabase();
  t.after(() => { database.close(); fs.rmSync(directory, { recursive: true, force: true }); });

  database.upsertStock({ ticker: 'AAA.LS', name: 'AAA', country: 'Portugal', indexName: 'PSI' });
  database.updateStockFirstDate('aaa.ls', '2011-03-01');
  assert.equal(database.getStockByTicker('AAA.LS').first_date, '2011-03-01');
});

test('checkIndexDataStatus continua a existir e é coerente com o novo checkIndexStatus', { skip: !SQLITE_AVAILABLE }, t => {
  const { directory, database } = openDatabase();
  t.after(() => { database.close(); fs.rmSync(directory, { recursive: true, force: true }); });

  database.upsertStock({ ticker: 'AAA', indexName: 'PSI' });
  database.saveHistoricalCandlesFromImport('AAA', [candle('AAA', '2024-06-14')]);

  const legacy = database.checkIndexDataStatus('PSI');
  assert.equal(legacy.hasStocks, true);
  assert.equal(legacy.hasPrices, true);
  assert.equal(legacy.stocksWithDataCount, 1);

  const full = database.checkIndexStatus('PSI');
  assert.equal(full.totalStocks, 1);
  assert.equal(full.stocks.length, 1);
  assert.ok(full.status);
});

test('addCustomTickersBulk mantém a tabela stocks em sincronia (M1: 1º Registo/status cobrem adições em bloco)', { skip: !SQLITE_AVAILABLE }, t => {
  const { directory, database } = openDatabase();
  t.after(() => { database.close(); fs.rmSync(directory, { recursive: true, force: true }); });

  const items = [
    { ticker: 'AAA', name: 'AAA', country: 'Portugal', indexName: 'PSI' },
    { ticker: 'BBB', name: 'BBB', country: 'Portugal', indexName: 'PSI' }
  ];
  const res = database.addCustomTickersBulk(items);
  assert.ok(res.changes >= 1);

  assert.equal(database.getCustomTickers().length, 2);
  assert.equal(database.getStocksByIndex('PSI').length, 2);
  assert.equal(database.checkIndexStatus('PSI').totalStocks, 2);

  // Re-adicionar não duplica nem apaga o first_date já gravado.
  database.updateStockFirstDate('AAA', '2010-01-01');
  database.addCustomTickersBulk([{ ticker: 'AAA', name: 'AAA', country: 'Portugal', indexName: 'PSI' }]);
  assert.equal(database.getStockByTicker('AAA').first_date, '2010-01-01');
  assert.equal(database.getStocksByIndex('PSI').length, 2);
});

test('saveHistoricalCandles com assinatura (ticker, candles) insere atomicamente e define first_date quando ausente', { skip: !SQLITE_AVAILABLE }, t => {
  const { directory, database } = openDatabase();
  t.after(() => { database.close(); fs.rmSync(directory, { recursive: true, force: true }); });

  database.upsertStock({ ticker: 'NVDA', name: 'Nvidia', country: 'US', indexName: 'SP500' });
  const candles = [
    { date: '2024-01-10', open: 500, high: 510, low: 495, close: 505, volume: 1000000 },
    { date: '2024-01-11', open: 506, high: 520, low: 504, close: 515, volume: 1200000 }
  ];
  const res = database.saveHistoricalCandles('NVDA', candles);
  assert.equal(res.changes, 2);
  assert.equal(database.getLastStoredDate('NVDA'), '2024-01-11');
  assert.equal(database.getStockByTicker('NVDA').first_date, '2024-01-10');
});

test('syncSingleTicker faz fallback automático para ativos sem histórico prévio', { skip: !SQLITE_AVAILABLE }, async t => {
  const { directory, database } = openDatabase();
  t.after(() => { database.close(); fs.rmSync(directory, { recursive: true, force: true }); });

  const yahooModule = require('yahoo-finance2');
  const yahoo = yahooModule.default || yahooModule;
  const originalChart = yahoo.chart;

  database.upsertStock({ ticker: 'NEWSTOCK', name: 'New Stock Inc', country: 'US', indexName: 'SP500' });

  const { syncSingleTicker } = require('../src/data/yahooClient');

  try {
    yahoo.chart = async (ticker) => {
      return {
        quotes: [
          { date: new Date('2024-06-01T00:00:00Z'), open: 100, high: 105, low: 99, close: 104, volume: 5000 },
          { date: new Date('2024-06-02T00:00:00Z'), open: 104, high: 106, low: 103, close: 105, volume: 6000 }
        ]
      };
    };

    const res = await syncSingleTicker('NEWSTOCK', '2024-06-03', database);
    assert.equal(res.status, 'INITIALIZED_FALLBACK');
    assert.equal(res.count, 2);
    assert.equal(database.getLastStoredDate('NEWSTOCK'), '2024-06-02');
    assert.equal(database.getStockByTicker('NEWSTOCK').first_date, '2024-06-01');

    // Segunda chamada: ativo já em dia deve devolver SKIPPED_ALREADY_SYNCED
    const resAlready = await syncSingleTicker('NEWSTOCK', '2024-06-02', database);
    assert.equal(resAlready.status, 'SKIPPED_ALREADY_SYNCED');
  } finally {
    yahoo.chart = originalChart;
  }
});

test('getMyListAssetsWithDates devolve todos os ativos e a respetiva data máxima numa query rápida', { skip: !SQLITE_AVAILABLE }, t => {
  const { directory, database } = openDatabase();
  t.after(() => { database.close(); fs.rmSync(directory, { recursive: true, force: true }); });

  database.upsertStock({ ticker: 'AAA', name: 'Alpha', country: 'PT', indexName: 'PSI' });
  database.upsertStock({ ticker: 'BBB', name: 'Beta', country: 'PT', indexName: 'PSI' });
  database.saveHistoricalCandles('AAA', [candle('AAA', '2024-01-01'), candle('AAA', '2024-01-05')]);

  const assets = database.getMyListAssetsWithDates('PSI');
  assert.equal(assets.length, 2);
  const byTicker = Object.fromEntries(assets.map(a => [a.ticker, a]));
  assert.equal(byTicker.AAA.last_date, '2024-01-05');
  assert.equal(byTicker.BBB.last_date, null);
});

test('saveIncrementalCandles grava lista plana via transação atómica', { skip: !SQLITE_AVAILABLE }, t => {
  const { directory, database } = openDatabase();
  t.after(() => { database.close(); fs.rmSync(directory, { recursive: true, force: true }); });

  database.upsertStock({ ticker: 'CCC', name: 'Gamma', country: 'US', indexName: 'SP500' });
  const candles = [
    candle('CCC', '2024-06-01', 100),
    candle('CCC', '2024-06-02', 105)
  ];
  const count = database.saveIncrementalCandles(candles);
  assert.equal(count, 2);
  assert.equal(database.getLastStoredDate('CCC'), '2024-06-02');
  assert.equal(database.getStockByTicker('CCC').first_date, '2024-06-01');
});

test('fetchMissingRecentCandles requisita velas incrementais ou 5d para novos ativos', async () => {
  const axios = require('axios');
  const originalGet = axios.get;
  const { fetchMissingRecentCandles } = require('../src/data/yahooClient');

  try {
    let requestedUrl = '';
    axios.get = async (url) => {
      requestedUrl = url;
      return {
        data: {
          chart: {
            result: [
              {
                timestamp: [1718000000],
                indicators: {
                  quote: [
                    { open: [100], high: [105], low: [99], close: [104], volume: [1000] }
                  ]
                }
              }
            ]
          }
        }
      };
    };

    const candlesWithLast = await fetchMissingRecentCandles('AAA', '2024-06-01');
    assert.match(requestedUrl, /period1=/);
    assert.equal(candlesWithLast.length, 1);
    assert.equal(candlesWithLast[0].ticker, 'AAA');
    assert.equal(candlesWithLast[0].close, 104);

    const candlesVirgin = await fetchMissingRecentCandles('BBB', null);
    assert.match(requestedUrl, /range=5d/);
    assert.equal(candlesVirgin.length, 1);
    assert.equal(candlesVirgin[0].ticker, 'BBB');
  } finally {
    axios.get = originalGet;
  }
});

test('getMyListAssetsSyncStatus e saveBulkIncrementalCandles cumprem o fluxo otimizado', { skip: !SQLITE_AVAILABLE }, t => {
  const { directory, database } = openDatabase();
  t.after(() => { database.close(); fs.rmSync(directory, { recursive: true, force: true }); });

  database.upsertStock({ ticker: 'AAPL', name: 'Apple Inc', country: 'US', indexName: 'SP500' });
  database.upsertStock({ ticker: 'MSFT', name: 'Microsoft', country: 'US', indexName: 'SP500' });
  database.upsertStock({ ticker: 'EDP.LS', name: 'EDP', country: 'PT', indexName: 'PSI' });

  // Sem cotações
  const initialStatus = database.getMyListAssetsSyncStatus('SP500');
  assert.equal(initialStatus.length, 2);
  assert.equal(initialStatus[0].ticker, 'AAPL');
  assert.equal(initialStatus[0].last_date, null);
  assert.equal(initialStatus[1].ticker, 'MSFT');
  assert.equal(initialStatus[1].last_date, null);

  // Inserção em bloco com saveBulkIncrementalCandles
  const candles = [
    { ticker: 'AAPL', date: '2026-08-25', open: 220, high: 225, low: 219, close: 224, volume: 50000000 },
    { ticker: 'AAPL', date: '2026-08-26', open: 224, high: 228, low: 223, close: 227, volume: 48000000 },
    { ticker: 'MSFT', date: '2026-08-26', open: 410, high: 415, low: 409, close: 414, volume: 20000000 }
  ];

  const saved = database.saveBulkIncrementalCandles(candles);
  assert.equal(saved, 3);

  // Re-auditoria instantânea
  const updatedStatus = database.getMyListAssetsSyncStatus('SP500');
  assert.equal(updatedStatus.length, 2);
  assert.equal(updatedStatus.find(a => a.ticker === 'AAPL').last_date, '2026-08-26');
  assert.equal(updatedStatus.find(a => a.ticker === 'MSFT').last_date, '2026-08-26');

  // Filtro ALL
  const allStatus = database.getMyListAssetsSyncStatus('ALL');
  assert.equal(allStatus.length, 3);
});

test('fetchIncrementalCandles calcula período correto e ignora se já atualizado', async () => {
  const axios = require('axios');
  const originalGet = axios.get;
  const { fetchIncrementalCandles } = require('../src/services/yahooClient');

  try {
    let requestedUrl = '';
    axios.get = async (url) => {
      requestedUrl = url;
      return {
        data: {
          chart: {
            result: [
              {
                timestamp: [1718000000],
                indicators: {
                  quote: [
                    { open: [150], high: [155], low: [149], close: [154], volume: [2000] }
                  ]
                }
              }
            ]
          }
        }
      };
    };

    // Caso A: Ativo com data anterior
    const res = await fetchIncrementalCandles('AAPL', '2024-01-01');
    assert.match(requestedUrl, /period1=/);
    assert.equal(res.length, 1);
    assert.equal(res[0].ticker, 'AAPL');
    assert.equal(res[0].close, 154);

    // Caso B: Ativo sem data prévia
    const resVirgin = await fetchIncrementalCandles('NVDA', null);
    assert.match(requestedUrl, /range=5d/);
    assert.equal(resVirgin.length, 1);
    assert.equal(resVirgin[0].ticker, 'NVDA');

    // Caso C: Ativo com data no futuro ou timestamp atual
    const futureDate = new Date(Date.now() + 86400000 * 2).toISOString().slice(0, 10);
    const resFuture = await fetchIncrementalCandles('AAPL', futureDate);
    assert.deepEqual(resFuture, []);
  } finally {
    axios.get = originalGet;
  }
});



