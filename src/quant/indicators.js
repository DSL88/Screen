// ─────────────────────────────────────────────────────────────
//  indicators.js  –  Funções quantitativas alinhadas com TradingView
//
//  RMA (Wilder's Moving Average) em toda a pipeline:
//    rma[seed]  = SMA(source, period)           (primeiro valor)
//    rma[i]     = (value + (period-1) * rma[i-1]) / period
//
//  Sem SMAs temporárias no ADX. Suavização Wilder pura em toda
//  a cadeia: TR, ±DM, DX → ADX.
// ─────────────────────────────────────────────────────────────

'use strict';

// ═══════════════════════════════════════════════════════════
//  SMA – Simple Moving Average
// ═══════════════════════════════════════════════════════════
function sma(values, period) {
  const n = values.length;
  const out = new Array(n).fill(null);
  if (n < period || period <= 0) return out;

  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i];
  out[period - 1] = sum / period;

  for (let i = period; i < n; i++) {
    sum += values[i] - values[i - period];
    out[i] = sum / period;
  }
  return out;
}

// ═══════════════════════════════════════════════════════════
//  EMA – Exponential Moving Average
// ═══════════════════════════════════════════════════════════
function ema(values, period) {
  const n = values.length;
  const out = new Array(n).fill(null);
  if (n < period || period <= 0) return out;

  const k = 2 / (period + 1);
  let seed = 0;
  for (let i = 0; i < period; i++) seed += values[i];
  out[period - 1] = seed / period;

  for (let i = period; i < n; i++) {
    out[i] = values[i] * k + out[i - 1] * (1 - k);
  }
  return out;
}

// ═══════════════════════════════════════════════════════════
//  StdDev – Population standard deviation (N divisor)
//  Alinhado com ta.stdev() do TradingView (biased=true, default)
// ═══════════════════════════════════════════════════════════
function stddev(values, period) {
  const n = values.length;
  const out = new Array(n).fill(null);
  if (n < period || period <= 0) return out;

  for (let i = period - 1; i < n; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += values[j];
    const mean = sum / period;
    let sq = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const d = values[j] - mean;
      sq += d * d;
    }
    out[i] = Math.sqrt(sq / period);
  }
  return out;
}

// ═══════════════════════════════════════════════════════════
//  RMA – Wilder's Moving Average (ta.rma do Pine Script)
//
//  Fórmula:
//    Seed  = SMA dos primeiros `period` valores válidos
//    Após  = (valor + (period - 1) × rma_anterior) / period
//
//  Valores null/undefined/NaN são ignorados na contagem de
//  warm-up, mas preservam a posição no array de saída.
// ═══════════════════════════════════════════════════════════
function rma(values, period) {
  const n = values.length;
  const out = new Array(n).fill(null);
  if (period <= 0) return out;

  let sum = 0;
  let count = 0;
  let prev = null;

  for (let i = 0; i < n; i++) {
    const val = values[i];

    // Ignorar valores inválidos durante o warm-up
    if (val === null || val === undefined || isNaN(val)) {
      continue;
    }

    count++;

    if (count < period) {
      // Acumular para o seed
      sum += val;
    } else if (count === period) {
      // Seed: SMA dos primeiros `period` válidos
      sum += val;
      prev = sum / period;
      out[i] = prev;
    } else {
      // Suavização de Wilder
      prev = (val + (period - 1) * prev) / period;
      out[i] = prev;
    }
  }
  return out;
}

// ═══════════════════════════════════════════════════════════
//  True Range
// ═══════════════════════════════════════════════════════════
function trueRange(highs, lows, closes) {
  const n = closes.length;
  const tr = new Array(n).fill(0);
  tr[0] = highs[0] - lows[0];

  for (let i = 1; i < n; i++) {
    const hl = highs[i] - lows[i];
    const hc = Math.abs(highs[i] - closes[i - 1]);
    const lc = Math.abs(lows[i] - closes[i - 1]);
    tr[i] = Math.max(hl, hc, lc);
  }
  return tr;
}

// ═══════════════════════════════════════════════════════════
//  ATR – Average True Range (Wilder/RMA)
// ═══════════════════════════════════════════════════════════
function atrWilder(highs, lows, closes, period = 14) {
  const tr = trueRange(highs, lows, closes);
  return rma(tr, period);
}

// ═══════════════════════════════════════════════════════════
//  RSI – Relative Strength Index (Wilder/RMA)
//
//  Replica exatamente ta.rsi() do Pine Script:
//    1. change = close[i] - close[i-1]
//    2. gain = max(change, 0),  loss = max(-change, 0)
//    3. avgGain = rma(gain, period)
//    4. avgLoss = rma(loss, period)
//    5. rs = avgGain / avgLoss
//    6. rsi = 100 - 100 / (1 + rs)
//
//  O seed RMA começa nos changes[1..period] (period values).
//  Primeiro RSI válido: índice `period`.
// ═══════════════════════════════════════════════════════════
function rsiWilder(closes, period = 21) {
  const n = closes.length;
  const out = new Array(n).fill(null);
  if (n <= period || period <= 0) return out;

  // Seed: SMA dos primeiros `period` changes (índices 1..period)
  let sumGain = 0;
  let sumLoss = 0;
  for (let i = 1; i <= period; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) sumGain += change;
    else sumLoss -= change;
  }

  let avgGain = sumGain / period;
  let avgLoss = sumLoss / period;

  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  // Suavização de Wilder a partir do índice period+1
  for (let i = period + 1; i < n; i++) {
    const change = closes[i] - closes[i - 1];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;
    avgGain = (gain + (period - 1) * avgGain) / period;
    avgLoss = (loss + (period - 1) * avgLoss) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }

  return out;
}

// ═══════════════════════════════════════════════════════════
//  ADX – Average Directional Index (Wilder/RMA puro)
//
//  Pipeline sem qualquer SMA temporária:
//    1. +DM, -DM  (regras clássicas de Wilder)
//    2. smoothTR   = RMA(TR, period)
//    3. smooth+DM  = RMA(+DM, period)
//    4. smooth-DM  = RMA(-DM, period)
//    5. +DI = 100 × smooth+DM / smoothTR
//    6. -DI = 100 × smooth-DM / smoothTR
//    7. DX  = 100 × |+DI − -DI| / (+DI + -DI)
//    8. ADX = RMA(DX, period)  ← segunda suavização Wilder
// ═══════════════════════════════════════════════════════════
function adxWilder(highs, lows, closes, period = 14) {
  const n = closes.length;
  const out = new Array(n).fill(null);
  // Precisamos de pelo menos 2×period bars para seed+smooth
  if (n < period * 2) return out;

  // +DM / -DM (bar 0 fica a 0, sem previous bar)
  const plusDM = new Array(n).fill(0);
  const minusDM = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const up = highs[i] - highs[i - 1];
    const down = lows[i - 1] - lows[i];
    plusDM[i] = (up > down && up > 0) ? up : 0;
    minusDM[i] = (down > up && down > 0) ? down : 0;
  }

  const tr = trueRange(highs, lows, closes);

  // 1ª suavização RMA
  const trSmooth = rma(tr, period);
  const plusSmooth = rma(plusDM, period);
  const minusSmooth = rma(minusDM, period);

  // DX série
  const dx = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    if (trSmooth[i] === null || plusSmooth[i] === null || minusSmooth[i] === null) {
      continue;
    }
    const trVal = trSmooth[i];
    const plusDI = trVal === 0 ? 0 : 100 * plusSmooth[i] / trVal;
    const minusDI = trVal === 0 ? 0 : 100 * minusSmooth[i] / trVal;
    const diSum = plusDI + minusDI;
    dx[i] = diSum === 0 ? 0 : 100 * Math.abs(plusDI - minusDI) / diSum;
  }

  // 2ª suavização RMA sobre DX → ADX
  return rma(dx, period);
}

// ═══════════════════════════════════════════════════════════
//  Bollinger Bands (SMA ± mult × StdDev)
// ═══════════════════════════════════════════════════════════
function bollingerBands(closes, period = 30, mult = 2.0) {
  const n = closes.length;
  const mid = sma(closes, period);
  const sd = stddev(closes, period);
  const upper = new Array(n).fill(null);
  const lower = new Array(n).fill(null);
  const pctB = new Array(n).fill(null);

  for (let i = 0; i < n; i++) {
    if (mid[i] !== null && sd[i] !== null) {
      upper[i] = mid[i] + mult * sd[i];
      lower[i] = mid[i] - mult * sd[i];
      const range = upper[i] - lower[i];
      pctB[i] = range === 0 ? 0.5 : (closes[i] - lower[i]) / range;
    }
  }
  return { mid, upper, lower, pctB };
}

module.exports = {
  sma,
  ema,
  stddev,
  rma,
  rsiWilder,
  atrWilder,
  adxWilder,
  bollingerBands,
  trueRange
};
