const assert = require('node:assert/strict');
const test = require('node:test');
const yahooModule = require('yahoo-finance2');
const yahoo = yahooModule.default || yahooModule;
const { fetchWithRetry, normalizeTicker, buildIncrementalPeriod1, fetchHistorySince } = require('../src/data/yahooClient');
const { makeRecentQuotes, withImmediateTimers } = require('./helpers');

test('normalização Yahoo cobre ações americanas e sufixos europeus', () => {
  assert.equal(normalizeTicker('BF.B'), 'BF-B');
  assert.equal(normalizeTicker(' BRK.A '), 'BRK-A');
  assert.equal(normalizeTicker('SONC.LS'), 'SONC.LS');
  assert.equal(normalizeTicker('A.B.C'), 'A-B-C');
});

test('Yahoo sucesso converte/deduplica cotações com mock determinístico', async () => {
  const original = yahoo.chart;
  try {
    yahoo.chart = async () => ({ quotes: [
      ...makeRecentQuotes(201),
      { date: new Date(), open: 1, high: 2, low: 1, close: 1, volume: 1 }
    ] });
    const candles = await withImmediateTimers(() => fetchWithRetry('AAA', '1d', 1));
    assert.ok(candles.length >= 200);
    assert.equal(candles.every(c => c.ticker === 'AAA'), true);
  } finally { yahoo.chart = original; }
});

test('Yahoo payload vazio representa 404 e não é repetido', async () => {
  const original = yahoo.chart;
  try {
    let calls = 0;
    yahoo.chart = async () => { calls += 1; return { quotes: [] }; };
    await assert.rejects(withImmediateTimers(() => fetchWithRetry('MISSING', '1d', 3)), error => error.isNotFound === true);
    assert.equal(calls, 1);
  } finally { yahoo.chart = original; }
});

test('Yahoo 429 e timeout respeitam número de tentativas', async () => {
  const original = yahoo.chart;
  try {
    let calls = 0;
    yahoo.chart = async () => { calls += 1; throw Object.assign(new Error('429 rate limit'), { code: 429 }); };
    await assert.rejects(withImmediateTimers(() => fetchWithRetry('AAA', '1d', 2)), /Rate Limit/);
    assert.equal(calls, 2);

    calls = 0;
    yahoo.chart = async () => { calls += 1; throw Object.assign(new Error('request timeout'), { code: 'ETIMEDOUT' }); };
    await assert.rejects(withImmediateTimers(() => fetchWithRetry('AAA', '1d', 2)), /timeout/);
    assert.equal(calls, 2);
  } finally { yahoo.chart = original; }
});

test.todo('Yahoo deve validar semanticamente strings de data, não apenas o comprimento do prefixo');

test('incremental period1 rejeita datas inválidas e avança um dia', () => {
  assert.equal(buildIncrementalPeriod1('invalid'), null);
  assert.equal(buildIncrementalPeriod1('2024-01-31').toISOString().slice(0, 10), '2024-02-01');
});

test('fetchHistorySince pede o bloco desde a data inicial e deduplica cotações', async () => {
  const original = yahoo.chart;
  try {
    let calledWith;
    yahoo.chart = async (ticker, opts) => { calledWith = { ticker, opts }; return { quotes: makeRecentQuotes(5) }; };
    const candles = await withImmediateTimers(() => fetchHistorySince('AAA', '2010-01-01'));
    assert.equal(calledWith.ticker, 'AAA');
    assert.equal(calledWith.opts.interval, '1d');
    assert.equal(calledWith.opts.period1.toISOString().slice(0, 10), '2010-01-01');
    assert.ok(candles.length >= 5);
    assert.equal(candles.every(c => c.ticker === 'AAA'), true);
  } finally { yahoo.chart = original; }
});

test('fetchHistorySince com data inválida recorre ao histórico completo', async () => {
  const original = yahoo.chart;
  try {
    let calls = 0;
    yahoo.chart = async () => { calls += 1; return { quotes: makeRecentQuotes(5) }; };
    const candles = await withImmediateTimers(() => fetchHistorySince('AAA', 'not-a-date'));
    assert.equal(calls, 1);
    assert.ok(candles.length >= 5);
  } finally { yahoo.chart = original; }
});
