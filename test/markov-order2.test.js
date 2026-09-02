'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { calculateMarkovMatrixOrder2, buildTransitionMatrixOrder2, buildStateSeries, getNumStates, analyzeSeries } = require('../src/quant/markovEngine');
const { runMarkovMonteCarloSimulation, buildStateReturnsMap } = require('../src/quant/monteCarloEngine');

// ═══════════════════════════════════════════════════════════
//  Fixtures: séries sintéticas diárias (YYYY-MM-DD)
// ═══════════════════════════════════════════════════════════
function dateAt(start, i) {
  return new Date(new Date(start + 'T00:00:00Z').getTime() + i * 86400000).toISOString().slice(0, 10);
}

function buildSeries(spec) {
  return spec.map((s) => ({
    date: s.date,
    open: s.open,
    high: s.high,
    low: s.low,
    close: s.close,
    volume: s.volume != null ? s.volume : 1000
  }));
}

// Tendência ascendente com ondulação (gera variedade de estados BB/ADX).
function trendingCandles(count = 400, startPrice = 100) {
  const spec = [];
  for (let i = 0; i < count; i++) {
    const close = startPrice * Math.pow(1.002, i) * (1 + 0.01 * Math.sin(i / 7));
    spec.push({ date: dateAt('2018-01-01', i), open: close, high: close * 1.004, low: close * 0.996, close, volume: 1000 });
  }
  return buildSeries(spec);
}

function matrixRowsSum(m2, stateSpace) {
  const N = getNumStates(stateSpace);
  const sums = new Set();
  for (let a = 0; a < N; a++) {
    for (let b = 0; b < N; b++) {
      const row = m2[a][b];
      assert.equal(row.length, N, 'linha de transição deve ter N estados');
      sums.add(row.reduce((s, v) => s + v, 0));
    }
  }
  return Array.from(sums);
}

// ═══════════════════════════════════════════════════════════
//  Passo 2 – calculateMarkovMatrixOrder2
// ═══════════════════════════════════════════════════════════
test('calculateMarkovMatrixOrder2 constrói matriz 3D com soma de probabilidades = 1 por par', () => {
  const candles = trendingCandles(400);
  const res = calculateMarkovMatrixOrder2(candles, { stateSpace: '9' });
  assert.equal(res.isValid, true);
  assert.equal(res.order, 2);
  assert.ok(res.currentState >= 0, 'currentState presente');
  assert.ok(res.prevState >= 0, 'prevState presente');
  assert.equal(res.transitionMatrix.length, 9);
  assert.equal(res.transitionMatrix[0].length, 9);
  assert.equal(res.transitionMatrix[0][0].length, 9);
  const sums = matrixRowsSum(res.transitionMatrix, '9');
  for (const s of sums) assert.ok(Math.abs(s - 1.0) < 1e-9, 'Σ_next = 1 (fallback incluído): ' + s);
  assert.ok(Array.isArray(res.stateReturns) && res.stateReturns.length === 9, 'stateReturns por estado');
});

test('calculateMarkovMatrixOrder2 ativa fallback de 1ª ordem sem erros para combinações raras', () => {
  // Série quase constante → poucos estados distintos → a maioria dos pares
  // (t-2, t-1) nunca ocorre. O fallback deve preencher todas as linhas.
  const spec = [];
  for (let i = 0; i < 300; i++) spec.push({ date: dateAt('2018-01-01', i), open: 100, high: 101, low: 99, close: 100, volume: 1000 });
  const candles = buildSeries(spec);
  const res = calculateMarkovMatrixOrder2(candles, { stateSpace: '6' });
  assert.equal(res.isValid, true, 'série plana ainda produz matriz válida');
  const sums = matrixRowsSum(res.transitionMatrix, '6');
  for (const s of sums) assert.ok(Math.abs(s - 1.0) < 1e-9, 'linha com fallback deve somar 1: ' + s);
});

test('calculateMarkovMatrixOrder2 respeita espaços de estado 3 e 6', () => {
  const candles = trendingCandles(400);
  for (const space of ['3', '6', '9']) {
    const res = calculateMarkovMatrixOrder2(candles, { stateSpace: space });
    const N = getNumStates(space);
    assert.equal(res.isValid, true, space);
    assert.equal(res.numStates, N, space);
    assert.equal(res.transitionMatrix.length, N, space);
    assert.equal(res.transitionMatrix[0][0].length, N, space);
    const sums = matrixRowsSum(res.transitionMatrix, space);
    for (const s of sums) assert.ok(Math.abs(s - 1.0) < 1e-9, space);
  }
});

// ═══════════════════════════════════════════════════════════
//  buildStateSeries / getNumStates
// ═══════════════════════════════════════════════════════════
test('buildStateSeries produz estados dentro de [0, numStates) para cada espaço', () => {
  const n = 200;
  const bbPct = Array.from({ length: n }, (_, i) => (((i % 25) / 24)));
  const rsi = Array.from({ length: n }, (_, i) => 30 + (i % 40));
  const adx = Array.from({ length: n }, (_, i) => (i % 20) * 4);
  for (const space of ['3', '6', '9']) {
    const N = getNumStates(space);
    const states = buildStateSeries(bbPct, rsi, adx, space);
    assert.equal(states.length, n, space);
    for (const s of states) {
      assert.ok(s >= 0 && s < N, `estado ${s} fora de [0,${N}) no espaço ${space}`);
    }
  }
});

// ═══════════════════════════════════════════════════════════
//  analyzeSeries com markovOrder 2
// ═══════════════════════════════════════════════════════════
test('analyzeSeries com markovOrder=2 devolve matriz 3D + prevState + order', () => {
  const candles = trendingCandles(300);
  const res = analyzeSeries(candles, { markovOrder: 2, useVolFilter: false, rvolMin: 0 });
  assert.equal(res.order, 2);
  assert.ok(res.prevState >= 0, 'prevState exposto');
  assert.equal(res.transitionMatrix.length, 9);
  assert.equal(res.transitionMatrix[0][0].length, 9);
  // Retrocompatibilidade: 1ª ordem continua em 2D.
  const res1 = analyzeSeries(candles, { markovOrder: 1, useVolFilter: false, rvolMin: 0 });
  assert.equal(res1.order, 1);
  assert.equal(res1.transitionMatrix.length, 9);
  assert.equal(typeof res1.transitionMatrix[0][0], 'number');
});

// ═══════════════════════════════════════════════════════════
//  Monte Carlo de 2ª ordem (determinístico)
// ═══════════════════════════════════════════════════════════
test('Monte Carlo de 2ª ordem corre sem erro e devolve winRate', () => {
  const candles = trendingCandles(400);
  const m = calculateMarkovMatrixOrder2(candles, { stateSpace: '9' });
  const mc = runMarkovMonteCarloSimulation(
    m.transitionMatrix,
    m.currentState,
    candles,
    candles[candles.length - 1].close,
    {
      slPct: 0.024, tpPct: 0.048, side: 'LONG',
      order: 2, prevState: m.prevState, stateSpace: '9',
      random: () => 0.3
    }
  );
  assert.ok(Number.isFinite(mc.winRate), `winRate=${mc.winRate}`);
  assert.equal(mc.mcTier.length > 0, true);
  assert.equal(typeof mc.mcTier, 'string');
});

test('Monte Carlo de 2ª ordem respeita espaço 3 e 6', () => {
  const candles = trendingCandles(400);
  for (const space of ['3', '6']) {
    const m = calculateMarkovMatrixOrder2(candles, { stateSpace: space });
    const mc = runMarkovMonteCarloSimulation(
      m.transitionMatrix, m.currentState, candles, candles[candles.length - 1].close,
      { slPct: 0.024, tpPct: 0.048, side: 'SHORT', order: 2, prevState: m.prevState, stateSpace: space, random: () => 0.4 }
    );
    assert.ok(Number.isFinite(mc.winRate), space);
  }
});

// ═══════════════════════════════════════════════════════════
//  buildStateReturnsMap por espaço
// ═══════════════════════════════════════════════════════════
test('buildStateReturnsMap dimensiona retornos pelo espaço de estado', () => {
  const candles = trendingCandles(300);
  assert.equal(buildStateReturnsMap(candles, '3').length, 3);
  assert.equal(buildStateReturnsMap(candles, '6').length, 6);
  assert.equal(buildStateReturnsMap(candles, '9').length, 9);
  assert.equal(buildStateReturnsMap(candles).length, 9, 'default = 9 estados');
});

// ═══════════════════════════════════════════════════════════
//  Integração: runSimulation com markovOrder 2 + meta
// ═══════════════════════════════════════════════════════════
test('runSimulation com markovOrder=2 processa histórico e expõe meta', async () => {
  const { runSimulation } = require('../src/engine/backtesterEngine');
  const candles = trendingCandles(500);
  const result = await runSimulation({
    universe: [{ ticker: 'TEST', name: 'Teste', candles }],
    params: {
      direction: 'both', exitMode: 'full', stopType: 'pct', stopLoss: 1.4, takeProfit: 2.8,
      trailingStop: false, trailingOffsetPct: 0, vwapGate: false, rvolGate: false,
      mcMin: 0, markovMin: 0, startDate: '', endDate: '', initialCapital: 10000,
      riskPerTradePct: 2, commissionPct: 0, slippagePct: 0, warmup: 200, markovWindow: 150,
      horizonDays: 5,
      markovOrder: 2, stateSpace: '9'
    },
    hooks: {}
  });
  assert.equal(result.ok, true);
  assert.equal(result.meta.markovOrder, 2);
  assert.equal(result.meta.stateSpace, '9');
  assert.equal(result.meta.numStates, 9);
  assert.ok(Array.isArray(result.equityCurve), 'curva de capital gerada');
});

test('runSimulation compara 1ª e 2ª ordem (meta diferente e KPIs calculáveis)', async () => {
  const { runSimulation } = require('../src/engine/backtesterEngine');
  const candles = trendingCandles(600);
  const baseParams = {
    direction: 'both', exitMode: 'full', stopType: 'pct', stopLoss: 1.4, takeProfit: 2.8,
    trailingStop: false, trailingOffsetPct: 0, vwapGate: false, rvolGate: false,
    mcMin: 0, markovMin: 0, startDate: '', endDate: '', initialCapital: 10000,
    riskPerTradePct: 2, commissionPct: 0, slippagePct: 0, warmup: 200, markovWindow: 150, horizonDays: 5
  };
  const order1 = await runSimulation({ universe: [{ ticker: 'A', name: 'Ativo', candles }], params: { ...baseParams, markovOrder: 1 }, hooks: {} });
  const order2 = await runSimulation({ universe: [{ ticker: 'A', name: 'Ativo', candles }], params: { ...baseParams, markovOrder: 2 }, hooks: {} });

  assert.equal(order1.ok, true);
  assert.equal(order2.ok, true);
  assert.equal(order1.meta.markovOrder, 1);
  assert.equal(order2.meta.markovOrder, 2);
  assert.ok(order2.equityCurve.length > 0, 'ordem 2 gera curva de capital');
  // Ambas devem produzir KPIs plausíveis para comparação direta no dashboard.
  for (const r of [order1, order2]) {
    assert.ok(typeof r.kpis.winRate === 'number');
    assert.ok(typeof r.kpis.profitFactor === 'number' || r.kpis.profitFactor == null);
    assert.ok(Number.isFinite(r.kpis.maxDrawdownPct));
  }
});
