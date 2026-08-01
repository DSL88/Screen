const { INDICES } = require('./tickerLists');

function tickerKey(value) {
  return String(value || '').trim().toUpperCase().replace(/\./g, '-');
}

function fromIndex(indexId) {
  const seen = new Set();
  return (INDICES[indexId] || []).reduce((out, item) => {
    const ticker = String(item && item.ticker || '').trim().toUpperCase();
    const key = tickerKey(ticker);
    if (!ticker || seen.has(key)) return out;
    seen.add(key);
    out.push(ticker);
    return out;
  }, []);
}

function entriesFromIndex(indexId) {
  const seen = new Set();
  return (INDICES[indexId] || []).reduce((out, item) => {
    const ticker = String(item && item.ticker || '').trim().toUpperCase();
    const key = tickerKey(ticker);
    if (!ticker || seen.has(key)) return out;
    seen.add(key);
    out.push({ ticker, name: String(item.name || ticker).trim() });
    return out;
  }, []);
}

// Kept locally so a B3 constituent import does not depend on the availability
// or layout of Wikipedia. It is intentionally broad (ordinary and preferred
// classes included) and is deduplicated by the same code as every other index.
const BOVESPA = [
  'ABEV3', 'ALOS3', 'ALPA4', 'ASAI3', 'AURE3', 'AZUL4', 'BBAS3', 'BBDC3', 'BBDC4',
  'BBSE3', 'B3SA3', 'BBTC3', 'BEEF3', 'BEES3', 'BPAC3', 'BPAC5', 'BPAC11', 'BRAP3',
  'BRAP4', 'BRAV3', 'BRBI11', 'BRFS3', 'CAML3', 'CMIG4', 'CMIN3', 'COGN3', 'CPLE3',
  'CPLE6', 'CRFB3', 'CSAN3', 'CSMG3', 'CSNA3', 'CURY3', 'CVCB3', 'CYRE3', 'ECOR3',
  'EGIE3', 'ELET3', 'ELET6', 'EMBR3', 'ENEV3', 'ENGI11', 'EQTL3', 'EVEN3', 'EZTC3',
  'FLRY3', 'GGBR4', 'GMAT3', 'GOAU4', 'HAPV3', 'HYPE3', 'IGTI11', 'INTB3', 'IRBR3',
  'ISAE4', 'ITSA4', 'ITUB3', 'ITUB4', 'JBSS3', 'JHSF3', 'KLBN11', 'LREN3', 'LWSA3',
  'MGLU3', 'MOVI3', 'MRFG3', 'MRVE3', 'MULT3', 'NTCO3', 'ODPV3', 'ONCO3', 'PCAR3',
  'PETR3', 'PETR4', 'PETZ3', 'POMO4', 'POSI3', 'PRIO3', 'PSSA3', 'QUAL3', 'RADL3',
  'RAIL3', 'RAIZ4', 'RENT3', 'RRRP3', 'SANB11', 'SBSP3', 'SLCE3', 'SMTO3', 'STBP3',
  'SUZB3', 'TAEE11', 'TASA4', 'TIMS3', 'TOTS3', 'TRPL4', 'UGPA3', 'UNIP6', 'USIM5',
  'VALE3', 'VAMO3', 'VBBR3', 'VIVT3', 'WEGE3', 'YDUQ3'
].map(ticker => ({ ticker: `${ticker}.SA`, name: ticker }));

function entry(indexId, indexName, indexTicker, aliases, extra = {}) {
  return {
    indexId,
    indexName,
    indexTicker,
    tickers: fromIndex(indexId),
    constituents: entriesFromIndex(indexId),
    aliases,
    ...extra
  };
}

const COUNTRY_INDEX_MAP = {
  Portugal: entry('PSI', 'PSI', '^PSI.LS', ['PT', 'Portugal']),
  Alemanha: entry('DAX40', 'DAX 40', '^GDAXI', ['DE', 'Germany', 'Alemanha']),
  Espanha: entry('IBEX35', 'IBEX 35', '^IBEX', ['ES', 'Spain', 'Espanha']),
  EUA: entry('SP500', 'S&P 500', '^GSPC', ['US', 'USA', 'United States', 'Estados Unidos', 'EUA']),
  França: entry('CAC40', 'CAC 40', '^FCHI', ['FR', 'France', 'Franca', 'França']),
  Holanda: entry('AEX25', 'AEX 25', '^AEX', ['NL', 'Netherlands', 'Holanda']),
  Suíça: entry('SMI', 'SMI', '^SSMI', ['CH', 'Switzerland', 'Suica', 'Suíça']),
  Itália: entry('FTSEMIB', 'FTSE MIB', 'FTSEMIB.MI', ['IT', 'Italy', 'Italia', 'Itália']),
  'Reino Unido': entry('FTSE100', 'FTSE 100', '^FTSE', ['GB', 'UK', 'United Kingdom', 'Reino Unido']),
  Japão: entry('NIKKEI30', 'Nikkei 225', '^N225', ['JP', 'Japan', 'Japao', 'Japão']),
  'Hong Kong': entry('HANGSENG30', 'Hang Seng', '^HSI', ['HK', 'Hong Kong', 'HongKong']),
  Brasil: {
    indexId: 'BOVESPA',
    indexName: 'Ibovespa',
    indexTicker: '^BVSP',
    tickers: BOVESPA.map(item => item.ticker),
    constituents: BOVESPA,
    aliases: ['BR', 'Brazil', 'Brasil']
  },
  Bélgica: entry('BEL20', 'BEL 20', '^BFX', ['BE', 'Belgium', 'Belgica', 'Bélgica']),
  Suécia: entry('OMXS30', 'OMX Stockholm 30', '^OMX', ['SE', 'Sweden', 'Suecia', 'Suécia']),
  Dinamarca: entry('OMXC20', 'OMX Copenhagen 20', '^OMXC20', ['DK', 'Denmark', 'Dinamarca'])
};

function normalizeCountry(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

const countryLookup = new Map();
for (const [key, mapping] of Object.entries(COUNTRY_INDEX_MAP)) {
  countryLookup.set(normalizeCountry(key), mapping);
  for (const alias of mapping.aliases || []) countryLookup.set(normalizeCountry(alias), mapping);
  countryLookup.set(normalizeCountry(mapping.indexId), mapping);
  countryLookup.set(normalizeCountry(mapping.indexName), mapping);
}

function getCountryIndex(country) {
  return countryLookup.get(normalizeCountry(country)) || null;
}

module.exports = { COUNTRY_INDEX_MAP, getCountryIndex, normalizeCountry, fromIndex };
