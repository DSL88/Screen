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

test('parser CSV aceita cabeçalhos em Português e números com vírgula decimal', () => {
  const dir = makeTempDir();
  const file = path.join(dir, 'pt.csv');
  fs.writeFileSync(file, [
    'Data;Abertura;Máxima;Mínima;Fechamento;Volume',
    '2024-02-01;10,5;11,2;9,8;10,75;1.000',
    '2024-02-02;10,8;12,0;10,5;11,90;2000',
    'invalid;10;11;9;10;100'
  ].join('\n'));
  const result = parseFile(file);
  assert.equal(result.ok, true);
  assert.equal(result.candles.length, 2);
  assert.deepEqual(result.candles[0], {
    date: '2024-02-01',
    open: 10.5,
    high: 11.2,
    low: 9.8,
    close: 10.75,
    volume: 1000
  });
  assert.equal(result.candles[1].close, 11.9);
  removeTempDir(dir);
});

test('parser CSV suporta cabeçalho misto EN/PT e formato europeu 1.234,56', () => {
  const dir = makeTempDir();
  const file = path.join(dir, 'mixed.csv');
  fs.writeFileSync(file, [
    'Date;Open;High;Low;Fechamento;Volume',
    '2024-01-05;1.234,56;1.300,00;1.200,00;1.250,00;5.000'
  ].join('\n'));
  const result = parseFile(file);
  assert.equal(result.ok, true);
  assert.equal(result.candles.length, 1);
  assert.equal(result.candles[0].open, 1234.56);
  assert.equal(result.candles[0].high, 1300);
  assert.equal(result.candles[0].close, 1250);
  assert.equal(result.candles[0].volume, 5000);
  removeTempDir(dir);
});

test('toNumber aceita formato inglês com vírgulas de milhar 1,234.56', () => {
  const dir = makeTempDir();
  const file = path.join(dir, 'en.csv');
  fs.writeFileSync(file, [
    'Date;Open;High;Low;Close;Volume',
    '2024-01-06;1,234.56;1,300.00;1,200.00;1,250.00;5,000'
  ].join('\n'));
  const result = parseFile(file);
  assert.equal(result.ok, true);
  assert.equal(result.candles[0].open, 1234.56);
  assert.equal(result.candles[0].high, 1300);
  assert.equal(result.candles[0].volume, 5000);
  removeTempDir(dir);
});

test('parser CSV rejeita ficheiro com delimitador vírgula e vírgula decimal (evita corrupção)', () => {
  const dir = makeTempDir();
  const file = path.join(dir, 'conflict.csv');
  fs.writeFileSync(file, [
    'Date,Open,High,Low,Close,Volume',
    '2024-01-07,10,5,11,2,9,8,10,75,1.000'
  ].join('\n'));
  const result = parseFile(file);
  assert.equal(result.ok, false);
  assert.match(result.error, /Inconsistência de colunas/i);
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
