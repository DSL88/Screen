'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const markovPath = require.resolve('../src/quant/markovEngine');
const monteCarloPath = require.resolve('../src/quant/monteCarloEngine');
const enginePath = require.resolve('../src/engine/backtesterEngine');

// ═══════════════════════════════════════════════════════════
//  Loader com stubs determinísticos (padrão de test/scanner.test.js)
// ═══════════════════════════════════════════════════════════
function loadEngine(config) {
  const analyzeSeries = config.analyzeSeries || ((candles) => {
    const last = candles[candles.length - 1];
    const dir = config.directionAt && config.directionAt(last.date) || 'NEUTRO';
    const vwapOffset = config.vwapOffset != null ? config.vwapOffset : -5;
    return {
      close: last.close,
      date: last.date,
      direction: dir,
      pBull: dir === 'COMPRA' ? 0.7 : 0.4,
      pBear: dir === 'VENDA' ? 0.7 : 0.4,
      pStay: 0.2,
      edge: 0.3,
      rollingVwap20: last.close + vwapOffset,
      atr: config.atr != null ? config.atr : 2,
      currentState: config.currentState != null ? config.currentState : 0,
      transitionMatrix: [[0.5, 0.5], [0.5, 0.5]]
    };
  });
  const monteCarlo = config.monteCarlo || (() => ({ winRate: 80, isApproved: true, mcTier: 'ELITE' }));

  require.cache[markovPath] = {
    id: markovPath, filename: markovPath, loaded: true,
    exports: { analyzeSeries }
  };
  require.cache[monteCarloPath] = {
    id: monteCarloPath, filename: monteCarloPath, loaded: true,
    exports: { runMarkovMonteCarloSimulation: monteCarlo }
  };
  delete require.cache[enginePath];
  return require(enginePath);
}

// ═══════════════════════════════════════════════════════════
//  Helpers de séries sintéticas (datas diárias YYYY-MM-DD)
// ═══════════════════════════════════════════════════════════
function dateAt(start, i) {
  return new Date(new Date(start + 'T00:00:00Z').getTime() + i * 86400000).toISOString().slice(0, 10);
}

function buildSeries(spec) {
  return spec.map(s => ({
    date: s.date,
    open: s.open,
    high: s.high,
    low: s.low,
    close: s.close,
    volume: s.volume != null ? s.volume : 1000
  }));
}

const START = '2020-02-01';
const END = '2020-02-29';

function baseParams(overrides) {
  return Object.assign({
    direction: 'both',
    exitMode: 'alerts',
    stopType: 'pct',
    stopLoss: 1.4,
    takeProfit: 2.8,
    trailingStop: false,
    trailingOffsetPct: 0,
    vwapGate: true,
    mcMinPct: 50,
    markovMinPct: 55,
    startDate: START,
    endDate: END,
    initialCapital: 10000,
    riskPerTradePct: 2,
    commissionPct: 0,
    slippagePct: 0,
    warmup: 20,
    markovWindow: 150,
    horizonDays: 5
  }, overrides || {});
}

// Série: 38 velas planas (01-01 → 02-07), sinal 02-08, fill/exit 02-09
function longTpSeries() {
  const spec = [];
  for (let i = 0; i < 38; i++) {
    const d = dateAt('2020-01-01', i);
    spec.push({ date: d, open: 100, high: 101, low: 99, close: 100 });
  }
  spec.push({ date: '2020-02-08', open: 100, high: 101, low: 99, close: 100 });
  spec.push({ date: '2020-02-09', open: 100, high: 110, low: 99, close: 108 });
  return buildSeries(spec);
}

test('LONG fecha por TP no nível take_profit', { concurrency: false }, async () => {
  const { runSimulation } = loadEngine({
    directionAt: date => (date === '2020-02-08' ? 'COMPRA' : 'NEUTRO')
  });
  const result = await runSimulation({
    universe: [{ ticker: 'TEST', name: 'Teste', candles: longTpSeries() }],
    params: baseParams(),
    hooks: {}
  });
  assert.equal(result.ok, true);
  assert.equal(result.trades.length, 1);
  const t = result.trades[0];
  assert.equal(t.side, 'LONG');
  assert.equal(t.entryDate, '2020-02-09');
  assert.equal(t.entryPrice, 100);
  assert.equal(t.exitDate, '2020-02-09');
  assert.equal(t.reason, 'TP');
  assert.equal(t.exitPrice, 102.8);
  assert.equal(t.profitPct, 2.8);
});

test('LONG fecha por SL no nível stop_loss', { concurrency: false }, async () => {
  const { runSimulation } = loadEngine({
    directionAt: date => (date === '2020-02-08' ? 'COMPRA' : 'NEUTRO')
  });
  const series = longTpSeries();
  series[series.length - 1] = { date: '2020-02-09', open: 100, high: 101, low: 95, close: 96, volume: 1000 };
  const result = await runSimulation({
    universe: [{ ticker: 'TEST', name: 'Teste', candles: series }],
    params: baseParams(),
    hooks: {}
  });
  assert.equal(result.trades.length, 1);
  const t = result.trades[0];
  assert.equal(t.reason, 'SL');
  assert.equal(t.exitPrice, 98.6);
  assert.equal(t.profitPct, -1.4);
});

test('SHORT fecha por TP com preços invertidos', { concurrency: false }, async () => {
  const { runSimulation } = loadEngine({
    directionAt: date => (date === '2020-02-08' ? 'VENDA' : 'NEUTRO'),
    vwapOffset: 5
  });
  const series = longTpSeries();
  series[series.length - 1] = { date: '2020-02-09', open: 100, high: 101, low: 95, close: 96, volume: 1000 };
  const result = await runSimulation({
    universe: [{ ticker: 'TEST', name: 'Teste', candles: series }],
    params: baseParams(),
    hooks: {}
  });
  assert.equal(result.trades.length, 1);
  const t = result.trades[0];
  assert.equal(t.side, 'SHORT');
  assert.equal(t.reason, 'TP');
  assert.equal(t.exitPrice, 97.2);
  assert.equal(t.profitPct, 2.8);
});

test('SHORT fecha por SL quando o preço sobe', { concurrency: false }, async () => {
  const { runSimulation } = loadEngine({
    directionAt: date => (date === '2020-02-08' ? 'VENDA' : 'NEUTRO'),
    vwapOffset: 5
  });
  const series = longTpSeries();
  series[series.length - 1] = { date: '2020-02-09', open: 100, high: 105, low: 99, close: 104, volume: 1000 };
  const result = await runSimulation({
    universe: [{ ticker: 'TEST', name: 'Teste', candles: series }],
    params: baseParams(),
    hooks: {}
  });
  assert.equal(result.trades.length, 1);
  const t = result.trades[0];
  assert.equal(t.reason, 'SL');
  assert.equal(t.exitPrice, 101.4);
  assert.equal(t.profitPct, -1.4);
});

test('Trailing Stop fecha com motivo Trailing', { concurrency: false }, async () => {
  const { runSimulation } = loadEngine({
    directionAt: date => (date === '2020-02-08' ? 'COMPRA' : 'NEUTRO')
  });
  const series = longTpSeries();
  series[series.length - 1] = { date: '2020-02-09', open: 100, high: 106, low: 99, close: 105, volume: 1000 };
  const result = await runSimulation({
    universe: [{ ticker: 'TEST', name: 'Teste', candles: series }],
    params: baseParams({ trailingStop: true, trailingOffsetPct: 2, takeProfit: 8 }),
    hooks: {}
  });
  assert.equal(result.trades.length, 1);
  const t = result.trades[0];
  assert.equal(t.reason, 'Trailing');
  assert.equal(t.exitPrice, 103.88);
});

test('Gatekeeper VWAP bloqueia LONG abaixo do VWAP e desligado permite', { concurrency: false }, async () => {
  const config = { directionAt: () => 'COMPRA', vwapOffset: 5 };
  const { runSimulation } = loadEngine(config);
  const universe = [{ ticker: 'TEST', name: 'Teste', candles: longTpSeries() }];

  const blocked = await runSimulation({ universe, params: baseParams(), hooks: {} });
  assert.equal(blocked.trades.length, 0);

  const allowed = await runSimulation({ universe, params: baseParams({ vwapGate: false }), hooks: {} });
  assert.equal(allowed.trades.length, 1);
});

test('Filtro de direção long não gera SHORTs', { concurrency: false }, async () => {
  const { runSimulation } = loadEngine({ directionAt: () => 'VENDA' });
  const result = await runSimulation({
    universe: [{ ticker: 'TEST', name: 'Teste', candles: longTpSeries() }],
    params: baseParams({ direction: 'long' }),
    hooks: {}
  });
  assert.equal(result.trades.length, 0);
});

test('Warm-up insuficiente ignora o ativo com mensagem', { concurrency: false }, async () => {
  const { runSimulation } = loadEngine({ directionAt: () => 'COMPRA' });
  const shortSeries = buildSeries([
    { date: '2020-01-30', open: 100, high: 101, low: 99, close: 100 },
    { date: '2020-01-31', open: 100, high: 101, low: 99, close: 100 },
    { date: '2020-02-01', open: 100, high: 101, low: 99, close: 100 },
    { date: '2020-02-02', open: 100, high: 101, low: 99, close: 100 },
    { date: '2020-02-03', open: 100, high: 101, low: 99, close: 100 },
    { date: '2020-02-04', open: 100, high: 101, low: 99, close: 100 },
    { date: '2020-02-05', open: 100, high: 101, low: 99, close: 100 }
  ]);
  const result = await runSimulation({
    universe: [{ ticker: 'SHORT', name: 'Curto', candles: shortSeries }],
    params: baseParams(),
    hooks: {}
  });
  assert.equal(result.trades.length, 0);
  assert.equal(result.messages.some(m => m.includes('sem registos suficientes')), true);
});

test('Ativo com menos de 20 velas gera mensagem de registos insuficientes', { concurrency: false }, async () => {
  const { runSimulation } = loadEngine({ directionAt: () => 'COMPRA' });
  const tinySeries = buildSeries(Array.from({ length: 15 }, (_, i) => ({
    date: dateAt('2020-01-30', i),
    open: 100, high: 101, low: 99, close: 100
  })));
  const result = await runSimulation({
    universe: [{ ticker: 'TINY', name: 'Pequeno', candles: tinySeries }],
    params: baseParams(),
    hooks: {}
  });
  assert.equal(result.trades.length, 0);
  assert.equal(result.messages.some(m => m.includes('sem registos suficientes')), true);
});

test('Warm-up dinâmico ajusta o início e não ignora o ativo', { concurrency: false }, async () => {
  const { runSimulation } = loadEngine({ directionAt: () => 'COMPRA' });
  const series = buildSeries(Array.from({ length: 250 }, (_, i) => ({
    date: dateAt('2020-01-01', i),
    open: 100, high: 101, low: 99, close: 100
  })));
  const result = await runSimulation({
    universe: [{ ticker: 'LONG', name: 'Longo', candles: series }],
    params: baseParams({ startDate: '2020-01-01', endDate: dateAt('2020-01-01', 249) }),
    hooks: {}
  });
  assert.ok(result.trades.length > 0, 'série longa com warm-up dinâmico deve produzir trades');
  assert.equal(result.messages.some(m => m.includes('início ajustado')), true);
  assert.equal(result.messages.some(m => m.includes('sem registos suficientes')), false);
});

test('Preços em String são coerzidos para números com o mesmo resultado', { concurrency: false }, async () => {
  const { runSimulation } = loadEngine({ directionAt: date => (date === '2020-02-08' ? 'COMPRA' : 'NEUTRO') });
  const numeric = longTpSeries();
  const stringy = numeric.map(c => ({
    date: c.date,
    open: String(c.open),
    high: String(c.high),
    low: String(c.low),
    close: String(c.close),
    volume: String(c.volume)
  }));
  const numResult = await runSimulation({
    universe: [{ ticker: 'TEST', name: 'Teste', candles: numeric }],
    params: baseParams(),
    hooks: {}
  });
  const strResult = await runSimulation({
    universe: [{ ticker: 'TEST', name: 'Teste', candles: stringy }],
    params: baseParams(),
    hooks: {}
  });
  assert.equal(strResult.trades.length, numResult.trades.length);
  assert.equal(strResult.kpis.totalTrades, numResult.kpis.totalTrades);
  assert.equal(strResult.kpis.netProfit, numResult.kpis.netProfit);
  assert.deepEqual(strResult.trades, numResult.trades);
});

test('Velas fora de ordem cronológica são ordenadas ASC com o mesmo resultado', { concurrency: false }, async () => {
  const { runSimulation } = loadEngine({ directionAt: date => (date === '2020-02-08' ? 'COMPRA' : 'NEUTRO') });
  const sorted = longTpSeries();
  const shuffled = sorted.slice().reverse();
  const sortedResult = await runSimulation({
    universe: [{ ticker: 'TEST', name: 'Teste', candles: sorted }],
    params: baseParams(),
    hooks: {}
  });
  const shuffledResult = await runSimulation({
    universe: [{ ticker: 'TEST', name: 'Teste', candles: shuffled }],
    params: baseParams(),
    hooks: {}
  });
  assert.equal(shuffledResult.trades.length, 1);
  assert.equal(shuffledResult.kpis.totalTrades, sortedResult.kpis.totalTrades);
  assert.equal(shuffledResult.kpis.netProfit, sortedResult.kpis.netProfit);
  assert.deepEqual(shuffledResult.trades, sortedResult.trades);
});

test('KPIs calculados corretamente num caso com 1 win e 1 loss', { concurrency: false }, async () => {
  const { calculateKPIs } = loadEngine({});
  const kpis = calculateKPIs(
    [
      { profit: 5.6, profitPct: 2.8, side: 'LONG', durationDays: 1 },
      { profit: -2.8, profitPct: -1.4, side: 'SHORT', durationDays: 3 }
    ],
    [
      { date: START, value: 10000 },
      { date: '2020-02-03', value: 10000 },
      { date: '2020-02-04', value: 10002.8 }
    ],
    10000
  );
  assert.equal(kpis.totalTrades, 2);
  assert.equal(kpis.longTrades, 1);
  assert.equal(kpis.shortTrades, 1);
  assert.equal(kpis.winRate, 50);
  assert.equal(kpis.grossProfit, 5.6);
  assert.equal(kpis.grossLoss, 2.8);
  assert.equal(kpis.profitFactor, 2);
  assert.equal(kpis.payoffRatio, 2);
  assert.equal(kpis.netProfit, 2.8);
  assert.equal(kpis.avgDurationDays, 2);
});

test('modo alerts ignora comissão/slippage; modo full sofre custos', { concurrency: false }, async () => {
  const { runSimulation } = loadEngine({ directionAt: date => (date === '2020-02-08' ? 'COMPRA' : 'NEUTRO') });
  const universe = [{ ticker: 'TEST', name: 'Teste', candles: longTpSeries() }];

  const alertsNoCost = await runSimulation({ universe, params: baseParams(), hooks: {} });
  const alertsWithCost = await runSimulation({
    universe,
    params: baseParams({ commissionPct: 5, slippagePct: 5 }),
    hooks: {}
  });
  assert.equal(alertsNoCost.kpis.netProfit, alertsWithCost.kpis.netProfit);

  const fullNoCost = await runSimulation({ universe, params: baseParams({ exitMode: 'full' }), hooks: {} });
  const fullWithCost = await runSimulation({
    universe,
    params: baseParams({ exitMode: 'full', commissionPct: 0.5, slippagePct: 0.5 }),
    hooks: {}
  });
  assert.ok(fullNoCost.kpis.netProfit > fullWithCost.kpis.netProfit);
});

test('hooks.cancelled aborta a simulação com cancelled=true', { concurrency: false }, async () => {
  const { runSimulation } = loadEngine({ directionAt: () => 'COMPRA' });
  const result = await runSimulation({
    universe: [{ ticker: 'TEST', name: 'Teste', candles: longTpSeries() }],
    params: baseParams(),
    hooks: { cancelled: () => true }
  });
  assert.equal(result.cancelled, true);
  assert.equal(result.ok, false);
});

test('MC gate para SHORT é chamado com side SHORT e frações positivas', { concurrency: false }, async () => {
  const calls = [];
  const { runSimulation } = loadEngine({
    directionAt: date => (date === '2020-02-08' ? 'VENDA' : 'NEUTRO'),
    vwapOffset: 5,
    monteCarlo: (tm, st, candles, price, opts) => { calls.push(opts); return { winRate: 80, isApproved: true }; }
  });
  const series = longTpSeries();
  series[series.length - 1] = { date: '2020-02-09', open: 100, high: 101, low: 95, close: 96, volume: 1000 };
  await runSimulation({
    universe: [{ ticker: 'TEST', name: 'Teste', candles: series }],
    params: baseParams(),
    hooks: {}
  });
  assert.ok(calls.length >= 1, 'MC deve ser chamado para o sinal SHORT');
  const shortOpts = calls[0];
  assert.equal(shortOpts.side, 'SHORT');
  assert.ok(shortOpts.slPct > 0, 'slPct deve ser positivo (motor MC trata a orientação)');
  assert.ok(shortOpts.tpPct > 0, 'tpPct deve ser positivo (motor MC trata a orientação)');
});

test('motor MC é side-aware: SHORT em descida ganha, em subida perde', { concurrency: false }, async () => {
  delete require.cache[markovPath];
  delete require.cache[monteCarloPath];
  const { runMarkovMonteCarloSimulation } = require('../src/quant/monteCarloEngine');
  const { buildStateSeries } = require('../src/quant/markovEngine');
  const ind = require('../src/quant/indicators');

  function candlesFromCloses(closes) {
    return closes.map(c => ({ date: '2020-01-01', open: c, high: c * 1.004, low: c * 0.996, close: c, volume: 1000 }));
  }
  function dominantState(candles) {
    const closes = candles.map(c => c.close);
    const highs = candles.map(c => c.high);
    const lows = candles.map(c => c.low);
    const rsi = ind.rsiWilder(closes, 21);
    const adx = ind.adxWilder(highs, lows, closes, 14);
    const bb = ind.bollingerBands(closes, 30, 2);
    const states = buildStateSeries(bb.pctB, rsi, adx);
    const counts = new Map();
    for (let i = 1; i < states.length; i++) {
      const s = states[i - 1];
      if (s < 0) continue;
      counts.set(s, (counts.get(s) || 0) + 1);
    }
    let best = -1;
    let bestCount = 0;
    for (const [s, c] of counts) {
      if (c > bestCount) { best = s; bestCount = c; }
    }
    return best;
  }
  function runFor(candles, state, side) {
    const matrix = Array.from({ length: 9 }, () => { const row = Array(9).fill(0); row[state] = 1; return row; });
    const last = candles[candles.length - 1].close;
    return runMarkovMonteCarloSimulation(matrix, 0, candles, last, { slPct: 0.005, tpPct: 0.01, side, random: () => 0.99 });
  }

  const down = [];
  for (let i = 0; i < 400; i++) down.push(100 * Math.pow(0.995, i));
  const downCandles = candlesFromCloses(down);
  const downState = dominantState(downCandles);
  assert.ok(downState >= 0, 'descida deve produzir um estado dominante');
  assert.ok(runFor(downCandles, downState, 'SHORT').winRate > 90, 'SHORT em descida deve ganhar');
  assert.ok(runFor(downCandles, downState, 'LONG').winRate < 10, 'LONG em descida deve perder');

  const up = [];
  for (let i = 0; i < 400; i++) up.push(100 * Math.pow(1.005, i));
  const upCandles = candlesFromCloses(up);
  const upState = dominantState(upCandles);
  assert.ok(upState >= 0, 'subida deve produzir um estado dominante');
  assert.ok(runFor(upCandles, upState, 'LONG').winRate > 90, 'LONG em subida deve ganhar');
  assert.ok(runFor(upCandles, upState, 'SHORT').winRate < 10, 'SHORT em subida deve perder');
});

test('aceita nomes de parâmetros estilo UI (capital/risk/commission/slippage)', { concurrency: false }, async () => {
  const { runSimulation } = loadEngine({ directionAt: date => (date === '2020-02-08' ? 'COMPRA' : 'NEUTRO') });
  const universe = [{ ticker: 'TEST', name: 'Teste', candles: longTpSeries() }];
  const ui = await runSimulation({
    universe,
    params: {
      direction: 'both',
      exitMode: 'full',
      stopType: 'pct',
      stopLoss: 1.4,
      takeProfit: 2.8,
      capital: 10000,
      risk: 2,
      commission: 0.5,
      slippage: 0.5,
      trailing: true,
      trailingOffset: 2,
      mcMin: 50,
      markovMin: 55,
      vwapGate: true,
      startDate: START,
      endDate: END,
      warmup: 20
    },
    hooks: {}
  });
  const engine = await runSimulation({
    universe,
    params: baseParams({
      exitMode: 'full',
      initialCapital: 10000,
      riskPerTradePct: 2,
      commissionPct: 0.5,
      slippagePct: 0.5,
      trailingStop: true,
      trailingOffsetPct: 2,
      mcMinPct: 50,
      markovMinPct: 55
    }),
    hooks: {}
  });
  assert.equal(ui.kpis.totalTrades, engine.kpis.totalTrades);
  assert.equal(ui.kpis.netProfit, engine.kpis.netProfit);
});
