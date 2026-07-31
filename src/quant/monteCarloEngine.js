'use strict';

const { rsiWilder, adxWilder, bollingerBands } = require('./indicators');
const { buildStateSeries, NUM_STATES, SL_PCT, TP_PCT } = require('./markovEngine');

const MC_ITERATIONS = 1000;
const MC_DAYS_AHEAD = 20;
const MC_THRESHOLD = 50;

const MC_TIERS = {
  REJECTED: 'REJECTED',
  MODERATE: 'MODERATE',
  ELITE: 'ELITE'
};

const RSI_PERIOD = 21;
const ADX_PERIOD = 14;
const BB_PERIOD = 30;
const BB_MULT = 2.0;

function sampleState(probabilities) {
  const r = Math.random();
  let cumulative = 0;
  for (let i = 0; i < probabilities.length; i++) {
    cumulative += probabilities[i];
    if (r <= cumulative) return i;
  }
  return probabilities.length - 1;
}

function buildStateReturnsMap(candles) {
  const closes = new Array(candles.length);
  const highs = new Array(candles.length);
  const lows = new Array(candles.length);

  for (let i = 0; i < candles.length; i++) {
    closes[i] = candles[i].close;
    highs[i] = candles[i].high;
    lows[i] = candles[i].low;
  }

  const rsi = rsiWilder(closes, RSI_PERIOD);
  const adx = adxWilder(highs, lows, closes, ADX_PERIOD);
  const bb = bollingerBands(closes, BB_PERIOD, BB_MULT);

  const states = buildStateSeries(bb.pctB, rsi, adx);

  const returnsByState = Array.from({ length: NUM_STATES }, () => []);

  for (let i = 1; i < candles.length; i++) {
    const prevState = states[i - 1];
    if (prevState < 0) continue;
    const prevClose = closes[i - 1];
    if (prevClose == null || prevClose <= 0) continue;
    const ret = (closes[i] - prevClose) / prevClose;
    if (Number.isFinite(ret)) {
      returnsByState[prevState].push(ret);
    }
  }

  return returnsByState;
}

function classifyMCTier(winRate) {
  if (winRate >= 65) {
    return { mcTier: MC_TIERS.ELITE, mcApproved: true, mcLabel: 'Alta Probabilidade' };
  }
  if (winRate >= 50) {
    return { mcTier: MC_TIERS.MODERATE, mcApproved: true, mcLabel: 'Probabilidade Moderada' };
  }
  return { mcTier: MC_TIERS.REJECTED, mcApproved: false, mcLabel: 'Rejeitado' };
}

function runMarkovMonteCarloSimulation(transitionMatrix, currentState, candles, currentPrice, options) {
  const opts = options || {};
  const iterations = opts.iterations || MC_ITERATIONS;
  const daysAhead = opts.daysAhead || MC_DAYS_AHEAD;
  const slPct = opts.slPct != null ? opts.slPct : SL_PCT;
  const tpPct = opts.tpPct != null ? opts.tpPct : TP_PCT;

  if (!transitionMatrix || currentState < 0 || !candles || candles.length < 60 || !currentPrice || currentPrice <= 0) {
    return { winRate: 0, tpHits: 0, slHits: 0, expired: iterations, isApproved: false, mcTier: 'REJECTED', mcLabel: 'Rejeitado' };
  }

  const returnsByState = buildStateReturnsMap(candles);

  const tpPrice = currentPrice * (1 + tpPct);
  const slPrice = currentPrice * (1 - slPct);

  let tpHits = 0;
  let slHits = 0;
  let expired = 0;

  for (let iter = 0; iter < iterations; iter++) {
    let price = currentPrice;
    let state = currentState;
    let exited = false;

    for (let d = 0; d < daysAhead; d++) {
      state = sampleState(transitionMatrix[state]);

      const returns = returnsByState[state];
      if (returns.length === 0) continue;

      const retIdx = Math.floor(Math.random() * returns.length);
      price = price * (1 + returns[retIdx]);

      if (price >= tpPrice) {
        tpHits++;
        exited = true;
        break;
      }
      if (price <= slPrice) {
        slHits++;
        exited = true;
        break;
      }
    }

    if (!exited) {
      expired++;
    }
  }

  const winRate = (tpHits / iterations) * 100;
  const tier = classifyMCTier(winRate);

  return { winRate, tpHits, slHits, expired, isApproved: tier.mcApproved, mcTier: tier.mcTier, mcLabel: tier.mcLabel };
}

module.exports = { runMarkovMonteCarloSimulation, MC_ITERATIONS, MC_DAYS_AHEAD, MC_THRESHOLD, MC_TIERS, classifyMCTier };
