const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
let Sqlite;
let DB;
let SQLITE_AVAILABLE = false;
try {
  Sqlite = require('better-sqlite3');
  DB = require('../src/db/database');
  const probe = new Sqlite(':memory:');
  probe.close();
  SQLITE_AVAILABLE = true;
} catch (_) {
  // The native addon may be unavailable when Node/Electron ABIs differ.
}
const { makeCandle, makeTempDir, removeTempDir } = require('./helpers');

function dateAt(start, i) {
  return new Date(new Date(start + 'T00:00:00Z').getTime() + i * 86400000).toISOString().slice(0, 10);
}

test('migra schema legado, preserva metadata e é idempotente', { skip: !SQLITE_AVAILABLE }, async () => {
  const dir = makeTempDir();
  const file = path.join(dir, 'trades.db');
  const legacy = new Sqlite(file);
  legacy.exec(`
    CREATE TABLE historical_signals (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ticker TEXT NOT NULL, date TEXT NOT NULL,
      preco_entrada REAL NOT NULL, direcao TEXT, edge REAL NOT NULL, p_stay REAL NOT NULL,
      atr_14 REAL NOT NULL, status TEXT DEFAULT 'aberto', resultado_pct REAL
    );
    CREATE TABLE custom_tickers (ticker TEXT PRIMARY KEY, name TEXT, exchange TEXT, type TEXT);
    CREATE TABLE stocks (ticker TEXT PRIMARY KEY, name TEXT NOT NULL, country TEXT NOT NULL, index_name TEXT NOT NULL);
    CREATE TABLE active_trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ticker TEXT NOT NULL, nome TEXT,
      direcao TEXT, preco_entrada REAL NOT NULL, stop_loss REAL NOT NULL,
      take_profit REAL NOT NULL, data_entrada TEXT NOT NULL, status TEXT DEFAULT 'aberto',
      resultado_pct REAL, preco_fecho REAL, motivo_fecho TEXT, fechado_em TEXT
    );
    INSERT INTO stocks VALUES ('ABC.LS', 'Nome antigo', 'Portugal', 'PSI');
    INSERT INTO custom_tickers VALUES ('ABC.LS', 'Nome antigo', 'Euronext', 'EQUITY');
    INSERT INTO active_trades (ticker,nome,direcao,preco_entrada,stop_loss,take_profit,data_entrada)
      VALUES ('ABC.LS','ABC','COMPRA',100,1,2,'2020-01-01');
  `);
  legacy.close();

  const db = new DB(dir);
  await db.init();
  assert.ok(db.db.prepare("SELECT 1 FROM sqlite_master WHERE name='historical_prices'").get());
  const customColumns = db.db.prepare('PRAGMA table_info(custom_tickers)').all().map(c => c.name);
  assert.ok(customColumns.includes('country'));
  assert.ok(customColumns.includes('index_name'));
  assert.ok(db.db.prepare('PRAGMA table_info(stocks)').all().some(c => c.name === 'first_date'));
  assert.equal(db.getStockByTicker('ABC.LS').name, 'Nome antigo');
  assert.equal(db.getActiveTrades()[0].stop_loss, 97.6);
  assert.ok(Math.abs(db.getActiveTrades()[0].take_profit - 104.8) < 1e-6);

  db.upsertStock({ ticker: 'ABC.LS', name: 'Nome novo', country: 'Portugal', indexName: 'PSI' });
  db.upsertStock({ ticker: 'ABC.LS', name: 'Nome novo 2', country: 'Portugal', indexName: 'PSI' });
  assert.equal(db.db.prepare('SELECT COUNT(*) AS n FROM stocks WHERE ticker=?').get('ABC.LS').n, 1);
  assert.equal(db.getStockByTicker('ABC.LS').name, 'Nome novo 2');
  db.close();

  const second = new DB(dir);
  await second.init();
  assert.equal(second.db.prepare('SELECT COUNT(*) AS n FROM stocks').get().n, 1);
  assert.deepEqual(second.getAdaptiveParams(), {
    edge_threshold: 0.15, markov_window: 150, volume_mult: 1.2, horizon_days: 5
  });
  second.close();
  removeTempDir(dir);
});

test('UPSERT de candles substitui valores sem duplicar a chave e mantém ordem', { skip: !SQLITE_AVAILABLE }, async () => {
  const dir = makeTempDir();
  const db = new DB(dir);
  await db.init();
  db.upsertStock({ ticker: 'AAA', name: 'AAA', country: 'EUA', indexName: 'SP500', firstDate: '1990-01-01' });
  const first = [makeCandle('AAA', '2024-01-02', 10), makeCandle('AAA', '2024-01-01', 9)];
  assert.equal(db.saveHistoricalCandlesFromImport('AAA', first).changes, 2);
  assert.equal(db.saveHistoricalCandlesFromImport('AAA', [makeCandle('AAA', '2024-01-01', 99)]).changes, 1);
  assert.equal(db.db.prepare('SELECT COUNT(*) AS n FROM historical_prices WHERE ticker=?').get('AAA').n, 2);
  assert.equal(db.getLocalHistoricalPrices('AAA')[0].close, 99);
  assert.equal(db.getStockByTicker('AAA').first_date, '1990-01-01');
  db.close();
  removeTempDir(dir);
});

test('bulk custom tickers aceita aliases e é repetível', { skip: !SQLITE_AVAILABLE }, async () => {
  const dir = makeTempDir();
  const db = new DB(dir);
  await db.init();
  const items = [
    { ticker: ' abc ', nome: 'ABC', mercado: 'X', tipo: 'EQUITY' },
    { ticker: 'ABC', name: 'ABC atualizado', exchange: 'Y', type: 'ETF' },
    { ticker: '', name: 'ignorado' }
  ];
  assert.equal(db.addCustomTickersBulk(items).changes, 2);
  assert.equal(db.addCustomTickersBulk(items).changes, 2);
  assert.equal(db.getCustomTickers().length, 1);
  assert.equal(db.getCustomTickers()[0].name, 'ABC atualizado');
  db.close();
  removeTempDir(dir);
});

test('deleteIndexAndStocks remove o índice e os seus ativos em cascata, sem tocar em outros índices', { skip: !SQLITE_AVAILABLE }, async () => {
  const dir = makeTempDir();
  const db = new DB(dir);
  await db.init();

  db.upsertStock({ ticker: 'A.LS', name: 'A', country: 'Portugal', indexName: 'PSI' });
  db.upsertStock({ ticker: 'B.LS', name: 'B', country: 'Portugal', indexName: 'PSI' });
  db.upsertStock({ ticker: 'C.MC', name: 'C', country: 'Espanha', indexName: 'DAX 40' });
  db.addCustomTicker({ ticker: 'A.LS', name: 'A', country: 'Portugal', indexName: 'PSI' });
  db.addCustomTicker({ ticker: 'B.LS', name: 'B', country: 'Portugal', indexName: 'PSI' });
  db.addCustomTicker({ ticker: 'C.MC', name: 'C', country: 'Espanha', indexName: 'DAX 40' });
  db.saveHistoricalCandlesFromImport('A.LS', [makeCandle('A.LS', '2024-01-01'), makeCandle('A.LS', '2024-01-02')]);
  db.saveHistoricalCandlesFromImport('B.LS', [makeCandle('B.LS', '2024-01-01')]);
  db.saveHistoricalCandlesFromImport('C.MC', [makeCandle('C.MC', '2024-01-01')]);

  const result = db.deleteIndexAndStocks(' psi ');
  assert.equal(result.success, true);
  assert.equal(result.indexName, 'psi');
  assert.equal(result.deletedStocksCount, 2);
  assert.equal(result.deletedPricesCount, 3);
  assert.equal(result.deletedCustomCount, 2);

  assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM stocks WHERE LOWER(TRIM(index_name)) = 'psi'").get().n, 0);
  assert.equal(db.db.prepare('SELECT COUNT(*) AS n FROM historical_prices WHERE ticker IN (?, ?)').get('A.LS', 'B.LS').n, 0);
  assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM custom_tickers WHERE LOWER(TRIM(index_name)) = 'psi'").get().n, 0);

  const sp500 = db.deleteIndexAndStocks('dax40');
  assert.equal(sp500.success, true);
  assert.equal(sp500.deletedStocksCount, 1);

  const missing = db.deleteIndexAndStocks('SP500');
  assert.equal(missing.success, true);
  assert.equal(missing.deletedStocksCount, 0);

  const noName = db.deleteIndexAndStocks('  ');
  assert.equal(noName.success, false);
  assert.equal(noName.error, 'missing-index-name');

  db.close();
  removeTempDir(dir);
});

test('getHistoricalPricesForSimulation cenário A devolve 100% do histórico ASC sem LIMIT', { skip: !SQLITE_AVAILABLE }, async () => {
  const dir = makeTempDir();
  const db = new DB(dir);
  await db.init();

  const candles = [];
  for (let i = 0; i < 500; i++) {
    candles.push(makeCandle('AAA', dateAt('2000-01-01', i), 100 + i));
  }
  db.saveHistoricalCandlesFromImport('AAA', candles);

  const out = db.getHistoricalPricesForSimulation(' aaa ', null, null);
  assert.equal(out.length, 500, 'sem filtro de datas não pode truncar o histórico');
  assert.equal(out[0].date, '2000-01-01');
  assert.equal(out[out.length - 1].date, dateAt('2000-01-01', 499));
  const asc = out.every((c, i) => i === 0 || out[i - 1].date <= c.date);
  assert.equal(asc, true, 'datas em ordenação estrita ASC');
  assert.equal(out[0].close, 100);
  assert.equal(out[10].volume, 1000);
  assert.equal(typeof out[0].open, 'number');

  assert.deepEqual(db.getHistoricalPricesForSimulation('', null, null), []);
  db.close();
  removeTempDir(dir);
});

test('getHistoricalPricesForSimulation cenário B inclui warm-up de 200 velas antes da data inicial', { skip: !SQLITE_AVAILABLE }, async () => {
  const dir = makeTempDir();
  const db = new DB(dir);
  await db.init();

  // 300 velas antes do start + 100 velas no período de teste
  const candles = [];
  for (let i = 0; i < 400; i++) {
    candles.push(makeCandle('BBB', dateAt('2018-01-01', i), 50 + i));
  }
  db.saveHistoricalCandlesFromImport('BBB', candles);

  const start = dateAt('2018-01-01', 300);
  const end = dateAt('2018-01-01', 399);
  const out = db.getHistoricalPricesForSimulation('bbb', start, end);

  assert.equal(out.length, 300, '200 velas de warm-up + 100 velas do período');
  assert.equal(out[0].date, dateAt('2018-01-01', 100), 'primeira vela é o início do warm-up');
  assert.equal(out[200].date, start, 'a vela 200 corresponde exatamente à data inicial');
  assert.equal(out[out.length - 1].date, end, 'não ultrapassa a data final');
  const asc = out.every((c, i) => i === 0 || out[i - 1].date <= c.date);
  assert.equal(asc, true, 'warm-up + período concatenados em ordem ASC');

  // Sem endDate → estende até ao fim do histórico guardado
  const noEnd = db.getHistoricalPricesForSimulation('BBB', start, null);
  assert.equal(noEnd.length, 300, 'sem endDate usa todo o histórico após o start');
  assert.equal(noEnd[noEnd.length - 1].date, end);

  db.close();
  removeTempDir(dir);
});

test('getHistoricalPricesForSimulation cenário B com warm-up insuficiente devolve apenas o disponível', { skip: !SQLITE_AVAILABLE }, async () => {
  const dir = makeTempDir();
  const db = new DB(dir);
  await db.init();

  const candles = [];
  for (let i = 0; i < 50; i++) {
    candles.push(makeCandle('CCC', dateAt('2020-01-01', i), 10 + i));
  }
  db.saveHistoricalCandlesFromImport('CCC', candles);

  const start = dateAt('2020-01-01', 30);
  const out = db.getHistoricalPricesForSimulation('CCC', start, null);
  assert.equal(out.length, 50, '30 velas de warm-up disponíveis + 20 do período = 50');
  assert.equal(out[0].date, dateAt('2020-01-01', 0));
  assert.equal(out[30].date, start);
  db.close();
  removeTempDir(dir);
});
