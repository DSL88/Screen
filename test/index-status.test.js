const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
let Sqlite;
let DB;
let SQLITE_AVAILABLE = false;
try {
  Sqlite = require('better-sqlite3');
  const probe = new Sqlite(':memory:');
  probe.close();
  SQLITE_AVAILABLE = true;
} catch (_) {
  // Native addon may be unavailable when Node/Electron ABIs differ.
}

const dateUtilsPath = require.resolve('../src/utils/dateUtils');
const realDateUtils = require('../src/utils/dateUtils');

function withExpectedDay(expectedDate, fn) {
  const previous = require.cache[dateUtilsPath];
  require.cache[dateUtilsPath] = {
    id: dateUtilsPath,
    filename: dateUtilsPath,
    loaded: true,
    exports: {
      ...realDateUtils,
      getLastExpectedTradingDay: () => expectedDate
    }
  };
  delete require.cache[require.resolve('../src/db/database')];
  DB = require('../src/db/database');
  try {
    return fn();
  } finally {
    require.cache[dateUtilsPath] = previous;
    delete require.cache[require.resolve('../src/db/database')];
    DB = require('../src/db/database');
  }
}

const { makeCandle, makeTempDir, removeTempDir } = require('./helpers');

const EXPECTED = '2024-06-14';

function makeDb() {
  const dir = makeTempDir();
  const db = new DB(dir);
  db.init();
  return { db, dir };
}

test('índice COMPLETO: todos os ativos com first_date, histórico desde a origem e última data = dia esperado', { skip: !SQLITE_AVAILABLE }, async () => {
  await withExpectedDay(EXPECTED, () => {
    const { db, dir } = makeDb();
    db.upsertStock({ ticker: 'A.LS', name: 'A', country: 'Portugal', indexName: 'PSI', firstDate: '2010-01-01', fullHistoryFetched: 1 });
    db.upsertStock({ ticker: 'B.LS', name: 'B', country: 'Portugal', indexName: 'PSI', firstDate: '2012-01-01', fullHistoryFetched: 1 });
    db.saveHistoricalCandlesFromImport('A.LS', [
      makeCandle('A.LS', '2010-01-01', 10),
      makeCandle('A.LS', EXPECTED, 20)
    ]);
    db.saveHistoricalCandlesFromImport('B.LS', [
      makeCandle('B.LS', '2012-01-01', 10),
      makeCandle('B.LS', EXPECTED, 20)
    ]);

    const s = db.checkIndexStatus('PSI');
    assert.equal(s.status, 'COMPLETO');
    assert.equal(s.complete, true);
    assert.equal(s.label, 'COMPLETO');
    assert.equal(s.totalStocks, 2);
    assert.equal(s.stocksCompleteCount, 2);
    db.close();
    removeTempDir(dir);
  });
});

test('índice sem first_date → pendente-primeiro-registo', { skip: !SQLITE_AVAILABLE }, async () => {
  await withExpectedDay(EXPECTED, () => {
    const { db, dir } = makeDb();
    db.upsertStock({ ticker: 'A.LS', name: 'A', country: 'Portugal', indexName: 'PSI' });
    db.saveHistoricalCandlesFromImport('A.LS', [makeCandle('A.LS', EXPECTED, 20)]);

    const s = db.checkIndexStatus('PSI');
    assert.equal(s.status, 'pendente-primeiro-registo');
    assert.equal(s.complete, false);
    assert.equal(s.label, 'Pendente: 1º Registo');
    assert.ok(s.stocks[0].missing.includes('first-date'));
    db.close();
    removeTempDir(dir);
  });
});

test('índice com full_history_fetched mas SEM first_date → pendente-primeiro-registo (L1)', { skip: !SQLITE_AVAILABLE }, async () => {
  await withExpectedDay(EXPECTED, () => {
    const { db, dir } = makeDb();
    db.upsertStock({ ticker: 'A.LS', name: 'A', country: 'Portugal', indexName: 'PSI', fullHistoryFetched: 1 });
    db.saveHistoricalCandlesFromImport('A.LS', [
      makeCandle('A.LS', '2010-01-01', 10),
      makeCandle('A.LS', EXPECTED, 20)
    ]);

    const s = db.checkIndexStatus('PSI');
    assert.equal(s.status, 'pendente-primeiro-registo');
    assert.ok(s.stocks[0].missing.includes('first-date'));
    db.close();
    removeTempDir(dir);
  });
});

test('índice com histórico incompleto desde a origem → pendente-primeiro-registo', { skip: !SQLITE_AVAILABLE }, async () => {
  await withExpectedDay(EXPECTED, () => {
    const { db, dir } = makeDb();
    // first_date aponta para 2010 mas só existem dados desde 2020 e sem full_history_fetched.
    db.upsertStock({ ticker: 'A.LS', name: 'A', country: 'Portugal', indexName: 'PSI', firstDate: '2010-01-01' });
    db.saveHistoricalCandlesFromImport('A.LS', [
      makeCandle('A.LS', '2020-01-01', 10),
      makeCandle('A.LS', EXPECTED, 20)
    ]);

    const s = db.checkIndexStatus('PSI');
    assert.equal(s.status, 'pendente-primeiro-registo');
    assert.ok(s.stocks[0].missing.includes('first-registo'));
    db.close();
    removeTempDir(dir);
  });
});

test('índice com first_date mas última data anterior ao dia esperado → pendente-recente', { skip: !SQLITE_AVAILABLE }, async () => {
  await withExpectedDay(EXPECTED, () => {
    const { db, dir } = makeDb();
    db.upsertStock({ ticker: 'A.LS', name: 'A', country: 'Portugal', indexName: 'PSI', firstDate: '2010-01-01', fullHistoryFetched: 1 });
    db.saveHistoricalCandlesFromImport('A.LS', [
      makeCandle('A.LS', '2010-01-01', 10),
      makeCandle('A.LS', '2024-05-01', 20)
    ]);

    const s = db.checkIndexStatus('PSI');
    assert.equal(s.status, 'pendente-recente');
    assert.equal(s.label, 'Pendente: Recente');
    assert.ok(s.stocks[0].missing.includes('recent'));
    db.close();
    removeTempDir(dir);
  });
});

test('índice sem ativos → estado pendente sem stocks', { skip: !SQLITE_AVAILABLE }, async () => {
  await withExpectedDay(EXPECTED, () => {
    const { db, dir } = makeDb();
    const s = db.checkIndexStatus('PSI');
    assert.equal(s.complete, false);
    assert.equal(s.totalStocks, 0);
    assert.equal(s.status, 'pendente-primeiro-registo');
    assert.equal(s.label, 'Pendente: 1º Registo');
    db.close();
    removeTempDir(dir);
  });
});

test('índice misto: um ativo completo e outro desatualizado → pendente-recente', { skip: !SQLITE_AVAILABLE }, async () => {
  await withExpectedDay(EXPECTED, () => {
    const { db, dir } = makeDb();
    db.upsertStock({ ticker: 'A.LS', name: 'A', country: 'Portugal', indexName: 'PSI', firstDate: '2010-01-01', fullHistoryFetched: 1 });
    db.upsertStock({ ticker: 'B.LS', name: 'B', country: 'Portugal', indexName: 'PSI', firstDate: '2012-01-01', fullHistoryFetched: 1 });
    db.saveHistoricalCandlesFromImport('A.LS', [
      makeCandle('A.LS', '2010-01-01', 10),
      makeCandle('A.LS', EXPECTED, 20)
    ]);
    db.saveHistoricalCandlesFromImport('B.LS', [
      makeCandle('B.LS', '2012-01-01', 10),
      makeCandle('B.LS', '2024-05-01', 20)
    ]);

    const s = db.checkIndexStatus('PSI');
    assert.equal(s.status, 'pendente-recente');
    assert.equal(s.stocksCompleteCount, 1);
    db.close();
    removeTempDir(dir);
  });
});

test('checkIndexStatus aceita ALL e devolve estados por ativo', { skip: !SQLITE_AVAILABLE }, async () => {
  await withExpectedDay(EXPECTED, () => {
    const { db, dir } = makeDb();
    db.upsertStock({ ticker: 'A.LS', name: 'A', country: 'Portugal', indexName: 'PSI', firstDate: '2010-01-01', fullHistoryFetched: 1 });
    db.upsertStock({ ticker: 'B.MC', name: 'B', country: 'Espanha', indexName: 'IBEX 35' });
    db.saveHistoricalCandlesFromImport('A.LS', [
      makeCandle('A.LS', '2010-01-01', 10),
      makeCandle('A.LS', EXPECTED, 20)
    ]);

    const s = db.checkIndexStatus('ALL');
    assert.equal(s.totalStocks, 2);
    assert.equal(s.stocks.length, 2);
    const byTicker = {};
    for (const d of s.stocks) byTicker[d.ticker] = d;
    assert.equal(byTicker['A.LS'].cardState, 'card-synced');
    assert.equal(byTicker['B.MC'].cardState, 'card-pending');
    db.close();
    removeTempDir(dir);
  });
});
