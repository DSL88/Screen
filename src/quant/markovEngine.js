// ─────────────────────────────────────────────────────────────
//  markovEngine.js  –  Motor de Markov com direção baseada em
//  probabilidades de transição e disjuntor RSI estrito.
//
//  Direção: pBull vs pBear (Markov) → filtro RSI → decisão final
//  Estados: 9 estados (3 zonas BB × 3 zonas ADX)
// ─────────────────────────────────────────────────────────────

'use strict';

const { sma, rsiWilder, adxWilder, bollingerBands, atrWilder } = require('./indicators');

// ── Constantes ──────────────────────────────────────────────
const NUM_STATES = 9;
const HORIZON = 5;
const RSI_PERIOD = 21;
const ADX_PERIOD = 14;
const BB_PERIOD = 30;
const BB_MULT = 2.0;
const ATR_PERIOD = 14;
const ATR_MULT = 1.5;
const TP_PCT = 0.025;
const VOL_SMA_PERIOD = 20;

// ── Classificação bull/bear por estado ──────────────────────
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

// ═══════════════════════════════════════════════════════════
//  Série de estados (0–8) bidimensional
//
//  bb_zone:  bbp < 0.33 → 0 | 0.33 ≤ bbp ≤ 0.66 → 1 | bbp > 0.66 → 2
//  adx_zone: adx < 20   → 0 | 20 ≤ adx ≤ 40     → 1 | adx > 40   → 2
//  state = bb_zone + (adx_zone × 3)
// ═══════════════════════════════════════════════════════════
function buildStateSeries(bbPct, rsi, adx) {
  const n = bbPct.length;
  const states = new Array(n).fill(-1);

  for (let i = 0; i < n; i++) {
    const bbp = bbPct[i];
    const ax = adx[i];
    if (bbp == null || ax == null) continue;

    const bb_zone = bbp < 0.33 ? 0 : (bbp > 0.66 ? 2 : 1);
    const adx_zone = ax < 20.0 ? 0 : (ax > 40.0 ? 2 : 1);
    states[i] = bb_zone + (adx_zone * 3);
  }
  return states;
}

// ═══════════════════════════════════════════════════════════
//  Matriz de transição com suavização de Laplace
// ═══════════════════════════════════════════════════════════
function buildTransitionMatrix(states, window) {
  const alpha = 0.1;
  const M = Array.from({ length: NUM_STATES }, () => new Array(NUM_STATES).fill(alpha));
  const len = states.length;
  const start = Math.max(0, len - window);

  for (let i = start; i < len - 1; i++) {
    const a = states[i];
    const b = states[i + 1];
    if (a < 0 || b < 0) continue;
    M[a][b] += 1;
  }

  for (let i = 0; i < NUM_STATES; i++) {
    let rowSum = 0;
    for (let j = 0; j < NUM_STATES; j++) rowSum += M[i][j];
    if (rowSum > 0) {
      for (let j = 0; j < NUM_STATES; j++) M[i][j] /= rowSum;
    } else {
      M[i][i] = 1;
    }
  }
  return M;
}

// ═══════════════════════════════════════════════════════════
//  Multiplicação vetor × matriz
// ═══════════════════════════════════════════════════════════
function matVec(M, v) {
  const out = new Array(NUM_STATES).fill(0);
  for (let j = 0; j < NUM_STATES; j++) {
    let s = 0;
    for (let i = 0; i < NUM_STATES; i++) s += v[i] * M[i][j];
    out[j] = s;
  }
  return out;
}

// ═══════════════════════════════════════════════════════════
//  Forecast: propaga estado `h` passos no futuro
// ═══════════════════════════════════════════════════════════
function forecast(M, currentState, h = HORIZON) {
  if (currentState < 0) return null;
  let v = new Array(NUM_STATES).fill(0);
  v[currentState] = 1;
  for (let step = 0; step < h; step++) {
    v = matVec(M, v);
  }
  return v;
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
// ═══════════════════════════════════════════════════════════
function analyzeSeries(candles, params = {}) {
  const window = params.markovWindow ?? 150;
  const volThresh = params.volumeMult ?? 1.2;
  const horizon = params.horizonDays ?? HORIZON;
  const useVolFilter = params.useVolFilter !== undefined ? params.useVolFilter : true;
  const onlyLongs = params.onlyLongs ?? false;

  const closes = candles.map(c => c.close);
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);
  const volumes = candles.map(c => c.volume);

  // ── Indicadores ───────────────────────────────────────────
  const rsi = rsiWilder(closes, RSI_PERIOD);
  const adx = adxWilder(highs, lows, closes, ADX_PERIOD);
  const bb = bollingerBands(closes, BB_PERIOD, BB_MULT);
  const atr = atrWilder(highs, lows, closes, ATR_PERIOD);
  const volSma = sma(volumes, VOL_SMA_PERIOD);

  // ── Cadeia de Markov ──────────────────────────────────────
  const states = buildStateSeries(bb.pctB, rsi, adx);
  const M = buildTransitionMatrix(states, window);

  const lastIdx = candles.length - 1;
  const lastState = states[lastIdx];
  const dist = forecast(M, lastState, horizon);

  // ── Probabilidades: pBull, pBear ──────────────────────────
  let pBull = 0;
  let pBear = 0;
  let pStay = 1;
  let edge = 0;

  if (dist) {
    for (let s = 0; s < NUM_STATES; s++) {
      if (isBullishState(s)) pBull += dist[s];
      else if (isBearishState(s)) pBear += dist[s];
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

  // ── Stop Loss / Take Profit ───────────────────────────────
  const close = closes[lastIdx];
  const atrVal = atr[lastIdx];
  let stopLoss = null;
  let takeProfit = null;

  if (direction === 'COMPRA' && close != null && atrVal != null) {
    stopLoss = close - ATR_MULT * atrVal;
    takeProfit = close * (1 + TP_PCT);
  } else if (direction === 'VENDA' && close != null && atrVal != null) {
    stopLoss = close + ATR_MULT * atrVal;
    takeProfit = close * (1 - TP_PCT);
  }

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
    stopLoss,
    takeProfit,
    currentState: lastState,
    transitionMatrix: M
  };
}

// ═══════════════════════════════════════════════════════════
//  shouldEmit – Decisão final de emissão de sinal
//
//  Respeita overrides manuais da UI:
//    - Se useVolFilter foi desligado → volumeValid já será true
//    - edgeThreshold é comparado com o edge calculado
// ═══════════════════════════════════════════════════════════
function shouldEmit(result, edgeThreshold) {
  // Precisa de direção não-neutra
  if (result.direction !== 'COMPRA' && result.direction !== 'VENDA') return false;

  // Edge tem de superar o threshold
  if (result.edge < edgeThreshold) return false;

  // Volume (já incorpora o override de useVolFilter)
  if (!result.volumeValid) return false;

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
  TP_PCT,
  VOL_SMA_PERIOD,
  analyzeSeries,
  shouldEmit,
  buildTransitionMatrix,
  buildStateSeries,
  isBullishState,
  isBearishState
};
