const pLimit = require('p-limit');
const { fetchWithRetry } = require('../data/yahooClient');
const { analyzeSeries, shouldEmit } = require('../quant/markovEngine');

const CONCURRENCY = 5;
const TARGET_GROUP_GAIN_MIN = 0.02;
const TARGET_GROUP_GAIN_MAX = 0.03;
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

  async run(options, runId, hooks) {
    const startedAt = Date.now();
    const list = Array.isArray(options?.tickers) ? options.tickers : [];

    if (list.length > 0 && !this.cancelled.has(runId)) {
      try {
        await this._evaluateTrades(runId, hooks);
      } catch (err) {
        hooks.onError({ ticker: '_evaluation', message: err.message || String(err), runId });
      }
    }

    const dbParams = this.db.getAdaptiveParams();
    const params = {
      edge_threshold: options?.edge_threshold ?? options?.edgeThreshold ?? dbParams.edge_threshold,
      markov_window: options?.markov_window ?? options?.markovWindow ?? dbParams.markov_window,
      volume_mult: options?.volume_mult ?? options?.volumeMult ?? dbParams.volume_mult,
      horizon_days: options?.horizon_days ?? options?.horizonDays ?? dbParams.horizon_days
    };
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
        let candles = this.db.getCachedOHLCV(t.ticker);
        if (!candles) {
          candles = await fetchWithRetry(t.ticker, 3);
          this.db.cacheOHLCV(t.ticker, candles);
        }
        const result = analyzeSeries(candles, {
          markovWindow: params.markov_window,
          volumeMult: params.volume_mult,
          horizonDays: params.horizon_days,
          edgeThreshold: params.edge_threshold
        });
        if (shouldEmit(result, params.edge_threshold)) {
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
            pStay: result.pStay,
            volumeValid: result.volumeValid,
            date: result.date,
            close: result.close,
            atr: result.atr,
            stopLoss: result.stopLoss,
            takeProfit: result.takeProfit
          });
        }
      } catch (err) {
        hooks.onError({ ticker: t.ticker, message: err.message || String(err), runId });
      }
    }));

    await Promise.all(tasks);

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
      if (candle.low <= trade.stop_loss) {
        return { exit: trade.stop_loss, reason: 'stop_loss' };
      }
      if (candle.high >= trade.take_profit) {
        return { exit: trade.take_profit, reason: 'take_profit' };
      }
    } else if (trade.direcao === 'VENDA') {
      if (candle.high >= trade.stop_loss) {
        return { exit: trade.stop_loss, reason: 'stop_loss' };
      }
      if (candle.low <= trade.take_profit) {
        return { exit: trade.take_profit, reason: 'take_profit' };
      }
    }
    return null;
  }

  _calcResultado(trade, exitPrice) {
    const sign = trade.direcao === 'COMPRA' ? 1 : -1;
    return ((exitPrice - trade.preco_entrada) / trade.preco_entrada) * sign;
  }

  async _evaluateTrades(runId, hooks) {
    const open = this.db.getOpenTrades();
    if (open.length === 0) return;

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
      const entryDate = trade.date;

      let closed = null;
      for (const c of candles) {
        if (c.date <= entryDate) continue;
        const hit = this._evaluateTradeHit(trade, c);
        if (hit) {
          closed = { ...hit, candle: c };
          break;
        }
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
  }

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

  async runBacktest(options, runId) {
    const { tickers, startDate, endDate } = options;
    const dbParams = this.db.getAdaptiveParams();
    const params = {
      edge_threshold: options.edge_threshold ?? options.edgeThreshold ?? dbParams.edge_threshold,
      markov_window: options.markov_window ?? options.markovWindow ?? dbParams.markov_window,
      volume_mult: options.volume_mult ?? options.volumeMult ?? dbParams.volume_mult,
      horizon_days: options.horizon_days ?? options.horizonDays ?? dbParams.horizon_days
    };
    const markovWindow = params.markov_window;
    const edgeThreshold = params.edge_threshold;
    const volumeMult = params.volume_mult;
    const horizonDays = params.horizon_days;

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
          edgeThreshold
        });

        if (shouldEmit(result, edgeThreshold)) {
          const entryPrice = result.close;
          const stopLoss = result.stopLoss;
          const takeProfit = result.takeProfit;
          const direction = result.direction;

          let exitPrice = null;
          let exitDate = null;
          let reason = 'horizonte';

          const maxExitIndex = Math.min(candles.length - 1, i + horizonDays);
          for (let j = i + 1; j <= maxExitIndex; j++) {
            const nextCandle = candles[j];
            if (direction === 'COMPRA') {
              if (nextCandle.low <= stopLoss) {
                exitPrice = stopLoss;
                exitDate = nextCandle.date;
                reason = 'stop_loss';
                break;
              }
              if (nextCandle.high >= takeProfit) {
                exitPrice = takeProfit;
                exitDate = nextCandle.date;
                reason = 'take_profit';
                break;
              }
            } else if (direction === 'VENDA') {
              if (nextCandle.high >= stopLoss) {
                exitPrice = stopLoss;
                exitDate = nextCandle.date;
                reason = 'stop_loss';
                break;
              }
              if (nextCandle.low <= takeProfit) {
                exitPrice = takeProfit;
                exitDate = nextCandle.date;
                reason = 'take_profit';
                break;
              }
            }
          }

          if (exitPrice === null && i + 1 < candles.length) {
            const finalIndex = Math.min(candles.length - 1, i + horizonDays);
            const finalCandle = candles[finalIndex];
            exitPrice = finalCandle.close;
            exitDate = finalCandle.date;
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
      if (currentEquity > peakEquity) {
        peakEquity = currentEquity;
      }
      const dd = (peakEquity - currentEquity) / peakEquity;
      if (dd > maxDrawdown) {
        maxDrawdown = dd;
      }
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
