'use strict';

// ═══════════════════════════════════════════════════════════
//  sentimentProxy.js — Fase 4 (bypass histórico)
//
//  Em backtests de longo prazo (>1 ano) não existem manchetes
//  diárias arquivadas (2005/2015). O FinBERT é feito Bypass e
//  substituído por uma métrica de divergência Preço-Volume via
//  Z-scores de 5 dias (proxy de convicção institucional).
//
//  Divergência > +threshold  → BULLISH_DIVERGENCE (proxy +1)
//  Divergência < -threshold  → BEARISH_DIVERGENCE (proxy -1)
// ═══════════════════════════════════════════════════════════

function zscoreAt(arr, i, window) {
  const start = Math.max(0, i - window + 1);
  const slice = arr.slice(start, i + 1).filter(Number.isFinite);
  if (slice.length < 2) return 0;
  const m = slice.reduce((s, v) => s + v, 0) / slice.length;
  const sd = Math.sqrt(slice.reduce((s, v) => s + (v - m) ** 2, 0) / slice.length);
  const cur = arr[i];
  if (!Number.isFinite(cur) || sd === 0) return 0;
  return (cur - m) / sd;
}

function pctChange(arr, i) {
  if (i < 1) return 0;
  const p = arr[i - 1];
  return p > 0 ? arr[i] / p - 1 : 0;
}

// Devolve, para cada índice i, um score de sentimento [-1, 1]
// baseado na divergência entre o z-score do retorno e o do volume.
function computePVSentimentProxy(closes, volumes, { window = 5, threshold = 2.0 } = {}) {
  const n = closes.length;
  const priceRet = new Array(n).fill(0);
  const volChg = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    priceRet[i] = pctChange(closes, i);
    volChg[i] = i >= 1 && volumes[i - 1] > 0 ? volumes[i] / volumes[i - 1] - 1 : 0;
  }
  const out = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    const zPrice = zscoreAt(priceRet, i, window);
    const zVol = zscoreAt(volChg, i, window);
    const divergence = zVol - zPrice;
    if (divergence >= threshold) out[i] = 1;
    else if (divergence <= -threshold) out[i] = -1;
    else out[i] = Math.max(-1, Math.min(1, divergence / (threshold || 1)));
  }
  return out;
}

module.exports = { computePVSentimentProxy };
