'use strict';

const { analyzeSeries } = require('../quant/markovEngine');
const { calculateRVOL } = require('../quant/indicators');
const { runMarkovMonteCarloSimulation } = require('../quant/monteCarloEngine');

let __nativeForBacktester = null;
try { __nativeForBacktester = require('../native'); } catch (_) {}

const DEFAULT_WARMUP = 200;
const DEFAULT_MARKOV_WINDOW = 150;
const DEFAULT_HORIZON = 5;

const SUPPORTED_STATE_SPACES = ['9', '6', '3'];
const STATE_SPACES_SET = new Set(SUPPORTED_STATE_SPACES);

// Nº de estados por espaço (mapa local para não depender de getNumStates
// quando markovEngine é substituído por um stub nos testes).
const STATE_SPACE_SIZES = { '9': 9, '6': 6, '3': 3 };
function numStatesFor(stateSpace) {
  return STATE_SPACE_SIZES[String(stateSpace)] || 9;
}

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
//  Pré-cálculo rápido de Rolling VWAP(20) com janela deslizante O(N)
// ═══════════════════════════════════════════════════════════
function precalculateRollingVWAP(candles, windowSize = 20) {
  const len = candles.length;
  const vwapArray = new Float64Array(len);
  let sumVolPrice = 0;
  let sumVol = 0;

  for (let i = 0; i < len; i++) {
    const c = candles[i];
    const tp = (Number(c.high) + Number(c.low) + Number(c.close)) / 3.0;
    const vol = Number(c.volume) || 0;
    sumVolPrice += tp * vol;
    sumVol += vol;

    if (i >= windowSize) {
      const old = candles[i - windowSize];
      const oldTp = (Number(old.high) + Number(old.low) + Number(old.close)) / 3.0;
      const oldVol = Number(old.volume) || 0;
      sumVolPrice -= oldTp * oldVol;
      sumVol -= oldVol;
    }

    vwapArray[i] = sumVol > 0 ? (sumVolPrice / sumVol) : Number(c.close);
  }
  return vwapArray;
}

// ═══════════════════════════════════════════════════════════
//  Pré-cálculo rápido de vetores de indicadores por ativo
// ═══════════════════════════════════════════════════════════
function precomputeAssetIndicators(candles, cfg) {
  const n = candles.length;
  const closes = new Float64Array(n);
  const highs = new Float64Array(n);
  const lows = new Float64Array(n);
  const volumes = new Float64Array(n);
  const vwap = precalculateRollingVWAP(candles, 20);
  const rvolApproved = new Uint8Array(n);

  for (let i = 0; i < n; i++) {
    const c = candles[i];
    closes[i] = Number(c.close);
    highs[i] = Number(c.high);
    lows[i] = Number(c.low);
    volumes[i] = Number(c.volume) || 0;
  }

  // RVOL(20)
  const minRvol = cfg && (cfg.minRVOL ?? cfg.rvolMin) != null ? Number(cfg.minRVOL ?? cfg.rvolMin) : 1.0;
  for (let i = 0; i < n; i++) {
    if (i < 20) {
      rvolApproved[i] = 1;
    } else {
      let sumVol = 0;
      for (let k = i - 20; k < i; k++) {
        sumVol += volumes[k];
      }
      const avgVol = sumVol / 20;
      const rvolVal = avgVol > 0 ? volumes[i] / avgVol : 1.0;
      rvolApproved[i] = (avgVol > 0 && rvolVal >= minRvol) ? 1 : 0;
    }
  }

  return { closes, highs, lows, volumes, vwap, rvolApproved };
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
    horizonDays: cfg.horizonDays,
    rvolMin: cfg.minRVOL,
    markovOrder: cfg.markovOrder,
    stateSpace: cfg.stateSpace
  });

  if (!result || result.close == null) return null;
  if (result.direction !== 'COMPRA' && result.direction !== 'VENDA') return null;

  const dir = result.direction;
  if (dir === 'COMPRA' && cfg.direction === 'short') return null;
  if (dir === 'VENDA' && cfg.direction === 'long') return null;

  // Nível mínimo de transição de Markov (%)
  if (dir === 'COMPRA' && result.pBull * 100 < cfg.markovMinPct) return null;
  if (dir === 'VENDA' && result.pBear * 100 < cfg.markovMinPct) return null;

  // Gatekeeper 1: Rolling VWAP(20) — verificação antecipada pré-Monte Carlo
  if (cfg.vwapGate && result.rollingVwap20 != null && result.close != null) {
    if (dir === 'COMPRA' && result.close <= result.rollingVwap20) return null;
    if (dir === 'VENDA' && result.close >= result.rollingVwap20) return null;
  }

  // Gatekeeper 2: RVOL(20) — confirmação de volume institucional antes do Monte Carlo
  if (cfg.rvolGate && dir === 'COMPRA') {
    const rvolApproved = result.rvolApproved != null ? result.rvolApproved
      : (() => { const r = calculateRVOL(slice, 20); return r.avgVolume > 0 && r.rvol >= (cfg.minRVOL ?? 1.0); })();
    if (!rvolApproved) return null;
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
    {
      slPct: slFrac,
      tpPct: tpFrac,
      side: dir === 'COMPRA' ? 'LONG' : 'SHORT',
      order: cfg.markovOrder,
      prevState: result.prevState,
      stateSpace: cfg.stateSpace
    }
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
    rvolGate: params.rvolGate !== undefined ? !!params.rvolGate : true,
    minRVOL: (params.minRVOL ?? params.rvolMin) != null ? Number(params.minRVOL ?? params.rvolMin) : 1.0,
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
    horizonDays: Number(params.horizonDays) || DEFAULT_HORIZON,
    markovOrder: Number(params.markovOrder) === 2 ? 2 : 1,
    stateSpace: (STATE_SPACES_SET.has(String(params.stateSpace)) ? String(params.stateSpace) : '9')
  };

  const messages = [];
  const trades = [];
  const initialCapital = cfg.initialCapital;
  const riskNotional = initialCapital * (cfg.riskPerTradePct / 100);

  // ── Pré-processamento: warm-up por ativo ─────────────────
  const assets = [];
  for (const u of universe) {
    if (!u || !Array.isArray(u.candles) || u.candles.length === 0) continue;
    const candles = u.candles
      .filter(c => c && c.close != null && String(c.close).trim() !== '' && Number.isFinite(Number(c.close)))
      .map(c => ({
        date: c.date,
        open: Number(c.open),
        high: Number(c.high),
        low: Number(c.low),
        close: Number(c.close),
        volume: Number(c.volume)
      }))
      .sort((a, b) => (String(a.date) < String(b.date) ? -1 : String(a.date) > String(b.date) ? 1 : 0));
    if (candles.length === 0) continue;

    let requestedStartIdx = 0;
    if (cfg.startDate) {
      while (requestedStartIdx < candles.length && String(candles[requestedStartIdx].date) < cfg.startDate) requestedStartIdx++;
    }

    if (candles.length <= cfg.warmup) {
      messages.push(`${u.ticker || '?'}: Ativo sem registos suficientes na base de dados SQLite.`);
      continue;
    }

    if (cfg.startDate && requestedStartIdx >= candles.length) {
      messages.push(`IGNORADO ${u.ticker || '?'}: startDate fora do histórico disponível`);
      continue;
    }

    const effectiveStartIdx = Math.max(requestedStartIdx, cfg.warmup);

    if (cfg.startDate && effectiveStartIdx > requestedStartIdx) {
      messages.push(`${u.ticker || '?'}: warm-up insuficiente até ${cfg.startDate}; início ajustado para ${candles[effectiveStartIdx].date}`);
    }

    let endIdx = candles.length - 1;
    if (cfg.endDate) {
      while (endIdx >= 0 && String(candles[endIdx].date) > cfg.endDate) endIdx--;
    }
    if (endIdx < effectiveStartIdx) continue;

    // Pré-computação vectorial de indicadores para este ativo
    const precomputed = precomputeAssetIndicators(candles, cfg);

    assets.push({
      ticker: u.ticker,
      name: u.name || u.ticker,
      candles,
      startIdx: effectiveStartIdx,
      endIdx,
      ptr: effectiveStartIdx,
      precomputed
    });
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
      messages,
      meta: {
        markovOrder: cfg.markovOrder,
        stateSpace: cfg.stateSpace,
        numStates: numStatesFor(cfg.stateSpace)
      }
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
  const equityCurve = [];

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

    // Cede o event loop periodicamente para o worker processar mensagens
    dateIdx++;
    if (dateIdx % 25 === 0) await yieldToEventLoop();

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
        if (totalBars > 0 && processedBars % 250 === 0) {
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
    messages,
    meta: {
      markovOrder: cfg.markovOrder,
      stateSpace: cfg.stateSpace,
      numStates: numStatesFor(cfg.stateSpace)
    }
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
      while (p + 1 <= a.endIdx && String(a.candles[p + 1].date) <= date) p++;
      ptrs.set(a.ticker, p);
      const c = Number(a.candles[p].close);
      const mult = Number.isFinite(c) && v.firstClose > 0 ? c / v.firstClose : 1;
      value += per * mult;
    }
    out.push({ date, value: round2(value) });
  }
  return out;
}

// ═══════════════════════════════════════════════════════════
//  Cálculo de KPIs
// ═══════════════════════════════════════════════════════════
function calculateKPIs(trades, equityCurve, initialCapital) {
  const list = Array.isArray(trades) ? trades : [];
  const totalTrades = list.length;
  const longTrades = list.filter(t => String(t.side).toUpperCase() === 'LONG').length;
  const shortTrades = list.filter(t => String(t.side).toUpperCase() === 'SHORT').length;

  const wins = list.filter(t => Number(t.profit) > 0);
  const losses = list.filter(t => Number(t.profit) < 0);
  const winRate = totalTrades > 0 ? (wins.length / totalTrades) * 100 : 0;

  const grossProfit = wins.reduce((sum, t) => sum + Number(t.profit), 0);
  const grossLoss = Math.abs(losses.reduce((sum, t) => sum + Number(t.profit), 0));
  const netProfit = grossProfit - grossLoss;
  const netProfitPct = initialCapital > 0 ? (netProfit / initialCapital) * 100 : 0;

  const profitFactor = grossLoss > 0
    ? grossProfit / grossLoss
    : (grossProfit > 0 ? 99.9 : 0);

  const avgWin = wins.length > 0 ? grossProfit / wins.length : 0;
  const avgLoss = losses.length > 0 ? grossLoss / losses.length : 0;
  const payoffRatio = avgLoss > 0 ? avgWin / avgLoss : (avgWin > 0 ? 99.9 : 0);

  // Max Drawdown na curva de capital diária
  let maxDrawdown = 0;
  let maxDrawdownPct = 0;
  let peak = initialCapital;
  for (const p of equityCurve || []) {
    const v = Number(p.value);
    if (!Number.isFinite(v)) continue;
    if (v > peak) peak = v;
    const dd = peak - v;
    if (dd > maxDrawdown) maxDrawdown = dd;
    if (peak > 0) {
      const ddPct = (dd / peak) * 100;
      if (ddPct > maxDrawdownPct) maxDrawdownPct = ddPct;
    }
  }

  // Duração média (dias)
  const durations = list.map(t => Number(t.durationDays)).filter(d => Number.isFinite(d));
  const avgDurationDays = durations.length > 0
    ? durations.reduce((a, b) => a + b, 0) / durations.length
    : null;

  // Expectancy (€ por trade)
  const pW = totalTrades > 0 ? wins.length / totalTrades : 0;
  const pL = totalTrades > 0 ? losses.length / totalTrades : 0;
  const expectancy = (pW * avgWin) - (pL * avgLoss);

  return {
    netProfit: round2(netProfit),
    netProfitPct: round1(netProfitPct),
    winRate: round1(winRate),
    profitFactor: round2(profitFactor),
    maxDrawdown: round2(maxDrawdown),
    maxDrawdownPct: round1(maxDrawdownPct),
    payoffRatio: round2(payoffRatio),
    totalTrades,
    longTrades,
    shortTrades,
    grossProfit: round2(grossProfit),
    grossLoss: round2(grossLoss),
    avgDurationDays: avgDurationDays != null ? round1(avgDurationDays) : null,
    expectancy: round2(expectancy)
  };
}

// ─────────────────────────────────────────────────────────────
// Spec Passo 3 – Classe BacktesterEngine (bar-by-bar) – mantida em paralelo
// com runSimulation (usada por testes existentes) para compatibilidade
// com o prompt e com o worker spec (workerData).
// ─────────────────────────────────────────────────────────────

function calculateMarkovMatrix(candles, options = {}) {
  try {
    const me = require('../quant/markovEngine');
    const ind = require('../quant/indicators');
    const stateSpace = STATE_SPACES_SET.has(String(options.stateSpace)) ? String(options.stateSpace) : '9';
    const markovOrder = Number(options.markovOrder) === 2 ? 2 : 1;
    const n = candles.length;
    const closes = new Float64Array(n);
    const highs = new Float64Array(n);
    const lows = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      closes[i] = Number(candles[i].close);
      highs[i] = Number(candles[i].high);
      lows[i] = Number(candles[i].low);
    }
    const rsi = ind.rsiWilder(closes, 21);
    const adx = ind.adxWilder(highs, lows, closes, 14);
    const bb = ind.bollingerBands(closes, 30, 2);
    const { buildStateSeries, buildTransitionMatrix, buildTransitionMatrixOrder2, getNumStates } = me;
    const states = buildStateSeries(bb.pctB, rsi, adx, stateSpace);
    const matrix = markovOrder === 2
      ? buildTransitionMatrixOrder2(states, 150, stateSpace)
      : buildTransitionMatrix(states, 150, stateSpace);
    const currentState = states[states.length - 1];
    const prevState = states[states.length - 2];
    const { buildStateReturnsMap } = require('../quant/monteCarloEngine');
    const stateReturns = buildStateReturnsMap(candles, stateSpace);
    if (currentState < 0) return { isValid: false };
    return { isValid: true, transitionMatrix: matrix, stateReturns, currentState, prevState, order: markovOrder, stateSpace, numStates: getNumStates(stateSpace) };
  } catch (_) {
    return { isValid: false };
  }
}

class BacktesterEngine {
  constructor(config = {}) {
    this.initialCapital = Number(config.initialCapital) || 10000;
    this.capital = this.initialCapital;
    this.riskPerTrade = Number(config.riskPerTradePct || 2) / 100;
    this.stopLossPct = Number(config.stopLoss || 1.4) / 100;
    this.takeProfitPct = Number(config.takeProfit || 2.8) / 100;
    this.direction = config.direction || 'BOTH';
    this.minMCWinRate = Number(config.minMCWinRate || 50);
    this.minRVOL = (config.minRVOL ?? config.rvolMin) != null ? Number(config.minRVOL ?? config.rvolMin) : 1.0;
    this.rvolGate = config.rvolGate !== undefined ? !!config.rvolGate : true;
    this.markovOrder = Number(config.markovOrder) === 2 ? 2 : 1;
    this.stateSpace = STATE_SPACES_SET.has(String(config.stateSpace)) ? String(config.stateSpace) : '9';
    this.trades = [];
    this.equityCurve = [];
  }

  run(candles, quantEngine) {
    if (!candles || candles.length < 220) return null;
    const qe = quantEngine || __nativeForBacktester;
    const n = candles.length;
    const precomputed = precomputeAssetIndicators(candles, { minRVOL: this.minRVOL });
    let inPosition = false;
    let currentTrade = null;
    let peakCapital = this.capital;
    let maxDrawdown = 0;

    for (let i = 200; i < n; i++) {
      const currentCandle = candles[i];
      if (this.capital > peakCapital) peakCapital = this.capital;
      const currentDrawdown = ((peakCapital - this.capital) / peakCapital) * 100;
      if (currentDrawdown > maxDrawdown) maxDrawdown = currentDrawdown;

      if (inPosition && currentTrade) {
        let closed = false; let exitPrice = 0; let exitReason = '';
        if (currentTrade.type === 'LONG') {
          if (currentCandle.high >= currentTrade.tpPrice) { exitPrice = currentTrade.tpPrice; exitReason = 'TAKE_PROFIT'; closed = true; }
          else if (currentCandle.low <= currentTrade.slPrice) { exitPrice = currentTrade.slPrice; exitReason = 'STOP_LOSS'; closed = true; }
        } else if (currentTrade.type === 'SHORT') {
          if (currentCandle.low <= currentTrade.tpPrice) { exitPrice = currentTrade.tpPrice; exitReason = 'TAKE_PROFIT'; closed = true; }
          else if (currentCandle.high >= currentTrade.slPrice) { exitPrice = currentTrade.slPrice; exitReason = 'STOP_LOSS'; closed = true; }
        }
        if (closed) {
          const pnlPct = currentTrade.type === 'LONG' ? (exitPrice - currentTrade.entryPrice) / currentTrade.entryPrice : (currentTrade.entryPrice - exitPrice) / currentTrade.entryPrice;
          const pnlEur = currentTrade.positionSize * pnlPct;
          this.capital += pnlEur;
          this.trades.push({ ...currentTrade, exitDate: currentCandle.date, exitPrice, exitReason, pnlEur, pnlPct: pnlPct * 100, capitalAfter: this.capital });
          this.equityCurve.push({ date: currentCandle.date, capital: this.capital });
          inPosition = false; currentTrade = null; continue;
        }
      }

      if (!inPosition && i < n - 1) {
        const lastClose = precomputed.closes[i];
        const rollingVWAP = precomputed.vwap[i];

        // Gatekeeper 1: Rolling VWAP 20
        let targetDirection = null;
        if ((this.direction === 'LONG' || this.direction === 'BOTH') && lastClose > rollingVWAP) targetDirection = 'LONG';
        else if ((this.direction === 'SHORT' || this.direction === 'BOTH') && lastClose < rollingVWAP) targetDirection = 'SHORT';

        if (!targetDirection) continue;

        // Gatekeeper RVOL(20)
        if (this.rvolGate && targetDirection === 'LONG') {
          if (!precomputed.rvolApproved[i]) continue;
        }

        const slice = candles.slice(0, i + 1);
        const signal = this.evaluateSignal(slice, qe, targetDirection);
        if (signal && signal.approved) {
          const entryPrice = currentCandle.close;
          const positionSize = (this.capital * this.riskPerTrade) / this.stopLossPct;
          currentTrade = {
            ticker: signal.ticker || candles[0].ticker,
            type: signal.type,
            entryDate: currentCandle.date,
            entryPrice,
            positionSize,
            slPrice: signal.type === 'LONG' ? entryPrice * (1 - this.stopLossPct) : entryPrice * (1 + this.stopLossPct),
            tpPrice: signal.type === 'LONG' ? entryPrice * (1 + this.takeProfitPct) : entryPrice * (1 - this.takeProfitPct),
            mcWinRate: signal.mcWinRate,
            mcTier: signal.mcTier
          };
          inPosition = true;
        }
      }
    }
    const wins = this.trades.filter(t => t.pnlEur > 0);
    const losses = this.trades.filter(t => t.pnlEur <= 0);
    const totalProfit = wins.reduce((acc, t) => acc + t.pnlEur, 0);
    const totalLoss = Math.abs(losses.reduce((acc, t) => acc + t.pnlEur, 0));
    return {
      initialCapital: this.initialCapital,
      finalCapital: this.capital,
      netProfit: this.capital - this.initialCapital,
      netProfitPct: ((this.capital - this.initialCapital) / this.initialCapital) * 100,
      totalTrades: this.trades.length,
      winsCount: wins.length,
      lossesCount: losses.length,
      winRate: this.trades.length > 0 ? (wins.length / this.trades.length) * 100 : 0,
      profitFactor: totalLoss > 0 ? (totalProfit / totalLoss) : (totalProfit > 0 ? 99.9 : 0),
      maxDrawdown,
      equityCurve: this.equityCurve,
      trades: this.trades
    };
  }

  evaluateSignal(slice, quantEngine, hintDirection) {
    const lastCandle = slice[slice.length - 1];
    const lastClose = Number(lastCandle.close);
    let targetDirection = hintDirection;

    if (!targetDirection) {
      let cumVol = 0; let cumVolPrice = 0;
      const vwapSlice = slice.slice(-20);
      for (const c of vwapSlice) { const tp = (Number(c.high) + Number(c.low) + Number(c.close)) / 3; cumVolPrice += tp * Number(c.volume || 0); cumVol += Number(c.volume || 0); }
      const rollingVWAP = cumVol > 0 ? (cumVolPrice / cumVol) : lastClose;
      if ((this.direction === 'LONG' || this.direction === 'BOTH') && lastClose > rollingVWAP) targetDirection = 'LONG';
      else if ((this.direction === 'SHORT' || this.direction === 'BOTH') && lastClose < rollingVWAP) targetDirection = 'SHORT';
      if (!targetDirection) return null;

      // Gatekeeper RVOL(20)
      if (this.rvolGate && targetDirection === 'LONG') {
        const r = calculateRVOL(slice, 20);
        if (r.avgVolume <= 0 || r.rvol < this.minRVOL) return null;
      }
    }

    const markov = calculateMarkovMatrix(slice, { markovOrder: this.markovOrder, stateSpace: this.stateSpace });
    if (!markov || !markov.isValid) return null;
    let mc = null;
    if (markov.order === 2) {
      try {
        mc = runMarkovMonteCarloSimulation(markov.transitionMatrix, markov.currentState, slice, lastClose, {
          slPct: this.stopLossPct, tpPct: this.takeProfitPct, side: targetDirection,
          order: 2, prevState: markov.prevState, stateSpace: markov.stateSpace
        });
        if (mc && mc.winRate != null && mc.winRateMC == null) mc.winRateMC = mc.winRate;
      } catch (_) { mc = null; }
    } else {
      const qe = quantEngine || __nativeForBacktester;
      if (!qe || typeof qe.runMonteCarlo !== 'function') return null;
      try {
        if (qe.runMonteCarlo.length >= 8) {
          mc = qe.runMonteCarlo(markov.transitionMatrix, markov.stateReturns, markov.currentState, lastClose, 1000, 20, this.stopLossPct, this.takeProfitPct);
        } else {
          mc = qe.runMonteCarlo(markov.transitionMatrix, markov.stateReturns, markov.currentState, lastClose, { iterations: 1000, daysAhead: 20, slPct: this.stopLossPct, tpPct: this.takeProfitPct });
          if (mc && mc.winRate != null && mc.winRateMC == null) mc.winRateMC = mc.winRate;
        }
      } catch (_) { mc = null; }
    }
    if (!mc) return null;
    const winRateMC = mc.winRateMC != null ? mc.winRateMC : (mc.winRate != null ? mc.winRate : 0);
    if (winRateMC >= this.minMCWinRate) {
      return { approved: true, type: targetDirection, mcWinRate: winRateMC, mcTier: mc.mcTier, ticker: slice[0].ticker };
    }
    return null;
  }
}

module.exports = { runSimulation, calculateKPIs, BacktesterEngine, calculateMarkovMatrix, precalculateRollingVWAP };
