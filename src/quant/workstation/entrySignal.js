'use strict';

// ═══════════════════════════════════════════════════════════
//  entrySignal.js — Avaliação de sinal de entrada (Fases 1–4
//  + Markov + Monte Carlo) para um ativo num índice de barra i.
//
//  Módulo PURO (sem DB/UI), partilhado entre:
//    • workstationEngine (fallback síncrono / thread principal)
//    • signalWorker     (pool de Worker Threads, fase paralela)
//
//  Determinístico: usa seed fixo no Monte Carlo → resultados
//  idênticos em modo síncrono e paralelo.
// ═══════════════════════════════════════════════════════════

const { analyzeSeries } = require('../markovEngine');
const { runMarkovMonteCarloSimulation } = require('../monteCarloEngine');
const { evaluateGraham } = require('./graham');
const { fracDiffFFD } = require('./fracdiff');

function fracMomentum(candles, i, lookback, cfg) {
  const start = Math.max(0, i - lookback);
  if (i - start < 25) return null;
  const seg = candles.slice(start, i + 1).map(c => c.close);
  const fd = fracDiffFFD(seg, cfg.ffdD || 0.4, 1e-4, true).filter(Number.isFinite);
  return fd.length ? fd[fd.length - 1] : null;
}

// asset: { ticker, candles:[{date,open,high,low,close,volume}], sentiment:number[] }
function evaluateEntrySignal(asset, i, cfg, fundamentalData) {
  const candles = asset.candles;
  const result = analyzeSeries(candles.slice(0, i + 1), {
    markovWindow: cfg.markovWindow, useVolFilter: false, horizonDays: cfg.horizonDays,
    rvolMin: cfg.minRVOL, markovOrder: cfg.markovOrder, stateSpace: cfg.stateSpace
  });
  if (!result || result.close == null) return null;
  if (result.direction !== 'COMPRA' && result.direction !== 'VENDA') return null;

  const side = result.direction === 'COMPRA' ? 'LONG' : 'SHORT';
  if (side === 'LONG' && cfg.direction === 'short') return null;
  if (side === 'SHORT' && cfg.direction === 'long') return null;

  if (side === 'LONG' && result.pBull * 100 < cfg.markovMinPct) return null;
  if (side === 'SHORT' && result.pBear * 100 < cfg.markovMinPct) return null;

  if (cfg.vwapGate && result.rollingVwap20 != null) {
    if (side === 'LONG' && result.close <= result.rollingVwap20) return null;
    if (side === 'SHORT' && result.close >= result.rollingVwap20) return null;
  }
  if (cfg.rvolGate && side === 'LONG' && !result.rvolApproved) return null;

  const mom = fracMomentum(candles, i, 60, cfg);
  if (cfg.ffdGate && mom != null) {
    if (side === 'LONG' && mom < 0) return null;
    if (side === 'SHORT' && mom > 0) return null;
  }

  if (cfg.sentimentGate && asset.sentiment) {
    const s = asset.sentiment[i];
    if (side === 'LONG' && s <= -0.6) return null;
    if (side === 'SHORT' && s >= 0.6) return null;
  }

  if (cfg.grahamGate) {
    const year = String(candles[i].date).slice(0, 4);
    const g = evaluateGraham(asset.ticker, year, fundamentalData, cfg.grahamThresholds);
    if (!g.approved) return null;
  }

  if (!result.transitionMatrix || result.currentState < 0) return null;
  const slFrac = cfg.stopType === 'atr' && result.atr ? (result.atr * cfg.stopLoss) / result.close : cfg.stopLoss / 100;
  const tpFrac = cfg.stopType === 'atr' && result.atr ? (result.atr * cfg.takeProfit) / result.close : cfg.takeProfit / 100;
  const mc = runMarkovMonteCarloSimulation(result.transitionMatrix, result.currentState, candles.slice(0, i + 1), result.close, {
    iterations: cfg.mcIterations, daysAhead: cfg.rebalanceDays, slPct: slFrac, tpPct: tpFrac,
    side, order: cfg.markovOrder, prevState: result.prevState, stateSpace: cfg.stateSpace,
    seed: cfg.mcSeed
  });
  if (!mc || mc.winRate < cfg.minWinRateMC) return null;

  return {
    side, winRateMC: mc.winRate, mcTier: mc.mcTier, atr: result.atr,
    pMarkov: side === 'LONG' ? result.pBull : result.pBear,
    vwapDist: result.rollingVwap20 ? (result.close - result.rollingVwap20) / result.rollingVwap20 : 0,
    rvol: result.rvol, momentumFfd: mom || 0
  };
}

module.exports = { evaluateEntrySignal, fracMomentum };
