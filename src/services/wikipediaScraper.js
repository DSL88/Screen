const axios = require('axios');
const cheerio = require('cheerio');
const { getCountryIndex, COUNTRY_INDEX_MAP } = require('../data/countryIndexMap');
const { normalizeTicker: normalizeYahooTicker } = require('./marketDataService');

const INDEX_WIKIPEDIA_URLS = {
  PSI: 'https://en.wikipedia.org/wiki/PSI-20',
  DAX40: 'https://en.wikipedia.org/wiki/DAX',
  IBEX35: 'https://en.wikipedia.org/wiki/IBEX_35',
  CAC40: 'https://en.wikipedia.org/wiki/CAC_40',
  SP500: 'https://en.wikipedia.org/wiki/List_of_S%26P_500_companies',
  FTSE100: 'https://en.wikipedia.org/wiki/FTSE_100_Index',
  AEX25: 'https://en.wikipedia.org/wiki/AEX_index',
  SMI: 'https://en.wikipedia.org/wiki/Swiss_Market_Index',
  BEL20: 'https://en.wikipedia.org/wiki/BEL_20',
  OMXS30: 'https://en.wikipedia.org/wiki/OMX_Stockholm_30',
  OMXC20: 'https://en.wikipedia.org/wiki/OMX_Copenhagen_25',
  FTSEMIB: 'https://en.wikipedia.org/wiki/FTSE_MIB',
  NIKKEI30: 'https://en.wikipedia.org/wiki/Nikkei_225',
  HANGSENG30: 'https://en.wikipedia.org/wiki/Hang_Seng_Index'
};

const INDEX_SUFFIXES = {
  PSI: 'LS', DAX40: 'DE', IBEX35: 'MC', CAC40: 'PA', FTSE100: 'L',
  AEX25: 'AS', SMI: 'SW', BEL20: 'BR', OMXS30: 'ST', OMXC20: 'CO',
  FTSEMIB: 'MI', NIKKEI30: 'T', HANGSENG30: 'HK'
};

function normalizeQuery(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function resolveMapping(countryOrIndex) {
  const countryMapping = getCountryIndex(countryOrIndex);
  if (countryMapping) {
    const indexId = countryMapping.indexId || Object.keys(INDEX_WIKIPEDIA_URLS)
      .find(id => normalizeQuery(id) === normalizeQuery(countryMapping.indexName)) ||
      normalizeQuery(countryMapping.indexName).toUpperCase();
    return { mapping: countryMapping, indexId };
  }

  const query = normalizeQuery(countryOrIndex);
  for (const [key, entry] of Object.entries(COUNTRY_INDEX_MAP)) {
    const candidates = [key, entry.indexName, entry.indexId, ...(entry.aliases || [])];
    if (candidates.some(candidate => {
      const normalized = normalizeQuery(candidate);
      return normalized === query || normalized.replace(/\d+$/, '') === query ||
        query.replace(/\d+$/, '') === normalized;
    })) {
      return { mapping: entry, indexId: entry.indexId || normalizeQuery(entry.indexName).toUpperCase() };
    }
  }
  return null;
}

function cleanName(value) {
  return String(value || '')
    .replace(/\[[^\]]+\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeTicker(value, indexId) {
  const raw = cleanName(value);
  if (!raw || /^(n\/a|na|—|-|none)$/i.test(raw)) return null;
  const suffix = INDEX_SUFFIXES[indexId];
  const ticker = normalizeYahooTicker(raw, suffix);
  if (!ticker || ticker.length > 32) return null;
  // Constituent lists must contain symbols, not prose or dates. Numeric
  // symbols remain valid when the exchange suffix is present (7203.T, 0700.HK).
  if (!/^[A-Z0-9]+(?:-[A-Z0-9]+)*(?:\.[A-Z]{1,4})?$/.test(ticker)) return null;
  if (!suffix && /^\d+$/.test(ticker)) return null;
  return ticker;
}

function decorateConstituents(list, metadata) {
  for (const [key, value] of Object.entries(metadata)) {
    Object.defineProperty(list, key, { value, enumerable: false, configurable: true });
  }
  return list;
}

function fallbackConstituents(mapping, indexId, reason) {
  const staticEntries = Array.isArray(mapping && mapping.constituents)
    ? mapping.constituents
    : (mapping && mapping.tickers || []).map(ticker => ({ ticker, name: ticker }));
  const seen = new Set();
  const result = [];
  for (const item of staticEntries) {
    const rawTicker = typeof item === 'string' ? item : item && item.ticker;
    const ticker = normalizeTicker(rawTicker, indexId);
    if (!ticker || seen.has(ticker)) continue;
    seen.add(ticker);
    const name = cleanName(typeof item === 'string' ? item : item.name) || ticker;
    result.push({ ticker, name });
  }
  return decorateConstituents(result, {
    source: 'static',
    status: result.length ? 'partial' : 'failed',
    fallback: true,
    error: reason || null
  });
}

function headerIndex(headers, pattern) {
  return headers.findIndex(header => pattern.test(header));
}

function parseConstituents(html, indexId) {
  const $ = cheerio.load(String(html || ''));
  const rows = new Map();

  $('table.wikitable, table').each((_, table) => {
    const tableRows = $(table).find('tr');
    if (!tableRows.length) return;
    const headerCells = tableRows.first().find('th,td')
      .map((__, cell) => cleanName($(cell).text()).toLowerCase()).get();
    const tickerColumn = headerIndex(headerCells, /(^|\b)(ticker(?: symbol)?|symbol|epic|code|ric)(\b|$)/i);
    if (tickerColumn < 0) return;
    const nameColumn = headerIndex(headerCells, /(^|\b)(company(?: name)?|security|constituent|name)(\b|$)/i);

    tableRows.slice(1).each((__, row) => {
      const cells = $(row).find('th,td').map((___, cell) => cleanName($(cell).text())).get();
      const ticker = normalizeTicker(cells[tickerColumn], indexId);
      if (!ticker || rows.has(ticker)) return;
      const name = (nameColumn >= 0 ? cells[nameColumn] : '') || ticker;
      rows.set(ticker, { ticker, name: cleanName(name) || ticker });
    });
  });

  return Array.from(rows.values());
}

function isRetryable(error) {
  const status = error && error.response && error.response.status;
  return status === 408 || status === 429 || status >= 500 ||
    ['ECONNABORTED', 'ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN'].includes(error && error.code) ||
    /timeout|network|socket/i.test(String(error && error.message));
}

async function fetchWikipedia(url, options = {}) {
  const retries = Number.isInteger(options.retries) ? Math.max(0, options.retries) : 1;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await axios.get(url, {
        timeout: options.timeoutMs || 10000,
        headers: { 'User-Agent': 'MarkovStockScanner/1.0 (open-source index constituent importer)' }
      });
      if (!response || response.status >= 400) {
        const error = new Error(`Wikipedia HTTP ${response && response.status}`);
        error.response = response;
        throw error;
      }
      return response.data;
    } catch (error) {
      if (attempt >= retries || !isRetryable(error)) throw error;
      const delay = options.backoffMs == null ? 250 * (2 ** attempt) : Math.max(0, options.backoffMs);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  throw new Error('Wikipedia retries exhausted');
}

async function getIndexConstituents(countryOrIndex, options = {}) {
  const resolved = resolveMapping(countryOrIndex);
  if (!resolved) return decorateConstituents([], { source: 'none', status: 'failed', error: 'Índice desconhecido' });

  const { mapping, indexId } = resolved;
  const url = INDEX_WIKIPEDIA_URLS[indexId];
  if (!url) return fallbackConstituents(mapping, indexId, 'sem fonte Wikipedia configurada');

  try {
    const html = await fetchWikipedia(url, options);
    const constituents = parseConstituents(html, indexId);
    // A one-row result for an index with a sizeable static list is almost
    // invariably a changed Wikipedia layout, not a valid constituent list.
    const staticCount = Array.isArray(mapping.tickers) ? mapping.tickers.length : 0;
    if (constituents.length === 0 || (staticCount > 10 && constituents.length < 2)) {
      return fallbackConstituents(mapping, indexId, 'Wikipedia sem constituintes suficientes');
    }
    return decorateConstituents(constituents, { source: 'wikipedia', status: 'success', fallback: false });
  } catch (error) {
    console.warn(`[wikipediaScraper] Fallback estático para ${countryOrIndex}: ${error.message || error}`);
    return fallbackConstituents(mapping, indexId, error.message || String(error));
  }
}

module.exports = {
  getIndexConstituents,
  parseConstituents,
  normalizeTicker,
  resolveMapping,
  fallbackConstituents,
  INDEX_WIKIPEDIA_URLS,
  INDEX_SUFFIXES
};
