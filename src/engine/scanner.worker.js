// ─────────────────────────────────────────────────────────────
//  scanner.worker.js  –  Worker Thread para operações pesadas
//
//  Recebe comandos do processo principal via parentPort,
//  executa fetching + análise Markov, e devolve resultados.
//  TODA a acesso a DB fica no processo principal.
// ─────────────────────────────────────────────────────────────

'use strict';

const { parentPort } = require('worker_threads');
const pLimit = require('p-limit');
const { fetchWithRetry } = require('../data/yahooClient');
const { analyzeSeries, shouldEmit } = require('../quant/markovEngine');

const CONCURRENCY = 5;
const MIN_CANDLES_WARMUP = 200;
const cancelRequested = new Set();

// ═══════════════════════════════════════════════════════════
//  DB Request-Response — Comunicação com Main Process
// ══════════════════════════════════════════════════════════

const dbRequests = new Map();
let dbSeq = 0;

function requestDB(type, payload) {
  return new Promise((resolve, reject) => {
    const requestId = `db_${++dbSeq}_${Date.now()}`;
    dbRequests.set(requestId, { resolve, reject });
    
    parentPort.postMessage({
      type,
      requestId,
      payload
    });
    
    // Timeout de segurança
    setTimeout(() => {
      if (dbRequests.has(requestId)) {
        dbRequests.delete(requestId);
        reject(new Error('DB request timeout'));
      }
    }, 30000);
  });
}

parentPort.on('message', async (msg) => {
  // Respostas do DB vindas do main process
  if (msg.type === 'dbResponse') {
    const req = dbRequests.get(msg.requestId);
    if (req) {
      dbRequests.delete(msg.requestId);
      if (msg.ok) {
        req.resolve(msg.data);
      } else {
        req.reject(new Error(msg.error || 'DB error'));
      }
    }
    return;
  }
  
  try {
    switch (msg.action) {
      case 'scan':
        await handleScan(msg);
        break;
      case 'backtest':
        await handleBacktest(msg);
        break;
      case 'updateTrades':
        await handleUpdateTrades(msg);
        break;
      case 'cancel':
        if (msg.runId) cancelRequested.add(msg.runId);
        break;
    }
  } catch (err) {
    send({ type: 'error', payload: { ticker: '_worker', message: err.message || String(err), runId: msg.runId } });
  }
});

// ═══════════════════════════════════════════════════════════
//  Helpers puros (extraídos do Scanner, sem dependência DB)
// ═══════════════════════════════════════════════════════════

function pickAnalysisCandles(candles, params) {
  if (!candles || candles.length < 2) return candles;

  const last = candles[candles.length - 1];
  const force = params && params.useLatestClosed === true;

  const now = new Date();
  const dow = now.getDay();
  const isWeekday = dow >= 1 && dow <= 5;
  const today = now.toISOString().slice(0, 10);
  const lastIsToday = last && last.date === today;
  const marketOpen = isWeekday && lastIsToday;

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

function calcDistancia(trade, currentPrice) {
  if (!currentPrice || currentPrice <= 0) return { distancia_stop_pct: null, distancia_tp_pct: null };
  const distStop = Math.abs(currentPrice - trade.stop_loss) / currentPrice * 100;
  const distTp = Math.abs(currentPrice - trade.take_profit) / currentPrice * 100;
  return { distancia_stop_pct: distStop, distancia_tp_pct: distTp };
}

function classifyPosition(trade, currentPrice, currentDirection) {
  if (currentPrice == null) return 'manter';
  const ALERT_THRESHOLD_PCT = 1.5;

  const { distancia_stop_pct, distancia_tp_pct } = calcDistancia(trade, currentPrice);

  if (currentDirection && currentDirection !== 'NEUTRO' && currentDirection !== trade.direcao) {
    return 'alerta_inversao';
  }
  if (distancia_stop_pct != null && distancia_stop_pct < ALERT_THRESHOLD_PCT) return 'alerta_stop';
  if (distancia_tp_pct != null && distancia_tp_pct < ALERT_THRESHOLD_PCT) return 'alerta_tp';
  return 'manter';
}

// ══════════════════════════════════════════════════════════
//  SCAN — Varrimento principal
// ═══════════════════════════════════════════════════════════

// ── Helper: Obter candles com cache inteligente ────────────
//  1. Verifica cache local (historical_prices)
//  2. Se vazio ou desatualizado, faz fetch apenas do delta
//  3. Guarda novas velas na BD
//  4. Retorna série completa para análise
async function getCandlesWithCache(ticker, timeframe) {
  try {
    // Passo 1: Verificar última data guardada localmente
    let lastStoredDate = null;
    try {
      lastStoredDate = await requestDB('getLastStoredDate', { ticker });
    } catch (err) {
      console.warn(`[Scanner] ${ticker}: Falha ao consultar cache local - ${err.message}`);
    }

    if (lastStoredDate) {
      // Dados locais existem → fetch incremental desde a última data
      // O INSERT OR REPLACE reescreve a última vela e adiciona as novas
      console.log(`[Scanner] ${ticker}: Dados locais até ${lastStoredDate} → fetch incremental`);
      send({ type: 'sync-status', payload: { ticker, status: 'syncing', lastDate: lastStoredDate } });

      try {
        const period1 = new Date(lastStoredDate);
        const newCandles = await fetchWithRetry(ticker, timeframe, 3, period1);

        if (newCandles && newCandles.length > 0) {
          // Guardar na tabela permanente
          await requestDB('saveHistoricalCandles', { candles: newCandles });
          // Guardar também no cache temporário para compatibilidade
          send({ type: 'cacheOHLCV', payload: { key: `${ticker}_${timeframe}`, candles: newCandles } });
          console.log(`[Scanner] ${ticker}: +${newCandles.length} velas sincronizadas`);
          send({ type: 'sync-status', payload: { ticker, status: 'downloaded-new', newDataCount: newCandles.length, lastDate: lastStoredDate } });
        } else {
          console.log(`[Scanner] ${ticker}: Sem dados novos`);
          send({ type: 'sync-status', payload: { ticker, status: 'up-to-date', lastDate: lastStoredDate } });
        }
      } catch (err) {
        console.warn(`[Scanner] ${ticker}: Falha no fetch incremental: ${err.message}. A usar dados locais.`);
        send({ type: 'sync-status', payload: { ticker, status: 'up-to-date', lastDate: lastStoredDate, warning: true } });
      }

      // Carregar série consolidada da SQLite (sempre, mesmo se fetch falhou)
      const fullSeries = await requestDB('getLocalHistoricalPrices', { ticker });
      if (fullSeries && fullSeries.length > 0) {
        return fullSeries;
      }
    }

    // Sem dados locais → download completo (1.5 anos) e guardar como seed
    console.log(`[Scanner] ${ticker}: Sem dados locais → download completo`);
    send({ type: 'sync-status', payload: { ticker, status: 'syncing', lastDate: null } });

    try {
      const fullHistory = await fetchWithRetry(ticker, timeframe, 3);
      if (fullHistory && fullHistory.length > 0) {
        await requestDB('saveHistoricalCandles', { candles: fullHistory });
        send({ type: 'cacheOHLCV', payload: { key: `${ticker}_${timeframe}`, candles: fullHistory } });
        console.log(`[Scanner] ${ticker}: ${fullHistory.length} velas guardadas (seed inicial)`);
        send({ type: 'sync-status', payload: { ticker, status: 'downloaded-new', newDataCount: fullHistory.length, lastDate: null } });
      }
      return fullHistory;
    } catch (err) {
      console.error(`[Scanner] ${ticker}: Sem dados locais e API falhou: ${err.message}`);
      throw new Error(`Sem dados locais e falha na API: ${err.message}`);
    }
  } catch (err) {
    console.error(`[Scanner] ${ticker}: Erro crítico - ${err.message}`);
    throw err;
  }
}

async function handleScan({ runId, tickers, params, timeframe }) {
  const startedAt = Date.now();
  const list = Array.isArray(tickers) ? tickers : [];
  const limit = pLimit(CONCURRENCY);
  let processed = 0;
  let emitted = 0;
  const signalsToSend = [];

  // Mínimo dinâmico: markovWindow + margem para warm-up dos indicadores
  const minCandles = Math.max(MIN_CANDLES_WARMUP, (params.markov_window || 150) + 60);

  send({ type: 'progress', payload: { processed: 0, total: list.length, runId } });

  const tasks = list.map(t => limit(async () => {
    if (cancelRequested.has(runId)) return;
    processed++;
    send({ type: 'progress', payload: { processed, total: list.length, currentTicker: t.ticker, runId } });

    try {
      let candles;
      try {
        console.log(`[Scanner] ${t.ticker}: A obter dados com cache inteligente...`);
        candles = await getCandlesWithCache(t.ticker, timeframe);
        console.log(`[Scanner] ${t.ticker}: ${candles?.length || 0} velas disponíveis para análise`);
        send({ type: 'cacheOHLCV', payload: { key: `${t.ticker}_${timeframe}`, candles } });
      } catch (e) {
        const errorMsg = e.message || String(e);
        console.error(`[Scanner] ${t.ticker}: Falha ao obter dados - ${errorMsg}`);
        
        // Detetar tipo de erro para mensagem mais específica
        let detailedMessage = `Falha ao obter dados: ${errorMsg}`;
        if (errorMsg.includes('No data found') || errorMsg.includes('No candles returned')) {
          detailedMessage = `Símbolo não encontrado ou delistado: ${t.ticker}. Verificar se o símbolo está correto.`;
        } else if (errorMsg.includes('Rate Limit') || errorMsg.includes('429')) {
          detailedMessage = `Rate limit do Yahoo Finance. Aguardar antes de tentar novamente.`;
        } else if (errorMsg.includes('null/empty')) {
          detailedMessage = `Dados corrompidos ou incompletos para ${t.ticker}.`;
        }
        
        send({ type: 'error', payload: { ticker: t.ticker, message: detailedMessage, runId } });
        candles = null;
      }

      // ─ Validação rigorosa: mínimo de velas para warm-up ─────
      if (!candles || candles.length < minCandles) {
        const candleCount = candles?.length || 0;
        console.warn(`[Scanner] ${t.ticker}: Dados insuficientes - ${candleCount} velas (mínimo: ${minCandles})`);
        
        let detailedMessage = `Dados insuficientes: ${candleCount} velas (mínimo: ${minCandles})`;
        if (candleCount === 0) {
          detailedMessage = `Nenhuma vela disponível para ${t.ticker}. O símbolo pode estar delistado ou a API falhou.`;
        } else if (candleCount < 60) {
          detailedMessage = `Muito poucas velas (${candleCount}) para ${t.ticker}. Necessário mínimo ${minCandles} para análise Markov.`;
        }
        
        send({ type: 'error', payload: {
          ticker: t.ticker,
          message: detailedMessage,
          runId
        }});
        return;
      }

      const analysisCandles = pickAnalysisCandles(candles, params);
      if (!analysisCandles || analysisCandles.length < minCandles) {
        const count = analysisCandles?.length || 0;
        console.warn(`[Scanner] ${t.ticker}: Velas fechadas insuficientes - ${count} (mínimo: ${minCandles})`);
        
        send({ type: 'error', payload: {
          ticker: t.ticker,
          message: `Velas fechadas insuficientes: ${count} (mínimo: ${minCandles}). Algumas velas foram descartadas por estarem em formação.`,
          runId
        }});
        return;
      }

      const result = analyzeSeries(analysisCandles, {
        markovWindow: params.markov_window,
        volumeMult: params.volume_mult,
        horizonDays: params.horizon_days,
        useVolFilter: params.useVolFilter
      });

      const emit = shouldEmit(result, params.edge_threshold, params.useVolFilter);

      if (emit) {
        // ── Guard clause: validar campos NOT NULL antes de enviar ──
        const pStay = result.pStay;
        const edge = result.edge;
        const precoEntrada = result.close;
        const atr14 = result.atr;
        const direcao = result.direction;

        if (pStay == null || !Number.isFinite(pStay)) {
          send({ type: 'error', payload: { ticker: t.ticker, message: `Sinal ignorado: pStay inválido (${pStay})`, runId } });
          return;
        }
        if (edge == null || !Number.isFinite(edge)) {
          send({ type: 'error', payload: { ticker: t.ticker, message: `Sinal ignorado: edge inválido (${edge})`, runId } });
          return;
        }
        if (precoEntrada == null || !Number.isFinite(precoEntrada) || precoEntrada <= 0) {
          send({ type: 'error', payload: { ticker: t.ticker, message: `Sinal ignorado: preço inválido (${precoEntrada})`, runId } });
          return;
        }
        if (!direcao || (direcao !== 'COMPRA' && direcao !== 'VENDA')) {
          send({ type: 'error', payload: { ticker: t.ticker, message: `Sinal ignorado: direção inválida (${direcao})`, runId } });
          return;
        }

        emitted++;
        signalsToSend.push({
          // ── Campos para DB (snake_case, alinhados com insertSignal) ──
          dbPayload: {
            ticker: t.ticker,
            date: result.date,
            preco_entrada: precoEntrada,
            direcao: direcao,
            edge: edge,
            p_stay: pStay,
            atr_14: atr14 ?? 0,
            stop_loss: result.stopLoss ?? null,
            take_profit: result.takeProfit ?? null
          },
          // ── Campos para renderer (camelCase) ──
          rendererPayload: {
            ticker: t.ticker,
            name: t.name,
            index: t.index,
            direction: direcao,
            edge: edge,
            pBull: result.pBull,
            pBear: result.pBear,
            pStay: pStay,
            rsi: result.rsi,
            adx: result.adx,
            bbPct: result.bbPct,
            volumeValid: result.volumeValid,
            date: result.date,
            close: precoEntrada,
            atr: atr14,
            stopLoss: result.stopLoss,
            takeProfit: result.takeProfit,
            currentState: result.currentState
          }
        });
      }
    } catch (err) {
      send({ type: 'error', payload: { ticker: t.ticker, message: err.message || String(err), runId } });
    }
  }));

  await Promise.all(tasks);

  // Estatísticas finais
  const failedCount = list.length - processed;
  const successRate = list.length > 0 ? ((processed - failedCount) / list.length * 100).toFixed(1) : 0;
  
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  SCAN CONCLUÍDO: ${processed}/${list.length} processados | ${emitted} sinais | ${failedCount} falhas (${successRate}% sucesso)`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  // Enviar sinais ao processo principal
  for (const s of signalsToSend) {
    send({ type: 'row', payload: { ...s.dbPayload, _renderer: s.rendererPayload, runId } });
  }

  const elapsedMs = Date.now() - startedAt;
  send({
    type: 'done',
    payload: {
      runId,
      totalSignals: emitted,
      totalProcessed: processed,
      elapsedMs,
      failedCount,
      successRate: parseFloat(successRate)
    }
  });
}

// ═══════════════════════════════════════════════════════════
//  BACKTEST
// ═══════════════════════════════════════════════════════════

async function handleBacktest({ requestId, tickers, params, timeframe, startDate, endDate, cachedCandles }) {
  const markovWindow = params.markov_window;
  const edgeThreshold = params.edge_threshold;
  const volumeMult = params.volume_mult;
  const horizonDays = params.horizon_days;
  const useVolFilter = params.useVolFilter;

  const list = Array.isArray(tickers) ? tickers : [];
  const simulatedTrades = [];
  const cacheUpdates = {};

  for (const t of list) {
    if (cancelRequested.has(requestId)) break;

    const cacheKey = `${t.ticker}_${timeframe}`;
    let candles = cachedCandles && cachedCandles[cacheKey] ? cachedCandles[cacheKey] : null;
    if (!candles) {
      try {
        candles = await fetchWithRetry(t.ticker, timeframe, 3);
        cacheUpdates[cacheKey] = candles;
        send({ type: 'cacheOHLCV', payload: { key: cacheKey, candles } });
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

  // Calcular estatísticas
  const totalTrades = simulatedTrades.length;
  const wins = simulatedTrades.filter(tr => tr.profitPct > 0);
  const losses = simulatedTrades.filter(tr => tr.profitPct <= 0);
  const winRate = totalTrades > 0 ? wins.length / totalTrades : 0;

  let totalProfit = 0, avgWin = 0, avgLoss = 0;
  if (totalTrades > 0) {
    totalProfit = simulatedTrades.reduce((acc, tr) => acc + tr.profitPct, 0);
    const winSum = wins.reduce((acc, tr) => acc + tr.profitPct, 0);
    const lossSum = losses.reduce((acc, tr) => acc + tr.profitPct, 0);
    avgWin = wins.length > 0 ? winSum / wins.length : 0;
    avgLoss = losses.length > 0 ? lossSum / losses.length : 0;
  }

  const expectancy = winRate * avgWin - (1 - winRate) * Math.abs(avgLoss);

  let currentEquity = 100, peakEquity = 100, maxDrawdown = 0;
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

  send({
    type: 'backtestResult',
    payload: {
      requestId,
      results: {
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
      }
    }
  });
}

// ═══════════════════════════════════════════════════════════
//  UPDATE TRADES — Monitorização de posições ativas
// ═══════════════════════════════════════════════════════════

async function handleUpdateTrades({ activeTrades }) {
  if (!Array.isArray(activeTrades) || activeTrades.length === 0) {
    send({ type: 'updateResult', payload: { updated: 0, closed: [], states: [], message: 'Nenhum trade ativo para monitorizar.' } });
    return;
  }

  const limit = pLimit(CONCURRENCY);
  const closed = [];
  const states = [];

  const tasks = activeTrades.map(trade => limit(async () => {
    try {
      const candles = await fetchWithRetry(trade.ticker, '1d', 2);
      if (!candles || candles.length === 0) return;

      const last = candles[candles.length - 1];
      let hit = null;

      if (trade.direcao === 'COMPRA') {
        if (last.low <= trade.stop_loss) {
          hit = { price: trade.stop_loss, reason: 'stop_loss' };
        } else if (last.high >= trade.take_profit) {
          hit = { price: trade.take_profit, reason: 'take_profit' };
        }
      } else if (trade.direcao === 'VENDA') {
        if (last.high >= trade.stop_loss) {
          hit = { price: trade.stop_loss, reason: 'stop_loss' };
        } else if (last.low <= trade.take_profit) {
          hit = { price: trade.take_profit, reason: 'take_profit' };
        }
      }

      if (hit) {
        const sign = trade.direcao === 'COMPRA' ? 1 : -1;
        const resultado = ((hit.price - trade.preco_entrada) / trade.preco_entrada) * sign;
        closed.push({
          id: trade.id,
          ticker: trade.ticker,
          nome: trade.nome,
          direcao: trade.direcao,
          preco_entrada: trade.preco_entrada,
          preco_fecho: hit.price,
          resultado_pct: resultado,
          motivo_fecho: hit.reason,
          data_lancamento: last.date,
          resultado,
          exitPrice: hit.price
        });
        return;
      }

      const { distancia_stop_pct, distancia_tp_pct } = calcDistancia(trade, last.close);

      let currentDirection = null;
      try {
        if (candles.length >= 60) {
          const result = analyzeSeries(candles, {
            markovWindow: 100,
            volumeMult: 1.0,
            horizonDays: 5,
            useVolFilter: false
          });
          currentDirection = result && result.direction ? result.direction : null;
        }
      } catch (_) {
        currentDirection = null;
      }

      const status = classifyPosition(trade, last.close, currentDirection);
      const resultadoAtual = trade.preco_entrada
        ? ((last.close - trade.preco_entrada) / trade.preco_entrada) * (trade.direcao === 'COMPRA' ? 1 : -1) * 100
        : null;

      states.push({
        id: trade.id,
        ticker: trade.ticker,
        nome: trade.nome,
        direcao: trade.direcao,
        preco_entrada: trade.preco_entrada,
        stop_loss: trade.stop_loss,
        take_profit: trade.take_profit,
        preco_atual: last.close,
        data_atual: last.date,
        status,
        distancia_stop_pct,
        distancia_tp_pct,
        current_direction: currentDirection,
        resultado_pct_atual: resultadoAtual
      });
    } catch (err) {
      console.warn(`[worker] updateTrades: erro ao processar ${trade.ticker}: ${err.message || err}`);
    }
  }));

  await Promise.all(tasks);

  const alerts = states.filter(s => s.status !== 'manter').length;
  send({
    type: 'updateResult',
    payload: {
      updated: closed.length,
      closed,
      states,
      message: closed.length > 0
        ? `${closed.length} trade(s) fechado(s)${alerts > 0 ? `, ${alerts} alerta(s) ativo(s).` : '.'}`
        : alerts > 0
          ? `Nenhum trade atingiu TP ou SL. ${alerts} alerta(s) de proximidade.`
          : 'Nenhum trade atingiu TP ou SL.'
    }
  });
}

// ═══════════════════════════════════════════════════════════
//  Mensageria
// ═══════════════════════════════════════════════════════════

function send(msg) {
  parentPort.postMessage(msg);
}
