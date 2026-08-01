const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
let DB;
let SQLITE_AVAILABLE = false;
try {
  DB = require('../src/db/database');
  const Sqlite = require('better-sqlite3');
  const probe = new Sqlite(':memory:');
  probe.close();
  SQLITE_AVAILABLE = true;
} catch (_) {}
const { parseFile, importFromCsvFile } = require('../src/importer/historicalImporter');
const { makeTempDir, removeTempDir } = require('./helpers');

test('parser CSV normaliza headers/datas, ordena e descarta linhas inválidas', () => {
  const dir = makeTempDir();
  const file = path.join(dir, 'prices.csv');
  fs.writeFileSync(file, [
    'Ticker,DATE,Open,High,Low,Close,Volume',
    'AAA,01/02/2024,10,11,9,10.5,1000',
    'AAA,2024-01-01,9,10,8,9,100',
    'AAA,not-a-date,9,10,8,9,100',
    'AAA,2024-01-03,invalid,10,8,9,100'
  ].join('\n'));
  const result = parseFile(file);
  assert.equal(result.ok, true);
  assert.deepEqual(result.candles.map(c => c.date), ['2024-01-01', '2024-01-02']);
  assert.equal(result.candles[1].volume, 1000);
  assert.equal(parseFile(path.join(dir, 'missing.csv')).error, 'File not found');
  removeTempDir(dir);
});

test('importação CSV transacional persiste tickers em maiúsculas e é UPSERT', { skip: !SQLITE_AVAILABLE }, async () => {
  const dir = makeTempDir();
  const file = path.join(dir, 'bulk.csv');
  fs.writeFileSync(file, [
    'ticker,date,open,high,low,close,volume',
    'aaa,2024-01-02,10,11,9,10,100',
    'aaa,2024-01-01,9,10,8,9,100',
    'aaa,2024-01-01,90,91,89,99,200',
    'aaa,2024-01-03,,,,,bad'
  ].join('\n'));
  const db = new DB(dir);
  await db.init();
  const result = await importFromCsvFile(file, db);
  assert.equal(result.ok, true);
  assert.equal(result.inserted, 3);
  assert.equal(result.skipped, 1);
  assert.equal(db.getTickerDataRange('AAA').total_candles, 2);
  assert.equal(db.getLocalHistoricalPrices('AAA')[0].close, 99);
  db.close();
  removeTempDir(dir);
});
