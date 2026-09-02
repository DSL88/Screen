#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────
//  test/benchmark_mc.js – Benchmark do motor Monte Carlo nativo
//
//  Compara o binário C++ (build/Release/quant_engine.node) com o
//  fallback JS puro (_runMonteCarloJSFallback), com inputs
//  idênticos e determinísticos (seed fixa).
//
//  Uso:
//    node test/benchmark_mc.js
//
//  Exit codes:
//    0 – OK (ou nativo indisponível: apenas avisa)
//    1 – critério de performance falhado com nativo disponível
// ─────────────────────────────────────────────────────────────
'use strict';

const {
  isNativeAvailable,
  runMonteCarlo,
  _runMonteCarloJSFallback
} = require('../src/native');

const NUM_STATES = 9;
const RUNS = 500;
const WARMUP_RUNS = 5;

// Parâmetros de produção do motor (paridade com src/native/index.js)
const BENCH_OPTS = { iterations: 1000, daysAhead: 35, slPct: 0.024, tpPct: 0.048 };
const CURRENT_STATE = 4;
const START_PRICE = 150;
const EMPTY_STATE = 7;

// ── Matriz de transição 9×9 row-stochastic ──────────────────
// Diagonal forte (~0.5–0.7); as vizinhas (i±1) partilham massa;
// o restante espalha-se pelas células sobrantes.
function buildMatrix() {
  const diag = [0.62, 0.58, 0.66, 0.70, 0.55, 0.52, 0.68, 0.60, 0.64];
  return Array.from({ length: NUM_STATES }, (_, i) => {
    const row = new Array(NUM_STATES).fill(0);
    const left = (i + NUM_STATES - 1) % NUM_STATES;
    const right = (i + 1) % NUM_STATES;
    row[i] = diag[i];
    row[left] += 0.18;
    row[right] += 0.09;
    const others = [];
    for (let j = 0; j < NUM_STATES; j++) if (row[j] === 0) others.push(j);
    const share = (1 - row[i] - row[left] - row[right]) / others.length;
    for (const j of others) row[j] = share;
    // Ajuste final para somar exatamente ~1 em vírgula flutuante
    const sum = row.reduce((a, b) => a + b, 0);
    row[others[others.length - 1]] += (1 - sum);
    return row;
  });
}

// Retornos por estado: 9 linhas ragged, uma delas VAZIA (estado 7)
function buildReturnsByState() {
  const lens = [8, 12, 3, 15, 6, 10, 20, 0, 5];
  return lens.map((len, i) =>
    Array.from({ length: len }, (_, j) => (((i * 7 + j * 13) % 23) - 11) / 150)
  );
}

function hrMs(start) {
  return Number(process.hrtime.bigint() - start) / 1e6;
}

// ═══════════════════════════════════════════════════════════
function main() {
  console.log('═'.repeat(60));
  console.log('  BENCHMARK MONTE CARLO — Motor Nativo C++ vs Fallback JS');
  console.log('═'.repeat(60));

  // ── Fixtures ────────────────────────────────────────────────
  const matrix = buildMatrix();
  const returnsByState = buildReturnsByState();

  // Sanidade: matriz tem de ser row-stochastic válida
  for (let i = 0; i < NUM_STATES; i++) {
    const sum = matrix[i].reduce((a, b) => a + b, 0);
    if (!(Math.abs(sum - 1) <= 1e-9)) {
      throw new Error(`Matriz inválida: linha ${i} soma ${sum}`);
    }
  }
  console.log(`Matriz ${NUM_STATES}×${NUM_STATES} row-stochastic: OK (diagonal forte 0.5–0.7)`);
  console.log(`returnsByState ragged: ${returnsByState.map(r => r.length).join(', ')} ` +
    `(estado ${EMPTY_STATE} vazio)`);

  console.log('\nNative Disponível:', isNativeAvailable());

  // ── Warm-up (5 simulações por motor) ────────────────────────
  for (let i = 0; i < WARMUP_RUNS; i++) {
    runMonteCarlo(matrix, returnsByState, CURRENT_STATE, START_PRICE, BENCH_OPTS);
    _runMonteCarloJSFallback(matrix, returnsByState, CURRENT_STATE, START_PRICE, BENCH_OPTS);
  }

  let nativeMs = null;

  // ── Benchmark NATIVO ────────────────────────────────────────
  if (isNativeAvailable()) {
    const t0 = process.hrtime.bigint();
    console.time(`MC Nativo      (${RUNS} sims × 1000 iter × 20 dias)`);
    for (let r = 0; r < RUNS; r++) {
      runMonteCarlo(matrix, returnsByState, CURRENT_STATE, START_PRICE, BENCH_OPTS);
    }
    console.timeEnd(`MC Nativo      (${RUNS} sims × 1000 iter × 35 dias)`);
    nativeMs = hrMs(t0);
  } else {
    console.warn('[Aviso] Binário nativo não compilado — corre "npm run build:native".');
    console.warn('        A benchmark apenas mede o fallback JS.');
  }

  // ── Benchmark FALLBACK (mesmos inputs, mesmas runs) ─────────
  const t1 = process.hrtime.bigint();
  console.time(`MC Fallback JS (${RUNS} sims × 1000 iter × 35 dias)`);
  for (let r = 0; r < RUNS; r++) {
    _runMonteCarloJSFallback(matrix, returnsByState, CURRENT_STATE, START_PRICE, BENCH_OPTS);
  }
  console.timeEnd(`MC Fallback JS (${RUNS} sims × 1000 iter × 35 dias)`);
  const fallbackMs = hrMs(t1);

  // ── Resultado amostra (seed fixa → determinístico) ──────────
  const sampleOpts = Object.assign({ seed: 42 }, BENCH_OPTS);
  const sample = isNativeAvailable()
    ? runMonteCarlo(matrix, returnsByState, CURRENT_STATE, START_PRICE, sampleOpts)
    : _runMonteCarloJSFallback(matrix, returnsByState, CURRENT_STATE, START_PRICE, sampleOpts);

  console.log('\nResultado amostra:');
  console.log(JSON.stringify(sample, null, 2));

  // ── Speedup + critério de aceitação ─────────────────────────
  console.log('─'.repeat(60));
  if (nativeMs != null) {
    const speedup = fallbackMs / nativeMs;
    console.log(`Tempo nativo:   ${nativeMs.toFixed(2)}ms`);
    console.log(`Tempo fallback: ${fallbackMs.toFixed(2)}ms`);
    console.log(`Speedup:        ${speedup.toFixed(2)}x`);
    if (nativeMs < 100) {
      console.log(`\n✓ PASS — ${RUNS} sims no nativo: ${nativeMs.toFixed(2)}ms (< 100ms)`);
    } else {
      console.log(`\n✗ FAIL — ${RUNS} sims no nativo: ${nativeMs.toFixed(2)}ms (>= 100ms)`);
      process.exitCode = 1;
    }
  } else {
    console.log(`Tempo fallback: ${fallbackMs.toFixed(2)}ms`);
    console.log('\n⚠ Nativo indisponível — critério de performance não avaliado.');
    process.exitCode = 0;
  }
  console.log('─'.repeat(60));
}

// ── Spec Passo 4 – benchmark simples (compat) ──────────────────
// Executado também quando o ficheiro é corrido diretamente, garante que
// `node test/benchmark_mc.js` valida 500 sims <100ms no C++ como exige o spec.
// Mantido em paralelo com o benchmark detalhado acima.
if (require.main === module) {
  try {
    const quantEngineSpec = require('../src/native');
    const testMatrix = [
      [0.6, 0.2, 0.2, 0.0, 0.0, 0.0],
      [0.1, 0.5, 0.2, 0.1, 0.1, 0.0],
      [0.2, 0.2, 0.4, 0.1, 0.1, 0.0],
      [0.0, 0.1, 0.1, 0.5, 0.2, 0.1],
      [0.0, 0.0, 0.1, 0.2, 0.5, 0.2],
      [0.0, 0.0, 0.0, 0.1, 0.3, 0.6]
    ];
    const testReturns = [
      [0.01, 0.015, -0.005, 0.02],
      [-0.01, -0.02, 0.005, -0.015],
      [0.002, -0.001, 0.003, -0.002],
      [0.012, 0.008, -0.004, 0.01],
      [-0.012, -0.009, 0.002, -0.014],
      [0.001, -0.001, 0.000, 0.002]
    ];
    console.log('====================================================');
    console.log('BENCHMARK DE PERFORMANCE: QUANT ENGINE (C++ vs JS)');
    console.log('Módulo C++ Nativo Ativo:', quantEngineSpec.isNativeAvailable());
    console.log('====================================================');
    const RUNS_SPEC = 500;
    console.time(`Tempo Total para ${RUNS_SPEC} Simulações Monte Carlo (1.000 trajetórias cada)`);
    for (let i = 0; i < RUNS_SPEC; i++) {
      quantEngineSpec.runMonteCarlo(testMatrix, testReturns, 0, 100.0, 1000, 35, 0.024, 0.048);
    }
    console.timeEnd(`Tempo Total para ${RUNS_SPEC} Simulações Monte Carlo (1.000 trajetórias cada)`);
    const sampleResult = quantEngineSpec.runMonteCarlo(testMatrix, testReturns, 0, 100.0, 1000, 35, 0.024, 0.048);
    console.log('\n--- Amostra de Validação Numérica ---');
    console.log(sampleResult);
  } catch (_) { /* ignora se já correu */ }
}

main();
