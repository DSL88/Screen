const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('../src/db/database');
const SQLite = require('better-sqlite3');

function openDatabase() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'screen-pipeline-test-'));
  const database = new Database(directory);
  database.init();
  return { directory, database };
}

test('UPSERT preserva metadados não fornecidos e normaliza o id do índice', t => {
  const { directory, database } = openDatabase();
  t.after(() => {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  database.upsertStock({
    ticker: 'ABC.PA', name: 'ABC', country: 'França', indexName: 'EUA — S&P 500', firstDate: '2000-01-01'
  });
  database.upsertStock({ ticker: 'ABC.PA', name: '', country: '', indexName: '', firstDate: '', fullHistoryFetched: null });

  assert.deepEqual(database.getStockByTicker('ABC.PA'), {
    ticker: 'ABC.PA', name: 'ABC', country: 'França', index_name: 'SP500',
    first_date: '2000-01-01', full_history_fetched: 0
  });
});

test('histórico é idempotente e só fica completo quando explicitamente marcado', t => {
  const { directory, database } = openDatabase();
  t.after(() => {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  database.upsertStock({ ticker: 'ABC', indexName: 'SP500' });
  const candle = { date: '2020-01-01', open: 1, high: 2, low: 1, close: 2, volume: 10 };
  assert.equal(database.saveHistoricalCandlesFromImport('ABC', [candle]).changes, 1);
  assert.equal(database.saveHistoricalCandlesFromImport('ABC', [candle]).changes, 0);
  assert.equal(database.getFullHistoryFetched('ABC'), false);

  database.setFullHistoryFetched('ABC');
  assert.equal(database.getFullHistoryFetched('ABC'), true);
  database.deleteHistoricalPrices('ABC');
  assert.equal(database.getFullHistoryFetched('ABC'), false);
});

test('consulta por label antigo resolve para o id canónico sem devolver outros índices', t => {
  const { directory, database } = openDatabase();
  t.after(() => {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  database.upsertStock({ ticker: 'A', indexName: 'DAX 40' });
  database.upsertStock({ ticker: 'B', indexName: 'CAC40' });
  assert.deepEqual(database.getTickersForIndex('Alemanha — DAX 40'), ['A']);
  assert.deepEqual(database.getTickersForIndex('not-an-index'), []);
});

test('migração defensiva converte labels de bases antigas', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'screen-pipeline-legacy-'));
  const filename = path.join(directory, 'trades.db');
  const legacy = new SQLite(filename);
  legacy.exec(`
    CREATE TABLE stocks (ticker TEXT PRIMARY KEY, name TEXT NOT NULL, country TEXT NOT NULL, index_name TEXT NOT NULL);
    CREATE TABLE custom_tickers (ticker TEXT PRIMARY KEY, name TEXT, exchange TEXT, type TEXT);
    INSERT INTO stocks VALUES ('OLD', 'Old', 'EUA', 'EUA — S&P 500');
    INSERT INTO custom_tickers VALUES ('OLD', 'Old', '', 'EQUITY');
  `);
  legacy.close();

  const database = new Database(directory);
  database.init();
  t.after(() => {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  assert.equal(database.getStockByTicker('OLD').index_name, 'SP500');
  assert.equal(database.db.prepare('SELECT index_name FROM custom_tickers WHERE ticker = ?').get('OLD').index_name, 'SP500');
});
