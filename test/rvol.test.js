const assert = require('node:assert/strict');
const test = require('node:test');

const { calculateRVOL } = require('../src/quant/indicators');
const { analyzeSeries, shouldEmit } = require('../src/quant/markovEngine');

function candle(volume, close = 100) {
  return { date: '2024-01-01', open: close, high: close + 1, low: close - 1, close, volume };
}

test('calculateRVOL usa SMA das 20 velas anteriores à vela atual', () => {
  const candles = [];
  for (let i = 0; i < 30; i++) candles.push(candle(100));
  candles.push(candle(200)); // última: volume 200

  const res = calculateRVOL(candles, 20);
  // SMA(20) das velas anteriores (índices 10..29) = 100; RVOL = 200/100 = 2
  assert.equal(res.avgVolume, 100);
  assert.ok(Math.abs(res.rvol - 2.0) < 1e-9, `rvol=${res.rvol}`);
  assert.equal(res.isVolumeConfirmed, true);
});

test('calculateRVOL marca não confirmado quando RVOL < 1.0', () => {
  const candles = [];
  for (let i = 0; i < 30; i++) candles.push(candle(100));
  candles.push(candle(50)); // volume abaixo da média

  const res = calculateRVOL(candles, 20);
  assert.ok(Math.abs(res.rvol - 0.5) < 1e-9, `rvol=${res.rvol}`);
  assert.equal(res.isVolumeConfirmed, false);
});

test('calculateRVOL nunca divide por zero com volume nulo/vazio', () => {
  // Média zero (todos os volumes nulos) → sem erro de divisão
  const candles = [];
  for (let i = 0; i < 25; i++) candles.push(candle(0));
  const res = calculateRVOL(candles, 20);
  assert.equal(res.avgVolume, 0);
  assert.equal(res.rvol, 0);
  assert.equal(res.isVolumeConfirmed, false);

  // Volume não numérico higienizado para 0
  const dirty = [];
  for (let i = 0; i < 25; i++) dirty.push({ ...candle(100), volume: i === 24 ? 'abc' : null });
  const res2 = calculateRVOL(dirty, 20);
  assert.ok(Number.isFinite(res2.rvol));
  assert.equal(res2.isVolumeConfirmed, false);
});

test('calculateRVOL devolve fallback com menos de period+1 velas', () => {
  const candles = Array.from({ length: 10 }, () => candle(100));
  const res = calculateRVOL(candles, 20);
  assert.equal(res.rvol, 0);
  assert.equal(res.isVolumeConfirmed, false);
  assert.equal(res.avgVolume, 0);
});

test('analyzeSeries expõe rvol e rvolApproved', () => {
  const candles = [];
  for (let i = 0; i < 80; i++) candles.push(candle(100, 100 + (i % 3)));
  candles.push(candle(200, 101));

  const res = analyzeSeries(candles, { useVolFilter: false, rvolMin: 1.0 });
  assert.equal(typeof res.rvol, 'number');
  assert.equal(typeof res.rvolApproved, 'boolean');
});

test('shouldEmit filtra COMPRA sem suporte de volume quando RVOL gate ativo', () => {
  const candles = [];
  for (let i = 0; i < 80; i++) candles.push(candle(100, 100 + (i % 3)));
  candles.push(candle(20, 101)); // RVOL < 1.0

  const res = analyzeSeries(candles, { useVolFilter: false, rvolMin: 1.0 });
  // Gate ativo → COMPRA com RVOL baixo deve ser rejeitada
  const emitted = shouldEmit(res, 0.15, false, true, 1.0);
  assert.equal(emitted, false);

  // Gate desativado → deve emitir (desde que o resto do sinal passe)
  if (res.direction === 'COMPRA') {
    const emittedNoGate = shouldEmit(res, 0.15, false, false, 1.0);
    assert.equal(emittedNoGate, true);
  }
});

test('shouldEmit aprova COMPRA com RVOL confirmado quando gate ativo', () => {
  const candles = [];
  for (let i = 0; i < 80; i++) candles.push(candle(100, 100 + (i % 3)));
  candles.push(candle(200, 101)); // RVOL > 1.0

  const res = analyzeSeries(candles, { useVolFilter: false, rvolMin: 1.0 });
  if (res.direction === 'COMPRA') {
    const emitted = shouldEmit(res, 0.15, false, true, 1.0);
    assert.equal(emitted, true);
  }
});
