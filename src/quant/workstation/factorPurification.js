'use strict';

// ═══════════════════════════════════════════════════════════
//  factorPurification.js — Fase 5: Purificação Fatorial (VIF)
//
//  Porta de src/features/purification.py (compute_vif +
//  neutralização setorial/size em duas etapas).
//
//  Objetivo no pipeline: numa data cross-sectional, eliminar
//  features colineares até VIF < 5.0 (limiar do pedido).
// ═══════════════════════════════════════════════════════════

// Resolve X·β = y (mínimos quadrados com intercepto embutido
// na matriz já aumentada). Retorna null se singular.
function solveLinearSystem(A, b) {
  const n = A.length;
  const M = A.map((row, i) => row.concat([b[i]]));
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    if (Math.abs(M[piv][col]) < 1e-12) return null;
    [M[col], M[piv]] = [M[piv], M[col]];
    const d = M[col][col];
    for (let j = col; j <= n; j++) M[col][j] /= d;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col];
      for (let j = col; j <= n; j++) M[r][j] -= f * M[col][j];
    }
  }
  return M.map(row => row[n]);
}

// OLS com intercepto. X: linhas=samplos, colunas=features.
function ols(X, y) {
  const p = X[0].length;
  // aumentar com coluna de 1s
  const A = X.map(row => [1, ...row]);
  // XtX e Xty
  const k = p + 1;
  const XtX = Array.from({ length: k }, () => new Array(k).fill(0));
  const Xty = new Array(k).fill(0);
  for (let i = 0; i < A.length; i++) {
    for (let a = 0; a < k; a++) {
      Xty[a] += A[i][a] * y[i];
      for (let b = 0; b < k; b++) XtX[a][b] += A[i][a] * A[i][b];
    }
  }
  const beta = solveLinearSystem(XtX, Xty);
  if (!beta) return null;
  let sse = 0, sst = 0;
  const yMean = y.reduce((s, v) => s + v, 0) / y.length;
  for (let i = 0; i < A.length; i++) {
    let pred = 0;
    for (let a = 0; a < k; a++) pred += beta[a] * A[i][a];
    sse += (y[i] - pred) ** 2;
    sst += (y[i] - yMean) ** 2;
  }
  const r2 = sst > 0 ? 1 - sse / sst : 0;
  return { beta, r2, residuals: y.map((v, i) => { let p2 = 0; for (let a = 0; a < k; a++) p2 += beta[a] * A[i][a]; return v - p2; }) };
}

// VIF por coluna: regressão contra as restantes.
function computeVIF(columns) {
  const names = Object.keys(columns);
  const k = names.length;
  if (k < 2) return names.map(f => ({ feature: f, vif: 1 }));
  const n = columns[names[0]].length;
  const out = [];
  for (let idx = 0; idx < k; idx++) {
    const y = columns[names[idx]];
    const otherNames = names.filter((_, j) => j !== idx);
    const X = [];
    for (let i = 0; i < n; i++) X.push(otherNames.map(f => columns[f][i]));
    // skip if any non-finite
    const valid = X.every(row => row.every(Number.isFinite)) && y.every(Number.isFinite);
    if (!valid) { out.push({ feature: names[idx], vif: NaN }); continue; }
    const res = ols(X, y);
    let vif = NaN;
    if (res) vif = res.r2 >= 0.999999 ? 1000 : 1 / (1 - res.r2);
    out.push({ feature: names[idx], vif: round2(vif) });
  }
  return out;
}

// Seleção gulosa: remove iterativamente a feature com maior VIF
// até todas terem VIF < threshold (>=2 amostras por feature).
function selectPurifiedFeatures(columns, threshold = 5.0) {
  let current = { ...columns };
  const removed = [];
  while (Object.keys(current).length >= 2) {
    const vifs = computeVIF(current).filter(v => Number.isFinite(v.vif));
    if (vifs.length === 0) break;
    const worst = vifs.reduce((a, b) => (b.vif > a.vif ? b : a));
    if (worst.vif < threshold) break;
    removed.push({ feature: worst.feature, vif: worst.vif });
    const next = { ...current };
    delete next[worst.feature];
    current = next;
  }
  const remainingVif = Object.keys(current).length >= 2 ? computeVIF(current) : Object.keys(current).map(f => ({ feature: f, vif: 1 }));
  return { kept: Object.keys(current), removed, vifReport: remainingVif };
}

// Neutralização em duas etapas (setor + size log-quadrática).
function neutralizeFeatureTwoStage(values, sectors, marketCaps) {
  const n = values.length;
  const clean = [];
  for (let i = 0; i < n; i++) if (Number.isFinite(values[i]) && sectors[i] != null && Number.isFinite(marketCaps[i])) clean.push(i);
  if (clean.length < 3) return values.map(() => null);

  // Etapa 1: dummies setoriais
  const uniqSectors = Array.from(new Set(clean.map(i => sectors[i])));
  const dummies = uniqSectors.slice(1); // drop_first
  const X1 = clean.map(i => dummies.map(s => (sectors[i] === s ? 1 : 0)));
  const y1 = clean.map(i => values[i]);
  const r1 = ols(X1, y1);
  const res1 = new Map();
  if (!r1) return values.map(() => null);
  clean.forEach((origIdx, j) => {
    let pred = r1.beta[0];
    for (let a = 0; a < X1[j].length; a++) pred += r1.beta[a + 1] * X1[j][a];
    res1.set(origIdx, y1[j] - pred);
  });

  // Etapa 2: log-mcap + log-mcap^2
  const X2 = clean.map(i => { const l = Math.log(Math.max(1, marketCaps[i])); return [l, l * l]; });
  const y2 = clean.map(i => res1.get(i));
  const r2 = ols(X2, y2);
  const out = values.map(() => null);
  clean.forEach((origIdx, j) => {
    if (!r2) return;
    let pred = r2.beta[0] + r2.beta[1] * X2[j][0] + r2.beta[2] * X2[j][1];
    out[origIdx] = y2[j] - pred;
  });
  return out;
}

function round2(v) { return Number.isFinite(v) ? Math.round(v * 100) / 100 : v; }

module.exports = {
  solveLinearSystem,
  ols,
  computeVIF,
  selectPurifiedFeatures,
  neutralizeFeatureTwoStage
};
