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

async function fetchWithRetry(ticker, timeframe = '1d', attempts = 3, customPeriod1 = null) {
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

  for (let i = 0; i < attempts; i++) {
    for (const tickerVariant of tickerVariants) {
      try {
        await sleep(1500 + Math.random() * 1000);

        const result = await yahooFinance.chart(
          tickerVariant,
          { period1, interval: timeframe },
          {
            fetchOptions: {
              headers: { 'User-Agent': USER_AGENT }
            }
          }
        );

        const quotes = result && result.quotes;
        if (!Array.isArray(quotes) || quotes.length === 0) {
          if (tickerVariants.indexOf(tickerVariant) < tickerVariants.length - 1) {
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
        const code = err && err.code;
        const msg = String(err && err.message ? err.message : '');
        const isRateLimit = code === 429 || /rate|429|too many/i.test(msg);
        const isNotFoundOrInactive = err.isInactive || err.isNotFound || /404|not found|quote not found/i.test(msg);
        
        if (isNotFoundOrInactive) {
          err.isInactive = true;
          err.isNotFound = true;
          throw err; // Não tentar retries para tickers comprovadamente inexistentes/inativos
        }

        // Se é rate limit, não adianta tentar outros variantes
        if (isRateLimit) {
          if (i === attempts - 1) {
            throw new Error('Yahoo Finance Rate Limit (429): Demasiados pedidos. Por favor, aguarde alguns minutos.');
          }
          await sleep(5000);
          break; // Break do loop de variantes, continuar para próxima tentativa
        }
        
        // Se não é rate limit e ainda há variantes para tentar, continuar
        if (tickerVariants.indexOf(tickerVariant) < tickerVariants.length - 1) {
          console.warn(`[yahooClient] ${ticker}: erro com variante "${tickerVariant}": ${err.message || err}`);
          continue;
        }
        
        // Se é a última variante e última tentativa, lançar erro
        if (i === attempts - 1 && tickerVariants.indexOf(tickerVariant) === tickerVariants.length - 1) {
          throw err;
        }
        
        // Caso contrário, esperar e tentar novamente
        const backoff = 500 * Math.pow(2, i);
        const jitter = Math.floor(Math.random() * 250);
        await sleep(backoff + jitter);
      }
    }
  }
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

module.exports = { fetchWithRetry, searchTickers, getBulkIndexTickers, normalizeTicker };
