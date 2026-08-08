'use strict';

const { analyzeSeries } = require('../quant/markovEngine');
const { runMarkovMonteCarloSimulation } = require('../quant/monteCarloEngine');

const DEFAULT_WARMUP = 200;
const DEFAULT_MARKOV_WINDOW = 150;
const DEFAULT_HORIZON = 5;

function round1(v) {
  return Math.round(v * 10) / 10;
}

function round2(v) {
  return Math.round(v * 100) / 100;
}

function toTime(iso) {
  return new Date(String(iso).slice(0, 10) + 'T00:00:00Z').getTime();
}

// ═══════════════════════════════════════════════════════════
//  Avaliação de sinal numa barra t (apenas dados até t)
//
//  Gatekeepers: direção permitida, probabilidade mínima de
//  Markov, Monte Carlo e Rolling VWAP(20).  Reutiliza os motores
//  existentes (markovEngine / monteCarloEngine).
// ═══════════════════════════════════════════════════════════
function evaluateSignal(candles, i, cfg) {
  const slice = candles.slice(0, i + 1);

  const result = analyzeSeries(slice, {
    markovWindow: cfg.markovWindow,
    useVolFilter: false,
    horizonDays: cfg.horizonDays
  });

  if (!result || result.close == null) return null;
  if (result.direction !== 'COMPRA' && result.direction !== 'VENDA') return null;

  const dir = result.direction;
  if (dir === 'COMPRA' && cfg.direction === 'short') return null;
  if (dir === 'VENDA' && cfg.direction === 'long') return null;

  // Nível mínimo de transição de Markov (%)
  if (dir === 'COMPRA' && result.pBull * 100 < cfg.markovMinPct) return null;
  if (dir === 'VENDA' && result.pBear * 100 < cfg.markovMinPct) return null;

  // Gatekeeper Rolling VWAP(20)
  if (cfg.vwapGate && result.rollingVwap20 != null && result.close != null) {
    if (dir === 'COMPRA' && result.close <= result.rollingVwap20) return null;
    if (dir === 'VENDA' && result.close >= result.rollingVwap20) return null;
  }

  // Probabilidade mínima de Monte Carlo (%)
  if (!result.transitionMatrix || result.currentState < 0) return null;
  const slFrac = cfg.stopType === 'atr' && result.atr
    ? (result.atr * cfg.stopLoss) / result.close
    : cfg.stopLoss / 100;
  const tpFrac = cfg.stopType === 'atr' && result.atr
    ? (result.atr * cfg.takeProfit) / result.close
    : cfg.takeProfit / 100;
  const mc = runMarkovMonteCarloSimulation(
    result.transitionMatrix,
    result.currentState,
    slice,
    result.close,
    { slPct: slFrac, tpPct: tpFrac, side: dir === 'COMPRA' ? 'LONG' : 'SHORT' }
  );
  if (!mc || mc.winRate < cfg.mcMinPct) return null;

  return { side: dir === 'COMPRA' ? 'LONG' : 'SHORT', atr: result.atr };
}

// ═══════════════════════════════════════════════════════════
//  runSimulation — loop cronológico vela a vela sem lookahead
//
//  Assíncrono de propósito: cede o event loop (`setImmediate`)
//  periodicamente para que o processo consumidor (Worker Thread)
//  consiga processar mensagens de cancelamento durante o loop.
// ═══════════════════════════════════════════════════════════
const yieldToEventLoop = () => new Promise(resolve => setImmediate(resolve));

async function runSimulation(options) {
  const universe = Array.isArray(options && options.universe) ? options.universe : [];
  const params = (options && options.params) || {};
  const hooks = (options && options.hooks) || {};
  const onProgress = typeof hooks.onProgress === 'function' ? hooks.onProgress : () => {};
  const onStatus = typeof hooks.onStatus === 'function' ? hooks.onStatus : () => {};
  const isCancelled = typeof hooks.cancelled === 'function' ? hooks.cancelled : () => false;

  const cfg = {
    direction: params.direction || 'both',
    exitMode: params.exitMode || 'full',
    stopType: params.stopType || 'pct',
    stopLoss: Number(params.stopLoss) || 0,
    takeProfit: Number(params.takeProfit) || 0,
    trailingStop: !!(params.trailingStop ?? params.trailing),
    trailingOffsetPct: Number(params.trailingOffsetPct ?? params.trailingOffset) || 0,
    vwapGate: params.vwapGate !== undefined ? !!params.vwapGate : true,
    mcMinPct: (params.mcMinPct ?? params.mcMin) != null ? Number(params.mcMinPct ?? params.mcMin) : 50,
    markovMinPct: (params.markovMinPct ?? params.markovMin) != null ? Number(params.markovMinPct ?? params.markovMin) : 55,
    startDate: String(params.startDate || '').slice(0, 10),
    endDate: String(params.endDate || '').slice(0, 10),
    initialCapital: Number(params.initialCapital ?? params.capital) || 10000,
    riskPerTradePct: Number(params.riskPerTradePct ?? params.risk) || 2,
    commissionPct: Number(params.commissionPct ?? params.commission) || 0,
    slippagePct: Number(params.slippagePct ?? params.slippage) || 0,
    warmup: Number(params.warmup) || DEFAULT_WARMUP,
    markovWindow: Number(params.markovWindow) || DEFAULT_MARKOV_WINDOW,
    horizonDays: Number(params.horizonDays) || DEFAULT_HORIZON
  };

  const messages = [];
  const trades = [];
  const initialCapital = cfg.initialCapital;
  const riskNotional = initialCapital * (cfg.riskPerTradePct / 100);

  // ── Pré-processamento: warm-up por ativo ─────────────────
  const assets = [];
  for (const u of universe) {
    if (!u || !Array.isArray(u.candles) || u.candles.length === 0) continue;
    const candles = u.candles.filter(c => c && c.close != null && Number.isFinite(Number(c.close)));
    if (candles.length === 0) continue;

    let startIdx = 0;
    while (startIdx < candles.length && String(candles[startIdx].date) < cfg.startDate) startIdx++;

    if (startIdx < cfg.warmup) {
      messages.push(`IGNORADO ${u.ticker || '?'}: warm-up insuficiente (${startIdx} velas prévias, mínimo ${cfg.warmup})`);
      continue;
    }

    let endIdx = candles.length - 1;
    while (endIdx >= 0 && String(candles[endIdx].date) > cfg.endDate) endIdx--;
    if (endIdx < startIdx) continue;

    assets.push({ ticker: u.ticker, name: u.name || u.ticker, candles, startIdx, endIdx, ptr: startIdx });
  }

  // Datas únicas ordenadas (eixo da curva de capital)
  const dateSet = new Set();
  let totalBars = 0;
  for (const a of assets) {
    for (let i = a.startIdx; i <= a.endIdx; i++) dateSet.add(String(a.candles[i].date));
    totalBars += a.endIdx - a.startIdx + 1;
  }
  const allDates = Array.from(dateSet).sort();

  if (assets.length === 0) {
    const kpis = calculateKPIs([], [{ date: cfg.startDate, value: initialCapital }], initialCapital);
    return {
      ok: true,
      cancelled: false,
      kpis,
      equityCurve: [{ date: cfg.startDate, value: initialCapital }],
      benchmark: [],
      drawdownSeries: [{ date: cfg.startDate, value: 0 }],
      trades: [],
      messages
    };
  }

  // ── Estado da simulação ──────────────────────────────────
  let cash = initialCapital;
  let realized = 0;
  let lastEquity = initialCapital;
  let processedBars = 0;
  const positions = new Map();
  const pending = new Map();
  const lastClose = new Map();
  const equityCurve = [{ date: cfg.startDate, value: initialCapital }];

  const slip = cfg.slippagePct / 100;
  const commission = cfg.commissionPct / 100;

  function openPosition(a, i, info) {
    const rawOpen = Number(a.candles[i].open);
    const entryRaw = Number.isFinite(rawOpen) ? rawOpen : Number(a.candles[i].close);
    const entry = cfg.exitMode === 'full'
      ? (info.side === 'LONG' ? entryRaw * (1 + slip) : entryRaw * (1 - slip))
      : entryRaw;

    let slPrice;
    let tpPrice;
    if (cfg.stopType === 'pct') {
      slPrice = info.side === 'LONG' ? entry * (1 - cfg.stopLoss / 100) : entry * (1 + cfg.stopLoss / 100);
      tpPrice = info.side === 'LONG' ? entry * (1 + cfg.takeProfit / 100) : entry * (1 - cfg.takeProfit / 100);
    } else {
      const atr = info.atr || 0;
      slPrice = info.side === 'LONG' ? entry - atr * cfg.stopLoss : entry + atr * cfg.stopLoss;
      tpPrice = info.side === 'LONG' ? entry + atr * cfg.takeProfit : entry - atr * cfg.takeProfit;
    }

    const pos = {
      ticker: a.ticker,
      name: a.name,
      side: info.side,
      entryPrice: entry,
      slPrice,
      tpPrice,
      peak: Number(a.candles[i].high),
      trough: Number(a.candles[i].low),
      entryDate: String(a.candles[i].date),
      shares: null,
      notional: null
    };

    if (cfg.exitMode === 'full') {
      const riskAmount = lastEquity * (cfg.riskPerTradePct / 100);
      let shares = Math.floor(riskAmount / Math.max(Math.abs(entry - slPrice), 1e-9));
      if (shares <= 0) return;
      if (info.side === 'LONG') {
        const unitCost = entry * (1 + commission);
        const maxShares = Math.floor(cash / Math.max(unitCost, 1e-9));
        shares = Math.min(shares, maxShares);
        if (shares <= 0) return;
        cash -= shares * unitCost;
      } else {
        cash += shares * entry * (1 - commission);
      }
      pos.shares = shares;
    } else {
      pos.notional = riskNotional;
    }

    positions.set(a.ticker, pos);
  }

  function managePosition(pos, bar) {
    if (pos.side === 'LONG') {
      pos.peak = Math.max(pos.peak, bar.high);
      let effectiveStop = pos.slPrice;
      let trailing = false;
      if (cfg.trailingStop && cfg.trailingOffsetPct > 0) {
        const cand = pos.peak * (1 - cfg.trailingOffsetPct / 100);
        if (cand > effectiveStop) {
          effectiveStop = cand;
          trailing = true;
        }
      }
      if (bar.low <= effectiveStop) return { price: effectiveStop, reason: trailing ? 'Trailing' : 'SL' };
      if (bar.high >= pos.tpPrice) return { price: pos.tpPrice, reason: 'TP' };
    } else {
      pos.trough = Math.min(pos.trough, bar.low);
      let effectiveStop = pos.slPrice;
      let trailing = false;
      if (cfg.trailingStop && cfg.trailingOffsetPct > 0) {
        const cand = pos.trough * (1 + cfg.trailingOffsetPct / 100);
        if (cand < effectiveStop) {
          effectiveStop = cand;
          trailing = true;
        }
      }
      if (bar.high >= effectiveStop) return { price: effectiveStop, reason: trailing ? 'Trailing' : 'SL' };
      if (bar.low <= pos.tpPrice) return { price: pos.tpPrice, reason: 'TP' };
    }
    return null;
  }

  function closePosition(a, pos, exitPriceRaw, reason, exitDate) {
    const exit = cfg.exitMode === 'full'
      ? (pos.side === 'LONG' ? exitPriceRaw * (1 - slip) : exitPriceRaw * (1 + slip))
      : exitPriceRaw;
    const sign = pos.side === 'LONG' ? 1 : -1;
    const profitPct = pos.entryPrice > 0 ? ((exit - pos.entryPrice) / pos.entryPrice) * sign * 100 : 0;

    let profit;
    if (cfg.exitMode === 'full') {
      if (pos.side === 'LONG') {
        cash += pos.shares * exit * (1 - commission);
      } else {
        cash -= pos.shares * exit * (1 + commission);
      }
      profit = sign * pos.shares * (exit - pos.entryPrice) - commission * (pos.shares * pos.entryPrice + pos.shares * exit);
    } else {
      profit = pos.notional * (profitPct / 100);
    }
    realized += profit;

    trades.push({
      ticker: pos.ticker,
      name: pos.name,
      side: pos.side,
      entryDate: pos.entryDate,
      entryPrice: round2(pos.entryPrice),
      exitDate,
      exitPrice: round2(exit),
      reason,
      profit: round2(profit),
      profitPct: round1(profitPct),
      durationDays: round1((toTime(exitDate) - toTime(pos.entryDate)) / 86400000)
    });
    positions.delete(pos.ticker);
  }

  // ── Loop principal: bar a bar, sem lookahead ─────────────
  let dateIdx = 0;
  for (const date of allDates) {
    if (isCancelled()) {
      return { ok: false, cancelled: true, messages };
    }

    // Cede o event loop periodicamente para o worker processar
    // mensagens (cancelamento) enquanto o loop corre.
    dateIdx++;
    if (dateIdx % 5 === 0) await yieldToEventLoop();

    for (const a of assets) {
      while (a.ptr <= a.endIdx && String(a.candles[a.ptr].date) <= date) {
        const c = a.candles[a.ptr];
        const bar = {
          open: Number(c.open),
          high: Number(c.high),
          low: Number(c.low),
          close: Number(c.close)
        };
        lastClose.set(a.ticker, bar.close);

        // 1) Preencher entrada pendente no open desta barra
        if (pending.has(a.ticker)) {
          const info = pending.get(a.ticker);
          pending.delete(a.ticker);
          openPosition(a, a.ptr, info);
        }

        // 2) Gerir posição aberta dentro da barra (SL/TP/Trailing)
        const pos = positions.get(a.ticker);
        if (pos) {
          const exit = managePosition(pos, bar);
          if (exit) closePosition(a, pos, exit.price, exit.reason, String(c.date));
        }

        // 3) Avaliar sinal na barra t → entrada no open de t+1
        const sig = evaluateSignal(a.candles, a.ptr, cfg);
        if (sig && a.ptr + 1 <= a.endIdx && String(a.candles[a.ptr + 1].date) <= cfg.endDate) {
          const after = positions.get(a.ticker);
          if (after) {
            if (sig.side !== after.side) {
              // Reversão de sinal: fechar no close e reagendar
              closePosition(a, after, bar.close, 'Sinal', String(c.date));
              pending.set(a.ticker, { side: sig.side, atr: sig.atr });
            }
          } else {
            pending.set(a.ticker, { side: sig.side, atr: sig.atr });
          }
        }

        a.ptr++;
        processedBars++;
        if (totalBars > 0 && processedBars % 500 === 0) {
          onProgress(Math.min(100, (processedBars / totalBars) * 100));
        }
      }
    }

    // Curva de capital no fim do dia
    let eq;
    if (cfg.exitMode === 'full') {
      eq = cash;
      for (const pos of positions.values()) {
        const last = lastClose.get(pos.ticker) || pos.entryPrice;
        eq += pos.side === 'LONG' ? pos.shares * last : -pos.shares * last;
      }
    } else {
      eq = initialCapital + realized;
      for (const pos of positions.values()) {
        const last = lastClose.get(pos.ticker) || pos.entryPrice;
        const sign = pos.side === 'LONG' ? 1 : -1;
        eq += pos.notional * sign * ((last - pos.entryPrice) / pos.entryPrice);
      }
    }
    equityCurve.push({ date, value: round2(eq) });
    lastEquity = eq;
  }

  // Fecho de posições ainda abertas no fim do período
  for (const pos of Array.from(positions.values())) {
    const a = assets.find(x => x.ticker === pos.ticker);
    const last = lastClose.get(pos.ticker) || pos.entryPrice;
    if (a) closePosition(a, pos, last, 'Sinal', String(a.candles[a.endIdx].date));
    else closePosition(null, pos, last, 'Sinal', cfg.endDate);
  }

  const kpis = calculateKPIs(trades, equityCurve, initialCapital);

  // Drawdown ponto-a-ponto (%)
  const drawdownSeries = [];
  let peakEq = initialCapital;
  for (const p of equityCurve) {
    peakEq = Math.max(peakEq, p.value);
    drawdownSeries.push({ date: p.date, value: peakEq > 0 ? round1(((peakEq - p.value) / peakEq) * 100) : 0 });
  }

  onProgress(100);
  onStatus(`Simulação concluída: ${trades.length} trades`);

  return {
    ok: true,
    cancelled: false,
    kpis,
    equityCurve,
    benchmark: buildBenchmark(assets, allDates, initialCapital),
    drawdownSeries,
    trades,
    messages
  };
}

// ═══════════════════════════════════════════════════════════
//  Benchmark Buy & Hold — equal-weight, normalizado ao capital
// ═══════════════════════════════════════════════════════════
function buildBenchmark(assets, allDates, initialCapital) {
  const valid = assets
    .map(a => {
      const fc = Number(a.candles[a.startIdx].close);
      return { a, firstClose: Number.isFinite(fc) && fc > 0 ? fc : null };
    })
    .filter(v => v.firstClose);

  const n = valid.length;
  if (n === 0) return [];
  const per = initialCapital / n;
  const ptrs = new Map();
  valid.forEach(v => ptrs.set(v.a.ticker, v.a.startIdx));

  const out = [];
  for (const date of allDates) {
    let value = 0;
    for (const v of valid) {
      const a = v.a;
      let p = ptrs.get(a.ticker);
      while (p <= a.endIdx && String(a.candles[p].date) <= date) p++;
      ptrs.set(a.ticker, p);
      const close = p > a.startIdx ? Number(a.candles[p - 1].close) : v.firstClose;
      value += (close / v.firstClose) * per;
    }
    out.push({ date, value: round2(value) });
  }
  return out;
}

// ═══════════════════════════════════════════════════════════
//  KPIs
// ═══════════════════════════════════════════════════════════
function calculateKPIs(trades, equityCurve, initialCapital) {
  const total = trades.length;
  const wins = trades.filter(t => t.profit > 0);
  const losses = trades.filter(t => t.profit <= 0);
  const winRate = total > 0 ? (wins.length / total) * 100 : 0;

  const grossProfit = wins.reduce((s, t) => s + t.profit, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.profit, 0));
  const profitFactor = grossLoss === 0 ? null : grossProfit / grossLoss;

  const avgWin = wins.length > 0 ? grossProfit / wins.length : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((s, t) => s + t.profit, 0) / losses.length : 0;
  const payoffRatio = avgLoss === 0 ? null : Math.abs(avgWin / avgLoss);
  const expectancy = total > 0 ? (winRate / 100) * avgWin - (1 - winRate / 100) * Math.abs(avgLoss) : 0;

  const finalEquity = equityCurve.length > 0 ? equityCurve[equityCurve.length - 1].value : initialCapital;
  const netProfit = finalEquity - initialCapital;
  const netProfitPct = initialCapital > 0 ? (netProfit / initialCapital) * 100 : 0;

  let peak = initialCapital;
  let maxDrawdown = 0;
  let maxDrawdownPct = 0;
  for (const p of equityCurve) {
    peak = Math.max(peak, p.value);
    const dd = peak - p.value;
    if (dd > maxDrawdown) maxDrawdown = dd;
    const ddPct = peak > 0 ? (dd / peak) * 100 : 0;
    if (ddPct > maxDrawdownPct) maxDrawdownPct = ddPct;
  }

  const avgDuration = total > 0 ? trades.reduce((s, t) => s + (t.durationDays || 0), 0) / total : 0;

  return {
    netProfit: round2(netProfit),
    netProfitPct: round2(netProfitPct),
    winRate: round1(winRate),
    profitFactor: profitFactor == null ? null : round2(profitFactor),
    maxDrawdown: round2(maxDrawdown),
    maxDrawdownPct: round1(maxDrawdownPct),
    payoffRatio: payoffRatio == null ? null : round2(payoffRatio),
    totalTrades: total,
    longTrades: trades.filter(t => t.side === 'LONG').length,
    shortTrades: trades.filter(t => t.side === 'SHORT').length,
    avgDurationDays: round1(avgDuration),
    grossProfit: round2(grossProfit),
    grossLoss: round2(grossLoss),
    expectancy: round2(expectancy)
  };
}

module.exports = { runSimulation, calculateKPIs };
