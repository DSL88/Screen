const assert = require('node:assert/strict');
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
  // Native addon may be unavailable when Node/Electron ABIs differ.
}

const { makeCandle, makeTempDir, removeTempDir } = require('./helpers');

function makeDb() {
  const dir = makeTempDir('hist-candles-test-');
  const db = new DB(dir);
  db.init();
  return { db, dir };
}

function countRows(db, ticker) {
  return db.db.prepare('SELECT COUNT(*) AS n FROM historical_prices WHERE ticker = ?').get(ticker).n;
}

// ── saveHistoricalCandles / saveHistoricalCandlesFromImport ─────────────────

test('saveHistoricalCandles grava em lote transacional e faz UPSERT por data sem duplicar', { skip: !SQLITE_AVAILABLE }, async () => {
  const { db, dir } = makeDb();
  db.upsertStock({ ticker: 'AAA', name: 'AAA', country: 'EUA', indexName: 'SP500' });

  const batch = [
    makeCandle('AAA', '2024-01-02', 10),
    makeCandle('AAA', '2024-01-03', 11),
    makeCandle('AAA', '2024-01-01', 9) // fora de ordem: a transação não depende da ordem
  ];
  assert.equal(db.saveHistoricalCandles(batch).changes, 3);
  assert.equal(countRows(db, 'AAA'), 3);

  // Vela duplicada com valor novo: UPSERT atualiza sem criar nova linha.
  const updated = db.saveHistoricalCandles([makeCandle('AAA', '2024-01-02', 99)]);
  assert.equal(updated.changes, 1);
  assert.equal(countRows(db, 'AAA'), 3);
  assert.equal(db.getLocalHistoricalPrices('AAA').find(c => c.date === '2024-01-02').close, 99);

  // Re-gravação idêntica não conta como alteração.
  assert.equal(db.saveHistoricalCandles([makeCandle('AAA', '2024-01-02', 99)]).changes, 0);
  assert.equal(countRows(db, 'AAA'), 3);
  db.close();
  removeTempDir(dir);
});

test('saveHistoricalCandlesFromImport deduplica datas repetidas no mesmo lote e devolve changes coerente', { skip: !SQLITE_AVAILABLE }, async () => {
  const { db, dir } = makeDb();
  db.upsertStock({ ticker: 'BBB.LS', name: 'BBB', country: 'Portugal', indexName: 'PSI' });

  // Duas velas com a mesma data no mesmo lote: a segunda faz UPSERT da primeira.
  const batch = [
    makeCandle('BBB.LS', '2024-01-01', 10),
    makeCandle('BBB.LS', '2024-01-01', 42),
    makeCandle('BBB.LS', '2024-01-02', 11)
  ];
  const res = db.saveHistoricalCandlesFromImport('BBB.LS', batch);
  assert.equal(res.changes, 3);
  assert.equal(countRows(db, 'BBB.LS'), 2);
  assert.equal(db.getLocalHistoricalPrices('BBB.LS').find(c => c.date === '2024-01-01').close, 42);
  db.close();
  removeTempDir(dir);
});

test('first_date é preenchido automaticamente quando estava NULL após o save', { skip: !SQLITE_AVAILABLE }, async () => {
  const { db, dir } = makeDb();
  db.upsertStock({ ticker: 'AAA', name: 'AAA', country: 'EUA', indexName: 'SP500' });
  assert.equal(db.getStockByTicker('AAA').first_date, null);

  db.saveHistoricalCandles([
    makeCandle('AAA', '2024-06-10', 10),
    makeCandle('AAA', '2024-06-11', 11)
  ]);
  assert.equal(db.getStockByTicker('AAA').first_date, '2024-06-10');

  // Via saveHistoricalCandlesFromImport com primeiro lote descrito de 2000.
  db.upsertStock({ ticker: 'BBB.LS', name: 'BBB', country: 'Portugal', indexName: 'PSI' });
  db.saveHistoricalCandlesFromImport('BBB.LS', [
    makeCandle('BBB.LS', '2000-03-01', 5),
    makeCandle('BBB.LS', '2024-06-14', 20)
  ]);
  assert.equal(db.getStockByTicker('BBB.LS').first_date, '2000-03-01');
  db.close();
  removeTempDir(dir);
});

test('first_date existente NÃO é sobrescrito por lotes mais recentes', { skip: !SQLITE_AVAILABLE }, async () => {
  const { db, dir } = makeDb();
  db.upsertStock({ ticker: 'AAA', name: 'AAA', country: 'EUA', indexName: 'SP500', firstDate: '1990-01-01' });

  db.saveHistoricalCandles([makeCandle('AAA', '2024-06-10', 10)]);
  assert.equal(db.getStockByTicker('AAA').first_date, '1990-01-01');

  db.saveHistoricalCandlesFromImport('AAA', [makeCandle('AAA', '2024-06-11', 11)]);
  assert.equal(db.getStockByTicker('AAA').first_date, '1990-01-01');

  // O ativo da My List também fica intacto quando o upsert repete metadata.
  db.upsertStock({ ticker: 'AAA', name: 'AAA', country: 'EUA', indexName: 'SP500' });
  assert.equal(db.getStockByTicker('AAA').first_date, '1990-01-01');
  db.close();
  removeTempDir(dir);
});

test('fluxo 1º Registo completo é idempotente: correr 2x não duplica velas nem perde a marca', { skip: !SQLITE_AVAILABLE }, async () => {
  const { db, dir } = makeDb();
  db.upsertStock({ ticker: 'AAA', name: 'AAA', country: 'EUA', indexName: 'SP500' });

  const history = [
    makeCandle('AAA', '2000-01-01', 5),
    makeCandle('AAA', '2000-01-02', 6),
    makeCandle('AAA', '2024-06-14', 20)
  ];
  db.updateStockFirstDate('AAA', '2000-01-01');
  assert.equal(db.saveHistoricalCandlesFromImport('AAA', history).changes, 3);
  db.setFullHistoryFetched('AAA');

  const audit = db.auditIndexStocks('SP500');
  assert.equal(audit.stocks[0].isComplete, true);
  assert.equal(audit.pendingCount, 0);

  // Segunda passagem: mesmo histórico → sem novas velas; auditoria mantém-se completa.
  assert.equal(db.saveHistoricalCandlesFromImport('AAA', history).changes, 0);
  assert.equal(countRows(db, 'AAA'), 3);
  assert.equal(db.auditIndexStocks('SP500').pendingCount, 0);
  db.close();
  removeTempDir(dir);
});

test('saveHistoricalCandles com lista vazia não toca na base e devolve changes 0', { skip: !SQLITE_AVAILABLE }, async () => {
  const { db, dir } = makeDb();
  db.upsertStock({ ticker: 'AAA', name: 'AAA', country: 'EUA', indexName: 'SP500' });
  assert.equal(db.saveHistoricalCandles([]).changes, 0);
  assert.equal(db.saveHistoricalCandlesFromImport('AAA', []).changes, 0);
  assert.equal(countRows(db, 'AAA'), 0);
  db.close();
  removeTempDir(dir);
});

test('getStockHistorySummary agrega MIN/MAX/COUNT e sincroniza first_date divergente', { skip: !SQLITE_AVAILABLE }, async () => {
  const { db, dir } = makeDb();
  db.upsertStock({ ticker: 'CCC', name: 'CCC', country: 'EUA', indexName: 'SP500' });
  // first_date corrompido (data do download) enquanto o histórico começa em 1994.
  db.updateStockFirstDate('CCC', '2026-08-27');

  db.saveHistoricalCandles([
    makeCandle('CCC', '1994-05-02', 10),
    makeCandle('CCC', '2024-06-10', 11),
    makeCandle('CCC', '2024-06-11', 12)
  ]);

  const summary = db.getStockHistorySummary('CCC');
  assert.equal(summary.first_date, '1994-05-02');
  assert.equal(summary.last_date, '2024-06-11');
  assert.equal(summary.total_candles, 3);

  // A leitura deve ter corrigido o first_date armazenado.
  assert.equal(db.getStockByTicker('CCC').first_date, '1994-05-02');
  db.close();
  removeTempDir(dir);
});

test('migração de arranque recalcula first_date a partir do MIN(date) real', { skip: !SQLITE_AVAILABLE }, async () => {
  const { db, dir } = makeDb();
  db.upsertStock({ ticker: 'DDD', name: 'DDD', country: 'EUA', indexName: 'SP500' });
  db.saveHistoricalCandles([
    makeCandle('DDD', '1988-01-03', 10),
    makeCandle('DDD', '2024-06-10', 11)
  ]);
  // Simula dado corrompido pré-existente antes da migração.
  db.updateStockFirstDate('DDD', '2026-08-27');

  // Reinicializa a BD para disparar a migração de autocorrção.
  db.close();
  const db2 = new DB(dir);
  db2.init();
  assert.equal(db2.getStockByTicker('DDD').first_date, '1988-01-03');
  db2.close();
  removeTempDir(dir);
});
