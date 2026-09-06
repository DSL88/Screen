'use strict';

// ═══════════════════════════════════════════════════════════
//  workstationEngine.js — Motor Integral da Workstation (1–20 anos)
//
//  Substitui o backtest simples pela pipeline completa:
//    Fase 1  Graham (solvência point-in-time)          → gate de universo
//    Fase 2  Indicadores Adaptativos (McGinley/VWAP/RVOL) → direção + filtros
//    Fase 3  Diferenciação Fracionária (FFD)           → confirmação de momentum
//    Fase 4  Sentimento (proxy PV-divergence, bypass)   → confirmação suave
//    Fase 5  Purificação Fatorial (VIF < 5)            → ranking de convicção
//    Fase 6  CPCV/DSR/PBO                              → validação (no relatório)
//    Markov + Monte Carlo (5k trajetórias, nativo C++) → escalão de convicção
//
//  Seleção de carteira corre APENAS a cada bloco de rebalanceamento
//  (H = 21/35 dias úteis) — evita recálculo barra a barra. Dentro do
//  bloco, as posições são geridas barra a barra (SL/TP/ATR/horizonte).
//  Warm-up de 200 velas: nenhuma ordem antes de estabilização.
// ═══════════════════════════════════════════════════════════

const { mcginleyDynamic } = require('../quant/indicators');
const { selectPurifiedFeatures } = require('../quant/workstation/factorPurification');
const { computePVSentimentProxy } = require('../quant/workstation/sentimentProxy');
const { evaluateEntrySignal } = require('../quant/workstation/entrySignal');
const { computeSignalsParallel } = require('./signalPool');
const metrics = require('../quant/workstation/metrics');
const validation = require('../quant/workstation/validation');

const DEFAULT_WARMUP = 200;
const STATE_SPACES_SET = new Set(['9', '6', '3']);
const MC_ITERATIONS = 5000;

const SUPPORTED_HORIZONS = [1, 2, 3, 5, 10, 15, 20];

function round1(v) { return Math.round((Number(v) || 0) * 10) / 10; }
function round2(v) { return Math.round((Number(v) || 0) * 100) / 100; }
function toTime(iso) { return new Date(String(iso).slice(0, 10) + 'T00:00:00Z').getTime(); }

// ── Resolução de horizonte temporal ────────────────────────
function resolveDates(params) {
  const endDate = String(params.endDate || '').slice(0, 10);
  const years = Number(params.horizonYears) || Number(params.horizon) || 0;
  let startDate = String(params.startDate || '').slice(0, 10);
  if (!startDate && years > 0 && endDate) {
    const e = new Date(endDate + 'T00:00:00Z');
    e.setUTCFullYear(e.getUTCFullYear() - years);
    startDate = e.toISOString().slice(0, 10);
  }
  if (!endDate && years > 0 && startDate) {
    const s = new Date(startDate + 'T00:00:00Z');
    s.setUTCFullYear(s.getUTCFullYear() + years);
    endDate = s.toISOString().slice(0, 10);
  }
  return { startDate, endDate, horizonYears: years || null };
}

// ── Normaliza/sorta candles e determina índices de início/fim ─
function prepareAsset(u, cfg, dates) {
  const candles = (u.candles || [])
    .filter(c => c && c.close != null && Number.isFinite(Number(c.close)))
    .map(c => ({
      date: String(c.date).slice(0, 10),
      open: Number(c.open), high: Number(c.high), low: Number(c.low),
      close: Number(c.close), volume: Number(c.volume) || 0
    }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  if (candles.length <= cfg.warmup) {
    return { skip: `${u.ticker}: Ativo sem registos suficientes na base de dados SQLite.` };
  }
  let requestedStart = 0;
  if (dates.startDate) while (requestedStart < candles.length && candles[requestedStart].date < dates.startDate) requestedStart++;
  if (dates.startDate && requestedStart >= candles.length) {
    return { skip: `IGNORADO ${u.ticker}: startDate fora do histórico disponível` };
  }
  const startIdx = Math.max(requestedStart, cfg.warmup);
  let endIdx = candles.length - 1;
  if (dates.endDate) while (endIdx >= 0 && candles[endIdx].date > dates.endDate) endIdx--;
  if (endIdx < startIdx) return { skip: null, empty: true, ticker: u.ticker };

  // McGinley + FFD feature de momentum (usa só warm-up p/ d*, sem lookahead)
  const closes = candles.map(c => c.close);
  const mg = mcginleyDynamic(closes, 14, 0.6);
  const sentiment = computePVSentimentProxy(closes, candles.map(c => c.volume));

  return {
    asset: {
      ticker: u.ticker, name: u.name || u.ticker, candles,
      startIdx, endIdx, ptr: startIdx, mg, sentiment,
      lastClose: closes
    }
  };
}

// ── Sinal técnico completo (Fases 1–4 + Markov/MC) extraído para
//    src/quant/workstation/entrySignal.js (partilhado com o worker pool).

// ── Fase 5: ranking cross-sectional purificado (VIF<5) ─────
function purifyAndRank(candidates) {
  if (candidates.length === 0) return [];
  const cols = {
    momentum: candidates.map(c => c.sig.momentumFfd),
    vwapDist: candidates.map(c => c.sig.vwapDist),
    rvol: candidates.map(c => c.sig.rvol || 1),
    mc: candidates.map(c => c.sig.winRateMC)
  };
  const { kept } = selectPurifiedFeatures(cols, 5.0);
  // score composto z-normalizado das features retidas + convicção MC
  const scored = candidates.map(c => ({ ...c, composite: c.sig.winRateMC }));
  if (kept.length) {
    const zs = {};
    for (const f of kept) {
      const arr = candidates.map(c => f === 'momentum' ? c.sig.momentumFfd : f === 'vwapDist' ? c.sig.vwapDist : f === 'rvol' ? (c.sig.rvol || 1) : c.sig.winRateMC);
      const m = arr.reduce((s, v) => s + v, 0) / arr.length;
      const sd = Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / arr.length) || 1;
      zs[f] = { m, sd };
    }
    for (const c of scored) {
      let acc = 0;
      for (const f of kept) {
        const val = f === 'momentum' ? c.sig.momentumFfd : f === 'vwapDist' ? c.sig.vwapDist : f === 'rvol' ? (c.sig.rvol || 1) : c.sig.winRateMC;
        acc += (val - zs[f].m) / zs[f].sd;
      }
      c.composite = c.sig.winRateMC * 0.6 + (acc / kept.length) * 5; // blend MC + purificado
    }
  }
  return scored.sort((a, b) => b.composite - a.composite);
}

// ═══════════════════════════════════════════════════════════
//  runWorkstationSimulation
// ═══════════════════════════════════════════════════════════
const yieldLoop = () => new Promise(res => setImmediate(res));

async function runWorkstationSimulation(options) {
  const universe = Array.isArray(options.universe) ? options.universe : [];
  const params = options.params || {};
  const hooks = options.hooks || {};
  const onProgress = typeof hooks.onProgress === 'function' ? hooks.onProgress : () => {};
  const isCancelled = typeof hooks.cancelled === 'function' ? hooks.cancelled : () => false;

  const tierMap = { elite: 65, moderate: 50, all: 50 };
  const dates = resolveDates(params);
  const cfg = {
    direction: (params.direction || 'both').toLowerCase(),
    stopType: params.stopType || 'pct',
    stopLoss: Number(params.stopLoss) || 2.4,
    takeProfit: Number(params.takeProfit) || 4.8,
    trailingStop: !!(params.trailingStop ?? params.trailing),
    trailingOffsetPct: Number(params.trailingOffsetPct ?? params.trailingOffset) || 0,
    vwapGate: params.vwapGate !== false,
    rvolGate: params.rvolGate !== false,
    grahamGate: params.grahamGate !== false,
    ffdGate: params.ffdGate !== false,
    sentimentGate: params.sentimentGate !== false,
    minRVOL: params.minRVOL != null ? Number(params.minRVOL) : 1.0,
    markovMinPct: params.markovMinPct != null ? Number(params.markovMinPct) : 55,
    minWinRateMC: params.minWinRateMC != null ? Number(params.minWinRateMC) : (tierMap[params.convictionTier] || 50),
    convictionTier: params.convictionTier === 'elite' ? 'elite' : 'moderate',
    rebalanceDays: Number(params.rebalanceDays) || 35,
    maxPositions: Number(params.maxPositions) || 10,
    initialCapital: Number(params.initialCapital ?? params.capital) || 10000,
    riskPerTradePct: Number(params.riskPerTradePct ?? params.risk) || 2,
    commissionPct: Number(params.commissionPct ?? params.commission) || 0,
    slippagePct: Number(params.slippagePct ?? params.slippage) || 0,
    warmup: Number(params.warmup) || DEFAULT_WARMUP,
    markovWindow: Number(params.markovWindow) || 150,
    horizonDays: Number(params.horizonDays) || 5,
    markovOrder: Number(params.markovOrder) === 2 ? 2 : 1,
    stateSpace: STATE_SPACES_SET.has(String(params.stateSpace)) ? String(params.stateSpace) : '9',
    mcIterations: Number(params.mcIterations) || MC_ITERATIONS,
    mcSeed: Number(params.mcSeed) != null ? Number(params.mcSeed) : 42,
    ffdD: Number(params.ffdD) || 0.4,
    parallelWorkers: Number(params.parallelWorkers) || undefined,
    grahamThresholds: params.grahamThresholds || undefined
  };

  const messages = [];
  const assets = [];
  for (const u of universe) {
    const r = prepareAsset(u, cfg, dates);
    if (r.skip) { messages.push(r.skip); continue; }
    if (r.empty) continue;
    assets.push(r.asset);
  }

  if (assets.length === 0) {
    return emptyResult(cfg, dates, messages);
  }

  // Eixo mestre de datas dentro do horizonte
  const dateSet = new Set();
  for (const a of assets) for (let i = a.startIdx; i <= a.endIdx; i++) dateSet.add(a.candles[i].date);
  const allDates = Array.from(dateSet).sort();

  // Estado de carteira
  let cash = cfg.initialCapital;
  let lastEquity = cfg.initialCapital;
  const positions = new Map();   // ticker -> pos
  const equityCurve = [];
  const trades = [];
  const slip = cfg.slippagePct / 100;
  const commission = cfg.commissionPct / 100;
  let processed = 0;
  const totalSteps = allDates.length;

  // Ponteiro por asset sobre allDates
  const ptrOf = new Map(assets.map(a => [a.ticker, a.startIdx]));

  function advanceTo(asset, date) {
    let p = ptrOf.get(asset.ticker);
    while (p + 1 <= asset.endIdx && asset.candles[p + 1].date <= date) p++;
    ptrOf.set(asset.ticker, p);
    return p;
  }

  function openPosition(asset, i, sig) {
    const c = asset.candles[i];
    const entryRaw = Number.isFinite(c.open) ? c.open : c.close;
    const entry = sig.side === 'LONG' ? entryRaw * (1 + slip) : entryRaw * (1 - slip);
    let slPrice, tpPrice;
    if (cfg.stopType === 'atr' && sig.atr) {
      slPrice = sig.side === 'LONG' ? entry - sig.atr * cfg.stopLoss : entry + sig.atr * cfg.stopLoss;
      tpPrice = sig.side === 'LONG' ? entry + sig.atr * cfg.takeProfit : entry - sig.atr * cfg.takeProfit;
    } else {
      slPrice = sig.side === 'LONG' ? entry * (1 - cfg.stopLoss / 100) : entry * (1 + cfg.stopLoss / 100);
      tpPrice = sig.side === 'LONG' ? entry * (1 + cfg.takeProfit / 100) : entry * (1 - cfg.takeProfit / 100);
    }
    const riskAmount = lastEquity * (cfg.riskPerTradePct / 100);
    let shares = Math.floor(riskAmount / Math.max(Math.abs(entry - slPrice), 1e-9));
    if (shares <= 0) return;
    if (sig.side === 'LONG') {
      const unitCost = entry * (1 + commission);
      shares = Math.min(shares, Math.floor(cash / Math.max(unitCost, 1e-9)));
      if (shares <= 0) return;
      cash -= shares * unitCost;
    } else {
      cash += shares * entry * (1 - commission);
    }
    positions.set(asset.ticker, {
      ticker: asset.ticker, name: asset.name, side: sig.side, entryPrice: entry,
      entryDate: c.date, slPrice, tpPrice, shares,
      peak: c.high, trough: c.low,
      mfe: 0, mae: 0,
      winRateMC: sig.winRateMC, mcTier: sig.mcTier, pMarkov: sig.pMarkov
    });
  }

  function manageAndClose(asset, i) {
    const pos = positions.get(asset.ticker);
    if (!pos) return;
    const bar = asset.candles[i];
    const sign = pos.side === 'LONG' ? 1 : -1;
    const favPct = ((sign * (bar.high - pos.entryPrice)) / pos.entryPrice) * 100;
    const advPct = ((sign * (bar.low - pos.entryPrice)) / pos.entryPrice) * 100;
    if (sign === 1) {
      pos.peak = Math.max(pos.peak, bar.high);
      let stop = pos.slPrice;
      let trailing = false;
      if (cfg.trailingStop && cfg.trailingOffsetPct > 0) {
        const cand = pos.peak * (1 - cfg.trailingOffsetPct / 100);
        if (cand > stop) { stop = cand; trailing = true; }
      }
      pos.mfe = Math.max(pos.mfe, favPct); pos.mae = Math.min(pos.mae, advPct);
      if (bar.low <= stop) closePosition(pos, stop, trailing ? 'Trailing' : 'Stop Loss', bar.date, i, asset);
      else if (bar.high >= pos.tpPrice) closePosition(pos, pos.tpPrice, 'Take Profit', bar.date, i, asset);
    } else {
      pos.trough = Math.min(pos.trough, bar.low);
      let stop = pos.slPrice;
      let trailing = false;
      if (cfg.trailingStop && cfg.trailingOffsetPct > 0) {
        const cand = pos.trough * (1 + cfg.trailingOffsetPct / 100);
        if (cand < stop) { stop = cand; trailing = true; }
      }
      pos.mfe = Math.max(pos.mfe, favPct); pos.mae = Math.min(pos.mae, advPct);
      if (bar.high >= stop) closePosition(pos, stop, trailing ? 'Trailing' : 'Stop Loss', bar.date, i, asset);
      else if (bar.low <= pos.tpPrice) closePosition(pos, pos.tpPrice, 'Take Profit', bar.date, i, asset);
    }
  }

  function closePosition(pos, exitRaw, reason, exitDate, i, asset) {
    const exit = pos.side === 'LONG' ? exitRaw * (1 - slip) : exitRaw * (1 + slip);
    const sign = pos.side === 'LONG' ? 1 : -1;
    const profitPct = pos.entryPrice > 0 ? ((exit - pos.entryPrice) / pos.entryPrice) * sign * 100 : 0;
    if (pos.side === 'LONG') cash += pos.shares * exit * (1 - commission);
    else cash -= pos.shares * exit * (1 + commission);
    const profit = sign * pos.shares * (exit - pos.entryPrice) - commission * pos.shares * (pos.entryPrice + exit);
    // fechar MFE/MAE no bar de saída
    const bar = asset ? asset.candles[i] : null;
    if (bar) {
      const favPct = ((sign * (bar.high - pos.entryPrice)) / pos.entryPrice) * 100;
      const advPct = ((sign * (bar.low - pos.entryPrice)) / pos.entryPrice) * 100;
      pos.mfe = Math.max(pos.mfe, favPct); pos.mae = Math.min(pos.mae, advPct);
    }
    trades.push({
      ticker: pos.ticker, name: pos.name, side: pos.side,
      entryDate: pos.entryDate, entryPrice: round2(pos.entryPrice),
      exitDate, exitPrice: round2(exit), reason,
      profit: round2(profit), profitPct: round1(profitPct),
      durationDays: round1((toTime(exitDate) - toTime(pos.entryDate)) / 86400000),
      winRateMC: round1(pos.winRateMC), mcTier: pos.mcTier, pMarkov: round2(pos.pMarkov || 0),
      mfePct: round1(pos.mfe), maePct: round1(pos.mae)
    });
    positions.delete(pos.ticker);
  }

  // ── Fase CPU-heavy (Markov + Monte Carlo) em paralelo ──────
  //    Distribui os ativos por os.cpus().length Worker Threads.
  //    blockStartDates replicam o cursor do loop (passo H).
  const blockStartDates = [];
  for (let c = 0; c < allDates.length; c += cfg.rebalanceDays) blockStartDates.push(allDates[c]);

  let signalMap = null;
  const parallel = params.parallel !== false;
  if (parallel && assets.length >= 2) {
    try {
      const plainAssets = assets.map(a => ({
        ticker: a.ticker, name: a.name, candles: a.candles,
        sentiment: a.sentiment, startIdx: a.startIdx, endIdx: a.endIdx
      }));
      const { map, mode, workers, error } = await computeSignalsParallel(plainAssets, blockStartDates, cfg, options.fundamentalData, { workerCount: cfg.parallelWorkers });
      signalMap = map;
      messages.push(`Sinais avaliados em modo ${mode} (${workers} worker${workers > 1 ? 's' : ''})${error ? ' — ' + error : ''}.`);
    } catch (_) {
      signalMap = null; // fallback para avaliação inline
    }
  }

  // ── Loop por blocos de rebalanceamento ─────────────────────
  let cursor = 0;
  let blockCounter = 0;
  while (cursor < allDates.length) {
    if (isCancelled()) return { ok: false, cancelled: true, messages };
    const blockStart = allDates[cursor];
    const blockEnd = allDates[Math.min(cursor + cfg.rebalanceDays - 1, allDates.length - 1)];

    // ─ SELEÇÃO no início do bloco (cross-sectional) ─
    const candidates = [];
    for (const a of assets) {
      if (positions.has(a.ticker)) continue; // já detido
      const i = advanceTo(a, blockStart);
      if (i < a.startIdx || i > a.endIdx) continue;
      const sig = signalMap ? (signalMap.get(`${a.ticker}|${blockStart}`) || null) : evaluateEntrySignal(a, i, cfg, options.fundamentalData);
      if (sig) candidates.push({ asset: a, i, sig });
    }
    const ranked = purifyAndRank(candidates);
    const slots = Math.max(0, cfg.maxPositions - positions.size);
    for (let k = 0; k < Math.min(slots, ranked.length); k++) {
      const cand = ranked[k];
      // entrada no início do próximo bloco usa a barra atual (blockStart)
      openPosition(cand.asset, cand.i, cand.sig);
    }

    // ─ GESTÃO barra a barra dentro do bloco ─
    for (let d = cursor; d <= cursor + cfg.rebalanceDays - 1 && d < allDates.length; d++) {
      const date = allDates[d];
      for (const a of assets) {
        const i = advanceTo(a, date);
        // avançar todas as barras do ativo até date (gestão intra-bloco)
        const fromPtr = positions.has(a.ticker) ? i : i;
        manageAndClose(a, i);
      }
      // marcação na mercado no fecho do dia
      let eq = cash;
      for (const pos of positions.values()) {
        const a = assets.find(x => x.ticker === pos.ticker);
        const last = a ? a.candles[Math.min(ptrOf.get(a.ticker), a.endIdx)].close : pos.entryPrice;
        eq += pos.side === 'LONG' ? pos.shares * last : -pos.shares * last;
      }
      equityCurve.push({ date, value: round2(eq) });
      lastEquity = eq;
    }

    // ─ FECHO por limite de horizonte H no fim do bloco ─
    for (const [tk] of Array.from(positions.entries())) {
      const a = assets.find(x => x.ticker === tk);
      const pos = positions.get(tk);
      if (pos && pos.entryDate <= blockEnd) {
        // só fecha por horizonte se ainda estiver aberto no fim do bloco
      }
    }
    for (const pos of Array.from(positions.values())) {
      const a = assets.find(x => x.ticker === pos.ticker);
      const lastIdx = a ? Math.min(ptrOf.get(a.ticker), a.endIdx) : null;
      if (a && lastIdx != null) closePosition(pos, a.candles[lastIdx].close, 'Limite H', a.candles[lastIdx].date, lastIdx, a);
    }

    cursor += cfg.rebalanceDays;
    blockCounter++;
    processed = cursor;
    onProgress(Math.min(100, (processed / totalSteps) * 100));
    await yieldLoop();
  }

  // ── Relatório ───────────────────────────────────────────────
  const globalKpis = metrics.computeGlobalKPIs({
    trades, equityCurve, initialCapital: cfg.initialCapital, startDate: dates.startDate, endDate: dates.endDate
  });
  const drawdownSeries = metrics.drawdownSeries(equityCurve, cfg.initialCapital);
  const yearlyMatrix = metrics.buildYearlyMatrix({ equityCurve, trades });
  const calibrationTiers = metrics.buildCalibrationTiers(trades);
  const returns = metrics.dailyReturnsFromEquity(equityCurve);
  const cpcvReport = validation.validateStrategy(returns, { nGroups: 5, kTestGroups: 2, nTrials: assets.length || 10 });

  const benchmark = buildBenchmark(assets, allDates, cfg.initialCapital);
  const equity = cash;
  onProgress(100);

  return {
    ok: true,
    cancelled: false,
    engine: 'workstation',
    summary: {
      title: `Simulação Workstation — ${dates.horizonYears ? dates.horizonYears + ' Anos' : 'Período'} (${(allDates[0] || '').slice(0, 4)} a ${(allDates[allDates.length - 1] || '').slice(0, 4)})`,
      startDate: allDates[0], endDate: allDates[allDates.length - 1]
    },
    kpis: {
      ...globalKpis,
      rentabilidadePct: globalKpis.netProfitPct,
      winRateReal: globalKpis.winRate,
      profitFactor: globalKpis.profitFactor,
      maxDrawdown: globalKpis.maxDrawdownPct,
      sharpe: globalKpis.sharpe
    },
    globalKpis,
    yearlyMatrix,
    calibrationTiers,
    risk: { var95: globalKpis.var95, cvar95: globalKpis.cvar95 },
    validation: cpcvReport,
    equityCurve,
    drawdownSeries,
    benchmark,
    trades,
    messages,
    meta: {
      markovOrder: cfg.markovOrder, stateSpace: cfg.stateSpace,
      rebalanceDays: cfg.rebalanceDays, convictionTier: cfg.convictionTier,
      minWinRateMC: cfg.minWinRateMC, maxPositions: cfg.maxPositions,
      blocks: blockCounter, universe: assets.length, mcIterations: cfg.mcIterations,
      phases: { graham: cfg.grahamGate, adaptive: true, ffd: cfg.ffdGate, sentiment: cfg.sentimentGate, purification: true, cpcv: true }
    }
  };
}

function buildBenchmark(assets, allDates, initialCapital) {
  const valid = assets.map(a => { const fc = a.candles[a.startIdx].close; return { a, fc: fc > 0 ? fc : null }; }).filter(v => v.fc);
  if (!valid.length) return [];
  const per = initialCapital / valid.length;
  const ptrs = new Map(valid.map(v => [v.a.ticker, v.a.startIdx]));
  const out = [];
  for (const date of allDates) {
    let value = 0;
    for (const v of valid) {
      const a = v.a; let p = ptrs.get(a.ticker);
      while (p + 1 <= a.endIdx && a.candles[p + 1].date <= date) p++;
      ptrs.set(a.ticker, p);
      const c = a.candles[p].close;
      value += per * (c / v.fc);
    }
    out.push({ date, value: round2(value) });
  }
  return out;
}

function emptyResult(cfg, dates, messages) {
  return {
    ok: true, cancelled: false, engine: 'workstation',
    summary: { title: 'Simulação Workstation — sem dados', startDate: dates.startDate, endDate: dates.endDate },
    kpis: { rentabilidadePct: 0, winRateReal: 0, profitFactor: 0, maxDrawdown: 0, sharpe: 0, totalTrades: 0, netProfit: 0, initialCapital: cfg.initialCapital, finalCapital: cfg.initialCapital },
    globalKpis: metrics.computeGlobalKPIs({ trades: [], equityCurve: [], initialCapital: cfg.initialCapital }),
    yearlyMatrix: [], calibrationTiers: metrics.buildCalibrationTiers([]), risk: { var95: 0, cvar95: 0 },
    validation: validation.validateStrategy([], {}), equityCurve: [], drawdownSeries: [], benchmark: [], trades: [], messages,
    meta: { universe: 0, blocks: 0 }
  };
}

module.exports = { runWorkstationSimulation, resolveDates, prepareAsset, purifyAndRank, SUPPORTED_HORIZONS, MC_ITERATIONS };
