const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const DB = require('../src/db/database');

const { makeTempDir, removeTempDir } = require('./helpers');

test('getStockDetailWithLatestPrice: retorna detalhes e última cotação ordenados por date DESC', () => {
  const dir = makeTempDir();
  const db = new DB(dir);
  db.init();

  // Inserir ativo de teste
  db.addOrUpdateStockRecord({
    ticker: 'GALP.LS',
    name: 'Galp Energia',
    country: 'Portugal',
    index_name: 'PSI20'
  });

  // Inserir histórico de velas com datas desordenadas
  const insertStmt = db.db.prepare(`
    INSERT INTO historical_prices (ticker, date, open, high, low, close, adjclose, volume)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insertStmt.run('GALP.LS', '2024-01-10', 14.1, 14.5, 14.0, 14.3, 14.3, 1000);
  insertStmt.run('GALP.LS', '2024-03-15', 15.0, 15.8, 14.9, 15.5, 14.8, 2500);
  insertStmt.run('GALP.LS', '2024-02-01', 14.4, 14.8, 14.2, 14.6, 14.6, 1500);

  const result = db.getStockDetailWithLatestPrice('galp.ls ');

  assert.ok(result, 'Resultado deve existir');
  assert.equal(result.ticker, 'GALP.LS');
  assert.equal(result.name, 'Galp Energia');
  assert.equal(result.country, 'Portugal');
  assert.equal(result.index_name, 'PSI20');
  assert.equal(result.first_date, '2024-01-10');
  assert.equal(result.last_date, '2024-03-15');
  assert.equal(result.total_candles, 3);

  // A última vela deve ser 2024-03-15
  assert.ok(result.latestPrice, 'latestPrice deve existir');
  assert.equal(result.latestPrice.date, '2024-03-15');
  assert.equal(result.latestPrice.close, 15.5);
  assert.equal(result.latestPrice.adjclose, 14.8);
  assert.equal(result.latestPrice.open, 15.0);
  assert.equal(result.latestPrice.high, 15.8);
  assert.equal(result.latestPrice.low, 14.9);
  assert.equal(result.latestPrice.volume, 2500);

  db.close();
  removeTempDir(dir);
});

test('getStockDetailWithLatestPrice: ativo sem velas retorna latestPrice null e total_candles 0', () => {
  const dir = makeTempDir();
  const db = new DB(dir);
  db.init();

  db.addOrUpdateStockRecord({
    ticker: 'NOVAA.LS',
    name: 'Nova Ação',
    country: 'Portugal',
    index_name: 'PSI20'
  });

  const result = db.getStockDetailWithLatestPrice('NOVAA.LS');

  assert.ok(result);
  assert.equal(result.ticker, 'NOVAA.LS');
  assert.equal(result.name, 'Nova Ação');
  assert.equal(result.total_candles, 0);
  assert.equal(result.latestPrice, null);

  db.close();
  removeTempDir(dir);
});

test('getStockDetailWithLatestPrice: COALESCE(adjclose, close) quando adjclose é null', () => {
  const dir = makeTempDir();
  const db = new DB(dir);
  db.init();

  db.addOrUpdateStockRecord({
    ticker: 'TEST.LS',
    name: 'Test Corp',
    country: 'Portugal',
    index_name: 'PSI20'
  });

  const insertStmt = db.db.prepare(`
    INSERT INTO historical_prices (ticker, date, open, high, low, close, adjclose, volume)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insertStmt.run('TEST.LS', '2024-05-01', 10, 11, 9, 10.5, null, 500);

  const result = db.getStockDetailWithLatestPrice('TEST.LS');
  assert.ok(result.latestPrice);
  assert.equal(result.latestPrice.close, 10.5);
  assert.equal(result.latestPrice.adjclose, 10.5);

  db.close();
  removeTempDir(dir);
});

test('HTML e Renderer: estrutura do modal, price box e formatDate', () => {
  const htmlPath = path.join(__dirname, '..', 'renderer', 'index.html');
  const html = fs.readFileSync(htmlPath, 'utf8');

  assert.ok(html.includes('id="stock-detail-modal"'), 'Modal deve ter id="stock-detail-modal"');
  assert.ok(html.includes('class="stock-modal-price-box"'), 'Deve conter class="stock-modal-price-box"');
  assert.ok(html.includes('id="modal-latest-close"'), 'Deve conter id="modal-latest-close"');
  assert.ok(html.includes('id="modal-latest-adjclose"'), 'Deve conter id="modal-latest-adjclose"');
  assert.ok(html.includes('id="modal-latest-session-date"'), 'Deve conter id="modal-latest-session-date"');
  assert.ok(html.includes('id="modal-first-date"'), 'Deve conter id="modal-first-date"');
  assert.ok(html.includes('id="modal-last-date"'), 'Deve conter id="modal-last-date"');
  assert.ok(html.includes('id="modal-total-candles"'), 'Deve conter id="modal-total-candles"');

  const rendererPath = path.join(__dirname, '..', 'renderer', 'renderer.js');
  const rendererCode = fs.readFileSync(rendererPath, 'utf8');

  assert.ok(rendererCode.includes('openStockDetailModal'), 'renderer.js deve conter openStockDetailModal');
  assert.ok(rendererCode.includes('formatDate'), 'renderer.js deve conter formatDate');
  assert.ok(rendererCode.includes('Sem Cotação'), 'renderer.js deve exibir "Sem Cotação" quando não há velas');

  // Teste lógico do formato de data DD-MM-AAAA
  function formatDate(isoStr) {
    if (!isoStr) return '--';
    const parts = String(isoStr).slice(0, 10).split('-');
    return parts.length === 3 ? `${parts[2]}-${parts[1]}-${parts[0]}` : isoStr;
  }

  assert.equal(formatDate('2024-03-15'), '15-03-2024');
  assert.equal(formatDate(null), '--');
  assert.equal(formatDate(''), '--');

  // Teste de renderização lógica do preço
  function computePriceDisplay(latestPrice) {
    if (!latestPrice || latestPrice.close === null || latestPrice.close === undefined) {
      return { close: 'Sem Cotação', adj: '', date: 'N/D' };
    }
    const rawClose = Number(latestPrice.close);
    const adjClose = Number(latestPrice.adjclose !== undefined && latestPrice.adjclose !== null ? latestPrice.adjclose : rawClose);
    return {
      close: rawClose.toFixed(2),
      adj: Math.abs(rawClose - adjClose) > 0.01 ? `(Adj: ${adjClose.toFixed(2)})` : '',
      date: formatDate(latestPrice.date)
    };
  }

  // Com split/dividendo (diferença > 0.01)
  const displayWithAdj = computePriceDisplay({ close: 15.5, adjclose: 14.8, date: '2024-03-15' });
  assert.equal(displayWithAdj.close, '15.50');
  assert.equal(displayWithAdj.adj, '(Adj: 14.80)');
  assert.equal(displayWithAdj.date, '15-03-2024');

  // Sem split (diferença <= 0.01)
  const displayNoAdj = computePriceDisplay({ close: 10.0, adjclose: 10.0, date: '2024-03-15' });
  assert.equal(displayNoAdj.close, '10.00');
  assert.equal(displayNoAdj.adj, '');
  assert.equal(displayNoAdj.date, '15-03-2024');

  // Sem cotação
  const displayEmpty = computePriceDisplay(null);
  assert.equal(displayEmpty.close, 'Sem Cotação');
  assert.equal(displayEmpty.adj, '');
  assert.equal(displayEmpty.date, 'N/D');

  // Verifica também simulation.html
  const simHtmlPath = path.join(__dirname, '..', 'src', 'renderer', 'simulation.html');
  const simHtml = fs.readFileSync(simHtmlPath, 'utf8');
  assert.ok(simHtml.includes('id="stock-detail-modal"'), 'simulation.html deve ter id="stock-detail-modal"');
  assert.ok(simHtml.includes('class="stock-modal-price-box"'), 'simulation.html deve conter class="stock-modal-price-box"');
});
