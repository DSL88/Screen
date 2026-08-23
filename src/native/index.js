'use strict';

const { SL_PCT, TP_PCT } = require('../quant/markovEngine');

const MC_ITERATIONS = 1000;
const MC_DAYS_AHEAD = 20;

let nativeModule = null;
if (process.env.QUANT_FORCE_FALLBACK !== '1') {
  try {
    nativeModule = require('../../build/Release/quant_engine.node');
    console.log('[Native Engine] Módulo C++ carregado com sucesso via N-API.');
  } catch (e) {
    console.warn('[Native Engine Warning] Módulo C++ não disponível. A utilizar fallback JS:', e.message);
  }
}

function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sampleState(probabilities, rng) {
  const r = rng();
  let cumulative = 0;
  for (let i = 0; i < probabilities.length; i++) {
    cumulative += probabilities[i];
    if (r <= cumulative) return i;
  }
  return probabilities.length - 1;
}

function classifyTier(winRate) {
  if (winRate >= 65) return { isApproved: true, mcTier: 'ELITE', mcLabel: 'Alta Probabilidade' };
  if (winRate >= 50) return { isApproved: true, mcTier: 'MODERATE', mcLabel: 'Probabilidade Moderada' };
  return { isApproved: false, mcTier: 'REJECTED', mcLabel: 'Rejeitado' };
}

function expectedValuePct(winRate, tpPct, slPct) {
  const p = winRate / 100;
  return ((p * tpPct) - ((1 - p) * slPct)) * 100;
}

function zeroedResult(iterations, tpPct, slPct) {
  return {
    winRate: 0,
    winRateMC: 0,
    tpHits: 0,
    slHits: 0,
    expired: iterations,
    isApproved: false,
    mcApproved: false,
    mcTier: 'REJECTED',
    mcLabel: 'Rejeitado',
    expectedValue: expectedValuePct(0, tpPct, slPct)
  };
}

function runMonteCarloJSFallback(matrix, returnsByState, currentState, startPrice, opts = {}) {
  const iterations = opts.iterations || MC_ITERATIONS;
  const daysAhead = opts.daysAhead || MC_DAYS_AHEAD;
  const slPct = opts.slPct != null ? opts.slPct : SL_PCT;
  const tpPct = opts.tpPct != null ? opts.tpPct : TP_PCT;
  const rng = opts.seed != null ? mulberry32(opts.seed >>> 0) : Math.random;
  const isShort = String(opts.side || 'LONG').toUpperCase() === 'SHORT';

  if (!matrix || currentState < 0 || currentState >= matrix.length || !Array.isArray(matrix[currentState]) || !startPrice || startPrice <= 0) {
    return zeroedResult(iterations, tpPct, slPct);
  }

  const tpPrice = startPrice * (1 + (isShort ? -tpPct : tpPct));
  const slPrice = startPrice * (1 + (isShort ? slPct : -slPct));

  let tpHits = 0;
  let slHits = 0;
  let expired = 0;

  for (let iter = 0; iter < iterations; iter++) {
    let price = startPrice;
    let state = currentState;
    let exited = false;

    for (let d = 0; d < daysAhead; d++) {
      state = sampleState(matrix[state], rng);

      const returns = returnsByState ? returnsByState[state] : null;
      if (!returns || returns.length === 0) continue;

      const retIdx = Math.floor(rng() * returns.length);
      price = price * (1 + returns[retIdx]);

      if (isShort) {
        if (price <= tpPrice) {
          tpHits++;
          exited = true;
          break;
        }
        if (price >= slPrice) {
          slHits++;
          exited = true;
          break;
        }
      } else {
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
    }

    if (!exited) {
      expired++;
    }
  }

  const winRate = (tpHits / iterations) * 100;
  const tier = classifyTier(winRate);

  return {
    winRate,
    winRateMC: winRate,
    tpHits,
    slHits,
    expired,
    isApproved: tier.isApproved,
    mcApproved: tier.isApproved,
    mcTier: tier.mcTier,
    mcLabel: tier.mcLabel,
    expectedValue: expectedValuePct(winRate, tpPct, slPct)
  };
}

module.exports = {
  isNative: () => nativeModule !== null,
  isNativeAvailable: () => nativeModule !== null,
  runMonteCarlo(matrix, returnsByState, currentState, startPrice, a, b, c, d) {
    let opts = {};
    if (typeof a === 'object' && a !== null) {
      opts = a;
    } else if (typeof a === 'number' || typeof b === 'number') {
      opts = {
        iterations: typeof a === 'number' ? a : MC_ITERATIONS,
        daysAhead: typeof b === 'number' ? b : MC_DAYS_AHEAD,
        slPct: typeof c === 'number' ? c : SL_PCT,
        tpPct: typeof d === 'number' ? d : TP_PCT
      };
    }
    if (nativeModule) {
      if (typeof a === 'number') {
        return nativeModule.runMonteCarlo(matrix, returnsByState, currentState, startPrice, opts.iterations, opts.daysAhead, opts.slPct, opts.tpPct);
      }
      return nativeModule.runMonteCarlo(matrix, returnsByState, currentState, startPrice, opts || {});
    }
    return runMonteCarloJSFallback(matrix, returnsByState, currentState, startPrice, opts || {});
  },
  computeMarkovModel(bbPctArr, adxArr, window) {
    if (nativeModule) {
      return nativeModule.computeMarkovModel(bbPctArr, adxArr, window);
    }
    return null;
  },
  _runMonteCarloJSFallback: runMonteCarloJSFallback
};
