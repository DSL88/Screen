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

let XLSX;
try {
  XLSX = require('xlsx');
} catch (_) {}

const { parseFile, importFromCsvFile } = require('../src/importer/historicalImporter');
const { makeCandle, makeTempDir, removeTempDir } = require('./helpers');

const MB = 1024 * 1024;

function countRows(db, ticker) {
  const range = db.getTickerDataRange(ticker);
  return range ? range.total_candles : 0;
}

function writeXlsx(file, rows, sheetName = 'Sheet1') {
  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  XLSX.writeFile(wb, file);
}

test('parseFile rejeita ficheiro acima do limite de 50 MB com erro claro', () => {
  const dir = makeTempDir();
  const file = path.join(dir, 'grande.csv');
  fs.writeFileSync(file, 'Date,Open,High,Low,Close,Volume\n');
  fs.truncateSync(file, 50 * MB + 1);

  const result = parseFile(file);
  assert.equal(result.ok, false);
  assert.match(result.error, /too large/i);
  assert.match(result.error, /50 MB/);
  removeTempDir(dir);
});

test('importFromCsvFile rejeita acima do limite sem tocar na base de dados', async () => {
  const dir = makeTempDir();
  const file = path.join(dir, 'grande.csv');
  fs.writeFileSync(file, 'ticker,date,open,high,low,close,volume\n');
  fs.truncateSync(file, 50 * MB + 1);

  let called = false;
  const result = await importFromCsvFile(file, {
    saveBulkHistoricalCandles() { called = true; }
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /too large/i);
  assert.equal(called, false);
  removeTempDir(dir);
});

test('parseFile exige ficheiro regular e extensão .csv/.xlsx', () => {
  const dir = makeTempDir();
  const asDir = path.join(dir, 'pasta.csv');
  fs.mkdirSync(asDir);
  const notFile = parseFile(asDir);
  assert.equal(notFile.ok, false);
  assert.match(notFile.error, /regular file/i);

  const txt = path.join(dir, 'dados.txt');
  fs.writeFileSync(txt, 'Date,Open,High,Low,Close,Volume\n2024-01-02,10,11,9,10,100\n');
  const unsupported = parseFile(txt);
  assert.equal(unsupported.ok, false);
  assert.match(unsupported.error, /Unsupported file format/i);

  assert.equal(parseFile(path.join(dir, 'missing.csv')).error, 'File not found');
  assert.equal(parseFile(null).ok, false);
  removeTempDir(dir);
});

test('parseFile não polui protótipos com cabeçalhos __proto__/constructor (CSV)', () => {
  const dir = makeTempDir();
  const file = path.join(dir, 'evil.csv');
  fs.writeFileSync(file, [
    '__proto__,constructor,prototype,Date,Open,High,Low,Close,Volume',
    'pollutedCheck,x,y,2024-01-02,10,11,9,10.5,100'
  ].join('\n'));

  const result = parseFile(file);
  assert.equal(result.ok, true);
  assert.equal(result.candles.length, 1);
  assert.equal(result.candles[0].date, '2024-01-02');
  assert.equal({}.pollutedCheck, undefined);
  assert.equal(Object.prototype.pollutedCheck, undefined);
  assert.equal(Object.getPrototypeOf({}), Object.prototype);
  removeTempDir(dir);
});

test('parseFile XLSX não polui protótipos com cabeçalhos maliciosos', { skip: !XLSX }, () => {
  const dir = makeTempDir();
  const file = path.join(dir, 'evil.xlsx');
  writeXlsx(file, [
    ['__proto__', 'constructor', 'Date', 'Open', 'High', 'Low', 'Close', 'Volume'],
    ['pollutedCheck', 'x', '2024-01-02', 10, 11, 9, 10.5, 100]
  ]);

  const result = parseFile(file);
  assert.equal(result.ok, true);
  assert.equal(result.candles.length, 1);
  assert.deepEqual(result.candles[0], {
    date: '2024-01-02', open: 10, high: 11, low: 9, close: 10.5, volume: 100
  });
  assert.equal({}.pollutedCheck, undefined);
  assert.equal(Object.prototype.pollutedCheck, undefined);
  removeTempDir(dir);
});

test('parseFile descarta datas calendaristicamente inválidas', () => {
  const dir = makeTempDir();
  const file = path.join(dir, 'datas.csv');
  fs.writeFileSync(file, [
    'Date,Open,High,Low,Close,Volume',
    '2024-02-31,10,11,9,10,100',
    '2023-02-29,10,11,9,10,100',
    '2024-01-02,10,11,9,10,100'
  ].join('\n'));

  const result = parseFile(file);
  assert.equal(result.ok, true);
  assert.deepEqual(result.candles.map(c => c.date), ['2024-01-02']);
  removeTempDir(dir);
});

test('parseFile XLSX ignora serial Excel extremo sem lançar RangeError', { skip: !XLSX }, () => {
  const dir = makeTempDir();
  const file = path.join(dir, 'serials.xlsx');
  // 45292 = 2024-01-01; 1e15 e -5 são seriais inválidos.
  writeXlsx(file, [
    ['Date', 'Open', 'High', 'Low', 'Close', 'Volume'],
    [1e15, 10, 11, 9, 10, 100],
    [-5, 10, 11, 9, 10, 100],
    [45292, 10, 11, 9, 10, 100]
  ]);

  const result = parseFile(file);
  assert.equal(result.ok, true);
  assert.deepEqual(result.candles.map(c => c.date), ['2024-01-01']);
  removeTempDir(dir);
});

test('parseFile XLSX lê denso com opções restritas (smoke test)', { skip: !XLSX }, () => {
  const dir = makeTempDir();
  const file = path.join(dir, 'ok.xlsx');
  writeXlsx(file, [
    ['Date', 'Open', 'High', 'Low', 'Close', 'Volume'],
    ['2024-01-03', 10, 11, 9, 10, 100],
    ['2024-01-02', 9, 10, 8, 9, 50]
  ]);

  const result = parseFile(file);
  assert.equal(result.ok, true);
  assert.deepEqual(result.candles.map(c => c.date), ['2024-01-02', '2024-01-03']);
  removeTempDir(dir);
});

test('importFromCsvFile ignora tickers fora do charset esperado', { skip: !SQLITE_AVAILABLE }, async () => {
  const dir = makeTempDir();
  const file = path.join(dir, 'tickers.csv');
  fs.writeFileSync(file, [
    'ticker,date,open,high,low,close,volume',
    '=cmd|calc,2024-01-02,10,11,9,10,100',
    'aaa;DROP,2024-01-03,10,11,9,10,100',
    'AAA,2024-01-04,10,11,9,10,100'
  ].join('\n'));

  const db = new DB(dir);
  await db.init();
  const result = await importFromCsvFile(file, db);
  assert.equal(result.ok, true);
  assert.equal(result.inserted, 1);
  assert.equal(result.skipped, 2);
  assert.equal(countRows(db, 'AAA'), 1);
  assert.equal(countRows(db, '=CMD|CALC'), 0);
  db.close();
  removeTempDir(dir);
});

test('import CSV falhado não reverte escritas de terceiros e não deixa transação aberta', { skip: !SQLITE_AVAILABLE }, async () => {
  const dir = makeTempDir();
  const db = new DB(dir);
  await db.init();
  db.saveBulkHistoricalCandles([makeCandle('EXT', '2024-01-01', 50)]);

  const lines = ['ticker,date,open,high,low,close,volume'];
  for (let i = 0; i < 200000; i++) {
    const month = String((i % 12) + 1).padStart(2, '0');
    const day = String((i % 28) + 1).padStart(2, '0');
    lines.push(`BIG,2024-${month}-${day},10,11,9,10,100`);
  }
  lines.push('BIG,2024-03-01,10,11,9,10,100,extra');
  const file = path.join(dir, 'lote.csv');
  fs.writeFileSync(file, lines.join('\n'));

  let settled = false;
  let observedNoOpenTransaction = false;
  const importPromise = importFromCsvFile(file, db).then(r => {
    settled = true;
    return r;
  });

  for (let i = 0; i < 20 && !settled; i++) {
    await new Promise(resolve => setImmediate(resolve));
    if (settled) break;
    assert.equal(db.db.inTransaction, false, 'importer não deve manter transação aberta durante o parsing');
    observedNoOpenTransaction = true;
    if (i === 0) {
      // Escrita de "outro handler" a meio do parsing do import.
      db.saveBulkHistoricalCandles([makeCandle('EXT2', '2024-02-01', 77)]);
    }
  }

  const result = await importPromise;
  assert.ok(observedNoOpenTransaction, 'o import deve continuar pendente durante a observação');
  assert.equal(result.ok, false);
  assert.match(result.error, /Inconsistência de colunas/i);
  assert.equal(db.db.inTransaction, false, 'sem transação pendente após o erro');
  assert.equal(countRows(db, 'EXT'), 1, 'escrita anterior ao import sobrevive');
  assert.equal(countRows(db, 'EXT2'), 1, 'escrita concorrente durante o parsing sobrevive');
  assert.equal(countRows(db, 'BIG'), 0, 'import falhado não deixa escritas parciais');
  db.close();
  removeTempDir(dir);
});
