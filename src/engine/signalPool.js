'use strict';

// ═══════════════════════════════════════════════════════════
//  signalPool.js — Pool de Worker Threads para a fase de sinais
//
//  Distribui os ativos por os.cpus().length workers; cada worker
//  avalia os sinais de entrada (Markov + Monte Carlo nativo) para
//  todos os blocos de rebalanceamento. Os resultados são devolvidos
//  num Map <"ticker|blockDate", signal> consumido pelo engine.
//
//  Fallback: se worker_threads não estiver disponível, ou se o
//  universo for pequeno, corre de forma síncrona no thread atual.
//  O resultado é IDÊNTICO em ambos os modos (MC determinístico).
// ═══════════════════════════════════════════════════════════

const os = require('os');
const path = require('path');
const { evaluateEntrySignal } = require('../quant/workstation/entrySignal');

let Worker = null;
try { ({ Worker } = require('worker_threads')); } catch (_) { Worker = null; }

function defaultWorkerCount() {
  const cores = (os.cpus() && os.cpus().length) || 1;
  return Math.max(1, cores - 1);
}

function indexForDate(candles, from, to, date) {
  let lo = from, hi = to, res = from;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (String(candles[mid].date) <= date) { res = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return res;
}

function computeSerial(assets, blockStartDates, cfg, fundamentalData) {
  const map = new Map();
  for (const asset of assets) {
    for (const bd of blockStartDates) {
      const i = indexForDate(asset.candles, asset.startIdx, asset.endIdx, bd);
      if (i < asset.startIdx || i > asset.endIdx) continue;
      const sig = evaluateEntrySignal(asset, i, cfg, fundamentalData);
      if (sig) map.set(`${asset.ticker}|${bd}`, sig);
    }
  }
  return map;
}

// assets: [{ticker, candles(plain), sentiment, startIdx, endIdx}]
async function computeSignalsParallel(assets, blockStartDates, cfg, fundamentalData, opts = {}) {
  const workerCount = Math.min(opts.workerCount || defaultWorkerCount(), assets.length);
  if (!Worker || process.env.QUANT_FORCE_SERIAL === '1' || workerCount < 2 || assets.length < 2) {
    return { map: computeSerial(assets, blockStartDates, cfg, fundamentalData), mode: 'serial', workers: 1 };
  }

  const shards = Array.from({ length: workerCount }, () => []);
  assets.forEach((a, idx) => shards[idx % workerCount].push(a));

  const script = path.join(__dirname, 'signalWorker.js');
  const jobs = shards
    .filter(s => s.length)
    .map((shard) => new Promise((resolve, reject) => {
      let w;
      try {
        w = new Worker(script, { workerData: { assets: shard, blockStartDates, cfg, fundamentalData } });
      } catch (e) { reject(e); return; }
      const timer = setTimeout(() => { w.terminate(); reject(new Error('signal worker timeout')); }, opts.workerTimeoutMs || 120000);
      w.on('message', (msg) => { clearTimeout(timer); w.terminate(); if (msg && msg.ok) resolve(msg.signals); else reject(new Error((msg && msg.error) || 'signal worker error')); });
      w.on('error', (e) => { clearTimeout(timer); w.terminate(); reject(e); });
    }));

  try {
    const results = await Promise.all(jobs);
    const map = new Map();
    for (const list of results) for (const { ticker, blockDate, sig } of list) map.set(`${ticker}|${blockDate}`, sig);
    return { map, mode: 'parallel', workers: jobs.length };
  } catch (e) {
    // Fallback resiliente para o modo síncrono
    return { map: computeSerial(assets, blockStartDates, cfg, fundamentalData), mode: 'serial-fallback', workers: 1, error: e.message };
  }
}

module.exports = { computeSignalsParallel, computeSerial, defaultWorkerCount };
