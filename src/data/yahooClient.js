const yahooFinance = require('yahoo-finance2').default || require('yahoo-finance2');
const pLimit = require('p-limit');
const axios = require('axios');
const tickerLists = (() => {
  try { return require('./tickerLists'); } catch (_) { return require('../data/tickerLists'); }
})();

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

// ── Pool de rede partilhada ─────────────────────────────────
// Máximo de pedidos HTTP concorrentes ao Yahoo. Todas as funções de
// histórico passam por aqui: é o controlo primário de ritmo (evita 429),
// substituindo os sleeps pré-fixos longos.
const networkLimit = pLimit(5);

// Micro-stagger (50–120ms) apenas para dessincronizar rajadas de tickers
// que arrancam em simultâneo dentro da própria pool. Não é rate limiting.
const microStagger = () => sleep(50 + Math.floor(Math.random() * 70));

function isNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

// Erros transitórios: retry faz sentido (rate limit, timeouts, sockets).
function isTransientNetworkError(err) {
  if (!err) return false;
  const msg = String(err.message || '');
  const code = err.code != null ? String(err.code) : null;
  const status = err.statusCode != null ? err.statusCode : err.status;
  if (status === 429 || /\b429\b|too many requests|rate.?limit/i.test(msg)) return true;
  if (/\b(ECONNRESET|ETIMEDOUT|ECONNREFUSED|ECONNABORTED|EAI_AGAIN|ENOTFOUND)\b|socket hang up|network|timeout/i.test(msg)) return true;
  if (code && /^(429|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ECONNABORTED|EAI_AGAIN)$/.test(code)) return true;
  return false;
}

// Erros definitivos: retry nunca resolve (símbolo inexistente/deslistado,
// janela sem dados). Não gastar backoff nestes casos.
function isDefinitiveDataError(err) {
  if (!err) return false;
  if (err.isInactive || err.isNotFound) return true;
  return /404|not found|no data|period1/i.test(String((err && err.message) || ''));
}

function isRateLimitError(err) {
  if (!err) return false;
  if (err.statusCode === 429 || err.status === 429) return true;
  if (err.code === 429 || err.code === '429') return true;
  return /\b429\b|too many requests|rate.?limit/i.test(String(err.message || ''));
}

// Retry genérico com backoff exponencial + jitter; delay duplicado em 429.
// opts.sleepFn injetável para testes determinísticos.
// Spec 1.2 (PASSO 1) exige assinatura fetchWithRetry(fn, retries=3, baseDelay=500) com jitter e log "[Yahoo Sync]"
// Mantida compatibilidade: fetchWithBackoff(fn, opts) continua disponível para código existente.
async function fetchWithBackoff(fn, opts = {}) {
  const retries = opts.retries ?? 3;
  const baseDelay = opts.baseDelay ?? 500;
  const sleepFn = opts.sleepFn || sleep;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try { return await fn(); }
    catch (error) {
      if (attempt === retries) throw error;
      // Definitivos (404/inativo): não desperdiçar tentativas
      if (isDefinitiveDataError(error)) throw error;
      const msg = String(error && error.message ? error.message : '');
      const isRateLimit = isRateLimitError(error);
      const jitter = Math.floor(Math.random() * 200);
      const delay = (isRateLimit ? baseDelay * 2 : baseDelay) * Math.pow(2, attempt - 1) + jitter;
      console.warn(`[yahooClient] Tentativa ${attempt}/${retries} falhou${isRateLimit ? ' (RATE LIMIT)' : ''}. A aguardar ${delay}ms... Motivo: ${msg}`);
      await sleepFn(delay);
    }
  }
}

// Spec 1.1 / 1.2 – assinatura exata do prompt
async function fetchWithRetrySpec(fn, retries = 3, baseDelay = 500) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt === retries) throw error;
      const jitter = Math.floor(Math.random() * 300);
      const delay = (baseDelay * Math.pow(2, attempt - 1)) + jitter;
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

// ═══════════════════════════════════════════════════════════
//  Normalização de símbolos para Yahoo Finance
//  - Converte '.' para '-' (ex: BF.B → BF-B)
//  - Mantém sufixos de exchange (.LS, .PA, .DE, etc.)
//  - Remove espaços e caracteres inválidos
// ══════════════════════════════════════════════════════════
function normalizeTicker(ticker) {
  if (!ticker || typeof ticker !== 'string') return ticker;
  
  const trimmed = ticker.trim();
  
  // Mapeamento de formatos conhecidos que precisam de conversão
  const knownConversions = {
    'BF.B': 'BF-B',
    'BRK.A': 'BRK-A',
    'BRK.B': 'BRK-B',
  };
  
  if (knownConversions[trimmed]) {
    return knownConversions[trimmed];
  }
  
  // Para símbolos europeus com '.', manter o formato original
  // Yahoo Finance aceita tanto '.' como '-' para a maioria dos casos
  // Mas alguns símbolos específicos precisam de '-'
  const parts = trimmed.split('.');
  if (parts.length === 2 && parts[1].length <= 3) {
    // Provavelmente um símbolo com sufixo de exchange (ex: AAPL.US, SONC.LS)
    // Manter como está, Yahoo Finance aceita
    return trimmed;
  }
  
  // Para outros casos, tentar com '-' em vez de '.'
  return trimmed.replace(/\./g, '-');
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

function validateStockActivity(candles, ticker) {
  if (!Array.isArray(candles) || candles.length === 0) {
    const err = new Error(`Ticker ${ticker} sem cotações registadas (inativo/deslistado).`);
    err.isInactive = true;
    throw err;
  }

  // Verificar as últimas 30 velas (ou todas se menos de 30)
  const recentCandles = candles.slice(-30);
  const activeCandles = recentCandles.filter(c => c && isNum(c.close) && c.close > 0 && isNum(c.volume) && c.volume > 0);

  if (activeCandles.length === 0) {
    const err = new Error(`Ticker ${ticker} inativo: sem volume nem negociação ativa nos últimos 30 dias úteis.`);
    err.isInactive = true;
    throw err;
  }

  // Verificar se a cotação mais recente não está estagnada há mais de 45 dias corridos
  const latestDateStr = recentCandles[recentCandles.length - 1].date;
  if (latestDateStr) {
    const latestDate = new Date(latestDateStr + 'T00:00:00Z');
    const now = new Date();
    const diffDays = Math.floor((now - latestDate) / (1000 * 60 * 60 * 24));
    if (diffDays > 45) {
      const err = new Error(`Ticker ${ticker} inativo: última cotação há ${diffDays} dias (${latestDateStr}).`);
      err.isInactive = true;
      throw err;
    }
  }

  return true;
}

async function fetchWithRetry(tickerOrFn, timeframe = '1d', attempts = 3, customPeriod1 = null) {
  // Spec 1.2 compat: fetchWithRetry(fn, retries=3, baseDelay=500)
  if (typeof tickerOrFn === 'function') {
    const fn = tickerOrFn;
    const retries = typeof timeframe === 'number' ? timeframe : 3;
    const baseDelay = typeof attempts === 'number' ? attempts : 500;
    return fetchWithRetrySpec(fn, retries, baseDelay);
  }
  const ticker = tickerOrFn;
  const period1 = customPeriod1 || new Date();

  if (!customPeriod1) {
    if (timeframe === '1wk') {
      period1.setDate(period1.getDate() - (365 * 5));
    } else if (timeframe === '1h' || timeframe === '4h') {
      period1.setDate(period1.getDate() - 180);
    } else {
      period1.setDate(period1.getDate() - (365 * 1.5));
    }
  }

  // Normalizar o ticker para o formato correto do Yahoo Finance
  const normalizedTicker = normalizeTicker(ticker);
  const tickerVariants = [normalizedTicker];
  
  // Se o ticker normalizado é diferente do original, tentar ambos
  if (normalizedTicker !== ticker) {
    tickerVariants.unshift(ticker); // Tentar original primeiro
  }
  
  // Para símbolos com '.', tentar também com '-'
  if (ticker.includes('.') && !normalizedTicker.includes('-')) {
    const dashVariant = ticker.replace(/\./g, '-');
    if (!tickerVariants.includes(dashVariant)) {
      tickerVariants.push(dashVariant);
    }
  }

  let lastErr = null;

  for (let v = 0; v < tickerVariants.length; v++) {
    const tickerVariant = tickerVariants[v];
    try {
      await microStagger();

      const result = await networkLimit(() => fetchWithBackoff(
        () => yahooFinance.chart(
          tickerVariant,
          { period1, interval: timeframe },
          {
            fetchOptions: {
              headers: { 'User-Agent': USER_AGENT }
            }
          }
        ),
        { retries: Math.max(1, attempts) }
      ));

      const quotes = result && result.quotes;
      if (!Array.isArray(quotes) || quotes.length === 0) {
        if (v < tickerVariants.length - 1) {
          console.warn(`[yahooClient] ${ticker}: variante "${tickerVariant}" sem dados, a tentar próximo...`);
          continue;
        }
        const err = new Error(`Ticker ${ticker} não encontrado / 404 no Yahoo Finance.`);
        err.isNotFound = true;
        err.isInactive = true;
        throw err;
      }

      const candles = processQuotes(quotes, ticker);

      if (candles.length < MIN_CANDLES) {
        const droppedNull = quotes.length - candles.length;
        const warn = `[yahooClient] AVISO: ${ticker} produziu apenas ${candles.length} velas válidas ` +
          `(${droppedNull} removidas por nulos). Warm-up incompleto (mínimo ${MIN_CANDLES}).`;
        if (candles.length === 0) {
          const err = new Error(`Todas as velas nulas/vazias para ${ticker} (ativo deslistado/inativo).`);
          err.isInactive = true;
          throw err;
        }
        console.warn(warn);
        if (candles.length < WARMUP_TARGET) {
          console.warn(`[yahooClient] ${ticker}: série abaixo do warm-up ideal (${WARMUP_TARGET}). A usar ${candles.length} velas.`);
        }
      }

      // Validar atividade recente do ativo (volume > 0 nos últimos 30 dias úteis)
      validateStockActivity(candles, ticker);

      if (tickerVariant !== ticker) {
        console.log(`[yahooClient] ${ticker}: a usar variante "${tickerVariant}" com sucesso`);
      }
      return candles;
    } catch (err) {
      // Definitivo: símbolo inexistente/deslistado — nem retry nem troca de variante
      if (isDefinitiveDataError(err)) {
        err.isInactive = true;
        err.isNotFound = true;
        throw err;
      }

      // Transitório: os retries exponenciais já decorreram dentro de
      // fetchWithBackoff; rodar para a variante seguinte e registar.
      lastErr = err;
      console.warn(`[yahooClient] ${ticker}: erro com variante "${tickerVariant}"${isRateLimitError(err) ? ' (RATE LIMIT)' : ''}: ${err.message || err}`);
    }
  }

  // Todas as variantes esgotadas — preservar mensagem amigável em rate limit
  if (isRateLimitError(lastErr)) {
    throw new Error('Yahoo Finance Rate Limit (429): Demasiados pedidos. Por favor, aguarde alguns minutos.');
  }
  throw lastErr || new Error(`Ticker ${ticker}: falha desconhecida ao obter histórico (${timeframe}).`);
}

const MARKET_EXCHANGES = {
  PSI: 'Euronext Lisbon',
  IBEX35: 'BME Madrid',
  SP500: 'NYSE/NASDAQ',
  DAX40: 'Xetra Frankfurt',
  CAC40: 'Euronext Paris',
  AEX25: 'Euronext Amsterdam',
  SMI: 'SIX Swiss Exchange',
  BEL20: 'Euronext Brussels',
  OMXS30: 'Nasdaq Stockholm',
  FTSEMIB: 'Borsa Italiana Milano',
  OMXC20: 'Nasdaq Copenhagen',
  FTSE100: 'London Stock Exchange',
  NIKKEI30: 'Tokyo Stock Exchange',
  HANGSENG30: 'Hong Kong Stock Exchange'
};

function resolveIndexId(queryOrId) {
  if (!queryOrId) return null;
  const raw = String(queryOrId).trim();
  const upper = raw.toUpperCase().replace(/^MERCADO_/, '').replace(/^BULK:/, '');

  if (tickerLists.INDICES && tickerLists.INDICES[upper]) return upper;

  const stripped = upper.replace(/[^A-Z0-9]/g, '');
  if (tickerLists.INDICES && tickerLists.INDICES[stripped]) return stripped;

  const alphaOnly = upper.replace(/[0-9]/g, '');
  if (alphaOnly && alphaOnly !== upper && tickerLists.INDICES && tickerLists.INDICES[alphaOnly]) return alphaOnly;

  const upperHyphen = upper.replace(/(\d+)/g, '-$1').replace(/--+/g, '-');
  if (upperHyphen !== upper && tickerLists.INDICES && tickerLists.INDICES[upperHyphen]) return upperHyphen;

  const matches = tickerLists.searchWorldIndices(raw);
  if (!matches || matches.length === 0) return null;

  const withComponents = matches.find(m => m.hasComponents);
  const chosen = withComponents || matches[0];
  if (!chosen) return null;
  if (chosen.id && tickerLists.INDICES && tickerLists.INDICES[chosen.id]) return chosen.id;
  return null;
}

function getBulkIndexTickers(queryOrId) {
  const id = resolveIndexId(queryOrId);
  if (!id) return null;
  const list = (tickerLists.INDICES && tickerLists.INDICES[id]) || [];
  if (!Array.isArray(list) || list.length === 0) return null;
  return {
    id,
    exchange: MARKET_EXCHANGES[id] || 'Índice',
    tickers: list.map(item => ({
      ticker: item.ticker,
      name: item.name,
      exchange: MARKET_EXCHANGES[id] || '',
      type: 'EQUITY'
    }))
  };
}

function buildBulkSearchResult(id) {
  const list = (tickerLists.INDICES && tickerLists.INDICES[id]) || [];
  const meta = (tickerLists.WORLD_INDICES || []).find(i => i.id === id);
  const name = meta && meta.name
    ? `${meta.name} - Adicionar todas as componentes`
    : `Índice ${id} - Adicionar todas as componentes`;
  return {
    ticker: `MERCADO_${id}`,
    name,
    exchange: MARKET_EXCHANGES[id] || 'Índice',
    quoteType: 'INDEX',
    isBulk: true,
    bulkId: id,
    bulkCount: list.length,
    bulkTickers: list.map(t => ({
      ticker: t.ticker,
      name: t.name,
      exchange: MARKET_EXCHANGES[id] || '',
      type: 'EQUITY'
    }))
  };
}

async function searchTickers(query, limit = 8) {
  if (!query || typeof query !== 'string' || query.trim().length < 1) return [];
  const q = query.trim();

  const bulkId = resolveIndexId(q);
  const out = [];
  const seen = new Set();

  if (bulkId) {
    const bulkItem = buildBulkSearchResult(bulkId);
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

async function fetchFullYahooHistory(ticker) {
  const period1 = new Date(0);
  const period2 = new Date();

  const normalizedTicker = normalizeTicker(ticker);
  const tickerVariants = [normalizedTicker];

  if (normalizedTicker !== ticker) {
    tickerVariants.unshift(ticker);
  }

  if (ticker.includes('.') && !normalizedTicker.includes('-')) {
    const dashVariant = ticker.replace(/\./g, '-');
    if (!tickerVariants.includes(dashVariant)) {
      tickerVariants.push(dashVariant);
    }
  }

  const attempts = 3;
  let lastErr = null;

  for (let v = 0; v < tickerVariants.length; v++) {
    const tickerVariant = tickerVariants[v];
    try {
      await microStagger();

      const result = await networkLimit(() => fetchWithBackoff(
        () => yahooFinance.chart(
          tickerVariant,
          { period1, period2, interval: '1d' },
          {
            fetchOptions: {
              headers: { 'User-Agent': USER_AGENT }
            }
          }
        ),
        { retries: attempts }
      ));

      const quotes = result && result.quotes;
      if (!Array.isArray(quotes) || quotes.length === 0) {
        if (v < tickerVariants.length - 1) {
          console.warn(`[yahooClient] ${ticker}: variante "${tickerVariant}" sem dados, a tentar próximo...`);
          continue;
        }
        const err = new Error(`Ticker ${ticker} não encontrado / 404 no Yahoo Finance.`);
        err.isNotFound = true;
        throw err;
      }

      const candles = processQuotes(quotes, ticker);

      if (candles.length === 0) {
        const err = new Error(`Todas as velas nulas/vazias para ${ticker} (ativo deslistado/inativo).`);
        err.isInactive = true;
        throw err;
      }

      if (tickerVariant !== ticker) {
        console.log(`[yahooClient] ${ticker}: a usar variante "${tickerVariant}" com sucesso`);
      }
      return candles;
    } catch (err) {
      // Definitivo: não vale retry nem troca de variante
      if (isDefinitiveDataError(err)) {
        throw err;
      }

      lastErr = err;
      console.warn(`[yahooClient] ${ticker}: erro com variante "${tickerVariant}"${isRateLimitError(err) ? ' (RATE LIMIT)' : ''}: ${err.message || err}`);
    }
  }

  if (isRateLimitError(lastErr)) {
    throw new Error('Yahoo Finance Rate Limit (429): Demasiados pedidos. Por favor, aguarde alguns minutos.');
  }
  throw lastErr || new Error(`Ticker ${ticker}: falha desconhecida ao obter histórico completo.`);
}

function buildIncrementalPeriod1(lastStoredDate) {
  if (!lastStoredDate || typeof lastStoredDate !== 'string') return null;
  const date = new Date(lastStoredDate + 'T00:00:00Z');
  if (Number.isNaN(date.getTime())) return null;
  date.setUTCDate(date.getUTCDate() + 1);
  return date;
}

function buildPeriod1FromDate(dateStr) {
  if (!dateStr || typeof dateStr !== 'string') return null;
  const date = new Date(dateStr + 'T00:00:00Z');
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

// Nota: a assinatura pública (ticker, lastStoredDate) mantém-se intacta.
// O terceiro parâmetro é opcional e interno: opts.throwOnError=true lança
// em vez de retornar [] (usado pelo orquestrador syncTickersBatch).
async function fetchIncrementalYahooHistory(ticker, lastStoredDate, opts = {}) {
  const throwOnError = !!opts.throwOnError;
  const period1 = buildIncrementalPeriod1(lastStoredDate);
  if (!period1) {
    if (throwOnError) throw new Error(`fetchIncrementalYahooHistory(${ticker}): lastStoredDate inválido (${lastStoredDate}).`);
    return [];
  }
  const period2 = new Date();

  if (period1.getTime() >= period2.getTime()) {
    return [];
  }

  const normalizedTicker = normalizeTicker(ticker);

  try {
    const result = await networkLimit(() => fetchWithBackoff(
      () => yahooFinance.chart(
        normalizedTicker,
        { period1, period2, interval: '1d' },
        {
          fetchOptions: {
            headers: { 'User-Agent': USER_AGENT }
          }
        }
      ),
      { retries: 3 }
    ));

    const quotes = result && result.quotes;
    if (!Array.isArray(quotes) || quotes.length === 0) {
      return [];
    }

    return processQuotes(quotes, ticker);
  } catch (err) {
    const msg = String(err && err.message ? err.message : '');

    // Definitivo: símbolo inexistente/deslistado ou janela sem dados novos.
    if (isDefinitiveDataError(err)) {
      console.warn(`[yahooClient] fetchIncrementalYahooHistory(${ticker}, desde ${lastStoredDate}): sem dados incrementais (${msg}).`);
      if (throwOnError) throw err;
      return [];
    }

    // Transitório esgotado (429/timeouts/rede): NÃO é "sem dados" — o sync
    // diário perdia velas silenciosamente aqui. Marcar com console.error.
    if (isTransientNetworkError(err)) {
      console.error(`[yahooClient] ERRO TRANSITÓRIO NÃO RECUPERADO fetchIncrementalYahooHistory(${ticker}, desde ${lastStoredDate}) após esgotar retries: ${msg}. Retornando []; sincronização incremental INCOMPLETA para este ticker.`);
      if (throwOnError) throw err;
      return [];
    }

    console.warn(`[yahooClient] fetchIncrementalYahooHistory(${ticker}): ${msg}`);
    if (throwOnError) throw err;
    return [];
  }
}

async function fetchHistorySince(ticker, sinceDate) {
  const period1 = buildPeriod1FromDate(sinceDate);
  if (!period1) return fetchFullYahooHistory(ticker);
  const period2 = new Date();
  if (period1.getTime() >= period2.getTime()) return [];

  const normalizedTicker = normalizeTicker(ticker);
  try {
    await microStagger();
    const result = await networkLimit(() => fetchWithBackoff(
      () => yahooFinance.chart(
        normalizedTicker,
        { period1, period2, interval: '1d' },
        {
          fetchOptions: {
            headers: { 'User-Agent': USER_AGENT }
          }
        }
      ),
      { retries: 3 }
    ));
    const quotes = result && result.quotes;
    if (!Array.isArray(quotes) || quotes.length === 0) return [];
    return processQuotes(quotes, ticker);
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    if (isDefinitiveDataError(err)) {
      console.warn(`[yahooClient] fetchHistorySince(${ticker}, ${sinceDate}): sem dados (${msg}).`);
      return [];
    }
    if (isTransientNetworkError(err)) {
      console.error(`[yahooClient] ERRO TRANSITÓRIO NÃO RECUPERADO fetchHistorySince(${ticker}, ${sinceDate}) após esgotar retries: ${msg}. Retornando [].`);
      return [];
    }
    console.warn(`[yahooClient] fetchHistorySince(${ticker}, ${sinceDate}): ${msg}`);
    return [];
  }
}

async function fetchFirstTradeDate(ticker) {
  try {
    await sleep(1200 + Math.random() * 800);
    const normalizedTicker = normalizeTicker(ticker);
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(normalizedTicker)}?range=max&interval=1mo`;
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
    if (!res || !res.ok) return null;
    const json = await res.json();
    const resultArr = json && json.chart && Array.isArray(json.chart.result) ? json.chart.result : null;
    const result = resultArr && resultArr.length > 0 ? resultArr[0] : null;
    const timestamps = result && result.timestamp;
    if (Array.isArray(timestamps) && timestamps.length > 0) {
      const d = new Date(timestamps[0] * 1000);
      if (!Number.isNaN(d.getTime())) return d.toISOString().split('T')[0];
    }
    return null;
  } catch (err) {
    console.warn(`[yahooClient] fetchFirstTradeDate(${ticker}): ${err && err.message ? err.message : err}`);
    return null;
  }
}

async function fetchFirstAvailableDate(ticker) {
  // Primeira data de negociação disponível (IPO) em ISO 'YYYY-MM-DD'.
  // Wrapper fino: tenta o chart range=max (1mo) e, em último recurso,
  // deriva a data da primeira vela do histórico diário completo.
  const firstDate = await fetchFirstTradeDate(ticker);
  if (firstDate) return firstDate;
  try {
    const candles = await fetchFullYahooHistory(ticker);
    if (Array.isArray(candles) && candles.length > 0) return candles[0].date || null;
  } catch (err) {
    console.warn(`[yahooClient] fetchFirstAvailableDate(${ticker}): ${err && err.message ? err.message : err}`);
  }
  return null;
}

async function fetchFullHistoryFromIPO(ticker) {
  // Histórico diário total desde a origem (period1=0 até agora).
  // Reforça o contrato: velas sanitizadas (tipos numéricos, sem nulos),
  // deduplicadas por data e ordenadas ASC.
  const candles = await fetchFullYahooHistory(ticker);
  if (!Array.isArray(candles) || candles.length === 0) return [];

  const sanitized = [];
  const seen = new Set();
  for (const c of candles) {
    if (!c || !c.date) continue;
    const date = String(c.date).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || seen.has(date)) continue;
    const close = Number(c.close);
    if (!Number.isFinite(close)) continue;
    const open = Number.isFinite(Number(c.open)) ? Number(c.open) : close;
    const high = Number.isFinite(Number(c.high))
      ? Math.max(Number(c.high), open, close)
      : Math.max(open, close);
    const low = Number.isFinite(Number(c.low))
      ? Math.min(Number(c.low), open, close)
      : Math.min(open, close);
    seen.add(date);
    sanitized.push({
      date,
      open,
      high,
      low,
      close,
      volume: Number.isFinite(Number(c.volume)) ? Number(c.volume) : 0
    });
  }
  sanitized.sort((a, b) => a.date.localeCompare(b.date));
  return sanitized;
}

// ── Orquestrador de sync em lote ────────────────────────────
// Coordena a atualização diária de N tickers sem tocar na rede fora da
// pool. Cada task verifica shouldContinue() antes de arrancar. A decisão
// de rede por ticker:
//   - sem lastDate e !forceFull  → SKIPPED_NO_INITIAL_DATE (zero rede)
//   - lastDate >= expectedTradingDay → ALREADY_UP_TO_DATE (zero rede)
//   - caso contrário → fetchOne (por omissão: incremental, ou full se
//     forceFull e sem lastDate). As defaults já passam por networkLimit;
//     um fetchOne injetado é responsabilidade de quem o fornece.
// Nota de implementação: as tasks NÃO são embrulhadas em networkLimit
// (p-limit não é reentrante — aninhar acquisition causaria deadlock com
// a pool saturada); quem adquire slots são as funções de rede finais.
async function syncTickersBatch(tickers, options = {}) {
  const list = Array.isArray(tickers) ? tickers.filter(Boolean) : [];
  const getLastDate = typeof options.getLastDate === 'function' ? options.getLastDate : () => null;
  const expectedTradingDay = options.expectedTradingDay ? String(options.expectedTradingDay).slice(0, 10) : null;
  const forceFull = !!options.forceFull;
  const shouldContinue = typeof options.shouldContinue === 'function' ? options.shouldContinue : () => true;

  const defaultFetchOne = (ticker, lastDate) => {
    if (lastDate) return fetchIncrementalYahooHistory(ticker, lastDate, { throwOnError: true });
    return fetchFullHistoryFromIPO(ticker);
  };
  // Compat: spec usa options.fetchMethod(ticker, lastDate) + networkLimit
  const hasFetchMethod = typeof options.fetchMethod === 'function';
  const fetchOne = hasFetchMethod ? options.fetchMethod : (typeof options.fetchOne === 'function' ? options.fetchOne : defaultFetchOne);

  // Comparação lexicográfica segura para datas 'YYYY-MM-DD'
  const normDay = d => (d ? String(d).slice(0, 10) : null);

  // Spec 1.3: quando fetchMethod é fornecido, orquestração via networkLimit (5 simultâneos)
  if (hasFetchMethod) {
    const tasks = list.map(ticker => networkLimit(async () => {
      try {
        const lastDateRaw = await getLastDate(ticker);
        const lastDate = normDay(lastDateRaw);
        if (!lastDate && !forceFull) {
          return { ticker, status: 'SKIPPED_NO_DATE' };
        }
        const expectedDate = expectedTradingDay;
        if (lastDate && expectedDate && lastDate >= expectedDate) {
          return { ticker, status: 'ALREADY_UP_TO_DATE' };
        }
        const candles = await fetchWithRetrySpec(() => fetchOne(ticker, lastDate));
        return { ticker, candles, status: 'SUCCESS' };
      } catch (err) {
        console.error(`[Yahoo Error] ${ticker}:`, err.message);
        return { ticker, status: 'ERROR', error: err.message };
      }
    }));
    return await Promise.all(tasks);
  }

  const tasks = list.map(rawTicker => async () => {
    const ticker = typeof rawTicker === 'string' ? rawTicker.trim() : rawTicker;

    if (!shouldContinue(ticker)) {
      return { ticker, status: 'CANCELLED' };
    }

    let storedLastDate = null;
    try { storedLastDate = getLastDate(ticker); } catch (_) { storedLastDate = null; }
    const lastDate = normDay(storedLastDate);

    if (!lastDate && !forceFull) {
      return { ticker, status: 'SKIPPED_NO_INITIAL_DATE' };
    }

    if (lastDate && expectedTradingDay && lastDate >= expectedTradingDay) {
      return { ticker, status: 'ALREADY_UP_TO_DATE', lastDate };
    }

    try {
      const candles = await fetchOne(ticker, lastDate || null);
      const arr = Array.isArray(candles) ? candles : [];
      if (arr.length === 0) {
        return { ticker, status: 'NOOP', count: 0 };
      }
      const newLast = arr[arr.length - 1] && arr[arr.length - 1].date ? normDay(arr[arr.length - 1].date) : null;
      return { ticker, status: 'SUCCESS', candles: arr, count: arr.length, lastDate: newLast };
    } catch (err) {
      return {
        ticker,
        status: 'ERROR',
        error: err && err.message ? err.message : String(err),
        ...(lastDate ? { lastDate } : {})
      };
    }
  });

  return Promise.all(tasks.map(run => run()));
}

async function fetchYahooCandles(ticker, period1, period2) {
  const p1 = period1 instanceof Date ? period1 : (typeof period1 === 'number' ? new Date(period1 * 1000) : (period1 ? new Date(period1) : new Date(Date.now() - 90 * 86400 * 1000)));
  const p2 = period2 instanceof Date ? period2 : (typeof period2 === 'number' ? new Date(period2 * 1000) : (period2 ? new Date(period2) : new Date()));
  const normalizedTicker = normalizeTicker(ticker);

  await microStagger();
  const result = await networkLimit(() => fetchWithBackoff(
    () => yahooFinance.chart(
      normalizedTicker,
      { period1: p1, period2: p2, interval: '1d' },
      {
        fetchOptions: {
          headers: { 'User-Agent': USER_AGENT }
        }
      }
    ),
    { retries: 3 }
  ));

  const quotes = result && result.quotes;
  if (!Array.isArray(quotes) || quotes.length === 0) return [];
  return processQuotes(quotes, ticker);
}

async function fetchRecentFallback(ticker, range = '3mo') {
  const normalizedTicker = normalizeTicker(ticker);
  let period1;
  if (typeof range === 'string' && range.endsWith('mo')) {
    const months = parseInt(range, 10) || 3;
    period1 = new Date(Date.now() - months * 30 * 24 * 60 * 60 * 1000);
  } else if (typeof range === 'string' && range.endsWith('y')) {
    const years = parseInt(range, 10) || 1;
    period1 = new Date(Date.now() - years * 365 * 24 * 60 * 60 * 1000);
  } else if (typeof range === 'string' && range.endsWith('d')) {
    const days = parseInt(range, 10) || 90;
    period1 = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  } else {
    period1 = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  }
  const period2 = new Date();

  await microStagger();
  const result = await networkLimit(() => fetchWithBackoff(
    () => yahooFinance.chart(
      normalizedTicker,
      { period1, period2, interval: '1d' },
      {
        fetchOptions: {
          headers: { 'User-Agent': USER_AGENT }
        }
      }
    ),
    { retries: 3 }
  ));

  const quotes = result && result.quotes;
  if (!Array.isArray(quotes) || quotes.length === 0) return [];
  return processQuotes(quotes, ticker);
}

async function syncSingleTicker(ticker, expectedDate, dbInstance) {
  const db = dbInstance;
  const lastDate = await db.getLastStoredDate(ticker);

  // CASO A: Ativo já possui histórico na SQLite
  if (lastDate) {
    if (expectedDate && lastDate >= expectedDate) {
      return { ticker, status: 'SKIPPED_ALREADY_SYNCED', lastDate };
    }
    const period1 = Math.floor(new Date(lastDate).getTime() / 1000) + 86400;
    const period2 = Math.floor(Date.now() / 1000);

    const newCandles = await fetchWithRetry(() => fetchYahooCandles(ticker, period1, period2));
    if (newCandles && newCandles.length > 0) {
      db.saveHistoricalCandles(ticker, newCandles);
      return { ticker, status: 'UPDATED', count: newCandles.length, lastDate: newCandles[newCandles.length - 1].date };
    }
    return { ticker, status: 'NO_NEW_DATA', lastDate };
  }

  // CASO B: Ativo virgem sem histórico (Fallback de Contingência)
  try {
    const fallbackCandles = await fetchWithRetry(() => fetchRecentFallback(ticker, '3mo'));
    if (fallbackCandles && fallbackCandles.length > 0) {
      // NUNCA sobrescrever first_date com a data de um lote parcial recente:
      // saveHistoricalCandles preenche first_date apenas quando ainda está
      // vazio (MIN(date) real), e a reconciliação global (arranque / IPC)
      // repõe o MIN(date) verdadeiro assim que o histórico completo existir.
      db.saveHistoricalCandles(ticker, fallbackCandles);
      return { ticker, status: 'INITIALIZED_FALLBACK', count: fallbackCandles.length, lastDate: fallbackCandles[fallbackCandles.length - 1].date };
    }
  } catch (fallbackErr) {
    return { ticker, status: 'FAILED_UNAVAILABLE', error: fallbackErr.message };
  }

  return { ticker, status: 'FAILED_NO_DATA', error: 'Sem cotações disponíveis no Yahoo Finance' };
}

async function fetchMissingRecentCandles(ticker, lastDate) {
  const normTicker = normalizeTicker(ticker);
  let url = '';
  if (lastDate) {
    const p1 = Math.floor(new Date(lastDate).getTime() / 1000) + 86400;
    const p2 = Math.floor(Date.now() / 1000);
    if (p1 >= p2) return []; // Já está no timestamp atual
    url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(normTicker)}?period1=${p1}&period2=${p2}&interval=1d`;
  } else {
    // Apenas últimos dias para não sobrecarregar
    url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(normTicker)}?range=5d&interval=1d`;
  }

  await microStagger();

  const fn = async () => {
    const response = await axios.get(url, {
      timeout: 8000,
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'application/json'
      }
    });
    const result = response.data?.chart?.result?.[0];
    if (!result || !result.timestamp || result.timestamp.length === 0) return [];

    const timestamps = result.timestamp;
    const quote = result.indicators?.quote?.[0] || {};
    const candles = [];

    for (let i = 0; i < timestamps.length; i++) {
      if (quote.close?.[i] == null) continue;
      const d = new Date(timestamps[i] * 1000);
      const dateStr = d.toISOString().slice(0, 10);
      const closeVal = Number(quote.close[i]);
      if (!Number.isFinite(closeVal)) continue;

      const openVal = Number.isFinite(Number(quote.open?.[i])) ? Number(quote.open[i]) : closeVal;
      const highVal = Number.isFinite(Number(quote.high?.[i])) ? Number(quote.high[i]) : Math.max(openVal, closeVal);
      const lowVal = Number.isFinite(Number(quote.low?.[i])) ? Number(quote.low[i]) : Math.min(openVal, closeVal);
      const volVal = Number.isFinite(Number(quote.volume?.[i])) ? Number(quote.volume[i]) : 0;

      candles.push({
        ticker: ticker.toUpperCase().trim(),
        date: dateStr,
        open: openVal,
        high: highVal,
        low: lowVal,
        close: closeVal,
        volume: volVal
      });
    }
    return candles;
  };

  return networkLimit(() => fetchWithRetry(fn, 3, 500));
}

async function fetchLatestCandlesForSingleTicker(ticker, lastDate) {
  const cleanTicker = encodeURIComponent(String(ticker).trim().toUpperCase());
  let url = '';

  if (lastDate) {
    const p1 = Math.floor(new Date(lastDate).getTime() / 1000) + 86400;
    const p2 = Math.floor(Date.now() / 1000);
    if (p1 >= p2) return [];
    url = `https://query1.finance.yahoo.com/v8/finance/chart/${cleanTicker}?period1=${p1}&period2=${p2}&interval=1d`;
  } else {
    url = `https://query1.finance.yahoo.com/v8/finance/chart/${cleanTicker}?range=5d&interval=1d`;
  }

  const retries = 3;
  let lastErr = null;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await axios.get(url, {
        timeout: 8000,
        headers: { 'User-Agent': USER_AGENT }
      });

      const result = response.data?.chart?.result?.[0];
      if (!result || !result.timestamp || result.timestamp.length === 0) {
        return [];
      }

      const timestamps = result.timestamp;
      const quote = result.indicators?.quote?.[0] || {};
      const candles = [];

      for (let i = 0; i < timestamps.length; i++) {
        if (quote.close?.[i] == null) continue;
        const d = new Date(timestamps[i] * 1000);
        const dateStr = d.toISOString().slice(0, 10);
        const closeVal = Number(quote.close[i]);
        if (!Number.isFinite(closeVal)) continue;
        candles.push({
          ticker: String(ticker).trim().toUpperCase(),
          date: dateStr,
          open: Number.isFinite(Number(quote.open?.[i])) ? Number(quote.open[i]) : closeVal,
          high: Number.isFinite(Number(quote.high?.[i])) ? Number(quote.high[i]) : Math.max(closeVal, Number.isFinite(Number(quote.open?.[i])) ? Number(quote.open[i]) : closeVal),
          low: Number.isFinite(Number(quote.low?.[i])) ? Number(quote.low[i]) : Math.min(closeVal, Number.isFinite(Number(quote.open?.[i])) ? Number(quote.open[i]) : closeVal),
          close: closeVal,
          volume: Number.isFinite(Number(quote.volume?.[i])) ? Number(quote.volume[i]) : 0
        });
      }

      return candles;
    } catch (err) {
      lastErr = err;
      if (attempt === retries || isDefinitiveDataError(err)) break;
      const isRateLimit = isRateLimitError(err);
      const baseWait = attempt === 1 ? 1000 : 3000;
      const jitter = 200 + Math.floor(Math.random() * 300);
      const delay = (isRateLimit ? baseWait * 1.5 : baseWait) + jitter;
      console.warn(`[Yahoo Sync Retry] ${ticker} tentativa ${attempt}/${retries} falhou (${err.message}). A aguardar ${delay}ms...`);
      await sleep(delay);
    }
  }

  throw lastErr || new Error(`Falha ao obter cotações para ${ticker}`);
}

async function fetchIncrementalCandles(ticker, lastDate) {
  const cleanTicker = encodeURIComponent(String(ticker).trim().toUpperCase());
  let url = '';

  if (lastDate) {
    const p1 = Math.floor(new Date(lastDate).getTime() / 1000) + 86400; // +1 dia
    const p2 = Math.floor(Date.now() / 1000);
    if (p1 >= p2) return []; // Já se encontra atualizado
    url = `https://query1.finance.yahoo.com/v8/finance/chart/${cleanTicker}?period1=${p1}&period2=${p2}&interval=1d`;
  } else {
    // Ativo virgem sem histórico: download de contingência (3 meses) para aquisição imediata
    url = `https://query1.finance.yahoo.com/v8/finance/chart/${cleanTicker}?range=3mo&interval=1d`;
  }

  const retries = 3;
  let lastErr = null;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await axios.get(url, {
        timeout: 7000,
        headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/json' }
      });

      const result = response.data?.chart?.result?.[0];
      if (!result || !result.timestamp || result.timestamp.length === 0) return [];

      const timestamps = result.timestamp;
      const quote = result.indicators?.quote?.[0] || {};
      const candles = [];

      for (let i = 0; i < timestamps.length; i++) {
        if (quote.close?.[i] == null) continue;
        const d = new Date(timestamps[i] * 1000);
        const dateStr = d.toISOString().slice(0, 10);
        const closeVal = Number(quote.close[i]);
        if (!Number.isFinite(closeVal)) continue;

        const openVal = Number.isFinite(Number(quote.open?.[i])) ? Number(quote.open[i]) : closeVal;
        const highVal = Number.isFinite(Number(quote.high?.[i])) ? Number(quote.high[i]) : Math.max(openVal, closeVal);
        const lowVal = Number.isFinite(Number(quote.low?.[i])) ? Number(quote.low[i]) : Math.min(openVal, closeVal);
        const volVal = Number.isFinite(Number(quote.volume?.[i])) ? Number(quote.volume[i]) : 0;

        candles.push({
          ticker: String(ticker).toUpperCase().trim(),
          date: dateStr,
          open: openVal,
          high: highVal,
          low: lowVal,
          close: closeVal,
          volume: volVal
        });
      }

      return candles;
    } catch (err) {
      lastErr = err;
      if (attempt === retries || isDefinitiveDataError(err)) {
        break;
      }
      const isRateLimit = isRateLimitError(err);
      const baseWait = attempt === 1 ? 1000 : 3000;
      const jitter = 200 + Math.floor(Math.random() * 300);
      const delay = (isRateLimit ? baseWait * 1.5 : baseWait) + jitter;
      console.warn(`[Yahoo Sync Retry] ${ticker} tentativa ${attempt}/${retries} falhou (${err.message}). A aguardar ${delay}ms...`);
      await sleep(delay);
    }
  }

  // Se falhar e for ativo virgem (3mo), tenta um último recurso de 5d antes de desistir
  if (!lastDate && lastErr) {
    try {
      const fallbackUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${cleanTicker}?range=5d&interval=1d`;
      const fallbackRes = await axios.get(fallbackUrl, {
        timeout: 7000,
        headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/json' }
      });
      const result = fallbackRes.data?.chart?.result?.[0];
      if (result && result.timestamp && result.timestamp.length > 0) {
        const timestamps = result.timestamp;
        const quote = result.indicators?.quote?.[0] || {};
        const candles = [];
        for (let i = 0; i < timestamps.length; i++) {
          if (quote.close?.[i] == null) continue;
          const d = new Date(timestamps[i] * 1000);
          candles.push({
            ticker: String(ticker).toUpperCase().trim(),
            date: d.toISOString().slice(0, 10),
            open: Number(quote.open?.[i] || quote.close[i]),
            high: Number(quote.high?.[i] || quote.close[i]),
            low: Number(quote.low?.[i] || quote.close[i]),
            close: Number(quote.close[i]),
            volume: Number(quote.volume?.[i] || 0)
          });
        }
        if (candles.length > 0) return candles;
      }
    } catch (_) {}
  }

  throw lastErr || new Error(`Falha ao obter cotações para ${ticker}`);
}

module.exports = {
  fetchWithRetry,
  fetchWithRetrySpec,
  fetchYahooCandles,
  fetchRecentFallback,
  fetchMissingRecentCandles,
  fetchLatestCandlesForSingleTicker,
  fetchIncrementalCandles,
  syncSingleTicker,
  searchTickers,
  getBulkIndexTickers,
  normalizeTicker,
  fetchFullYahooHistory,
  fetchIncrementalYahooHistory,
  buildIncrementalPeriod1,
  fetchFirstTradeDate,
  fetchHistorySince,
  fetchFirstAvailableDate,
  fetchFullHistoryFromIPO,
  networkLimit,
  fetchWithBackoff,
  syncTickersBatch
};

