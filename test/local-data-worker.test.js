'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { Worker } = require('node:worker_threads');

// ═══════════════════════════════════════════════════════════
//  Helpers — histórico sintético diário (datas YYYY-MM-DD)
// ═══════════════════════════════════════════════════════════

function dateAt(start, i) {
  return new Date(new Date(start + 'T00:00:00Z').getTime() + i * 86400000).toISOString().slice(0, 10);
}

function buildSeries(count, start = '2020-01-01') {
  return Array.from({ length: count }, (_, i) => ({
    date: dateAt(start, i),
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    volume: 1000
  }));
}

const START = '2020-01-01';
const END = dateAt(START, 249);

// ═══════════════════════════════════════════════════════════
//  Emulador do main process (DB request-response)
// ═══════════════════════════════════════════════════════════

function runSimulationWorker({ ticker, candles, params }) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, '../src/engine/simulationWorker.js'));
    const simErrors = [];
    const timer = setTimeout(() => reject(new Error('worker timeout')), 8000);

    const finish = (value) => { clearTimeout(timer); resolve(value); };

    worker.on('message', message => {
      if (message.type === 'getAllHistoricalPrices') {
        assert.equal(message.payload.ticker, 'BAS.DE', 'worker deve sanitizar o ticker para UPPERCASE');
        worker.postMessage({
          type: 'dbResponse',
          requestId: message.requestId,
          ok: true,
          data: candles
        });
        return;
      }
      if (message.type === 'simError') {
        simErrors.push(message.payload);
        return;
      }
      if (message.type === 'simResult') {
        finish({ result: message.payload.result, simErrors, worker });
      }
    });

    worker.on('error', err => { clearTimeout(timer); reject(err); });

    worker.postMessage({
      action: 'start',
      runId: 'local-data-' + Date.now(),
      universe: [{ ticker, name: 'BAS' }],
      params,
      dbPath: undefined,
      startDate: START,
      endDate: END
    });
  });
}

const baseParams = {
  warmup: 20,
  direction: 'both',
  exitMode: 'full',
  stopType: 'pct',
  stopLoss: 1.4,
  takeProfit: 2.8,
  trailingStop: false,
  vwapGate: true,
  mcMinPct: 50,
  markovMinPct: 55,
  initialCapital: 10000,
  riskPerTradePct: 2,
  commissionPct: 0,
  slippagePct: 0
};

test('worker sanitiza ticker para UPPERCASE e termina com simResult ok sem simError', async () => {
  const { result, simErrors, worker } = await runSimulationWorker({
    ticker: 'bas.de',
    candles: buildSeries(250),
    params: baseParams
  });
  try {
    assert.equal(result.ok, true);
    assert.equal(result.cancelled, false);
    assert.equal(simErrors.length, 0, 'com dados suficientes não deve haver simError');
    assert.ok(result.kpis.totalTrades >= 0);
  } finally {
    await worker.terminate();
  }
});

test('worker emite simError quando o histórico devolve vazio', async () => {
  const { result, simErrors, worker } = await runSimulationWorker({
    ticker: 'bas.de',
    candles: [],
    params: baseParams
  });
  try {
    assert.equal(simErrors.length, 1, 'deve emitir exatamente um simError');
    assert.ok(simErrors[0].message.includes('sem registos suficientes'));
    assert.equal(simErrors[0].ticker, 'BAS.DE');
    assert.equal(result.ok, true, 'simResult continua a ser emitido após o simError');
    assert.equal(result.trades.length, 0);
  } finally {
    await worker.terminate();
  }
});
