const assert = require('node:assert/strict');
const test = require('node:test');
let DB;
let SQLITE_AVAILABLE = false;
try {
  DB = require('../src/db/database');
  SQLITE_AVAILABLE = true;
} catch (_) {
  // The native addon may be unavailable when Node/Electron ABIs differ.
}
const { makeCandle, makeTempDir, removeTempDir } = require('./helpers');

function dateAt(start, i) {
  return new Date(new Date(start + 'T00:00:00Z').getTime() + i * 86400000).toISOString().slice(0, 10);
}

test('reconcileAllStocksFirstDate repõe o MIN(date) real em vez da data recente', { skip: !SQLITE_AVAILABLE }, async () => {
  const dir = makeTempDir();
  const db = new DB(dir);
  await db.init();

  // INF.L com milhares de velas desde 1994 até hoje.
  const candles = [];
  for (let i = 0; i < 7053; i++) {
    candles.push(makeCandle('INF.L', dateAt('1994-01-03', i), 10 + i * 0.01));
  }
  db.saveHistoricalCandlesFromImport('INF.L', candles);

  // Simula o bug: first_date gravada com a data de um lote incremental recente.
  db.upsertStock({ ticker: 'INF.L', name: 'Informa', country: 'UK', indexName: 'FTSE', firstDate: '2026-08-20' });
  assert.equal(db.getStockByTicker('INF.L').first_date, '2026-08-20');

  const result = db.reconcileAllStocksFirstDate();
  assert.equal(result.success, true);
  assert.equal(db.getStockByTicker('INF.L').first_date, '1994-01-03');

  const summary = db.getStockHistorySummary('INF.L');
  assert.equal(summary.first_date, '1994-01-03');
  assert.equal(summary.last_date, dateAt('1994-01-03', 7052));
  assert.equal(summary.total_candles, 7053);

  db.close();
  removeTempDir(dir);
});

test('reconcileAllStocksFirstDate corrige também tickers legados em caixa/trim divergentes', { skip: !SQLITE_AVAILABLE }, async () => {
  const dir = makeTempDir();
  const db = new DB(dir);
  await db.init();

  db.upsertStock({ ticker: 'XYZ.L', name: 'XYZ', country: 'UK', indexName: 'FTSE', firstDate: '2026-08-20' });
  // Linha legada com ticker em minúsculas + espaços — não apanha o match exato.
  db.db.prepare(`
    INSERT INTO historical_prices (ticker, date, open, high, low, close, volume)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(' xyz.l ', '1998-03-02', 5, 6, 4, 5, 1000);

  const result = db.reconcileAllStocksFirstDate();
  assert.equal(result.success, true);
  assert.equal(db.getStockByTicker('XYZ.L').first_date, '1998-03-02');

  db.close();
  removeTempDir(dir);
});

test('saveHistoricalCandlesBatch fixa imediatamente o MIN(date) na tabela stocks', { skip: !SQLITE_AVAILABLE }, async () => {
  const dir = makeTempDir();
  const db = new DB(dir);
  await db.init();
  db.upsertStock({ ticker: 'AAA', name: 'AAA', country: 'EUA', indexName: 'SP500' });

  const candles = [makeCandle('AAA', '2001-05-05', 10), makeCandle('AAA', '2001-05-06', 11), makeCandle('AAA', '2026-08-20', 12)];
  const res = db.saveHistoricalCandlesBatch('AAA', candles);
  assert.equal(res.changes, 3);
  assert.equal(db.getStockByTicker('AAA').first_date, '2001-05-05');
  const summary = db.getStockHistorySummary('AAA');
  assert.equal(summary.last_date, '2026-08-20');
  assert.equal(summary.total_candles, 3);

  db.close();
  removeTempDir(dir);
});

test('sincronização incremental diária não sobrescreve a first_date original', { skip: !SQLITE_AVAILABLE }, async () => {
  const dir = makeTempDir();
  const db = new DB(dir);
  await db.init();

  db.upsertStock({ ticker: 'BBB', name: 'BBB', country: 'DE', indexName: 'DAX40', firstDate: '2000-01-03' });
  db.saveHistoricalCandlesFromImport('BBB', [makeCandle('BBB', '2000-01-03', 30), makeCandle('BBB', '2000-01-04', 31)]);

  // Lote incremental com apenas velas recentes (típico da sincronização diária).
  db.saveIncrementalCandles([
    makeCandle('BBB', '2026-08-20', 32),
    makeCandle('BBB', '2026-08-21', 33)
  ]);

  assert.equal(db.getStockByTicker('BBB').first_date, '2000-01-03', 'first_date nunca regride para a data do lote recente');
  const summary = db.getStockHistorySummary('BBB');
  assert.equal(summary.last_date, '2026-08-21');
  assert.equal(summary.total_candles, 4);

  db.close();
  removeTempDir(dir);
});