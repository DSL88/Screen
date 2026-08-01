const assert = require('node:assert/strict');
const test = require('node:test');
const axios = require('axios');
const scraper = require('../src/services/wikipediaScraper');

const html = `
  <table class="wikitable"><tr><th>Ticker</th><th>Company</th></tr>
    <tr><td>GALP</td><td>Galp Energia [1]</td></tr>
    <tr><td>GALP</td><td>duplicado</td></tr>
    <tr><td>EDP</td><td>EDP</td></tr>
  </table>`;

test('parser Wikipedia extrai tabela, remove notas, deduplica e aplica sufixo', () => {
  const rows = scraper.parseConstituents(html, 'PSI');
  assert.deepEqual(rows, [
    { ticker: 'GALP.LS', name: 'Galp Energia' },
    { ticker: 'EDP.LS', name: 'EDP' }
  ]);
});

test('parser normaliza formato SP500 e rejeita símbolos perigosos', () => {
  const rows = scraper.parseConstituents(`
    <table class="wikitable"><tr><th>Symbol</th><th>Security</th></tr>
      <tr><td>BRK.B</td><td>Berkshire</td></tr>
      <tr><td>BAD SYMBOL !</td><td>Bad</td></tr>
    </table>`, 'SP500');
  assert.deepEqual(rows, [{ ticker: 'BRK-B', name: 'Berkshire' }]);
});

test('fallback estático é determinístico para falha HTTP e payload vazio', async () => {
  const original = axios.get;
  try {
    axios.get = async () => { throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }); };
    const timeoutFallback = await scraper.getIndexConstituents('Portugal');
    assert.ok(timeoutFallback.length > 0);
    assert.ok(timeoutFallback.every(row => row.ticker.endsWith('.LS')));

    axios.get = async () => ({ data: '<html><body>sem tabelas</body></html>' });
    const emptyFallback = await scraper.getIndexConstituents('PT');
    assert.deepEqual(emptyFallback, timeoutFallback);
    assert.deepEqual(await scraper.getIndexConstituents('país inexistente'), []);
  } finally {
    axios.get = original;
  }
});
