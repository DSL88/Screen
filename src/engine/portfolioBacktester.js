'use strict';

// ═══════════════════════════════════════════════════════════
//  portfolioBacktester.js — Backtester de Carteira Multi-Ativo
//
//  Banca global unificada (ex.: 10.000 €), processa o universo
//  dia a dia em ordem cronológica estrita (sem lookahead).
//
//  Modelo operacional:
//    • Slots de capital: 10/15/20% por trade, N posições simultâneas.
//    • Pipeline de entrada (dia d): warm-up 200 → Rolling VWAP 20 →
//      Markov (direção COMPRA) → Monte Carlo (1000 it, ≥50%/≥65%).
//    • Desempate: mais candidatos que vagas → maior convicção MC.
//    • Saídas diárias rigorosas: TP +4.8% · SL −2.4% · expiração 35d.
//    • Capital restituído ao saldo no instante do fecho.
//    • Equity diária = cash + marcação na mercado das posições.
// ═══════════════════════════════════════════════════════════

const { analyzeSeries } = require('../quant/markovEngine');
const { runMarkovMonteCarloSimulation, classifyMCTier } = require('../quant/monteCarloEngine');
const metrics = require('../quant/workstation/metrics');
const validation = require('../quant/workstation/validation');

function round2(v) { return Math.round((Number(v) || 0) * 100) / 100; }
function round1(v) { return Math.round((Number(v) || 0) * 10) / 10; }

// ═══════════════════════════════════════════════════════════
//  Matriz de Slots — regras de cálculo
//    Máx. posições = floor(100% / Slot%)
//    Capital por trade = Capital × (Slot% / 100)
//  (o motor calcula capital por trade dinamicamente a partir do
//   património; aqui ficam os presets para UI/referência)
// ═══════════════════════════════════════════════════════════
const SLOT_DEFINITIONS = {
  '2':   { slotPct: 0.020, maxPositions: Math.floor(1 / 0.020) },  // 50
  '5':   { slotPct: 0.050, maxPositions: Math.floor(1 / 0.050) },  // 20
  '7.5': { slotPct: 0.075, maxPositions: Math.floor(1 / 0.075) },  // 13
  '10':  { slotPct: 0.100, maxPositions: Math.floor(1 / 0.100) },  // 10
  '15':  { slotPct: 0.150, maxPositions: Math.floor(1 / 0.150) },  // 6
  '20':  { slotPct: 0.200, maxPositions: Math.floor(1 / 0.200) }   // 5
};

function maxPositionsForSlot(slotPct) {
  const p = Number(slotPct);
  if (!Number.isFinite(p) || p <= 0) return 5;
  return Math.max(1, Math.floor((1 + 1e-9) / p));
}

// ── Limites de segurança dos parâmetros ─────────────────────
const MAX_MC_ITERATIONS = 1000000;
const MAX_HORIZON_DAYS = 2520;
const MAX_STOP_LOSS_PCT = 100;
const MAX_TAKE_PROFIT_PCT = 1000;

function finiteNumber(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}


class PortfolioBacktester {
  constructor(config = {}) {
    const warnings = [];
    const invalid = (field, fallback) => {
      warnings.push(`Parâmetro ${field} inválido; normalizado para ${fallback}.`);
    };

    // ── Capital ──────────────────────────────────────────────
    const rawCapital = finiteNumber(config.initialCapital ?? config.capital);
    if (rawCapital == null || rawCapital <= 0) {
      if (config.initialCapital != null || config.capital != null) invalid('initialCapital', '10000');
      this.initialCapital = 10000;
    } else {
      this.initialCapital = rawCapital;
    }
    this.cash = this.initialCapital;

    // Resolução do slot: aceita preset '2'|'5'|'7.5'|'10'|'15'|'20' (em %),
    // positionAllocationPct/slotPct (fração) e maxPositions explícito.
    const presetKey = config.slotSize != null ? String(config.slotSize)
      : (config.slotPct != null ? String(Number(config.slotPct) * 100) : null);
    const preset = presetKey && SLOT_DEFINITIONS[presetKey] ? SLOT_DEFINITIONS[presetKey] : null;

    // ── Alocação por trade: fração em (0, 1] ─────────────────
    let allocation = null;
    const rawAllocation = config.positionAllocationPct != null
      ? config.positionAllocationPct
      : (config.slotPct != null ? config.slotPct : null);
    if (rawAllocation != null) {
      const n = finiteNumber(rawAllocation);
      if (n == null || n <= 0) invalid('positionAllocationPct', preset ? preset.slotPct : 0.20);
      else if (n > 1) { invalid('positionAllocationPct', 1); allocation = 1; }
      else allocation = n;
    }
    if (allocation == null) allocation = preset ? preset.slotPct : 0.20;
    this.positionAllocationPct = allocation;

    // ── Máximo de posições: inteiro em [1, 1000] ─────────────
    const rawMaxPositions = finiteNumber(config.maxPositions);
    if (rawMaxPositions != null && rawMaxPositions > 0) {
      this.maxPositions = Math.min(1000, Math.floor(rawMaxPositions));
    } else {
      if (config.maxPositions != null) invalid('maxPositions', preset ? preset.maxPositions : maxPositionsForSlot(allocation));
      this.maxPositions = preset ? preset.maxPositions : maxPositionsForSlot(allocation);
    }

    // ── Stops: percentagens finitas e positivas ──────────────
    const rawStopLoss = finiteNumber(config.stopLoss);
    if (rawStopLoss == null || rawStopLoss <= 0) {
      if (config.stopLoss != null) invalid('stopLoss', '2.4%');
      this.stopLossPct = 0.024;
    } else {
      this.stopLossPct = Math.min(rawStopLoss, MAX_STOP_LOSS_PCT) / 100;
    }
    const rawTakeProfit = finiteNumber(config.takeProfit);
    if (rawTakeProfit == null || rawTakeProfit <= 0) {
      if (config.takeProfit != null) invalid('takeProfit', '4.8%');
      this.takeProfitPct = 0.048;
    } else {
      this.takeProfitPct = Math.min(rawTakeProfit, MAX_TAKE_PROFIT_PCT) / 100;
    }

    // ── Horizonte: inteiro em [1, 2520] dias úteis ───────────
    const rawHorizon = Number(config.horizonDays);
    if (config.horizonDays != null && (Number.isNaN(rawHorizon) || rawHorizon <= 0)) {
      invalid('horizonDays', 35);
      this.horizonDays = 35;
    } else if (config.horizonDays == null) {
      this.horizonDays = 35;
    } else if (!Number.isFinite(rawHorizon)) {
      this.horizonDays = rawHorizon > 0 ? MAX_HORIZON_DAYS : 35;
    } else {
      this.horizonDays = Math.min(MAX_HORIZON_DAYS, Math.max(1, Math.floor(rawHorizon)));
    }

    // ── Monte Carlo: inteiro em [1, 1_000_000] ───────────────
    const rawIterations = Number(config.mcIterations);
    if (config.mcIterations != null && (Number.isNaN(rawIterations) || rawIterations <= 0)) {
      invalid('mcIterations', 1000);
      this.mcIterations = 1000;
    } else if (config.mcIterations == null) {
      this.mcIterations = 1000;
    } else if (!Number.isFinite(rawIterations)) {
      this.mcIterations = rawIterations > 0 ? MAX_MC_ITERATIONS : 1000;
    } else {
      this.mcIterations = Math.min(MAX_MC_ITERATIONS, Math.max(1, Math.floor(rawIterations)));
    }

    // ── Win-rate mínima: percentagem em [0, 100] ─────────────
    const rawMinMC = finiteNumber(config.minMCWinRate ?? config.minMC ?? config.mcMin);
    this.minMCWinRate = rawMinMC == null ? 50 : Math.min(100, Math.max(0, rawMinMC));

    // ── Direção: apenas long | short | both ──────────────────
    const rawDirection = String(config.direction || 'long').trim().toLowerCase();
    if (rawDirection === 'long' || rawDirection === 'short' || rawDirection === 'both') {
      this.direction = rawDirection;
    } else {
      invalid('direction', 'long');
      this.direction = 'long';
    }

    const rawRisk = finiteNumber(config.riskPerTradePct ?? config.risk);
    this.riskPerTradePct = rawRisk != null && rawRisk > 0 ? rawRisk : this.positionAllocationPct * 100;

    // ── Warm-up / janela de Markov: inteiros ≥ 0 / > 0 ───────
    const rawWarmup = finiteNumber(config.warmup);
    this.warmup = rawWarmup != null && rawWarmup >= 0 ? Math.floor(rawWarmup) : 200;
    if (config.warmup != null && (rawWarmup == null || rawWarmup < 0)) invalid('warmup', 200);

    const rawMarkovWindow = finiteNumber(config.markovWindow);
    this.markovWindow = rawMarkovWindow != null && rawMarkovWindow > 0 ? Math.floor(rawMarkovWindow) : 150;

    const rawMinMarkov = finiteNumber(config.markovMinPct);
    this.minMarkovPct = rawMinMarkov == null ? 0 : Math.min(100, Math.max(0, rawMinMarkov));

    const rawSeed = finiteNumber(config.mcSeed);
    this.mcSeed = rawSeed != null ? rawSeed : undefined;
    this.mfeMaEEnabled = config.mfeMae !== false;

    const rawMinOrder = finiteNumber(config.minOrderCapital);
    this.minOrderCapital = rawMinOrder != null && rawMinOrder > 0 ? rawMinOrder : 50; // piso operacional por ordem

    // ── Custos: finitos e ≥ 0 (percentagem como fornecida) ───
    const rawCommission = finiteNumber(config.commissionPct ?? config.commission);
    this.commissionPct = rawCommission != null && rawCommission >= 0 ? rawCommission : 0;
    if (rawCommission != null && rawCommission < 0) invalid('commission', '0');
    const rawSlippage = finiteNumber(config.slippagePct ?? config.slippage);
    this.slippagePct = rawSlippage != null && rawSlippage >= 0 ? rawSlippage : 0;
    if (rawSlippage != null && rawSlippage < 0) invalid('slippage', '0');

    this.openPositions = [];
    this.closedTrades = [];
    this.dailyEquityCurve = [];
    this.messages = warnings;
  }

  /**
   * Executa a simulação sincronizada multi-ativo (loop day-by-day).
   * Assíncrono: cede o event loop a cada 25 dias e verifica cancelamento,
   * emitindo progresso (data atual) a cada ~5% para a UI.
   * @param {Map<string,Array>|Array|Object} candlesByTicker
   * @param {Array<string>} allCalendarDates - datas de pregão ordenadas (ASC)
   * @param {Object} quantEngine - módulo nativo C++ / fallback JS (opcional)
   * @param {Object} hooks - { onProgress(fn), cancelled(fn) }
   */
  async run(candlesByTicker, allCalendarDates, quantEngine, hooks = {}) {
    const onProgress = typeof hooks.onProgress === 'function' ? hooks.onProgress : () => {};
    const isCancelled = typeof hooks.cancelled === 'function' ? hooks.cancelled : () => false;
    const yieldLoop = () => new Promise(res => setImmediate(res));

    const entries = this._normalizeUniverse(candlesByTicker);
    // Índice data→posição por ticker (construído uma única vez).
    const lookup = new Map();
    for (const e of entries) {
      const m = new Map();
      for (let i = 0; i < e.candles.length; i++) m.set(String(e.candles[i].date), i);
      lookup.set(e.ticker, m);
    }
    const openByTicker = new Map(); // ticker -> pos (consulta O(1))

    let peakEquity = this.initialCapital;
    let maxDrawdown = 0;
    const totalDays = allCalendarDates.length || 1;
    let dayCount = 0;
    let lastProgressAt = 0;

    for (const currentDate of allCalendarDates) {
      if (isCancelled()) return { ok: false, cancelled: true, messages: this.messages };
      dayCount++;
      if (dayCount % 25 === 0) await yieldLoop();
      if (dayCount % Math.max(1, Math.round(totalDays / 20)) === 0 || dayCount === totalDays) {
        onProgress({ percent: Math.min(100, Math.round((dayCount / totalDays) * 100)), date: currentDate, openPositions: this.openPositions.length, trades: this.closedTrades.length });
      }
      // ── PASSO 1: Gerir posições abertas no dia ──────────────
      const remaining = [];
      for (const pos of this.openPositions) {
        const idx = lookup.get(pos.ticker).get(String(currentDate));
        if (idx === undefined) { // não negociou hoje → mantém e congela preço
          remaining.push(pos);
          continue;
        }
        const candle = pos.candles[idx];
        pos.daysHeld += 1;
        const isLong = pos.side !== 'SHORT';
        if (this.mfeMaEEnabled) {
          const fav = isLong
            ? ((candle.high - pos.entryPrice) / pos.entryPrice) * 100
            : ((pos.entryPrice - candle.low) / pos.entryPrice) * 100;
          const adv = isLong
            ? ((candle.low - pos.entryPrice) / pos.entryPrice) * 100
            : ((pos.entryPrice - candle.high) / pos.entryPrice) * 100;
          pos.mfe = Math.max(pos.mfe, fav);
          pos.mae = Math.min(pos.mae, adv);
        }

        let isClosed = false, exitPrice = 0, exitReason = '';
        if (isLong) {
          if (candle.high >= pos.tpPrice) { exitPrice = pos.tpPrice; exitReason = 'TAKE_PROFIT'; isClosed = true; }
          else if (candle.low <= pos.slPrice) { exitPrice = pos.slPrice; exitReason = 'STOP_LOSS'; isClosed = true; }
        } else {
          // SHORT: TP abaixo do preço de entrada, SL acima (espelhado do LONG)
          if (candle.low <= pos.tpPrice) { exitPrice = pos.tpPrice; exitReason = 'TAKE_PROFIT'; isClosed = true; }
          else if (candle.high >= pos.slPrice) { exitPrice = pos.slPrice; exitReason = 'STOP_LOSS'; isClosed = true; }
        }
        if (!isClosed && pos.daysHeld >= this.horizonDays) {
          exitPrice = candle.close; exitReason = 'EXPIRED_HORIZON'; isClosed = true;
        }

        if (isClosed) {
          const sign = pos.side === 'SHORT' ? -1 : 1;
          const pnlPct = ((exitPrice - pos.entryPrice) / pos.entryPrice) * sign;
          const pnlEur = pos.investedAmount * pnlPct;
          this.cash += (pos.investedAmount + pnlEur); // devolve capital + PnL
          this.closedTrades.push({
            ticker: pos.ticker, name: pos.name, side: pos.side,
            entryDate: pos.entryDate, entryPrice: round2(pos.entryPrice),
            exitDate: currentDate, exitPrice: round2(exitPrice),
            reason: exitReason, exitReason,
            daysHeld: pos.daysHeld, durationDays: pos.daysHeld,
            investedAmount: round2(pos.investedAmount),
            profit: round2(pnlEur), pnlEur: round2(pnlEur),
            profitPct: round1(pnlPct * 100), pnlPct: round1(pnlPct * 100),
            winRateMC: round1(pos.mcWinRate), mcWinRate: round1(pos.mcWinRate),
            mcTier: pos.mcTier,
            mfePct: round1(pos.mfe || 0), maePct: round1(pos.mae || 0),
            shares: pos.shares
          });
          openByTicker.delete(pos.ticker);
        } else {
          pos.currentPrice = candle.close;
          remaining.push(pos);
        }
      }
      this.openPositions = remaining;

      // ── PASSO 2: Equity mark-to-market ──────────────────────
      let openValue = 0;
      for (const pos of this.openPositions) {
        const rawRet = (pos.currentPrice - pos.entryPrice) / pos.entryPrice;
        const ret = pos.side === 'SHORT' ? -rawRet : rawRet;
        openValue += pos.investedAmount * (1 + ret);
      }
      const totalEquity = this.cash + openValue;
      if (totalEquity > peakEquity) peakEquity = totalEquity;
      const dd = peakEquity > 0 ? ((peakEquity - totalEquity) / peakEquity) * 100 : 0;
      if (dd > maxDrawdown) maxDrawdown = dd;
      this.dailyEquityCurve.push({
        date: currentDate, equity: round2(totalEquity), value: round2(totalEquity),
        cash: round2(this.cash), invested: round2(openValue),
        openPositionsCount: this.openPositions.length, drawdown: round1(dd)
      });

      // ── PASSO 3: Procura novas entradas (se houver vagas) ───
      const availableSlots = this.maxPositions - this.openPositions.length;
      const targetSlotCapital = totalEquity * this.positionAllocationPct;
      if (availableSlots > 0 && this.cash >= this.minOrderCapital) {
        const candidates = [];
        for (const e of entries) {
          if (openByTicker.has(e.ticker)) continue; // já detido
          const idx = lookup.get(e.ticker).get(String(currentDate));
          if (idx === undefined || idx < this.warmup) continue; // warm-up 200 velas
          const ev = this.evaluateAssetGatekeepers(e.candles.slice(0, idx + 1), quantEngine, e.ticker);
          if (ev && ev.approved) {
            candidates.push({ ticker: e.ticker, name: e.name, candle: e.candles[idx], idx, candles: e.candles, evaluation: ev });
          }
        }
        // Desempate: maior probabilidade de acerto no Monte Carlo
        candidates.sort((a, b) => b.evaluation.winRateMC - a.evaluation.winRateMC);
        const toOpen = candidates.slice(0, availableSlots);
        for (const cand of toOpen) {
          const side = cand.evaluation.side === 'SHORT' ? 'SHORT' : 'LONG';
          // Sem execução silenciosamente errada: respeita a direção configurada
          // mesmo quando o gatekeeper é fornecido externamente (ex.: testes).
          if (side === 'SHORT' && this.direction === 'long') continue;
          if (side === 'LONG' && this.direction === 'short') continue;
          const allocation = Math.min(targetSlotCapital, this.cash);
          if (allocation < this.minOrderCapital) break; // sem liquidez mínima → aborta a entrada
          this.cash -= allocation;
          const entryPrice = cand.candle.close;
          const pos = {
            ticker: cand.ticker, name: cand.name, side,
            candles: cand.candles,
            entryDate: currentDate, entryPrice, currentPrice: entryPrice,
            investedAmount: allocation,
            shares: allocation / entryPrice,
            slPrice: side === 'SHORT' ? entryPrice * (1 + this.stopLossPct) : entryPrice * (1 - this.stopLossPct),
            tpPrice: side === 'SHORT' ? entryPrice * (1 - this.takeProfitPct) : entryPrice * (1 + this.takeProfitPct),
            daysHeld: 0, mfe: 0, mae: 0,
            mcWinRate: cand.evaluation.winRateMC, mcTier: cand.evaluation.mcTier
          };
          this.openPositions.push(pos);
          openByTicker.set(cand.ticker, pos);
        }
      }
    }

    // Fecho de posições ainda abertas no último dia (liberta capital)
    if (this.openPositions.length) {
      const lastDate = allCalendarDates.length ? allCalendarDates[allCalendarDates.length - 1] : null;
      for (const pos of this.openPositions) {
        const exitPrice = pos.currentPrice;
        const sign = pos.side === 'SHORT' ? -1 : 1;
        const pnlPct = ((exitPrice - pos.entryPrice) / pos.entryPrice) * sign;
        const pnlEur = pos.investedAmount * pnlPct;
        this.cash += (pos.investedAmount + pnlEur);
        this.closedTrades.push({
          ticker: pos.ticker, name: pos.name, side: pos.side,
          entryDate: pos.entryDate, entryPrice: round2(pos.entryPrice),
          exitDate: lastDate, exitPrice: round2(exitPrice),
          reason: 'FIM_PERIODO', exitReason: 'FIM_PERIODO',
          daysHeld: pos.daysHeld, durationDays: pos.daysHeld,
          investedAmount: round2(pos.investedAmount),
          profit: round2(pnlEur), pnlEur: round2(pnlEur),
          profitPct: round1(pnlPct * 100), pnlPct: round1(pnlPct * 100),
          winRateMC: round1(pos.mcWinRate), mcWinRate: round1(pos.mcWinRate), mcTier: pos.mcTier,
          mfePct: round1(pos.mfe || 0), maePct: round1(pos.mae || 0), shares: pos.shares
        });
      }
      this.openPositions = [];
      // recalcular equity final = cash
      const last = this.dailyEquityCurve[this.dailyEquityCurve.length - 1];
      if (last) { last.equity = round2(this.cash); last.value = round2(this.cash); last.openPositionsCount = 0; last.invested = 0; }
    }

    return this.compileResults(maxDrawdown);
  }

  _normalizeUniverse(candlesByTicker) {
    let list = [];
    if (candlesByTicker instanceof Map) list = Array.from(candlesByTicker.entries()).map(([t, c]) => ({ ticker: t, candles: c }));
    else if (Array.isArray(candlesByTicker)) list = candlesByTicker.map(u => ({ ticker: u.ticker, name: u.name, candles: u.candles }));
    else if (candlesByTicker && typeof candlesByTicker === 'object') list = Object.entries(candlesByTicker).map(([t, c]) => ({ ticker: t, candles: c }));
    return list
      .map(e => ({
        ticker: e.ticker, name: e.name || e.ticker,
        candles: (e.candles || [])
          .filter(c => c && c.close != null && Number.isFinite(Number(c.close)))
          .map(c => ({ date: String(c.date).slice(0, 10), open: Number(c.open), high: Number(c.high), low: Number(c.low), close: Number(c.close), volume: Number(c.volume) || 0 }))
          .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
      }))
      .filter(e => e.candles.length > 0);
  }

  // Gatekeepers: VWAP(20) → Markov (direção COMPRA) → Monte Carlo.
  evaluateAssetGatekeepers(slice, quantEngine) {
    const result = analyzeSeries(slice, {
      markovWindow: this.markovWindow, useVolFilter: false, horizonDays: this.horizonDays,
      markovOrder: 1, stateSpace: '9'
    });
    if (!result || result.close == null) return null;
    if (this.direction === 'long' && result.direction !== 'COMPRA') return null;
    if (this.direction === 'both' && result.direction !== 'COMPRA' && result.direction !== 'VENDA') return null;
    if (this.direction === 'short' && result.direction !== 'VENDA') return null;
    if (this.minMarkovPct > 0) {
      if (result.direction === 'COMPRA' && result.pBull * 100 < this.minMarkovPct) return null;
      if (result.direction === 'VENDA' && result.pBear * 100 < this.minMarkovPct) return null;
    }
    // Gatekeeper VWAP(20)
    if (result.rollingVwap20 != null) {
      if (result.direction === 'COMPRA' && result.close <= result.rollingVwap20) return null;
      if (result.direction === 'VENDA' && result.close >= result.rollingVwap20) return null;
    }
    if (!result.transitionMatrix || result.currentState < 0) return null;

    const side = result.direction === 'COMPRA' ? 'LONG' : 'SHORT';
    const mc = runMarkovMonteCarloSimulation(result.transitionMatrix, result.currentState, slice, result.close, {
      iterations: this.mcIterations, daysAhead: this.horizonDays,
      slPct: this.stopLossPct, tpPct: this.takeProfitPct, side,
      order: 1, prevState: result.prevState, stateSpace: '9',
      seed: this.mcSeed
    });
    if (!mc) return null;
    const winRateMC = mc.winRateMC != null ? mc.winRateMC : mc.winRate;
    if (winRateMC >= this.minMCWinRate) {
      const tier = classifyMCTier(winRateMC);
      return { approved: true, winRateMC, mcTier: tier.mcTier, side };
    }
    return null;
  }

  compileResults(maxDrawdown) {
    const wins = this.closedTrades.filter(t => t.pnlEur > 0);
    const losses = this.closedTrades.filter(t => t.pnlEur <= 0);
    const totalProfit = wins.reduce((s, t) => s + t.pnlEur, 0);
    const totalLoss = Math.abs(losses.reduce((s, t) => s + t.pnlEur, 0));
    const finalEquity = this.dailyEquityCurve.length ? this.dailyEquityCurve[this.dailyEquityCurve.length - 1].equity : this.initialCapital;

    return {
      ok: true,
      cancelled: false,
      engine: 'portfolio',
      initialCapital: round2(this.initialCapital),
      finalCapital: round2(finalEquity),
      netProfitEur: round2(finalEquity - this.initialCapital),
      netProfitPct: round1(((finalEquity - this.initialCapital) / this.initialCapital) * 100),
      totalTrades: this.closedTrades.length,
      winRate: this.closedTrades.length ? round1((wins.length / this.closedTrades.length) * 100) : 0,
      profitFactor: totalLoss > 0 ? round2(totalProfit / totalLoss) : (totalProfit > 0 ? 99.9 : 0),
      maxDrawdownPct: round1(maxDrawdown),
      positionAllocationPct: this.positionAllocationPct,
      maxPositions: this.maxPositions,
      stopLossPct: this.stopLossPct * 100,
      takeProfitPct: this.takeProfitPct * 100,
      horizonDays: this.horizonDays,
      minMCWinRate: this.minMCWinRate,
      equityCurve: this.dailyEquityCurve,
      trades: this.closedTrades,
      messages: this.messages
    };
  }
}

module.exports = { PortfolioBacktester, runPortfolioSimulation, SLOT_DEFINITIONS, maxPositionsForSlot };

// ═══════════════════════════════════════════════════════════
//  runPortfolioSimulation — wrapper usado pelo worker
//  Compila calendário unificado, corre o PortfolioBacktester e
//  enriquece o resultado com os 5 blocos analíticos (A–E).
// ═══════════════════════════════════════════════════════════
async function runPortfolioSimulation(options = {}) {
  const universe = Array.isArray(options.universe) ? options.universe : [];
  const params = options.params || {};
  const hooks = options.hooks || {};
  const quantEngine = options.quantEngine;

  const slotKey = params.slotSize != null ? String(params.slotSize) : null;
  const preset = (slotKey && SLOT_DEFINITIONS[slotKey]) ? SLOT_DEFINITIONS[slotKey] : null;
  const config = {
    initialCapital: params.initialCapital ?? params.capital,
    slotSize: slotKey,
    maxPositions: params.maxPositions != null ? Number(params.maxPositions) : (preset ? preset.maxPositions : undefined),
    positionAllocationPct: params.positionAllocationPct != null ? Number(params.positionAllocationPct) : (preset ? preset.slotPct : undefined),
    stopLoss: params.stopLoss != null ? params.stopLoss : 2.4,
    takeProfit: params.takeProfit != null ? params.takeProfit : 4.8,
    horizonDays: params.horizonDays != null ? params.horizonDays : 35,
    minMCWinRate: params.minMCWinRate != null ? params.minMCWinRate : (params.convictionTier === 'elite' ? 65 : 50),
    direction: params.direction || 'long',
    markovWindow: params.markovWindow,
    warmup: params.warmup,
    mcIterations: params.mcIterations,
    commission: params.commissionPct ?? params.commission,
    slippage: params.slippagePct ?? params.slippage,
    riskPerTradePct: params.riskPerTradePct ?? params.risk,
    mcSeed: params.mcSeed != null ? Number(params.mcSeed) : 42
  };

  // Calendário unificado (ASC) a partir das velas de todos os ativos
  const candlesByTicker = new Map();
  const dateSet = new Set();
  const start = String(params.startDate || '').slice(0, 10);
  const end = String(params.endDate || '').slice(0, 10);
  for (const u of universe) {
    const cs = (u.candles || [])
      .filter(c => c && Number.isFinite(Number(c.close)))
      .map(c => ({ date: String(c.date).slice(0, 10), open: Number(c.open), high: Number(c.high), low: Number(c.low), close: Number(c.close), volume: Number(c.volume) || 0 }))
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    if (!cs.length) continue;
    // Mantém histórico completo (inclui warm-up). O calendário de simulação
    // (datas geridas/avaliadas) restringe-se a [start,end].
    candlesByTicker.set(u.ticker, cs);
    for (const c of cs) if ((!start || c.date >= start) && (!end || c.date <= end)) dateSet.add(c.date);
  }
  const allCalendarDates = Array.from(dateSet).sort();

  const bt = new PortfolioBacktester(config);
  const result = await bt.run(candlesByTicker, allCalendarDates, quantEngine, hooks);
  if (result.cancelled) return result;

  // ── Enriquecimento: 5 blocos ─────────────────────────────
  const globalKpis = metrics.computeGlobalKPIs({
    trades: result.trades, equityCurve: result.equityCurve,
    initialCapital: result.initialCapital, startDate: start, endDate: end
  });
  const drawdownSeries = metrics.drawdownSeries(result.equityCurve, result.initialCapital);
  const yearlyMatrix = metrics.buildYearlyMatrix({ equityCurve: result.equityCurve, trades: result.trades });
  const calibrationTiers = metrics.buildCalibrationTiers(result.trades);
  const returns = metrics.dailyReturnsFromEquity(result.equityCurve);
  const cpcvReport = validation.validateStrategy(returns, { nGroups: 5, kTestGroups: 2, nTrials: candlesByTicker.size || 10 });
  const benchmark = buildBuyAndHold(candlesByTicker, allCalendarDates, result.initialCapital);

  result.ok = true;
  result.globalKpis = globalKpis;
  result.kpis = {
    ...globalKpis,
    rentabilidadePct: globalKpis.netProfitPct, winRateReal: globalKpis.winRate,
    maxDrawdown: globalKpis.maxDrawdownPct
  };
  result.yearlyMatrix = yearlyMatrix;
  result.calibrationTiers = calibrationTiers;
  result.risk = { var95: globalKpis.var95, cvar95: globalKpis.cvar95 };
  result.validation = cpcvReport;
  result.drawdownSeries = drawdownSeries;
  result.benchmark = benchmark;
  result.equityCurve = result.equityCurve.map(p => ({ date: p.date, value: p.equity }));
  result.summary = {
    title: `Carteira Multi-Ativo — ${config.positionAllocationPct * 100}% × ${config.maxPositions} slots (${allCalendarDates[0] ? allCalendarDates[0].slice(0, 4) : ''} a ${allCalendarDates[allCalendarDates.length - 1] ? allCalendarDates[allCalendarDates.length - 1].slice(0, 4) : ''})`,
    startDate: allCalendarDates[0], endDate: allCalendarDates[allCalendarDates.length - 1]
  };
  result.meta = {
    engine: 'portfolio', universe: candlesByTicker.size, days: allCalendarDates.length,
    maxPositions: config.maxPositions, positionAllocationPct: config.positionAllocationPct,
    stopLossPct: config.stopLoss, takeProfitPct: config.takeProfit, horizonDays: config.horizonDays,
    minMCWinRate: config.minMCWinRate
  };
  return result;
}

function buildBuyAndHold(candlesByTicker, allCalendarDates, initialCapital) {
  const valid = Array.from(candlesByTicker.entries())
    .map(([t, cs]) => { const fc = cs[0].close; return { t, cs, fc: fc > 0 ? fc : null }; })
    .filter(v => v.fc);
  if (!valid.length) return [];
  const per = initialCapital / valid.length;
  const ptrs = new Map(valid.map(v => [v.t, 0]));
  const dateIdx = new Map(valid.map(v => [v.t, new Map(v.cs.map((c, i) => [c.date, i]))]));
  const out = [];
  for (const date of allCalendarDates) {
    let value = 0;
    for (const v of valid) {
      const idx = dateIdx.get(v.t).get(date);
      const p = idx != null ? idx : ptrs.get(v.t);
      ptrs.set(v.t, p);
      value += per * (v.cs[p].close / v.fc);
    }
    out.push({ date, value: Math.round(value * 100) / 100 });
  }
  return out;
}
