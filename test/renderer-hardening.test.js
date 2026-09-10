'use strict';

// ═══════════════════════════════════════════════════════════════
//  RENDERER HARDENING — XSS + PERFORMANCE (regressão)
//
//  O projeto não usa jsdom. Para os fluxos que dependem de DOM usamos um
//  mock mínimo mas comportamental, que carrega os renderers reais e
//  exercita as funções internas através das suas entradas públicas
//  (listeners/eventos). Para funções não exportadas (fases 1/5 do
//  quantRenderer) validamos o padrão de escape por análise de fonte,
//  à semelhança de test/ui-contract.test.js.
// ═══════════════════════════════════════════════════════════════

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── DOM mock mínimo e reutilizável ────────────────────────────
function createElement(id) {
  const classes = new Set();
  const listeners = {};
  const el = {
    id,
    value: '',
    checked: false,
    hidden: false,
    disabled: false,
    textContent: '',
    innerHTML: '',
    innerText: '',
    className: '',
    dataset: {},
    style: {},
    children: [],
    selectedOptions: [],
    _listeners: listeners,
    _classes: classes,
    classList: {
      add(...cs) { cs.forEach((c) => classes.add(c)); },
      remove(...cs) { cs.forEach((c) => classes.delete(c)); },
      toggle(c, force) {
        const on = force === undefined ? !classes.has(c) : !!force;
        if (on) classes.add(c); else classes.delete(c);
        return on;
      },
      contains(c) { return classes.has(c); }
    },
    addEventListener(evt, handler) { (listeners[evt] = listeners[evt] || []).push(handler); },
    removeEventListener(evt, handler) {
      const arr = listeners[evt];
      if (!arr) return;
      const i = arr.indexOf(handler);
      if (i >= 0) arr.splice(i, 1);
    },
    querySelector() { return createElement(id + '::child'); },
    querySelectorAll() { return []; },
    appendChild(child) { this.children.push(child); return child; },
    insertBefore(child) { this.children.push(child); return child; },
    removeChild() {},
    remove() {},
    setAttribute() {},
    getAttribute() { return null; },
    removeAttribute() {},
    closest() { return null; },
    contains() { return false; },
    focus() {},
    blur() {},
    scrollIntoView() {},
    click() { this.dispatch('click'); },
    dispatch(evt, event) {
      const payload = event || { target: this, preventDefault() {}, stopPropagation() {} };
      (listeners[evt] || []).slice().forEach((h) => h(payload));
    },
    getContext() {
      return { clearRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, fill() {}, arc() {}, fillRect() {}, setLineDash() {} };
    },
    getBoundingClientRect() { return { width: 0, height: 0, left: 0, top: 0 }; }
  };
  return el;
}

function installDomHarness() {
  const elements = new Map();
  const apiListeners = {};
  const getEl = (id) => {
    if (!id) return null;
    if (!elements.has(id)) elements.set(id, createElement(id));
    return elements.get(id);
  };

  const api = {
    on(channel, callback) {
      (apiListeners[channel] = apiListeners[channel] || []).push(callback);
      return () => {};
    },
    listTickers: async () => ({ ok: true, custom: [] }),
    getParams: async () => ({ ok: false }),
    checkListFreshness: async () => ({ ok: true, isUpdated: true, outdatedTickers: [] }),
    checkIndexStatus: async () => ({ ok: false }),
    auditIndex: async () => ({ ok: false }),
    syncAudit: async () => ({ ok: false, error: 'não configurado' }),
    syncStartDownload: async () => ({ ok: true, started: false }),
    onSyncRecentProgress: () => () => {},
    onSimulationProgress: () => () => {},
    onSimulationProgressSpec: () => () => {},
    onSimulationResult: () => () => {},
    onSimulationError: () => () => {}
  };

  global.CSS = { escape: (s) => String(s) };
  global.alert = () => {};
  global.requestAnimationFrame = (cb) => setTimeout(() => cb(0), 0);
  global.document = {
    readyState: 'complete',
    body: createElement('document-body'),
    documentElement: createElement('document-element'),
    getElementById: getEl,
    querySelector() { return null; },
    querySelectorAll() { return []; },
    createElement(tag) { return createElement('created-' + tag); },
    createDocumentFragment() {
      return { children: [], appendChild(child) { this.children.push(child); return child; } };
    },
    addEventListener() {},
    removeEventListener() {}
  };
  global.window = {
    innerWidth: 1280,
    innerHeight: 800,
    location: { href: '' },
    api,
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {}
  };

  return { elements, getEl, api, apiListeners };
}

const harness = installDomHarness();

// Ordem de carga real do index.html: renderer.js → simulationRenderer.js →
// quantRenderer.js → quantTrackerRenderer.js. Capturamos a versão local de
// renderTopRecommendations antes de o quantRenderer a substituir (shadowing
// documentado no relatório M-04).
require(path.join(ROOT, 'renderer/renderer.js'));
const localRenderTopRecommendations = global.window.renderTopRecommendations;
require(path.join(ROOT, 'renderer/simulationRenderer.js'));
require(path.join(ROOT, 'renderer/quantRenderer.js'));
require(path.join(ROOT, 'renderer/quantTrackerRenderer.js'));

const { getEl, api, apiListeners } = harness;

// ═══════════════════════════════════════════════════════════════
//  1. XSS — renderer.js
// ═══════════════════════════════════════════════════════════════

test('renderTopRecommendations escapa ticker/name/sector (renderer.js:5702-5705)', () => {
  const tbody = getEl('tbody-top-recommendations');
  localRenderTopRecommendations([{
    ticker: '<img src=x onerror=alert(1)>',
    name: '"><script>alert(2)</script>',
    sector: '<svg onload=alert(3)>',
    alpha_score: 1
  }]);

  const html = tbody.children.map((tr) => tr.innerHTML).join('');
  assert.ok(html.length > 0, 'deve ter renderizado uma linha');
  assert.ok(!html.includes('<img'), 'ticker/name não podem criar elementos crus');
  assert.ok(!html.includes('<svg'), 'sector não pode criar elementos crus');
  assert.ok(!html.includes('<script'), 'name não pode criar script');
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /&lt;svg onload=alert\(3\)&gt;/);
});

test('freshnessBannerMessage escapa datas provenientes do IPC/SQLite (renderer.js:2814-2816)', async () => {
  // Popula a watchlist para que o clique no scan chegue à verificação.
  api.listTickers = async () => ({
    ok: true,
    custom: [{ ticker: 'AAA', name: 'Ativo A', indexId: 'PSI', indexName: 'PSI' }]
  });
  api.checkListFreshness = async () => ({
    ok: true,
    isUpdated: false,
    outdatedTickers: [{ ticker: 'AAA' }],
    expectedDate: '<img src=x onerror=alert(1)>',
    maxStoredDate: '2024-01-01'
  });

  global.window.loadInitialStockData();
  await delay(25);

  const scanClick = getEl('btn-scan')._listeners.click[0];
  assert.ok(scanClick, 'btn-scan deve ter handler de clique');
  scanClick();
  await delay(25);

  const bannerHtml = getEl('freshness-banner-message').innerHTML;
  assert.ok(bannerHtml.includes('&lt;img src=x onerror=alert(1)&gt;'), 'data esperada deve ser escapada');
  assert.ok(!bannerHtml.includes('<img'), 'não pode injetar elementos no banner');
});

// ═══════════════════════════════════════════════════════════════
//  2. XSS — quantTrackerRenderer.js
// ═══════════════════════════════════════════════════════════════

test('tracker escapa coortes e matriz de patamares (quantTrackerRenderer:184-192, 226-244)', async () => {
  global.window.quantAPI = {
    fetchTrackerData: async () => ({
      data: {
        kpis: { hit_rate: 60, target_hits: 1, resolved_trades: 1, active_pending: 0, profit_factor: 2, avg_return_pct: 1, avg_days_to_target: 3, total_recommendations: 1 },
        cohort_dates: ['<img src=x onerror=alert(1)>', '2024-01-05'],
        tier_matrix: [{
          tier_label: '<img src=x onerror=alert(2)>',
          suggestions_count: 1,
          targets_hit: 1,
          stops_hit: 0,
          hit_rate_real: 60,
          avg_return: 1,
          status_calibration: '<svg onload=alert(3)>'
        }],
        items: []
      }
    })
  };

  await global.window.quantTracker.loadTrackerDashboard();

  const matrixHtml = getEl('tracker-matrix-body').innerHTML;
  const dateHtml = getEl('tracker-filter-date').innerHTML;
  assert.ok(!matrixHtml.includes('<img'), 'tier_label não pode criar elementos');
  assert.ok(!matrixHtml.includes('<svg'), 'status_calibration não pode criar elementos');
  assert.match(matrixHtml, /&lt;img src=x onerror=alert\(2\)&gt;/);
  assert.ok(!dateHtml.includes('<img'), 'coortes não podem criar elementos');
  assert.match(dateHtml, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

// ═══════════════════════════════════════════════════════════════
//  3. XSS — padrões de escape no quantRenderer.js (fases internas)
// ═══════════════════════════════════════════════════════════════

test('quantRenderer fases 1/5 e matriz markov escapam todos os campos dinâmicos', () => {
  const src = read('renderer/quantRenderer.js');
  const phase1 = src.match(/function renderPhase1Fundamentals\(p1\) \{([\s\S]*?)\n  \}/);
  const phase5 = src.match(/function renderPhase5Purification\(p5\) \{([\s\S]*?)\n  \}/);
  assert.ok(phase1 && phase5, 'fases 1 e 5 devem existir');

  for (const field of ['s.ticker', 's.sector', 's.market_cap', 's.quality_score', 's.roa', 's.debt_to_equity', 's.earnings_yield', 's.fcf_yield', 's.status']) {
    assert.match(phase1[1], new RegExp('escapeHtml\\(' + field.replace('.', '\\.') + '\\)'), `fase 1 deve escapar ${field}`);
  }
  for (const field of ['c.feature', 'c.vif_raw', 'c.vif_purified', 'c.status']) {
    assert.match(phase5[1], new RegExp('escapeHtml\\(' + field.replace('.', '\\.') + '\\)'), `fase 5 deve escapar ${field}`);
  }
  assert.match(src, /escapeHtml\(r\.from_pair\)/, 'matriz markov deve escapar from_pair');
});

// ═══════════════════════════════════════════════════════════════
//  4. PERFORMANCE — appendRow em lote (DocumentFragment + rAF)
// ═══════════════════════════════════════════════════════════════

test('appendRow agrega N linhas num único append e só limpa placeholders uma vez', async () => {
  const rowCallback = apiListeners['scan:row'][0];
  assert.ok(rowCallback, 'scan:row deve estar subscrito');

  const body = getEl('results-body');
  let appends = 0;
  let placeholderQueries = 0;
  const originalAppend = body.appendChild.bind(body);
  const originalQuery = body.querySelectorAll.bind(body);
  body.appendChild = (child) => { appends++; return originalAppend(child); };
  body.querySelectorAll = (sel) => { placeholderQueries++; return originalQuery(sel); };

  for (let i = 0; i < 200; i++) {
    rowCallback({
      ticker: 'T' + i,
      name: 'Nome ' + i,
      direction: 'COMPRA',
      edge: 0.1,
      pStay: 0.5,
      volumeValid: true,
      rvol: 1,
      rvolApproved: true,
      close: 10,
      stopLoss: 9,
      takeProfit: 11
    });
  }

  assert.equal(placeholderQueries, 1, 'placeholders devem ser removidos uma única vez por scan');

  await delay(30); // deixa o requestAnimationFrame do lote executar
  assert.equal(appends, 1, 'as 200 linhas devem entrar num único append');

  body.appendChild = originalAppend;
  body.querySelectorAll = originalQuery;
});

// ═══════════════════════════════════════════════════════════════
//  5. PERFORMANCE — debounce da pesquisa de trades
// ═══════════════════════════════════════════════════════════════

test('pesquisa do trade log só re-renderiza após debounce (150ms)', async () => {
  const tbody = getEl('tbody-trades-log');
  let writes = 0;
  Object.defineProperty(tbody, 'innerHTML', {
    configurable: true,
    get() { return this._innerHTML || ''; },
    set(v) { writes++; this._innerHTML = v; }
  });

  const search = getEl('ws-trades-search');
  const inputHandlers = search._listeners.input || [];
  assert.ok(inputHandlers.length >= 1, 'input de pesquisa deve estar ligado');

  writes = 0;
  inputHandlers[0]();
  inputHandlers[0]();
  inputHandlers[0]();
  assert.equal(writes, 0, 'não pode redesenhar a cada tecla');

  await delay(220);
  assert.equal(writes, 1, 'deve redesenhar exatamente uma vez após o debounce');
});

// ═══════════════════════════════════════════════════════════════
//  6. LEAK — listener SYNC_RECENT_PROGRESS
// ═══════════════════════════════════════════════════════════════

test('dois cliques em Mais Recente mantêm no máximo um listener de progresso ativo', async () => {
  const click = getEl('btn-most-recent')._listeners.click[0];
  assert.ok(click, 'btn-most-recent deve ter handler');

  let active = 0;
  let maxActive = 0;
  api.onSyncRecentProgress = () => {
    active++;
    maxActive = Math.max(maxActive, active);
    return () => { active = Math.max(0, active - 1); };
  };
  api.syncAudit = async () => ({ ok: true, total: 2, pending: 1, upToDate: 1 });

  let releaseDownload;
  api.syncStartDownload = () => new Promise((resolve) => { releaseDownload = resolve; });

  click();
  click(); // segundo clique síncrono deve ser bloqueado pela guarda de reentrância

  await delay(600); // auditoria + espera de 500 ms até registar o listener
  assert.equal(active, 1, 'deve existir exatamente um listener ativo');
  assert.equal(maxActive, 1, 'nunca pode acumular listeners');

  click(); // clique durante o download em curso continua bloqueado
  assert.equal(active, 1, 'clique reentrante não pode registar outro listener');

  releaseDownload({ ok: true, started: false });
  await delay(50);
  assert.equal(active, 0, 'o caminho foreground deve remover o listener no fim');
});

test('sync-all-done remove o listener do caminho de background uma única vez', async () => {
  const click = getEl('btn-most-recent')._listeners.click[0];
  let active = 0;
  api.onSyncRecentProgress = () => {
    active++;
    return () => { active = Math.max(0, active - 1); };
  };
  api.syncAudit = async () => ({ ok: true, total: 2, pending: 1, upToDate: 1 });
  api.syncStartDownload = async () => ({ ok: true, started: true, pending: 1 });

  click();
  await delay(600);
  assert.equal(active, 1, 'em background o listener mantém-se durante o download');

  const done = (apiListeners['sync-all-done'] || [])[0];
  assert.ok(done, 'sync-all-done deve estar subscrito');
  await done({ totalStocks: 1, updatedCount: 1, failedCount: 0 });

  assert.equal(active, 0, 'sync-all-done deve remover o listener');

  // Uma segunda chamada ao evento não deve remover nada inexistente nem falhar.
  await done({ totalStocks: 1, updatedCount: 1, failedCount: 0 });
  assert.equal(active, 0);
});

// ═══════════════════════════════════════════════════════════════
//  7. Contrato de fonte (cleanup + escape helper)
// ═══════════════════════════════════════════════════════════════

test('contrato de fonte: cleanup idempotente e helper de escape completo', () => {
  const rendererSrc = read('renderer/renderer.js');
  const simSrc = read('renderer/simulationRenderer.js');

  assert.match(rendererSrc, /function cleanupSyncRecentProgressListener\(\)/);
  assert.match(rendererSrc, /syncRecentProgressCleanup = typeof cleanupProgress === 'function'/);
  // registo, finally, sync-all-done e beforeunload
  assert.ok((rendererSrc.match(/cleanupSyncRecentProgressListener\(\);/g) || []).length >= 4,
    'cleanup deve ser invocado no registo, no finally, no sync-all-done e no beforeunload');

  assert.match(rendererSrc, /\.replace\(\/'\/g, '&#39;'\)/, "escapeHtml deve cobrir aspas simples");

  const appendRow = rendererSrc.match(/function appendRow\(r\) \{([\s\S]*?)\n  \}/);
  assert.ok(appendRow, 'appendRow deve existir');
  assert.ok((appendRow[1].match(/body\.querySelectorAll/g) || []).length === 1,
    'appendRow não pode fazer querySelectorAll por linha');
  assert.match(appendRow[1], /rowPlaceholdersCleared/);
  assert.match(rendererSrc, /document\.createDocumentFragment\(\)/);
  assert.match(rendererSrc, /function scheduleRowFlush\(\)/);

  assert.match(simSrc, /let tradesSearchDebounce = null/);
  assert.match(simSrc, /\}, 150\);/);
  assert.match(simSrc, /PENDENTE \(A-01\): paginação\/virtualização do trade log/);
});
