'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { Worker } = require('worker_threads');
const path = require('path');

const WORKER = path.join(__dirname, '../src/engine/simulationWorker.js');

function synth(seed, n, y) {
  let s = seed >>> 0;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  const out = []; let p = 60;
  for (let i = 0; i < n; i++) {
    p = Math.max(1, p * (1 + (rnd() - 0.46) * 0.05));
    const d = new Date(Date.UTC(y, 0, 1)); d.setUTCDate(d.getUTCDate() + i);
    out.push({ date: d.toISOString().slice(0, 10), open: p, high: p * 1.03, low: p * 0.96, close: p, volume: 1e6 });
  }
  return out;
}

test('worker: modo carteira (engine=portfolio) devolve relatório multi-ativo completo', async () => {
  const universe = [
    { ticker: 'MSFT', name: 'MSFT', candles: synth(7, 1400, 2019) },
    { ticker: 'XOM', name: 'XOM', candles: synth(13, 1400, 2019) }
  ];
  const result = await new Promise((resolve, reject) => {
    const w = new Worker(WORKER);
    const timer = setTimeout(() => reject(new Error('timeout')), 40000);
    let percentSeen = false;
    w.on('message', (msg) => {
      if (msg.type === 'simProgress' && msg.payload && msg.payload.percent > 0) percentSeen = true;
      if (msg.type === 'simResult') { clearTimeout(timer); w.terminate(); resolve({ result: msg.payload.result, percentSeen }); }
      else if (msg.type === 'simError' && msg.payload && !msg.payload.ticker) { clearTimeout(timer); w.terminate(); reject(new Error(msg.payload.message)); }
    });
    w.on('error', (e) => { clearTimeout(timer); reject(e); });
    w.postMessage({
      action: 'start',
      runId: 'sim_pf_test',
      universe,
      params: { engine: 'portfolio', portfolio: true, positionAllocationPct: 0.20, maxPositions: 5, stopLoss: 2.4, takeProfit: 4.8, horizonDays: 35, mcIterations: 400 },
      startDate: null,
      endDate: null
    });
  });

  const r = result.result;
  assert.equal(r.ok, true);
  assert.equal(r.engine, 'portfolio');
  assert.equal(r.initialCapital, 10000);
  assert.ok(result.percentSeen, 'worker deve emitir progresso com percentuais');
  // nunca excede 5 posições simultâneas
  for (const p of (r.equityCurve || [])) {
    if (p.openPositionsCount != null) assert.ok(p.openPositionsCount <= 5);
  }
  assert.ok(r.globalKpis && r.calibrationTiers && Array.isArray(r.yearlyMatrix), 'blocos A–E presentes');
  if (r.trades.length) {
    for (const t of r.trades) {
      assert.ok(['TAKE_PROFIT', 'STOP_LOSS', 'EXPIRED_HORIZON', 'FIM_PERIODO'].includes(t.reason), `razão inesperada: ${t.reason}`);
    }
  }
});
