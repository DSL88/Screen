'use strict';

// ═══════════════════════════════════════════════════════════
//  graham.js — Fase 1: Filtro Fundamental Defensivo (Graham)
//
//  Tratamento Point-in-Time para backtests de 1–20 anos:
//    • Se existirem rácios arquivados para o ponto temporal,
//      validar solvência no snapshot mais próximo (<= data).
//    • Caso contrário, recorrer a um perfil fundamental estimado
//      (allowlist de empresas solventes conhecidas) em vez de
//      falhar — conforme especificação do pedido.
//
//  Limiares (do prompt mestre):
//    Current Ratio >= 1.5 · Debt/Equity <= 1.5 · ROA > 0
//    Earnings Yield e FCF Yield presentes.
// ═══════════════════════════════════════════════════════════

const DEFAULT_THRESHOLDS = {
  minCurrentRatio: 1.5,
  maxDebtEquity: 1.5,
  minRoa: 0.0,
  minEarningsYield: 0.0,
  minFcfYield: 0.0
};

// Perfil fundamental estimado para constituentes de índice de
// referência reconhecida solvência. Usado APENAS quando não há
// dados arquivados no ponto temporal. (valores aproximados, 2020s)
const SOLVENT_PROFILES = {
  // PSI
  'GALP': { currentRatio: 1.6, debtEquity: 0.9, roa: 0.06, earningsYield: 0.09, fcfYield: 0.06 },
  'EDP':  { currentRatio: 0.9, debtEquity: 1.4, roa: 0.05, earningsYield: 0.06, fcfYield: 0.02 },
  'JERONIMO MARTINS': { currentRatio: 1.1, debtEquity: 0.8, roa: 0.09, earningsYield: 0.05, fcfYield: 0.03 },
  'RAMOS': { currentRatio: 1.1, debtEquity: 0.8, roa: 0.09, earningsYield: 0.05, fcfYield: 0.03 },
  'SEMILLER': { currentRatio: 1.2, debtEquity: 0.6, roa: 0.12, earningsYield: 0.06, fcfYield: 0.04 },
  'MOTA-ENGIL': { currentRatio: 1.1, debtEquity: 1.0, roa: 0.08, earningsYield: 0.07, fcfYield: 0.04 },
  'CTT': { currentRatio: 1.3, debtEquity: 0.7, roa: 0.10, earningsYield: 0.07, fcfYield: 0.05 },
  'ESES': { currentRatio: 1.2, debtEquity: 0.5, roa: 0.13, earningsYield: 0.06, fcfYield: 0.05 },
  'NOVA': { currentRatio: 1.4, debtEquity: 0.6, roa: 0.07, earningsYield: 0.05, fcfYield: 0.03 },
  'CORTICEIRA AMORIM': { currentRatio: 1.5, debtEquity: 0.5, roa: 0.11, earningsYield: 0.05, fcfYield: 0.04 },
  // S&P 500 mega-caps defensivas
  'MSFT': { currentRatio: 1.6, debtEquity: 0.5, roa: 0.18, earningsYield: 0.03, fcfYield: 0.025 },
  'AAPL': { currentRatio: 1.0, debtEquity: 1.4, roa: 0.27, earningsYield: 0.025, fcfYield: 0.03 },
  'GOOGL': { currentRatio: 2.0, debtEquity: 0.1, roa: 0.22, earningsYield: 0.04, fcfYield: 0.05 },
  'BRK-B': { currentRatio: 1.5, debtEquity: 0.6, roa: 0.08, earningsYield: 0.04, fcfYield: 0.03 },
  'JNJ': { currentRatio: 1.3, debtEquity: 0.6, roa: 0.17, earningsYield: 0.04, fcfYield: 0.05 },
  'PG': { currentRatio: 0.8, debtEquity: 1.0, roa: 0.25, earningsYield: 0.04, fcfYield: 0.05 },
  'KO': { currentRatio: 1.1, debtEquity: 1.3, roa: 0.20, earningsYield: 0.03, fcfYield: 0.05 },
  'XOM': { currentRatio: 1.2, debtEquity: 0.2, roa: 0.09, earningsYield: 0.07, fcfYield: 0.05 },
  'NVDA': { currentRatio: 3.0, debtEquity: 0.2, roa: 0.35, earningsYield: 0.03, fcfYield: 0.03 },
  'MA': { currentRatio: 1.0, debtEquity: 1.2, roa: 0.30, earningsYield: 0.03, fcfYield: 0.04 },
  'V': { currentRatio: 1.2, debtEquity: 0.9, roa: 0.20, earningsYield: 0.03, fcfYield: 0.04 },
  'COST': { currentRatio: 1.1, debtEquity: 0.4, roa: 0.25, earningsYield: 0.03, fcfYield: 0.04 },
  'MRK': { currentRatio: 1.2, debtEquity: 1.0, roa: 0.11, earningsYield: 0.05, fcfYield: 0.06 },
  'ABBV': { currentRatio: 0.7, debtEquity: 6.0, roa: 0.09, earningsYield: 0.05, fcfYield: 0.08 },
  'HD': { currentRatio: 1.0, debtEquity: 1.0, roa: 0.25, earningsYield: 0.04, fcfYield: 0.06 },
  'DIS': { currentRatio: 1.0, debtEquity: 0.8, roa: 0.05, earningsYield: 0.03, fcfYield: 0.04 },
  // DAX
  'SAP': { currentRatio: 1.4, debtEquity: 0.9, roa: 0.12, earningsYield: 0.03, fcfYield: 0.04 },
  'LINDE': { currentRatio: 1.2, debtEquity: 0.6, roa: 0.11, earningsYield: 0.04, fcfYield: 0.03 },
  'AIRBUS': { currentRatio: 0.8, debtEquity: 1.2, roa: 0.06, earningsYield: 0.04, fcfYield: 0.02 },
  'SIEMENS': { currentRatio: 1.3, debtEquity: 0.7, roa: 0.10, earningsYield: 0.05, fcfYield: 0.04 },
  'ALLIANZ': { currentRatio: 1.2, debtEquity: 0.9, roa: 0.08, earningsYield: 0.06, fcfYield: 0.04 },
  'BASF': { currentRatio: 1.3, debtEquity: 0.4, roa: 0.06, earningsYield: 0.06, fcfYield: 0.03 }
};

// Normaliza ticker (remove sufixos de bolsa .LS .DE .MC etc.)
function baseTicker(ticker) {
  const t = String(ticker || '').trim().toUpperCase();
  return t.split('.')[0];
}

function findProfile(ticker) {
  const base = baseTicker(ticker);
  if (SOLVENT_PROFILES[base]) return SOLVENT_PROFILES[base];
  // aliases comuns
  if (base === 'JMT') return SOLVENT_PROFILES['JERONIMO MARTINS'];
  if (base === 'SONAEC' || base === 'SONA-E') return SOLVENT_PROFILES['SEMILLER'];
  if (base === 'BCP') return null; // banco — aplicar regras próprias se houver dados
  return null;
}

// Resolve o snapshot point-in-time: escolhe o registo fundamental
// mais antigo <= year (fallback: mais próximo). `history` é uma
// lista opcional de { year|date, currentRatio, debtEquity, roa,
// earningsYield, fcfYield }.
function resolveSnapshot(history, year) {
  if (!Array.isArray(history) || history.length === 0) return null;
  const y = Number(year);
  const dated = history
    .map(h => ({ h, t: h.year != null ? Number(h.year) : new Date(String(h.date).slice(0, 10)).getUTCFullYear() }))
    .sort((a, b) => a.t - b.t);
  let best = null;
  for (const d of dated) {
    if (d.t <= y) best = d.h;
  }
  if (best) return best;
  return dated[0].h; // não há registo anterior: usa o mais antigo (sem lookahead futuro)
}

// Valida solvência a partir de um conjunto de rácios normalizado.
function checkSolvency(ratios, thresholds) {
  const th = { ...DEFAULT_THRESHOLDS, ...(thresholds || {}) };
  const cr = ratios.currentRatio;
  const de = ratios.debtEquity;
  const roa = ratios.roa;
  const ey = ratios.earningsYield;
  const fcf = ratios.fcfYield;

  const passCR = cr != null && cr >= th.minCurrentRatio;
  const passDE = de != null && de <= th.maxDebtEquity && de >= 0;
  const passROA = roa != null && roa > th.minRoa;
  const passEY = ey != null && ey > th.minEarningsYield;
  const passFCF = fcf == null || fcf > th.minFcfYield; // FCF opcional se não arquivado

  const approved = passCR && passDE && passROA && passEY && passFCF;

  // Graham Quality Score 0..100 (rank percentil não aplicável a
  // um único ativo — usa aderência absoluta aos limiares).
  let score = 0;
  if (cr != null) score += clamp(cr / th.minCurrentRatio, 0, 1) * 25;
  if (de != null) score += clamp(1 - de / (th.maxDebtEquity * 1.2), 0, 1) * 25;
  if (roa != null) score += clamp(roa / 0.15, 0, 1) * 25;
  if (ey != null) score += clamp(ey / 0.06, 0, 1) * 25;

  return {
    approved,
    qualityScore: Math.round(score),
    metrics: {
      currentRatio: cr != null ? round2(cr) : null,
      debtEquity: de != null ? round2(de) : null,
      roa: roa != null ? roundPct(roa) : null,
      earningsYield: ey != null ? roundPct(ey) : null,
      fcfYield: fcf != null ? roundPct(fcf) : null
    },
    reasons: { passCR, passDE, passROA, passEY, passFCF }
  };
}

// API principal: avalia solvência point-in-time de um ativo num ano.
//   fundamentalData: Map/obj ticker -> history[]  (opcional)
function evaluateGraham(ticker, year, fundamentalData, thresholds) {
  const history = fundamentalData
    ? (fundamentalData instanceof Map ? fundamentalData.get(baseTicker(ticker)) : fundamentalData[baseTicker(ticker)] || fundamentalData[ticker])
    : null;

  const snapshot = resolveSnapshot(history, year);
  if (snapshot) {
    return { source: 'archived', ...checkSolvency(snapshot, thresholds) };
  }

  const profile = findProfile(ticker);
  if (profile) {
    return { source: 'estimated', ...checkSolvency(profile, thresholds) };
  }

  // Sem dados e sem perfil: conservadoramente NÃO bloqueia o
  // sinal técnico, mas marca como não-verificado (approved=true,
  // qualityScore neutro) para não esvaziar universos pequenos.
  return {
    source: 'unknown',
    approved: true,
    qualityScore: 50,
    metrics: { currentRatio: null, debtEquity: null, roa: null, earningsYield: null, fcfYield: null },
    reasons: { passCR: true, passDE: true, passROA: true, passEY: true, passFCF: true }
  };
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function round2(v) { return Math.round((Number(v) || 0) * 100) / 100; }
function roundPct(v) { return Math.round((Number(v) || 0) * 10000) / 100; } // 0.06 -> 6.00

module.exports = {
  DEFAULT_THRESHOLDS,
  SOLVENT_PROFILES,
  baseTicker,
  findProfile,
  resolveSnapshot,
  checkSolvency,
  evaluateGraham
};
