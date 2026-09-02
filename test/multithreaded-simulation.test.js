'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const os = require('os');
const path = require('path');
const quant = require('../src/native');
const { precalculateRollingVWAP } = require('../src/engine/backtesterEngine');

test('Multithreading & C++ Quant Engine: verificação de módulos e componentes', () => {
  // 1. Verificar módulo nativo e métodos expostos
  assert.equal(typeof quant.isNative, 'function', 'quant.isNative deve existir');
  assert.equal(typeof quant.isNativeAvailable, 'function', 'quant.isNativeAvailable deve existir');
  assert.equal(typeof quant.runMonteCarlo, 'function', 'quant.runMonteCarlo deve existir');
  assert.equal(typeof quant.computeMarkovModel, 'function', 'quant.computeMarkovModel deve existir');
  assert.equal(typeof quant._runMonteCarloJSFallback, 'function', 'quant._runMonteCarloJSFallback deve existir');

  assert.equal(typeof quant.isNative(), 'boolean', 'isNative deve retornar boolean');
  assert.equal(typeof quant.isNativeAvailable(), 'boolean', 'isNativeAvailable deve retornar boolean');

  // 2. Testar chamada de 8 argumentos posicionais no runMonteCarlo
  const matrix = [
    [0.7, 0.2, 0.1],
    [0.1, 0.8, 0.1],
    [0.2, 0.2, 0.6]
  ];
  const returns = [
    [0.02, 0.03, -0.01],
    [0.01, -0.01, 0.0],
    [-0.02, -0.03, 0.01]
  ];
  const currentState = 0;
  const startPrice = 100.0;

  const res8Args = quant.runMonteCarlo(matrix, returns, currentState, startPrice, 500, 35, 0.024, 0.048);
  assert.ok(res8Args, 'runMonteCarlo com 8 args deve retornar resultado válido');
  assert.ok(typeof res8Args.winRateMC === 'number', 'res.winRateMC deve ser numérico');
  assert.ok(typeof res8Args.mcApproved === 'boolean', 'res.mcApproved deve ser boolean');
  assert.ok(typeof res8Args.mcTier === 'string', 'res.mcTier deve ser string');
  assert.ok(typeof res8Args.mcLabel === 'string', 'res.mcLabel deve ser string');
  assert.equal(res8Args.tpHits + res8Args.slHits + res8Args.expired, 500, 'A soma das trajetórias deve ser 500');

  // 3. Testar algoritmo de Rolling VWAP em janela deslizante O(N)
  const candles = [];
  for (let i = 0; i < 100; i++) {
    candles.push({
      date: `2024-01-${String(i + 1).padStart(2, '0')}`,
      open: 10 + (i % 5),
      high: 12 + (i % 5),
      low: 9 + (i % 5),
      close: 10 + (i % 5),
      volume: 1000 + i * 10
    });
  }

  const vwapArray = precalculateRollingVWAP(candles, 20);
  assert.equal(vwapArray.length, candles.length, 'Array de VWAP deve ter o mesmo tamanho das velas');
  for (let i = 0; i < vwapArray.length; i++) {
    assert.ok(Number.isFinite(vwapArray[i]), `VWAP no índice ${i} deve ser finito`);
    assert.ok(vwapArray[i] > 0, `VWAP no índice ${i} deve ser positivo`);
  }

  // 4. Testar particionamento de tickers em chunks por CPUs
  const numCores = Math.max(1, os.cpus().length - 1);
  const tickers = Array.from({ length: 25 }, (_, i) => `TICKER_${i}`);
  const workerCount = Math.min(numCores, tickers.length);
  const chunks = Array.from({ length: workerCount }, () => []);

  tickers.forEach((t, index) => {
    chunks[index % workerCount].push(t);
  });

  assert.equal(chunks.length, workerCount);
  const totalTickersInChunks = chunks.reduce((acc, chunk) => acc + chunk.length, 0);
  assert.equal(totalTickersInChunks, tickers.length, 'Todos os tickers devem ser distribuídos');
});
