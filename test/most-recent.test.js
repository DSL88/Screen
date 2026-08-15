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
