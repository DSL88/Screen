const yahooFinance = require('yahoo-finance2').default;

yahooFinance.setGlobalConfig({
  queue: {
    concurrency: 1,
    timeout: 60
  }
});

try {
  yahooFinance._opts.fetchOptions = {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    }
  };
} catch (_) { }

try {
  if (typeof yahooFinance.suppressNotices === 'function') {
    yahooFinance.suppressNotices(['yahooSurvey', 'ripHistorical']);
  }
} catch (_) { }

const sleep = ms => new Promise(res => setTimeout(res, ms));

function isValidCandle(c) {
  return c && Number.isFinite(c.open) && Number.isFinite(c.high)
    && Number.isFinite(c.low) && Number.isFinite(c.close)
    && Number.isFinite(c.volume);
}

async function fetchWithRetry(ticker, attempts = 3) {
  const period1 = new Date();
  period1.setDate(period1.getDate() - 365);
  const period2 = new Date();
  for (let i = 0; i < attempts; i++) {
    try {
      await sleep(1500 + Math.random() * 1000);
      const result = await yahooFinance.historical(ticker, {
        period1,
        period2,
        interval: '1d',
        includeAdjustedClose: true
      });
      if (!Array.isArray(result) || result.length < 200) {
        throw new Error(`Insufficient candles for ${ticker}: ${result?.length || 0}`);
      }
      const candles = result
        .filter(isValidCandle)
        .map(r => ({
          ticker,
          date: r.date instanceof Date ? r.date.toISOString().slice(0, 10) : String(r.date).slice(0, 10),
          open: r.open,
          high: r.high,
          low: r.low,
          close: r.adjustedClose ?? r.close,
          volume: r.volume
        }));
      if (candles.length < 200) {
        throw new Error(`Not enough valid candles for ${ticker}: ${candles.length}`);
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
    const result = await yahooFinance.search(q, {
      quotesCount: limit,
      newsCount: 0,
      listsCount: 0,
      quotesQueryId: undefined
    });
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
