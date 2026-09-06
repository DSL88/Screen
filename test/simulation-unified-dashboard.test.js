'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

// ═══════════════════════════════════════════════════════════
//  CONTRATO DA UI — MOTOR INTEGRAL DA WORKSTATION (1–20 ANOS)
//  Substitui o antigo dashboard de backtest simplificado.
// ═══════════════════════════════════════════════════════════

test('Workstation HTML: dashboard com seletor de horizonte 1–20 anos', () => {
  const html = fs.readFileSync(require.resolve('../renderer/index.html'), 'utf8');

  // Botões de horizonte rápido
  for (const y of [1, 2, 3, 5, 10, 15, 20]) {
    assert.match(html, new RegExp(`data-years="${y}"`), `deve existir botão de horizonte ${y} anos`);
  }
  assert.match(html, /id=["']ws-horizon-group["']/, 'grupo de botões de horizonte');
  assert.match(html, /id=["']ws-custom-dates["']/, 'datas personalizadas');
  assert.match(html, /Personalizado/, 'opção de intervalo personalizado');

  // Escalão mínimo de convicção (Elite / Moderado+Elite)
  assert.match(html, /id=["']sim-conviction-tier["']/);
  assert.match(html, /Elite Only[^<]*65/, 'opção Elite ≥ 65%');
  assert.match(html, /Moderado[^<]*50/, 'opção Moderado ≥ 50%');

  // Gestão de risco com ATR dinâmico + start workstation
  assert.match(html, /id=["']sim-stop-mode["']/);
  assert.match(html, /value=["']pct["']/, 'modo percentagem fixa (2.4/4.8) é o padrão');
  assert.match(html, /Iniciar Simulação Workstation/, 'botão de iniciar workstation');
});

test('Workstation HTML: matriz de slots 2/5/7,5/10/15/20% + preview dinâmico', () => {
  const html = fs.readFileSync(require.resolve('../renderer/index.html'), 'utf8');
  assert.match(html, /id=["']sim-slot-size["']/, 'seletor de slot (6 opções)');
  for (const v of ['2', '5', '7.5', '10', '15', '20']) {
    assert.match(html, new RegExp(`<option value=["']${v}["']`), `opção de slot ${v}%`);
  }
  assert.match(html, /Máx\. 50 Posições/);
  assert.match(html, /Máx\. 20 Posições/);
  assert.match(html, /Máx\. 13 Posições/);
  assert.match(html, /Máx\. 10 Posições/);
  assert.match(html, /Máx\. 6 Posições/);
  assert.match(html, /Máx\. 5 Posições/);
  // preview dinâmico
  assert.match(html, /id=["']sim-slot-preview["']/);
  assert.match(html, /id=["']preview-max-positions["']/);
  assert.match(html, /id=["']preview-capital-per-trade["']/);
  assert.match(html, /id=["']sim-horizon-exp["']/, 'horizonte de expiração (dias úteis)');
  // defaults calibrados SL 2.4 / TP 4.8 / 35d / capital 10.000 €
  assert.match(html, /id=["']sim-stop-loss["'][^>]*value=["']2\.4["']/);
  assert.match(html, /id=["']sim-take-profit["'][^>]*value=["']4\.8["']/);
  assert.match(html, /id=["']sim-horizon-exp["'][^>]*value=["']35["']/);
  assert.match(html, /id=["']sim-initial-capital["'][^>]*value=["']10000["']/);
});

test('Renderer: matriz SLOT_DEFINITIONS e recálculo floor(1/slot) + payload slotSize', () => {
  const fs2 = require('fs');
  const js = fs2.readFileSync(require.resolve('../renderer/simulationRenderer.js'), 'utf8');
  // 6 chaves na matriz
  ['2', '5', '7.5', '10', '15', '20'].forEach(k => assert.match(js, new RegExp(`'${k}':\\s*\\{\\s*slotPct`), `definição ${k}%`));
  // derivada de floor(1/slotPct)
  assert.match(js, /Math\.floor\(1 \/ 0\.020\)/);
  assert.match(js, /Math\.floor\(1 \/ 0\.075\)/);
  // preview reativo escuta capital + slot
  assert.match(js, /addEventListener\('input',\s*updateSlotPreview\)/);
  assert.match(js, /addEventListener\('change',\s*updateSlotPreview\)/);
  // payload envia slotSize + positionAllocationPct
  assert.match(js, /slotSize:\s*slotKey/);
  assert.match(js, /positionAllocationPct:\s*preset\.slotPct/);
});

test('Engine SLOT_DEFINITIONS: floor(100%/Slot%) para as 6 opções', () => {
  const { SLOT_DEFINITIONS, maxPositionsForSlot } = require('../src/engine/portfolioBacktester');
  const expect = { '2': 50, '5': 20, '7.5': 13, '10': 10, '15': 6, '20': 5 };
  for (const [k, max] of Object.entries(expect)) {
    assert.equal(SLOT_DEFINITIONS[k].maxPositions, max, `slot ${k}%`);
    assert.equal(maxPositionsForSlot(SLOT_DEFINITIONS[k].slotPct), max, `derive ${k}%`);
  }
});

test('Workstation HTML: card resumo com 5 destaques (incl. Sharpe)', () => {
  const html = fs.readFileSync(require.resolve('../renderer/index.html'), 'utf8');
  for (const id of [
    'simulation-summary-card-container', 'btn-open-simulation-modal',
    'summary-card-title', 'summary-card-dates',
    'summary-gain', 'summary-winrate', 'summary-pf', 'summary-dd', 'summary-sharpe'
  ]) {
    assert.match(html, new RegExp(`id=["']${id}["']`), `card resumo: id "${id}"`);
  }
});

test('Workstation HTML: modal com os 5 blocos analíticos (A–E)', () => {
  const html = fs.readFileSync(require.resolve('../renderer/index.html'), 'utf8');
  // Bloco A — KPIs globais
  assert.match(html, /id=["']ws-kpis-bar["']/);
  assert.match(html, /Métricas Globais Institucionais/);
  // Bloco B — matriz ano a ano
  assert.match(html, /id=["']tbody-yearly["']/);
  assert.match(html, /Matriz de Retornos Ano a Ano/);
  // Bloco C — tiers de calibração
  assert.match(html, /id=["']tbody-tiers["']/);
  assert.match(html, /Auditoria por Escalão de Convicção/);
  // Bloco D — gráficos + tail risk
  assert.match(html, /id=["']canvas-equity-curve["']/);
  assert.match(html, /id=["']canvas-drawdown-curve["']/);
  assert.match(html, /id=["']ws-tail-risk["']/);
  // Bloco E — trade log com MFE/MAE + export CSV + pesquisa
  assert.match(html, /id=["']tbody-trades-log["']/);
  assert.match(html, /MFE %/);
  assert.match(html, /MAE %/);
  assert.match(html, /id=["']btn-export-trades-csv["']/);
  assert.match(html, /id=["']ws-trades-search["']/);
});

test('Workstation Renderer: ciclo de vida com relatório do motor (5 blocos)', () => {
  const elements = new Map();
  const listeners = new Map();

  function makeMockElement(id) {
    const classListSet = new Set();
    return {
      id, value: '', checked: false, textContent: '', innerHTML: '', hidden: false,
      style: {}, dataset: {},
      classList: {
        add(c) { classListSet.add(c); }, remove(c) { classListSet.delete(c); },
        toggle(c, force) { const on = force === undefined ? !classListSet.has(c) : force; if (on) classListSet.add(c); else classListSet.delete(c); },
        contains(c) { return classListSet.has(c); }
      },
      addEventListener(evt, h) { const k = `${id}:${evt}`; if (!listeners.has(k)) listeners.set(k, []); listeners.get(k).push(h); },
      querySelectorAll() { return { forEach() {} }; },
      getContext() { return { clearRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, fill() {}, arc() {} }; }
    };
  }

  const ids = [
    'sim-asset-universe', 'sim-conviction-tier', 'sim-direction', 'sim-stop-mode',
    'sim-stop-loss', 'sim-take-profit', 'sim-risk-per-trade', 'sim-rebalance-days',
    'sim-max-positions', 'sim-initial-capital', 'sim-start-date', 'sim-end-date',
    'btn-start-simulation', 'btn-reset-params', 'btn-sim-cancel',
    'sim-progress-wrap', 'sim-progress-fill', 'sim-progress-text', 'sim-status',
    'simulation-summary-card-container', 'btn-open-simulation-modal',
    'summary-card-title', 'summary-card-dates', 'summary-gain', 'summary-winrate',
    'summary-pf', 'summary-dd', 'summary-sharpe',
    'modal-simulation-details', 'modal-sim-subtitle', 'btn-close-sim-modal',
    'ws-kpis-bar', 'tbody-yearly', 'tbody-tiers', 'ws-tail-risk',
    'canvas-equity-curve', 'canvas-drawdown-curve', 'table-trades-log', 'tbody-trades-log'
  ];
  for (const id of ids) elements.set(id, makeMockElement(id));
  elements.get('simulation-summary-card-container').classList.add('hidden');
  elements.get('modal-simulation-details').classList.add('hidden');

  global.document = {
    readyState: 'complete',
    getElementById(id) { return elements.get(id) || null; },
    querySelectorAll() { return []; },
    addEventListener() {}, removeEventListener() {}
  };

  let resultCb = null;
  global.window = {
    addEventListener() {}, removeEventListener() {},
    api: {
      simulationStart: async () => ({ ok: true, runId: 'sim_ws_1' }),
      simulationCancel: async () => ({ ok: true }),
      onSimulationProgress() { return () => {}; },
      onSimulationResult(cb) { resultCb = cb; return () => {}; },
      onSimulationError() { return () => {}; }
    }
  };

  delete require.cache[require.resolve('../src/renderer/js/simulationRenderer')];
  require('../src/renderer/js/simulationRenderer');

  // Relatório no formato do motor workstation
  const wsResult = {
    ok: true, engine: 'workstation',
    summary: { title: 'Simulação Workstation — 20 Anos (2006 a 2026)' },
    kpis: { rentabilidadePct: 132.5, winRateReal: 58, profitFactor: 1.94, maxDrawdown: 14.3, sharpe: 1.62, finalCapital: 23250 },
    globalKpis: { initialCapital: 10000, finalCapital: 23250, netProfitPct: 132.5, cagr: 6.1, sharpe: 1.62, sortino: 2.1, calmar: 0.43, maxDrawdownPct: 14.3, totalTrades: 3, winRate: 58, profitFactor: 1.94, payoffRatio: 1.5, expectancy: 4416, avgDurationDays: 22, exposurePct: 40, var95: 1.8, cvar95: 2.6 },
    yearlyMatrix: [
      { year: '2020', returnPct: 12.5, trades: 2, winRate: 50, maxDrawdownPct: 4.1, sharpe: 1.2 },
      { year: '2021', returnPct: -3.2, trades: 1, winRate: 0, maxDrawdownPct: 5.5, sharpe: -0.4 }
    ],
    calibrationTiers: {
      ELITE: { tier: 'Elite', range: '65–100%', trades: 2, winRateReal: 60, winRateTheoretical: 71, pnl: 5000, alpha: -11 },
      MODERATE: { tier: 'Moderado', range: '50–64.9%', trades: 1, winRateReal: 55, winRateTheoretical: 56, pnl: 1900, alpha: -1 }
    },
    risk: { var95: 1.8, cvar95: 2.6 },
    validation: { valid: true, sharpeOOS: 1.4, dsrPercent: 96.5, pboPercent: 12.5, isApproved: true },
    equityCurve: [{ date: '2020-01-02', value: 10000 }, { date: '2021-12-30', value: 23250 }],
    drawdownSeries: [{ date: '2020-01-02', value: 0 }, { date: '2021-01-02', value: 5.5 }],
    benchmark: [{ date: '2020-01-02', value: 10000 }, { date: '2021-12-30', value: 15000 }],
    trades: [
      { ticker: 'GALP', side: 'LONG', entryDate: '2020-03-01', entryPrice: 10.5, exitDate: '2020-04-01', exitPrice: 11.2, reason: 'Take Profit', profit: 700, profitPct: 6.7, mfePct: 8.1, maePct: -1.2, winRateMC: 68, mcTier: 'ELITE' },
      { ticker: 'EDP', side: 'LONG', entryDate: '2021-02-01', entryPrice: 4.2, exitDate: '2021-02-20', exitPrice: 4.0, reason: 'Stop Loss', profit: -200, profitPct: -4.8, mfePct: 1.1, maePct: -6.0, winRateMC: 55, mcTier: 'MODERATE' }
    ],
    meta: { universe: 3, blocks: 12 }
  };

  assert.ok(resultCb, 'onSimulationResult subscrito');
  resultCb({ runId: 'sim_ws_1', result: wsResult });

  // Card resumo visível + destaques
  assert.equal(elements.get('simulation-summary-card-container').classList.contains('hidden'), false);
  assert.match(elements.get('summary-gain').textContent, /132\.5/);
  assert.match(elements.get('summary-dd').textContent, /14\.3/);
  assert.match(elements.get('summary-sharpe').textContent, /1\.62/);

  // Modal ainda oculto até clique
  assert.equal(elements.get('modal-simulation-details').classList.contains('hidden'), true);
  listeners.get('btn-open-simulation-modal:click')[0]();
  assert.equal(elements.get('modal-simulation-details').classList.contains('hidden'), false);

  // Bloco A preenchido
  assert.match(elements.get('ws-kpis-bar').innerHTML, /Capital Final/);
  // Bloco B — anos presentes
  assert.match(elements.get('tbody-yearly').innerHTML, /2020/);
  assert.match(elements.get('tbody-yearly').innerHTML, /2021/);
  // Bloco C — tiers
  assert.match(elements.get('tbody-tiers').innerHTML, /Elite/);
  assert.match(elements.get('tbody-tiers').innerHTML, /Moderado/);
  // Bloco D — tail risk com VaR/CVaR e validação
  assert.match(elements.get('ws-tail-risk').innerHTML, /VaR 95%/);
  assert.match(elements.get('ws-tail-risk').innerHTML, /CVaR/);
  assert.match(elements.get('ws-tail-risk').innerHTML, /PBO/);
  // Bloco E — trade log com tickers
  assert.match(elements.get('tbody-trades-log').innerHTML, /GALP/);
  assert.match(elements.get('tbody-trades-log').innerHTML, /EDP/);
});
