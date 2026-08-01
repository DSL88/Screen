const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { Worker } = require('node:worker_threads');

test('worker publica progresso inicial e done para uma execução vazia', async () => {
  const worker = new Worker(path.join(__dirname, '../src/engine/scanner.worker.js'));
  const messages = [];
  try {
    const done = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('worker timeout')), 3000);
      worker.on('message', message => {
        messages.push(message);
        if (message.type === 'done') { clearTimeout(timer); resolve(message.payload); }
      });
      worker.on('error', reject);
      worker.postMessage({ action: 'scan', runId: 'empty-1', tickers: [], params: {
        markov_window: 100, volume_mult: 1, horizon_days: 5, edge_threshold: 0.15, useVolFilter: false
      }, timeframe: '1d' });
    });
    assert.equal(messages[0].type, 'progress');
    assert.equal(done.runId, 'empty-1');
    assert.equal(done.totalProcessed, 0);
  } finally { await worker.terminate(); }
});

test('worker aceita cancelamento determinístico antes do scan', async () => {
  const worker = new Worker(path.join(__dirname, '../src/engine/scanner.worker.js'));
  try {
    const done = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('worker timeout')), 3000);
      worker.on('message', message => {
        if (message.type === 'done') { clearTimeout(timer); resolve(message.payload); }
      });
      worker.on('error', reject);
    });
    worker.postMessage({ action: 'cancel', runId: 'cancel-worker-1' });
    worker.postMessage({ action: 'scan', runId: 'cancel-worker-1', tickers: [{ ticker: 'NOPE' }], params: {
      markov_window: 100, volume_mult: 1, horizon_days: 5, edge_threshold: 0.15, useVolFilter: false
    }, timeframe: '1d' });
    const payload = await done;
    assert.equal(payload.totalProcessed, 0);
  } finally { await worker.terminate(); }
});
