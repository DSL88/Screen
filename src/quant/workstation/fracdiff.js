'use strict';

// ═══════════════════════════════════════════════════════════
//  fracdiff.js — Fase 3: Diferenciação Fracionária (FFD)
//
//  Porta de src/features/fracdiff.py (López de Prado, Cap. 5).
//  Inclui teste ADF simplificado (estatística t de beta em
//  Δy_{t-1} ~ y_{t-1}, 1 lag) com valor crítico ~ -2.86 (5%).
//
//  McGinley Dynamic é reutilizado de ../indicators.
// ═══════════════════════════════════════════════════════════

const { mcginleyDynamic } = require('../indicators');

// ── Pesos FFD de janela fixa (1 - B)^d ─────────────────────
function getFFDWeights(d, thres = 1e-4, maxLags = 2000) {
  if (d === 0) return [1.0];
  const w = [1.0];
  let k = 1;
  while (k < maxLags) {
    const wk = (-w[w.length - 1] / k) * (d - k + 1);
    if (Math.abs(wk) < thres) break;
    w.push(wk);
    k++;
  }
  return w.reverse(); // [w_K, ..., w_0] p/ convolução "valid"
}

// ── Série fracionariamente diferenciada (FFT-free) ─────────
function fracDiffFFD(values, d, thres = 1e-4, useLog = false) {
  const n = values.length;
  let src = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const v = Number(values[i]);
    src[i] = useLog ? Math.log(v > 0 ? v : NaN) : v;
  }
  if (d === 0) return Array.from(src);

  let weights = getFFDWeights(d, thres);
  let width = weights.length;
  if (width > n) {
    weights = getFFDWeights(d, thres, Math.max(2, Math.floor(n / 2)));
    width = weights.length;
  }
  const out = new Array(n).fill(NaN);
  for (let i = width - 1; i < n; i++) {
    let acc = 0;
    for (let j = 0; j < width; j++) acc += weights[j] * src[i - width + 1 + j];
    out[i] = acc;
  }
  return out;
}

// ── Teste ADF (1 lag, sem trend/const? usa const. implícita via beta) ─
function adfTest(series) {
  const y = (Array.isArray(series) ? series : Array.from(series)).filter(x => Number.isFinite(x));
  const n = y.length;
  if (n < 20) return { stat: 0, pValue: 1.0 };

  // Δy_t = alpha + beta*y_{t-1} + gamma*Δy_{t-1} + eps
  // Mínimos quadrados por eliminação (3 regressores).
  const dy = new Array(n - 1);
  const ylag = new Array(n - 1);
  const dylag = new Array(n - 1);
  for (let t = 1; t < n; t++) {
    dy[t - 1] = y[t] - y[t - 1];
    ylag[t - 1] = y[t - 1];
    dylag[t - 1] = t >= 2 ? y[t - 1] - y[t - 2] : 0;
  }
  const m = dy.length;
  // X = [1, ylag, dylag]
  const XtX = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  const Xty = [0, 0, 0];
  for (let i = 0; i < m; i++) {
    const x = [1, ylag[i], dylag[i]];
    for (let a = 0; a < 3; a++) {
      Xty[a] += x[a] * dy[i];
      for (let b = 0; b < 3; b++) XtX[a][b] += x[a] * x[b];
    }
  }
  const inv = invert3(XtX);
  if (!inv) return { stat: 0, pValue: 1.0 };
  const beta = [0, 0, 0];
  for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) beta[a] += inv[a][b] * Xty[b];

  // Resíduos e variância
  let sse = 0;
  for (let i = 0; i < m; i++) {
    const x = [1, ylag[i], dylag[i]];
    const pred = beta[0] * x[0] + beta[1] * x[1] + beta[2] * x[2];
    const e = dy[i] - pred;
    sse += e * e;
  }
  const sigma2 = sse / (m - 3);
  const seBeta = Math.sqrt(Math.max(1e-18, sigma2 * inv[1][1]));
  const stat = beta[1] / seBeta;
  // Valor crítico aproximado ADF (const, sem trend): -2.86 (5%)
  const pValue = stat < -3.43 ? 0.01 : (stat < -2.86 ? 0.05 : (stat < -1.98 ? 0.10 : 1.0));
  return { stat, pValue };
}

function invert3(M) {
  const [[a, b, c], [d, e, f], [g, h, i]] = M;
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
  const id = 1 / det;
  return [
    [(e * i - f * h) * id, (c * h - b * i) * id, (b * f - c * e) * id],
    [(f * g - d * i) * id, (a * i - c * g) * id, (c * d - a * f) * id],
    [(d * h - e * g) * id, (b * g - a * h) * id, (a * e - b * d) * id]
  ];
}

// ── Ordem ótima d* mínima que torna a série estacionária ───
function findOptimalD(values, { dRange = [0, 1], step = 0.05, pThreshold = 0.05, thres = 1e-4 } = {}) {
  const clean = (Array.isArray(values) ? values : Array.from(values)).filter(x => Number.isFinite(x) && x > 0);
  const optimal = { optimalD: null, adfPValue: 1, correlation: 0, isStationary: false };
  for (let d = dRange[0]; d <= dRange[1] + 1e-9; d = +(d + step).toFixed(4)) {
    const fd = fracDiffFFD(clean, d, thres, true).filter(Number.isFinite);
    if (fd.length < 20) continue;
    const { stat, pValue } = adfTest(fd);
    const corr = correlation(clean.slice(clean.length - fd.length), fd);
    if (pValue < pThreshold) {
      return { optimalD: d, adfStat: stat, adfPValue: pValue, correlation: corr, isStationary: true };
    }
    if (optimal.optimalD === null || pValue < optimal.adfPValue) {
      optimal.optimalD = d; optimal.adfStat = stat; optimal.adfPValue = pValue; optimal.correlation = corr;
    }
  }
  return { ...optimal, isStationary: optimal.adfPValue < pThreshold };
}

function correlation(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < 2) return 0;
  let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    const xa = a[i] - ma, xb = b[i] - mb;
    num += xa * xb; da += xa * xa; db += xb * xb;
  }
  const den = Math.sqrt(da * db);
  return den > 0 ? num / den : 0;
}

// ── McGinley Dynamic Ratio (preço vs McGinley) ─────────────
function mcginleyRatio(closes, period = 14, k = 0.6) {
  const mg = mcginleyDynamic(closes, period, k);
  return closes.map((c, i) => (mg[i] != null && mg[i] > 0 ? c / mg[i] : null));
}

module.exports = {
  getFFDWeights,
  fracDiffFFD,
  adfTest,
  findOptimalD,
  correlation,
  mcginleyRatio
};
