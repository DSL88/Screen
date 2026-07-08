// ─────────────────────────────────────────────────────────────
//  scanner.js  –  Motor de varrimento
//
//  1. UI tem PRIORIDADE ABSOLUTA sobre parâmetros do SQLite
//  2. console.log() detalhado por ticker para auditoria
//  3. Filtro de volume respeita override da UI
// ─────────────────────────────────────────────────────────────

'use strict';

const pLimit = require('p-limit');
const { fetchWithRetry } = require('../data/yahooClient');
const { analyzeSeries, shouldEmit } = require('../quant/markovEngine');

const CONCURRENCY = 5;
const ADAPTIVE_WINDOW = 50;
const EDGE_MIN = 0.10;
const EDGE_MAX = 0.30;
const WINDOW_MIN = 100;
const WINDOW_MAX = 200;

class Scanner {
  constructor(db) {
    this.db = db;
    this.cancelled = new Set();
  }

  cancel(runId) {
    if (runId) this.cancelled.add(runId);
  }

  // ═══════════════════════════════════════════════════════════
  //  Resolução de parâmetros
  //
  //  PRIORIDADE ABSOLUTA: valores da UI > valores do SQLite.
  //  A UI pode enviar snake_case ou camelCase — ambos aceites.
  //  Se a UI não enviar um valor (undefined), usa o do SQLite.
  // ═══════════════════════════════════════════════════════════
  _resolveParams(uiParams) {
    const dbParams = this.db.getAdaptiveParams();

    // Extrair valores da UI (aceitar ambos os formatos)
    const uiEdge = uiParams?.edge_threshold ?? uiParams?.edgeThreshold;
    const uiWindow = uiParams?.markov_window ?? uiParams?.markovWindow;
    const uiVolume = uiParams?.volume_mult ?? uiParams?.volumeMult;
    const uiHorizon = uiParams?.horizon_days ?? uiParams?.horizonDays;
    const uiUseVolFilter = uiParams?.useVolFilter;
    const uiUseLatestClosed = uiParams?.useLatestClosed ?? uiParams?.use_latest_closed;

    return {
      edge_threshold: uiEdge != null ? Number(uiEdge) : Number(dbParams.edge_threshold),
      markov_window: uiWindow != null ? Number(uiWindow) : Number(dbParams.markov_window),
      volume_mult: uiVolume != null ? Number(uiVolume) : Number(dbParams.volume_mult),
      horizon_days: uiHorizon != null ? Number(uiHorizon) : Number(dbParams.horizon_days),
      // Se a UI enviar useVolFilter=false, respeitar. Se não enviar, default=true.
      useVolFilter: uiUseVolFilter !== undefined ? Boolean(uiUseVolFilter) : true,
      // Forçar análise com base na última vela fechada (ignora vela de hoje em aberto)
      useLatestClosed: uiUseLatestClosed === true
    };
  }

  // ═══════════════════════════════════════════════════════════
  //  RUN – Varrimento principal
  // ═══════════════════════════════════════════════════════════
  async run(options, runId, hooks) {
    const startedAt = Date.now();
    const list = Array.isArray(options?.tickers) ? options.tickers : [];

    // Avaliar trades abertos antes do scan
    if (list.length > 0 && !this.cancelled.has(runId)) {
      try {
        await this._evaluateTrades(runId, hooks);
      } catch (err) {
        hooks.onError({ ticker: '_evaluation', message: err.message || String(err), runId });
      }
    }

    // ── PRIORIDADE ABSOLUTA: UI > SQLite ────────────────────
    const params = this._resolveParams(options);

    console.log('');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('  SCANNER INICIADO');
    console.log(`  Edge ≥ ${params.edge_threshold} | VolMult ≥ ${params.volume_mult} | Window ${params.markov_window} | Horizon ${params.horizon_days}d | VolFilter: ${params.useVolFilter ? 'ON' : 'OFF'}`);
    console.log(`  Tickers a processar: ${list.length}`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    const total = list.length;
    const limit = pLimit(CONCURRENCY);
    let processed = 0;
    let emitted = 0;
    const newSignalIds = [];

    hooks.onProgress({ processed: 0, total, runId });

    const tasks = list.map(t => limit(async () => {
      if (this.cancelled.has(runId)) return;
      processed++;
      hooks.onProgress({ processed, total, currentTicker: t.ticker, runId });

      try {
        // ── Obter candles ─────────────────────────────────────
        let candles = this.db.getCachedOHLCV(t.ticker);
        if (!candles) {
          candles = await fetchWithRetry(t.ticker, 3);
          this.db.cacheOHLCV(t.ticker, candles);
        }

        if (!candles || candles.length < 60) {
          console.log(`  [${String(processed).padStart(4)}/${total}] ${(t.ticker || '???').padEnd(10)} SKIP: insuficientes candles (${candles?.length || 0})`);
          return;
        }

        // ── Descartar última vela se ainda incompleta ────────
        const analysisCandles = this._pickAnalysisCandles(candles, params);
        if (!analysisCandles || analysisCandles.length < 60) {
          console.log(`  [${String(processed).padStart(4)}/${total}] ${(t.ticker || '???').padEnd(10)} SKIP: velas fechadas insuficientes (${analysisCandles?.length || 0})`);
          return;
        }
        const dropped = candles.length - analysisCandles.length;

        // ── Análise (baseada na última vela fechada) ─────────
        const result = analyzeSeries(analysisCandles, {
          markovWindow: params.markov_window,
          volumeMult: params.volume_mult,
          horizonDays: params.horizon_days,
          useVolFilter: params.useVolFilter
        });

        // ── LOG DETALHADO POR TICKER ──────────────────────────
        // Ticker | Preço | BB% | ADX | RSI | Estado | Edge | Vol Válido | Direção Final
        const emit = shouldEmit(result, params.edge_threshold, params.useVolFilter);
        console.log(
          `  [${String(processed).padStart(4)}/${total}] ` +
          `${(t.ticker || '???').padEnd(10)} ` +
          `Preço: ${result.close != null ? result.close.toFixed(2).padStart(9) : '     N/A'}  ` +
          `BB%: ${result.bbPct != null ? result.bbPct.toFixed(3) : 'N/A  '}  ` +
          `ADX: ${result.adx != null ? result.adx.toFixed(1).padStart(5) : '  N/A'}  ` +
          `RSI: ${result.rsi != null ? result.rsi.toFixed(1).padStart(5) : '  N/A'}  ` +
          `Estado: ${result.currentState >= 0 ? result.currentState : '-'}  ` +
          `Edge: ${result.edge.toFixed(4)}  ` +
          `Vol: ${result.volumeValid ? '✓' : '✗'}  ` +
          `Dir: ${result.direction.padEnd(6)}  ` +
          `${dropped > 0 ? `[última vela descartada] ` : ''}` +
          `${emit ? '→ SINAL ✓' : ''}`
        );

        // ── Emissão de sinal ──────────────────────────────────
        if (emit) {
          const id = this.db.insertSignal({
            ticker: t.ticker,
            date: result.date,
            preco_entrada: result.close,
            direcao: result.direction,
            edge: result.edge,
            p_stay: result.pStay,
            atr_14: result.atr,
            stop_loss: result.stopLoss,
            take_profit: result.takeProfit
          });
          newSignalIds.push(id);
          emitted++;
          hooks.onRow({
            id,
            ticker: t.ticker,
            name: t.name,
            index: t.index,
            direction: result.direction,
            edge: result.edge,
            pBull: result.pBull,
            pBear: result.pBear,
            pStay: result.pStay,
            rsi: result.rsi,
            adx: result.adx,
            bbPct: result.bbPct,
            volumeValid: result.volumeValid,
            date: result.date,
            close: result.close,
            atr: result.atr,
            stopLoss: result.stopLoss,
            takeProfit: result.takeProfit,
            currentState: result.currentState
          });
        }
      } catch (err) {
        console.log(`  [${String(processed).padStart(4)}/${total}] ${(t.ticker || '???').padEnd(10)} ERRO: ${err.message || err}`);
        hooks.onError({ ticker: t.ticker, message: err.message || String(err), runId });
      }
    }));

    await Promise.all(tasks);

    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`  CONCLUÍDO: ${processed} processados | ${emitted} sinais emitidos | ${(Date.now() - startedAt)}ms`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    if (newSignalIds.length > 0 && !this.cancelled.has(runId)) {
      this._tuneAdaptiveParams();
    }

    hooks.onDone({
      runId,
      totalSignals: emitted,
      totalProcessed: processed,
      elapsedMs: Date.now() - startedAt
    });
  }

  // ═══════════════════════════════════════════════════════════
  //  Helpers internos
  // ═══════════════════════════════════════════════════════════

  // ── Última vela fechada completa ────────────────────────────
  //  O Yahoo Finance devolve sempre a vela do dia corrente (mesmo
  //  com o mercado aberto), com volume e preço ainda incompletos.
  //  Esta função decide se a última vela deve ser descartada, de
  //  modo a que o motor analise apenas a ÚLTIMA VELA FECHADA
  //  consolidate (candles.length - 2 no original).
  //
  //  Critérios para descartar a última vela:
  //    1. useLatestClosed=true (override manual da UI)
  //    2. Dia da semana e a vela é a de hoje (mercado aberto)
  //    3. Volume da última vela abaixo da média móvel recente
  // ──────────────────────────────────────────────────────────
  _pickAnalysisCandles(candles, params) {
    if (!candles || candles.length < 2) return candles;

    const last = candles[candles.length - 1];
    const force = params && params.useLatestClosed === true;

    // (2) Hoje em dia útil → vela em formação
    const now = new Date();
    const dow = now.getDay();
    const isWeekday = dow >= 1 && dow <= 5;
    const today = now.toISOString().slice(0, 10);
    const lastIsToday = last && last.date === today;
    const marketOpen = isWeekday && lastIsToday;

    // (3) Volume da última vela abaixo da média móvel recente
    let lowVolume = false;
    if (last && Number.isFinite(last.volume)) {
      const n = Math.min(20, candles.length - 1);
      let sum = 0, count = 0;
      for (let i = candles.length - 1 - n; i < candles.length - 1; i++) {
        const v = candles[i] && candles[i].volume;
        if (Number.isFinite(v)) { sum += v; count++; }
      }
      if (count > 0) {
        const avg = sum / count;
        const thr = avg * ((params && params.volume_mult) || 1.0);
        if (avg > 0 && last.volume < thr) lowVolume = true;
      }
    }

    if (force || marketOpen || lowVolume) {
      return candles.slice(0, candles.length - 1);
    }
    return candles;
  }

  async _getCandlesSince(ticker, sinceDate) {
    let candles = this.db.getCachedOHLCV(ticker);
    if (!candles) {
      try {
        candles = await fetchWithRetry(ticker, 3);
        this.db.cacheOHLCV(ticker, candles);
      } catch (_) {
        return null;
      }
    }
    if (!sinceDate) return candles;
    return candles.filter(c => c.date > sinceDate);
  }

  _evaluateTradeHit(trade, candle) {
    if (trade.stop_loss == null || trade.take_profit == null) return null;
    if (trade.direcao === 'COMPRA') {
      if (candle.low <= trade.stop_loss) return { exit: trade.stop_loss, reason: 'stop_loss' };
      if (candle.high >= trade.take_profit) return { exit: trade.take_profit, reason: 'take_profit' };
    } else if (trade.direcao === 'VENDA') {
      if (candle.high >= trade.stop_loss) return { exit: trade.stop_loss, reason: 'stop_loss' };
      if (candle.low <= trade.take_profit) return { exit: trade.take_profit, reason: 'take_profit' };
    }
    return null;
  }

  _calcResultado(trade, exitPrice) {
    const sign = trade.direcao === 'COMPRA' ? 1 : -1;
    return ((exitPrice - trade.preco_entrada) / trade.preco_entrada) * sign;
  }

  async _evaluateTrades(runId, hooks) {
    let open;
    try {
      open = this.db.getOpenTrades();
    } catch (err) {
      console.warn(`[scanner] _evaluateTrades: DB indisponível (${err && err.message ? err.message : err}). A continuar o scan normalmente.`);
      return;
    }
    if (!Array.isArray(open) || open.length === 0) return;

    try {
      const tickersToFetch = [...new Set(open.map(t => t.ticker))];
      const candleCache = {};
      for (const ticker of tickersToFetch) {
        if (this.cancelled.has(runId)) return;
        candleCache[ticker] = await this._getCandlesSince(ticker, null);
      }

      let slHit = 0, tpHit = 0;
      for (const trade of open) {
        if (this.cancelled.has(runId)) return;
        if (trade.resultado_pct != null) continue;
        const candles = candleCache[trade.ticker];
        if (!candles || candles.length === 0) continue;

        let closed = null;
        for (const c of candles) {
          if (c.date <= trade.date) continue;
          const hit = this._evaluateTradeHit(trade, c);
          if (hit) { closed = { ...hit, candle: c }; break; }
        }

        if (closed) {
          const resultado = this._calcResultado(trade, closed.exit);
          this.db.closeTrade(trade.id, resultado, closed.reason);
          if (closed.reason === 'stop_loss') slHit++;
          else tpHit++;
        }
      }

      if (slHit > 0 || tpHit > 0) {
        hooks.onProgress({
          processed: 0, total: 0, runId,
          message: `Avaliação: ${tpHit} TP, ${slHit} SL`
        });
      }
    } catch (err) {
      console.warn(`[scanner] _evaluateTrades: falha parcial na avaliação de trades abertos (${err && err.message ? err.message : err}). A continuar o scan normalmente.`);
    }
  }

  // ═══════════════════════════════════════════════════════════
  //  Auto-tuning adaptativo
  // ═══════════════════════════════════════════════════════════
  _tuneAdaptiveParams() {
    const closed = this.db.getClosedTrades(ADAPTIVE_WINDOW);
    if (closed.length < ADAPTIVE_WINDOW) return;

    const sorted = [...closed].sort((a, b) => a.edge - b.edge);
    const quartiles = [[], [], [], []];
    sorted.forEach((t, i) => quartiles[Math.min(3, Math.floor(i / sorted.length * 4))].push(t));

    let bestQ = 0;
    let bestExpectancy = -Infinity;
    quartiles.forEach((bucket, idx) => {
      if (bucket.length === 0) return;
      const wins = bucket.filter(t => (t.resultado_pct || 0) > 0).length;
      const avg = bucket.reduce((a, t) => a + (t.resultado_pct || 0), 0) / bucket.length;
      const winRate = wins / bucket.length;
      const expectancy = winRate * avg - (1 - winRate) * Math.abs(avg);
      if (expectancy > bestExpectancy) {
        bestExpectancy = expectancy;
        bestQ = idx;
      }
    });

    const current = this.db.getAdaptiveParams();
    const step = 0.02;
    const targetEdge = bestQ === 0
      ? current.edge_threshold - step
      : bestQ === 3
        ? current.edge_threshold + step
        : current.edge_threshold;
    const newEdge = Math.max(EDGE_MIN, Math.min(EDGE_MAX, targetEdge));
    if (newEdge !== current.edge_threshold) {
      this.db.setAdaptiveParam('edge_threshold', newEdge);
    }

    const newWindow = bestQ === 3
      ? Math.min(WINDOW_MAX, current.markov_window + 10)
      : bestQ === 0
        ? Math.max(WINDOW_MIN, current.markov_window - 10)
        : current.markov_window;
    if (newWindow !== current.markov_window) {
      this.db.setAdaptiveParam('markov_window', newWindow);
    }
  }

  // ═══════════════════════════════════════════════════════════
  //  BACKTEST
  // ═══════════════════════════════════════════════════════════
  async runBacktest(options, runId) {
    const { tickers, startDate, endDate } = options;
    const params = this._resolveParams(options);
    const markovWindow = params.markov_window;
    const edgeThreshold = params.edge_threshold;
    const volumeMult = params.volume_mult;
    const horizonDays = params.horizon_days;
    const useVolFilter = params.useVolFilter;

    const list = Array.isArray(tickers) ? tickers : [];
    const simulatedTrades = [];

    for (const t of list) {
      if (this.cancelled.has(runId)) break;

      let candles = this.db.getCachedOHLCV(t.ticker);
      if (!candles) {
        try {
          candles = await fetchWithRetry(t.ticker, 3);
          this.db.cacheOHLCV(t.ticker, candles);
        } catch (_) {
          continue;
        }
      }

      if (!candles || candles.length < markovWindow + 20) continue;

      for (let i = markovWindow + 20; i < candles.length; i++) {
        const currentCandle = candles[i];
        if (currentCandle.date < startDate) continue;
        if (currentCandle.date > endDate) break;

        const slice = candles.slice(0, i + 1);
        const result = analyzeSeries(slice, {
          markovWindow,
          volumeMult,
          horizonDays,
          useVolFilter
        });

        if (shouldEmit(result, edgeThreshold, useVolFilter)) {
          const entryPrice = result.close;
          const stopLoss = result.stopLoss;
          const takeProfit = result.takeProfit;
          const direction = result.direction;

          let exitPrice = null;
          let exitDate = null;
          let reason = 'horizonte';

          const maxExitIndex = Math.min(candles.length - 1, i + horizonDays);
          for (let j = i + 1; j <= maxExitIndex; j++) {
            const nc = candles[j];
            if (direction === 'COMPRA') {
              if (nc.low <= stopLoss) { exitPrice = stopLoss; exitDate = nc.date; reason = 'stop_loss'; break; }
              if (nc.high >= takeProfit) { exitPrice = takeProfit; exitDate = nc.date; reason = 'take_profit'; break; }
            } else if (direction === 'VENDA') {
              if (nc.high >= stopLoss) { exitPrice = stopLoss; exitDate = nc.date; reason = 'stop_loss'; break; }
              if (nc.low <= takeProfit) { exitPrice = takeProfit; exitDate = nc.date; reason = 'take_profit'; break; }
            }
          }

          if (exitPrice === null && i + 1 < candles.length) {
            const fi = Math.min(candles.length - 1, i + horizonDays);
            exitPrice = candles[fi].close;
            exitDate = candles[fi].date;
            reason = 'horizonte';
          }

          if (exitPrice !== null) {
            const sign = direction === 'COMPRA' ? 1 : -1;
            const profitPct = ((exitPrice - entryPrice) / entryPrice) * sign;
            simulatedTrades.push({
              ticker: t.ticker,
              name: t.name || t.ticker,
              entryDate: currentCandle.date,
              entryPrice,
              direction,
              exitDate,
              exitPrice,
              profitPct,
              reason
            });
          }
        }
      }
    }

    const totalTrades = simulatedTrades.length;
    const wins = simulatedTrades.filter(tr => tr.profitPct > 0);
    const losses = simulatedTrades.filter(tr => tr.profitPct <= 0);
    const winRate = totalTrades > 0 ? wins.length / totalTrades : 0;

    let totalProfit = 0;
    let avgWin = 0;
    let avgLoss = 0;
    if (totalTrades > 0) {
      totalProfit = simulatedTrades.reduce((acc, tr) => acc + tr.profitPct, 0);
      const winSum = wins.reduce((acc, tr) => acc + tr.profitPct, 0);
      const lossSum = losses.reduce((acc, tr) => acc + tr.profitPct, 0);
      avgWin = wins.length > 0 ? winSum / wins.length : 0;
      avgLoss = losses.length > 0 ? lossSum / losses.length : 0;
    }

    const expectancy = winRate * avgWin - (1 - winRate) * Math.abs(avgLoss);

    let currentEquity = 100;
    let peakEquity = 100;
    let maxDrawdown = 0;
    const equityCurve = [100];

    const sortedTrades = [...simulatedTrades].sort((a, b) => a.entryDate.localeCompare(b.entryDate));
    for (const tr of sortedTrades) {
      currentEquity = currentEquity * (1 + tr.profitPct);
      equityCurve.push(currentEquity);
      if (currentEquity > peakEquity) peakEquity = currentEquity;
      const dd = (peakEquity - currentEquity) / peakEquity;
      if (dd > maxDrawdown) maxDrawdown = dd;
    }

    let sharpeRatio = 0;
    if (totalTrades > 1) {
      const avgReturn = totalProfit / totalTrades;
      const variance = simulatedTrades.reduce((acc, tr) => acc + Math.pow(tr.profitPct - avgReturn, 2), 0) / (totalTrades - 1);
      const stdDev = Math.sqrt(variance);
      sharpeRatio = stdDev > 0 ? (avgReturn / stdDev) * Math.sqrt(252 / horizonDays) : 0;
    }

    return {
      totalTrades,
      winRate,
      expectancy,
      sharpeRatio,
      maxDrawdown,
      netReturn: currentEquity - 100,
      trades: sortedTrades.map(tr => ({
        ...tr,
        profitPctFormatted: (tr.profitPct * 100).toFixed(2) + '%'
      }))
    };
  }
}

module.exports = Scanner;
