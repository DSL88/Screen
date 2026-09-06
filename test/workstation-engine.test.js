'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const metrics = require('../src/quant/workstation/metrics');
const validation = require('../src/quant/workstation/validation');
const graham = require('../src/quant/workstation/graham');
const fracdiff = require('../src/quant/workstation/fracdiff');
const purif = require('../src/quant/workstation/factorPurification');
const { runWorkstationSimulation, resolveDates } = require('../src/engine/workstationEngine');

// ── Gerador determinístico de candles ─────────────────────
function makeCandles(seed, n, startYear) {
  let s = seed >>> 0;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  const out = [];
  let p = 50;
  for (let i = 0; i < n; i++) {
    const drift = rnd() - 0.47;
    p = Math.max(1, p * (1 + drift * 0.05));
    const d = new Date(Date.UTC(startYear, 0, 1));
    d.setUTCDate(d.getUTCDate() + Math.round(i * 1.4));
    out.push({
      date: d.toISOString().slice(0, 10),
      open: +(p * 0.99).toFixed(4), high: +(p * 1.03).toFixed(4),
      low: +(p * 0.96).toFixed(4), close: +p.toFixed(4),
      volume: Math.round(1e6 * (0.7 + rnd() * 0.8))
    });
  }
  return out;
}

test('metrics: Sharpe/Sortino/Calmar/VaR/CVaR determinísticos', () => {
  const r = [0.01, -0.02, 0.015, 0.005, -0.01, 0.02, -0.005, 0.01];
  assert.ok(Number.isFinite(metrics.sharpeRatio(r)));
  assert.ok(Number.isFinite(metrics.sortinoRatio(r)));
  assert.ok(metrics.valueAtRisk(r, 0.95) >= 0);
  assert.ok(metrics.conditionalVaR(r, 0.95) >= metrics.valueAtRisk(r, 0.95) - 1e-9);
});

test('metrics: CAGR de 10k→20k em 10 anos ≈ 7.18%', () => {
  const g = metrics.cagr(10000, 20000, 3652.5);
  assert.ok(Math.abs(g - 7.18) < 0.2, `CAGR=${g}`);
});

test('metrics: matriz anual e tiers de calibração', () => {
  const eq = [
    { date: '2020-01-02', value: 10000 }, { date: '2020-12-30', value: 11000 },
    { date: '2021-01-04', value: 11000 }, { date: '2021-12-30', value: 10450 }
  ];
  const trades = [
    { ticker: 'A', profit: 100, exitDate: '2020-06-01', mcTier: 'ELITE', winRateMC: 70 },
    { ticker: 'A', profit: -50, exitDate: '2021-06-01', mcTier: 'MODERATE', winRateMC: 55 }
  ];
  const rows = metrics.buildYearlyMatrix({ equityCurve: eq, trades });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].year, '2020');
  assert.ok(rows[0].returnPct > 0 && rows[1].returnPct < 0);
  const tiers = metrics.buildCalibrationTiers(trades);
  assert.equal(tiers.ELITE.trades, 1);
  assert.equal(tiers.MODERATE.trades, 1);
});

test('graham: solvência point-in-time por perfil estimado e archived', () => {
  const g1 = graham.evaluateGraham('MSFT', 2015, null);
  assert.equal(g1.source, 'estimated');
  assert.equal(g1.approved, true);
  const g2 = graham.evaluateGraham('XYZ', 2015, { XYZ: [{ year: 2010, currentRatio: 0.5, debtEquity: 3, roa: -0.1, earningsYield: 0.02 }] });
  assert.equal(g2.approved, false);
});

test('fracdiff: pesos FFD e ADF testam estacionariedade', () => {
  const w = fracdiff.getFFDWeights(0.4);
  assert.ok(w.length >= 2);
  assert.equal(w[w.length - 1], 1.0);
  const clean = makeCandles(3, 400, 2020).map(c => c.close);
  const res = fracdiff.findOptimalD(clean);
  assert.ok(res.optimalD >= 0 && res.optimalD <= 1);
});

test('purification: VIF elimina feature colinear', () => {
  const a = [1, 2, 3, 4, 5, 6, 7, 8];
  const b = a.map(x => x * 2 + 1);            // perfeitamente colinear com a
  const c = [3, 1, 4, 1, 5, 9, 2, 6];         // independente
  const { kept } = purif.selectPurifiedFeatures({ a, b, c }, 5.0);
  assert.ok(kept.length >= 2);
  assert.ok(!(kept.includes('a') && kept.includes('b')), 'não deve manter ambas as colineares');
});

test('validation: DSR em [0,1] e normPpf consistente', () => {
  const r = [0.001, 0.002, -0.001, 0.003, 0.001, -0.002, 0.004, 0.0015, -0.0005, 0.002];
  const dsr = validation.deflatedSharpeRatio(r, 5);
  assert.ok(dsr >= 0 && dsr <= 1);
  assert.ok(Math.abs(validation.normPpf(0.5)) < 1e-3);
});

test('resolveDates: horizonte de 5 anos a partir de endDate', () => {
  const d = resolveDates({ horizonYears: 5, endDate: '2026-01-01' });
  assert.equal(d.startDate, '2021-01-01');
  assert.equal(d.horizonYears, 5);
});

test('workstation: executa 20 anos, warm-up respeitado e relatório completo', async () => {
  const universe = [
    { ticker: 'MSFT', name: 'MSFT', candles: makeCandles(11, 5000, 2006) },
    { ticker: 'AAPL', name: 'AAPL', candles: makeCandles(23, 5000, 2006) },
    { ticker: 'XOM', name: 'XOM', candles: makeCandles(31, 5000, 2006) }
  ];
  const t0 = Date.now();
  const r = await runWorkstationSimulation({
    universe,
    params: { horizonYears: 20, endDate: '2026-01-01', convictionTier: 'moderate', rebalanceDays: 35, maxPositions: 3, mcIterations: 800 }
  });
  assert.equal(r.ok, true);
  assert.equal(r.engine, 'workstation');
  assert.ok(Date.now() - t0 < 8000, 'execução deve ser rápida (escassos segundos)');
  // relatório tem todos os 5 blocos
  assert.ok(r.globalKpis && typeof r.globalKpis.sharpe === 'number');   // Bloco A
  assert.ok(Array.isArray(r.yearlyMatrix));                              // Bloco B
  assert.ok(r.calibrationTiers && r.calibrationTiers.ELITE);             // Bloco C
  assert.ok(r.equityCurve.length > 0 && r.drawdownSeries.length > 0);    // Bloco D
  assert.ok(Array.isArray(r.trades));                                    // Bloco E
  // trades têm MFE/MAE
  if (r.trades.length) {
    const t = r.trades[0];
    assert.ok('mfePct' in t && 'maePct' in t && 'winRateMC' in t && 'mcTier' in t);
    assert.ok(t.mfePct >= 0);
  }
});

test('workstation: nenhuma ordem nas primeiras 200 velas de warm-up', async () => {
  const candles = makeCandles(77, 600, 2024);
  const r = await runWorkstationSimulation({
    universe: [{ ticker: 'KO', name: 'KO', candles }],
    params: { horizonYears: 20, endDate: '2026-01-01', maxPositions: 5, mcIterations: 400, rebalanceDays: 21 }
  });
  assert.equal(r.ok, true);
  const warmupDate = candles[199].date;
  for (const t of r.trades) {
    assert.ok(t.entryDate >= warmupDate, `entrada ${t.entryDate} antes do fim do warm-up ${warmupDate}`);
  }
});

test('workstation: modo paralelo (Worker Threads) e síncrono são idênticos', async () => {
  const universe = [
    { ticker: 'MSFT', name: 'MSFT', candles: makeCandles(11, 3000, 2012) },
    { ticker: 'AAPL', name: 'AAPL', candles: makeCandles(23, 3000, 2012) },
    { ticker: 'XOM', name: 'XOM', candles: makeCandles(31, 3000, 2012) },
    { ticker: 'JNJ', name: 'JNJ', candles: makeCandles(47, 3000, 2012) }
  ];
  const params = { horizonYears: 10, endDate: '2024-01-01', rebalanceDays: 35, maxPositions: 4, mcIterations: 1500 };
  const par = await runWorkstationSimulation({ universe, params: { ...params, parallel: true } });
  const ser = await runWorkstationSimulation({ universe, params: { ...params, parallel: false } });
  const norm = (r) => JSON.stringify({
    k: r.kpis, y: r.yearlyMatrix,
    tr: r.trades.map(t => [t.ticker, t.entryDate, t.exitDate, t.profit, t.mfePct, t.maePct, t.winRateMC, t.mcTier])
  });
  assert.equal(norm(par), norm(ser), 'o resultado paralelo deve ser bit-a-bit idêntico ao síncrono');
});
