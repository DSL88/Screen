'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { Worker } = require('worker_threads');
const path = require('path');

const WORKER = path.join(__dirname, '../src/engine/simulationWorker.js');

function synthCandles(seed, n, startYear) {
  let s = seed >>> 0;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  const out = [];
  let p = 60;
  for (let i = 0; i < n; i++) {
    p = Math.max(1, p * (1 + (rnd() - 0.47) * 0.05));
    const d = new Date(Date.UTC(startYear, 0, 1));
    d.setUTCDate(d.getUTCDate() + Math.round(i * 1.4));
    out.push({ date: d.toISOString().slice(0, 10), open: +(p * 0.99).toFixed(3), high: +(p * 1.03).toFixed(3), low: +(p * 0.96).toFixed(3), close: +p.toFixed(3), volume: Math.round(1e6 * (0.6 + rnd())) });
  }
  return out;
}

test('worker: modo workstation devolve relatório com os 5 blocos analíticos', async () => {
  const candles = synthCandles(5, 3000, 2016);
  const runId = 'sim_ws_test';

  const result = await new Promise((resolve, reject) => {
    const w = new Worker(WORKER);
    const timer = setTimeout(() => reject(new Error('timeout')), 25000);
    w.on('message', (msg) => {
      if (msg.type === 'simResult') { clearTimeout(timer); w.terminate(); resolve(msg.payload.result); }
      else if (msg.type === 'simError' && msg.payload && msg.payload.message && !msg.payload.ticker) {
        clearTimeout(timer); w.terminate(); reject(new Error(msg.payload.message));
      }
    });
    w.on('error', (e) => { clearTimeout(timer); reject(e); });
    w.postMessage({
      action: 'start',
      runId,
      universe: [{ ticker: 'TEST', name: 'TEST', candles }],
      params: { workstation: true, horizonYears: 20, endDate: '2026-01-01', convictionTier: 'moderate', rebalanceDays: 21, maxPositions: 3, mcIterations: 500 },
      startDate: null,
      endDate: '2026-01-01'
    });
  });

  assert.equal(result.ok, true);
  assert.equal(result.engine, 'workstation');
  assert.ok(result.globalKpis, 'Bloco A');
  assert.ok(Array.isArray(result.yearlyMatrix), 'Bloco B');
  assert.ok(result.calibrationTiers, 'Bloco C');
  assert.ok(Array.isArray(result.equityCurve) && Array.isArray(result.drawdownSeries), 'Bloco D');
  assert.ok(Array.isArray(result.trades), 'Bloco E');
  assert.ok(result.summary && result.summary.title.includes('Workstation'), 'título do card resumo');
});
