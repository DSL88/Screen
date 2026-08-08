'use strict';

const { parentPort } = require('worker_threads');
const { runSimulation } = require('./backtesterEngine');

const DB_TIMEOUT_MS = 60000;
const PROGRESS_THROTTLE_MS = 100;

const cancelRequested = new Set();

// ═══════════════════════════════════════════════════════════
//  DB Request-Response — Comunicação com Main Process
// ═══════════════════════════════════════════════════════════

const dbRequests = new Map();
let dbSeq = 0;

function requestDB(type, payload) {
  return new Promise((resolve, reject) => {
    const requestId = `db_${++dbSeq}_${Date.now()}`;
    dbRequests.set(requestId, { resolve, reject });

    parentPort.postMessage({ type, requestId, payload });

    setTimeout(() => {
      if (dbRequests.has(requestId)) {
        dbRequests.delete(requestId);
        reject(new Error('DB request timeout'));
      }
    }, DB_TIMEOUT_MS);
  });
}

parentPort.on('message', async (msg) => {
  if (msg.type === 'dbResponse') {
    const req = dbRequests.get(msg.requestId);
    if (req) {
      dbRequests.delete(msg.requestId);
      if (msg.ok) {
        req.resolve(msg.data);
      } else {
        req.reject(new Error(msg.error || 'DB error'));
      }
    }
    return;
  }

  if (msg.action === 'cancel') {
    if (msg.runId) cancelRequested.add(msg.runId);
    return;
  }

  if (msg.action === 'start') {
    try {
      await handleStart(msg);
    } catch (err) {
      cancelRequested.delete(msg.runId);
      send({
        type: 'simError',
        payload: { runId: msg.runId, message: err.message || String(err) }
      });
    }
  }
});

// ═══════════════════════════════════════════════════════════
//  SIMULAÇÃO
// ═══════════════════════════════════════════════════════════

async function handleStart({ runId, universe, params }) {
  const messages = [];
  const list = Array.isArray(universe) ? universe : [];

  if (cancelRequested.has(runId)) {
    cancelRequested.delete(runId);
    send({ type: 'simResult', payload: { runId, result: { ok: false, cancelled: true, messages } } });
    return;
  }

  const built = [];
  let lastLoadAt = 0;
  let lastTicker = null;
  for (let i = 0; i < list.length; i++) {
    const u = list[i];
    if (cancelRequested.has(runId)) break;

    lastTicker = u.ticker;
    const now = Date.now();
    if (now - lastLoadAt >= PROGRESS_THROTTLE_MS) {
      lastLoadAt = now;
      const current = i + 1;
      send({
        type: 'simProgress',
        payload: {
          runId,
          current,
          total: list.length,
          ticker: u.ticker,
          percent: Math.round((current / list.length) * 100)
        }
      });
    }

    let candles = null;
    try {
      candles = await requestDB('getAllHistoricalPrices', { ticker: u.ticker });
    } catch (err) {
      const ticker = u && u.ticker ? u.ticker : '?';
      messages.push(`${ticker}: falha ao carregar candles — ${err.message || String(err)}`);
      continue;
    }

    if (!candles || candles.length === 0) {
      messages.push(`${u.ticker}: sem candles disponíveis`);
      continue;
    }

    built.push({ ticker: u.ticker, name: u.name || u.ticker, candles });
  }

  if (cancelRequested.has(runId)) {
    cancelRequested.delete(runId);
    send({ type: 'simResult', payload: { runId, result: { ok: false, cancelled: true, messages } } });
    return;
  }

  let lastProgressAt = 0;
  let lastPercent = 0;

  const result = await runSimulation({
    universe: built,
    params,
    hooks: {
      onProgress(percent) {
        lastPercent = percent;
        const now = Date.now();
        if (percent < 100 && now - lastProgressAt < PROGRESS_THROTTLE_MS) return;
        lastProgressAt = now;
        send({ type: 'simProgress', payload: { runId, percent, ticker: lastTicker } });
      },
      onStatus(message) {
        const now = Date.now();
        if (now - lastProgressAt < PROGRESS_THROTTLE_MS) return;
        lastProgressAt = now;
        send({ type: 'simProgress', payload: { runId, percent: lastPercent, message, ticker: lastTicker } });
      },
      cancelled: () => cancelRequested.has(runId)
    }
  });

  result.messages = messages.concat(result.messages || []);
  cancelRequested.delete(runId);

  send({ type: 'simResult', payload: { runId, result } });
}

// ═══════════════════════════════════════════════════════════
//  Mensageria
// ═══════════════════════════════════════════════════════════

function send(msg) {
  parentPort.postMessage(msg);
}
