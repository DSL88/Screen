'use strict';

// ═══════════════════════════════════════════════════════════
//  metrics.js — Métricas institucionais puras (sem DB/UI)
//
//  Operam sobre:
//    • dailyReturns: number[] retornos simples diários (r_t = P_t/P_{t-1} - 1)
//    • equityCurve:  { date, value }[]
//    • trades:       { profit, profitPct, side, entryDate, exitDate, ... }[]
//
//  Convenções:
//    • Annualização: 252 dias úteis
//    • Drawdowns/retornos em fração quando não indicado (%)
// ═══════════════════════════════════════════════════════════

const TRADING_DAYS = 252;

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function mean(arr) {
  const n = arr.length;
  if (n === 0) return 0;
  let s = 0;
  for (let i = 0; i < n; i++) s += arr[i];
  return s / n;
}

function stdev(arr) {
  const n = arr.length;
  if (n < 2) return 0;
  const m = mean(arr);
  let ss = 0;
  for (let i = 0; i < n; i++) {
    const d = arr[i] - m;
    ss += d * d;
  }
  return Math.sqrt(ss / (n - 1));
}

// Assimetria amostral (skew) — usada pelo DSR
function skewness(arr) {
  const n = arr.length;
  if (n < 3) return 0;
  const m = mean(arr);
  const s = stdev(arr);
  if (s === 0) return 0;
  let acc = 0;
  for (let i = 0; i < n; i++) acc += Math.pow((arr[i] - m) / s, 3);
  return (n / ((n - 1) * (n - 2))) * acc;
}

// Curtose EXCEDENTE (Fisher); aqui devolvemos curtose total (Pearson) = excess + 3
function kurtosis(arr) {
  const n = arr.length;
  if (n < 4) return 3;
  const m = mean(arr);
  const s = stdev(arr);
  if (s === 0) return 3;
  let acc = 0;
  for (let i = 0; i < n; i++) acc += Math.pow((arr[i] - m) / s, 4);
  const excess = ((n * (n + 1)) / ((n - 1) * (n - 2) * (n - 3))) * acc
    - (3 * (n - 1) * (n - 1)) / ((n - 2) * (n - 3));
  return excess + 3;
}

function dailyReturnsFromEquity(equityCurve) {
  const out = [];
  const eq = Array.isArray(equityCurve) ? equityCurve : [];
  for (let i = 1; i < eq.length; i++) {
    const prev = toNum(eq[i - 1].value);
    const cur = toNum(eq[i].value);
    if (prev > 0) out.push(cur / prev - 1);
  }
  return out;
}

// ── Sharpe anualizado (rf=0) ──────────────────────────────
function sharpeRatio(returns) {
  const r = Array.isArray(returns) ? returns : [];
  const s = stdev(r);
  if (r.length < 2 || s === 0) return 0;
  return (mean(r) / s) * Math.sqrt(TRADING_DAYS);
}

// ── Sortino anualizado (downside dev. sobre alvo 0) ───────
function sortinoRatio(returns) {
  const r = Array.isArray(returns) ? returns : [];
  if (r.length < 2) return 0;
  const downside = r.filter(x => x < 0);
  if (downside.length === 0) return mean(r) > 0 ? 99.9 : 0;
  const ds = Math.sqrt(mean(downside.map(x => x * x)));
  if (ds === 0) return 0;
  return (mean(r) / ds) * Math.sqrt(TRADING_DAYS);
}

// ── Drawdown a partir da equity curve ─────────────────────
function drawdownSeries(equityCurve, initialCapital) {
  const eq = Array.isArray(equityCurve) ? equityCurve : [];
  let peak = toNum(initialCapital) || (eq.length ? toNum(eq[0].value) : 0);
  const out = [];
  for (const p of eq) {
    const v = toNum(p.value);
    if (v > peak) peak = v;
    const ddPct = peak > 0 ? ((peak - v) / peak) * 100 : 0;
    out.push({ date: p.date, value: ddPct });
  }
  return out;
}

function maxDrawdownPct(ddSeries) {
  let max = 0;
  for (const p of ddSeries || []) max = Math.max(max, toNum(p.value));
  return max;
}

// ── Calmar: retorno anualizado / |Max DD| ──────────────────
function calmarRatio(returns, maxDDPct) {
  const r = Array.isArray(returns) ? returns : [];
  const ann = mean(r) * TRADING_DAYS * 100; // retorno anualizado %
  const dd = Math.abs(toNum(maxDDPct));
  if (dd === 0) return ann > 0 ? 99.9 : 0;
  return ann / dd;
}

// ── CAGR: usa capitais inicial/final e nº de dias de calendário ─
function cagr(initialCapital, finalCapital, days) {
  const c0 = toNum(initialCapital);
  const c1 = toNum(finalCapital);
  const yrs = toNum(days) / 365.25;
  if (c0 <= 0 || yrs <= 0 || c1 <= 0) return 0;
  return (Math.pow(c1 / c0, 1 / yrs) - 1) * 100;
}

// ── Value at Risk / Expected Shortfall históricos (retornos) ─
function quantile(sortedAsc, q) {
  const arr = sortedAsc;
  if (!arr.length) return 0;
  const pos = (arr.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  if (arr[base + 1] != null) return arr[base] + rest * (arr[base + 1] - arr[base]);
  return arr[base];
}

function valueAtRisk(returns, confidence = 0.95) {
  const r = (Array.isArray(returns) ? returns : []).filter(x => Number.isFinite(x)).slice().sort((a, b) => a - b);
  if (r.length < 2) return 0;
  // retorno no percentil (1-confidence) → negativo; VaR reportado como % de perda
  return -quantile(r, 1 - confidence) * 100;
}

function conditionalVaR(returns, confidence = 0.95) {
  const r = (Array.isArray(returns) ? returns : []).filter(x => Number.isFinite(x)).slice().sort((a, b) => a - b);
  if (r.length < 2) return 0;
  const cutoff = quantile(r, 1 - confidence);
  const tail = r.filter(x => x <= cutoff);
  if (tail.length === 0) return -cutoff * 100;
  return -mean(tail) * 100;
}

// ── Expectativa matemática (€ / trade) ─────────────────────
function expectancy(trades) {
  const list = Array.isArray(trades) ? trades : [];
  if (list.length === 0) return 0;
  const wins = list.filter(t => toNum(t.profit) > 0);
  const losses = list.filter(t => toNum(t.profit) < 0);
  const pW = wins.length / list.length;
  const pL = losses.length / list.length;
  const avgW = wins.length ? mean(wins.map(t => toNum(t.profit))) : 0;
  const avgL = losses.length ? Math.abs(mean(losses.map(t => toNum(t.profit)))) : 0;
  return pW * avgW - pL * avgL;
}

// ═══════════════════════════════════════════════════════════
//  KPIs agregados do relatório (Bloco A)
// ═══════════════════════════════════════════════════════════
function computeGlobalKPIs({ trades, equityCurve, initialCapital, startDate, endDate }) {
  const list = Array.isArray(trades) ? trades : [];
  const eq = Array.isArray(equityCurve) ? equityCurve : [];
  const c0 = toNum(initialCapital) || (eq.length ? toNum(eq[0].value) : 0);
  const c1 = eq.length ? toNum(eq[eq.length - 1].value) : c0;

  const returns = dailyReturnsFromEquity(eq);
  const dd = drawdownSeries(eq, c0);
  const maxDD = maxDrawdownPct(dd);

  const wins = list.filter(t => toNum(t.profit) > 0);
  const losses = list.filter(t => toNum(t.profit) < 0);
  const grossProfit = wins.reduce((s, t) => s + toNum(t.profit), 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + toNum(t.profit), 0));

  const netProfit = grossProfit - grossLoss;
  const winRate = list.length ? (wins.length / list.length) * 100 : 0;
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? 99.9 : 0);
  const avgWin = wins.length ? grossProfit / wins.length : 0;
  const avgLoss = losses.length ? grossLoss / losses.length : 0;
  const payoffRatio = avgLoss > 0 ? avgWin / avgLoss : (avgWin > 0 ? 99.9 : 0);

  const days = (startDate && endDate)
    ? (new Date(String(endDate).slice(0, 10) + 'T00:00:00Z') - new Date(String(startDate).slice(0, 10) + 'T00:00:00Z')) / 86400000
    : (eq.length > 1
        ? (new Date(String(eq[eq.length - 1].date).slice(0, 10) + 'T00:00:00Z') - new Date(String(eq[0].date).slice(0, 10) + 'T00:00:00Z')) / 86400000
        : 0);

  const durations = list.map(t => toNum(t.durationDays)).filter(d => Number.isFinite(d) && d > 0);
  const avgDuration = durations.length ? mean(durations) : null;

  // Exposição média de capital (%): fração das barras com posição aberta
  let exposurePct = 0;
  if (list.length && eq.length > 1) {
    const barsWithTrades = list.reduce((s, t) => s + Math.max(1, Math.round(toNum(t.durationDays) / 365.25 * TRADING_DAYS) || 1), 0);
    exposurePct = Math.min(100, (barsWithTrades / eq.length) * 100);
  }

  return {
    initialCapital: round2(c0),
    finalCapital: round2(c1),
    netProfit: round2(netProfit),
    netProfitPct: c0 > 0 ? round1((netProfit / c0) * 100) : 0,
    cagr: round2(cagr(c0, c1, days)),
    sharpe: round2(sharpeRatio(returns)),
    sortino: round2(sortinoRatio(returns)),
    calmar: round2(calmarRatio(returns, maxDD)),
    maxDrawdownPct: round1(maxDD),
    totalTrades: list.length,
    winRate: round1(winRate),
    profitFactor: round2(profitFactor),
    payoffRatio: round2(payoffRatio),
    expectancy: round2(expectancy(list)),
    avgDurationDays: avgDuration != null ? round1(avgDuration) : null,
    exposurePct: round1(exposurePct),
    var95: round2(valueAtRisk(returns, 0.95)),
    cvar95: round2(conditionalVaR(returns, 0.95)),
    grossProfit: round2(grossProfit),
    grossLoss: round2(grossLoss),
    periodDays: Math.round(days)
  };
}

// ═══════════════════════════════════════════════════════════
//  Matriz de retornos ano a ano (Bloco B)
// ═══════════════════════════════════════════════════════════
function buildYearlyMatrix({ equityCurve, trades }) {
  const eq = Array.isArray(equityCurve) ? equityCurve : [];
  const list = Array.isArray(trades) ? trades : [];
  const byYear = new Map();

  const yearOf = (d) => String(d || '').slice(0, 4);
  const ensure = (y) => {
    if (!byYear.has(y)) byYear.set(y, { year: y, equity: [], trades: [] });
    return byYear.get(y);
  };

  for (const p of eq) {
    const y = yearOf(p.date);
    if (/^\d{4}$/.test(y)) ensure(y).equity.push(p);
  }
  for (const t of list) {
    const y = yearOf(t.exitDate || t.entryDate);
    if (/^\d{4}$/.test(y)) ensure(y).trades.push(t);
  }

  const rows = [];
  for (const y of Array.from(byYear.keys()).sort()) {
    const { equity, trades: yrTrades } = byYear.get(y);
    let retPct = 0;
    let maxDD = 0;
    let sharpe = 0;
    if (equity.length >= 2) {
      const first = toNum(equity[0].value);
      const last = toNum(equity[equity.length - 1].value);
      retPct = first > 0 ? ((last - first) / first) * 100 : 0;
      const dd = drawdownSeries(equity, first);
      maxDD = maxDrawdownPct(dd);
      sharpe = sharpeRatio(dailyReturnsFromEquity(equity));
    }
    const wins = yrTrades.filter(t => toNum(t.profit) > 0).length;
    const wr = yrTrades.length ? (wins / yrTrades.length) * 100 : 0;
    rows.push({
      year: y,
      returnPct: round1(retPct),
      trades: yrTrades.length,
      winRate: round1(wr),
      maxDrawdownPct: round1(maxDD),
      sharpe: round2(sharpe)
    });
  }
  return rows;
}

// ═══════════════════════════════════════════════════════════
//  Auditoria por escalão de convicção (Bloco C)
//  Cruza mcTier (win rate teórico MC) com execução real.
// ═══════════════════════════════════════════════════════════
function buildCalibrationTiers(trades) {
  const list = Array.isArray(trades) ? trades : [];
  const tiers = { ELITE: [], MODERATE: [], REJECTED: [] };
  for (const t of list) {
    const k = String(t.mcTier || 'REJECTED').toUpperCase();
    (tiers[k] || tiers.REJECTED).push(t);
  }
  const summarize = (name, min, max, group) => {
    const wins = group.filter(t => toNum(t.profit) > 0).length;
    const pnl = group.reduce((s, t) => s + toNum(t.profit), 0);
    const theoWr = group.length ? mean(group.map(t => toNum(t.winRateMC))) : 0;
    return {
      tier: name,
      range: `${min}–${max}%`,
      trades: group.length,
      winRateReal: group.length ? round1((wins / group.length) * 100) : 0,
      winRateTheoretical: round1(theoWr),
      pnl: round2(pnl),
      alpha: round2(group.length ? (wins / group.length) * 100 - theoWr : 0)
    };
  };
  return {
    ELITE: summarize('Elite', 65, 100, tiers.ELITE),
    MODERATE: summarize('Moderado', 50, 64.9, tiers.MODERATE),
    REJECTED: summarize('Rejeitado', 0, 49.9, tiers.REJECTED)
  };
}

// ═══════════════════════════════════════════════════════════
//  MFE / MAE (por trade, calculados fora do engine)
// ═══════════════════════════════════════════════════════════

function round1(v) { return Math.round(toNum(v) * 10) / 10; }
function round2(v) { return Math.round(toNum(v) * 100) / 100; }

module.exports = {
  TRADING_DAYS,
  mean,
  stdev,
  skewness,
  kurtosis,
  dailyReturnsFromEquity,
  sharpeRatio,
  sortinoRatio,
  calmarRatio,
  drawdownSeries,
  maxDrawdownPct,
  cagr,
  valueAtRisk,
  conditionalVaR,
  expectancy,
  computeGlobalKPIs,
  buildYearlyMatrix,
  buildCalibrationTiers,
  round1,
  round2
};
