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

const REDUNDANT_INDEXES = [
  'idx_hist_prices_ticker_date',
  'idx_hist_ticker_date',
  'idx_historical_prices_ticker_date_asc',
  'idx_hist_ticker_date_desc'
];

function instrumentPrepare(db) {
  const captured = [];
  const original = db.db.prepare.bind(db.db);
  db.db.prepare = (sql, ...rest) => {
    captured.push(String(sql));
    return original(sql, ...rest);
  };
  return {
    captured,
    restore() { delete db.db.prepare; }
  };
}

test('H1: novos init e bases legadas ficam sem índices redundantes em historical_prices', { skip: !SQLITE_AVAILABLE }, async (t) => {
  const freshDir = makeTempDir('db-perfsec-fresh-');
  const fresh = new DB(freshDir);
  await fresh.init();
  t.after(() => {
    fresh.close();
    removeTempDir(freshDir);
  });

  const freshIndexes = fresh.db.prepare("SELECT name FROM pragma_index_list('historical_prices')").all().map(r => r.name);
  for (const name of REDUNDANT_INDEXES) {
    assert.ok(!freshIndexes.includes(name), `${name} não deve ser criado em BD nova`);
  }
  assert.ok(freshIndexes.includes('sqlite_autoindex_historical_prices_1'), 'a PK (ticker,date) deve permanecer');

  const freshPlan = fresh.db.prepare(
    'EXPLAIN QUERY PLAN SELECT MIN(date), MAX(date), COUNT(*) FROM historical_prices WHERE ticker = ?'
  ).all('AAA').map(r => r.detail);
  assert.ok(freshPlan.some(d => /SEARCH historical_prices USING .*INDEX sqlite_autoindex_historical_prices_1/.test(d)), freshPlan.join(' | '));
  assert.ok(!freshPlan.some(d => /SCAN historical_prices/.test(d)), 'agregação por ticker não pode fazer full scan');
  assert.ok(fresh.db.pragma('user_version', { simple: true }) >= 2);

  const legacyDir = makeTempDir('db-perfsec-legacy-');
  const filename = path.join(legacyDir, 'trades.db');
  const legacy = new Sqlite(filename);
  legacy.exec(`
    CREATE TABLE historical_prices (
      ticker TEXT NOT NULL, date TEXT NOT NULL,
      open REAL NOT NULL, high REAL NOT NULL, low REAL NOT NULL, close REAL NOT NULL,
      volume INTEGER NOT NULL, PRIMARY KEY (ticker, date)
    );
    CREATE INDEX idx_hist_prices_ticker_date ON historical_prices (ticker, date);
    CREATE INDEX idx_hist_ticker_date ON historical_prices (ticker, date);
    CREATE INDEX idx_historical_prices_ticker_date_asc ON historical_prices (ticker, date ASC);
    CREATE INDEX idx_hist_ticker_date_desc ON historical_prices (ticker, date DESC);
    CREATE TABLE stocks (ticker TEXT PRIMARY KEY, name TEXT NOT NULL, country TEXT NOT NULL, index_name TEXT NOT NULL);
  `);
  legacy.close();

  const migrated = new DB(legacyDir);
  await migrated.init();
  t.after(() => {
    migrated.close();
    removeTempDir(legacyDir);
  });

  const migratedIndexes = migrated.db.prepare("SELECT name FROM pragma_index_list('historical_prices')").all().map(r => r.name);
  for (const name of REDUNDANT_INDEXES) {
    assert.ok(!migratedIndexes.includes(name), `${name} deve ser removido pela migração`);
  }
  const migratedPlan = migrated.db.prepare(
    "EXPLAIN QUERY PLAN SELECT date, open, high, low, close, volume FROM historical_prices WHERE ticker = ? ORDER BY date DESC LIMIT 1"
  ).all('AAA').map(r => r.detail);
  assert.ok(migratedPlan.some(d => /SEARCH historical_prices USING .*INDEX sqlite_autoindex_historical_prices_1/.test(d)), migratedPlan.join(' | '));
  assert.ok(!migratedPlan.some(d => /SCAN historical_prices/.test(d)));

  migrated.close();
  const reopened = new DB(legacyDir);
  await reopened.init();
  t.after(() => reopened.close());
  const reopenedIndexes = reopened.db.prepare("SELECT name FROM pragma_index_list('historical_prices')").all().map(r => r.name);
  for (const name of REDUNDANT_INDEXES) {
    assert.ok(!reopenedIndexes.includes(name), `migração de ${name} deve ser idempotente`);
  }
});

test('H2: getStockDetailWithLatestPrice usa ticker = ? e mantém fallback legado', { skip: !SQLITE_AVAILABLE }, async (t) => {
  const dir = makeTempDir('db-perfsec-detail-');
  const db = new DB(dir);
  await db.init();
  t.after(() => {
    db.close();
    removeTempDir(dir);
  });

  db.upsertStock({ ticker: 'AAA', name: 'Ativo AAA', country: 'Portugal', indexName: 'PSI' });
  db.saveHistoricalCandlesFromImport('AAA', [
    makeCandle('AAA', '2024-01-02', 10),
    makeCandle('AAA', '2024-06-03', 15)
  ]);

  const spy = instrumentPrepare(db);
  const detail = db.getStockDetailWithLatestPrice(' aaa ');
  spy.restore();

  assert.equal(detail.total_candles, 2);
  assert.equal(detail.first_date, '2024-01-02');
  assert.equal(detail.last_date, '2024-06-03');
  assert.equal(detail.latestPrice.close, 15);
  assert.ok(spy.captured.some(sql => /FROM historical_prices\s+WHERE ticker = \?/.test(sql)), 'deve consultar por igualdade canónica');
  assert.ok(!spy.captured.some(sql => /UPPER\(TRIM\(ticker\)\) = \?/.test(sql)), 'caminho canónico não pode manter o full scan UPPER(TRIM)');

  const legacyDir = makeTempDir('db-perfsec-detail-legacy-');
  const legacyDb = new DB(legacyDir);
  await legacyDb.init();
  t.after(() => {
    legacyDb.close();
    removeTempDir(legacyDir);
  });

  legacyDb.db.prepare(`
    INSERT INTO historical_prices (ticker, date, open, high, low, close, volume)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(' aaa ', '2020-02-03', 5, 6, 4, 5.5, 1000);

  const legacyDetail = legacyDb.getStockDetailWithLatestPrice('AAA');
  assert.equal(legacyDetail.total_candles, 1);
  assert.equal(legacyDetail.latestPrice.close, 5.5);
  assert.equal(legacyDetail.last_date, '2020-02-03');
});

test('H3: reconcile é sargável, idempotente e corrige resíduos legados', { skip: !SQLITE_AVAILABLE }, async (t) => {
  const dir = makeTempDir('db-perfsec-reconcile-');
  const db = new DB(dir);
  await db.init();
  t.after(() => {
    db.close();
    removeTempDir(dir);
  });

  db.upsertStock({ ticker: 'INF.L', name: 'Informa', country: 'UK', indexName: 'FTSE40' });
  db.saveHistoricalCandlesFromImport('INF.L', [
    makeCandle('INF.L', '1994-01-03', 10),
    makeCandle('INF.L', '2026-08-20', 30)
  ]);
  db.upsertStock({ ticker: 'INF.L', firstDate: '2026-08-20' });
  assert.equal(db.getStockByTicker('INF.L').first_date, '2026-08-20');

  const spy = instrumentPrepare(db);
  const result = db.reconcileAllStocksFirstDate();
  spy.restore();

  assert.equal(result.success, true);
  assert.equal(result.updatedCount, 1);
  assert.equal(db.getStockByTicker('INF.L').first_date, '1994-01-03');

  const fastUpdate = spy.captured.find(sql => /UPDATE stocks/.test(sql) && /MIN\(hp\.date\)/.test(sql));
  assert.ok(fastUpdate, 'deve existir o UPDATE sargável');
  assert.ok(!/UPPER\(TRIM\(hp\.ticker\)\) = UPPER\(TRIM\(stocks\.ticker\)\)/.test(fastUpdate), 'sem subquery correlacionada não-sargável');
  const plan = db.db.prepare('EXPLAIN QUERY PLAN ' + fastUpdate).all().map(r => r.detail);
  const hpPlan = plan.filter(d => /historical_prices/.test(d));
  assert.ok(hpPlan.length > 0 && hpPlan.every(d => /SEARCH hp USING/.test(d)), plan.join(' | '));
  assert.ok(!plan.some(d => /SCAN hp/.test(d)), 'step 1 não pode varrer historical_prices');

  const totalBefore = db.db.prepare('SELECT total_changes() AS n').get().n;
  const second = db.reconcileAllStocksFirstDate();
  const totalAfter = db.db.prepare('SELECT total_changes() AS n').get().n;
  assert.equal(second.updatedCount, 0);
  assert.equal(totalAfter, totalBefore, 'segunda reconciliação sem alterações não deve escrever');

  const legacyDir = makeTempDir('db-perfsec-reconcile-legacy-');
  const legacyDb = new DB(legacyDir);
  await legacyDb.init();
  t.after(() => {
    legacyDb.close();
    removeTempDir(legacyDir);
  });

  legacyDb.upsertStock({ ticker: 'XYZ.L', name: 'XYZ', country: 'UK', indexName: 'FTSE40', firstDate: '2026-08-20' });
  legacyDb.db.prepare(`
    INSERT INTO historical_prices (ticker, date, open, high, low, close, volume)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(' xyz.l ', '1998-03-02', 5, 6, 4, 5, 1000);

  const legacyResult = legacyDb.reconcileAllStocksFirstDate();
  assert.equal(legacyResult.success, true);
  assert.equal(legacyResult.updatedCount, 1);
  assert.equal(legacyDb.getStockByTicker('XYZ.L').first_date, '1998-03-02');
});

test('H4: checkListFreshness agrega por lote (sem N+1) e calcula outdatedTickers', { skip: !SQLITE_AVAILABLE }, async (t) => {
  const dir = makeTempDir('db-perfsec-freshness-');
  const db = new DB(dir);
  await db.init();
  t.after(() => {
    db.close();
    removeTempDir(dir);
  });

  const expectedDate = db.getLastExpectedTradingDay();
  for (const ticker of ['AAA', 'BBB', 'CCC', 'DDD']) {
    db.addCustomTicker({ ticker, name: ticker, indexName: 'PSI' });
  }
  db.saveHistoricalCandlesFromImport('AAA', [makeCandle('AAA', expectedDate, 10)]);
  db.saveHistoricalCandlesFromImport('BBB', [makeCandle('BBB', expectedDate, 20)]);
  db.saveHistoricalCandlesFromImport('DDD', [makeCandle('DDD', '2000-01-03', 30)]);

  const spy = instrumentPrepare(db);
  const freshness = db.checkListFreshness();
  spy.restore();

  assert.equal(freshness.expectedDate, expectedDate);
  assert.equal(freshness.isUpdated, true);
  assert.equal(freshness.maxStoredDate, expectedDate);
  assert.deepEqual(freshness.outdatedTickers, ['CCC', 'DDD']);

  const historyQueries = spy.captured.filter(sql => /FROM historical_prices/.test(sql));
  const groupedQueries = historyQueries.filter(sql => /GROUP BY ticker/.test(sql));
  assert.equal(groupedQueries.length, 1, 'deve existir uma única agregação por chunk');
  assert.ok(groupedQueries[0].includes('IN ('), 'agregação deve usar ticker IN (...)');
  assert.ok(!spy.captured.some(sql => /SELECT MAX\(date\) as last_date FROM historical_prices WHERE ticker = \?/.test(sql)), 'sem query N+1 por ticker');
});

test('H4: checkListFreshness faz chunking acima de 900 tickers', { skip: !SQLITE_AVAILABLE }, async (t) => {
  const dir = makeTempDir('db-perfsec-freshness-chunk-');
  const db = new DB(dir);
  await db.init();
  t.after(() => {
    db.close();
    removeTempDir(dir);
  });

  const expectedDate = db.getLastExpectedTradingDay();
  const tickers = [];
  for (let i = 0; i < 905; i++) {
    tickers.push(`T${String(i).padStart(4, '0')}`);
  }
  db.addCustomTickersBulk(tickers.map(ticker => ({ ticker, name: ticker, indexName: 'PSI' })));

  const spy = instrumentPrepare(db);
  const freshness = db.checkListFreshness();
  spy.restore();

  const groupedQueries = spy.captured.filter(sql => /FROM historical_prices/.test(sql) && /GROUP BY ticker/.test(sql));
  assert.equal(groupedQueries.length, 2, '905 tickers devem ser agregados em 2 chunks');
  assert.ok(freshness.outdatedTickers.length >= 900);
});
