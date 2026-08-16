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
  const dir = makeTempDir('audit-index-test-');
  const db = new DB(dir);
  db.init();
  return { db, dir };
}

// ── Auditoria de 1º Registo por índice (auditIndexStocks) ──────────────────

test('índice sem ativos devolve contagens zeradas e sem stocks', { skip: !SQLITE_AVAILABLE }, async () => {
  const { db, dir } = makeDb();
  const audit = db.auditIndexStocks('PSI');
  assert.equal(audit.indexName, 'PSI');
  assert.equal(audit.totalStocks, 0);
  assert.equal(audit.completeCount, 0);
  assert.equal(audit.pendingCount, 0);
  assert.deepEqual(audit.stocks, []);
  db.close();
  removeTempDir(dir);
});

test('ativo com first_date + full_history_fetched e histórico desde a origem → isComplete', { skip: !SQLITE_AVAILABLE }, async () => {
  const { db, dir } = makeDb();
  db.upsertStock({ ticker: 'A.LS', name: 'A', country: 'Portugal', indexName: 'PSI', firstDate: '2000-01-01', fullHistoryFetched: 1 });
  db.saveHistoricalCandlesFromImport('A.LS', [
    makeCandle('A.LS', '2000-01-01', 10),
    makeCandle('A.LS', '2024-06-14', 20)
  ]);

  const audit = db.auditIndexStocks('PSI');
  assert.equal(audit.totalStocks, 1);
  assert.equal(audit.completeCount, 1);
  assert.equal(audit.pendingCount, 0);

  const s = audit.stocks[0];
  assert.equal(s.isComplete, true);
  assert.equal(s.needsFirstDate, false);
  assert.equal(s.needsHistoricalDownload, false);
  assert.equal(s.historyFromOrigin, true);
  assert.equal(s.firstDate, '2000-01-01');
  assert.equal(s.minStoredDate, '2000-01-01');
  assert.equal(s.totalStoredCandles, 2);
  db.close();
  removeTempDir(dir);
});

test('ativo com histórico desde a origem (MIN(date) <= first_date) sem full_history_fetched → isComplete', { skip: !SQLITE_AVAILABLE }, async () => {
  const { db, dir } = makeDb();
  // fullHistoryFetched não é fornecido: a origem é deduzida do MIN(date).
  db.upsertStock({ ticker: 'B.LS', name: 'B', country: 'Portugal', indexName: 'PSI', firstDate: '2010-01-01' });
  db.saveHistoricalCandlesFromImport('B.LS', [
    makeCandle('B.LS', '2010-01-01', 10),
    makeCandle('B.LS', '2024-06-14', 20)
  ]);

  const audit = db.auditIndexStocks('PSI');
  const s = audit.stocks[0];
  assert.equal(s.isComplete, true);
  assert.equal(s.needsHistoricalDownload, false);
  assert.equal(s.historyFromOrigin, true);
  assert.equal(audit.completeCount, 1);
  db.close();
  removeTempDir(dir);
});

test('ativo sem first_date → needsFirstDate e nunca completo, mesmo com histórico armazenado', { skip: !SQLITE_AVAILABLE }, async () => {
  const { db, dir } = makeDb();
  db.upsertStock({ ticker: 'C.LS', name: 'C', country: 'Portugal', indexName: 'PSI' });
  // saveHistoricalCandlesFromImport preenche first_date automaticamente;
  // limpamos depois para reconstruir o cenário "sem first_date".
  db.saveHistoricalCandlesFromImport('C.LS', [
    makeCandle('C.LS', '2024-01-01', 10),
    makeCandle('C.LS', '2024-06-14', 20)
  ]);
  db.updateStockFirstDate('C.LS', null);

  const audit = db.auditIndexStocks('PSI');
  const s = audit.stocks[0];
  assert.equal(s.firstDate, null);
  assert.equal(s.needsFirstDate, true);
  assert.equal(s.historyFromOrigin, false);
  assert.equal(s.isComplete, false);
  assert.equal(s.needsHistoricalDownload, false); // há dados; falta só a origem
  assert.equal(audit.completeCount, 0);
  assert.equal(audit.pendingCount, 1);
  db.close();
  removeTempDir(dir);
});

test('ativo com first_date mas SEM histórico → needsHistoricalDownload e incompleto', { skip: !SQLITE_AVAILABLE }, async () => {
  const { db, dir } = makeDb();
  db.upsertStock({ ticker: 'D.LS', name: 'D', country: 'Portugal', indexName: 'PSI', firstDate: '2000-01-01' });

  const audit = db.auditIndexStocks('PSI');
  const s = audit.stocks[0];
  assert.equal(s.firstDate, '2000-01-01');
  assert.equal(s.minStoredDate, null);
  assert.equal(s.totalStoredCandles, 0);
  assert.equal(s.needsFirstDate, false);
  assert.equal(s.needsHistoricalDownload, true);
  assert.equal(s.historyFromOrigin, false);
  assert.equal(s.isComplete, false);
  db.close();
  removeTempDir(dir);
});

test('ativo com histórico apenas recente (MIN(date) > first_date + 1 ano) → descarga antiga em falta', { skip: !SQLITE_AVAILABLE }, async () => {
  const { db, dir } = makeDb();
  // first_date remonta a 2000 mas o bloco armazenado só começa em 2024.
  db.upsertStock({ ticker: 'E.LS', name: 'E', country: 'Portugal', indexName: 'PSI', firstDate: '2000-01-01' });
  db.saveHistoricalCandlesFromImport('E.LS', [
    makeCandle('E.LS', '2024-01-01', 10),
    makeCandle('E.LS', '2024-06-14', 20)
  ]);

  const audit = db.auditIndexStocks('PSI');
  const s = audit.stocks[0];
  assert.equal(s.needsHistoricalDownload, true);
  assert.equal(s.historyFromOrigin, false);
  assert.equal(s.isComplete, false);
  assert.ok(s.minStoredDate > '2001-01-01'); // > first_date + 1 ano
  db.close();
  removeTempDir(dir);
});

test('auditoria mista soma completos e pendentes por ativo', { skip: !SQLITE_AVAILABLE }, async () => {
  const { db, dir } = makeDb();
  db.upsertStock({ ticker: 'A.LS', name: 'A', country: 'Portugal', indexName: 'PSI', firstDate: '2000-01-01', fullHistoryFetched: 1 });
  db.saveHistoricalCandlesFromImport('A.LS', [
    makeCandle('A.LS', '2000-01-01', 10),
    makeCandle('A.LS', '2024-06-14', 20)
  ]);
  db.upsertStock({ ticker: 'B.LS', name: 'B', country: 'Portugal', indexName: 'PSI', firstDate: '2000-01-01' });
  db.upsertStock({ ticker: 'C.LS', name: 'C', country: 'Portugal', indexName: 'PSI' });

  const audit = db.auditIndexStocks('PSI');
  assert.equal(audit.totalStocks, 3);
  assert.equal(audit.completeCount, 1);
  assert.equal(audit.pendingCount, 2);
  const byTicker = Object.fromEntries(audit.stocks.map(s => [s.ticker, s]));
  assert.equal(byTicker['A.LS'].isComplete, true);
  assert.equal(byTicker['B.LS'].needsHistoricalDownload, true);
  assert.equal(byTicker['C.LS'].needsFirstDate, true);
  db.close();
  removeTempDir(dir);
});

test('auditoria ALL cobre os ativos de todos os índices', { skip: !SQLITE_AVAILABLE }, async () => {
  const { db, dir } = makeDb();
  db.upsertStock({ ticker: 'A.LS', name: 'A', country: 'Portugal', indexName: 'PSI', firstDate: '2000-01-01', fullHistoryFetched: 1 });
  db.saveHistoricalCandlesFromImport('A.LS', [
    makeCandle('A.LS', '2000-01-01', 10),
    makeCandle('A.LS', '2024-06-14', 20)
  ]);
  db.upsertStock({ ticker: 'F.MC', name: 'F', country: 'Espanha', indexName: 'IBEX 35', firstDate: '2010-01-01', fullHistoryFetched: 1 });
  db.saveHistoricalCandlesFromImport('F.MC', [
    makeCandle('F.MC', '2010-01-01', 10),
    makeCandle('F.MC', '2024-06-14', 20)
  ]);
  db.upsertStock({ ticker: 'G.DE', name: 'G', country: 'Alemanha', indexName: 'DAX 40' });

  const audit = db.auditIndexStocks('ALL');
  assert.equal(audit.indexName, 'ALL');
  assert.equal(audit.totalStocks, 3);
  assert.equal(audit.completeCount, 2);
  assert.equal(audit.pendingCount, 1);
  db.close();
  removeTempDir(dir);
});

test('auditoria normaliza o nome do índice para o id canónico', { skip: !SQLITE_AVAILABLE }, async () => {
  const { db, dir } = makeDb();
  db.upsertStock({ ticker: 'F.MC', name: 'F', country: 'Espanha', indexName: 'IBEX 35' });
  db.upsertStock({ ticker: 'G.DE', name: 'G', country: 'Alemanha', indexName: 'DAX 40' });

  assert.equal(db.auditIndexStocks('IBEX 35').indexName, 'IBEX35');
  assert.equal(db.auditIndexStocks('Alemanha — DAX 40').indexName, 'DAX40');
  db.close();
  removeTempDir(dir);
});
