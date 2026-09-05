const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

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

const { makeTempDir, removeTempDir } = require('./helpers');

function makeDb() {
  const dir = makeTempDir('hist-dividends-test-');
  const db = new DB(dir);
  db.init();
  return { db, dir };
}

// ── Testes de Base de Dados: historical_dividends ───────────────────────────

test('database cria a tabela historical_dividends e os índices adequadamente', { skip: !SQLITE_AVAILABLE }, () => {
  const { db, dir } = makeDb();
  try {
    const table = db.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='historical_dividends'").get();
    assert.ok(table, 'A tabela historical_dividends deve existir');

    const indices = db.db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='historical_dividends'").all();
    const indexNames = indices.map(i => i.name);
    assert.ok(indexNames.includes('idx_div_ticker'), 'Índice idx_div_ticker deve existir');
    assert.ok(indexNames.includes('idx_div_ticker_date'), 'Índice idx_div_ticker_date deve existir');
  } finally {
    db.close();
    removeTempDir(dir);
  }
});

test('saveStockDividends e getStockDividends gravam e recuperam métricas calculadas', { skip: !SQLITE_AVAILABLE }, () => {
  const { db, dir } = makeDb();
  try {
    const sampleDividends = [
      { ticker: 'AAPL', date: '2023-05-12', amount: 0.24 },
      { ticker: 'AAPL', date: '2023-08-11', amount: 0.24 },
      { ticker: 'AAPL', date: '2023-11-10', amount: 0.24 },
      { ticker: 'AAPL', date: '2024-02-09', amount: 0.24 }
    ];

    const savedCount = db.saveStockDividends('AAPL', sampleDividends);
    assert.equal(savedCount, 4);

    const result = db.getStockDividends('AAPL');
    assert.equal(result.totalCount, 4);
    assert.equal(result.totalAmount, 0.96);
    assert.ok(result.lastDividend);
    assert.equal(result.lastDividend.date, '2024-02-09');
    assert.equal(result.lastDividend.amount, 0.24);
    assert.equal(result.dividends.length, 4);
    assert.equal(result.dividends[0].date, '2024-02-09'); // ordenado por data DESC

    // Teste de idempotência / REPLACE com valor atualizado
    db.saveStockDividends('AAPL', [{ ticker: 'AAPL', date: '2024-02-09', amount: 0.25 }]);
    const updated = db.getStockDividends('AAPL');
    assert.equal(updated.totalCount, 4, 'Não deve duplicar registo para a mesma data');
    assert.equal(updated.lastDividend.amount, 0.25, 'Deve atualizar montante do dividendo');
    assert.equal(updated.totalAmount, 0.97);

    // Teste com ticker com espaços ou minúsculas
    const lowerResult = db.getStockDividends(' aapl ');
    assert.equal(lowerResult.totalCount, 4);
  } finally {
    db.close();
    removeTempDir(dir);
  }
});

test('saveStockDividends lida com listas vazias ou inválidas graciosamente', { skip: !SQLITE_AVAILABLE }, () => {
  const { db, dir } = makeDb();
  try {
    assert.equal(db.saveStockDividends('MSFT', []), 0);
    assert.equal(db.saveStockDividends('MSFT', null), 0);

    const emptyRes = db.getStockDividends('MSFT');
    assert.deepEqual(emptyRes, {
      dividends: [],
      totalCount: 0,
      totalAmount: 0,
      lastDividend: null
    });
  } finally {
    db.close();
    removeTempDir(dir);
  }
});

// ── Testes do Cliente Yahoo Finance ─────────────────────────────────────────

test('yahooClient exporta fetchStockDividendsFromYahoo em src/data e src/services', () => {
  const dataYahoo = require('../src/data/yahooClient');
  const servicesYahoo = require('../src/services/yahooClient');

  assert.equal(typeof dataYahoo.fetchStockDividendsFromYahoo, 'function');
  assert.equal(typeof servicesYahoo.fetchStockDividendsFromYahoo, 'function');
});

// ── Testes de Preload e Contrato de API ──────────────────────────────────────

test('preload expõe getStockDividends e downloadStockDividends', () => {
  const preloadContent = fs.readFileSync(path.join(__dirname, '../preload.js'), 'utf8');
  assert.ok(preloadContent.includes('getStockDividends:'), 'preload.js deve conter getStockDividends');
  assert.ok(preloadContent.includes('downloadStockDividends:'), 'preload.js deve conter downloadStockDividends');
  assert.ok(preloadContent.includes("'get-stock-dividends'"), 'preload.js deve invocar get-stock-dividends');
  assert.ok(preloadContent.includes("'download-stock-dividends'"), 'preload.js deve invocar download-stock-dividends');
});

// ── Testes de Interface (index.html e renderer.js) ──────────────────────────

test('index.html contém os elementos de UI do histórico de dividendos', () => {
  const html = fs.readFileSync(path.join(__dirname, '../renderer/index.html'), 'utf8');
  assert.ok(html.includes('id="btn-download-dividends"'), 'index.html deve conter btn-download-dividends');
  assert.ok(html.includes('id="modal-div-total"'), 'index.html deve conter modal-div-total');
  assert.ok(html.includes('id="modal-div-count"'), 'index.html deve conter modal-div-count');
  assert.ok(html.includes('id="modal-div-last"'), 'index.html deve conter modal-div-last');
  assert.ok(html.includes('id="tbody-modal-dividends"'), 'index.html deve conter tbody-modal-dividends');
});

test('renderer.js contém as funções loadAndRenderDividends e formatEuropeanDate', () => {
  const js = fs.readFileSync(path.join(__dirname, '../renderer/renderer.js'), 'utf8');
  assert.ok(js.includes('function formatEuropeanDate'), 'renderer.js deve conter formatEuropeanDate');
  assert.ok(js.includes('async function loadAndRenderDividends'), 'renderer.js deve conter loadAndRenderDividends');
  assert.ok(js.includes('btn-download-dividends'), 'renderer.js deve escutar o botão de download de dividendos');
});
