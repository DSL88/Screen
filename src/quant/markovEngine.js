// ─────────────────────────────────────────────────────────────
//  markovEngine.js  –  Motor de Markov com direção baseada em
//  probabilidades de transição e disjuntor RSI estrito.
//
//  Direção: pBull vs pBear (Markov) → filtro RSI → decisão final
//  Estados: 9 estados (3 zonas BB × 3 zonas ADX) por defeito.
//
//  Passo 2 – Cadeia de Markov de 2ª Ordem (memória de 2 velas):
//    - calculateMarkovMatrixOrder2(candles, options) constrói a
//      tabela de transição tridimensional [prev2][prev1][next]
//      com suavização de Laplace e fallback para 1ª ordem quando
//      um par (t-2, t-1) nunca ocorreu na janela de amostragem.
// ─────────────────────────────────────────────────────────────

'use strict';

const { sma, rsiWilder, adxWilder, bollingerBands, atrWilder, calculateRollingVWAP, calculateRVOL } = require('./indicators');

// ── Constantes ──────────────────────────────────────────────
const NUM_STATES = 9;
const HORIZON = 5;
const RSI_PERIOD = 21;
const ADX_PERIOD = 14;
const BB_PERIOD = 30;
const BB_MULT = 2.0;
const ATR_PERIOD = 14;
const ATR_MULT = 1.5;
const SL_PCT = 0.014;
const TP_PCT = 0.028;
const VOL_SMA_PERIOD = 20;
const VWAP_PERIOD = 20;
const LAPLACE_ALPHA = 0.1;

// ── Espaços de estado suportados ────────────────────────────
//  '9': 3 zonas BB × 3 zonas ADX   (padrão, retrocompatível)
//  '6': 3 zonas BB × 2 estados de ADX (tendência fraca/forte)
//  '3': 3 estados direcionais (Bear / Neutro / Bull)
const STATE_SPACES = {
  '9': { numStates: 9 },
  '6': { numStates: 6 },
  '3': { numStates: 3 }
};

function getNumStates(stateSpace) {
  return (STATE_SPACES[stateSpace] || STATE_SPACES['9']).numStates;
}

// ── Classificação bull/bear por estado (espaço 9, padrão) ────
//  state = bb_zone + (adx_zone × 3)
//
//  Bull: state 5 (bb=2, adx=1) → BB alto, tendência moderada
//        state 7 (bb=1, adx=2) → BB médio, tendência forte
//  Bear: state 3 (bb=0, adx=1) → BB baixo, tendência moderada
//        state 6 (bb=0, adx=2) → BB baixo, tendência forte
function isBullishState(s) {
  return s === 5 || s === 7;
}

function isBearishState(s) {
  return s === 3 || s === 6;
}

// Bullish/bearish por espaço de estado (usado no forecast da direção).
function isBullishStateInSpace(s, stateSpace) {
  if (stateSpace === '3') return s === 2; // Bull
  if (stateSpace === '6') return s === 4 || s === 5; // bb médio/alto + tendência forte
  return isBullishState(s);
}

function isBearishStateInSpace(s, stateSpace) {
  if (stateSpace === '3') return s === 0; // Bear
  if (stateSpace === '6') return s === 3; // bb baixo + tendência forte
  return isBearishState(s);
}

// ═══════════════════════════════════════════════════════════
//  Série de estados bidimensional
//
//  Espaço '9' (padrão):
//    bb_zone:  bbp < 0.33 → 0 | 0.33 ≤ bbp ≤ 0.66 → 1 | bbp > 0.66 → 2
//    adx_zone: adx < 20   → 0 | 20 ≤ adx ≤ 40     → 1 | adx > 40   → 2
//    state = bb_zone + (adx_zone × 3)
//
//  Espaço '6':
//    bbp (0/1/2) igual ao espaço 9; adx_zone = adx ≥ 25 ? 1 : 0
//    state = bb_zone + (adx_zone × 3)
//
//  Espaço '3' (direcional):
//    bbp > 0.66 → 2 (Bull) | bbp < 0.33 → 0 (Bear) | senão → 1 (Neutro)
// ═══════════════════════════════════════════════════════════
function buildStateSeries(bbPct, rsi, adx, stateSpace) {
  const space = STATE_SPACES[stateSpace] ? stateSpace : '9';
  const n = bbPct.length;
  const states = new Array(n).fill(-1);

  for (let i = 0; i < n; i++) {
    const bbp = bbPct[i];
    const ax = adx[i];
    if (bbp == null || ax == null) continue;

    if (space === '3') {
      states[i] = bbp < 0.33 ? 0 : (bbp > 0.66 ? 2 : 1);
      continue;
    }

    const bb_zone = bbp < 0.33 ? 0 : (bbp > 0.66 ? 2 : 1);
    let adx_zone;
    if (space === '6') {
      adx_zone = ax >= 25.0 ? 1 : 0;
    } else {
      adx_zone = ax < 20.0 ? 0 : (ax > 40.0 ? 2 : 1);
    }
    states[i] = bb_zone + (adx_zone * 3);
  }
  return states;
}

function stateSizeForSpace(stateSpace) {
  const space = STATE_SPACES[stateSpace] ? stateSpace : '9';
  return getNumStates(space);
}

// ═══════════════════════════════════════════════════════════
//  Matriz de transição (1ª ordem) com suavização de Laplace
// ═══════════════════════════════════════════════════════════
function buildTransitionMatrix(states, window, stateSpace) {
  const alpha = LAPLACE_ALPHA;
  const N = stateSizeForSpace(stateSpace);
  const M = Array.from({ length: N }, () => new Array(N).fill(alpha));
  const len = states.length;
  const start = Math.max(0, len - window);

  for (let i = start; i < len - 1; i++) {
    const a = states[i];
    const b = states[i + 1];
    if (a < 0 || b < 0 || a >= N || b >= N) continue;
    M[a][b] += 1;
  }

  for (let i = 0; i < N; i++) {
    let rowSum = 0;
    for (let j = 0; j < N; j++) rowSum += M[i][j];
    if (rowSum > 0) {
      for (let j = 0; j < N; j++) M[i][j] /= rowSum;
    } else {
      M[i][i] = 1;
    }
  }
  return M;
}

// ═══════════════════════════════════════════════════════════
//  Matriz de transição de 2ª ordem (memória de 2 velas)
//
//  M2[prev2][prev1][next] = P(S_t = next | S_{t-1}=prev1, S_{t-2}=prev2)
//  Normalização por par (prev2, prev1) → Σ_next = 1.
//  Fallback: se o par (prev2, prev1) nunca ocorreu na janela
//  (Σ_next N = 0), usa a distribuição de 1ª ordem de `prev1`.
// ═══════════════════════════════════════════════════════════
function buildTransitionMatrixOrder2(states, window, stateSpace) {
  const alpha = LAPLACE_ALPHA;
  const N = stateSizeForSpace(stateSpace);
  const len = states.length;
  const start = Math.max(0, len - window);

  // Contagens brutas (para o fallback sem suavização)
  const counts = Array.from({ length: N }, () =>
    Array.from({ length: N }, () => new Array(N).fill(0))
  );
  const pairCounts = Array.from({ length: N }, () => new Array(N).fill(0));

  for (let i = start; i < len - 2; i++) {
    const a = states[i];       // t-2
    const b = states[i + 1];   // t-1
    const c = states[i + 2];   // t
    if (a < 0 || b < 0 || c < 0 || a >= N || b >= N || c >= N) continue;
    counts[a][b][c] += 1;
    pairCounts[a][b] += 1;
  }

  // Matriz de 1ª ordem (fallback por par sem histórico)
  const firstOrder = buildTransitionMatrix(states, window, stateSpace);

  // Distribuição normalizada por par
  const M2 = Array.from({ length: N }, () =>
    Array.from({ length: N }, () => new Array(N).fill(0))
  );

  for (let a = 0; a < N; a++) {
    for (let b = 0; b < N; b++) {
      const total = pairCounts[a][b];
      if (total === 0) {
        // Fallback → distribuição de 1ª ordem a partir de b
        for (let k = 0; k < N; k++) M2[a][b][k] = firstOrder[b][k];
        continue;
      }
      const denom = total + N * alpha;
      for (let k = 0; k < N; k++) {
        M2[a][b][k] = (counts[a][b][k] + alpha) / denom;
      }
    }
  }

  return M2;
}

// ═══════════════════════════════════════════════════════════
//  Multiplicação vetor × matriz (dimensões dinâmicas)
// ═══════════════════════════════════════════════════════════
function matVec(M, v) {
  const rows = M.length;
  const cols = rows > 0 ? M[0].length : 0;
  const out = new Array(cols).fill(0);
  for (let j = 0; j < cols; j++) {
    let s = 0;
    for (let i = 0; i < rows; i++) s += v[i] * M[i][j];
    out[j] = s;
  }
  return out;
}

// ═══════════════════════════════════════════════════════════
//  Forecast: propaga estado `currentState` `h` passos no futuro
// ═══════════════════════════════════════════════════════════
function forecast(M, currentState, h = HORIZON) {
  if (currentState < 0 || !M || M.length === 0) return null;
  const N = M.length;
  let v = new Array(N).fill(0);
  v[currentState] = 1;
  for (let step = 0; step < h; step++) {
    v = matVec(M, v);
  }
  return v;
}

// ═══════════════════════════════════════════════════════════
//  Mapa de retornos por estado (ida para o Monte Carlo)
//  Tamanho dimensionado pelo espaço de estado escolhido.
// ═══════════════════════════════════════════════════════════
function buildStateReturnsMapForCandles(candles, stateSpace) {
  const N = stateSizeForSpace(stateSpace);
  const closes = candles.map(c => c.close);
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);

  const rsi = rsiWilder(closes, RSI_PERIOD);
  const adx = adxWilder(highs, lows, closes, ADX_PERIOD);
  const bb = bollingerBands(closes, BB_PERIOD, BB_MULT);

  const states = buildStateSeries(bb.pctB, rsi, adx, stateSpace);
  const returnsByState = Array.from({ length: N }, () => []);

  for (let i = 1; i < candles.length; i++) {
    const prevState = states[i - 1];
    if (prevState < 0 || prevState >= N) continue;
    const prevClose = closes[i - 1];
    if (prevClose == null || prevClose <= 0) continue;
    const ret = (closes[i] - prevClose) / prevClose;
    if (Number.isFinite(ret)) {
      returnsByState[prevState].push(ret);
    }
  }

  return returnsByState;
}

// ═══════════════════════════════════════════════════════════
//  ANÁLISE PRINCIPAL DA SÉRIE
//
//  Lógica de direção em 2 passos:
//    1. DIREÇÃO BASE (Markov):
//       pBull > pBear → COMPRA  |  pBear > pBull → VENDA
//    2. DISJUNTOR RSI (filtro final estrito):
//       COMPRA + RSI > 53 → COMPRA final  |  senão → NEUTRO
//       VENDA  + RSI < 47 → VENDA  final  |  senão → NEUTRO
//    3. NEUTRO → edge = 0 (estritamente)
//
//  Passo 2 – ordenação de Markov:
//    params.markovOrder === 2 → transitionMatrix é tridimensional
//    [prev2][prev1][next] e é devolvido prevState (usado no Monte Carlo).
//    A direção continua a usar o forecast de 1ª ordem (matriz 2D) para
//    manter a classificação bull/bear/neutro estável.
// ═══════════════════════════════════════════════════════════
function analyzeSeries(candles, params = {}) {
  const window = params.markovWindow ?? 150;
  const volThresh = params.volumeMult ?? 1.2;
  const horizon = params.horizonDays ?? HORIZON;
  const useVolFilter = params.useVolFilter !== undefined ? params.useVolFilter : true;
  const onlyLongs = params.onlyLongs ?? false;
  const stateSpace = params.stateSpace ?? '9';
  const markovOrder = params.markovOrder === 2 ? 2 : 1;

  // ── Períodos dinâmicos (fallbacks = constantes do topo) ──
  const rsiPeriod = params.rsiPeriod ?? RSI_PERIOD;
  const adxPeriod = params.adxPeriod ?? ADX_PERIOD;
  const bbPeriod = params.bbPeriod ?? BB_PERIOD;
  const bbMult = params.bbMult ?? BB_MULT;
  const atrPeriod = params.atrPeriod ?? ATR_PERIOD;
  const atrMult = params.atrMult ?? ATR_MULT;
  const slPct = params.slPct ?? SL_PCT;
  const tpPct = params.tpPct ?? TP_PCT;

  // Descarta velas com close null (ainda em formação)
  candles = candles.filter(c => c && c.close != null);

  if (!candles || candles.length < 60) {
    return {
      ticker: null,
      date: null,
      close: null,
      direction: 'NEUTRO',
      baseDirection: 'NEUTRO',
      edge: 0,
      pBull: 0,
      pBear: 0,
      pStay: 1,
      rsi: null,
      adx: null,
      bbPct: null,
      atr: null,
      volume: null,
      volumeSma: null,
      volumeValid: false,
      rvol: null,
      rvolApproved: false,
      rollingVwap20: null,
      stopLoss: null,
      takeProfit: null,
      currentState: -1,
      prevState: -1,
      order: markovOrder,
      stateSpace,
      numStates: getNumStates(stateSpace),
      transitionMatrix: null
    };
  }

  const closes = candles.map(c => c.close);
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);
  const volumes = candles.map(c => c.volume);

  // ── Indicadores ───────────────────────────────────────────
  const rsi = rsiWilder(closes, rsiPeriod);
  const adx = adxWilder(highs, lows, closes, adxPeriod);
  const bb = bollingerBands(closes, bbPeriod, bbMult);
  const atr = atrWilder(highs, lows, closes, atrPeriod);
  const volSma = sma(volumes, VOL_SMA_PERIOD);

  const lastIdx = candles.length - 1;

  const rollingVwap = calculateRollingVWAP(candles, VWAP_PERIOD);
  const lastRollingVwap = rollingVwap[lastIdx];

  const states = buildStateSeries(bb.pctB, rsi, adx, stateSpace);
  const N = getNumStates(stateSpace);
  const M1 = buildTransitionMatrix(states, window, stateSpace);

  const lastState = states[lastIdx];
  const prevState = states[lastIdx - 1];
  const dist = forecast(M1, lastState, horizon);

  // ── Probabilidades: pBull, pBear ──────────────────────────
  let pBull = 0;
  let pBear = 0;
  let pStay = 1;
  let edge = 0;

  if (dist) {
    for (let s = 0; s < N; s++) {
      if (s < dist.length && dist[s] > 0) {
        if (isBullishStateInSpace(s, stateSpace)) pBull += dist[s];
        else if (isBearishStateInSpace(s, stateSpace)) pBear += dist[s];
      }
    }
    pStay = Math.max(0, 1 - pBull - pBear);
    edge = Math.abs(pBull - pBear);
  }

  // ── PASSO 1: DIREÇÃO BASE (probabilidades de Markov) ──────
  let baseDirection = 'NEUTRO';
  if (pBull > pBear) {
    baseDirection = 'COMPRA';
  } else if (pBear > pBull) {
    baseDirection = 'VENDA';
  }

  // ── PASSO 2: DISJUNTOR RSI (filtro final estrito) ─────────
  const lastRsi = rsi[lastIdx];
  let direction = 'NEUTRO';

  if (baseDirection === 'COMPRA') {
    direction = (lastRsi != null && lastRsi > 53) ? 'COMPRA' : 'NEUTRO';
  } else if (baseDirection === 'VENDA') {
    direction = (lastRsi != null && lastRsi < 47) ? 'VENDA' : 'NEUTRO';
  }

  // ── PASSO 3: NEUTRO → edge estritamente a 0 ──────────────
  if (direction === 'NEUTRO') {
    edge = 0;
  }

  // Filtro only-longs
  if (onlyLongs && direction === 'VENDA') {
    direction = 'NEUTRO';
    edge = 0;
  }

  // ── Volume ────────────────────────────────────────────────
  const lastVol = volumes[lastIdx];
  const lastVolSma = volSma[lastIdx];
  const volumeValid = !useVolFilter ||
    (lastVol != null && lastVolSma != null && lastVolSma > 0 && lastVol > lastVolSma * volThresh);

  // ── RVOL (Volume Relativo) – Gatekeeper externo ───────────
  const rvolMin = params.rvolMin != null ? Number(params.rvolMin) : 1.0;
  const rvolRes = calculateRVOL(candles, VOL_SMA_PERIOD);
  const rvol = rvolRes.rvol;
  const rvolApproved = rvolRes.avgVolume > 0 && rvol >= rvolMin;

  // ── Stop Loss / Take Profit ───────────────────────────────
  const close = closes[lastIdx];
  const atrVal = atr[lastIdx];
  let stopLoss = null;
  let takeProfit = null;

  if (direction === 'COMPRA' && close != null) {
    stopLoss = close * (1 - slPct);
    takeProfit = close * (1 + tpPct);
  } else if (direction === 'VENDA' && close != null) {
    stopLoss = close * (1 + slPct);
    takeProfit = close * (1 - tpPct);
  }

  // Matriz exposta ao Monte Carlo: 2D (1ª ordem) ou 3D (2ª ordem)
  const transitionMatrix = (markovOrder === 2)
    ? buildTransitionMatrixOrder2(states, window, stateSpace)
    : M1;

  return {
    ticker: candles[lastIdx]?.ticker,
    date: candles[lastIdx]?.date,
    close,
    direction,
    baseDirection,
    edge,
    pBull,
    pBear,
    pStay,
    rsi: lastRsi,
    adx: adx[lastIdx],
    bbPct: bb.pctB[lastIdx],
    atr: atrVal,
    volume: lastVol,
    volumeSma: lastVolSma,
    volumeValid,
    rvol,
    rvolApproved,
    rollingVwap20: lastRollingVwap,
    stopLoss,
    takeProfit,
    currentState: lastState,
    prevState,
    order: markovOrder,
    stateSpace,
    numStates: N,
    transitionMatrix
  };
}

// ═══════════════════════════════════════════════════════════
//  CALCULATE MARKOV MATRIX – 2ª ORDEM (API pública do Passo 2)
//
//  Calcula os estados de cada vela, constrói a tabela de transição
//  tridimensional, normaliza por par e devolve os dois estados mais
//  recentes + mapa de retornos. O fallback de 1ª ordem está ativo
//  para combinações raras (pares sem histórico na janela).
// ═══════════════════════════════════════════════════════════
function calculateMarkovMatrixOrder2(candles, options = {}) {
  const window = options.markovWindow ?? 150;
  const stateSpace = options.stateSpace ?? '9';

  candles = candles.filter(c => c && c.close != null);
  if (!candles || candles.length < 60) {
    return { isValid: false, order: 2, stateSpace, currentState: -1, prevState: -1, transitionMatrix: null, stateReturns: [] };
  }

  const closes = candles.map(c => c.close);
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);
  const rsi = rsiWilder(closes, RSI_PERIOD);
  const adx = adxWilder(highs, lows, closes, ADX_PERIOD);
  const bb = bollingerBands(closes, BB_PERIOD, BB_MULT);
  const states = buildStateSeries(bb.pctB, rsi, adx, stateSpace);

  const stateReturns = buildStateReturnsMapForCandles(candles, stateSpace);
  const N = getNumStates(stateSpace);

  // Transição por par (i, j) de t-2, t-1 → t, com fallback de 1ª ordem
  const transitionMatrix = buildTransitionMatrixOrder2(states, window, stateSpace);

  const lastIdx = candles.length - 1;
  const currentState = states[lastIdx];
  const prevState = states[lastIdx - 1];

  const base = {
    isValid: currentState >= 0 && prevState >= 0,
    order: 2,
    stateSpace,
    numStates: N,
    transitionMatrix,
    stateReturns,
    currentState,
    prevState
  };

  if (!base.isValid) return { ...base, isValid: false };
  return base;
}

// ═══════════════════════════════════════════════════════════
//  shouldEmit – Decisão final de emissão de sinal
//
//  Respeita overrides manuais da UI:
//    - Se useVolFilter foi desligado → volumeValid já será true
//    - edgeThreshold é comparado com o edge calculado
// ═══════════════════════════════════════════════════════════
function shouldEmit(result, edgeThreshold, useVolFilter, useRvolGate, rvolMin) {
  if (result.direction !== 'COMPRA' && result.direction !== 'VENDA') return false;

  if (result.direction === 'COMPRA' && result.rollingVwap20 != null && result.close != null) {
    if (result.close <= result.rollingVwap20) return false;
  }

  if (result.edge < edgeThreshold) return false;

  if (useVolFilter === false) return true;

  // Caso contrário, exige volume válido
  if (!result.volumeValid) return false;

  // Gatekeeper externo: RVOL(20) — confirmação de volume institucional.
  // Aplicado aos sinais de COMPRA (regra do prompt). Configurável e
  // desativável. Não altera a Matriz de Markov.
  if (useRvolGate !== false && result.direction === 'COMPRA') {
    const min = rvolMin != null ? Number(rvolMin) : 1.0;
    const approved = result.rvolApproved != null
      ? result.rvolApproved
      : (result.rvol != null && result.rvol >= min);
    if (!approved) return false;
  }

  return true;
}

module.exports = {
  NUM_STATES,
  HORIZON,
  RSI_PERIOD,
  ADX_PERIOD,
  BB_PERIOD,
  BB_MULT,
  ATR_PERIOD,
  ATR_MULT,
  SL_PCT,
  TP_PCT,
  VOL_SMA_PERIOD,
  VWAP_PERIOD,
  LAPLACE_ALPHA,
  STATE_SPACES,
  getNumStates,
  analyzeSeries,
  shouldEmit,
  buildTransitionMatrix,
  buildTransitionMatrixOrder2,
  buildStateSeries,
  calculateMarkovMatrixOrder2,
  buildStateReturnsMapForCandles,
  isBullishState,
  isBearishState,
  isBullishStateInSpace,
  isBearishStateInSpace
};
