const yahooFinance = require('yahoo-finance2').default || require('yahoo-finance2');
yahooFinance.defaults.options.validation = { logErrors: false };

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

  return deduped;
}

async function fetchWithRetry(ticker, attempts = 3) {
  const period1 = new Date();
  period1.setDate(period1.getDate() - 365);

  for (let i = 0; i < attempts; i++) {
    try {
      await sleep(1500 + Math.random() * 1000);

      const result = await yahooFinance.chart(
        ticker,
        { period1, interval: '1d' },
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

async function searchTickers(query, limit = 8) {
  if (!query || typeof query !== 'string' || query.trim().length < 1) return [];
  const q = query.trim();
  try {
    const result = await yahooFinance.search(
      q,
      {
        quotesCount: limit,
        newsCount: 0,
        listsCount: 0,
        quotesQueryId: undefined
      },
      {
        fetchOptions: {
          headers: { 'User-Agent': USER_AGENT }
        }
      }
    );
    const quotes = (result && result.quotes) || [];
    const out = [];
    const seen = new Set();
    for (const item of quotes) {
      const symbol = item.symbol;
      if (!symbol) continue;
      if (!/^[A-Z0-9.\-^=]{1,20}$/.test(symbol)) continue;
      const type = item.quoteType || '';
      if (type && !['EQUITY', 'ETF', 'INDEX', 'MUTUALFUND'].includes(type)) continue;
      if (seen.has(symbol)) continue;
      seen.add(symbol);
      out.push({
        ticker: symbol,
        name: item.shortname || item.longname || symbol,
        exchange: item.exchange || item.exchDisp || '',
        type
      });
      if (out.length >= limit) break;
    }
    return out;
  } catch (_err) {
    return [];
  }
}

module.exports = { fetchWithRetry, searchTickers };
