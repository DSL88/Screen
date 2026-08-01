const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const { makeCandle } = require('./helpers');

const markovPath = require.resolve('../src/quant/markovEngine');
const monteCarloPath = require.resolve('../src/quant/monteCarloEngine');
const scannerPath = require.resolve('../src/engine/scanner');

function loadScanner() {
  require.cache[markovPath] = {
    id: markovPath, filename: markovPath, loaded: true,
    exports: {
      analyzeSeries: candles => ({ close: candles && candles.length ? candles[candles.length - 1].close : 100,
        date: candles && candles.length ? candles[candles.length - 1].date : '2024-01-01',
        direction: 'COMPRA', edge: 0.3, pStay: 0.5, pBull: 0.6, pBear: 0.4, atr: 1,
        stopLoss: 99, takeProfit: 102, rsi: 50, adx: 20, bbPct: 0.5, volumeValid: true,
        currentState: -1, transitionMatrix: null }),
      shouldEmit: result => result.close > 0
    }
  };
  require.cache[monteCarloPath] = {
    id: monteCarloPath, filename: monteCarloPath, loaded: true,
    exports: { runMarkovMonteCarloSimulation: () => ({ isApproved: true }) }
  };
  delete require.cache[scannerPath];
  return require(scannerPath);
}

function baseDb(getCandles) {
  return {
    getAdaptiveParams: () => ({ edge_threshold: 0.15, markov_window: 100, volume_mult: 1, horizon_days: 5 }),
    getOpenTrades: () => [],
    getLocalHistoricalPricesLimit: getCandles,
    insertSignal: signal => { dbSignals.push(signal); return dbSignals.length; },
    getClosedTrades: () => [],
    setAdaptiveParam() {}
  };
}

let dbSignals;

test('scanner persiste tickers válidos e mantém falhas parciais isoladas', { concurrency: false }, async () => {
  const Scanner = loadScanner();
  dbSignals = [];
  const good = Array.from({ length: 70 }, (_, i) => makeCandle('GOOD', `2024-01-${String(i + 1).padStart(2, '0')}`, 100 + i));
  const db = baseDb(ticker => {
    if (ticker === 'FAIL') throw new Error('mock fetch failure');
    return ticker === 'GOOD' ? good : [];
  });
  const errors = [];
  const done = [];
  await new Scanner(db).run({ tickers: [{ ticker: 'GOOD' }, { ticker: 'FAIL' }, { ticker: 'EMPTY' }] }, 'mixed-1', {
    onProgress() {}, onRow() {}, onError: e => errors.push(e), onDone: d => done.push(d)
  });
  assert.equal(dbSignals.length, 1);
  assert.equal(dbSignals[0].ticker, 'GOOD');
  assert.equal(errors.some(e => e.ticker === 'FAIL'), true);
  assert.equal(done[0].totalProcessed, 3);
});

test('scanner limita concorrência a cinco tarefas', { concurrency: false }, async () => {
  const Scanner = loadScanner();
  dbSignals = [];
  let active = 0;
  let maximum = 0;
  const candles = Array.from({ length: 70 }, (_, i) => makeCandle('X', `2024-02-${String(i + 1).padStart(2, '0')}`, 100));
  const db = baseDb(() => {
    active += 1;
    maximum = Math.max(maximum, active);
    active -= 1;
    return candles;
  });
  const tickers = Array.from({ length: 12 }, (_, i) => ({ ticker: `X${i}` }));
  await new Scanner(db).run({ tickers }, 'concurrent-1', { onProgress() {}, onRow() {}, onError() {}, onDone() {} });
  assert.ok(maximum <= 5, `observed concurrency=${maximum}`);
  assert.equal(dbSignals.length, 12);
});

test('cancelamento antes do dispatch não persiste nem processa tickers', { concurrency: false }, async () => {
  const Scanner = loadScanner();
  dbSignals = [];
  const scanner = new Scanner(baseDb(() => []));
  scanner.cancel('cancel-1');
  let done;
  await scanner.run({ tickers: [{ ticker: 'A' }, { ticker: 'B' }] }, 'cancel-1', {
    onProgress() {}, onRow() {}, onError() {}, onDone: d => { done = d; }
  });
  assert.equal(done.totalProcessed, 0);
  assert.equal(dbSignals.length, 0);
});

test.todo('Scanner/main devem publicar estado explícito success/partial/failed e contar falhas por ticker');
