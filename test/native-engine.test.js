'use strict';

// ═══════════════════════════════════════════════════════════
//  test/native-engine.test.js – Validação do motor quant nativo
//
//  Cobre:
//   1. Paridade nativo ↔ fallback JS (MC) — bit-exata em todos os
//      campos; `expectedValue` com tolerância de 1 ULP (contração
//      FMA do clang no build C++, ver nota junto dos helpers)
//   2. Determinismo por seed (mulberry32 partilhado)
//   3. Escalões ELITE / MODERATE / REJECTED nos dois motores
//   4. Guards de input inválido (estado/preço/matriz)
//   5. Simetria LONG ↔ SHORT (espelho matemático TP/SL)
//   6. Paridade da matriz de Markov (computeMarkovModel vs JS)
//   7. Delegação end-to-end via monteCarloEngine
//
//  Tudo determinístico: zero rede, zero Math.random real — os
//  RNGs são sempre semeados com opts.seed (mulberry32 idêntico
//  nos dois motores, ordem de draws igual).
//
//  A suite passa COM e SEM binário: os testes nativo-dependentes
//  fazem skip informativo quando o .node não está compilado ou
//  quando QUANT_FORCE_FALLBACK=1.
// ═══════════════════════════════════════════════════════════

const assert = require('node:assert/strict');
const test = require('node:test');

// ── Módulos sob teste ───────────────────────────────────────
// Loader oficial (respeita QUANT_FORCE_FALLBACK): fonte de verdade
// para isNativeAvailable() e para o fallback JS puro.
const quant = require('../src/native');
const { _runMonteCarloJSFallback } = quant;

// Binário carregado diretamente (mesma instância em cache que o
// loader usa — Node resolve ambos para o mesmo ficheiro).
let nativeBinary = null;
try {
  nativeBinary = require('../build/Release/quant_engine.node');
} catch (_) { /* ausente → skips */ }

const nativeOK = quant.isNativeAvailable();
const SKIP_MSG = 'binário nativo não compilado — corre npm run build:native';

const { buildTransitionMatrix, buildStateSeries, NUM_STATES,
        RSI_PERIOD, ADX_PERIOD, BB_PERIOD, BB_MULT } = require('../src/quant/markovEngine');
const { runMarkovMonteCarloSimulation, buildStateReturnsMap } = require('../src/quant/monteCarloEngine');
const { rsiWilder, adxWilder, bollingerBands } = require('../src/quant/indicators');

// ── Registo de motores (o par Nativo só existe se disponível) ─
const ENGINES = [];
if (nativeOK && nativeBinary) {
  ENGINES.push({
    nome: 'Nativo C++',
    run: (m, r, s, p, o) => nativeBinary.runMonteCarlo(m, r, s, p, o)
  });
}
ENGINES.push({
  nome: 'Fallback JS',
  run: (m, r, s, p, o) => _runMonteCarloJSFallback(m, r, s, p, o)
});

// Escolha "de produção": o motor que a delegação usaria neste modo
function directEngineRun(matrix, returnsByState, state, price, opts) {
  if (nativeOK && nativeBinary) {
    return nativeBinary.runMonteCarlo(matrix, returnsByState, state, price, opts);
  }
  return _runMonteCarloJSFallback(matrix, returnsByState, state, price, opts);
}

// ═══════════════════════════════════════════════════════════
//  FIXTURES DETERMINÍSTICAS
// ═══════════════════════════════════════════════════════════

const EMPTY_STATE = 7; // estado cuja linha de retornos é VAZIA

// Matriz 9×9 row-stochastic com diagonal forte (~0.5–0.7) e massa
// nas vizinhas (i±1) — garante vagueação entre estados (incluindo
// o estado vazio 7, vizinho de 6 e 8).
function buildStrongDiagonalMatrix() {
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
    const sum = row.reduce((a, b) => a + b, 0);
    row[others[others.length - 1]] += (1 - sum);
    return row;
  });
}

// Matriz identidade por linhas (estado nunca muda; 1 draw/dia na transição)
const UNIT_MATRIX = Array.from({ length: NUM_STATES }, (_, i) => {
  const row = new Array(NUM_STATES).fill(0);
  row[i] = 1;
  return row;
});

// Retornos ragged: linha 7 vazia; valores mistos ±7% aprox.
function buildRaggedReturns() {
  const lens = [8, 12, 3, 15, 6, 10, 20, 0, 5];
  return lens.map((len, i) =>
    Array.from({ length: len }, (_, j) => (((i * 7 + j * 13) % 23) - 11) / 150)
  );
}

function returnsOnly(values) {
  return Array.from({ length: NUM_STATES }, (_, i) => (i === 0 ? values.slice() : []));
}

const PARITY_OPTS = { iterations: 300, daysAhead: 20, slPct: 0.014, tpPct: 0.028 };

// Procura determinística (scan fixo de seeds) de um seed cujo nº
// de TPs caia num intervalo — usado para calibrar o escalão MODERATE.
function findSeedWithTpInRange(engineRun, cfg, minTp, maxTp, maxSeeds = 600) {
  for (let seed = 1; seed <= maxSeeds; seed++) {
    const res = engineRun(cfg.matrix, cfg.returnsByState, cfg.state, cfg.price,
      { iterations: cfg.iterations, daysAhead: 20, slPct: 0.014, tpPct: 0.028, side: 'LONG', seed });
    if (res.tpHits >= minTp && res.tpHits <= maxTp) return seed;
  }
  return null;
}

// ═══════════════════════════════════════════════════════════
//  PARIDADE — helpers
//
//  DESCOBERTA EMPÍRICA (ver nota no relatório): o caminho
//  estocástico é bit-exato (mesmos draws, mesmos contadores,
//  mesmo winRate). APENAS o escalar derivado `expectedValue`
//  diverge por ≤1 ULP (~1e-16 relativo): o clang (arm64, -O3)
//  contrai `((p·tp − (1−p)·sl)·100)` numa instrução FMA com
//  arredondamento único, ao contrário do V8. Ex.: nativo
//  0.6300000000000001 vs fallback 0.63. Como não é permitido
//  alterar produção (flags de compilação em binding.gyp), a
//  paridade do EV é afirmada a 1e-10 (≈40× acima de 1 ULP,
//  mas 6 ordens de grandeza abaixo da precisão útil em %),
//  mantendo deepStrictEqual global sobre o objeto normalizado.
// ═══════════════════════════════════════════════════════════

// Normaliza apenas o campo sujeito a contração FMA
function canon(res) {
  return Object.assign({}, res, { expectedValue: Number(res.expectedValue.toFixed(10)) });
}

// Paridade completa: objeto inteiro (com EV normalizado) + campos
// estocásticos/tier exigidos BIT-EXATOS campo a campo.
function assertParidade(nat, fb, ctx) {
  assert.deepStrictEqual(canon(nat), canon(fb),
    `divergência nativo↔fallback (${ctx})`);
  assert.equal(nat.winRate, fb.winRate, `winRate (${ctx})`);
  assert.equal(nat.tpHits, fb.tpHits, `tpHits (${ctx})`);
  assert.equal(nat.slHits, fb.slHits, `slHits (${ctx})`);
  assert.equal(nat.expired, fb.expired, `expired (${ctx})`);
  assert.equal(nat.isApproved, fb.isApproved, `isApproved (${ctx})`);
  assert.equal(nat.mcTier, fb.mcTier, `mcTier (${ctx})`);
  assert.equal(nat.mcLabel, fb.mcLabel, `mcLabel (${ctx})`);

  if (nat.expectedValue !== fb.expectedValue) {
    const scale = Math.max(Math.abs(nat.expectedValue), Math.abs(fb.expectedValue), 1);
    assert.ok(Math.abs(nat.expectedValue - fb.expectedValue) <= 1e-12 * scale,
      `expectedValue diverge mais que 1 ULP (${ctx}): ` +
      `${nat.expectedValue} vs ${fb.expectedValue}`);
  }
}

// ═══════════════════════════════════════════════════════════
//  1. PARIDADE BIT-EXATA nativo ↔ fallback (EV: ver nota FMA)
// ═══════════════════════════════════════════════════════════
test('MC: paridade bit-exata nativo ↔ fallback em seeds × lados × estados', { skip: nativeOK ? false : SKIP_MSG }, () => {
  const matrix = buildStrongDiagonalMatrix();
  const returnsByState = buildRaggedReturns();
  const seeds = [1, 42, 123456789, 4294967295]; // inclui UINT32_MAX
  const sides = ['LONG', 'SHORT'];
  const states = [0, 6, EMPTY_STATE]; // inclui estado com retornos VAZIOS

  let comparisons = 0;
  for (const seed of seeds) {
    for (const side of sides) {
      for (const state of states) {
        const opts = Object.assign({}, PARITY_OPTS, { side, seed });
        const nat = nativeBinary.runMonteCarlo(matrix, returnsByState, state, 100, opts);
        const fb = _runMonteCarloJSFallback(matrix, returnsByState, state, 100, opts);

        assertParidade(nat, fb, `seed=${seed} side=${side} state=${state}`);
        assert.ok(Number.isFinite(nat.winRate));
        comparisons++;
      }
    }
  }
  assert.equal(comparisons, seeds.length * sides.length * states.length);

  // Propriedade "linha vazia ⇒ preço imóvel": só vale se a cadeia
  // NUNCA sair do estado vazio → matriz unidade (estado 7 → 7).
  // Com a matriz diagonal-forte a cadeia migra para os vizinhos
  // 6/8, que TÊM retornos — pelo que aí já não expira tudo.
  const probe = nativeBinary.runMonteCarlo(UNIT_MATRIX, returnsByState, EMPTY_STATE, 100,
    Object.assign({}, PARITY_OPTS, { seed: 42 }));
  assert.equal(probe.expired, PARITY_OPTS.iterations,
    'matriz unidade + retornos vazios devia expirar todas as iterações');
  assert.equal(probe.winRate, 0);
  const fbProbe = _runMonteCarloJSFallback(UNIT_MATRIX, returnsByState, EMPTY_STATE, 100,
    Object.assign({}, PARITY_OPTS, { seed: 42 }));
  assertParidade(probe, fbProbe, 'estado vazio × matriz unidade');

  // Contraste (migração real): partindo do estado vazio com a matriz
  // diagonal-forte, os contadores continuam a somar `iterations`.
  const migrated = nativeBinary.runMonteCarlo(matrix, returnsByState, EMPTY_STATE, 100,
    Object.assign({}, PARITY_OPTS, { seed: 42 }));
  assert.equal(migrated.tpHits + migrated.slHits + migrated.expired, PARITY_OPTS.iterations);
});

// ═══════════════════════════════════════════════════════════
//  2. DETERMINISMO
// ═══════════════════════════════════════════════════════════
test('MC: mesma seed reproduz exatamente o mesmo resultado (ambos os motores)', () => {
  const matrix = buildStrongDiagonalMatrix();
  const returnsByState = buildRaggedReturns();

  for (const engine of ENGINES) {
    const a = engine.run(matrix, returnsByState, 6, 100, Object.assign({}, PARITY_OPTS, { seed: 2024 }));
    const b = engine.run(matrix, returnsByState, 6, 100, Object.assign({}, PARITY_OPTS, { seed: 2024 }));
    assert.deepStrictEqual(a, b, `motor ${engine.nome} não é determinístico com a mesma seed`);
  }
});

test('MC: seeds diferentes produzem resultados distintos (caso estável)', () => {
  const matrix = buildStrongDiagonalMatrix();
  const returnsByState = buildRaggedReturns();

  for (const engine of ENGINES) {
    const a = engine.run(matrix, returnsByState, 6, 100, Object.assign({}, PARITY_OPTS, { seed: 1 }));
    const b = engine.run(matrix, returnsByState, 6, 100, Object.assign({}, PARITY_OPTS, { seed: 999999 }));
    const differingFields =
      ['tpHits', 'slHits', 'expired'].filter(k => a[k] !== b[k]).length;
    assert.ok(differingFields >= 1,
      `motor ${engine.nome}: esperava ≥1 campo distinto entre seeds 1 e 999999 ` +
      `(a=${JSON.stringify([a.tpHits, a.slHits, a.expired])}, ` +
      `b=${JSON.stringify([b.tpHits, b.slHits, b.expired])})`);
  }
});

// ═══════════════════════════════════════════════════════════
//  3. ESCALÕES (tiers) — validados nos DOIS motores
// ═══════════════════════════════════════════════════════════
test('Escalões: retornos só-positivos → ELITE / "Alta Probabilidade" / aprovado', () => {
  const matrix = UNIT_MATRIX;
  const returnsByState = returnsOnly([0.05]); // +5%/dia → TP (+2.8%) no 1º dia

  for (const engine of ENGINES) {
    const res = engine.run(matrix, returnsByState, 0, 50, { ...PARITY_OPTS, seed: 7 });
    assert.equal(res.mcTier, 'ELITE', `motor ${engine.nome}`);
    assert.equal(res.mcLabel, 'Alta Probabilidade', `motor ${engine.nome}`);
    assert.equal(res.isApproved, true, `motor ${engine.nome}`);
    assert.equal(res.winRate, 100, `motor ${engine.nome}`);
  }
});

test('Escalões: retornos mistos calibrados → MODERATE / "Probabilidade Moderada"', () => {
  const matrix = UNIT_MATRIX;
  // p(TP no dia 1)=1/3; senão 0.99 sobrevive ao SL (0.986) e decide no dia 2
  // → taxa teórica de TP ≈ 55.6%, confortavelmente dentro de [50, 65).
  const returnsByState = returnsOnly([0.04, -0.01, -0.01]);
  const cfg = { matrix, returnsByState, state: 0, price: 50, iterations: 1000 };

  // Seed procurada deterministicamente (scan fixo): tpHits ∈ [520, 630]
  const refEngine = ENGINES[ENGINES.length - 1];
  const seed = findSeedWithTpInRange(refEngine.run, cfg, 520, 630);
  assert.ok(seed !== null, 'nenhum seed caiu na banda MODERATE em 600 tentativas');

  for (const engine of ENGINES) {
    const res = engine.run(matrix, returnsByState, 0, 50,
      { iterations: 1000, daysAhead: 20, slPct: 0.014, tpPct: 0.028, side: 'LONG', seed });
    assert.equal(res.mcTier, 'MODERATE', `motor ${engine.nome} (seed=${seed})`);
    assert.equal(res.mcLabel, 'Probabilidade Moderada', `motor ${engine.nome}`);
    assert.equal(res.isApproved, true, `motor ${engine.nome}`);
    assert.ok(res.winRate >= 50 && res.winRate < 65, `motor ${engine.nome}: winRate=${res.winRate}`);
  }
});

test('Escalões: retornos só-negativos → REJECTED false / "Rejeitado"', () => {
  const matrix = UNIT_MATRIX;
  const returnsByState = returnsOnly([-0.02]); // −2%/dia → SL (−1.4%) no 1º dia

  for (const engine of ENGINES) {
    const res = engine.run(matrix, returnsByState, 0, 50, { ...PARITY_OPTS, seed: 7 });
    assert.equal(res.mcTier, 'REJECTED', `motor ${engine.nome}`);
    assert.equal(res.mcLabel, 'Rejeitado', `motor ${engine.nome}`);
    assert.equal(res.isApproved, false, `motor ${engine.nome}`);
    assert.equal(res.winRate, 0, `motor ${engine.nome}`);
    assert.equal(res.slHits, PARITY_OPTS.iterations, `motor ${engine.nome}`);
    // EV com winRate 0 = (0·tp − 1·sl)·100 = −1.4. O nativo diverge
    // do fallback por ≤1 ULP (contração FMA — ver nota em cima),
    // pelo que se afirma com tolerância de 1e-9 e não igualdade.
    assert.ok(Math.abs(res.expectedValue - (-1.4)) <= 1e-9,
      `motor ${engine.nome}: expectedValue=${res.expectedValue}`);
  }
});

// ═══════════════════════════════════════════════════════════
//  4. GUARDS de input inválido
//
//  Nota: NÃO se exige deepEqual entre motores aqui — no caminho
//  de guarda o nativo devolve expectedValue=0 (default da struct)
//  enquanto o fallback devolve −sl·100 (=−1.4); divergência
//  conhecida e documentada. Exige-se apenas zeragem por motor.
// ═══════════════════════════════════════════════════════════
test('Guards: estado inválido, preço inválido ou matriz vazia zeram o resultado (ambos os motores)', () => {
  const matrix = buildStrongDiagonalMatrix();
  const returnsByState = buildRaggedReturns();
  const cases = [
    { desc: 'currentState=-1', args: [-1, 100], matrix },
    { desc: 'startPrice=0', args: [4, 0], matrix },
    { desc: 'startPrice negativo', args: [4, -50], matrix },
    { desc: 'startPrice=NaN', args: [4, NaN], matrix },
    { desc: 'matrix vazio', args: [0, 100], matrix: [] }
  ];

  for (const engine of ENGINES) {
    for (const c of cases) {
      const res = engine.run(c.matrix, returnsByState, c.args[0], c.args[1],
        Object.assign({}, PARITY_OPTS, { seed: 42 }));
      assert.equal(res.winRate, 0, `${engine.nome} / ${c.desc}`);
      assert.equal(res.tpHits, 0, `${engine.nome} / ${c.desc}`);
      assert.equal(res.slHits, 0, `${engine.nome} / ${c.desc}`);
      assert.equal(res.expired, PARITY_OPTS.iterations, `${engine.nome} / ${c.desc}`);
      assert.equal(res.isApproved, false, `${engine.nome} / ${c.desc}`);
      assert.equal(res.mcTier, 'REJECTED', `${engine.nome} / ${c.desc}`);
      assert.equal(res.mcLabel, 'Rejeitado', `${engine.nome} / ${c.desc}`);
    }
  }

  // Caso válido: os contadores têm de somar exatamente `iterations`
  for (const engine of ENGINES) {
    const res = engine.run(matrix, returnsByState, 6, 100,
      Object.assign({}, PARITY_OPTS, { seed: 42 }));
    assert.equal(res.tpHits + res.slHits + res.expired, PARITY_OPTS.iterations,
      `motor ${engine.nome}: contadores não somam iterations`);
    assert.ok(Number.isFinite(res.expectedValue));
  }
});

// ═══════════════════════════════════════════════════════════
//  5. SIMETRIA LONG ↔ SHORT
//
//  Leitura prévia do código: com slPct ≠ tpPct (defaults 0.014/
//  0.028) o espelho exato NÃO se verifica (LONG.tp conta toques
//  em +tp, SHORT.sl conta toques em +sl). Com slPct === tpPct os
//  limiares espelham-se ao dígito sobre caminhos de preço
//  idênticos (mesma seed, mesma ordem de draws) → propriedade
//  exata: LONG.tpHits === SHORT.slHits e vice-versa.
// ═══════════════════════════════════════════════════════════
test('SHORT simétrico: com slPct===tpPct, LONG.tpHits===SHORT.slHits e vice-versa', () => {
  const matrix = UNIT_MATRIX;
  const returnsByState = returnsOnly([0.03, -0.025]);
  const symOpts = { iterations: 500, daysAhead: 20, slPct: 0.02, tpPct: 0.02, seed: 12345 };

  for (const engine of ENGINES) {
    const long = engine.run(matrix, returnsByState, 0, 80, { ...symOpts, side: 'LONG' });
    const short = engine.run(matrix, returnsByState, 0, 80, { ...symOpts, side: 'SHORT' });
    assert.equal(long.tpHits, short.slHits, `motor ${engine.nome}: LONG.tp ≠ SHORT.sl`);
    assert.equal(long.slHits, short.tpHits, `motor ${engine.nome}: LONG.sl ≠ SHORT.tp`);
    assert.equal(long.expired, short.expired, `motor ${engine.nome}: expired difere`);
  }
});

test('SHORT: paridade nativo ↔ fallback mantém-se no lado SHORT (params default)', { skip: nativeOK ? false : SKIP_MSG }, () => {
  const matrix = buildStrongDiagonalMatrix();
  const returnsByState = buildRaggedReturns();

  for (const seed of [1, 777777]) {
    const opts = Object.assign({}, PARITY_OPTS, { side: 'SHORT', seed });
    const nat = nativeBinary.runMonteCarlo(matrix, returnsByState, 6, 100, opts);
    const fb = _runMonteCarloJSFallback(matrix, returnsByState, 6, 100, opts);
    assertParidade(nat, fb, `paridade SHORT seed=${seed}`);
  }
});

// ═══════════════════════════════════════════════════════════
//  6. PARIDADE DA MATRIZ DE MARKOV
//
//  computeMarkovModel(bbPct, adx, window) [nativo] deve coincidir
//  com buildTransitionMatrix(buildStateSeries(bbPct, rsi, adx), window)
//  [JS]. Nota verificada na leitura: buildStateSeries IGNORA o rsi
//  internamente (só lê bbPct[i] e adx[i]) → é seguro passar nulls.
// ═══════════════════════════════════════════════════════════
test('Matriz de Markov: nativo === JS (Laplace α=0.1) para windows [10, 150, 1000]', { skip: nativeOK ? false : SKIP_MSG }, () => {
  const n = 300;
  const bbZones = [0.05, 0.50, 0.95]; // zonas BB 0, 1, 2
  const adxZones = [5, 30, 50];       // zonas ADX 0, 1, 2
  const bbPct = [];
  const adx = [];
  for (let i = 0; i < n; i++) {
    bbPct.push(bbZones[i % 3]);
    adx.push(adxZones[Math.floor(i / 3) % 3]); // percorre os 9 estados ciclicamente
  }
  const rsiNullSafe = new Array(n).fill(null); // ignorado por buildStateSeries

  for (const window of [10, 150, 1000]) {
    const nat = quant.computeMarkovModel(bbPct, adx, window);
    assert.ok(nat && nat.transitionMatrix, `computeMarkovModel devolveu null (window=${window})`);

    const states = buildStateSeries(bbPct, rsiNullSafe, adx);
    const jsM = buildTransitionMatrix(states, window);

    // Forma 9×9
    assert.equal(nat.transitionMatrix.length, NUM_STATES);
    assert.equal(jsM.length, NUM_STATES);

    // Paridade célula a célula (tolerância 1e-12) + row-stochastic
    for (let i = 0; i < NUM_STATES; i++) {
      let rowSum = 0;
      for (let j = 0; j < NUM_STATES; j++) {
        const diff = Math.abs(nat.transitionMatrix[i][j] - jsM[i][j]);
        assert.ok(diff <= 1e-12,
          `window=${window} célula [${i}][${j}]: nativo=${nat.transitionMatrix[i][j]} ` +
          `js=${jsM[i][j]} diff=${diff}`);
        rowSum += nat.transitionMatrix[i][j];
      }
      assert.ok(Math.abs(rowSum - 1) <= 1e-9, `window=${window} linha ${i} soma ${rowSum}`);
    }

    // Estado atual igual (último elemento da série sintética)
    assert.equal(nat.currentState, states[n - 1],
      `currentState difere (window=${window})`);
    assert.ok(nat.currentState >= 0 && nat.currentState < NUM_STATES);
  }
});

// ═══════════════════════════════════════════════════════════
//  7. DELEGAÇÃO end-to-end (monteCarloEngine → motor escolhido)
//
//  Prova que runMarkovMonteCarloSimulation(candles) produz o mesmo
//  resultado do motor subjacente chamado diretamente com os MESMOS
//  inputs extraídos (matrix dos estados reais, returns do
//  buildStateReturnsMap exportado). Não se toca em QUANT_FORCE_
//  FALLBACK aqui: usa-se o motor que a delegação escolheria neste
//  processo (nativo se disponível, senão fallback).
// ═══════════════════════════════════════════════════════════
test('Delegação: runMarkovMonteCarloSimulation === motor direto com os mesmos inputs extraídos', () => {
  // 200 velas sintéticas determinísticas com closes oscilantes
  const candles = [];
  for (let i = 0; i < 200; i++) {
    const close = 100 + Math.sin(i / 5) * 1.5 + Math.sin(i / 17) * 2.5;
    candles.push({
      date: new Date(Date.UTC(2024, 0, 1 + i)).toISOString().slice(0, 10),
      open: close - 0.3,
      high: close + 1,
      low: close - 1,
      close,
      volume: 1000 + (i % 50) * 10
    });
  }

  // Inputs extraídos EXATAMENTE como a delegação faria
  const closes = candles.map(c => c.close);
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);
  const rsi = rsiWilder(closes, RSI_PERIOD);
  const adx = adxWilder(highs, lows, closes, ADX_PERIOD);
  const bb = bollingerBands(closes, BB_PERIOD, BB_MULT);
  const states = buildStateSeries(bb.pctB, rsi, adx);
  const matrix = buildTransitionMatrix(states, 150);
  const currentState = states[states.length - 1];

  assert.ok(currentState >= 0 && currentState < NUM_STATES,
    `currentState derivado inválido: ${currentState}`);

  const returnsByState = buildStateReturnsMap(candles);
  const nonEmptyRows = returnsByState.filter(r => r.length > 0).length;
  assert.ok(nonEmptyRows >= 1, 'buildStateReturnsMap não produziu retornos — teste seria trivial');
  assert.ok(returnsByState.reduce((a, r) => a + r.length, 0) >= 100);

  const currentPrice = candles[candles.length - 1].close;
  const opts = { iterations: 800, daysAhead: 20, slPct: 0.014, tpPct: 0.028, side: 'LONG', seed: 777 };

  const delegated = runMarkovMonteCarloSimulation(matrix, currentState, candles, currentPrice, opts);
  const direct = directEngineRun(matrix, returnsByState, currentState, currentPrice, opts);

  assert.ok(Number.isFinite(delegated.winRate), 'delegação devolveu winRate não finito');
  assert.equal(delegated.tpHits + delegated.slHits + delegated.expired, opts.iterations,
    'contadores da delegação não somam iterations');
  assert.deepStrictEqual(delegated, direct,
    'delegação divergiu do motor subjacente com inputs idênticos');

  // Campos de tier presentes e coerentes com o winRate
  assert.equal(delegated.mcTier, delegated.winRate >= 65 ? 'ELITE'
    : (delegated.winRate >= 50 ? 'MODERATE' : 'REJECTED'));
});
