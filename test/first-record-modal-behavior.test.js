'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// ══════════════════════════════════════════════════════════════
//  REGRESSÃO: MODAL DE ESCOLHA DO "1º REGISTO"
//  Executa o renderer.js real contra um DOM simulado e valida:
//   - abertura pelo botão da toolbar;
//   - fecho em X, Cancelar, clique fora e Escape;
//   - reabertura sem backdrop preso;
//   - lote por modo com progresso e proteção de concorrência.
// ══════════════════════════════════════════════════════════════

const ROOT = path.join(__dirname, '..');
const RENDERER_PATH = path.join(ROOT, 'renderer', 'renderer.js');
const HTML_PATH = path.join(ROOT, 'renderer', 'index.html');

function makeClassList() {
  const set = new Set();
  return {
    set,
    add(...c) { c.forEach(x => set.add(x)); },
    remove(...c) { c.forEach(x => set.delete(x)); },
    contains(c) { return set.has(c); },
    toggle(c, force) {
      const on = force === undefined ? !set.has(c) : !!force;
      if (on) set.add(c); else set.delete(c);
      return on;
    }
  };
}

function makeEl(id) {
  const listeners = new Map();
  const el = {
    id: id || '',
    tagName: 'DIV',
    classList: makeClassList(),
    style: {},
    dataset: {},
    hidden: false,
    disabled: false,
    value: '',
    textContent: '',
    innerHTML: '',
    checked: false,
    selectedOptions: [],
    options: [],
    children: [],
    addEventListener(type, cb) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(cb);
    },
    removeEventListener() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    closest() { return null; },
    contains() { return false; },
    appendChild(c) { this.children.push(c); return c; },
    removeChild(c) { return c; },
    insertAdjacentHTML() {},
    focus() {},
    blur() {},
    getBoundingClientRect() { return { top: 0, left: 0, right: 10, bottom: 10, width: 100, height: 20 }; },
    getContext() { return new Proxy({}, { get: () => () => {} }); },
    setAttribute() {},
    getAttribute() { return null; },
    removeAttribute() {},
    scrollIntoView() {},
    setSelectionRange() {}
  };
  el._listeners = listeners;
  el.dispatch = (type, ev) => {
    const event = Object.assign({
      type,
      target: el,
      preventDefault() {},
      stopPropagation() {},
      stopImmediatePropagation() { event._stoppedImmediately = true; }
    }, ev || {});
    for (const cb of (listeners.get(type) || [])) {
      cb(event);
      if (event._stoppedImmediately) break;
    }
    return event;
  };
  return el;
}

function createHarness() {
  const html = fs.readFileSync(HTML_PATH, 'utf8');
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);
  const registry = new Map();
  const getEl = (id) => {
    const key = String(id);
    if (!registry.has(key)) registry.set(key, makeEl(key));
    return registry.get(key);
  };
  ids.forEach(getEl);

  getEl('select-index-bulk-fetch').value = 'ALL';
  getEl('select-index-bulk-fetch').selectedOptions = [{ textContent: 'Todos os Índices', dataset: {} }];
  getEl('modal-first-record-choice').classList.add('hidden');
  getEl('modal-first-record-choice').style.display = 'none';

  const choiceButtons = [
    getEl('btn-choice-prices-only'),
    getEl('btn-choice-dividends-only'),
    getEl('btn-choice-both')
  ];
  getEl('modal-first-record-choice').querySelectorAll = (sel) =>
    sel === '.choice-option-btn' ? choiceButtons : [];

  const documentMock = {
    readyState: 'complete',
    body: getEl('body'),
    documentElement: getEl('html'),
    getElementById(id) { return registry.has(String(id)) ? registry.get(String(id)) : null; },
    querySelector(sel) {
      if (sel === '.choice-option-btn') return choiceButtons[0];
      return null;
    },
    querySelectorAll() { return []; },
    createElement(tag) { return makeEl('created-' + tag); },
    createDocumentFragment() { return makeEl('fragment'); },
    addEventListener() {},
    removeEventListener() {}
  };

  const calls = [];
  const windowListeners = new Map();
  const timers = [];
  const progressCallbacks = [];

  const api = new Proxy({
    syncIndexDataBatch: async (params) => {
      calls.push(params);
      return { success: true, updatedCount: 3, total: 3 };
    },
    onSyncProgressUpdate: (cb) => { progressCallbacks.push(cb); return () => {}; }
  }, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (prop === 'then') return undefined;
      return async () => ({ ok: true, success: true, data: {}, custom: [] });
    }
  });

  const windowMock = {
    addEventListener(type, cb) {
      if (!windowListeners.has(type)) windowListeners.set(type, []);
      windowListeners.get(type).push(cb);
    },
    removeEventListener() {},
    dispatch(type, ev) {
      const event = Object.assign({
        type,
        preventDefault() {},
        stopPropagation() {},
        stopImmediatePropagation() { event._stoppedImmediately = true; }
      }, ev || {});
      for (const cb of (windowListeners.get(type) || [])) {
        cb(event);
        if (event._stoppedImmediately) break;
      }
      return event;
    },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    requestAnimationFrame: (cb) => { timers.push(cb); return timers.length; },
    cancelAnimationFrame() {},
    api,
    location: { href: 'file:///index.html' }
  };

  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    window: windowMock,
    document: documentMock,
    navigator: { userAgent: 'test', clipboard: { writeText: async () => {} }, platform: 'MacIntel' },
    location: windowMock.location,
    localStorage: windowMock.localStorage,
    setTimeout: (cb) => { timers.push(cb); return timers.length; },
    clearTimeout() {},
    setInterval: () => 0,
    clearInterval() {},
    requestAnimationFrame: windowMock.requestAnimationFrame,
    cancelAnimationFrame() {},
    getComputedStyle: windowMock.getComputedStyle,
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    alert() {},
    confirm: () => true,
    prompt: () => null,
    CSS: { escape: (s) => String(s) },
    MutationObserver: class { observe() {} disconnect() {} },
    ResizeObserver: class { observe() {} disconnect() {} },
    IntersectionObserver: class { observe() {} disconnect() {} },
    Chart: function () { return { destroy() {}, update() {}, resize() {} }; },
    HTMLElement: function () {},
    Event: function () {},
    CustomEvent: function () {},
    XMLHttpRequest: function () {},
    Blob: function () {},
    URL: { createObjectURL: () => '', revokeObjectURL() {} },
    FormData: function () {},
    FileReader: function () {},
    performance: { now: () => Date.now() }
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;

  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(RENDERER_PATH, 'utf8'), sandbox, { filename: 'renderer.js' });

  const tick = () => new Promise(r => setImmediate(r));
  const flushTimers = () => {
    const pending = timers.splice(0);
    for (const cb of pending) { try { cb(); } catch (_) {} }
  };

  return {
    windowMock,
    calls,
    timers,
    progressCallbacks,
    tick,
    flushTimers,
    el: getEl,
    click(id) { getEl(id).dispatch('click', { target: getEl(id) }); }
  };
}

test('botão "1º Registo" abre sempre o modal de escolha e expõe API de abertura/fecho', async () => {
  const h = createHarness();
  assert.equal(typeof h.windowMock.openFirstRecordChoiceModal, 'function');
  assert.equal(typeof h.windowMock.closeFirstRecordChoiceModal, 'function');

  const modal = h.el('modal-first-record-choice');
  assert.equal(modal.classList.contains('hidden'), true);

  h.click('btn-first-registo');
  await h.tick();

  assert.equal(modal.classList.contains('hidden'), false, 'modal aberto após clique');
  assert.equal(modal.hidden, false);
  assert.equal(modal.style.display, 'flex');
});

test('X, Cancelar, clique fora e Escape fecham o modal; reabertura funciona sem backdrop preso', async () => {
  const h = createHarness();
  const modal = h.el('modal-first-record-choice');
  const openBtn = 'btn-first-registo';

  const assertOpen = (label) => {
    assert.equal(modal.classList.contains('hidden'), false, label + ': aberto');
    assert.equal(modal.style.display, 'flex', label + ': display flex');
  };
  const assertClosed = (label) => {
    assert.equal(modal.classList.contains('hidden'), true, label + ': fechado');
    assert.equal(modal.style.display, 'none', label + ': display none');
  };

  // X
  h.click(openBtn);
  assertOpen('abertura 1');
  h.click('btn-close-choice-modal');
  assertClosed('X');
  h.click(openBtn);
  assertOpen('reabertura após X');

  // Cancelar
  h.click('btn-cancel-choice-modal');
  assertClosed('Cancelar');
  h.click(openBtn);
  assertOpen('reabertura após Cancelar');

  // Clique fora (no backdrop, target === modal)
  modal.dispatch('click', { target: modal });
  assertClosed('clique fora');
  h.click(openBtn);
  assertOpen('reabertura após clique fora');

  // Escape
  h.windowMock.dispatch('keydown', { key: 'Escape' });
  assertClosed('Escape');
  h.click(openBtn);
  assertOpen('reabertura após Escape');

  // Escape com o modal fechado não deve interferir com outras camadas
  h.click('btn-close-choice-modal');
  const ev = h.windowMock.dispatch('keydown', { key: 'Escape' });
  assert.equal(!!ev._stoppedImmediately, false, 'Escape sem modal aberto não é intercetado');
});

test('lote PRICES_ONLY/DIVIDENDS_ONLY/BOTH chama o IPC com o modo certo e atualiza progresso', async () => {
  const h = createHarness();
  const modal = h.el('modal-first-record-choice');
  h.click('btn-first-registo');

  const cases = [
    ['btn-choice-prices-only', 'PRICES_ONLY'],
    ['btn-choice-dividends-only', 'DIVIDENDS_ONLY'],
    ['btn-choice-both', 'BOTH']
  ];
  for (const [btnId, mode] of cases) {
    h.click(btnId);
    await h.tick(); await h.tick();
    const last = h.calls[h.calls.length - 1];
    assert.equal(last.mode, mode, `modo ${mode} enviado`);
    assert.equal(last.indexFilter, 'ALL');
    assert.equal(h.el('choice-modal-progress-bar').style.width, '100%');
    assert.match(h.el('choice-modal-status-text').textContent, /Concluído/);
    h.flushTimers();
    await h.tick();
    assert.equal(modal.classList.contains('hidden'), true, 'modal fecha após concluir');
    h.click('btn-first-registo');
  }
});

test('progresso IPC ativo a ativo atualiza barra e contador', async () => {
  const h = createHarness();
  assert.ok(h.progressCallbacks.length >= 1, 'onSyncProgressUpdate subscrito');

  h.click('btn-first-registo');
  h.progressCallbacks[0]({ current: 2, total: 4, ticker: 'GALP.LS', label: 'Preços' });

  assert.equal(h.el('choice-modal-progress-bar').style.width, '50%');
  assert.equal(h.el('choice-modal-counter').textContent, '2 / 4');
  assert.match(h.el('choice-modal-status-text').textContent, /GALP\.LS/);
});

test('falha no IPC reativa os botões; pedido duplicado é ignorado enquanto decorre', async () => {
  const h = createHarness();
  h.click('btn-first-registo');
  const pricesBtn = h.el('btn-choice-prices-only');
  const divsBtn = h.el('btn-choice-dividends-only');

  // Primeiro pedido fica pendente; segundo clique não pode duplicar o lote.
  let resolveFirst;
  const originalSync = h.windowMock.api.syncIndexDataBatch;
  h.windowMock.api.syncIndexDataBatch = () => new Promise((resolve) => { resolveFirst = resolve; });

  pricesBtn.dispatch('click', { target: pricesBtn });
  await h.tick();
  divsBtn.dispatch('click', { target: divsBtn });
  await h.tick();

  assert.equal(h.calls.filter(c => c.mode === 'DIVIDENDS_ONLY').length, 0, 'sem lote concorrente');
  assert.equal(pricesBtn.disabled, true, 'botões bloqueados durante o lote');

  resolveFirst({ success: false, message: 'Yahoo indisponível' });
  await h.tick(); await h.tick();

  assert.equal(pricesBtn.disabled, false, 'botões reativados após falha');
  assert.equal(divsBtn.disabled, false);
  assert.match(h.el('choice-modal-status-text').textContent, /Yahoo indisponível/);
  assert.equal(h.el('modal-first-record-choice').classList.contains('hidden'), false, 'modal permanece aberto para nova tentativa');

  h.windowMock.api.syncIndexDataBatch = originalSync;
});
