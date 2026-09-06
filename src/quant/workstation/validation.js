'use strict';

// ═══════════════════════════════════════════════════════════
//  validation.js — Fase 6: CPCV, Deflated Sharpe Ratio e PBO
//
//  Porta de src/validation/cpcv_evaluator.py (López de Prado).
//  Distribuição normal (pdf/cdf/ppf) sem dependências externas.
// ═══════════════════════════════════════════════════════════

const { mean, stdev, skewness, kurtosis, TRADING_DAYS } = require('./metrics');

// ── Função de erro (Abramowitz & Stegun 7.1.26) ───────────
function erf(x) {
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return sign * y;
}

function normCdf(z) {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

function normPdf(z) {
  return Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI);
}

// ── Inverso da normal padrão (Acklam) ──────────────────────
function normPpf(p) {
  if (p <= 0) return -8;
  if (p >= 1) return 8;
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615366568937758e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
  const pl = 0.02425, ph = 1 - pl;
  let q, r;
  if (p < pl) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p <= ph) {
    q = p - 0.5; r = q * q;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }
  q = Math.sqrt(-2 * Math.log(1 - p));
  return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
}

function sharpeRatio(returns) {
  const s = stdev(returns);
  if (returns.length < 2 || s === 0) return 0;
  return (mean(returns) / s) * Math.sqrt(TRADING_DAYS);
}

// ── Deflated Sharpe Ratio (probabilidade, 0..1) ────────────
//    sr_hat observada vs benchmark esperado dado n_trials,
//    ajustado a assimetria e curtose.
function deflatedSharpeRatio(returns, nTrials = 10, expectedSR = 0) {
  const arr = Array.isArray(returns) ? returns : [];
  const T = arr.length;
  if (T < 2) return 0;

  const srHat = sharpeRatio(arr);
  const sk = skewness(arr);
  const ku = kurtosis(arr); // total (excess + 3)

  let denomVar = 1 - sk * srHat + ((ku - 1) / 4) * (srHat * srHat);
  if (denomVar <= 0) denomVar = 1e-8;
  const srStd = Math.sqrt(denomVar / (T - 1));

  let srBenchmark = expectedSR;
  if (nTrials > 1) {
    const euler = 0.5772156649;
    const z1 = normPpf(1 - 1 / nTrials);
    const z2 = normPpf(1 - 1 / (nTrials * Math.E));
    srBenchmark = expectedSR + srStd * ((1 - euler) * z1 + euler * z2);
  }

  const z = (srHat - srBenchmark) / (srStd + 1e-8);
  return Math.max(0, Math.min(1, normCdf(z)));
}

// ── CPCV Splitter (combinatorial purged k-fold) ────────────
function* cpcvSplit(nSamples, { nGroups = 5, kTestGroups = 2, purgeWindow = 10, embargoWindow = 10 } = {}) {
  const groupSize = Math.floor(nSamples / nGroups);
  if (groupSize <= 0) return;
  const bounds = [];
  for (let g = 0; g < nGroups; g++) {
    const start = g * groupSize;
    const end = g === nGroups - 1 ? nSamples : (g + 1) * groupSize;
    bounds.push([start, end]);
  }
  const idx = Array.from({ length: nGroups }, (_, i) => i);
  for (const testGroups of combinations(idx, kTestGroups)) {
    const testMask = new Array(nSamples).fill(false);
    const trainMask = new Array(nSamples).fill(true);
    for (const g of testGroups) {
      const [start, end] = bounds[g];
      for (let i = start; i < end; i++) testMask[i] = true;
      const ps = Math.max(0, start - purgeWindow);
      const pe = Math.min(nSamples, end + purgeWindow);
      for (let i = ps; i < pe; i++) trainMask[i] = false;
      const ee = Math.min(nSamples, end + embargoWindow);
      for (let i = end; i < ee; i++) trainMask[i] = false;
    }
    const train = [], test = [];
    for (let i = 0; i < nSamples; i++) {
      if (trainMask[i]) train.push(i);
      if (testMask[i]) test.push(i);
    }
    yield { train, test };
  }
}

function combinations(arr, k) {
  const res = [];
  const combo = [];
  const recurse = (start) => {
    if (combo.length === k) { res.push(combo.slice()); return; }
    for (let i = start; i < arr.length; i++) { combo.push(arr[i]); recurse(i + 1); combo.pop(); }
  };
  recurse(0);
  return res;
}

// ── PBO a partir de matrizes IS/OOS (nCombos × nStrategies) ─
function pboFromCPCV(isMatrix, oosMatrix) {
  const nCombos = isMatrix.length;
  if (nCombos === 0) return 0;
  let under = 0;
  for (let c = 0; c < nCombos; c++) {
    let bestIs = 0, bestIsVal = -Infinity;
    for (let s = 0; s < isMatrix[c].length; s++) {
      if (isMatrix[c][s] > bestIsVal) { bestIsVal = isMatrix[c][s]; bestIs = s; }
    }
    const oosOfBest = oosMatrix[c][bestIs];
    const row = oosMatrix[c].slice().sort((a, b) => a - b);
    const median = row.length % 2 ? row[(row.length - 1) / 2] : (row[row.length / 2 - 1] + row[row.length / 2]) / 2;
    if (oosOfBest < median) under++;
  }
  return under / nCombos;
}

// ── Validação agregada da estratégia simulada ──────────────
//    Divide os retornos diários em blocos, corre CPCV sobre o
//    PnL diário (proxy de um "estratégia candidata" por bloco de
//    parâmetros se houver) e devolve DSR/PBO/Sharpe OOS.
function validateStrategy(dailyReturns, { nGroups = 5, kTestGroups = 2, nTrials = 10 } = {}) {
  const r = Array.isArray(dailyReturns) ? dailyReturns.filter(x => Number.isFinite(x)) : [];
  if (r.length < nGroups * 4) {
    return { valid: false, dsr: 0, pbo: 0, sharpeOOS: sharpeRatio(r), nCombinations: 0, isApproved: false, reason: 'Amostra insuficiente para CPCV' };
  }
  const isSharpes = [];
  const oosSharpes = [];
  let nCombos = 0;
  for (const { train, test } of cpcvSplit(r.length, { nGroups, kTestGroups })) {
    if (train.length < 2 || test.length < 2) continue;
    isSharpes.push([sharpeRatio(train.map(i => r[i]))]);
    oosSharpes.push([sharpeRatio(test.map(i => r[i]))]);
    nCombos++;
  }
  const oosFlat = [];
  for (const { test } of cpcvSplit(r.length, { nGroups, kTestGroups })) {
    for (const i of test) oosFlat.push(r[i]);
  }
  const meanOos = mean(oosSharpes.map(x => x[0]));
  const dsr = deflatedSharpeRatio(oosFlat.length > 1 ? oosFlat : r, nTrials);
  const pbo = nCombos >= 2 && isSharpes[0].length >= 2 ? pboFromCPCV(isSharpes, oosSharpes) : 0;
  return {
    valid: true,
    nCombinations: nCombos,
    sharpeOOS: round2(meanOos),
    dsr: round4(dsr),
    dsrPercent: round2(dsr * 100),
    pbo: round4(pbo),
    pboPercent: round1(pbo * 100),
    isApproved: dsr > 0.95 && pbo < 0.30
  };
}

function round1(v) { return Math.round((Number(v) || 0) * 10) / 10; }
function round2(v) { return Math.round((Number(v) || 0) * 100) / 100; }
function round4(v) { return Math.round((Number(v) || 0) * 10000) / 10000; }

module.exports = {
  erf,
  normCdf,
  normPdf,
  normPpf,
  sharpeRatio,
  deflatedSharpeRatio,
  cpcvSplit,
  combinations,
  pboFromCPCV,
  validateStrategy
};
