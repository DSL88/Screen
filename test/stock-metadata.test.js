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

const { makeCandle, makeTempDir, removeTempDir } = require('./helpers');

function makeDb() {
  const dir = makeTempDir('stock-metadata-test-');
  const db = new DB(dir);
  db.init();
  return { db, dir };
}

test('atualizar apenas o name muda o nome e preserva country/index_name', { skip: !SQLITE_AVAILABLE }, async () => {
  const { db, dir } = makeDb();
  db.upsertStock({ ticker: 'AAA', name: 'Nome antigo', country: 'Portugal', indexName: 'PSI' });

  const res = db.updateStockMetadata('AAA', { name: 'Nome novo' });
  assert.equal(res.success, true);
  assert.equal(res.ticker, 'AAA');
  assert.equal(res.changes, 1);

  const s = db.getStockByTicker('AAA');
  assert.equal(s.name, 'Nome novo');
  assert.equal(s.country, 'Portugal');
  assert.equal(s.index_name, 'PSI');
  db.close();
  removeTempDir(dir);
});

test('atualizar apenas o country e apenas o index_name (parciais) preserva os restantes', { skip: !SQLITE_AVAILABLE }, async () => {
  const { db, dir } = makeDb();
  db.upsertStock({ ticker: 'AAA', name: 'AAA', country: 'Portugal', indexName: 'PSI' });

  const byCountry = db.updateStockMetadata('AAA', { country: 'Espanha' });
  assert.equal(byCountry.changes, 1);
  let s = db.getStockByTicker('AAA');
  assert.equal(s.name, 'AAA');
  assert.equal(s.country, 'Espanha');
  assert.equal(s.index_name, 'PSI');

  const byIndex = db.updateStockMetadata('AAA', { index_name: 'IBEX 35' });
  assert.equal(byIndex.changes, 1);
  s = db.getStockByTicker('AAA');
  assert.equal(s.name, 'AAA');
  assert.equal(s.country, 'Espanha');
  assert.equal(s.index_name, 'IBEX35'); // normalizado para o id canónico
  db.close();
  removeTempDir(dir);
});

test('atualizar os 3 campos ao mesmo tempo', { skip: !SQLITE_AVAILABLE }, async () => {
  const { db, dir } = makeDb();
  db.upsertStock({ ticker: 'AAA', name: 'AAA', country: 'Portugal', indexName: 'PSI' });

  const res = db.updateStockMetadata('AAA', { name: 'Nome', country: 'EUA', index_name: 'S&P 500' });
  assert.equal(res.success, true);
  assert.equal(res.changes, 1);

  const s = db.getStockByTicker('AAA');
  assert.equal(s.name, 'Nome');
  assert.equal(s.country, 'EUA');
  assert.equal(s.index_name, 'SP500');
  db.close();
  removeTempDir(dir);
});

test('COALESCE: campos vazios/whitespace mantêm os valores atuais', { skip: !SQLITE_AVAILABLE }, async () => {
  const { db, dir } = makeDb();
  db.upsertStock({ ticker: 'AAA', name: 'Nome', country: 'Portugal', indexName: 'PSI' });

  // Todos os campos "vazios" → nada para atualizar → invalid-input (sem alteração).
  const allBlank = db.updateStockMetadata('AAA', { name: '   ', country: '', index_name: '  ' });
  assert.equal(allBlank.success, false);
  assert.equal(allBlank.error, 'invalid-input');

  const s = db.getStockByTicker('AAA');
  assert.equal(s.name, 'Nome');
  assert.equal(s.country, 'Portugal');
  assert.equal(s.index_name, 'PSI');

  // Só um campo preenchido entre vazios: os vazios ficam COALESCE, o preenchido muda.
  const partial = db.updateStockMetadata('AAA', { name: 'Novo', country: '   ', index_name: '' });
  assert.equal(partial.changes, 1);
  const s2 = db.getStockByTicker('AAA');
  assert.equal(s2.name, 'Novo');
  assert.equal(s2.country, 'Portugal');
  assert.equal(s2.index_name, 'PSI');
  db.close();
  removeTempDir(dir);
});

test('normalização do índice: IBEX 35 → IBEX35, S&P 500 → SP500, personalizado mantém-se', { skip: !SQLITE_AVAILABLE }, async () => {
  const { db, dir } = makeDb();
  db.upsertStock({ ticker: 'A.MC', name: 'A', country: 'Espanha', indexName: 'IBEX 35' });
  db.upsertStock({ ticker: 'B.US', name: 'B', country: 'EUA', indexName: 'S&P 500' });
  db.upsertStock({ ticker: 'C.XX', name: 'C', country: 'X', indexName: 'PSI' });

  db.updateStockMetadata('A.MC', { index_name: 'IBEX 35' });
  db.updateStockMetadata('B.US', { index_name: 'S&P 500' });
  db.updateStockMetadata('C.XX', { index_name: 'Meu Índice Personalizado' });

  assert.equal(db.getStockByTicker('A.MC').index_name, 'IBEX35');
  assert.equal(db.getStockByTicker('B.US').index_name, 'SP500');
  // Índice desconhecido/personalizado mantém o raw value (canonicalIndexId).
  assert.equal(db.getStockByTicker('C.XX').index_name, 'Meu Índice Personalizado');
  db.close();
  removeTempDir(dir);
});

test('ticker inexistente → success com changes 0 e sem criar ativo', { skip: !SQLITE_AVAILABLE }, async () => {
  const { db, dir } = makeDb();
  const res = db.updateStockMetadata('ZZZ', { name: 'Fantasma' });
  assert.equal(res.success, true);
  assert.equal(res.changes, 0);
  assert.equal(db.db.prepare('SELECT COUNT(*) AS n FROM stocks WHERE ticker = ?').get('ZZZ').n, 0);
  db.close();
  removeTempDir(dir);
});

test('ticker vazio ou data vazia → invalid-input', { skip: !SQLITE_AVAILABLE }, async () => {
  const { db, dir } = makeDb();
  db.upsertStock({ ticker: 'AAA', name: 'AAA', country: 'Portugal', indexName: 'PSI' });

  const noTicker = db.updateStockMetadata('', { name: 'X' });
  assert.equal(noTicker.success, false);
  assert.equal(noTicker.error, 'invalid-input');

  const whitespaceTicker = db.updateStockMetadata('   ', { name: 'X' });
  assert.equal(whitespaceTicker.success, false);
  assert.equal(whitespaceTicker.error, 'invalid-input');

  const noData = db.updateStockMetadata('AAA', null);
  assert.equal(noData.success, false);
  assert.equal(noData.error, 'invalid-input');

  const emptyData = db.updateStockMetadata('AAA', {});
  assert.equal(emptyData.success, false);
  assert.equal(emptyData.error, 'invalid-input');

  // Todos os campos em branco → invalid-input (nada para atualizar).
  const blankData = db.updateStockMetadata('AAA', { name: '  ', country: '', index_name: ' ' });
  assert.equal(blankData.success, false);
  assert.equal(blankData.error, 'invalid-input');

  // A BD não foi alterada por nenhuma chamada inválida.
  const s = db.getStockByTicker('AAA');
  assert.equal(s.name, 'AAA');
  assert.equal(s.country, 'Portugal');
  assert.equal(s.index_name, 'PSI');
  db.close();
  removeTempDir(dir);
});

test('não toca em first_date, full_history_fetched nem historical_prices', { skip: !SQLITE_AVAILABLE }, async () => {
  const { db, dir } = makeDb();
  db.upsertStock({ ticker: 'AAA', name: 'AAA', country: 'Portugal', indexName: 'PSI', firstDate: '2000-01-01', fullHistoryFetched: 1 });
  db.saveHistoricalCandlesFromImport('AAA', [
    makeCandle('AAA', '2000-01-01', 10),
    makeCandle('AAA', '2024-06-14', 20)
  ]);

  const res = db.updateStockMetadata('AAA', { name: 'Renomeado', country: 'Espanha', index_name: 'IBEX 35' });
  assert.equal(res.changes, 1);

  const s = db.getStockByTicker('AAA');
  assert.equal(s.name, 'Renomeado');
  assert.equal(s.country, 'Espanha');
  assert.equal(s.index_name, 'IBEX35');
  assert.equal(s.first_date, '2000-01-01');
  assert.equal(s.full_history_fetched, 1);

  const prices = db.getLocalHistoricalPrices('AAA');
  assert.equal(prices.length, 2);
  assert.equal(prices[0].date, '2000-01-01');
  assert.equal(prices[1].date, '2024-06-14');
  db.close();
  removeTempDir(dir);
});

test('sincroniza custom_tickers: o name/country/index_name refletem no card My List', { skip: !SQLITE_AVAILABLE }, async () => {
  const { db, dir } = makeDb();
  // My List é alimentada por custom_tickers; stocks é a origem do modal.
  db.addCustomTicker({ ticker: 'AAA', name: 'Nome antigo', country: 'Portugal', indexName: 'PSI' });
  db.upsertStock({ ticker: 'AAA', name: 'Nome antigo', country: 'Portugal', indexName: 'PSI' });

  const res = db.updateStockMetadata('AAA', { name: 'Nome editado', country: 'Espanha', index_name: 'IBEX 35' });
  assert.equal(res.success, true);

  const custom = db.db.prepare('SELECT name, country, index_name FROM custom_tickers WHERE ticker = ?').get('AAA');
  assert.equal(custom.name, 'Nome editado');
  assert.equal(custom.country, 'Espanha');
  assert.equal(custom.index_name, 'IBEX35');

  const stock = db.getStockByTicker('AAA');
  assert.equal(stock.name, 'Nome editado');
  assert.equal(stock.country, 'Espanha');
  assert.equal(stock.index_name, 'IBEX35');
  db.close();
  removeTempDir(dir);
});

test('sincroniza custom_tickers com COALESCE: campos vazios mantêm os valores atuais', { skip: !SQLITE_AVAILABLE }, async () => {
  const { db, dir } = makeDb();
  db.addCustomTicker({ ticker: 'BBB', name: 'BBBB', country: 'França', indexName: 'CAC40' });
  db.upsertStock({ ticker: 'BBB', name: 'BBBB', country: 'França', indexName: 'CAC40' });

  const res = db.updateStockMetadata('BBB', { name: 'BBBB Renomeado', country: '', index_name: '' });
  assert.equal(res.success, true);

  const custom = db.db.prepare('SELECT name, country, index_name FROM custom_tickers WHERE ticker = ?').get('BBB');
  assert.equal(custom.name, 'BBBB Renomeado');
  assert.equal(custom.country, 'França');
  assert.equal(custom.index_name, 'CAC40');
  db.close();
  removeTempDir(dir);
});

test('atualiza EXATAMENTE o ticker: AAA.LS não altera AAA (sem variante base)', { skip: !SQLITE_AVAILABLE }, async () => {
  const { db, dir } = makeDb();
  db.upsertStock({ ticker: 'AAA', name: 'AAA base', country: 'EUA', indexName: 'SP500' });
  db.upsertStock({ ticker: 'AAA.LS', name: 'AAA Lisboa', country: 'Portugal', indexName: 'PSI' });

  const res = db.updateStockMetadata('AAA.LS', { name: 'AAA Lisboa Editado' });
  assert.equal(res.changes, 1);

  const base = db.getStockByTicker('AAA');
  assert.equal(base.name, 'AAA base');
  assert.equal(base.country, 'EUA');
  assert.equal(base.index_name, 'SP500');

  const exact = db.getStockByTicker('AAA.LS');
  assert.equal(exact.name, 'AAA Lisboa Editado');
  assert.equal(exact.country, 'Portugal');
  assert.equal(exact.index_name, 'PSI');
  db.close();
  removeTempDir(dir);
});