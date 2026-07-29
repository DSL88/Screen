const Database = require('better-sqlite3');

const RUNS = 3;

function makeCandles(ticker, count, startDate) {
  const candles = [];
  const base = new Date(startDate).getTime();
  for (let i = 0; i < count; i++) {
    const d = new Date(base + i * 86400000);
    candles.push({
      ticker,
      date: d.toISOString().slice(0, 10),
      open: 100 + Math.random() * 10,
      high: 105 + Math.random() * 10,
      low: 95 + Math.random() * 10,
      close: 100 + Math.random() * 10,
      volume: Math.floor(1000000 + Math.random() * 5000000)
    });
  }
  return candles;
}

function test(title, fn) {
  const start = process.hrtime.bigint();
  try {
    const result = fn();
    const elapsed = Number(process.hrtime.bigint() - start) / 1e6;
    const pass = result !== false;
    console.log(`${pass ? '\u2713' : '\u2717'} ${title} \u2014 ${elapsed.toFixed(2)}ms`);
    if (!pass) process.exit(1);
    return elapsed;
  } catch (err) {
    console.log(`\u2717 ${title} \u2014 ERRO: ${err.message}`);
    process.exit(1);
  }
}

async function main() {
  console.log('\n\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550');
  console.log('  PERFORMANCE TEST \u2014 SQLite + historical_prices');
  console.log('\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\n');

  const db = new Database(':memory:');

  test('PRAGMA journal_mode = WAL', () => {
    db.pragma('journal_mode = WAL');
  });

  test('PRAGMA synchronous = NORMAL', () => {
    db.pragma('synchronous = NORMAL');
  });

  test('PRAGMA cache_size = -64000', () => {
    db.pragma('cache_size = -64000');
  });

  test('PRAGMA temp_store = MEMORY', () => {
    db.pragma('temp_store = MEMORY');
  });

  test('Criar tabela + \u00edndices', () => {
    db.exec(`
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
      CREATE INDEX IF NOT EXISTS idx_hist_ticker_date ON historical_prices (ticker, date);
      CREATE INDEX IF NOT EXISTS idx_historical_prices_ticker_date_asc ON historical_prices (ticker, date ASC);
    `);
  });

  const TICKER = 'AAPL';
  const CANDLE_COUNT = 5000;
  const START_DATE = new Date('2000-01-01');
  const candles = makeCandles(TICKER, CANDLE_COUNT, START_DATE);

  // Test 1: Batch insert performance
  let insertTimes = [];
  for (let r = 0; r < RUNS; r++) {
    db.exec(`DELETE FROM historical_prices WHERE ticker = '${TICKER}'`);
    const insertCandle = db.prepare(`
      INSERT OR REPLACE INTO historical_prices (ticker, date, open, high, low, close, volume)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const time = test(`[Run ${r+1}] Inserir ${CANDLE_COUNT} velas em lote`, () => {
      const tx = db.transaction((rows) => {
        for (const c of rows) {
          insertCandle.run(c.ticker, c.date, c.open, c.high, c.low, c.close, c.volume);
        }
      });
      tx(candles);
    });
    insertTimes.push(time);
  }

  const avgInsert = insertTimes.reduce((a, b) => a + b, 0) / insertTimes.length;
  console.log(`\n  \u2192 M\u00e9dia inser\u00e7\u00e3o: ${avgInsert.toFixed(2)}ms`);
  if (avgInsert > 100) {
    console.log(`  \u26a0 AVISO: Inser\u00e7\u00e3o acima de 100ms (${avgInsert.toFixed(2)}ms).`);
  } else {
    console.log(`  \u2713 CRIT\u00c9RIO ACEITE: < 100ms`);
  }

  // Test 2: Range query (MIN/MAX)
  test('Range query (getTickerDataRange)', () => {
    const row = db.prepare(`
      SELECT MIN(date) AS first_date, MAX(date) AS last_date, COUNT(*) AS total_candles
      FROM historical_prices WHERE ticker = ?
    `).get(TICKER);
    if (!row || row.total_candles !== CANDLE_COUNT) throw new Error('Unexpected count');
  });

  // Test 3: Last stored date (MAX)
  test('Last stored date (getLastStoredDate)', () => {
    const row = db.prepare('SELECT MAX(date) as last_date FROM historical_prices WHERE ticker = ?').get(TICKER);
    if (!row || !row.last_date) throw new Error('No last date');
  });

  // Test 4: Limited loading
  test('Limited loading (getLocalHistoricalPricesLimit: 300)', () => {
    const rows = db.prepare(`
      SELECT date, open, high, low, close, volume
      FROM historical_prices
      WHERE ticker = ?
      ORDER BY date DESC
      LIMIT ?
    `).all(TICKER, 300);
    if (rows.length !== 300) throw new Error(`Expected 300, got ${rows.length}`);
  });

  // Test 5: Full table scan vs indexed scan
  test('SELECT com \u00edndice (ticker = ?)', () => {
    const rows = db.prepare('SELECT * FROM historical_prices WHERE ticker = ? ORDER BY date ASC').all(TICKER);
    if (rows.length !== CANDLE_COUNT) throw new Error('Unexpected count');
  });

  // Test 6: Multiple queries in sequence (simulating scanner workload)
  test('10 consultas sequenciais (simulando scanner)', () => {
    for (let i = 0; i < 10; i++) {
      const rows = db.prepare(`
        SELECT date, open, high, low, close, volume
        FROM historical_prices
        WHERE ticker = ?
        ORDER BY date DESC
        LIMIT 300
      `).all(TICKER);
      if (rows.length !== 300) throw new Error('Unexpected count');
    }
  });

  // Test 7: Date range query
  const midDate = new Date('2010-01-01').toISOString().slice(0, 10);
  test(`SELECT com date >= '${midDate}'`, () => {
    const rows = db.prepare(`
      SELECT date, open, high, low, close, volume
      FROM historical_prices
      WHERE ticker = ? AND date >= ?
      ORDER BY date ASC
    `).all(TICKER, midDate);
    if (rows.length === 0) throw new Error('No rows returned');
  });

  db.close();

  console.log('\n\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550');
  console.log('  TESTES CONCLU\u00cdDOS');
  console.log('\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\n');
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
