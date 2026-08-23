'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

test('Simulation UI Renderer: blindagem contra ausência de DOM e restauração de estado', () => {
  // Mock do ambiente DOM
  const elements = new Map();

  global.document = {
    readyState: 'complete',
    getElementById(id) {
      return elements.get(id) || null;
    },
    querySelectorAll(selector) {
      return [];
    },
    createElement(tag) {
      return {
        className: '',
        innerHTML: '',
        textContent: '',
        style: {},
        classList: { add() {}, remove() {}, toggle() {} },
        appendChild() {},
        remove() {}
      };
    },
    addEventListener() {},
    removeEventListener() {}
  };

  global.window = {
    devicePixelRatio: 1,
    addEventListener() {},
    removeEventListener() {},
    requestAnimationFrame(cb) { return setTimeout(cb, 0); },
    cancelAnimationFrame(id) { clearTimeout(id); },
    api: {
      simulationOptions: async () => ({ ok: true, indices: [], assets: [] }),
      simulationStart: async () => ({ ok: true, runId: 'sim_test_123' }),
      simulationCancel: async () => ({ ok: true }),
      onSimulationProgress(cb) { global._progressCb = cb; return () => {}; },
      onSimulationResult(cb) { global._resultCb = cb; return () => {}; },
      onSimulationError(cb) { global._errorCb = cb; return () => {}; }
    }
  };

  // Carregar o script do renderer
  delete require.cache[require.resolve('../src/renderer/js/simulationRenderer')];
  require('../src/renderer/js/simulationRenderer');

  assert.ok(global.window.simulationState, 'simulationState deve estar exposto globalmente');
  assert.equal(typeof global.window.restoreSimulationViewState, 'function', 'restoreSimulationViewState deve ser função');

  // 1. Simular envio de evento de progresso sem elementos no DOM (ex: outra aba ativa)
  assert.doesNotThrow(() => {
    global._progressCb({
      runId: 'sim_test_123',
      current: 10,
      total: 50,
      ticker: 'TEST.LS',
      percent: 20
    });
  }, 'onProgress não pode falhar mesmo sem elementos no DOM');

  assert.equal(global.window.simulationState.isRunning, true);
  assert.equal(global.window.simulationState.progress, 20);
  assert.equal(global.window.simulationState.currentTicker, 'TEST.LS');
  assert.equal(global.window.simulationState.completedTickers, 10);
  assert.equal(global.window.simulationState.totalTickers, 50);

  // 2. Montar elementos simulados no DOM (como se o utilizador abrisse a aba)
  const mockProgressBar = { style: { width: '0%' } };
  const mockProgressText = { textContent: '' };
  const mockStatus = { textContent: '', hidden: true };
  const mockTab = { classList: { contains: (cls) => cls === 'active' }, offsetParent: {} };

  elements.set('simulation-progress-bar', mockProgressBar);
  elements.set('simulation-progress-text', mockProgressText);
  elements.set('sim-status', mockStatus);
  elements.set('tab-simulation', mockTab);

  // 3. Chamar restoreSimulationViewState()
  global.window.restoreSimulationViewState();

  assert.equal(mockProgressBar.style.width, '20%');
  assert.ok(mockProgressText.textContent.includes('20%'));
  assert.ok(mockProgressText.textContent.includes('TEST.LS'));

  // 4. Simular conclusão com resultado enquanto noutra aba
  elements.clear(); // desmonta elementos novamente
  const mockResult = {
    ok: true,
    kpis: { netProfit: 1500, winRate: 65 },
    trades: [{ ticker: 'TEST.LS', profit: 500 }],
    equityCurve: [{ date: '2023-01-01', value: 10000 }]
  };

  assert.doesNotThrow(() => {
    global._resultCb({ runId: 'sim_test_123', result: mockResult });
  }, 'onResult não pode falhar mesmo sem elementos no DOM');

  assert.equal(global.window.simulationState.isRunning, false);
  assert.equal(global.window.simulationState.results, mockResult);

  // 5. Utilizador regressa à aba Simulação:
  const mockTradesBody = { innerHTML: '', appendChild() {} };
  const mockResultsSection = { hidden: true };
  elements.set('sim-trades-body', mockTradesBody);
  elements.set('sim-results', mockResultsSection);
  elements.set('tab-simulation', mockTab);

  assert.doesNotThrow(() => {
    global.window.restoreSimulationViewState();
  }, 'restoreSimulationViewState deve restaurar os resultados salvos sem erro');

  assert.equal(mockResultsSection.hidden, false);
});
