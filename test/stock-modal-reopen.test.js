'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// ══════════════════════════════════════════════════════════════
//  REGRESSÃO: ECRÃ ESCURO / BACKDROP PRESO AO REABRIR O MODAL
//  O fecho aplicava `hidden`/`display:none` ao cartão interior
//  (#stock-detail-modal); a abertura seguinte mostrava apenas o
//  backdrop (#modal-asset-detail), deixando o ecrã bloqueado.
// ══════════════════════════════════════════════════════════════

const RENDERER_PATH = path.join(__dirname, '..', 'renderer', 'renderer.js');

class FakeClassList {
  constructor(classes = []) {
    this.set = new Set(classes);
  }
  add(...classes) { classes.forEach(c => this.set.add(c)); }
  remove(...classes) { classes.forEach(c => this.set.delete(c)); }
  contains(c) { return this.set.has(c); }
}

class FakeElement {
  constructor(id, classes = []) {
    this.id = id;
    this.classList = new FakeClassList(classes);
    this.style = {};
    this.hidden = false;
    this.textContent = '';
    this.value = '';
  }
  querySelector(selector) {
    return this._matches(selector) ? this : null;
  }
  querySelectorAll(selector) {
    return this._matches(selector) ? [this] : [];
  }
  _matches(selector) {
    if (selector.startsWith('#')) return this.id === selector.slice(1);
    if (selector.startsWith('.')) {
      return selector.slice(1).split('.').every(c => this.classList.contains(c));
    }
    const attr = selector.match(/^\[id\*="([^"]+)"\]$/);
    if (attr) return this.id.includes(attr[1]);
    return false;
  }
}

function createDom() {
  const backdrop = new FakeElement('modal-asset-detail', ['modal-backdrop']);
  backdrop.hidden = true;
  const card = new FakeElement('stock-detail-modal', ['modal', 'modal-asset-detail']);
  const closePrice = new FakeElement('modal-latest-close');
  const adjPrice = new FakeElement('modal-latest-adjclose');
  const sessionDate = new FakeElement('modal-latest-session-date');
  const elements = [backdrop, card, closePrice, adjPrice, sessionDate];
  const byId = new Map(elements.map(el => [el.id, el]));

  const documentMock = {
    getElementById(id) { return byId.get(id) || null; },
    querySelectorAll(selectorList) {
      const selectors = selectorList.split(',').map(s => s.trim()).filter(Boolean);
      const found = [];
      for (const el of elements) {
        if (selectors.some(sel => el._matches(sel)) && !found.includes(el)) found.push(el);
      }
      return found;
    }
  };

  return { documentMock, backdrop, card, closePrice };
}

function loadModalFunctions(documentMock, windowMock) {
  const code = fs.readFileSync(RENDERER_PATH, 'utf8');

  const slice = (startMarker, endMarker) => {
    const start = code.indexOf(startMarker);
    const end = code.indexOf(endMarker, start);
    assert.ok(start !== -1, `marcador inicial não encontrado: ${startMarker}`);
    assert.ok(end !== -1, `marcador final não encontrado: ${endMarker}`);
    return code.slice(start, end);
  };

  const renderStockPriceBoxSrc = slice('  function renderStockPriceBox(data) {', '  // Abertura estritamente segura do modal do ativo');
  const openStockDetailModalSrc = slice('  async function openStockDetailModal(ticker) {', '  function formatDate(isoStr) {');
  const formatDateSrc = slice('  function formatDate(isoStr) {', '  function closeStockModal() {');
  const showStockModalSrc = slice('  function showStockModal() {', '  async function openAssetDetailModalInternal(ticker) {');
  const closeStockModalSrc = slice('  function closeStockModal() {', '  function closeAssetDetailModal() {');

  const src = `
    'use strict';
    let currentModalStock = null;
    let currentAssetTicker = null;
    let currentModalActiveTicker = null;
    let assetSelectedFile = null;
    let activeInspectedAsset = null;
    const toastLog = [];
    function showToast(message, type) { toastLog.push({ message, type }); }
    function attachModalEnterKeyListeners() {}
    const modalAssetDetail = document.getElementById('modal-asset-detail');
    ${showStockModalSrc}
    ${renderStockPriceBoxSrc}
    ${openStockDetailModalSrc}
    ${formatDateSrc}
    ${closeStockModalSrc}
    return {
      showStockModal,
      openStockDetailModal,
      closeStockModal,
      renderStockPriceBox,
      formatDate,
      getState: () => ({ currentModalStock, currentAssetTicker, toastLog })
    };
  `;

  return new Function('document', 'window', src)(documentMock, windowMock);
}

test('renderer.js: closeStockModal repõe o cartão interior visível para a próxima abertura', () => {
  const { documentMock, backdrop, card } = createDom();
  const win = { api: {} };
  const modal = loadModalFunctions(documentMock, win);

  modal.closeStockModal();

  assert.equal(backdrop.classList.contains('hidden'), true, 'backdrop fica oculto');
  assert.equal(backdrop.hidden, true);
  assert.equal(backdrop.style.display, 'none');
  assert.equal(card.classList.contains('hidden'), false, 'cartão não herda hidden do fecho');
  assert.equal(card.hidden, false);
  assert.notEqual(card.style.display, 'none', 'cartão não herda display:none do fecho');
});

test('renderer.js: abrir 1.º e 2.º ativo sucessivamente mantém backdrop E cartão visíveis', async () => {
  const { documentMock, backdrop, card, closePrice } = createDom();
  const win = {
    api: {
      getStockDetails: async (ticker) => ({
        success: true,
        data: {
          ticker,
          name: `Ativo ${ticker}`,
          country: 'Portugal',
          index_name: 'PSI20',
          first_date: null,
          last_date: null,
          total_candles: 0,
          latestPrice: null
        }
      })
    }
  };
  const modal = loadModalFunctions(documentMock, win);

  // 1.º ativo (sem histórico) — abre com "Sem Cotação"
  await modal.openStockDetailModal('AAA.LS');
  assert.equal(backdrop.classList.contains('hidden'), false, '1.º backdrop visível');
  assert.equal(card.classList.contains('hidden'), false, '1.º cartão visível');
  assert.equal(card.style.display, '', '1.º cartão sem display:none inline');
  assert.equal(closePrice.textContent, 'Sem Cotação', 'ativo sem velas mostra "Sem Cotação"');

  // Fecho (X, Escape ou fundo usam todos closeStockModal)
  modal.closeStockModal();
  assert.equal(backdrop.classList.contains('hidden'), true, 'fecho esconde backdrop');

  // 2.º ativo — regressão: o cartão tem de voltar a aparecer
  await modal.openStockDetailModal('BBB.LS');
  assert.equal(backdrop.classList.contains('hidden'), false, '2.º backdrop visível');
  assert.equal(backdrop.style.display, 'flex');
  assert.equal(card.classList.contains('hidden'), false, '2.º cartão visível (bug do ecrã escuro)');
  assert.equal(card.hidden, false, '2.º cartão sem hidden');
  assert.notEqual(card.style.display, 'none', '2.º cartão sem display:none');

  // 3.º ativo para garantir que o ciclo é estável
  modal.closeStockModal();
  await modal.openStockDetailModal('CCC.LS');
  assert.equal(backdrop.classList.contains('hidden'), false);
  assert.equal(card.classList.contains('hidden'), false);
});

test('renderer.js: falha IPC na abertura remove o backdrop de imediato e notifica', async () => {
  const { documentMock, backdrop, card } = createDom();
  const win = {
    api: {
      getStockDetails: async () => { throw new Error('SQLite indisponível'); }
    }
  };
  const modal = loadModalFunctions(documentMock, win);

  // Abre um ativo válido para simular estado previamente visível
  win.api.getStockDetails = async (ticker) => ({ success: true, data: { ticker, latestPrice: null } });
  await modal.openStockDetailModal('DDD.LS');
  assert.equal(backdrop.classList.contains('hidden'), false);

  // Falha inesperada na leitura
  win.api.getStockDetails = async () => { throw new Error('SQLite indisponível'); };
  await modal.openStockDetailModal('EEE.LS');

  assert.equal(backdrop.classList.contains('hidden'), true, 'backdrop removido após erro');
  assert.equal(backdrop.style.display, 'none');
  assert.equal(card.classList.contains('hidden'), false, 'cartão pronto para a próxima abertura');
  const { toastLog } = modal.getState();
  assert.equal(toastLog.length, 1, 'erro notificado ao utilizador');
  assert.equal(toastLog[0].type, 'error');
  assert.match(toastLog[0].message, /EEE\.LS/);
});

test('renderer.js: resposta IPC sem sucesso também liberta o ecrã sem exceção fatal', async () => {
  const { documentMock, backdrop } = createDom();
  const win = {
    api: { getStockDetails: async () => ({ success: false, error: 'not-found' }) }
  };
  const modal = loadModalFunctions(documentMock, win);

  await modal.openStockDetailModal('FFF.LS');
  assert.equal(backdrop.classList.contains('hidden'), true);
  assert.match(modal.getState().toastLog[0].message, /not-found/);
});

test('renderer.js: preço nulo/garbage nunca lança TypeError no renderStockPriceBox', () => {
  const { documentMock, closePrice } = createDom();
  const modal = loadModalFunctions(documentMock, { api: {} });

  modal.renderStockPriceBox({ latestPrice: { close: null, adjclose: null } });
  assert.equal(closePrice.textContent, 'Sem Cotação');

  modal.renderStockPriceBox({ latestPrice: { close: 'abc', adjclose: 'xyz' } });
  assert.equal(closePrice.textContent, 'Sem Cotação');

  modal.renderStockPriceBox({ latestPrice: null });
  assert.equal(closePrice.textContent, 'Sem Cotação');

  modal.renderStockPriceBox({});
  assert.equal(closePrice.textContent, 'Sem Cotação');

  modal.renderStockPriceBox({ latestPrice: { close: 15.5, adjclose: 14.8, date: '2024-03-15' } });
  assert.equal(closePrice.textContent, '15.50');
});
