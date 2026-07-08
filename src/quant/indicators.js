function sma(values, period) {
  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;
  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i];
  out[period - 1] = sum / period;
  for (let i = period; i < values.length; i++) {
    sum += values[i] - values[i - period];
    out[i] = sum / period;
  }
  return out;
}

function ema(values, period) {
  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let prev = 0;
  for (let i = 0; i < period; i++) prev += values[i];
  out[period - 1] = prev / period;
  for (let i = period; i < values.length; i++) {
    out[i] = values[i] * k + out[i - 1] * (1 - k);
  }
  return out;
}

function stddev(values, period) {
  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;
  for (let i = period - 1; i < values.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += values[j];
    const mean = sum / period;
    let sq = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const d = values[j] - mean;
      sq += d * d;
    }
    out[i] = period > 1 ? Math.sqrt(sq / (period - 1)) : 0;
  }
  return out;
}

function rsiWilder(closes, period = 21) {
  const out = new Array(closes.length).fill(null);
  if (closes.length <= period) return out;
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const ch = closes[i] - closes[i - 1];
    if (ch > 0) avgGain += ch;
    else avgLoss += -ch;
  }
  avgGain /= period;
  avgLoss /= period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < closes.length; i++) {
    const ch = closes[i] - closes[i - 1];
    const gain = ch > 0 ? ch : 0;
    const loss = ch < 0 ? -ch : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

function trueRange(highs, lows, closes) {
  const tr = new Array(closes.length).fill(0);
  tr[0] = highs[0] - lows[0];
  for (let i = 1; i < closes.length; i++) {
    const a = highs[i] - lows[i];
    const b = Math.abs(highs[i] - closes[i - 1]);
    const c = Math.abs(lows[i] - closes[i - 1]);
    tr[i] = Math.max(a, b, c);
  }
  return tr;
}

function atrWilder(highs, lows, closes, period = 14) {
  const tr = trueRange(highs, lows, closes);
  const out = new Array(tr.length).fill(null);
  if (tr.length <= period) return out;
  let prev = 0;
  for (let i = 0; i < period; i++) prev += tr[i];
  out[period - 1] = prev / period;
  for (let i = period; i < tr.length; i++) {
    out[i] = (out[i - 1] * (period - 1) + tr[i]) / period;
  }
  return out;
}

function rma(values, period) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  let count = 0;
  let lastRma = null;

  for (let i = 0; i < values.length; i++) {
    const val = values[i];
    if (val === null || val === undefined || isNaN(val)) {
      continue;
    }
    count++;
    if (count < period) {
      sum += val;
    } else if (count === period) {
      sum += val;
      lastRma = sum / period;
      out[i] = lastRma;
    } else {
      lastRma = (val + (period - 1) * lastRma) / period;
      out[i] = lastRma;
    }
  }
  return out;
}

function adxWilder(highs, lows, closes, period = 14) {
  const len = closes.length;
  const out = new Array(len).fill(null);
  if (len < period * 2) return out;

  const plusDM = new Array(len).fill(0);
  const minusDM = new Array(len).fill(0);
  for (let i = 1; i < len; i++) {
    const up = highs[i] - highs[i - 1];
    const down = lows[i - 1] - lows[i];
    plusDM[i] = (up > down && up > 0) ? up : 0;
    minusDM[i] = (down > up && down > 0) ? down : 0;
  }

  const tr = trueRange(highs, lows, closes);
  const trur = rma(tr, period);
  const plusDMRma = rma(plusDM, period);
  const minusDMRma = rma(minusDM, period);

  const dx = new Array(len).fill(null);
  for (let i = 0; i < len; i++) {
    if (trur[i] === null || plusDMRma[i] === null || minusDMRma[i] === null) {
      continue;
    }
    const trurVal = trur[i];
    const plusDI = trurVal === 0 ? 0 : 100 * plusDMRma[i] / trurVal;
    const minusDI = trurVal === 0 ? 0 : 100 * minusDMRma[i] / trurVal;
    const sum = plusDI + minusDI;
    dx[i] = sum === 0 ? 0 : (100 * Math.abs(plusDI - minusDI)) / sum;
  }

  return rma(dx, period);
}

function bollingerBands(closes, period = 30, mult = 2.0) {
  const mid = sma(closes, period);
  const sd = stddev(closes, period);
  const upper = new Array(closes.length).fill(null);
  const lower = new Array(closes.length).fill(null);
  const pctB = new Array(closes.length).fill(null);
  for (let i = 0; i < closes.length; i++) {
    if (mid[i] != null && sd[i] != null) {
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
  rsiWilder,
  atrWilder,
  adxWilder,
  bollingerBands,
  trueRange
};
