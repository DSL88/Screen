'use strict';

// ═══════════════════════════════════════════════════════════
//  signalWorker.js — Worker Thread de avaliação de sinais
//
//  Recebe um SHARD de ativos + datas de rebalanceamento e cfg.
//  Para cada ativo e cada blockStart, computa o sinal de entrada
//  (Fases 1–4 + Markov + Monte Carlo 5k em C++) — a fase CPU-heavy
//  do pipeline. Devolve os candidatos aprovados.
//
//  Distribui o trabalho por os.cpus().length workers (ver
//  signalPool.js). Determinístico: MC usa seed fixo → resultados
//  idênticos ao caminho síncrono do engine.
// ═══════════════════════════════════════════════════════════

const { parentPort, workerData } = require('worker_threads');
const { evaluateEntrySignal } = require('../quant/workstation/entrySignal');

function indexForDate(candles, from, to, date) {
  let lo = from, hi = to, res = from;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (String(candles[mid].date) <= date) { res = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return res;
}

function main() {
  const { assets, blockStartDates, cfg, fundamentalData } = workerData;
  const signals = [];
  for (const asset of assets) {
    for (const bd of blockStartDates) {
      const i = indexForDate(asset.candles, asset.startIdx, asset.endIdx, bd);
      if (i < asset.startIdx || i > asset.endIdx) continue;
      const sig = evaluateEntrySignal(asset, i, cfg, fundamentalData);
      if (sig) signals.push({ ticker: asset.ticker, blockDate: bd, sig });
    }
  }
  parentPort.postMessage({ ok: true, signals });
}

try {
  main();
} catch (e) {
  parentPort.postMessage({ ok: false, error: e.message || String(e) });
}
