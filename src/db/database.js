const path = require('path');
const Database = require('better-sqlite3');
const { getLastExpectedTradingDay } = require('../utils/dateUtils');
const { WORLD_INDICES } = require('../data/tickerLists');

// Spec Passo 2 – referência canónica (verificação de conteúdo)
// function getLastExpectedTradingDay() {
//   const now = new Date();
//   const dayOfWeek = now.getDay(); // 0 = Domingo, 6 = Sábado
//   const target = new Date(now);
//   if (dayOfWeek === 0) { target.setDate(now.getDate() - 2); }
//   else if (dayOfWeek === 6) { target.setDate(now.getDate() - 1); }
//   else if (dayOfWeek === 1 && now.getHours() < 18) { target.setDate(now.getDate() - 3); }
//   else if (now.getHours() < 18) { target.setDate(now.getDate() - 1); }
//   const year = target.getFullYear(); const month = String(target.getMonth() + 1).padStart(2, '0'); const day = String(target.getDate()).padStart(2, '0'); return `${year}-${month}-${day}`;
// }

function normalizeIndexValue(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

// The database stores the stable id (SP500, DAX40, ...), never the label
// shown by the UI.  Keeping this conversion here also makes old databases
// safe to read after the labels in the UI change.
const INDEX_IDS = new Map();
for (const index of WORLD_INDICES || []) {
  const values = [index.id, index.name, ...(index.aliases || [])];
  for (const value of values) {
    const normalized = normalizeIndexValue(value);
    if (normalized) INDEX_IDS.set(normalized, index.id);
  }
}

function canonicalIndexId(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  return INDEX_IDS.get(normalizeIndexValue(raw)) || raw;
}

function canonicalTicker(value) {
  return String(value || '').trim().toUpperCase();
}

const DEFAULT_PARAMS = {
  edge_threshold: 0.15,
  markov_window: 150,
  volume_mult: 1.2,
  horizon_days: 5
};

class DB {
  constructor(userDataPath) {
    this.db = null;
    this.userDataPath = userDataPath;
  }

  canonicalIndexId(value) {
    return canonicalIndexId(value);
  }

  init() {
    if (!this.userDataPath) {
      throw new Error('DB.init requires a userDataPath');
    }
    const dbPath = path.join(this.userDataPath, 'trades.db');
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('cache_size = -64000');
    this.db.pragma('temp_store = MEMORY');
    this.db.pragma('foreign_keys = ON');
    this._migrate();
    this._seedParams();
    // Statements quentes compilados uma única vez, com o schema já migrado.
    this._prepareStatements();
    return Promise.resolve();
  }

  _migrate() {
    const tx = this.db.transaction(() => {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS historical_signals (
          id              INTEGER PRIMARY KEY AUTOINCREMENT,
          ticker          TEXT NOT NULL,
          date            TEXT NOT NULL,
          preco_entrada   REAL NOT NULL,
          direcao         TEXT CHECK(direcao IN ('COMPRA','VENDA')),
          edge            REAL NOT NULL,
          p_stay          REAL NOT NULL,
          atr_14          REAL NOT NULL,
          stop_loss       REAL,
          take_profit     REAL,
          status          TEXT DEFAULT 'aberto' CHECK(status IN ('aberto','fechado')),
          resultado_pct   REAL,
          closed_at       TEXT,
          close_reason    TEXT,
          created_at      TEXT DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_ticker_date ON historical_signals(ticker, date);
        CREATE INDEX IF NOT EXISTS idx_status ON historical_signals(status);

        CREATE TABLE IF NOT EXISTS adaptive_params (
          key   TEXT PRIMARY KEY,
          value REAL NOT NULL
        );

        CREATE TABLE IF NOT EXISTS ohlcv_cache (
          ticker        TEXT NOT NULL,
          date          TEXT NOT NULL,
          open          REAL NOT NULL,
          high          REAL NOT NULL,
          low           REAL NOT NULL,
          close         REAL NOT NULL,
          volume        REAL NOT NULL,
          fetched_at    TEXT NOT NULL,
          PRIMARY KEY (ticker, date)
        );

        CREATE TABLE IF NOT EXISTS historical_prices (
          ticker        TEXT NOT NULL,
          date          TEXT NOT NULL,
          open          REAL NOT NULL,
          high          REAL NOT NULL,
          low           REAL NOT NULL,
          close         REAL NOT NULL,
          volume        INTEGER NOT NULL,
          PRIMARY KEY (ticker, date)
        );
        CREATE INDEX IF NOT EXISTS idx_ticker_date ON historical_prices (ticker, date);
        CREATE INDEX IF NOT EXISTS idx_hist_ticker_date ON historical_prices (ticker, date);
        CREATE INDEX IF NOT EXISTS idx_historical_prices_ticker_date_asc ON historical_prices (ticker, date ASC);
        CREATE INDEX IF NOT EXISTS idx_hist_ticker_date_desc ON historical_prices (ticker, date DESC);

        CREATE TABLE IF NOT EXISTS stocks (
          ticker      TEXT PRIMARY KEY,
          name        TEXT NOT NULL,
          country     TEXT NOT NULL,
          index_name  TEXT NOT NULL,
          created_at  TEXT DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_stocks_ticker ON stocks (ticker);
        CREATE INDEX IF NOT EXISTS idx_stocks_index ON stocks (index_name);

        CREATE TABLE IF NOT EXISTS custom_tickers (
          ticker     TEXT PRIMARY KEY,
          name       TEXT,
          exchange   TEXT,
          type       TEXT,
          added_at   TEXT DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS active_trades (
          id             INTEGER PRIMARY KEY AUTOINCREMENT,
          ticker         TEXT NOT NULL,
          nome           TEXT,
          direcao        TEXT CHECK(direcao IN ('COMPRA','VENDA')),
          preco_entrada  REAL NOT NULL,
          stop_loss      REAL NOT NULL,
          take_profit    REAL NOT NULL,
          data_entrada   TEXT NOT NULL,
          status         TEXT DEFAULT 'aberto' CHECK(status IN ('aberto','fechado')),
          resultado_pct  REAL,
          preco_fecho    REAL,
          motivo_fecho   TEXT,
          fechado_em     TEXT,
          created_at     TEXT DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_active_trades_status ON active_trades(status);

        CREATE TABLE IF NOT EXISTS market_shortcuts (
          id        INTEGER PRIMARY KEY AUTOINCREMENT,
          ticker    TEXT NOT NULL UNIQUE,
          nome      TEXT,
          mercado   TEXT,
          tipo      TEXT,
          added_at  TEXT DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_market_shortcuts_ticker ON market_shortcuts(ticker);
      `);

      const cols = this.db.prepare("PRAGMA table_info(historical_signals)").all();
      const have = new Set(cols.map(c => c.name));
      if (!have.has('stop_loss')) {
        this.db.exec('ALTER TABLE historical_signals ADD COLUMN stop_loss REAL');
      }
      if (!have.has('take_profit')) {
        this.db.exec('ALTER TABLE historical_signals ADD COLUMN take_profit REAL');
      }
      if (!have.has('closed_at')) {
        this.db.exec('ALTER TABLE historical_signals ADD COLUMN closed_at TEXT');
      }
      if (!have.has('close_reason')) {
        this.db.exec('ALTER TABLE historical_signals ADD COLUMN close_reason TEXT');
      }

      // Migration: ensure stocks table exists for older databases
      const tables = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='stocks'").get();
      if (!tables) {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS stocks (
            ticker      TEXT PRIMARY KEY,
            name        TEXT NOT NULL,
            country     TEXT NOT NULL,
            index_name  TEXT NOT NULL,
            created_at  TEXT DEFAULT CURRENT_TIMESTAMP
          );
        `);
      }

      const customCols = this.db.prepare("PRAGMA table_info(custom_tickers)").all();
      const customColsSet = new Set(customCols.map(c => c.name));
      if (!customColsSet.has('country')) {
        try { this.db.exec('ALTER TABLE custom_tickers ADD COLUMN country TEXT'); } catch (_) { /* already added */ }
      }
      if (!customColsSet.has('index_name')) {
        try { this.db.exec('ALTER TABLE custom_tickers ADD COLUMN index_name TEXT'); } catch (_) { /* already added */ }
      }

      const stockCols = this.db.prepare("PRAGMA table_info(stocks)").all();
      const stockColsSet = new Set(stockCols.map(c => c.name));
      // Some very early databases had a minimal stocks table.  Add every
      // metadata column defensively so the UPSERT below is always valid.
      if (!stockColsSet.has('name')) {
        try { this.db.exec("ALTER TABLE stocks ADD COLUMN name TEXT NOT NULL DEFAULT ''"); } catch (_) { /* already added */ }
      }
      if (!stockColsSet.has('country')) {
        try { this.db.exec("ALTER TABLE stocks ADD COLUMN country TEXT NOT NULL DEFAULT ''"); } catch (_) { /* already added */ }
      }
      if (!stockColsSet.has('index_name')) {
        try { this.db.exec("ALTER TABLE stocks ADD COLUMN index_name TEXT NOT NULL DEFAULT ''"); } catch (_) { /* already added */ }
      }
      if (!stockColsSet.has('full_history_fetched')) {
        try { this.db.exec('ALTER TABLE stocks ADD COLUMN full_history_fetched INTEGER DEFAULT 0'); } catch (_) { /* already added */ }
      }
      if (!stockColsSet.has('first_date')) {
        try {
          this.db.exec('ALTER TABLE stocks ADD COLUMN first_date TEXT');
        } catch (_) {
          // Another process may have added the column between PRAGMA and ALTER.
        }
      }

      // Índice composto para agregações MIN/MAX/COUNT instantâneas por ativo.
      this.db.exec('CREATE INDEX IF NOT EXISTS idx_ticker_date ON historical_prices (ticker, date)');

      // AUTOCORREÇÃO DA PRIMEIRA DATA HISTÓRICA
      // ------------------------------------------------------------------
      // Recalcula first_date para TODOS os ativos já gravados na BD, com
      // base no MIN(date) real de historical_prices. Isto corrige
      // retroativamente registos cujo first_date tinha sido populado com a
      // data do download (em vez da vela mais antiga) por versões anteriores.
      //
      // NOTA DE PERFORMANCE: os tickers são sempre gravados de forma canónica
      // (UPPER + TRIM) em todos os caminhos de escrita. Usar
      // UPPER(TRIM(hp.ticker)) na comparação impediria o uso do índice
      // composto idx_hist_ticker_date e forçaria uma varredura completa de
      // historical_prices POR CADA ativo — em bases com milhões de velas
      // (ex.: 905 ativos × 5.2M linhas) a migração nunca termina e a app
      // "não arranca". A correspondência exata usa o índice (milissegundos).
      try {
        const fixStmt = this.db.prepare(`
          UPDATE stocks
          SET first_date = (
            SELECT MIN(hp.date)
            FROM historical_prices hp
            WHERE hp.ticker = stocks.ticker
          )
          WHERE EXISTS (
            SELECT 1
            FROM historical_prices hp
            WHERE hp.ticker = stocks.ticker
          )
        `);
        const fixResult = fixStmt.run();
        if (fixResult.changes > 0) {
          console.log(`[DB Migration] first_date recalculado para ${fixResult.changes} ativo(s) a partir do MIN(date) real.`);
        }
      } catch (err) {
        console.error('[DB Migration] Falha ao recalcular first_date:', err && err.message ? err.message : err);
      }

      // Older releases stored labels such as "EUA — S&P 500" in this
      // column.  Convert them once, defensively, before any indexed query.
      const stockRows = this.db.prepare('SELECT ticker, index_name FROM stocks').all();
      const updateStockIndex = this.db.prepare('UPDATE stocks SET index_name = ? WHERE ticker = ?');
      for (const row of stockRows) {
        const id = canonicalIndexId(row.index_name);
        if (id && id !== row.index_name) updateStockIndex.run(id, row.ticker);
      }
      const customRows = this.db.prepare('SELECT ticker, index_name FROM custom_tickers').all();
      const updateCustomIndex = this.db.prepare('UPDATE custom_tickers SET index_name = ? WHERE ticker = ?');
      for (const row of customRows) {
        const id = canonicalIndexId(row.index_name);
        if (id && id !== row.index_name) updateCustomIndex.run(id, row.ticker);
      }
      // custom_tickers did not have index metadata in another old schema;
      // recover it from stocks when the ticker is shared.
      this.db.exec(`
        UPDATE custom_tickers
        SET index_name = (SELECT s.index_name FROM stocks s WHERE s.ticker = custom_tickers.ticker)
        WHERE (index_name IS NULL OR TRIM(index_name) = '')
          AND EXISTS (SELECT 1 FROM stocks s WHERE s.ticker = custom_tickers.ticker AND s.index_name IS NOT NULL)
      `);

      this._migrateRecalculateSLTP();
    });
    tx();
  }

  _migrateRecalculateSLTP() {
    const SL_PCT = 0.014;
    const TP_PCT = 0.028;

    const tx = this.db.transaction(() => {
      this.db.exec(`
        UPDATE active_trades
        SET stop_loss = CASE
          WHEN direcao = 'COMPRA' THEN preco_entrada * (1 - ${SL_PCT})
          WHEN direcao = 'VENDA'  THEN preco_entrada * (1 + ${SL_PCT})
          ELSE stop_loss
        END,
        take_profit = CASE
          WHEN direcao = 'COMPRA' THEN preco_entrada * (1 + ${TP_PCT})
          WHEN direcao = 'VENDA'  THEN preco_entrada * (1 - ${TP_PCT})
          ELSE take_profit
        END
        WHERE preco_entrada IS NOT NULL AND preco_entrada > 0
      `);

      this.db.exec(`
        UPDATE historical_signals
        SET stop_loss = CASE
          WHEN direcao = 'COMPRA' THEN preco_entrada * (1 - ${SL_PCT})
          WHEN direcao = 'VENDA'  THEN preco_entrada * (1 + ${SL_PCT})
          ELSE stop_loss
        END,
        take_profit = CASE
          WHEN direcao = 'COMPRA' THEN preco_entrada * (1 + ${TP_PCT})
          WHEN direcao = 'VENDA'  THEN preco_entrada * (1 - ${TP_PCT})
          ELSE take_profit
        END
        WHERE preco_entrada IS NOT NULL AND preco_entrada > 0
      `);
    });
    tx();
  }

  _seedParams() {
    const stmt = this.db.prepare(
      'INSERT OR IGNORE INTO adaptive_params (key, value) VALUES (?, ?)'
    );
    const tx = this.db.transaction(() => {
      for (const [k, v] of Object.entries(DEFAULT_PARAMS)) stmt.run(k, v);
    });
    tx();
  }

  // Prepared statements de hot path (gravação de velas no sync em lote e nas
  // mensagens do scanner). Compilados uma única vez em init(); o UPSERT
  // condicional (`WHERE ... IS NOT excluded...`) evita reescritas idênticas,
  // pelo que r.changes conta apenas mudanças reais.
  _prepareStatements() {
    this._stmtUpsertPrice = this.db.prepare(`
      INSERT INTO historical_prices (ticker, date, open, high, low, close, volume)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(ticker, date) DO UPDATE SET
        open = excluded.open, high = excluded.high, low = excluded.low,
        close = excluded.close, volume = excluded.volume
      WHERE historical_prices.open IS NOT excluded.open
         OR historical_prices.high IS NOT excluded.high
         OR historical_prices.low IS NOT excluded.low
         OR historical_prices.close IS NOT excluded.close
         OR historical_prices.volume IS NOT excluded.volume
    `);

    this._insertRecentCandleStmt = this.db.prepare(`
      INSERT OR REPLACE INTO historical_prices (ticker, date, open, high, low, close, volume)
      VALUES (@ticker, @date, @open, @high, @low, @close, @volume)
    `);

    this._insertBatchTransaction = this.db.transaction((candlesList) => {
      let count = 0;
      for (const candle of candlesList) {
        this._insertRecentCandleStmt.run({
          ticker: String(candle.ticker).trim().toUpperCase(),
          date: String(candle.date).slice(0, 10),
          open: Number(candle.open),
          high: Number(candle.high),
          low: Number(candle.low),
          close: Number(candle.close),
          volume: Number(candle.volume || 0)
        });
        count++;
      }
      return count;
    });
  }

  getAdaptiveParams() {
    const rows = this.db.prepare('SELECT key, value FROM adaptive_params').all();
    const out = { ...DEFAULT_PARAMS };
    for (const r of rows) out[r.key] = r.value;
    return out;
  }

  setAdaptiveParam(key, value) {
    this.db.prepare(
      'INSERT INTO adaptive_params (key, value) VALUES (?, ?) ' +
      'ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    ).run(key, value);
  }

  insertSignal(s) {
    const stmt = this.db.prepare(`
      INSERT INTO historical_signals
        (ticker, date, preco_entrada, direcao, edge, p_stay, atr_14, stop_loss, take_profit, status, resultado_pct)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'aberto', NULL)
    `);
    const info = stmt.run(
      s.ticker, s.date, s.preco_entrada ?? s.close,
      s.direcao, s.edge, s.p_stay, s.atr_14 ?? 0,
      s.stop_loss ?? null, s.take_profit ?? null
    );
    return info.lastInsertRowid;
  }

  getOpenTrades() {
    return this.db.prepare(
      "SELECT * FROM historical_signals WHERE status = 'aberto' OR resultado_pct IS NULL ORDER BY date ASC"
    ).all();
  }

  getClosedTrades(limit = 100) {
    return this.db.prepare(
      "SELECT * FROM historical_signals WHERE status = 'fechado' ORDER BY date DESC LIMIT ?"
    ).all(limit);
  }

  closeTrade(id, resultadoPct, reason = 'manual') {
    this.db.prepare(
      "UPDATE historical_signals SET status = 'fechado', resultado_pct = ?, closed_at = ?, close_reason = ? WHERE id = ?"
    ).run(resultadoPct, new Date().toISOString().slice(0, 10), reason, id);
  }

  cacheOHLCV(ticker, candles) {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO ohlcv_cache
        (ticker, date, open, high, low, close, volume, fetched_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const now = new Date().toISOString();
    const tx = this.db.transaction(() => {
      for (const c of candles) {
        stmt.run(ticker, c.date, c.open, c.high, c.low, c.close, c.volume, now);
      }
    });
    tx();
  }

  getCachedOHLCV(ticker, maxAgeMs = 24 * 3600 * 1000) {
    const rows = this.db.prepare(`
      SELECT date, open, high, low, close, volume
      FROM ohlcv_cache
      WHERE ticker = ?
        AND datetime(fetched_at) > datetime('now', ?)
      ORDER BY date ASC
    `).all(ticker, `-${Math.floor(maxAgeMs / 1000)} seconds`);
    if (rows.length < 200) return null;
    return rows.map(r => ({ ticker, ...r }));
  }

  addCustomTicker(t) {
    const country = String(t.country || '').trim();
    const indexName = canonicalIndexId(t.indexName || t.index_name || t.index || '');
    const ticker = canonicalTicker(t.ticker);
    this.db.prepare(`
      INSERT INTO custom_tickers (ticker, name, exchange, type, country, index_name)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(ticker) DO UPDATE SET
        name = CASE WHEN NULLIF(excluded.name, '') IS NULL THEN custom_tickers.name ELSE excluded.name END,
        exchange = CASE WHEN NULLIF(excluded.exchange, '') IS NULL THEN custom_tickers.exchange ELSE excluded.exchange END,
        type = CASE WHEN NULLIF(excluded.type, '') IS NULL THEN custom_tickers.type ELSE excluded.type END,
        country = CASE WHEN NULLIF(excluded.country, '') IS NULL THEN custom_tickers.country ELSE excluded.country END,
        index_name = CASE WHEN NULLIF(excluded.index_name, '') IS NULL THEN custom_tickers.index_name ELSE excluded.index_name END
    `).run(ticker, t.name || '', t.exchange || '', t.type || '', country, indexName);
  }

  addCustomTickersBulk(list) {
    if (!Array.isArray(list) || list.length === 0) return { changes: 0 };
    const stmt = this.db.prepare(`
      INSERT INTO custom_tickers (ticker, name, exchange, type, country, index_name)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(ticker) DO UPDATE SET
        name = excluded.name,
        exchange = excluded.exchange,
        type = excluded.type,
        country = CASE WHEN NULLIF(excluded.country, '') IS NULL THEN custom_tickers.country ELSE excluded.country END,
        index_name = CASE WHEN NULLIF(excluded.index_name, '') IS NULL THEN custom_tickers.index_name ELSE excluded.index_name END
    `);
    const stockStmt = this.db.prepare(`
      INSERT INTO stocks (ticker, name, country, index_name, first_date, full_history_fetched)
      VALUES (?, ?, ?, ?, NULL, COALESCE(?, 0))
      ON CONFLICT(ticker) DO UPDATE SET
        name = CASE WHEN NULLIF(excluded.name, '') IS NULL THEN stocks.name ELSE excluded.name END,
        country = CASE WHEN NULLIF(excluded.country, '') IS NULL THEN stocks.country ELSE excluded.country END,
        index_name = CASE WHEN NULLIF(excluded.index_name, '') IS NULL THEN stocks.index_name ELSE excluded.index_name END
    `);
    const tx = this.db.transaction((items) => {
      let changes = 0;
      for (const item of items) {
        const tk = String(item.ticker || '').toUpperCase().trim();
        if (!tk) continue;
        const r = stmt.run(
          tk,
          item.name || item.nome || '',
          item.exchange || item.mercado || '',
          item.type || item.tipo || '',
          item.country || '',
          canonicalIndexId(item.indexName || item.index_name || item.index || '')
        );
        changes += r.changes || 0;
        // Manter a tabela `stocks` em sincronia para que o "1º Registo" e o
        // validador de estado do índice cubram os ativos adicionados em bloco
        // (mesmo comportamento do addCustomTicker + upsertStock no add individual).
        const fullHistory = item.fullHistoryFetched ?? item.full_history_fetched;
        stockStmt.run(
          tk,
          item.name || item.nome || '',
          item.country || '',
          canonicalIndexId(item.indexName || item.index_name || item.index || ''),
          fullHistory == null || String(fullHistory).trim() === '' ? null : (Number(fullHistory) ? 1 : 0)
        );
      }
      return changes;
    });
    const changes = tx(list);
    return { changes, total: list.length };
  }

  removeCustomTicker(ticker) {
    this.db.prepare('DELETE FROM custom_tickers WHERE ticker = ?').run(ticker);
  }

  getCustomTickers() {
    return this.db.prepare(
      'SELECT ticker, name, exchange, type FROM custom_tickers ORDER BY added_at ASC'
    ).all();
  }

  clearCustomTickers() {
    this.db.prepare('DELETE FROM custom_tickers').run();
  }

  addActiveTrade(trade) {
    const stmt = this.db.prepare(`
      INSERT INTO active_trades
        (ticker, nome, direcao, preco_entrada, stop_loss, take_profit, data_entrada, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'aberto')
    `);
    return stmt.run(
      trade.ticker, trade.nome || '',
      trade.direcao, trade.preco_entrada,
      trade.stop_loss, trade.take_profit,
      trade.data_entrada || new Date().toISOString().slice(0, 10)
    );
  }

  getActiveTrades() {
    return this.db.prepare(
      "SELECT * FROM active_trades WHERE status = 'aberto' ORDER BY data_entrada DESC"
    ).all();
  }

  getClosedActiveTrades(limit = 50) {
    return this.db.prepare(
      "SELECT * FROM active_trades WHERE status = 'fechado' ORDER BY fechado_em DESC LIMIT ?"
    ).all(limit);
  }

  closeActiveTrade(id, precoFecho, resultadoPct, motivo = 'auto') {
    this.db.prepare(`
      UPDATE active_trades
      SET status = 'fechado', resultado_pct = ?, preco_fecho = ?,
          motivo_fecho = ?, fechado_em = ?
      WHERE id = ?
    `).run(resultadoPct, precoFecho, motivo, new Date().toISOString().slice(0, 10), id);
  }

  removeActiveTrade(id) {
    return this.db.prepare('DELETE FROM active_trades WHERE id = ?').run(id);
  }

  clearActiveTrades() {
    return this.db.prepare("DELETE FROM active_trades WHERE status = 'aberto'").run();
  }

  clearClosedTrades() {
    return this.db.prepare("DELETE FROM active_trades WHERE status = 'fechado'").run();
  }

  addShortcut(tickerOrArray, nome, mercado, tipo = '') {
    if (Array.isArray(tickerOrArray)) {
      const stmt = this.db.prepare(`
        INSERT OR IGNORE INTO market_shortcuts (ticker, nome, mercado, tipo)
        VALUES (?, ?, ?, ?)
      `);
      const tx = this.db.transaction((list) => {
        for (const item of list) {
          const t = String(item.ticker || '').toUpperCase().trim();
          if (!t) continue;
          stmt.run(
            t,
            item.name || item.nome || item.ticker,
            item.exchange || item.mercado || '',
            item.type || item.tipo || ''
          );
        }
      });
      tx(tickerOrArray);
      return { changes: tickerOrArray.length };
    }

    return this.db.prepare(`
      INSERT OR IGNORE INTO market_shortcuts (ticker, nome, mercado, tipo)
      VALUES (?, ?, ?, ?)
    `).run(String(tickerOrArray).toUpperCase().trim(), nome || tickerOrArray, mercado || '', tipo || '');
  }

  getShortcuts() {
    return this.db.prepare(
      'SELECT id, ticker, nome, mercado, tipo, added_at FROM market_shortcuts ORDER BY added_at ASC, ticker ASC'
    ).all();
  }

  removeShortcut(ticker) {
    return this.db.prepare('DELETE FROM market_shortcuts WHERE ticker = ?')
      .run(String(ticker).toUpperCase().trim());
  }

  // ═══════════════════════════════════════════════════════════
  //  HISTORICAL PRICES — Cache permanente de OHLCV
  // ═══════════════════════════════════════════════════════════

  saveHistoricalCandles(tickerOrCandles, maybeCandles) {
    let ticker = null;
    let candles = [];
    if (typeof tickerOrCandles === 'string') {
      ticker = tickerOrCandles;
      candles = Array.isArray(maybeCandles) ? maybeCandles : [];
    } else if (Array.isArray(tickerOrCandles)) {
      candles = tickerOrCandles;
    }
    if (!Array.isArray(candles) || candles.length === 0) return { changes: 0 };

    const formatted = candles.map(c => ({
      ticker: canonicalTicker(c.ticker || ticker),
      date: String(c.date || '').slice(0, 10),
      open: Number(c.open),
      high: Number(c.high),
      low: Number(c.low),
      close: Number(c.close),
      volume: Number(c.volume || 0)
    })).filter(c => c.ticker && c.date && Number.isFinite(c.close));

    if (formatted.length === 0) return { changes: 0 };

    // Statement hoisted em _prepareStatements() — chamado por ticker no ciclo
    // de mensagens do scanner worker, não deve recompilar por invocação.
    const stmt = this._stmtUpsertPrice;

    const tx = this.db.transaction((candlesList) => {
      let changes = 0;
      for (const candle of candlesList) {
        const r = stmt.run(
          candle.ticker,
          candle.date,
          candle.open,
          candle.high,
          candle.low,
          candle.close,
          candle.volume
        );
        changes += r.changes || 0;
      }
      // Preencher first_date automaticamente quando ainda não existe:
      // usa a data mais antiga do histórico armazenado como referência da origem.
      const tickerSet = new Set();
      for (const c of candlesList) {
        if (c.ticker) tickerSet.add(c.ticker);
      }
      for (const t of tickerSet) {
        const stock = this.db.prepare('SELECT first_date FROM stocks WHERE ticker = ?').get(t);
        if (stock && (!stock.first_date || String(stock.first_date).trim() === '')) {
          const histRow = this.db.prepare(
            'SELECT MIN(date) as min_date FROM historical_prices WHERE ticker = ?'
          ).get(t);
          const trueFirstDate = histRow && histRow.min_date ? histRow.min_date : null;
          if (trueFirstDate) this.updateStockFirstDate(t, trueFirstDate);
        }
      }
      return changes;
    });

    return { changes: tx(formatted) };
  }

  // Gravação segura de histórico descarregado. Aceita (ticker, candles) para um
  // ativo ou a forma legada de lote (entries) com [{ ticker, candles }]. Após
  // gravar, recalcula e fixa imediatamente o MIN(date) real na tabela stocks —
  // nunca a data do download — para que o "PRIMEIRO REGISTO" não regresse a
  // uma data recente quando o lote descarregado é parcial.
  saveHistoricalCandlesBatch(ticker, maybeCandles) {
    let entries = null;
    if (typeof ticker === 'string') {
      const cleanTicker = canonicalTicker(ticker);
      entries = (Array.isArray(maybeCandles) ? maybeCandles : []).map(c => ({
        ticker: cleanTicker,
        candles: [c]
      }));
    } else if (Array.isArray(ticker)) {
      entries = ticker;
    }
    if (!Array.isArray(entries) || entries.length === 0) return { changes: 0 };

    // UPSERT condicional hoisted em _prepareStatements(): reenvios idênticos
    // contam 0 e atualizações contam 1 — preserva o contrato de {changes}.
    const stmt = this._stmtUpsertPrice || this.db.prepare(`
      INSERT INTO historical_prices (ticker, date, open, high, low, close, volume)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(ticker, date) DO UPDATE SET
        open = excluded.open, high = excluded.high, low = excluded.low,
        close = excluded.close, volume = excluded.volume
      WHERE historical_prices.open IS NOT excluded.open
         OR historical_prices.high IS NOT excluded.high
         OR historical_prices.low IS NOT excluded.low
         OR historical_prices.close IS NOT excluded.close
         OR historical_prices.volume IS NOT excluded.volume
    `);

    const tx = this.db.transaction((list) => {
      let changes = 0;
      for (const entry of list) {
        for (const c of entry.candles) {
          const date = String(c.date || '').slice(0, 10);
          const close = Number(c.close);
          if (!date || !Number.isFinite(close)) continue;
          changes += stmt.run(
            canonicalTicker(entry.ticker),
            date,
            Number(c.open),
            Number(c.high),
            Number(c.low),
            close,
            Number(c.volume || 0)
          ).changes || 0;
        }
      }
      return changes;
    });

    const changes = tx(entries);

    // Recalcular e fixar imediatamente o MIN(date) real na tabela stocks.
    const tickerSet = new Set(entries.map(e => canonicalTicker(e.ticker)).filter(Boolean));
    for (const t of tickerSet) {
      this.getStockHistorySummary(t);
    }

    return { changes };
  }

  // API flat para gravação consolidada via IPC: recebe velas já "achatadas"
  // [{ ticker, date:'YYYY-MM-DD', open, high, low, close, volume }] numa
  // única transação. Coerção defensiva por linha; linhas inválidas (sem
  // ticker/data ou preços não finitos) são ignoradas sem abortar o lote.
  // Devolve { changes, skipped }: changes tem a mesma semântica do método
  // acima (soma de r.changes do UPSERT condicional).
  saveBulkHistoricalCandles(candlesArray) {
    if (!Array.isArray(candlesArray) || candlesArray.length === 0) {
      return { changes: 0, skipped: 0 };
    }

    const stmt = this._stmtUpsertPrice;

    const tx = this.db.transaction((rows) => {
      let changes = 0;
      let skipped = 0;
      for (const raw of rows) {
        const row = raw || {};
        const ticker = canonicalTicker(row.ticker);
        const date = String(row.date || '').slice(0, 10);
        const open = Number(row.open);
        const high = Number(row.high);
        const low = Number(row.low);
        const close = Number(row.close);
        const volumeNum = Number(row.volume || 0);
        const volume = Number.isFinite(volumeNum) ? volumeNum : 0;

        // NaN/Infinity não são vinculáveis pelo better-sqlite3: filtra antes
        // de correr o statement para nunca abortar o lote inteiro.
        if (!ticker || !date || !Number.isFinite(close)
          || !Number.isFinite(open) || !Number.isFinite(high) || !Number.isFinite(low)) {
          skipped++;
          continue;
        }

        const r = stmt.run(ticker, date, open, high, low, close, volume);
        changes += r.changes || 0;
      }
      return { changes, skipped };
    });

    const { changes, skipped } = tx(candlesArray);
    return { changes, skipped };
  }

  getLocalHistoricalPrices(ticker, limit = 300) {
    const rows = this.db.prepare(`
      SELECT date, open, high, low, close, volume
      FROM historical_prices
      WHERE ticker = ?
      ORDER BY date DESC
      LIMIT ?
    `).all(ticker, limit);

    if (!rows || rows.length === 0) {
      return [];
    }

    return rows.reverse().map(row => ({
      date: row.date,
      open: Number(row.open),
      high: Number(row.high),
      low: Number(row.low),
      close: Number(row.close),
      volume: Number(row.volume)
    }));
  }

  getLocalHistoricalPricesLimit(ticker, limit) {
    const rows = this.db.prepare(`
      SELECT date, open, high, low, close, volume
      FROM historical_prices
      WHERE ticker = ?
      ORDER BY date DESC
      LIMIT ?
    `).all(ticker, limit);

    if (!rows || rows.length === 0) {
      return [];
    }

    return rows.reverse().map(row => ({
      date: row.date,
      open: Number(row.open),
      high: Number(row.high),
      low: Number(row.low),
      close: Number(row.close),
      volume: Number(row.volume)
    }));
  }

  getHistoricalPricesForScan(ticker) {
    const cleanTicker = String(ticker).trim().toUpperCase();
    const rows = this.db.prepare(`
      SELECT date, open, high, low, close, volume
      FROM historical_prices
      WHERE ticker = ?
      ORDER BY date DESC
      LIMIT 300
    `).all(cleanTicker).reverse();
    return rows.map(r => ({
      date: String(r.date).slice(0, 10),
      open: Number(r.open),
      high: Number(r.high),
      low: Number(r.low),
      close: Number(r.close),
      volume: Number(r.volume || 0)
    }));
  }

  getAllHistoricalPrices(ticker) {
    const rows = this.db.prepare(`
      SELECT date, open, high, low, close, volume
      FROM historical_prices
      WHERE ticker = ?
      ORDER BY date ASC
    `).all(canonicalTicker(ticker));

    return rows.map(row => ({
      date: row.date,
      open: Number(row.open),
      high: Number(row.high),
      low: Number(row.low),
      close: Number(row.close),
      volume: Number(row.volume)
    }));
  }

  // Extração dedicada à simulação: carrega 100% do histórico guardado
  // (cenário A) ou o intervalo pedido com um buffer de warm-up de 200
  // velas anteriores à data inicial (cenário B). Nunca trunca o histórico
  // além da subquery de warm-up. Datas normalizadas para YYYY-MM-DD,
  // valores coerzidos para Number e ordenação estrita ASC.
  getHistoricalPricesForSimulation(ticker, startDate = null, endDate = null) {
    if (!ticker) return [];
    const cleanTicker = canonicalTicker(ticker);

    const toRow = (r) => ({
      date: String(r.date).slice(0, 10),
      open: Number(r.open),
      high: Number(r.high),
      low: Number(r.low),
      close: Number(r.close),
      volume: Number(r.volume || 0)
    });

    // CENÁRIO A: Sem filtro de data — 100% dos dados guardados
    if (!startDate && !endDate) {
      const rows = this.db.prepare(`
        SELECT date, open, high, low, close, volume
        FROM historical_prices
        WHERE ticker = ?
        ORDER BY date ASC
      `).all(cleanTicker);
      return rows.map(toRow);
    }

    // CENÁRIO B: Intervalo definido com warm-up prévio de 200 velas
    const cleanStart = String(startDate).slice(0, 10);
    const cleanEnd = endDate ? String(endDate).slice(0, 10) : '9999-12-31';

    const warmupRows = this.db.prepare(`
      SELECT date, open, high, low, close, volume
      FROM historical_prices
      WHERE ticker = ? AND date < ?
      ORDER BY date DESC
      LIMIT 200
    `).all(cleanTicker, cleanStart).reverse();

    const mainRows = this.db.prepare(`
      SELECT date, open, high, low, close, volume
      FROM historical_prices
      WHERE ticker = ? AND date >= ? AND date <= ?
      ORDER BY date ASC
    `).all(cleanTicker, cleanStart, cleanEnd);

    return [...warmupRows, ...mainRows].map(toRow);
  }

  getTickerDataRange(ticker) {
    const row = this.db.prepare(`
      SELECT 
        ticker,
        MIN(date) AS first_date,
        MAX(date) AS last_date,
        COUNT(*) AS total_candles
      FROM historical_prices
      WHERE ticker = ?
      GROUP BY ticker
    `).get(ticker);

    return row || null;
  }

  getLastStoredDate(ticker) {
    const row = this.db.prepare(`
      SELECT MAX(date) as last_date
      FROM historical_prices
      WHERE ticker = ?
    `).get(ticker);

    return row && row.last_date ? row.last_date : null;
  }

  getAllHistoricalMaxDates() {
    const rows = this.db.prepare(`
      SELECT ticker, MAX(date) as last_date
      FROM historical_prices
      GROUP BY ticker
    `).all();

    const map = new Map();
    for (const r of rows) {
      if (r && r.ticker) {
        map.set(canonicalTicker(r.ticker), r.last_date ? String(r.last_date).slice(0, 10) : null);
      }
    }
    return map;
  }

  // ═══════════════════════════════════════════════════════════
  //  STOCKS — Metadata for imported assets
  // ═══════════════════════════════════════════════════════════

  getStockByTicker(ticker) {
    return this.db.prepare(
      'SELECT ticker, name, country, index_name, first_date, full_history_fetched FROM stocks WHERE ticker = ?'
    ).get(canonicalTicker(ticker));
  }

  getStocksByIndex(indexName = null) {
    if (!indexName || indexName === 'ALL') {
      return this.db.prepare(`SELECT * FROM stocks ORDER BY ticker ASC`).all();
    }
    const indexId = canonicalIndexId(indexName);
    return this.db.prepare(`
      SELECT * FROM stocks
      WHERE index_name = ?
      ORDER BY ticker ASC
    `).all(indexId);
  }

  checkIndexDataStatus(indexName) {
    const stocks = this.getStocksByIndex(indexName);
    if (!stocks || stocks.length === 0) {
      return { hasStocks: false, hasPrices: false, totalStocks: 0, stocksWithDataCount: 0, stocks: [] };
    }
    const tickers = stocks.map(s => s.ticker);
    const placeholders = tickers.map(() => '?').join(',');
    const result = this.db.prepare(`
      SELECT COUNT(DISTINCT ticker) as stocksWithData
      FROM historical_prices
      WHERE ticker IN (${placeholders})
    `).get(...tickers);
    return {
      hasStocks: true,
      hasPrices: (result ? result.stocksWithData > 0 : false),
      totalStocks: stocks.length,
      stocksWithDataCount: (result ? result.stocksWithData : 0),
      stocks
    };
  }

  checkIndexStatus(indexName) {
    const stocks = this.getStocksByIndex(indexName);
    if (!stocks || stocks.length === 0) {
      return {
        status: 'pendente-primeiro-registo',
        label: 'Pendente: 1º Registo',
        complete: false,
        totalStocks: 0,
        stocksCompleteCount: 0,
        expectedDate: this.getLastExpectedTradingDay(),
        stocks: [],
        missing: ['first-date']
      };
    }

    const tickers = stocks.map(s => s.ticker);
    const placeholders = tickers.map(() => '?').join(',');
    const prices = this.db.prepare(`
      SELECT ticker,
             MIN(date) as min_date,
             MAX(date) as max_date,
             COUNT(*) as total_candles
      FROM historical_prices
      WHERE ticker IN (${placeholders})
      GROUP BY ticker
    `).all(...tickers);

    const priceMap = {};
    for (const row of prices) priceMap[row.ticker] = row;

    const expectedDate = this.getLastExpectedTradingDay();

    const details = stocks.map((s) => {
      const p = priceMap[s.ticker] || null;
      const hasData = !!p && p.total_candles > 0;
      const firstDate = s.first_date || null;
      const minDate = p ? p.min_date : null;
      const maxDate = p ? p.max_date : null;
      const fullHistoryFetched = !!s.full_history_fetched;

      let cardState;
      if (!hasData) cardState = 'card-pending';
      else if (maxDate && expectedDate && maxDate >= expectedDate) cardState = 'card-synced';
      else cardState = 'card-outdated';

      const historyFromOrigin = hasData && !!firstDate && (
        fullHistoryFetched ||
        (minDate && minDate <= firstDate)
      );

      const missing = [];
      if (!firstDate) missing.push('first-date');
      if (!hasData) missing.push('history');
      else if (!historyFromOrigin) missing.push('first-registo');
      if (cardState === 'card-outdated') missing.push('recent');

      return {
        ticker: s.ticker,
        name: s.name,
        indexName: s.index_name,
        firstDate,
        minDate,
        maxDate,
        fullHistoryFetched,
        hasData,
        cardState,
        historyFromOrigin: !!historyFromOrigin,
        missing
      };
    });

    const stocksCompleteCount = details.filter(d =>
      d.hasData && d.historyFromOrigin && d.cardState === 'card-synced'
    ).length;

    let status;
    const hasAnyFirstRegistoMissing = details.some(d => !d.historyFromOrigin || !d.firstDate || !d.hasData);
    const hasAnyOutdated = details.some(d => d.cardState === 'card-outdated');

    if (details.length > 0 && stocksCompleteCount === details.length) {
      status = 'COMPLETO';
    } else if (hasAnyFirstRegistoMissing) {
      status = 'pendente-primeiro-registo';
    } else if (hasAnyOutdated) {
      status = 'pendente-recente';
    } else {
      status = 'pendente-primeiro-registo';
    }

    const labels = {
      'COMPLETO': 'COMPLETO',
      'pendente-primeiro-registo': 'Pendente: 1º Registo',
      'pendente-recente': 'Pendente: Recente'
    };

    return {
      status,
      label: labels[status] || status,
      complete: status === 'COMPLETO',
      hasStocks: details.length > 0,
      totalStocks: details.length,
      stocksCompleteCount,
      expectedDate,
      missing: details.reduce((acc, d) => acc.concat(d.missing), []),
      stocks: details
    };
  }

  // Complementar à checkIndexStatus: auditoria com o intervalo real de
  // cotações armazenado e a lista de ativos pendentes de 1º registo.
  auditIndexStocks(indexName) {
    const stocks = this.getStocksByIndex(indexName);
    const canonicalName = (indexName && indexName !== 'ALL') ? canonicalIndexId(indexName) : indexName;

    if (!stocks || stocks.length === 0) {
      return {
        indexName: canonicalName || indexName || 'ALL',
        totalStocks: 0,
        completeCount: 0,
        pendingCount: 0,
        stocks: []
      };
    }

    const tickers = stocks.map(s => s.ticker);
    const placeholders = tickers.map(() => '?').join(',');
    // Query agregada (sem N+1) com o intervalo real por ativo.
    const priceRows = this.db.prepare(`
      SELECT ticker,
             MIN(date) as min_date,
             MAX(date) as max_date,
             COUNT(*) as total_candles
      FROM historical_prices
      WHERE ticker IN (${placeholders})
      GROUP BY ticker
    `).all(...tickers);

    const priceMap = {};
    for (const row of priceRows) priceMap[row.ticker] = row;

    const oneYearAfter = (firstDate) => {
      const d = new Date(firstDate + 'T00:00:00Z');
      if (Number.isNaN(d.getTime())) return null;
      d.setUTCFullYear(d.getUTCFullYear() + 1);
      return d.toISOString().slice(0, 10);
    };

    const details = stocks.map((s) => {
      const p = priceMap[s.ticker] || null;
      const firstDate = s.first_date ? String(s.first_date).trim() : '';
      const minDate = p ? p.min_date : null;
      const maxDate = p ? p.max_date : null;
      const totalCandles = p ? p.total_candles : 0;
      const fullHistoryFetched = !!s.full_history_fetched;

      const needsFirstDate = !firstDate;
      const hasStoredData = totalCandles > 0;
      const toleranceDate = firstDate ? oneYearAfter(firstDate) : null;
      // Sem registos OU min_date substancialmente mais recente que a origem
      // (tolerância ~1 ano) => falta descarregar o bloco antigo.
      const minTooRecent = !!toleranceDate && !!minDate && minDate > toleranceDate;
      const needsHistoricalDownload = !hasStoredData || (!!firstDate && !minDate) || minTooRecent;

      const historyFromOrigin = !needsFirstDate && hasStoredData && (
        fullHistoryFetched ||
        (!!minDate && minDate <= firstDate)
      );

      return {
        ticker: s.ticker,
        name: s.name,
        country: s.country,
        indexName: s.index_name,
        firstDate: firstDate || null,
        fullHistoryFetched,
        minStoredDate: minDate,
        maxStoredDate: maxDate,
        totalStoredCandles: totalCandles,
        needsFirstDate,
        needsHistoricalDownload,
        historyFromOrigin,
        isComplete: !needsFirstDate && hasStoredData && historyFromOrigin
      };
    });

    const completeCount = details.filter(d => d.isComplete).length;

    return {
      indexName: canonicalName || indexName || 'ALL',
      totalStocks: details.length,
      completeCount,
      pendingCount: details.length - completeCount,
      stocks: details
    };
  }

  upsertStock(stock) {
    const ticker = canonicalTicker(stock.ticker);
    const name = String(stock.name || '').trim();
    const country = String(stock.country || '').trim();
    const indexName = canonicalIndexId(stock.indexName || stock.index_name || stock.index || '');
    const rawFirstDate = stock.firstDate ?? stock.first_date;
    const firstDate = rawFirstDate == null || String(rawFirstDate).trim() === '' ? null : String(rawFirstDate).trim();
    const fullHistoryInput = stock.fullHistoryFetched ?? stock.full_history_fetched;
    const hasFullHistory = fullHistoryInput != null && String(fullHistoryInput).trim() !== '';
    const fullHistoryFetched = hasFullHistory
      ? (Number(fullHistoryInput) ? 1 : 0)
      : null;
    return this.db.prepare(`
      INSERT INTO stocks (ticker, name, country, index_name, first_date, full_history_fetched)
      VALUES (?, ?, ?, ?, ?, COALESCE(?, 0))
      ON CONFLICT(ticker) DO UPDATE SET
        name = CASE WHEN NULLIF(excluded.name, '') IS NULL THEN stocks.name ELSE excluded.name END,
        country = CASE WHEN NULLIF(excluded.country, '') IS NULL THEN stocks.country ELSE excluded.country END,
        index_name = CASE WHEN NULLIF(excluded.index_name, '') IS NULL THEN stocks.index_name ELSE excluded.index_name END,
        first_date = CASE WHEN NULLIF(excluded.first_date, '') IS NULL THEN stocks.first_date ELSE excluded.first_date END,
        full_history_fetched = COALESCE(?, stocks.full_history_fetched)
    `).run(ticker, name, country, indexName, firstDate, fullHistoryFetched, fullHistoryFetched);
  }

  setFullHistoryFetched(ticker) {
    this.db.prepare('UPDATE stocks SET full_history_fetched = 1 WHERE ticker = ?').run(ticker);
  }

  updateStockFirstDate(ticker, firstDate) {
    const symbol = canonicalTicker(ticker);
    const baseSymbol = symbol.replace(/\.[A-Z]{1,4}$/i, '');
    const value = firstDate == null || String(firstDate).trim() === '' ? null : String(firstDate).trim().slice(0, 10);
    return this.db.prepare(`
      UPDATE stocks 
      SET first_date = ? 
      WHERE UPPER(TRIM(ticker)) = UPPER(TRIM(?)) OR UPPER(TRIM(ticker)) = UPPER(TRIM(?))
    `).run(value, symbol, baseSymbol);
  }

  updateStockMetadata(ticker, data) {
    const symbol = canonicalTicker(ticker);
    if (!symbol) return { success: false, error: 'invalid-input' };

    // Empty/NULL fields stay untouched (COALESCE): only non-empty values are
    // actually updated.  Whitespace-only strings are converted to NULL so the
    // COALESCE keeps the current column value.
    const clean = (value) => {
      if (value == null) return null;
      const s = String(value).trim();
      return s === '' ? null : s;
    };

    const name = clean(data && data.name);
    const country = clean(data && data.country);
    // Normalize the index via canonicalIndexId for consistency with the rest
    // of the app (labels → stable id).  Custom/new index names are accepted:
    // canonicalIndexId returns the raw value when the id is unknown.
    const rawIndex = clean(data && data.index_name);
    const indexName = rawIndex ? canonicalIndexId(rawIndex) : null;

    if (!name && !country && !indexName) return { success: false, error: 'invalid-input' };

    // Exact ticker only (unlike updateStockFirstDate, no base-variant update).
    // Update BOTH tables: `stocks` (source of truth for the detail modal) and
    // `custom_tickers` (what feeds the My List cards / hover card). Keeping them
    // in sync guarantees the edit is reflected immediately in the UI.
    const updateStocks = this.db.prepare(`
      UPDATE stocks SET
        name = COALESCE(?, name),
        country = COALESCE(?, country),
        index_name = COALESCE(?, index_name)
      WHERE ticker = ?
    `);
    const updateCustom = this.db.prepare(`
      UPDATE custom_tickers SET
        name = COALESCE(?, name),
        country = COALESCE(?, country),
        index_name = COALESCE(?, index_name)
      WHERE ticker = ?
    `);

    const tx = this.db.transaction(() => {
      const stockResult = updateStocks.run(name, country, indexName, symbol);
      updateCustom.run(name, country, indexName, symbol);
      return stockResult.changes;
    });

    return { success: true, ticker: symbol, changes: tx() };
  }

  // Distinct index_name values stored in `stocks` (stable ids after
  // canonicalIndexId normalization), sorted ASC.  Empty/NULL names are
  // excluded; returns an empty array when no stocks exist.
  getAllDistinctIndices() {
    const rows = this.db.prepare(`
      SELECT DISTINCT index_name
      FROM stocks
      WHERE index_name IS NOT NULL AND TRIM(index_name) != ''
      ORDER BY index_name ASC
    `).all();
    return rows.map(r => r.index_name);
  }

  // Países distintos já guardados (stocks + custom_tickers), limpos e por
  // ordem alfabética. Alimenta o autocomplete do campo "País" no modal de
  // adição de ativos; quando um país ainda não existe, é gravado no submit.
  getAllDistinctCountries() {
    const rows = this.db.prepare(`
      SELECT DISTINCT TRIM(country) AS country
      FROM (
        SELECT country FROM stocks
        UNION
        SELECT country FROM custom_tickers
      )
      WHERE country IS NOT NULL AND TRIM(country) != ''
      ORDER BY country ASC
    `).all();
    return rows.map(r => r.country);
  }

  getFullHistoryFetched(ticker) {
    const row = this.db.prepare('SELECT full_history_fetched FROM stocks WHERE ticker = ?').get(canonicalTicker(ticker));
    return row ? !!row.full_history_fetched : false;
  }

  saveHistoricalCandlesFromImport(ticker, candles) {
    if (!Array.isArray(candles) || candles.length === 0) return { changes: 0 };

    const canTicker = canonicalTicker(ticker);
    const sorted = [...candles].sort((a, b) => (a.date > b.date ? 1 : a.date < b.date ? -1 : 0));
    const stmt = this._stmtUpsertPrice || this.db.prepare(`
      INSERT INTO historical_prices (ticker, date, open, high, low, close, volume)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(ticker, date) DO UPDATE SET
        open = excluded.open, high = excluded.high, low = excluded.low,
        close = excluded.close, volume = excluded.volume
      WHERE historical_prices.open IS NOT excluded.open
         OR historical_prices.high IS NOT excluded.high
         OR historical_prices.low IS NOT excluded.low
         OR historical_prices.close IS NOT excluded.close
         OR historical_prices.volume IS NOT excluded.volume
    `);

    const tx = this.db.transaction((rows) => {
      let changes = 0;
      for (const c of rows) {
        const r = stmt.run(
          canTicker,
          c.date,
          c.open,
          c.high,
          c.low,
          c.close,
          c.volume
        );
        changes += r.changes || 0;
      }
      return changes;
    });

    const changes = tx(sorted);

    try {
      const stock = this.db.prepare('SELECT first_date FROM stocks WHERE UPPER(TRIM(ticker)) = ?').get(canTicker);
      if (stock && (!stock.first_date || String(stock.first_date).trim() === '')) {
        const histRow = this.db.prepare(
          'SELECT MIN(date) as min_date FROM historical_prices WHERE ticker = ?'
        ).get(canTicker);
        const trueFirstDate = histRow && histRow.min_date ? histRow.min_date : null;
        if (trueFirstDate) this.updateStockFirstDate(canTicker, trueFirstDate);
      }
    } catch (_) {}

    return { changes };
  }

  hasHistoricalData(ticker) {
    const row = this.db.prepare(
      'SELECT COUNT(*) as cnt FROM historical_prices WHERE ticker = ?'
    ).get(ticker);
    return row && row.cnt > 0;
  }

  getHistoricalSummary(ticker) {
    const symbol = canonicalTicker(ticker);
    const row = this.db.prepare(`
      SELECT 
        COALESCE(s.first_date, h.MIN_date) as first_date,
        h.MAX_date as last_date,
        h.total_candles,
        COALESCE(s.full_history_fetched, 0) as full_history_fetched
      FROM (
        SELECT 
          MIN(date) as MIN_date,
          MAX(date) as MAX_date,
          COUNT(*) as total_candles
        FROM historical_prices
        WHERE ticker = ?
      ) h
      LEFT JOIN stocks s ON s.ticker = ?
    `).get(symbol, symbol);

    if (!row || row.total_candles === 0) {
      return {
        hasData: false,
        firstDate: row?.first_date || null,
        lastDate: null,
        totalCandles: 0,
        fullHistoryFetched: false
      };
    }

    return {
      hasData: true,
      firstDate: row.first_date,
      lastDate: row.last_date,
      totalCandles: row.total_candles,
      fullHistoryFetched: !!row.full_history_fetched
    };
  }

  // Agregação resiliente dos limites reais do histórico local (MIN/MAX/COUNT)
  // que, além de devolver os limites, sincroniza a coluna first_date da
  // tabela stocks quando esta está nula ou divergente do MIN(date) real.
  getStockHistorySummary(ticker) {
    const cleanTicker = String(ticker).trim().toUpperCase();
    const row = this.db.prepare(`
      SELECT
        MIN(date) AS first_date,
        MAX(date) AS last_date,
        COUNT(*)  AS total_candles
      FROM historical_prices
      WHERE ticker = ?
    `).get(cleanTicker);

    if (!row || row.total_candles === 0) {
      return { first_date: null, last_date: null, total_candles: 0 };
    }

    // Corrige first_date divergendo do MIN(date) real (segurança adicional
    // à migração de arranque e aos saves incrementais).
    if (row.first_date) {
      try {
        const stock = this.db.prepare(
          'SELECT first_date FROM stocks WHERE UPPER(TRIM(ticker)) = ?'
        ).get(cleanTicker);
        const stored = stock && stock.first_date ? String(stock.first_date).trim() : '';
        if (!stored || stored !== String(row.first_date).trim()) {
          this.db.prepare(
            'UPDATE stocks SET first_date = ? WHERE UPPER(TRIM(ticker)) = ?'
          ).run(String(row.first_date).trim(), cleanTicker);
        }
      } catch (_) { /* não bloqueia a leitura */ }
    }

    return {
      first_date: row.first_date,
      last_date: row.last_date,
      total_candles: row.total_candles
    };
  }

  // Auditoria e reconciliação global: repõe o MIN(date) real de
  // historical_prices na coluna first_date de todos os ativos. Executada no
  // arranque da aplicação e sob pedido via IPC (reconcile-all-dates), para
  // que datas escritas por sincronizações incrementais recentes (ex.: o dia
  // de hoje) nunca sejam apresentadas como "PRIMEIRO REGISTO".
  reconcileAllStocksFirstDate() {
    try {
      // Garante que a coluna first_date existe na tabela stocks.
      const cols = this.db.prepare('PRAGMA table_info(stocks)').all();
      if (!cols.some(c => c.name === 'first_date')) {
        this.db.exec('ALTER TABLE stocks ADD COLUMN first_date TEXT');
      }

      // Garante o índice composto que acelera as agregações MIN/MAX/COUNT.
      this.db.exec('CREATE INDEX IF NOT EXISTS idx_hist_ticker_date ON historical_prices (ticker, date)');

      // Passo 1 — correspondência exata de ticker (usa o índice composto;
      // corre em milissegundos mesmo com milhões de velas). Os tickers são
      // gravados de forma canónica (UPPER + TRIM) em todos os caminhos de
      // escrita, pelo que o match exato cobre a esmagadora maioria dos casos.
      const fastResult = this.db.prepare(`
        UPDATE stocks
        SET first_date = (
          SELECT MIN(hp.date)
          FROM historical_prices hp
          WHERE hp.ticker = stocks.ticker
        )
        WHERE EXISTS (
          SELECT 1
          FROM historical_prices hp
          WHERE hp.ticker = stocks.ticker
        )
      `).run();

      // Passo 2 — resíduos legados cujo ticker diverge em caixa/trim (não
      // apanhados pelo match exato). Raro, por isso é aceitável pagar a
      // varredura UPPER(TRIM) apenas nesses ativos.
      const stragglersResult = this.db.prepare(`
        UPDATE stocks
        SET first_date = (
          SELECT MIN(hp.date)
          FROM historical_prices hp
          WHERE UPPER(TRIM(hp.ticker)) = UPPER(TRIM(stocks.ticker))
        )
        WHERE NOT EXISTS (
          SELECT 1
          FROM historical_prices hp
          WHERE hp.ticker = stocks.ticker
        )
        AND EXISTS (
          SELECT 1
          FROM historical_prices hp
          WHERE UPPER(TRIM(hp.ticker)) = UPPER(TRIM(stocks.ticker))
        )
      `).run();

      const updatedCount = (fastResult.changes || 0) + (stragglersResult.changes || 0);
      console.log(`[Reconciliação Concluída] Datas de 1º registo corrigidas para ${updatedCount} ativos.`);
      return { success: true, updatedCount };
    } catch (error) {
      console.error('[Erro na Reconciliação Global]:', error && error.message ? error.message : error);
      return { success: false, error: (error && error.message) || String(error) };
    }
  }

  getHistoricalSummaryBatch(tickers) {
    if (!Array.isArray(tickers) || tickers.length === 0) return {};

    const placeholders = tickers.map(() => '?').join(',');
    const rows = this.db.prepare(`
      SELECT 
        ticker,
        MIN(date) as first_date,
        MAX(date) as last_date,
        COUNT(*) as total_candles
      FROM historical_prices
      WHERE ticker IN (${placeholders})
      GROUP BY ticker
    `).all(...tickers);

    const fetchedRows = this.db.prepare(`
      SELECT ticker, first_date, full_history_fetched FROM stocks WHERE ticker IN (${placeholders})
    `).all(...tickers);

    const fetchedMap = {};
    const firstDateMap = {};
    for (const r of fetchedRows) {
      fetchedMap[r.ticker] = !!r.full_history_fetched;
      firstDateMap[r.ticker] = r.first_date || null;
    }

    const result = {};
    for (const row of rows) {
      result[row.ticker] = {
        hasData: row.total_candles > 0,
        firstDate: firstDateMap[row.ticker] || row.first_date || null,
        lastDate: row.last_date || null,
        totalCandles: row.total_candles || 0,
        fullHistoryFetched: fetchedMap[row.ticker] || false
      };
    }
    return result;
  }

  deleteHistoricalPrices(ticker) {
    const tx = this.db.transaction(() => {
      const result = this.db.prepare(
        'DELETE FROM historical_prices WHERE ticker = ?'
      ).run(canonicalTicker(ticker));
      // A deleted history is no longer a successfully fetched full history.
      this.db.prepare('UPDATE stocks SET full_history_fetched = 0 WHERE ticker = ?')
        .run(canonicalTicker(ticker));
      return result;
    });
    const result = tx();
    return { changes: result.changes || 0 };
  }

  // ═══════════════════════════════════════════════════════════
  //  PURGE INACTIVE STOCKS — Remover ativos inativos / antigos
  // ═══════════════════════════════════════════════════════════
  purgeInactiveStocks(daysCutoff = 60) {
    const cutoffDate = new Date(Date.now() - daysCutoff * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    // Obter todos os tickers ativos com registos de cotação atualizados nos últimos `daysCutoff` dias
    const activeRows = this.db.prepare(`
      SELECT ticker FROM historical_prices GROUP BY ticker HAVING MAX(date) >= ?
    `).all(cutoffDate);
    const activeTickers = new Set(activeRows.map(r => r.ticker.toUpperCase().trim()));

    // Identificar tickers a remover da tabela stocks
    const allStocks = this.db.prepare('SELECT ticker FROM stocks').all();
    const stocksToRemove = allStocks
      .map(s => s.ticker)
      .filter(t => !activeTickers.has(t.toUpperCase().trim()));

    // Identificar tickers a remover da tabela market_shortcuts
    const allShortcuts = this.db.prepare('SELECT ticker FROM market_shortcuts').all();
    const shortcutsToRemove = allShortcuts
      .map(s => s.ticker)
      .filter(t => !activeTickers.has(t.toUpperCase().trim()));

    let deletedStocks = 0;
    let deletedShortcuts = 0;

    const tx = this.db.transaction(() => {
      for (const t of stocksToRemove) {
        const res = this.db.prepare('DELETE FROM stocks WHERE ticker = ?').run(t);
        deletedStocks += res.changes || 0;
      }
      for (const t of shortcutsToRemove) {
        const res = this.db.prepare('DELETE FROM market_shortcuts WHERE ticker = ?').run(t);
        deletedShortcuts += res.changes || 0;
      }
    });
    tx();

    return {
      cutoffDate,
      deletedStocks,
      deletedShortcuts,
      totalPurged: deletedStocks + deletedShortcuts,
      purgedTickers: Array.from(new Set([...stocksToRemove, ...shortcutsToRemove]))
    };
  }

  // ═══════════════════════════════════════════════════════════
  //  DELETE INDEX — Remover um índice e todos os seus ativos
  // ═══════════════════════════════════════════════════════════
  deleteIndexAndStocks(indexName) {
    const name = String(indexName || '').trim();
    if (!name) {
      return { success: false, error: 'missing-index-name' };
    }

    const tx = this.db.transaction((idx) => {
      // Passo A: tickers pertencentes ao índice (filtro insensível a
      // maiúsculas/minúsculas e espaços).
      const matched = this.db.prepare(
        'SELECT ticker FROM stocks WHERE LOWER(TRIM(index_name)) = LOWER(TRIM(?))'
      ).all(idx);

      // Passo B: eliminar o histórico de cotações desses tickers.
      const prices = this.db.prepare(
        'DELETE FROM historical_prices WHERE ticker IN (' +
        '  SELECT ticker FROM stocks WHERE LOWER(TRIM(index_name)) = LOWER(TRIM(?))' +
        ')'
      ).run(idx);

      // Passo C: eliminar os registos de metadados.
      const stocks = this.db.prepare(
        'DELETE FROM stocks WHERE LOWER(TRIM(index_name)) = LOWER(TRIM(?))'
      ).run(idx);

      // A My List é alimentada pela tabela custom_tickers; remover também os
      // ativos do índice dessa lista para que a UI reflita a eliminação.
      const custom = this.db.prepare(
        'DELETE FROM custom_tickers WHERE LOWER(TRIM(index_name)) = LOWER(TRIM(?))'
      ).run(idx);

      return {
        tickers: matched.map(r => r.ticker),
        deletedStocksCount: stocks.changes || 0,
        deletedPricesCount: prices.changes || 0,
        deletedCustomCount: custom.changes || 0
      };
    });

    const result = tx(name);
    return {
      success: true,
      indexName: name,
      deletedStocksCount: result.deletedStocksCount,
      ...result
    };
  }

  getTickersForIndex(indexName = null) {
    if (!indexName || indexName === 'ALL') {
      return this.db.prepare('SELECT ticker FROM stocks ORDER BY ticker ASC').all().map(r => r.ticker);
    }

    // Indexes are persisted by canonical id.  Do not fall back to all rows:
    // a typo or a label from a legacy client must never import another index.
    const canonicalId = canonicalIndexId(indexName);
    return this.db.prepare(
      'SELECT ticker FROM stocks WHERE index_name = ? ORDER BY ticker ASC'
    ).all(canonicalId).map(r => r.ticker);

    const raw = String(indexName).trim();
    // Extrai o nome limpo removendo prefixos de país (ex: "EUA — S&P 500" vira "S&P 500")
    let cleanIndex = raw;
    if (raw.includes('—')) cleanIndex = raw.split('—')[1].trim();
    if (raw.includes('–')) cleanIndex = raw.split('–')[1].trim();
    if (raw.includes('|')) {
      const parts = raw.split('|');
      cleanIndex = parts[1] ? parts[1].trim() : parts[0].trim();
    }
    // Remove caracteres especiais para comparação insensível a maiúsculas/hífens/espaços/&
    const normalized = cleanIndex.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
    if (!normalized) {
      return this.db.prepare('SELECT ticker FROM stocks ORDER BY ticker ASC').all().map(r => r.ticker);
    }

    // Padrões LIKE: o nome completo normalizado e, se houver sufixo entre parênteses
    // (ex: "PSI (Portugal)"), o token antes do parêntesis
    const likePatterns = new Set([`%${normalized}%`]);
    const parenIdx = cleanIndex.indexOf('(');
    if (parenIdx > 0) {
      const head = cleanIndex.slice(0, parenIdx).replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
      if (head) likePatterns.add(`%${head}%`);
    }

    const likeClauses = [];
    const likeParams = [];
    for (const pattern of likePatterns) {
      likeClauses.push(`REPLACE(REPLACE(REPLACE(LOWER(TRIM(index_name)), '-', ''), ' ', ''), '&', '') LIKE ?`);
      likeParams.push(pattern);
    }

    const rows = this.db.prepare(`
      SELECT ticker FROM stocks
      WHERE LOWER(TRIM(index_name)) = LOWER(TRIM(?))
         OR LOWER(TRIM(index_name)) = LOWER(TRIM(?))
         OR ${likeClauses.join(' OR ')}
      ORDER BY ticker ASC
    `).all(raw, cleanIndex, ...likeParams);

    if (rows.length > 0) return rows.map(r => r.ticker);

    // Do not block the user when legacy rows use an unexpected index label.
    return this.db.prepare('SELECT ticker FROM stocks ORDER BY ticker ASC').all().map(r => r.ticker);
  }

  getTickersByIndex(indexName = null) {
    return this.getTickersForIndex(indexName);
  }

  getCustomTickersByIndex(indexName = null) {
    if (indexName) {
      return this.db.prepare(
        'SELECT ticker FROM custom_tickers WHERE index_name = ? ORDER BY ticker'
      ).all(canonicalIndexId(indexName)).map(r => r.ticker);
    }
    return this.db.prepare(
      'SELECT ticker FROM custom_tickers ORDER BY ticker'
    ).all().map(r => r.ticker);
  }

  getLastExpectedTradingDay() {
    return getLastExpectedTradingDay();
  }

  checkListFreshness(indexFilter = null) {
    // Spec 1.2 – query direta com JOIN opcional (stocks) + compat com custom_tickers
    let query = `SELECT MAX(hp.date) as maxStoredDate FROM historical_prices hp`;
    const params = [];
    if (indexFilter && indexFilter !== 'ALL') {
      query += ` JOIN stocks s ON hp.ticker = s.ticker WHERE LOWER(TRIM(s.index_name)) = LOWER(TRIM(?))`;
      params.push(indexFilter);
    }
    let row = null;
    try { row = this.db.prepare(query).get(...params); } catch (_) { row = null; }
    const expectedDate = this.getLastExpectedTradingDay();
    const maxStoredDate = row && row.maxStoredDate ? String(row.maxStoredDate).slice(0, 10) : null;
    const isUpdated = maxStoredDate ? (maxStoredDate >= expectedDate) : false;

    // Compat: manter outdatedTickers para callers existentes (main renderer)
    const tickers = this.getCustomTickersByIndex(indexFilter);
    if (tickers.length === 0) {
      return { isUpdated, maxStoredDate, expectedDate, outdatedTickers: [] };
    }
    let overallMax = maxStoredDate;
    const outdatedTickers = [];
    for (const ticker of tickers) {
      const r = this.db.prepare('SELECT MAX(date) as last_date FROM historical_prices WHERE ticker = ?').get(ticker);
      const lastDate = r ? r.last_date : null;
      if (lastDate && (!overallMax || lastDate > overallMax)) overallMax = lastDate;
      if (!lastDate || lastDate < expectedDate) outdatedTickers.push(ticker);
    }
    const finalMax = overallMax || maxStoredDate;
    const finalUpdated = finalMax ? (finalMax >= expectedDate) : false;

    return {
      isUpdated: finalUpdated,
      maxStoredDate: finalMax,
      expectedDate,
      outdatedTickers
    };
  }

  getMyListAssetsSyncStatus(indexFilter = null) {
    const stocksSql = `
      SELECT s.ticker, s.name, s.index_name
      FROM stocks s
      WHERE LOWER(TRIM(s.index_name)) = LOWER(TRIM(?))
      ORDER BY s.ticker ASC
    `;
    const stocksSqlAll = `
      SELECT s.ticker, s.name, s.index_name
      FROM stocks s
      ORDER BY s.ticker ASC
    `;

    let rows = [];
    try {
      if (indexFilter && indexFilter !== 'ALL' && indexFilter !== '') {
        rows = this.db.prepare(stocksSql).all(indexFilter);
      } else {
        rows = this.db.prepare(stocksSqlAll).all();
      }
    } catch (_) {
      rows = [];
    }

    if (rows.length === 0) {
      const ctSql = `
        SELECT ct.ticker, ct.name, ct.index_name
        FROM custom_tickers ct
        WHERE LOWER(TRIM(ct.index_name)) = LOWER(TRIM(?))
        ORDER BY ct.ticker ASC
      `;
      const ctSqlAll = `
        SELECT ct.ticker, ct.name, ct.index_name
        FROM custom_tickers ct
        ORDER BY ct.ticker ASC
      `;
      try {
        if (indexFilter && indexFilter !== 'ALL' && indexFilter !== '') {
          rows = this.db.prepare(ctSql).all(indexFilter);
        } else {
          rows = this.db.prepare(ctSqlAll).all();
        }
      } catch (_) {}
    }

    if (rows.length === 0) {
      return [];
    }

    const tickers = rows.map(r => (r.ticker || '').toUpperCase().trim());
    const lastDateMap = new Map();

    const CHUNK = 900;
    for (let i = 0; i < tickers.length; i += CHUNK) {
      const chunk = tickers.slice(i, i + CHUNK);
      const placeholders = chunk.map(() => '?').join(',');
      const maxDatesSql = `
        SELECT ticker, MAX(date) AS last_date
        FROM historical_prices
        WHERE ticker IN (${placeholders})
        GROUP BY ticker
      `;
      try {
        const maxRows = this.db.prepare(maxDatesSql).all(...chunk);
        for (const r of maxRows) {
          lastDateMap.set((r.ticker || '').toUpperCase().trim(), r.last_date ? String(r.last_date).slice(0, 10) : null);
        }
      } catch (_) {}
    }

    return rows.map(r => ({
      ticker: (r.ticker || '').toUpperCase().trim(),
      name: r.name || r.ticker,
      index_name: r.index_name || '',
      last_date: lastDateMap.get((r.ticker || '').toUpperCase().trim()) || null
    }));
  }

  getMyListAssetsWithDates(indexFilter = null) {
    return this.getMyListAssetsSyncStatus(indexFilter);
  }

  auditMyListAssets(indexFilter = null) {
    return this.getMyListAssetsSyncStatus(indexFilter);
  }

  saveBulkIncrementalCandles(candlesArray) {
    if (!Array.isArray(candlesArray) || candlesArray.length === 0) return 0;
    return this.saveIncrementalCandles(candlesArray);
  }

  saveSingleAssetCandles(candles) {
    if (!Array.isArray(candles) || candles.length === 0) return 0;
    const insertStmt = this.db.prepare(`
      INSERT OR REPLACE INTO historical_prices (ticker, date, open, high, low, close, volume)
      VALUES (@ticker, @date, @open, @high, @low, @close, @volume)
    `);
    const tx = this.db.transaction((list) => {
      let count = 0;
      for (const c of list) {
        const ticker = String(c.ticker || '').trim().toUpperCase();
        const date = String(c.date || '').slice(0, 10);
        const close = Number(c.close);
        if (!ticker || !date || !Number.isFinite(close)) continue;
        insertStmt.run({
          ticker,
          date,
          open: Number(c.open),
          high: Number(c.high),
          low: Number(c.low),
          close,
          volume: Number(c.volume || 0)
        });
        count++;
      }
      return count;
    });
    const savedCount = tx(candles);

    try {
      let ticker = null;
      for (const c of candles) {
        const t = String(c.ticker || '').trim().toUpperCase();
        const d = String(c.date || '').slice(0, 10);
        if (!t || !d || !Number.isFinite(Number(c.close))) continue;
        if (!ticker) ticker = t;
      }
      if (ticker) {
        const row = this.db.prepare(
          `SELECT first_date FROM stocks WHERE UPPER(TRIM(ticker)) = ?`
        ).get(ticker);
        if (row && (!row.first_date || String(row.first_date).trim() === '')) {
          const histRow = this.db.prepare(
            `SELECT MIN(date) as min_date FROM historical_prices WHERE ticker = ?`
          ).get(ticker);
          const trueFirstDate = histRow && histRow.min_date ? histRow.min_date : null;
          if (trueFirstDate) {
            this.db.prepare(
              `UPDATE stocks SET first_date = ? WHERE UPPER(TRIM(ticker)) = ?`
            ).run(trueFirstDate, ticker);
          }
        }
      }
    } catch (_) {}

    return savedCount;
  }

  saveIncrementalCandles(candlesList) {
    if (!Array.isArray(candlesList) || candlesList.length === 0) return 0;

    const formatted = candlesList.map(c => ({
      ticker: canonicalTicker(c.ticker),
      date: String(c.date || '').slice(0, 10),
      open: Number(c.open),
      high: Number(c.high),
      low: Number(c.low),
      close: Number(c.close),
      volume: Number(c.volume || 0)
    })).filter(c => c.ticker && c.date && Number.isFinite(c.close));

    if (formatted.length === 0) return 0;

    let savedCount = 0;
    if (this._insertBatchTransaction) {
      savedCount = this._insertBatchTransaction(formatted);
    } else {
      const stmt = this.db.prepare(`
        INSERT OR REPLACE INTO historical_prices (ticker, date, open, high, low, close, volume)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      const tx = this.db.transaction((list) => {
        let count = 0;
        for (const candle of list) {
          stmt.run(
            candle.ticker,
            candle.date,
            candle.open,
            candle.high,
            candle.low,
            candle.close,
            candle.volume
          );
          count++;
        }
        return count;
      });
      savedCount = tx(formatted);
    }

    // Preencher first_date eficientemente em O(N) para ativos sem first_date
    // usando o MIN(date) do histórico armazenado, não do lote atual.
    try {
      const virginStocks = this.db.prepare(`
        SELECT ticker 
        FROM stocks 
        WHERE first_date IS NULL OR TRIM(first_date) = ''
      `).all();

      if (virginStocks.length > 0) {
        const updateStmt = this.db.prepare(`
          UPDATE stocks SET first_date = ? WHERE UPPER(TRIM(ticker)) = ?
        `);
        const minDateStmt = this.db.prepare(`
          SELECT MIN(date) as min_date FROM historical_prices WHERE ticker = ?
        `);
        const updateTx = this.db.transaction((list) => {
          for (const s of list) {
            const canonicalT = canonicalTicker(s.ticker);
            const histRow = minDateStmt.get(canonicalT);
            const trueFirstDate = histRow && histRow.min_date ? histRow.min_date : null;
            if (trueFirstDate) {
              updateStmt.run(trueFirstDate, canonicalT);
            }
          }
        });
        updateTx(virginStocks);
      }
    } catch (_) {}

    return savedCount;
  }

  close() {
    if (this.db) this.db.close();
  }
}

module.exports = DB;
