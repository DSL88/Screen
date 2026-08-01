const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

const renderer = fs.readFileSync(require.resolve('../renderer/renderer.js'), 'utf8');
const html = fs.readFileSync(require.resolve('../renderer/index.html'), 'utf8');

test('UI tem contrato de re-renderização segura da My List', () => {
  assert.match(renderer, /function renderWatchlist\(highlightTicker\)/);
  assert.match(renderer, /watchlistEl\.innerHTML\s*=\s*''/);
  assert.match(renderer, /async function reloadMyListFromDatabase\(\)/);
  assert.match(renderer, /watchlist\s*=\s*\(res\.custom \|\| \[\]\)\.map/);
  assert.match(renderer, /renderWatchlist\(\);/);
  assert.match(renderer, /item\.querySelector\('\.wl-remove'\)\.addEventListener/);
});

test('seleção repetida de país e listeners têm proteção contra reentrada', () => {
  assert.match(renderer, /if \(countryImport && !countryImport\.finished\) return;/);
  assert.match(renderer, /selectCountryFilter\.value\s*=\s*''/);
  assert.match(renderer, /subscribeApiEvent\('on', 'scan:progress'/);
  assert.match(renderer, /subscribeApiEvent\('on', 'scan:done'/);
  assert.match(renderer, /subscribeApiEvent\('on', 'sync-all-progress'/);
  assert.equal((renderer.match(/selectCountryFilter\.addEventListener\('change'/g) || []).length, 1);
});

test('HTML mantém controles necessários para progresso, cancelamento e My List', () => {
  for (const id of ['watchlist', 'select-country-filter', 'btn-cancel-country-import', 'index-bulk-progress-fill', 'progress-fill']) {
    assert.match(html, new RegExp(`id=["']${id}["']`));
  }
});
