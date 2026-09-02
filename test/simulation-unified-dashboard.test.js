'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

test('Simulation Unified Dashboard & Modal UI contract in HTML', () => {
  const html = fs.readFileSync(require.resolve('../renderer/index.html'), 'utf8');

  // 1. Dashboard de Configuração Unificado
  const expectedDashboardIds = [
    'sim-asset-universe',
    'sim-direction',
    'sim-stop-loss',
    'sim-take-profit',
    'sim-risk-per-trade',
    'sim-toggle-vwap',
    'sim-min-mc',
    'sim-markov-window',
    'sim-start-date',
    'sim-end-date',
    'sim-initial-capital',
    'btn-start-simulation',
    'btn-reset-params'
  ];

  for (const id of expectedDashboardIds) {
    assert.match(html, new RegExp(`id=["']${id}["']`), `HTML deve conter o elemento com id "${id}"`);
  }

  // 2. Card Único de Resumo
  const expectedSummaryCardIds = [
    'simulation-summary-card-container',
    'btn-open-simulation-modal',
    'summary-card-title',
    'summary-card-dates',
    'summary-gain',
    'summary-winrate',
    'summary-pf',
    'summary-dd'
  ];

  for (const id of expectedSummaryCardIds) {
    assert.match(html, new RegExp(`id=["']${id}["']`), `HTML deve conter o elemento do card de resumo com id "${id}"`);
  }

  // 3. Modal Pop-up Detalhado
  const expectedModalIds = [
    'modal-simulation-details',
    'modal-sim-subtitle',
    'btn-close-sim-modal',
    'modal-final-capital',
    'modal-total-trades',
    'modal-winning-trades',
    'modal-expected-value',
    'canvas-equity-curve',
    'canvas-drawdown-curve',
    'table-trades-log',
    'tbody-trades-log'
  ];

  for (const id of expectedModalIds) {
    assert.match(html, new RegExp(`id=["']${id}["']`), `HTML deve conter o elemento do modal detalhado com id "${id}"`);
  }
});

test('Simulation Unified Dashboard & Modal logic lifecycle in simulationRenderer.js', () => {
  const elements = new Map();
  const listeners = new Map();

  function makeMockElement(id) {
    const classListSet = new Set();
    return {
      id,
      value: '',
      checked: false,
      textContent: '',
      innerHTML: '',
      hidden: false,
      style: {},
      classList: {
        add(cls) { classListSet.add(cls); },
        remove(cls) { classListSet.delete(cls); },
        toggle(cls) { if (classListSet.has(cls)) classListSet.delete(cls); else classListSet.add(cls); },
        contains(cls) { return classListSet.has(cls); }
      },
      addEventListener(evt, handler) {
        if (!listeners.has(`${id}:${evt}`)) listeners.set(`${id}:${evt}`, []);
        listeners.get(`${id}:${evt}`).push(handler);
      },
      getContext() {
        return {
          clearRect() {},
          beginPath() {},
          moveTo() {},
          lineTo() {},
          stroke() {},
          fill() {},
          arc() {}
        };
      }
    };
  }

  const idsToMock = [
    'sim-asset-universe', 'sim-direction', 'sim-stop-loss', 'sim-take-profit',
    'sim-risk-per-trade', 'sim-toggle-vwap', 'sim-min-mc', 'sim-markov-window',
    'sim-start-date', 'sim-end-date', 'sim-initial-capital',
    'btn-start-simulation', 'btn-reset-params', 'btn-sim-cancel',
    'sim-progress-wrap', 'sim-progress-fill', 'sim-progress-text', 'sim-status',
    'simulation-summary-card-container', 'btn-open-simulation-modal',
    'summary-card-title', 'summary-card-dates', 'summary-gain', 'summary-winrate',
    'summary-pf', 'summary-dd',
    'modal-simulation-details', 'modal-sim-subtitle', 'btn-close-sim-modal',
    'modal-final-capital', 'modal-total-trades', 'modal-winning-trades',
    'modal-expected-value', 'canvas-equity-curve', 'canvas-drawdown-curve',
    'table-trades-log', 'tbody-trades-log'
  ];

  for (const id of idsToMock) {
    elements.set(id, makeMockElement(id));
  }

  // Pre-hide container and modal as in production
  elements.get('simulation-summary-card-container').classList.add('hidden');
  elements.get('modal-simulation-details').classList.add('hidden');

  global.document = {
    readyState: 'complete',
    getElementById(id) {
      return elements.get(id) || null;
    },
    querySelectorAll() { return []; },
    addEventListener() {},
    removeEventListener() {}
  };

  let registeredResultCb = null;
  global.window = {
    addEventListener() {},
    removeEventListener() {},
    api: {
      simulationStart: async () => ({ ok: true, runId: 'sim_run_999' }),
      simulationCancel: async () => ({ ok: true }),
      onSimulationProgress() { return () => {}; },
      onSimulationResult(cb) { registeredResultCb = cb; return () => {}; },
      onSimulationComplete(cb) { registeredResultCb = cb; return () => {}; },
      onSimulationError() { return () => {}; }
    }
  };

  delete require.cache[require.resolve('../src/renderer/js/simulationRenderer')];
  require('../src/renderer/js/simulationRenderer');

  // 1. Simulação Concluída emite resultado
  const mockResult = {
    totalGain: 18.5,
    winRate: 64,
    profitFactor: 2.15,
    maxDrawdown: 4.8,
    finalCapital: 11850,
    winningTradesCount: 16,
    expectedValue: 1.15,
    equityCurve: [
      { date: '2023-01-01', capital: 10000 },
      { date: '2023-06-01', capital: 11000 },
      { date: '2023-12-31', capital: 11850 }
    ],
    drawdownCurve: [
      { date: '2023-01-01', drawdown: 0 },
      { date: '2023-06-01', drawdown: 2.1 },
      { date: '2023-12-31', drawdown: 0.5 }
    ],
    trades: [
      { ticker: 'GALP.LS', type: 'LONG', entryDate: '2023-01-10', entryPrice: 10.5, exitDate: '2023-01-20', exitPrice: 11.2, exitReason: 'TP', profit: 700, profitPct: 6.67 },
      { ticker: 'EDP.LS', type: 'LONG', entryDate: '2023-02-05', entryPrice: 4.2, exitDate: '2023-02-15', exitPrice: 4.0, exitReason: 'SL', profit: -200, profitPct: -4.76 }
    ]
  };

  assert.ok(registeredResultCb, 'onSimulationComplete deve estar subscrito');
  registeredResultCb(mockResult);

  // 2. Card Resumo Único deve estar visível e preenchido
  const summaryContainer = elements.get('simulation-summary-card-container');
  assert.equal(summaryContainer.classList.contains('hidden'), false, 'Card Resumo deve estar visível');
  assert.equal(elements.get('summary-gain').textContent, '+18.5%');
  assert.equal(elements.get('summary-winrate').textContent, '64%');
  assert.equal(elements.get('summary-pf').textContent, '2.15');
  assert.equal(elements.get('summary-dd').textContent, '4.80%');

  // Modal detalhado ainda oculto antes do clique
  const modal = elements.get('modal-simulation-details');
  assert.equal(modal.classList.contains('hidden'), true, 'Modal deve estar oculto até ser clicado');

  // 3. Clique no Card Resumo abre o Modal Detalhado
  const openHandlers = listeners.get('btn-open-simulation-modal:click') || [];
  assert.ok(openHandlers.length > 0, 'Deve existir listener para abrir o modal no card resumo');
  openHandlers[0]();

  assert.equal(modal.classList.contains('hidden'), false, 'Modal deve abrir ao clicar no card resumo');
  assert.equal(elements.get('modal-total-trades').textContent, '2');
  assert.equal(elements.get('modal-winning-trades').textContent, '16 (64%)');
  assert.equal(elements.get('modal-expected-value').textContent, '+1.15% / trade');
  assert.match(elements.get('tbody-trades-log').innerHTML, /GALP\.LS/);
  assert.match(elements.get('tbody-trades-log').innerHTML, /EDP\.LS/);

  // 4. Fecho do Modal
  const closeHandlers = listeners.get('btn-close-sim-modal:click') || [];
  assert.ok(closeHandlers.length > 0, 'Deve existir listener no botão fechar modal');
  closeHandlers[0]();

  assert.equal(modal.classList.contains('hidden'), true, 'Modal deve fechar');
  assert.equal(summaryContainer.classList.contains('hidden'), false, 'Card resumo permanece preservado em memória');

  // 5. Botão Restaurar Padrões
  const resetHandlers = listeners.get('btn-reset-params:click') || [];
  assert.ok(resetHandlers.length > 0, 'Deve existir listener no botão restaurar padrões');
  elements.get('sim-stop-loss').value = '5.0';
  elements.get('sim-take-profit').value = '10.0';
  resetHandlers[0]();
  assert.equal(elements.get('sim-stop-loss').value, '2.4', 'Restaurar padrões deve repor SL para 2.4');
  assert.equal(elements.get('sim-take-profit').value, '4.8', 'Restaurar padrões deve repor TP para 4.8');
});
