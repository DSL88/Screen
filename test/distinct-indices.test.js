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
  // The native addon may be unavailable when Node/Electron ABIs differ.
}

const { makeTempDir, removeTempDir } = require('./helpers');

function makeDb() {
  const dir = makeTempDir('distinct-indices-test-');
  const db = new DB(dir);
  db.init();
  return { db, dir };
}

test('getAllDistinctIndices devolve [] quando a BD não tem stocks', { skip: !SQLITE_AVAILABLE }, () => {
  const { db, dir } = makeDb();
  assert.deepEqual(db.getAllDistinctIndices(), []);
  db.close();
  removeTempDir(dir);
});

test('índices distintos de vários stocks: ordenados ASC e sem duplicados', { skip: !SQLITE_AVAILABLE }, () => {
  const { db, dir } = makeDb();
  db.upsertStock({ ticker: 'A.LS', name: 'A', country: 'Portugal', indexName: 'PSI' });
  db.upsertStock({ ticker: 'B.LS', name: 'B', country: 'Portugal', indexName: 'PSI' }); // duplicado
  db.upsertStock({ ticker: 'C.MC', name: 'C', country: 'Espanha', indexName: 'IBEX 35' });
  db.upsertStock({ ticker: 'D.US', name: 'D', country: 'EUA', indexName: 'S&P 500' });

  assert.deepEqual(db.getAllDistinctIndices(), ['IBEX35', 'PSI', 'SP500']);
  db.close();
  removeTempDir(dir);
});

test('labels amigáveis são normalizados para o id canónico antes do DISTINCT', { skip: !SQLITE_AVAILABLE }, () => {
  const { db, dir } = makeDb();
  // O mesmo índice escrito por labels diferentes não duplica no resultado.
  db.upsertStock({ ticker: 'A.US', name: 'A', country: 'EUA', indexName: 'S&P 500' });
  db.upsertStock({ ticker: 'B.US', name: 'B', country: 'EUA', indexName: 'S&P 500' });
  db.upsertStock({ ticker: 'C.MC', name: 'C', country: 'Espanha', indexName: 'IBEX 35' });

  assert.deepEqual(db.getAllDistinctIndices(), ['IBEX35', 'SP500']);
  db.close();
  removeTempDir(dir);
});

test('filtra index_name vazio/whitespace-only (default do schema)', { skip: !SQLITE_AVAILABLE }, () => {
  const { db, dir } = makeDb();
  db.upsertStock({ ticker: 'A.LS', name: 'A', country: 'Portugal', indexName: 'PSI' });
  // index_name é NOT NULL DEFAULT '' no schema; whitespace-only também não conta.
  db.upsertStock({ ticker: 'B.LS', name: 'B', country: 'Portugal', indexName: '   ' });
  db.upsertStock({ ticker: 'C.LS', name: 'C', country: 'Portugal', indexName: '' });

  assert.deepEqual(db.getAllDistinctIndices(), ['PSI']);
  db.close();
  removeTempDir(dir);
});

test('índice personalizado gravado via updateStockMetadata aparece nos distintos', { skip: !SQLITE_AVAILABLE }, () => {
  const { db, dir } = makeDb();
  db.upsertStock({ ticker: 'A.LS', name: 'A', country: 'Portugal', indexName: 'PSI' });

  const res = db.updateStockMetadata('A.LS', { index_name: 'Meu Índice' });
  assert.equal(res.success, true);
  assert.equal(res.changes, 1);
  assert.deepEqual(db.getAllDistinctIndices(), ['Meu Índice']);
  db.close();
  removeTempDir(dir);
});

test('getAllDistinctIndices lê apenas stocks: custom_tickers sem stock correspondente não entra', { skip: !SQLITE_AVAILABLE }, () => {
  const { db, dir } = makeDb();
  // Só na watchlist (custom_tickers), sem entrada em stocks → não conta.
  db.addCustomTicker({ ticker: 'ZZZ.LS', name: 'ZZZ', country: 'Portugal', indexName: 'PSI' });
  assert.deepEqual(db.getAllDistinctIndices(), []);

  // Depois do upsert em stocks, o índice já aparece.
  db.upsertStock({ ticker: 'ZZZ.LS', name: 'ZZZ', country: 'Portugal', indexName: 'PSI' });
  assert.deepEqual(db.getAllDistinctIndices(), ['PSI']);
  db.close();
  removeTempDir(dir);
});