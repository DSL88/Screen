'use strict';

// ═══════════════════════════════════════════════════════════
//  backtester-hardening.test.js
//
//  Regressões de segurança do motor de backtesting:
//   • F-03 — `side` do sinal executado corretamente (LONG/SHORT)
//   • F-08/F-19/F-20 — caps e validação de parâmetros do portefólio
//   • F-01 (A1 conservador) — pré-filtro VWAP/RVOL e prefixo
//     incremental mantêm resultados idênticos
//   • F-08/F-20 — `horizonDays` finito/teto em runSimulation
//   • F-13/F-20 — validação e timeout de cálculo no worker
// ═══════════════════════════════════════════════════════════

const assert = require('node:assert/strict');
const test = require('node:test');

const { PortfolioBacktester } = require('../src/engine/portfolioBacktester');

// ─────────────────────────────────────────────────────────────
//  Helpers de séries sintéticas
// ─────────────────────────────────────────────────────────────
function dayGrid(n, start = new Date(Date.UTC(2024, 0, 1))) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(start);
    d.setUTCDate(d.getUTCDate() + i);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

function flatCandles(dates, base, overrides = {}) {
  return dates.map((date, i) => {
    const o = overrides[i] || {};
    return {
      date,
      open: o.open != null ? o.open : base,
      high: o.high != null ? o.high : base,
      low: o.low != null ? o.low : base,
      close: o.close != null ? o.close : base,
      volume: 1e6
    };
  });
}

function sideGatekeeper(approvals) {
  return (slice, _quantEngine, ticker) => {
    const date = slice[slice.length - 1].date;
    const a = approvals.get(`${ticker}|${date}`);
    if (!a) return null;
    return {
      approved: true,
      winRateMC: a.winRateMC != null ? a.winRateMC : 70,
      mcTier: a.winRateMC >= 65 ? 'ELITE' : 'MODERATE',
      side: a.side || 'LONG'
    };
  };
}

function oscillatingSeries(n) {
  const out = [];
  const start = Date.UTC(2020, 0, 1);
  for (let i = 0; i < n; i++) {
    const close = 100 + 10 * Math.sin(i / 5) + (i % 7) * 0.1;
    const prev = i === 0 ? close : 100 + 10 * Math.sin((i - 1) / 5) + ((i - 1) % 7) * 0.1;
    out.push({
      date: new Date(start + i * 86400000).toISOString().slice(0, 10),
      open: prev,
      high: Math.max(prev, close) * 1.005,
      low: Math.min(prev, close) * 0.995,
      close,
      volume: 1000 + (i % 11) * 50
    });
  }
  return out;
}

// Carrega backtesterEngine com hooks temporários nos módulos quant.
// Restaura sempre os exports originais no fim do teste.
function loadEngine({ analyzeSeries, monteCarlo } = {}) {
  const markovPath = require.resolve('../src/quant/markovEngine');
  const mcPath = require.resolve('../src/quant/monteCarloEngine');
  const enginePath = require.resolve('../src/engine/backtesterEngine');
  const realMarkov = require(markovPath);
  const realMc = require(mcPath);
  const origAnalyze = realMarkov.analyzeSeries;
  const origMc = realMc.runMarkovMonteCarloSimulation;
  if (analyzeSeries) realMarkov.analyzeSeries = analyzeSeries;
  if (monteCarlo) realMc.runMarkovMonteCarloSimulation = monteCarlo;
  delete require.cache[enginePath];
  const engine = require(enginePath);
  return {
    engine,
    restore() {
      realMarkov.analyzeSeries = origAnalyze;
      realMc.runMarkovMonteCarloSimulation = origMc;
      delete require.cache[enginePath];
    }
  };
}

// ═══════════════════════════════════════════════════════════
//  F-03 — SHORT no PortfolioBacktester
// ═══════════════════════════════════════════════════════════

test('Portfolio SHORT: sinal VENDA abre SHORT e fecha em TP espelhado (PnL positivo)', async () => {
  const dates = dayGrid(240);
  const candles = flatCandles(dates, 100);
  // Dia 1: SHORT entra a 100; TP = 95.2 (100 * (1 - 4.8%)) → low 94 toca
  candles[1] = { date: dates[1], open: 100, high: 100, low: 94, close: 95, volume: 1e6 };
  const map = new Map([['S', candles]]);
  const approvals = new Map([[`S|${dates[0]}`, { side: 'SHORT', winRateMC: 80 }]]);

  const bt = new PortfolioBacktester({
    initialCapital: 10000, maxPositions: 1, positionAllocationPct: 0.5,
    warmup: 0, direction: 'both', stopLoss: 2.4, takeProfit: 4.8
  });
  bt.evaluateAssetGatekeepers = sideGatekeeper(approvals);
  const res = await bt.run(map, dates);

  const tr = res.trades.find(t => t.ticker === 'S');
  assert.ok(tr, 'deve executar o sinal SHORT em vez de o abrir como LONG');
  assert.equal(tr.side, 'SHORT');
  assert.equal(tr.entryPrice, 100);
  assert.equal(tr.reason, 'TAKE_PROFIT');
  assert.equal(tr.exitPrice, 95.2);
  assert.ok(Math.abs(tr.pnlPct - 4.8) < 0.01, `pnlPct=${tr.pnlPct}`);
  assert.ok(tr.profit > 0, 'queda do preço deve dar lucro no SHORT');
  assert.ok(res.finalCapital > 10000, `finalCapital=${res.finalCapital}`);
});

test('Portfolio SHORT: subida do preço fecha em SL com perda', async () => {
  const dates = dayGrid(240);
  const candles = flatCandles(dates, 100);
  // SL SHORT = 102.4 (100 * (1 + 2.4%)) → high 103 toca
  candles[1] = { date: dates[1], open: 100, high: 103, low: 100, close: 103, volume: 1e6 };
  const map = new Map([['S', candles]]);
  const approvals = new Map([[`S|${dates[0]}`, { side: 'SHORT', winRateMC: 80 }]]);

  const bt = new PortfolioBacktester({
    initialCapital: 10000, maxPositions: 1, positionAllocationPct: 0.5,
    warmup: 0, direction: 'both', stopLoss: 2.4, takeProfit: 4.8
  });
  bt.evaluateAssetGatekeepers = sideGatekeeper(approvals);
  const res = await bt.run(map, dates);

  const tr = res.trades.find(t => t.ticker === 'S');
  assert.equal(tr.side, 'SHORT');
  assert.equal(tr.reason, 'STOP_LOSS');
  assert.equal(tr.exitPrice, 102.4);
  assert.ok(Math.abs(tr.pnlPct - (-2.4)) < 0.01, `pnlPct=${tr.pnlPct}`);
  assert.ok(tr.profit < 0);
  assert.ok(res.finalCapital < 10000);
});

test('Portfolio SHORT: mark-to-market reflete ganho não realizado', async () => {
  const dates = dayGrid(240);
  const candles = flatCandles(dates, 100);
  // Queda suave (low 98.5 > TP 95.2) → posição continua aberta
  candles[10] = { date: dates[10], open: 99, high: 100, low: 98.5, close: 98, volume: 1e6 };
  const map = new Map([['S', candles]]);
  const approvals = new Map([[`S|${dates[0]}`, { side: 'SHORT', winRateMC: 80 }]]);

  const bt = new PortfolioBacktester({
    initialCapital: 10000, maxPositions: 1, positionAllocationPct: 0.5,
    warmup: 0, direction: 'both', stopLoss: 2.4, takeProfit: 4.8
  });
  bt.evaluateAssetGatekeepers = sideGatekeeper(approvals);
  const res = await bt.run(map, dates);

  const p = res.equityCurve.find(x => x.date === dates[10]);
  assert.ok(p, 'curva deve incluir o dia 10');
  assert.equal(p.openPositionsCount, 1);
  assert.equal(p.invested, 5100); // 5000 × (1 + 2%)
  assert.ok(Math.abs(p.equity - 10100) < 0.51, `equity=${p.equity}`);
});

test('Portfolio: direction long/short não executam o lado oposto de sinais externos', async () => {
  const dates = dayGrid(240);
  const map = new Map([['A', flatCandles(dates, 100)]]);
  const shortApproval = new Map([[`A|${dates[0]}`, { side: 'SHORT', winRateMC: 90 }]]);
  const longApproval = new Map([[`A|${dates[0]}`, { side: 'LONG', winRateMC: 90 }]]);

  const longOnly = new PortfolioBacktester({ warmup: 0, direction: 'long' });
  longOnly.evaluateAssetGatekeepers = sideGatekeeper(shortApproval);
  const longRes = await longOnly.run(map, dates);
  assert.equal(longRes.trades.length, 0, 'sinal SHORT não pode ser executado em modo long');

  const shortOnly = new PortfolioBacktester({ warmup: 0, direction: 'short' });
  shortOnly.evaluateAssetGatekeepers = sideGatekeeper(longApproval);
  const shortRes = await shortOnly.run(map, dates);
  assert.equal(shortRes.trades.length, 0, 'sinal LONG não pode ser executado em modo short');
});

// ═══════════════════════════════════════════════════════════
//  F-08/F-19/F-20 — validação e caps de parâmetros
// ═══════════════════════════════════════════════════════════

test('Portfolio: mcIterations/horizonDays são finitos e limitados por teto', () => {
  const bt = new PortfolioBacktester({
    mcIterations: 5e6,
    horizonDays: 999999,
    stopLoss: -1,
    takeProfit: 0,
    commission: -0.5,
    slippage: Infinity,
    initialCapital: -100,
    positionAllocationPct: 5,
    maxPositions: 2.7,
    warmup: NaN,
    markovWindow: -3
  });

  assert.equal(bt.mcIterations, 1000000);
  assert.equal(bt.horizonDays, 2520);
  assert.equal(bt.stopLossPct, 0.024);
  assert.equal(bt.takeProfitPct, 0.048);
  assert.equal(bt.commissionPct, 0);
  assert.equal(bt.slippagePct, 0);
  assert.equal(bt.initialCapital, 10000);
  assert.equal(bt.positionAllocationPct, 1);
  assert.equal(bt.maxPositions, 2);
  assert.equal(bt.warmup, 200);
  assert.equal(bt.markovWindow, 150);

  for (const [k, v] of Object.entries({
    mcIterations: bt.mcIterations,
    horizonDays: bt.horizonDays,
    stopLossPct: bt.stopLossPct,
    takeProfitPct: bt.takeProfitPct,
    commissionPct: bt.commissionPct,
    slippagePct: bt.slippagePct,
    initialCapital: bt.initialCapital,
    positionAllocationPct: bt.positionAllocationPct,
    maxPositions: bt.maxPositions
  })) {
    assert.ok(Number.isFinite(v), `${k} deve ser finito (${v})`);
  }
});

test('Portfolio: strings numéricas são aceites, strings inválidas e Infinity não propagam', () => {
  const numerics = new PortfolioBacktester({ mcIterations: '250', horizonDays: '120', stopLoss: '3', takeProfit: '6' });
  assert.equal(numerics.mcIterations, 250);
  assert.equal(numerics.horizonDays, 120);
  assert.ok(Math.abs(numerics.stopLossPct - 0.03) < 1e-12);
  assert.ok(Math.abs(numerics.takeProfitPct - 0.06) < 1e-12);

  const invalid = new PortfolioBacktester({ mcIterations: 'abc', horizonDays: 'abc', stopLoss: 'xyz', takeProfit: undefined });
  assert.equal(invalid.mcIterations, 1000);
  assert.equal(invalid.horizonDays, 35);
  assert.equal(invalid.stopLossPct, 0.024);
  assert.equal(invalid.takeProfitPct, 0.048);

  const infinite = new PortfolioBacktester({ mcIterations: Infinity, horizonDays: Infinity });
  assert.equal(infinite.mcIterations, 1000000);
  assert.equal(infinite.horizonDays, 2520);
  assert.ok(Number.isFinite(infinite.mcIterations));
  assert.ok(Number.isFinite(infinite.horizonDays));
});

// ═══════════════════════════════════════════════════════════
//  F-01 (A1 conservador) — performance com resultados idênticos
// ═══════════════════════════════════════════════════════════

test('runSimulation: pré-filtro A1 reduz chamadas a analyzeSeries sem alterar resultados', async () => {
  const series = oscillatingSeries(200);
  const dates = series.map(c => c.date);
  const calls = { fast: [], ref: [] };
  let bucket = calls.fast;

  const realAnalyze = require('../src/quant/markovEngine').analyzeSeries;
  const wrapper = (candles, params) => {
    bucket.push({ len: candles.length, first: candles[0].date, last: candles[candles.length - 1].date });
    return realAnalyze(candles, params);
  };

  const { engine, restore } = loadEngine({
    analyzeSeries: wrapper,
    monteCarlo: () => ({ winRate: 80, isApproved: true, mcTier: 'ELITE' })
  });

  try {
    const params = {
      direction: 'long',
      stopType: 'pct',
      stopLoss: 1.4,
      takeProfit: 2.8,
      vwapGate: true,
      rvolGate: true,
      mcMinPct: 50,
      markovMinPct: 0,
      startDate: dates[0],
      endDate: dates[dates.length - 1],
      initialCapital: 10000,
      riskPerTradePct: 2,
      exitMode: 'alerts',
      warmup: 60,
      markovWindow: 150,
      horizonDays: 5
    };
    const universe = [{ ticker: 'OSC', name: 'Osc', candles: series }];

    bucket = calls.ref;
    const reference = await engine.runSimulation({ universe, params, hooks: { referenceMode: true } });
    bucket = calls.fast;
    const fast = await engine.runSimulation({ universe, params, hooks: {} });

    // Resultados idênticos (trades, KPIs e curva de capital)
    assert.deepEqual(fast.trades, reference.trades, 'trades devem ser idênticos');
    assert.deepEqual(fast.kpis, reference.kpis, 'KPIs devem ser idênticos');
    assert.deepEqual(fast.equityCurve, reference.equityCurve, 'equity curve deve ser idêntica');

    // A otimização tem de efetivamente evitar avaliações
    assert.ok(calls.fast.length > 0, 'deve avaliar sinais');
    assert.ok(calls.fast.length < calls.ref.length, `pré-filtro deve cortar barras (${calls.fast.length} < ${calls.ref.length})`);

    // Todo o prefixo avaliado é candles[0..len-1] (sem lookahead)
    const refLengths = new Set(calls.ref.map(c => c.len));
    for (const c of calls.fast) {
      assert.ok(refLengths.has(c.len), `prefixo ${c.len} não existe no modo referência`);
      assert.equal(c.first, series[0].date);
      assert.equal(c.last, series[c.len - 1].date);
    }
  } finally {
    restore();
  }
});

test('runSimulation: horizonDays não finito é limitado antes de chegar ao motor', async () => {
  const seen = [];
  const series = oscillatingSeries(90);
  const { engine, restore } = loadEngine({
    analyzeSeries: (candles, params) => {
      seen.push(params.horizonDays);
      const last = candles[candles.length - 1];
      return {
        close: last.close, date: last.date, direction: 'NEUTRO',
        pBull: 0.1, pBear: 0.1, rollingVwap20: null, currentState: 0,
        transitionMatrix: null
      };
    }
  });

  try {
    const params = {
      horizonDays: Infinity,
      warmup: 60,
      startDate: series[0].date,
      endDate: series[series.length - 1].date
    };
    const universe = [{ ticker: 'H', name: 'H', candles: series }];
    const res = await engine.runSimulation({ universe, params, hooks: {} });
    assert.equal(res.ok, true);
    assert.ok(seen.length > 0, 'analyzeSeries deve ser chamada');
    assert.ok(seen.every(h => h === 2520), `horizonDays deve ser limitado a 2520 (${seen[0]})`);
  } finally {
    restore();
  }
});

// ═══════════════════════════════════════════════════════════
//  F-13/F-20 — worker: validação e timeout de segurança
// ═══════════════════════════════════════════════════════════

test('simulationWorker: sanitiza mcIterations/horizonDays recebidos por mensagem', () => {
  const worker = require('../src/engine/simulationWorker');
  assert.equal(typeof worker.sanitizeSimulationParams, 'function');

  const capped = worker.sanitizeSimulationParams({ mcIterations: 5e6, horizonDays: 1e9 });
  assert.equal(capped.mcIterations, 1000000);
  assert.equal(capped.horizonDays, 2520);

  const infinity = worker.sanitizeSimulationParams({ mcIterations: Infinity, horizonDays: Infinity });
  assert.equal(infinity.mcIterations, 1000000);
  assert.equal(infinity.horizonDays, 2520);

  const dropped = worker.sanitizeSimulationParams({ mcIterations: NaN, horizonDays: 'abc', direction: 'both' });
  assert.ok(!('mcIterations' in dropped));
  assert.ok(!('horizonDays' in dropped));
  assert.equal(dropped.direction, 'both');

  const numericStrings = worker.sanitizeSimulationParams({ mcIterations: '250', horizonDays: '40' });
  assert.equal(numericStrings.mcIterations, 250);
  assert.equal(numericStrings.horizonDays, 40);

  const nonPositive = worker.sanitizeSimulationParams({ mcIterations: 0, horizonDays: -10 });
  assert.ok(!('mcIterations' in nonPositive));
  assert.ok(!('horizonDays' in nonPositive));
});

test('simulationWorker: guarda de cálculo expira e sinaliza cancelamento', async () => {
  const worker = require('../src/engine/simulationWorker');
  const guard = worker.createCalculationGuard('run_test_timeout', 25);
  try {
    assert.equal(guard.timedOut, false);
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.equal(guard.timedOut, true, 'timeout deve disparar');
  } finally {
    guard.clear();
  }

  // Sem timeout configurado a guarda não dispara
  const neutral = worker.createCalculationGuard('run_test_none', 0);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(neutral.timedOut, false);
  neutral.clear();
});
