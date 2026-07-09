const path = require('path');
const Database = require('better-sqlite3');

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

  init() {
    if (!this.userDataPath) {
      throw new Error('DB.init requires a userDataPath');
    }
    const dbPath = path.join(this.userDataPath, 'trades.db');
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this._migrate();
    this._seedParams();
    return Promise.resolve();
  }

  _migrate() {
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
    this.db.prepare(`
      INSERT INTO custom_tickers (ticker, name, exchange, type)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(ticker) DO UPDATE SET
        name = excluded.name,
        exchange = excluded.exchange,
        type = excluded.type
    `).run(t.ticker, t.name || '', t.exchange || '', t.type || '');
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

  closeActiveTrade(id, precoFecho, resultadoPct) {
    this.db.prepare(`
      UPDATE active_trades
      SET status = 'fechado', resultado_pct = ?, preco_fecho = ?,
          motivo_fecho = ?, fechado_em = ?
      WHERE id = ?
    `).run(resultadoPct, precoFecho, 'auto', new Date().toISOString().slice(0, 10), id);
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

  close() {
    if (this.db) this.db.close();
  }
}

module.exports = DB;
