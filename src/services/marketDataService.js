const axios = require('axios');

const USER_AGENT = 'MarkovStockScanner/1.0';
const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_RETRIES = 2;
const DEFAULT_BACKOFF_MS = 250;
const MAX_BACKOFF_MS = 2000;

// Yahoo uses the exchange suffixes below.  A class separator (BRK.B, BT.A,
// BF.B, ...) is deliberately not treated as an exchange suffix.
const EXCHANGE_SUFFIXES = new Set([
  'LS', 'DE', 'MC', 'PA', 'AS', 'MI', 'SW', 'L', 'ST', 'CO', 'HE', 'HK',
  'T', 'SA', 'TO', 'NS', 'BO', 'AX', 'OL', 'BR', 'VI', 'JK', 'KS', 'SS',
  'TA', 'MX', 'IR', 'IS', 'NZ', 'SG', 'US'
]);

const STOOQ_SUFFIXES = {
  LS: 'pt', L: 'uk', DE: 'de', MC: 'es', PA: 'fr', AS: 'nl', MI: 'it',
  SW: 'ch', ST: 'se', CO: 'dk', HE: 'fi', HK: 'hk', T: 'jp', SA: 'br',
  TO: 'ca', NS: 'in', BO: 'in', AX: 'au', OL: 'no', BR: 'be', VI: 'at',
  JK: 'id', KS: 'kr', SS: 'cn', TA: 'il', MX: 'mx', SG: 'sg'
};

const INDEX_TO_SUFFIX = {
  PSI: 'LS', DAX40: 'DE', IBEX35: 'MC', CAC40: 'PA', FTSE100: 'L',
  AEX25: 'AS', SMI: 'SW', BEL20: 'BR', OMXS30: 'ST', OMXC20: 'CO',
  FTSEMIB: 'MI', NIKKEI30: 'T', HANGSENG30: 'HK', BOVESPA: 'SA'
};

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function cleanTicker(value) {
  return String(value == null ? '' : value)
    .replace(/\[[^\]]+\]/g, '')
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/\s+/g, '')
    .replace(/\//g, '-')
    .trim()
    .toUpperCase();
}

/**
 * Convert a symbol to Yahoo's notation.
 *
 * Dots in a US/class symbol are separators, not exchanges (BRK.B -> BRK-B).
 * Dots in a known exchange-qualified symbol remain exchange separators
 * (VOW3.DE), and class dots before the exchange are converted too.
 */
function normalizeTicker(value, exchangeSuffix) {
  let ticker = cleanTicker(value);
  if (!ticker) return null;

  const requestedSuffix = exchangeSuffix
    ? (INDEX_TO_SUFFIX[String(exchangeSuffix).replace(/^\./, '').toUpperCase()] ||
      String(exchangeSuffix).replace(/^\./, '').toUpperCase())
    : null;
  const parts = ticker.split('.');
  const hasKnownSuffix = parts.length > 1 && EXCHANGE_SUFFIXES.has(parts[parts.length - 1]);
  const sourceSuffix = hasKnownSuffix ? parts.pop() : null;
  const suffix = requestedSuffix || sourceSuffix;

  // .US is commonly supplied by CSV/importers, but is not a Yahoo suffix.
  if (suffix === 'US') return parts.join('-').replace(/\./g, '-');

  let base = parts.join('-').replace(/\.+/g, '-');
  base = base.replace(/--+/g, '-').replace(/^-|-$/g, '');
  if (!base) return null;
  return suffix ? `${base}.${suffix}` : base;
}

function isValidIsoDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function toIsoDate(timestamp) {
  const number = Number(timestamp);
  if (!Number.isFinite(number) || number <= 0) return null;
  const milliseconds = number < 100000000000 ? number * 1000 : number;
  const date = new Date(milliseconds);
  if (Number.isNaN(date.getTime())) return null;
  const iso = date.toISOString().slice(0, 10);
  return isValidIsoDate(iso) && date.getTime() <= Date.now() ? iso : null;
}

function parseDate(value) {
  if (typeof value === 'number') return toIsoDate(value);
  const text = String(value == null ? '' : value).trim();
  return isValidIsoDate(text) ? text : null;
}

function finiteNumber(value) {
  if (value === '' || value == null) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/** Reject malformed candles instead of manufacturing OHLC values. */
function normalizeCandle(date, open, high, low, close, volume) {
  const parsedDate = parseDate(date);
  const numericOpen = finiteNumber(open);
  const numericHigh = finiteNumber(high);
  const numericLow = finiteNumber(low);
  const numericClose = finiteNumber(close);
  const numericVolume = finiteNumber(volume == null || volume === '' ? 0 : volume);

  if (!parsedDate || [numericOpen, numericHigh, numericLow, numericClose, numericVolume]
    .some(value => value === null)) return null;
  if ([numericOpen, numericHigh, numericLow, numericClose].some(value => value <= 0)) return null;
  if (numericVolume < 0 || numericLow > numericHigh) return null;
  if (numericHigh < Math.max(numericOpen, numericClose)) return null;
  if (numericLow > Math.min(numericOpen, numericClose)) return null;

  return {
    date: parsedDate,
    open: numericOpen,
    high: numericHigh,
    low: numericLow,
    close: numericClose,
    volume: numericVolume
  };
}

function attachParserMeta(candles, total) {
  Object.defineProperty(candles, 'invalidCount', {
    value: Math.max(0, total - candles.length), enumerable: false
  });
  Object.defineProperty(candles, 'totalCount', { value: total, enumerable: false });
  return candles;
}

function dedupeCandles(candles) {
  const seen = new Set();
  return candles
    .filter(candle => {
      if (!candle || seen.has(candle.date)) return false;
      seen.add(candle.date);
      return true;
    })
    .sort((a, b) => a.date.localeCompare(b.date));
}

function parseYahooPayload(payload) {
  const result = payload && payload.chart && payload.chart.result && payload.chart.result[0];
  const timestamps = result && result.timestamp;
  if (!result || !Array.isArray(timestamps) || timestamps.length === 0) {
    return attachParserMeta([], 0);
  }
  const quote = result.indicators && result.indicators.quote && result.indicators.quote[0];
  if (!quote || !Array.isArray(quote.open) || !Array.isArray(quote.high) ||
      !Array.isArray(quote.low) || !Array.isArray(quote.close)) {
    return attachParserMeta([], timestamps.length);
  }

  const candles = timestamps.map((timestamp, index) => normalizeCandle(
    timestamp,
    quote.open[index],
    quote.high[index],
    quote.low[index],
    quote.close[index],
    quote.volume && quote.volume[index]
  )).filter(Boolean);
  const deduped = dedupeCandles(candles);
  return attachParserMeta(deduped, timestamps.length);
}

function stooqSymbols(ticker) {
  const yahooTicker = normalizeTicker(ticker);
  if (!yahooTicker) return [];
  const [base, suffix] = yahooTicker.split('.');
  const symbols = [yahooTicker.toLowerCase()];
  const stooqSuffix = suffix && STOOQ_SUFFIXES[suffix];
  if (stooqSuffix) symbols.push(`${base.toLowerCase()}.${stooqSuffix}`);
  // Stooq has historically accepted both exchange-qualified and bare US
  // symbols. Keeping both also makes fallback useful for newly listed assets.
  if (!suffix) {
    symbols.push(`${base.toLowerCase()}.us`);
    symbols.push(base.toLowerCase());
  }
  return Array.from(new Set(symbols));
}

function parseStooqCsv(csv) {
  const text = String(csv == null ? '' : csv).trim();
  if (!text || /^(no data|symbol not found|error)/i.test(text)) return attachParserMeta([], 0);
  const lines = text.split(/\r?\n/).filter(line => line.trim());
  if (lines.length < 2) return attachParserMeta([], 0);
  const header = lines.shift().split(',').map(value => value.trim().toLowerCase());
  const position = key => header.indexOf(key);
  const dateColumn = position('date');
  const required = ['open', 'high', 'low', 'close'].every(key => position(key) >= 0);
  if (dateColumn < 0 || !required) return attachParserMeta([], lines.length);

  const candles = lines.map(line => {
    const values = line.split(',').map(value => value.trim());
    return normalizeCandle(
      values[dateColumn], values[position('open')], values[position('high')],
      values[position('low')], values[position('close')],
      position('volume') >= 0 ? values[position('volume')] : 0
    );
  }).filter(Boolean);
  return attachParserMeta(dedupeCandles(candles), lines.length);
}

function periodToUnix(period1) {
  if (period1 == null || period1 === '') return null;
  if (typeof period1 === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(period1) && !isValidIsoDate(period1)) {
    throw new TypeError(`Data inicial inválida: ${period1}`);
  }
  const date = period1 instanceof Date
    ? new Date(period1.getTime())
    : (typeof period1 === 'number' || /^\d+$/.test(String(period1))
      ? new Date(Number(period1) < 100000000000 ? Number(period1) * 1000 : Number(period1))
      : new Date(period1));
  if (Number.isNaN(date.getTime()) || date.getTime() > Date.now()) {
    throw new TypeError(`Data inicial inválida: ${period1}`);
  }
  return Math.floor(date.getTime() / 1000);
}

function filterFromDate(candles, period1) {
  if (period1 == null || period1 === '') return candles;
  const start = new Date(periodToUnix(period1) * 1000).toISOString().slice(0, 10);
  return candles.filter(candle => candle.date >= start);
}

function isRetryable(error) {
  const status = error && error.response && error.response.status;
  const code = error && error.code;
  const message = String(error && error.message ? error.message : '').toLowerCase();
  return status === 408 || status === 429 || status >= 500 ||
    ['ECONNABORTED', 'ETIMEDOUT', 'ECONNRESET', 'ENETUNREACH', 'EAI_AGAIN'].includes(code) ||
    /timeout|timed out|socket hang up|network error/.test(message);
}

async function requestWithRetry(request, options, errors) {
  const retries = Number.isInteger(options.retries) ? Math.max(0, options.retries) : DEFAULT_RETRIES;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await request();
      if (!response || (response.status != null && response.status >= 400)) {
        const error = new Error(`HTTP ${response && response.status ? response.status : 'invalid'} response`);
        error.response = response;
        throw error;
      }
      return response;
    } catch (error) {
      errors.push({ attempt: attempt + 1, status: error.response && error.response.status, code: error.code, message: error.message });
      if (attempt >= retries || !isRetryable(error)) throw error;
      const backoff = Math.min(MAX_BACKOFF_MS, DEFAULT_BACKOFF_MS * (2 ** attempt));
      await sleep(options.backoffMs == null ? backoff : Math.max(0, options.backoffMs));
    }
  }
  throw new Error('request retries exhausted');
}

function historyResult(candles, metadata) {
  const result = candles.slice();
  for (const [key, value] of Object.entries(metadata)) {
    Object.defineProperty(result, key, { value, enumerable: false, configurable: true });
  }
  return result;
}

async function fetchYahooHistory(ticker, period1, options = {}) {
  const normalized = normalizeTicker(ticker);
  const params = new URLSearchParams({ interval: '1d' });
  const start = periodToUnix(period1);
  if (start != null) params.set('period1', start);
  else params.set('range', 'max');
  params.set('period2', Math.floor(Date.now() / 1000));
  const errors = options._errors || [];
  const response = await requestWithRetry(() => axios.get(
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(normalized)}?${params.toString()}`,
    { timeout: options.timeoutMs || DEFAULT_TIMEOUT_MS, headers: { 'User-Agent': USER_AGENT } }
  ), options, errors);
  const candles = parseYahooPayload(response.data);
  if (candles.length === 0) {
    const error = new Error(`Yahoo devolveu payload vazio/inválido para ${ticker}`);
    error.code = 'EMPTY_PAYLOAD';
    error.isEmptyPayload = true;
    error.attempts = errors;
    throw error;
  }
  return { candles, errors, invalidCount: candles.invalidCount || 0, normalized };
}

async function fetchStooqHistory(ticker, options = {}) {
  const errors = [];
  for (const symbol of stooqSymbols(ticker)) {
    try {
      const response = await requestWithRetry(() => axios.get(
        `https://stooq.com/q/d/l/?s=${encodeURIComponent(symbol)}&i=d`,
        { timeout: options.timeoutMs || DEFAULT_TIMEOUT_MS, headers: { 'User-Agent': USER_AGENT }, responseType: 'text' }
      ), options, errors);
      const parsed = parseStooqCsv(response.data);
      const candles = filterFromDate(parsed, options.period1);
      if (candles.length > 0) {
        return { candles, errors, invalidCount: parsed.invalidCount || 0, symbol };
      }
      errors.push({ symbol, message: 'empty payload' });
    } catch (error) {
      // Try the next exchange spelling; the complete error is retained for
      // diagnostics instead of silently converting a failed import to [].
      errors.push({ symbol, status: error.response && error.response.status, code: error.code, message: error.message });
    }
  }
  const error = new Error(`Stooq sem dados válidos para ${ticker}`);
  error.code = 'EMPTY_PAYLOAD';
  error.attempts = errors;
  throw error;
}

async function fetchStockHistory(ticker, period1, options = {}) {
  const requested = cleanTicker(ticker);
  if (!requested) {
    const error = new Error('Ticker vazio ou inválido');
    error.code = 'INVALID_TICKER';
    error.status = 'failed';
    throw error;
  }
  // Validate once before selecting a provider. Otherwise an invalid date
  // could be accidentally hidden by Stooq, which has no period1 parameter.
  periodToUnix(period1);

  const yahooErrors = [];
  try {
    const yahoo = await fetchYahooHistory(requested, period1, { ...options, _errors: yahooErrors });
    return historyResult(yahoo.candles, {
      status: yahoo.invalidCount > 0 ? 'partial' : 'success',
      source: 'yahoo',
      ticker: requested,
      normalizedTicker: yahoo.normalized,
      invalidCandles: yahoo.invalidCount,
      errors: yahooErrors
    });
  } catch (error) {
    yahooErrors.push({ status: error.response && error.response.status, code: error.code, message: error.message });
    console.warn(`[marketDataService] Yahoo indisponível para ${requested}; a tentar Stooq (${error.message || error})`);
  }

  const stooqErrors = [];
  try {
    const stooq = await fetchStooqHistory(requested, { ...options, period1, _errors: stooqErrors });
    return historyResult(stooq.candles, {
      status: 'partial',
      source: 'stooq',
      ticker: requested,
      normalizedTicker: normalizeTicker(requested),
      fallback: true,
      invalidCandles: stooq.invalidCount,
      errors: yahooErrors.concat(stooqErrors)
    });
  } catch (error) {
    stooqErrors.push({ status: error.response && error.response.status, code: error.code, message: error.message });
    // Keep the historical array contract used by the importer, but attach a
    // non-enumerable outcome. Consumers can now distinguish an empty failed
    // fetch from a genuine empty result without breaking existing callers.
    return historyResult([], {
      status: 'failed',
      source: null,
      ticker: requested,
      normalizedTicker: normalizeTicker(requested),
      errors: yahooErrors.concat(stooqErrors),
      code: 'MARKET_DATA_UNAVAILABLE'
    });
  }
}

module.exports = {
  fetchStockHistory,
  fetchYahooHistory,
  fetchStooqHistory,
  parseYahooPayload,
  parseStooqCsv,
  normalizeCandle,
  normalizeTicker,
  stooqSymbols,
  isValidIsoDate,
  DEFAULT_TIMEOUT_MS
};
