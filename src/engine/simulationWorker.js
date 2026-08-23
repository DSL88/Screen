'use strict';

const { parentPort, workerData } = require('worker_threads');
const { runSimulation } = require('./backtesterEngine');

// Spec Passo 3 – modo workerData (START_SIMULATION) – execução direta ao arrancar
// Mantém compatibilidade com modo message-based (simulation:start)
if (workerData && workerData.dbPath && Array.isArray(workerData.tickers)) {
  (async () => {
    try {
      const Database = require('better-sqlite3');
      const BacktesterEngine = require('./backtesterEngine').BacktesterEngine || require('./backtesterEngine');
      const BE = (BacktesterEngine && BacktesterEngine.BacktesterEngine) ? BacktesterEngine.BacktesterEngine : BacktesterEngine;
      const quantEngine = require('../native');
      const { dbPath, tickers, startDate, endDate, config } = workerData;
      const db = new Database(dbPath, { readonly: true, fileMustExist: true });
      db.pragma('journal_mode = WAL');

      function loadCandlesForWorker(ticker, start, end) {
        const cleanTicker = String(ticker).trim().toUpperCase();
        if (!start && !end) {
          return db.prepare(`SELECT date, open, high, low, close, volume FROM historical_prices WHERE UPPER(TRIM(ticker)) = ? ORDER BY date ASC`).all(cleanTicker);
        }
        const cleanStart = String(start).slice(0, 10);
        const cleanEnd = end ? String(end).slice(0, 10) : '9999-12-31';
        const warmup = db.prepare(`SELECT date, open, high, low, close, volume FROM historical_prices WHERE UPPER(TRIM(ticker)) = ? AND date < ? ORDER BY date DESC LIMIT 200`).all(cleanTicker, cleanStart).reverse();
        const main = db.prepare(`SELECT date, open, high, low, close, volume FROM historical_prices WHERE UPPER(TRIM(ticker)) = ? AND date >= ? AND date <= ? ORDER BY date ASC`).all(cleanTicker, cleanStart, cleanEnd);
        return [...warmup, ...main];
      }

      const results = [];
      const total = tickers.length;
      let lastProgressTime = 0;

      for (let i = 0; i < total; i++) {
        const ticker = tickers[i];
        const rawCandles = loadCandlesForWorker(ticker, startDate, endDate);
        const candles = rawCandles.map(c => ({
          ticker,
          date: String(c.date).slice(0, 10),
          open: Number(c.open),
          high: Number(c.high),
          low: Number(c.low),
          close: Number(c.close),
          volume: Number(c.volume || 0)
        }));

        if (candles.length >= 220) {
          const EngineCls = BE.BacktesterEngine || BE;
          const engine = new EngineCls(config);
          const simRes = engine.run(candles, quantEngine);
          if (simRes) results.push({ ticker, ...simRes });
        }

        const now = Date.now();
        if (i === total - 1 || now - lastProgressTime >= 100 || (i + 1) % 5 === 0) {
          lastProgressTime = now;
          parentPort.postMessage({
            type: 'PROGRESS',
            data: {
              deltaProcessed: 1,
              current: i + 1,
              total,
              ticker,
              tradesCount: results.length,
              percent: Math.round(((i + 1) / total) * 100)
            }
          });
        }
      }
      db.close();
      parentPort.postMessage({ type: 'COMPLETE', results });
    } catch (e) {
      try { parentPort.postMessage({ type: 'ERROR', error: e.message || String(e) }); } catch (_) {}
    }
  })();
}

const DB_TIMEOUT_MS = 60000;
const PROGRESS_THROTTLE_MS = 100;
const MIN_CANDLES = 20;

const cancelRequested = new Set();

function toISODate(v) {
  return String(v || '').slice(0, 10);
}

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

function loadLocalCandles(dbPath, ticker, startDate, endDate) {
  const Database = require('better-sqlite3');
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    db.pragma('journal_mode = WAL');
    const cleanTicker = String(ticker || '').trim().toUpperCase();
    const toRow = row => ({
      date: String(row.date).slice(0, 10),
      open: Number(row.open),
      high: Number(row.high),
      low: Number(row.low),
      close: Number(row.close),
      volume: Number(row.volume || 0)
    });

    if (!startDate && !endDate) {
      const rows = db.prepare(`
        SELECT date, open, high, low, close, volume
        FROM historical_prices
        WHERE UPPER(TRIM(ticker)) = ?
        ORDER BY date ASC
      `).all(cleanTicker);
      return rows.map(toRow);
    }

    const cleanStart = String(startDate || '').slice(0, 10);
    const cleanEnd = endDate ? String(endDate).slice(0, 10) : '9999-12-31';
    const warmup = db.prepare(`
      SELECT date, open, high, low, close, volume
      FROM historical_prices
      WHERE UPPER(TRIM(ticker)) = ? AND date < ?
      ORDER BY date DESC
      LIMIT 200
    `).all(cleanTicker, cleanStart).reverse();
    const main = db.prepare(`
      SELECT date, open, high, low, close, volume
      FROM historical_prices
      WHERE UPPER(TRIM(ticker)) = ? AND date >= ? AND date <= ?
      ORDER BY date ASC
    `).all(cleanTicker, cleanStart, cleanEnd);
    return [...warmup, ...main].map(toRow);
  } finally {
    db.close();
  }
}

async function handleStart({ runId, universe, params, dbPath, startDate, endDate }) {
  const messages = [];
  const list = Array.isArray(universe) ? universe : [];
  const start = toISODate(startDate);
  const end = toISODate(endDate);
  const simParams = {
    ...(params || {}),
    startDate: start,
    endDate: end
  };

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

    const ticker = String(u.ticker || '').trim().toUpperCase();
    if (!ticker) continue;
    lastTicker = ticker;

    const now = Date.now();
    if (now - lastLoadAt >= PROGRESS_THROTTLE_MS || i === list.length - 1) {
      lastLoadAt = now;
      const current = i + 1;
      send({
        type: 'simProgress',
        payload: {
          runId,
          current,
          total: list.length,
          ticker,
          percent: Math.round((current / list.length) * 100)
        }
      });
    }

    let candles = null;
    let candlesError = null;

    // Carregamento direto e rápido via SQLite local no worker quando dbPath disponível
    if (dbPath) {
      try {
        candles = loadLocalCandles(dbPath, ticker, start, end);
      } catch (err) {
        candlesError = err;
      }
    }

    // Fallback para IPC se necessário
    if (!candles || candles.length === 0) {
      try {
        candles = await requestDB('getHistoricalPricesForSimulation', { ticker, startDate: start, endDate: end });
      } catch (err) {
        candlesError = candlesError || err;
      }
    }

    if (!candles || candles.length < MIN_CANDLES) {
      if (candlesError) {
        messages.push(`${ticker}: ${candlesError.message || String(candlesError)}`);
      }
      const message = 'Ativo sem registos suficientes na base de dados SQLite.';
      send({ type: 'simError', payload: { runId, ticker, message } });
      messages.push(message);
      continue;
    }

    built.push({ ticker, name: u.name || ticker, candles });
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
    params: simParams,
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
