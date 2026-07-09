const yahooFinance = require('yahoo-finance2').default || require('yahoo-finance2');
const tickerLists = require('./tickerLists');

// Suprimir avisos de validação de esquema no terminal
const yfConfig = yahooFinance._opts;
if (yfConfig?.validation) {
  yfConfig.validation.logErrors = false;
  yfConfig.validation.logOptionsErrors = false;
}

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const MIN_CANDLES = 200;
const WARMUP_TARGET = 250;

const sleep = ms => new Promise(res => setTimeout(res, ms));

function isNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function processQuote(q, ticker) {
  if (!q) return null;

  const date = q.date instanceof Date ? q.date.toISOString().slice(0, 10) : String(q.date).slice(0, 10);
  if (!date || date.length < 8) return null;

  const open = isNum(q.open) ? q.open : null;
  const high = isNum(q.high) ? q.high : null;
  const low = isNum(q.low) ? q.low : null;
  const adjClose = isNum(q.adjclose) ? q.adjclose : null;
  const rawClose = isNum(q.close) ? q.close : null;
  const volume = isNum(q.volume) ? q.volume : 0;

  let close = adjClose !== null ? adjClose : rawClose;

  if (close === null && open !== null) {
    close = open;
  } else if (close === null && high !== null) {
    close = high;
  } else if (close === null && low !== null) {
    close = low;
  }

  if (close === null) return null;

  let finalOpen = open !== null ? open : close;
  let finalHigh = high !== null ? high : Math.max(finalOpen, close);
  let finalLow = low !== null ? low : Math.min(finalOpen, close);

  if (finalHigh < Math.max(finalOpen, close)) {
    finalHigh = Math.max(finalOpen, close);
  }
  if (finalLow > Math.min(finalOpen, close)) {
    finalLow = Math.min(finalOpen, close);
  }

  return {
    ticker,
    date,
    open: finalOpen,
    high: finalHigh,
    low: finalLow,
    close,
    volume
  };
}

function processQuotes(quotes, ticker) {
  if (!Array.isArray(quotes) || quotes.length === 0) return [];

  const cleaned = quotes.map(q => processQuote(q, ticker)).filter(Boolean);

  const seen = new Set();
  const deduped = [];
  for (const c of cleaned) {
    if (!c.date || seen.has(c.date)) continue;
    seen.add(c.date);
    deduped.push(c);
  }

  deduped.sort((a, b) => a.date.localeCompare(b.date));

  // ── FILTRO DE INTEGRIDADE ──────────────────────────────────
  // Remove velas diárias incompletas (close nulo) ou com volume
  // nulo (corrompidas / em formação) ANTES de qualquer gravação
  // na cache SQLite. Isto garante que o ohlcv_cache nunca é
  // poluído com dados inválidos.
  if (deduped.length > 0) {
    const last = deduped[deduped.length - 1];
    if (last.close == null || last.volume <= 0) {
      deduped.pop();
    }
  }

  return deduped;
}

async function fetchWithRetry(ticker, timeframe = '1d', attempts = 3) {
  const period1 = new Date();

  if (timeframe === '1wk') {
    period1.setDate(period1.getDate() - (365 * 5));
  } else if (timeframe === '1h' || timeframe === '4h') {
    period1.setDate(period1.getDate() - 180);
  } else {
    period1.setDate(period1.getDate() - (365 * 1.5));
  }

  for (let i = 0; i < attempts; i++) {
    try {
      await sleep(1500 + Math.random() * 1000);

      const result = await yahooFinance.chart(
        ticker,
        { period1, interval: timeframe },
        {
          fetchOptions: {
            headers: { 'User-Agent': USER_AGENT }
          }
        }
      );

      const quotes = result && result.quotes;
      if (!Array.isArray(quotes) || quotes.length === 0) {
        throw new Error(`No candles returned for ${ticker}`);
      }

      const candles = processQuotes(quotes, ticker);

      if (candles.length < MIN_CANDLES) {
        const droppedNull = quotes.length - candles.length;
        const warn = `[yahooClient] AVISO: ${ticker} produziu apenas ${candles.length} velas válidas ` +
          `(${droppedNull} removidas por nulos). Warm-up incompleto (mínimo ${MIN_CANDLES}).`;
        if (candles.length === 0) {
          throw new Error(`All candles null/empty for ${ticker} após sanitização`);
        }
        console.warn(warn);
        if (candles.length < WARMUP_TARGET) {
          console.warn(`[yahooClient] ${ticker}: série abaixo do warm-up ideal (${WARMUP_TARGET}). A usar ${candles.length} velas.`);
        }
      }

      return candles;
    } catch (err) {
      const code = err && err.code;
      const isRateLimit = code === 429 || /rate|429|too many/i.test(String(err.message || ''));
      if (i === attempts - 1) {
        if (isRateLimit) {
          throw new Error('Yahoo Finance Rate Limit (429): Demasiados pedidos. Por favor, aguarde alguns minutos.');
        }
        throw err;
      }
      if (isRateLimit) {
        await sleep(5000);
      } else {
        const backoff = 500 * Math.pow(2, i);
        const jitter = Math.floor(Math.random() * 250);
        await sleep(backoff + jitter);
      }
    }
  }
}

function getBulkIndexTickers(queryOrTicker) {
  const q = String(queryOrTicker || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  if (['portugal', 'psi', '^psi20', 'psi20'].includes(q)) {
    const list = tickerLists.PSI || [];
    return {
      id: 'PSI',
      name: 'Índice PSI (Portugal) - Inclui todas as ações portuguesas',
      tickers: list.map(item => ({
        ticker: item.ticker,
        name: item.name,
        exchange: 'LIS',
        type: 'EQUITY'
      }))
    };
  }
  if (['franca', 'frança', 'cac40', 'cac 40', '^fchi', 'fchi'].includes(q)) {
    const list = tickerLists.CAC40 || [];
    return {
      id: 'CAC40',
      name: 'Índice CAC 40 (França) - Inclui todas as ações francesas',
      tickers: list.map(item => ({
        ticker: item.ticker,
        name: item.name,
        exchange: 'PAR',
        type: 'EQUITY'
      }))
    };
  }
  if (['espanha', 'ibex', 'ibex35', 'ibex 35', '^ibex', 'ibex-35'].includes(q)) {
    const list = tickerLists.IBEX35 || [];
    return {
      id: 'IBEX35',
      name: 'Índice IBEX 35 (Espanha) - Inclui todas as ações espanholas',
      tickers: list.map(item => ({
        ticker: item.ticker,
        name: item.name,
        exchange: 'MC',
        type: 'EQUITY'
      }))
    };
  }
  return null;
}

async function searchTickers(query, limit = 8) {
  if (!query || typeof query !== 'string' || query.trim().length < 1) return [];
  const q = query.trim();

  const bulkMatch = getBulkIndexTickers(q);
  const out = [];
  const seen = new Set();

  if (bulkMatch) {
    const bulkItem = {
      ticker: `BULK:${bulkMatch.id}`,
      name: bulkMatch.name,
      exchange: bulkMatch.tickers[0]?.exchange || '',
      type: 'INDEX'
    };
    out.push(bulkItem);
    seen.add(bulkItem.ticker);
  }

  const attempts = 3;
  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    // Pequeno delay para evitar rate-limit
    await sleep(800 + Math.random() * 700);

    try {
      const result = await yahooFinance.search(
        q,
        { quotesCount: limit, newsCount: 0 },
        { fetchOptions: { headers: { 'User-Agent': USER_AGENT } } }
      );

      const quotes = (result && result.quotes) || [];
      for (const item of quotes) {
        if (!item || item.isYahooFinance === false) continue;
        const symbol = item.symbol;
        if (!symbol) continue;
        if (!/^\^?[A-Z0-9.\-=]{1,20}$/i.test(symbol)) continue;
        
        const quoteType = item.quoteType;
        const typeUpper = typeof quoteType === 'string' ? quoteType.toUpperCase() : '';
        const allowedTypes = ['EQUITY', 'ETF', 'INDEX', 'CURRENCY', 'CRYPTOCURRENCY'];
        
        let isTypeValid = false;
        if (quoteType) {
          isTypeValid = allowedTypes.includes(typeUpper);
        } else if (symbol.startsWith('^')) {
          isTypeValid = true;
        }
        
        if (!isTypeValid) continue;
        
        if (seen.has(symbol)) continue;
        seen.add(symbol);
        
        out.push({
          ticker: item.symbol,
          name: item.shortname || item.longname || item.symbol,
          exchange: item.exchange || '',
          type: item.quoteType
        });
        if (out.length >= limit) break;
      }
      return out;
    } catch (err) {
      lastErr = err;
      const msg = err && err.message ? err.message : String(err);
      const isRateLimit = /429|Too Many|Rate/i.test(msg);
      if (i === attempts - 1) break;
      if (isRateLimit) {
        await sleep(3000 + Math.random() * 2000);
      } else {
        await sleep(500 * Math.pow(2, i));
      }
    }
  }

  const msg = lastErr && lastErr.message ? lastErr.message : String(lastErr);
  if (/429|Too Many|Rate/i.test(msg)) {
    throw new Error('Yahoo Finance rate limit (429). Aguarde uns segundos antes de pesquisar novamente.');
  }
  throw new Error('Falha na pesquisa Yahoo: ' + msg);
}

module.exports = { fetchWithRetry, searchTickers, getBulkIndexTickers };
