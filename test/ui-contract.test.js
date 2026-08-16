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

test('toolbar My List reestruturada expõe os 6 controlos e o badge de estado', () => {
  for (const id of ['select-index-bulk-fetch', 'mylist-search-input', 'btn-first-registo', 'btn-most-recent', 'btn-add-stock-modal', 'btn-index-actions', 'index-status-badge']) {
    assert.match(html, new RegExp(`id=["']${id}["']`));
  }
  assert.match(html, /Todos os Índices/);
  assert.match(html, /value="ALL"/);
  assert.match(html, /1º Registo \(Baixar histórico desde o IPO\/Origem\)/);
  assert.match(html, /Mais Recente \(Sincronizar até à última sessão de mercado\)/);
  assert.match(renderer, /refreshIndexStatusBadge\(\)/);
  assert.match(renderer, /window\.api\.firstRegisto\(/);
  assert.match(renderer, /window\.api\.syncAllListStocks\(/);
  assert.match(renderer, /onFirstRegistoProgress/);
});

test('eliminação de índice pede confirmação antes de invocar o IPC e recarrega a My List', () => {
  assert.match(html, /id=["']btn-delete-index["']/);
  assert.match(renderer, /window\.api\.deleteIndexWithStocks\(indexId\)/);
  assert.match(renderer, /openConfirmModal\(\{/);
  assert.match(renderer, /confirmLabel:\s*'Sim, Apagar Tudo'/);
  assert.match(renderer, /await reloadMyListFromDatabase\(\);/);
});

test('toolbar de Auditoria 1º Registo liga o botão ao sync e o badge à auditoria', () => {
  assert.match(renderer, /btnFirstRegisto\.addEventListener\('click'/);
  assert.match(renderer, /window\.api\.syncIndexFirstRecords\(requestName\)/);
  assert.match(renderer, /setFirstRegistoBusy\(/);
  assert.match(renderer, /function setFirstRegistoBusy/);
  assert.match(renderer, /A auditar e descarregar 1º registo de/);
  assert.match(renderer, /A auditar e descarregar \$\{p\.ticker\}/);

  // O badge de estado do índice é alimentado pela auditoria (X/Y ativos completos).
  assert.match(renderer, /refreshIndexStatusBadge\(\)/);
  assert.match(renderer, /window\.api\.auditIndex\(requestIndex\)/);
  assert.match(renderer, /\$\{audit\.completeCount\}\/\$\{audit\.totalStocks\} ativos completos/);
  assert.match(renderer, /audit\.pendingCount === 0/);

  // Progresso subscrito exatamente uma vez via subscribeApiEvent (sem duplicados).
  assert.equal((renderer.match(/subscribeApiEvent\('onIndexSyncProgress'/g) || []).length, 1);
  assert.equal((renderer.match(/btnFirstRegisto\.addEventListener\('click'/g) || []).length, 1);
  assert.equal((renderer.match(/setFirstRegistoBusy\(true\)/g) || []).length, 1);
});

test('modal de edição de metadados expõe os 4 controlos e o botão de gravação', () => {
  for (const id of ['modal-stock-name', 'modal-stock-country', 'modal-stock-index', 'modal-stock-index-custom', 'btn-save-stock-metadata']) {
    assert.match(html, new RegExp(`id=["']${id}["']`));
  }
  assert.match(html, /CUSTOM_NEW/);
});

test('saveStockMetadata grava via IPC, notifica sucesso e repopula a UI sem duplicar listeners', () => {
  // A função existe e é a única registada no botão.
  assert.match(renderer, /async function saveStockMetadata\(\)/);
  assert.equal((renderer.match(/btnSaveStockMetadata\.addEventListener\('click', saveStockMetadata\)/g) || []).length, 1);

  // Chama o canal via preload com (ticker, data) e lê o contrato { ok }.
  assert.match(renderer, /window\.api\.updateStockMetadata\(ticker, data\)/);
  assert.match(renderer, /if \(!res \|\| !res\.ok\)/);

  // Sucesso: toast, fecho do modal e repovoamento da My List/dropdown/badge.
  assert.match(renderer, /showToast\('Metadados atualizados com sucesso', 'success'\)/);
  assert.match(renderer, /closeAssetDetailModal\(\)/);
  assert.match(renderer, /await reloadMyListFromDatabase\(\);/);
  assert.match(renderer, /populateIndexBulkFetchDropdown\(\);/);
  assert.match(renderer, /await refreshIndexStatusBadge\(\);/);

  // Erro de negócio (res.ok false) mostra toast de erro sem sucesso falso.
  assert.match(renderer, /showToast\('Erro: ' \+ \(\(res && res\.error\) \|\| 'desconhecido'\), 'error'\)/);
});
