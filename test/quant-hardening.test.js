'use strict';

// ═══════════════════════════════════════════════════════════
//  test/quant-hardening.test.js
//
//  Regressões de segurança numérica / DoS de cálculo do relatório
//  reports/perfsec-quant.md:
//    C1  caps de iterations/daysAhead no Monte Carlo
//    C2  cap de horizonDays no forecast de Markov
//    A2  sanitização de períodos/stops/bbMult
//    A3  caps em mcIterations/horizonDays no workstationEngine
//    A4  stddev estável (dois passos)
//    A5  sma/ema não concatenam strings
//    A6  entradas não-array/NaN não lançam nem contaminam
//    M1  entrySignal rejeita winRate não finito
//    M2  buildStateSeries ignora NaN
//    M3  graham.resolveSnapshot sem lookahead futuro
//    M8  Sortino com denominador sobre n total
//    C3  DSR com a mesma frequência (sem saturação)
//    C4  PBO null (não fabricado) e gate documentado
// ═══════════════════════════════════════════════════════════

const { test } = require('node:test');
const assert = require('node:assert/strict');

const indicators = require('../src/quant/indicators');
const { analyzeSeries, buildStateSeries } = require('../src/quant/markovEngine');
const { runMarkovMonteCarloSimulation } = require('../src/quant/monteCarloEngine');
const metrics = require('../src/quant/workstation/metrics');
const validation = require('../src/quant/workstation/validation');
const graham = require('../src/quant/workstation/graham');
const { runWorkstationSimulation, MC_ITERATIONS } = require('../src/engine/workstationEngine');

// ── Fixtures determinísticas ────────────────────────────────
function dateAt(start, i) {
  return new Date(new Date(start + 'T00:00:00Z').getTime() + i * 86400000).toISOString().slice(0, 10);
}

function trendingCandles(count = 300, startPrice = 100) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const close = startPrice * Math.pow(1.002, i) * (1 + 0.01 * Math.sin(i / 7));
    out.push({ date: dateAt('2018-01-01', i), open: close, high: close * 1.004, low: close * 0.996, close, volume: 1000 });
  }
  return out;
}

function centeredNoise(n) {
  let s = 12345 >>> 0;
  const raw = [];
  for (let i = 0; i < n; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    raw.push(s / 4294967296 - 0.5);
  }
  const m = raw.reduce((a, b) => a + b, 0) / raw.length;
  return raw.map(x => x - m);
}

// ═══════════════════════════════════════════════════════════
//  C1 — caps de iterations/daysAhead no Monte Carlo
// ═══════════════════════════════════════════════════════════
test('C1: Monte Carlo rejeita Infinity/não-finitos e limita a 1e6 iterações', () => {
  const candles = trendingCandles(300);
  const analysis = analyzeSeries(candles, { useVolFilter: false, rvolMin: 0 });
  const state = analysis.currentState >= 0 ? analysis.currentState : 0;
  const price = candles[candles.length - 1].close;
  const run = (opts) => runMarkovMonteCarloSimulation(analysis.transitionMatrix, state, candles, price, opts);

  // Infinity → default MC_ITERATIONS (1000), não infinito.
  const inf = run({ iterations: Infinity, daysAhead: 1, random: () => 0.5 });
  assert.equal(inf.tpHits + inf.slHits + inf.expired, 1000);
  assert.ok(Number.isFinite(inf.winRate));

  // 2e6 → cap duro de 1e6.
  const capped = run({ iterations: 2_000_000, daysAhead: 1, random: () => 0.99 });
  assert.equal(capped.tpHits + capped.slHits + capped.expired, 1_000_000);

  // daysAhead Infinity → default (35) e termina.
  const days = run({ iterations: 100, daysAhead: Infinity, random: () => 0.5 });
  assert.equal(days.tpHits + days.slHits + days.expired, 100);
  assert.ok(Number.isFinite(days.winRate));
});

test('C1: Monte Carlo com candles não-array devolve estrutura vazia sem lançar', () => {
  const mc = runMarkovMonteCarloSimulation([[1]], 0, null, 100, {});
  assert.equal(mc.winRate, 0);
  assert.equal(mc.isApproved, false);
  assert.equal(mc.mcTier, 'REJECTED');
  assert.equal(mc.expired, 1000);
});

// ═══════════════════════════════════════════════════════════
//  C2 — cap de horizonDays
// ═══════════════════════════════════════════════════════════
test('C2: horizonDays é limitado a 504 e Infinity cai no default HORIZON', () => {
  const candles = trendingCandles(300);
  const big = analyzeSeries(candles, { horizonDays: 1e9, useVolFilter: false, rvolMin: 0 });
  const max = analyzeSeries(candles, { horizonDays: 504, useVolFilter: false, rvolMin: 0 });
  assert.equal(big.pBull, max.pBull);
  assert.equal(big.pBear, max.pBear);

  const inf = analyzeSeries(candles, { horizonDays: Infinity, useVolFilter: false, rvolMin: 0 });
  const def = analyzeSeries(candles, { useVolFilter: false, rvolMin: 0 });
  assert.equal(inf.pBull, def.pBull);
  assert.equal(inf.pBear, def.pBear);
});

// ═══════════════════════════════════════════════════════════
//  A2 — períodos/stops/bbMult sanitizados
// ═══════════════════════════════════════════════════════════
test('A2: períodos inválidos são clampados a [1, n] sem propagar NaN', () => {
  const candles = trendingCandles(300);
  const base = { useVolFilter: false, rvolMin: 0 };

  const rsiZero = analyzeSeries(candles, { ...base, rsiPeriod: 0 });
  const rsiOne = analyzeSeries(candles, { ...base, rsiPeriod: 1 });
  assert.equal(rsiZero.rsi, rsiOne.rsi);

  const rsiNeg = analyzeSeries(candles, { ...base, rsiPeriod: -5 });
  assert.equal(rsiNeg.rsi, rsiOne.rsi);

  const adxZero = analyzeSeries(candles, { ...base, adxPeriod: 0 });
  const adxOne = analyzeSeries(candles, { ...base, adxPeriod: 1 });
  assert.equal(adxZero.adx, adxOne.adx);

  const bbHuge = analyzeSeries(candles, { ...base, bbPeriod: 1e9 });
  const bbMax = analyzeSeries(candles, { ...base, bbPeriod: candles.length });
  assert.equal(bbHuge.bbPct, bbMax.bbPct);
});

test('A2: slPct/tpPct fora de (0,1] e bbMult <= 0 caem no default', () => {
  const candles = trendingCandles(300);
  const base = { useVolFilter: false, rvolMin: 0 };
  const def = analyzeSeries(candles, base);

  const negMult = analyzeSeries(candles, { ...base, bbMult: -2 });
  assert.equal(negMult.bbPct, def.bbPct);

  const badStops = analyzeSeries(candles, { ...base, slPct: 0, tpPct: 99 });
  assert.equal(badStops.stopLoss, def.stopLoss);
  assert.equal(badStops.takeProfit, def.takeProfit);
});

// ═══════════════════════════════════════════════════════════
//  A3 — caps no workstationEngine
// ═══════════════════════════════════════════════════════════
test('A3: workstationEngine não deixa Infinity sobreviver a mcIterations/horizonDays', async () => {
  const candles = trendingCandles(600, 50);
  const r = await runWorkstationSimulation({
    universe: [{ ticker: 'TEST', name: 'Teste', candles }],
    params: {
      horizonYears: 20, endDate: '2026-01-01', rebalanceDays: 35,
      maxPositions: 3, warmup: 500, mcIterations: Infinity, horizonDays: Infinity
    }
  });
  assert.equal(r.ok, true);
  assert.ok(Number.isFinite(r.meta.mcIterations));
  assert.equal(r.meta.mcIterations, MC_ITERATIONS);
  assert.equal(r.validation.pbo, null);
});

// ═══════════════════════════════════════════════════════════
//  A4 — stddev estável (dois passos)
// ═══════════════════════════════════════════════════════════
test('A4: stddev é estável em valores ~1e8 com variância pequena', () => {
  const base = 1e8;
  const vals = Array.from({ length: 90 }, (_, i) => base + (i % 2 ? 1 : -1));
  const sd = indicators.stddev(vals, 30);
  assert.ok(Math.abs(sd[45] - 1) < 1e-9, `stddev=${sd[45]} (esperado 1)`);

  const bb = indicators.bollingerBands(vals, 30, 2);
  assert.ok(Math.abs((bb.upper[45] - bb.lower[45]) / 4 - 1) < 1e-9, 'bandas BB devem refletir σ=1');
});

// ═══════════════════════════════════════════════════════════
//  A5 — sma/ema coercão de strings
// ═══════════════════════════════════════════════════════════
test('A5: sma/ema não concatenam strings numéricas', () => {
  assert.deepEqual(indicators.sma(['100', '100', '100'], 2), [null, 100, 100]);
  assert.deepEqual(indicators.sma([100, '100', 100], 3), [null, null, 100]);
  assert.deepEqual(indicators.ema(['10', '20', '30'], 3), [null, null, 20]);
});

// ═══════════════════════════════════════════════════════════
//  A6 — entradas não-array, velas inválidas e mesma série no MC
// ═══════════════════════════════════════════════════════════
test('A6: analyzeSeries devolve estrutura vazia para entradas não-array', () => {
  for (const bad of [null, undefined, {}, 'x', 42]) {
    const r = analyzeSeries(bad, {});
    assert.equal(r.direction, 'NEUTRO');
    assert.equal(r.currentState, -1);
    assert.equal(r.transitionMatrix, null);
  }
});

test('A6: analyzeSeries ignora velas sem close finito', () => {
  const candles = trendingCandles(300);
  const withNulls = candles.map((c, i) => (i % 5 === 0 ? { ...c, close: null } : c));
  const r = analyzeSeries(withNulls, { useVolFilter: false, rvolMin: 0 });
  assert.ok(Number.isFinite(r.close));
  assert.ok(Number.isFinite(r.rsi));
  assert.ok(Number.isFinite(r.bbPct));
});

test('A6: MC usa a mesma série filtrada (velas com close null são descartadas)', () => {
  const candles = trendingCandles(300);
  const withNulls = candles.map((c, i) => (i % 5 === 0 ? { ...c, close: null } : c));
  const filtered = candles.filter((c, i) => i % 5 !== 0);
  const analysis = analyzeSeries(withNulls, { useVolFilter: false, rvolMin: 0 });
  const price = analysis.close;
  const opts = { iterations: 200, daysAhead: 10, slPct: 0.024, tpPct: 0.048, side: 'LONG', seed: 7 };

  const a = runMarkovMonteCarloSimulation(analysis.transitionMatrix, analysis.currentState, withNulls, price, opts);
  const b = runMarkovMonteCarloSimulation(analysis.transitionMatrix, analysis.currentState, filtered, price, opts);
  assert.deepEqual(a, b);
});

test('M2: buildStateSeries ignora NaN (não classifica como neutro)', () => {
  const states = buildStateSeries([NaN, 0.5, 0.1], [50, 50, 50], [30, 30, NaN], '9');
  assert.equal(states[0], -1, 'bbPct NaN → inválido');
  assert.equal(states[2], -1, 'adx NaN → inválido');
  assert.equal(states[1], 4, 'bb médio + adx moderado → estado 4');
});

// ═══════════════════════════════════════════════════════════
//  M1 — entrySignal rejeita winRate não finito
// ═══════════════════════════════════════════════════════════
test('M1: entrySignal rejeita winRate não finito', { concurrency: false }, () => {
  const markovPath = require.resolve('../src/quant/markovEngine');
  const mcPath = require.resolve('../src/quant/monteCarloEngine');
  const esPath = require.resolve('../src/quant/workstation/entrySignal');
  const savedMarkov = require.cache[markovPath];
  const savedMc = require.cache[mcPath];
  const savedEs = require.cache[esPath];

  const analyzeStub = () => ({
    close: 100, direction: 'COMPRA', pBull: 0.9, pBear: 0.1, pStay: 0.0,
    rollingVwap20: 90, rvolApproved: true, atr: 2, currentState: 0, prevState: 0,
    transitionMatrix: Array.from({ length: 3 }, () => [0.34, 0.33, 0.33])
  });
  const candles = trendingCandles(120);
  const asset = { ticker: 'TEST', candles, sentiment: candles.map(() => 0) };
  const cfg = {
    markovWindow: 150, useVolFilter: false, horizonDays: 5, rvolMin: 1,
    markovOrder: 1, stateSpace: '9', direction: 'both', markovMinPct: 55,
    vwapGate: true, rvolGate: true, ffdGate: false, sentimentGate: false, grahamGate: false,
    stopType: 'pct', stopLoss: 2.4, takeProfit: 4.8, mcIterations: 1000,
    rebalanceDays: 35, minWinRateMC: 50, mcSeed: 42
  };

  const load = (mcStub) => {
    delete require.cache[esPath];
    require.cache[markovPath] = { id: markovPath, filename: markovPath, loaded: true, exports: { analyzeSeries: analyzeStub } };
    require.cache[mcPath] = { id: mcPath, filename: mcPath, loaded: true, exports: { runMarkovMonteCarloSimulation: mcStub } };
    return require(esPath);
  };

  try {
    const bad = load(() => ({ winRate: NaN, mcTier: 'ELITE' }));
    assert.equal(bad.evaluateEntrySignal(asset, 100, cfg, null), null, 'NaN não pode passar o gate');

    const missing = load(() => ({ mcTier: 'ELITE' }));
    assert.equal(missing.evaluateEntrySignal(asset, 100, cfg, null), null, 'winRate ausente não pode passar');

    const zero = load(() => ({ winRate: 0, mcTier: 'REJECTED' }));
    assert.equal(zero.evaluateEntrySignal(asset, 100, cfg, null), null, 'winRate abaixo do mínimo não pode passar');

    const good = load(() => ({ winRate: 80, mcTier: 'ELITE' }));
    const sig = good.evaluateEntrySignal(asset, 100, cfg, null);
    assert.ok(sig && sig.winRateMC === 80);
  } finally {
    delete require.cache[esPath];
    if (savedMarkov) require.cache[markovPath] = savedMarkov; else delete require.cache[markovPath];
    if (savedMc) require.cache[mcPath] = savedMc; else delete require.cache[mcPath];
    if (savedEs) require.cache[esPath] = savedEs;
  }
});

// ═══════════════════════════════════════════════════════════
//  M3 — graham.resolveSnapshot sem lookahead futuro
// ═══════════════════════════════════════════════════════════
test('M3: resolveSnapshot devolve null quando não há snapshot <= year', () => {
  const history = [
    { year: 2015, currentRatio: 2.0 },
    { year: 2018, currentRatio: 1.8 }
  ];
  assert.equal(graham.resolveSnapshot(history, 2010), null);
  assert.equal(graham.resolveSnapshot(history, 2016).year, 2015);
  assert.equal(graham.resolveSnapshot(history, 2018).year, 2018);
  assert.equal(graham.resolveSnapshot([], 2010), null);
  assert.equal(graham.resolveSnapshot(null, 2010), null);
});

// ═══════════════════════════════════════════════════════════
//  M8 — Sortino com denominador sobre n total
// ═══════════════════════════════════════════════════════════
test('M8: sortinoRatio divide o downside deviation pelo n total', () => {
  const r = [0.02, -0.01, -0.01, 0.01];
  const mean = 0.0025;
  const expected = (mean / Math.sqrt(2e-4 / 4)) * Math.sqrt(252);
  assert.ok(Math.abs(metrics.sortinoRatio(r) - expected) < 1e-9,
    `sortino=${metrics.sortinoRatio(r)} esperado=${expected}`);
  // Fórmula antiga (apenas negativos) subestimava o downside → Sortino menor.
  const old = (mean / Math.sqrt(1e-4)) * Math.sqrt(252);
  assert.ok(metrics.sortinoRatio(r) > old);
});

// ═══════════════════════════════════════════════════════════
//  C3/C4 — DSR com frequência consistente; PBO não fabricado
// ═══════════════════════════════════════════════════════════
test('C3: DSR de ruído centrado não satura e desaprova', () => {
  const noise = centeredNoise(800);
  const report = validation.validateStrategy(noise, { nGroups: 5, kTestGroups: 2, nTrials: 10 });
  assert.ok(report.valid);
  assert.ok(Math.abs(report.sharpeOOS) < 0.5, `sharpeOOS=${report.sharpeOOS} (esperado ≈ 0)`);
  assert.ok(report.dsr < 0.5, `dsr=${report.dsr} (esperado baixo para ruído)`);
  assert.equal(report.isApproved, false);
});

test('C4: PBO é null (não fabricado) e não bloqueia aprovação via DSR', () => {
  const noise = centeredNoise(800);
  const noiseReport = validation.validateStrategy(noise, { nGroups: 5, kTestGroups: 2, nTrials: 10 });
  assert.equal(noiseReport.pbo, null);
  assert.equal(noiseReport.pboPercent, null);

  const small = validation.validateStrategy([0.01, -0.01, 0.02], {});
  assert.equal(small.pbo, null);
  assert.equal(small.isApproved, false);

  // Série com drift forte: DSR alto aprova mesmo sem PBO estimável
  // (o gate PBO só se aplica quando é calculável — documentado).
  let s = 999 >>> 0;
  const drift = [];
  for (let i = 0; i < 800; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    drift.push(0.001 + (s / 4294967296 - 0.5) * 0.004);
  }
  const driftReport = validation.validateStrategy(drift, { nGroups: 5, kTestGroups: 2, nTrials: 10 });
  assert.equal(driftReport.pbo, null);
  assert.ok(driftReport.dsr > 0.95, `dsr=${driftReport.dsr}`);
  assert.equal(driftReport.isApproved, true);
});
