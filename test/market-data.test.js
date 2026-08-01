const assert = require('node:assert/strict');
const test = require('node:test');
const axios = require('axios');
const { fetchStockHistory, parseYahooPayload, parseStooqCsv } = require('../src/services/marketDataService');

function yahooPayload() {
  return {
    chart: { result: [{
      timestamp: [1704153600, 1704240000],
      indicators: { quote: [{ open: [10, 11], high: [12, 13], low: [9, 10], close: [11, 12], volume: [100, 200] }] }
    }] }
  };
}

const stooq = 'Date,Open,High,Low,Close,Volume\n2024-01-02,10,12,9,11,100\n2024-01-01,9,11,8,10,90';

test('Yahoo sucesso e payload vazio são tratados sem rede real', async () => {
  const original = axios.get;
  try {
    let calls = 0;
    axios.get = async url => {
      calls += 1;
      assert.match(url, /query1\.finance\.yahoo\.com/);
      return { data: yahooPayload() };
    };
    const candles = await fetchStockHistory('AAA', new Date('2024-01-01T00:00:00Z'));
    assert.equal(candles.length, 2);
    assert.deepEqual(candles.map(c => c.date), ['2024-01-02', '2024-01-03']);
    assert.equal(calls, 1);

    axios.get = async url => {
      if (url.includes('yahoo')) return { data: {} };
      return { data: stooq };
    };
    assert.equal((await fetchStockHistory('AAA')).length, 2);
  } finally { axios.get = original; }
});

for (const [label, error] of [
  ['404', Object.assign(new Error('not found'), { response: { status: 404 } })],
  ['429', Object.assign(new Error('rate limit'), { response: { status: 429 } })],
  ['timeout', Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })]
]) {
  test(`Yahoo ${label} faz fallback Stooq e termina deterministically`, async () => {
    const original = axios.get;
    const calls = [];
    try {
      axios.get = async url => {
        calls.push(url);
      if (url.includes('yahoo')) throw error;
        return { data: stooq };
      };
      const result = await fetchStockHistory('AAA.LS');
      assert.equal(result.status, 'partial');
      assert.equal(result.source, 'stooq');
      assert.equal(result.length, 2);
      assert.ok(calls.some(url => url.includes('yahoo')));
      assert.ok(calls.some(url => url.includes('stooq')));
    } finally { axios.get = original; }
  });
}

test('datas inválidas num payload Yahoo são descartadas', () => {
  const payload = yahooPayload();
  payload.chart.result[0].timestamp.push(Number.NaN);
  payload.chart.result[0].indicators.quote[0].close.push(13);
  assert.equal(parseYahooPayload(payload).length, 2);
});

test.todo('Stooq deve validar semanticamente datas string inválidas antes de as persistir');
test('parser Stooq ordena CSV válido e ignora cabeçalho sem dados', () => {
  assert.deepEqual(parseStooqCsv(stooq).map(c => c.date), ['2024-01-01', '2024-01-02']);
  assert.deepEqual(parseStooqCsv('No data'), []);
});
