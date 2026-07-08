// ─────────────────────────────────────────────────────────────
//  indicators.js  –  Funções quantitativas alinhadas com TradingView
//  Todas as suavizações usam a fórmula exata do ta.rma() do Pine Script:
//    rma[0]           = sma(source, period)        (seed = média aritmética)
//    rma[i], i >= 1   = (value + (period-1) * rma[i-1]) / period
// ─────────────────────────────────────────────────────────────

'use strict';

// ── SMA ─────────────────────────────────────────────────────
function sma(values, period) {
  const n = values.length;
  const out = new Array(n).fill(null);
  if (n < period) return out;

  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i];
  out[period - 1] = sum / period;

  for (let i = period; i < n; i++) {
    sum += values[i] - values[i - period];
    out[i] = sum / period;
  }
  return out;
}

// ── EMA ─────────────────────────────────────────────────────
function ema(values, period) {
  const n = values.length;
  const out = new Array(n).fill(null);
  if (n < period) return out;

  const k = 2 / (period + 1);
  let seed = 0;
  for (let i = 0; i < period; i++) seed += values[i];
  out[period - 1] = seed / period;

  for (let i = period; i < n; i++) {
    out[i] = values[i] * k + out[i - 1] * (1 - k);
  }
  return out;
}

// ── Standard Deviation (population, N divisor – matches TradingView ta.stdev) ─
function stddev(values, period) {
  const n = values.length;
  const out = new Array(n).fill(null);
  if (n < period) return out;

  for (let i = period - 1; i < n; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += values[j];
    const mean = sum / period;
    let sq = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const d = values[j] - mean;
      sq += d * d;
    }
    // TradingView ta.stdev uses population stddev (divides by N, not N-1)
    out[i] = Math.sqrt(sq / period);
  }
  return out;
}

// ── RMA (Wilder's Moving Average) ──────────────────────────
// Fórmula exata do ta.rma() do Pine Script:
//   Seed (primeiro valor) = SMA dos primeiros `period` valores válidos
//   Subsequente: rma = (value + (period - 1) * prev_rma) / period
//
// Trata valores null/undefined/NaN como se não existissem, preservando
// a contagem interna de warm-up para que o seed comece no lugar certo.
function rma(values, period) {
  const n = values.length;
  const out = new Array(n).fill(null);

  let sum = 0;
  let count = 0;
  let prevRma = null;

  for (let i = 0; i < n; i++) {
    const val = values[i];
    if (val === null || val === undefined || isNaN(val)) {
      // Sem valor → mantém null na saída
      continue;
    }

    count++;

    if (count < period) {
      // Fase de acumulação – somamos para o seed
      sum += val;
    } else if (count === period) {
      // Seed: SMA dos primeiros `period` valores válidos
      sum += val;
      prevRma = sum / period;
      out[i] = prevRma;
    } else {
      // Suavização de Wilder
      prevRma = (val + (period - 1) * prevRma) / period;
      out[i] = prevRma;
    }
  }
  return out;
}

// ── True Range ──────────────────────────────────────────────
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

// ── ATR (Wilder) ────────────────────────────────────────────
function atrWilder(highs, lows, closes, period = 14) {
  const tr = trueRange(highs, lows, closes);
  return rma(tr, period);
}

// ── RSI (Wilder) ────────────────────────────────────────────
// Implementação que replica exatamente o ta.rsi() do Pine Script:
//   1. Calcula change = close[i] - close[i-1]
//   2. gain = max(change, 0), loss = max(-change, 0)
//   3. avgGain = rma(gain, period), avgLoss = rma(loss, period)
//   4. rs = avgGain / avgLoss
//   5. rsi = 100 - (100 / (1 + rs))
function rsiWilder(closes, period = 21) {
  const n = closes.length;
  const out = new Array(n).fill(null);
  if (n <= period) return out;

  // Séries de gain e loss (o índice 0 não tem change, fica 0)
  const gains = new Array(n).fill(0);
  const losses = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const change = closes[i] - closes[i - 1];
    gains[i] = change > 0 ? change : 0;
    losses[i] = change < 0 ? -change : 0;
  }

  // Suavização RMA sobre gains e losses (começando no índice 1)
  // Precisamos ignorar gains[0]/losses[0] porque não há change no bar 0.
  // Fazemos o RMA manualmente para alinhar com o Pine Script.
  let sumGain = 0;
  let sumLoss = 0;

  // Seed: SMA dos primeiros `period` changes (índices 1..period)
  for (let i = 1; i <= period; i++) {
    sumGain += gains[i];
    sumLoss += losses[i];
  }

  let avgGain = sumGain / period;
  let avgLoss = sumLoss / period;

  // Primeiro RSI válido aparece no índice `period`
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  // Suavização de Wilder para os restantes
  for (let i = period + 1; i < n; i++) {
    avgGain = (gains[i] + (period - 1) * avgGain) / period;
    avgLoss = (losses[i] + (period - 1) * avgLoss) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }

  return out;
}

// ── ADX (Wilder) ────────────────────────────────────────────
// Replica o ta.dmi() / ADX do TradingView:
//   1. +DM / -DM conforme regras clássicas de Wilder
//   2. Smooth +DM, -DM e TR com RMA(period)
//   3. +DI = 100 * rma(+DM) / rma(TR)
//   4. -DI = 100 * rma(-DM) / rma(TR)
//   5. DX = 100 * |+DI - -DI| / (+DI + -DI)
//   6. ADX = RMA(DX, period)   ← segunda suavização de Wilder
function adxWilder(highs, lows, closes, period = 14) {
  const n = closes.length;
  const out = new Array(n).fill(null);
  if (n < period * 2 + 1) return out;

  // +DM / -DM
  const plusDM = new Array(n).fill(0);
  const minusDM = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const up = highs[i] - highs[i - 1];
    const down = lows[i - 1] - lows[i];
    plusDM[i] = (up > down && up > 0) ? up : 0;
    minusDM[i] = (down > up && down > 0) ? down : 0;
  }

  // True Range
  const tr = trueRange(highs, lows, closes);

  // Primeira suavização RMA (para +DM, -DM e TR)
  const trSmooth = rma(tr, period);
  const plusDMSmooth = rma(plusDM, period);
  const minusDMSmooth = rma(minusDM, period);

  // Calcular DX série
  const dx = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    if (trSmooth[i] === null || plusDMSmooth[i] === null || minusDMSmooth[i] === null) {
      continue;
    }
    const trVal = trSmooth[i];
    const plusDI = trVal === 0 ? 0 : 100 * plusDMSmooth[i] / trVal;
    const minusDI = trVal === 0 ? 0 : 100 * minusDMSmooth[i] / trVal;
    const diSum = plusDI + minusDI;
    dx[i] = diSum === 0 ? 0 : 100 * Math.abs(plusDI - minusDI) / diSum;
  }

  // Segunda suavização RMA sobre o DX → ADX
  return rma(dx, period);
}

// ── Bollinger Bands ─────────────────────────────────────────
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
