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
//
//  Sliding Window O(N): mantém soma e soma dos quadrados
//  em tempo real, eliminando o loop aninhado O(N × period).
//  Variância via E[X²] − (E[X])² com guarda numérica.
// ═══════════════════════════════════════════════════════════
function stddev(values, period) {
  const n = values.length;
  const out = new Array(n).fill(null);
  if (n < period || period <= 0) return out;

  let sum = 0;
  let sumSq = 0;

  for (let i = 0; i < period; i++) {
    const v = values[i];
    sum += v;
    sumSq += v * v;
  }

  let mean = sum / period;
  out[period - 1] = Math.sqrt(Math.max(0, sumSq / period - mean * mean));

  for (let i = period; i < n; i++) {
    const outgoing = values[i - period];
    const incoming = values[i];
    sum += incoming - outgoing;
    sumSq += incoming * incoming - outgoing * outgoing;
    mean = sum / period;
    out[i] = Math.sqrt(Math.max(0, sumSq / period - mean * mean));
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
//  Pipeline single-pass sem arrays intermédios:
//    1. +DM, -DM, TR calculados inline por barra
//    2. RMA inline para smoothTR, smooth±DM (1ª suavização)
//    3. DX calculado imediatamente a partir dos DI
//    4. RMA inline sobre DX → ADX (2ª suavização)
//
//  Reduz alocação de 7 arrays de tamanho N para 0 arrays
//  intermédios — apenas escalares de estado + 1 array de saída.
// ═══════════════════════════════════════════════════════════
function adxWilder(highs, lows, closes, period = 14) {
  const n = closes.length;
  const out = new Array(n).fill(null);
  if (n < period * 2) return out;

  const k = period - 1;

  // Estado RMA para TR, +DM, -DM (1ª suavização)
  let trSum = 0, plusDmSum = 0, minusDmSum = 0;
  let trRma = null, plusRma = null, minusRma = null;
  let count = 0;

  // Estado RMA para DX → ADX (2ª suavização)
  let dxSum = 0;
  let adxRma = null;
  let dxCount = 0;

  for (let i = 0; i < n; i++) {
    // ── TR inline ────────────────────────────────────────
    let tr;
    if (i === 0) {
      tr = highs[i] - lows[i];
    } else {
      const hl = highs[i] - lows[i];
      const hc = Math.abs(highs[i] - closes[i - 1]);
      const lc = Math.abs(lows[i] - closes[i - 1]);
      tr = Math.max(hl, hc, lc);
    }

    // ── +DM / -DM inline ────────────────────────────────
    let plusDM = 0, minusDM = 0;
    if (i > 0) {
      const up = highs[i] - highs[i - 1];
      const down = lows[i - 1] - lows[i];
      if (up > down && up > 0) plusDM = up;
      if (down > up && down > 0) minusDM = down;
    }

    // ── 1ª suavização RMA (TR, +DM, -DM) ────────────────
    count++;
    if (count < period) {
      trSum += tr;
      plusDmSum += plusDM;
      minusDmSum += minusDM;
    } else if (count === period) {
      trSum += tr;
      plusDmSum += plusDM;
      minusDmSum += minusDM;
      trRma = trSum / period;
      plusRma = plusDmSum / period;
      minusRma = minusDmSum / period;
    } else {
      trRma = (tr + k * trRma) / period;
      plusRma = (plusDM + k * plusRma) / period;
      minusRma = (minusDM + k * minusRma) / period;
    }

    // ── DX inline ───────────────────────────────────────
    if (trRma === null || plusRma === null || minusRma === null) continue;

    const plusDI = trRma === 0 ? 0 : 100 * plusRma / trRma;
    const minusDI = trRma === 0 ? 0 : 100 * minusRma / trRma;
    const diSum = plusDI + minusDI;
    const dx = diSum === 0 ? 0 : 100 * Math.abs(plusDI - minusDI) / diSum;

    // ── 2ª suavização RMA (DX → ADX) ────────────────────
    dxCount++;
    if (dxCount < period) {
      dxSum += dx;
    } else if (dxCount === period) {
      dxSum += dx;
      adxRma = dxSum / period;
      out[i] = adxRma;
    } else {
      adxRma = (dx + k * adxRma) / period;
      out[i] = adxRma;
    }
  }

  return out;
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
