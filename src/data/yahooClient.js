const yahooFinance = require('yahoo-finance2').default || require('yahoo-finance2');

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const MIN_CANDLES = 200;
const WARMUP_TARGET = 250;

const sleep = ms => new Promise(res => setTimeout(res, ms));

function isNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function sanitizeCandle(r) {
  if (!r) return null;
  const open = isNum(r.open) ? r.open : null;
  const high = isNum(r.high) ? r.high : null;
  const low = isNum(r.low) ? r.low : null;
  const adjClose = isNum(r.adjustedClose) ? r.adjustedClose : null;
  const close = isNum(r.close) ? r.close : adjClose;
  const volume = isNum(r.volume) ? r.volume : 0;

  const hasAnyPrice = open !== null || high !== null || low !== null || close !== null;
  if (!hasAnyPrice) return null;

  let finalOpen = open;
  let finalHigh = high;
  let finalLow = low;
  let finalClose = close;

  if (finalClose === null && finalOpen !== null) {
    finalClose = finalOpen;
  } else if (finalClose === null && finalHigh !== null) {
    finalClose = finalHigh;
  } else if (finalClose === null && finalLow !== null) {
    finalClose = finalLow;
  }

  if (finalClose === null) return null;

  if (finalOpen === null) finalOpen = finalClose;
  if (finalHigh === null) finalHigh = Math.max(finalOpen, finalClose);
  if (finalLow === null) finalLow = Math.min(finalOpen, finalClose);

  if (finalHigh < Math.max(finalOpen, finalClose)) {
    finalHigh = Math.max(finalOpen, finalClose);
  }
  if (finalLow > Math.min(finalOpen, finalClose)) {
    finalLow = Math.min(finalOpen, finalClose);
  }

  return {
    ticker: r.ticker,
    date: r.date instanceof Date ? r.date.toISOString().slice(0, 10) : String(r.date).slice(0, 10),
    open: finalOpen,
    high: finalHigh,
    low: finalLow,
    close: adjClose !== null ? adjClose : finalClose,
    volume
  };
}

function sanitizeSeries(rawCandles, ticker) {
  if (!Array.isArray(rawCandles) || rawCandles.length === 0) return [];

  const enriched = rawCandles.map(r => ({ ...r, ticker }));
  const cleaned = enriched.map(sanitizeCandle).filter(Boolean);

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
  const period2 = new Date();
  for (let i = 0; i < attempts; i++) {
    try {
      await sleep(1500 + Math.random() * 1000);
      const result = await yahooFinance.historical(
        ticker,
        {
          period1,
          period2,
          interval: '1d',
          includeAdjustedClose: true
        },
        {
          fetchOptions: {
            headers: {
              'User-Agent': USER_AGENT
            }
          }
        }
      );

      if (!Array.isArray(result) || result.length === 0) {
        throw new Error(`No candles returned for ${ticker}`);
      }

      const candles = sanitizeSeries(result, ticker);

      if (candles.length < MIN_CANDLES) {
        const droppedNull = result.length - candles.length;
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
          headers: {
            'User-Agent': USER_AGENT
          }
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
