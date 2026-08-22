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

test('modal de edição de metadados expõe camadas view/edit e os controlos dinâmicos', () => {
  for (const id of ['display-stock-name', 'display-stock-country', 'display-stock-index', 'edit-stock-name', 'edit-stock-country', 'edit-stock-index', 'edit-stock-index-custom', 'btn-edit-stock-modal', 'btn-save-stock-modal', 'btn-cancel-edit-modal']) {
    assert.match(html, new RegExp(`id=["']${id}["']`));
  }
  // Ícones foram migrados de emojis para sprite SVG inline (refinamento visual).
  assert.match(html, /id=["']btn-edit-stock-modal["'][^>]*><svg class="icon"[^>]*><use href="#i-pencil"><\/use><\/svg> Editar</);
  assert.match(html, /<svg class="icon"[^>]*><use href="#i-save"><\/use><\/svg> Guardar Alterações/);
  // Os IDs antigos sempre-editáveis foram substituídos pelos novos.
  for (const id of ['modal-stock-name', 'modal-stock-country', 'modal-stock-index', 'modal-stock-index-custom', 'btn-save-stock-metadata']) {
    assert.doesNotMatch(html, new RegExp(`id=["']${id}["']`));
  }
});

test('edição dinâmica carrega índices via getDistinctIndices e tem um listener por botão', () => {
  // Abrir o modal regressa sempre a .view-mode; editar alterna para .edit-mode.
  assert.match(renderer, /function setAssetDetailViewMode\(view\)/);
  assert.match(renderer, /setAssetDetailViewMode\(true\)/);
  assert.match(renderer, /async function enterAssetDetailEditMode\(\)/);
  assert.match(renderer, /function cancelAssetDetailEdit\(\)/);
  assert.equal((renderer.match(/btnEditStockModal\.addEventListener\('click', enterAssetDetailEditMode\)/g) || []).length, 1);
  assert.equal((renderer.match(/btnCancelEditModal\.addEventListener\('click', cancelAssetDetailEdit\)/g) || []).length, 1);
  // O dropdown de edição é alimentado pelos índices distintos da BD.
  assert.match(renderer, /async function populateEditStockIndexDropdown\(/);
  assert.match(renderer, /window\.api\.getDistinctIndices\(\)/);
  assert.match(renderer, /editStockIndex\.addEventListener\('change'/);
});

test('saveStockModal grava via IPC, notifica sucesso e repopula a UI sem duplicar listeners', () => {
  // A função existe e é a única registada no botão.
  assert.match(renderer, /async function saveStockModal\(\)/);
  assert.equal((renderer.match(/btnSaveStockModal\.addEventListener\('click', saveStockModal\)/g) || []).length, 1);

  // Chama o canal via preload com (ticker, data) e lê o contrato { ok }.
  assert.match(renderer, /window\.api\.updateStockMetadata\(ticker, data\)/);
  assert.match(renderer, /if \(!res \|\| !res\.ok\)/);

  // Sucesso: atualiza a memória local + camada view, toast, e repopula a UI.
  assert.match(renderer, /setAssetDetailViewValues\(assetDetailCurrentValues\)/);
  assert.match(renderer, /setAssetDetailViewMode\(true\)/);
  assert.match(renderer, /showToast\('Metadados atualizados com sucesso', 'success'\)/);
  assert.match(renderer, /await reloadMyListFromDatabase\(\);/);
  assert.match(renderer, /populateIndexBulkFetchDropdown\(\);/);
  assert.match(renderer, /await refreshIndexStatusBadge\(\);/);

  // Erro de negócio (res.ok false) mostra toast de erro sem sucesso falso.
  assert.match(renderer, /showToast\('Erro: ' \+ \(\(res && res\.error\) \|\| 'desconhecido'\), 'error'\)/);
});

test('openAssetDetailModal reverter para .view-mode descarta edições pendentes', () => {
  // Ao abrir o modal: limpa os valores atuais e regressa sempre à camada view.
  assert.match(renderer, /async function openAssetDetailModal\(ticker\)/);
  assert.match(renderer, /Reverter sempre para \.view-mode ao abrir, descartando edições pendentes\./);
  assert.match(renderer, /assetDetailCurrentValues\s*=\s*\{\s*name: '', country: '', indexName: '' \};/);
  // A chamada setAssetDetailViewMode(true) dentro do open é a que reverte;
  // o mesmo padrão é usado pelo cancelar e pelo save.
  assert.ok((renderer.match(/setAssetDetailViewMode\(true\)/g) || []).length >= 1);
});

test('cancelAssetDetailEdit volta a .view-mode sem IPC nem sucesso falso', () => {
  const match = renderer.match(/function cancelAssetDetailEdit\(\) \{([\s\S]*?)\n  \}/);
  assert.ok(match, 'cancelAssetDetailEdit deve existir');
  const body = match[1];
  // Só restaura a camada de visualização e limpa o erro; não grava nem toasts.
  assert.match(body, /setAssetDetailViewMode\(true\)/);
  assert.doesNotMatch(body, /window\.api\./);
  assert.doesNotMatch(body, /showToast\(/);
  assert.match(body, /assetMetadataError\.textContent\s*=\s*''/);
});

test('edição tem um único listener de change no select e pré-preenche os inputs', () => {
  assert.equal((renderer.match(/editStockIndex\.addEventListener\('change'/g) || []).length, 1);
  // O modo edição preenche os inputs com os valores atuais antes de carregar.
  assert.match(renderer, /editStockName\.value\s*=\s*vals\.name \|\| ''/);
  assert.match(renderer, /editStockCountry\.value\s*=\s*vals\.country \|\| ''/);
  assert.match(renderer, /setAssetDetailViewMode\(false\)/);
  assert.match(renderer, /await populateEditStockIndexDropdown\(vals\.indexName \|\| ''\)/);
});
