// ═══════════════════════════════════════════════════════════════════════════
// sync-universe-diagnostics.test.js
// Cobertura da implementação "universo completo + diagnóstico de falhas":
//   1. getMyListAssetsSyncStatus — UNION deduplicada stocks+custom_tickers
//   2. indexFilter — regra PSI20 + NULL/'' (nunca 0 quando há matches)
//   3. saveSingleAssetCandles — ticker só em custom_tickers propaga para stocks
//   4. main.js (estático) — classifySyncError, loop sequencial, payload sync-all-done
//   5. yahooClient.fetchLatestCandlesForSingleTicker — fallback de virgens (mock axios)
//   6. renderer (estático) — modal de diagnóstico, normalizeFailedEntries, sem XSS
// Testes determinísticos: BD temporária real + axios mockado; nenhuma rede.
// ═══════════════════════════════════════════════════════════════════════════
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

let SQLITE_AVAILABLE = false;
let Database;
try {
  Database = require('../src/db/database');
  const probe = require('better-sqlite3');
  probe(':memory:').close();
  SQLITE_AVAILABLE = true;
} catch (_) {
  // Native addon indisponível com ABI diferente — testes de BD ficam `todo`.
}

const { makeTempDir, removeTempDir } = require('./helpers');
const axios = require('axios');
const yahooClient = require('../src/data/yahooClient');

const ROOT = path.join(__dirname, '..');

function openDb(t) {
  const dir = makeTempDir('sync-universe-diag-');
  const db = new Database(dir);
  db.init();
  t.after(() => {
    db.close();
    removeTempDir(dir);
  });
  return db;
}

// INSERTs raw para controlar casing/espaces/NULL que os helpers canonizam.
function rawStock(db, { ticker, name, country = '', indexName = '' }) {
  db.db.prepare(
    'INSERT INTO stocks (ticker, name, country, index_name) VALUES (?, ?, ?, ?)'
  ).run(ticker, name, country, indexName);
}

function rawCustom(db, { ticker, name = '', country = '', indexName = null }) {
  db.db.prepare(
    'INSERT INTO custom_tickers (ticker, name, exchange, type, country, index_name) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(ticker, name, '', '', country, indexName);
}

function rawCandle(db, ticker, date, close = 100) {
  db.db.prepare(
    'INSERT OR REPLACE INTO historical_prices (ticker, date, open, high, low, close, volume) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(ticker, date, close, close + 1, close - 1, close, 1000);
}

const candle = (ticker, date, close = 100) => ({
  ticker, date, open: close - 1, high: close + 1, low: close - 2, close, volume: 1000
});

// ── Mock do payload Yahoo chart ─────────────────────────────────────────────
function chartResponse({ timestamps, open, high, low, close, volume }) {
  return {
    data: {
      chart: {
        result: [{
          timestamp: timestamps,
          indicators: { quote: [{ open, high, low, close, volume }] }
        }]
      }
    }
  };
}

const dbTodo = { skip: !SQLITE_AVAILABLE };

// ═══════════════════════════════════════════════════════════════════════════
// 1. Universo completo — getMyListAssetsSyncStatus (sem filtro)
// ═══════════════════════════════════════════════════════════════════════════
test('universo completo: UNION deduplicada por UPPER(TRIM(ticker)) com prioridade para stocks', dbTodo, t => {
  const db = openDb(t);

  // stocks: 3 tickers (MSFT fica sem histórico — "virgem")
  rawStock(db, { ticker: 'AAPL', name: 'Apple Inc (stocks)', country: 'US', indexName: 'SP500' });
  rawStock(db, { ticker: 'MSFT', name: 'Microsoft (stocks)', country: 'US', indexName: 'SP500' });
  rawStock(db, { ticker: 'ALPHA', name: 'Alpha Motors (stocks)', country: 'PT', indexName: 'PSI20' });

  // custom_tickers: 5 rows — 2 não existentes em stocks (EDP.LS com index NULL,
  // TOTA.LS com index ''), 1 duplicado com casing/espaços diferente (' alpha '),
  // e 2 exactos (AAPL, MSFT) com names que NÃO podem vencer os de stocks.
  rawCustom(db, { ticker: ' alpha ', name: 'Alpha (custom)', indexName: 'PSI20' });
  rawCustom(db, { ticker: 'AAPL', name: 'Apple (custom)', indexName: 'SP500' });
  rawCustom(db, { ticker: 'MSFT', name: 'Microsoft (custom)', indexName: 'SP500' });
  rawCustom(db, { ticker: 'EDP.LS', name: 'EDP Renovaveis', indexName: null });
  rawCustom(db, { ticker: 'TOTA.LS', name: 'Totalgem', indexName: '' });

  // histórico parcial: AAPL e ALPHA têm velas; MSFT/EDP.LS/TOTA.LS não.
  rawCandle(db, 'AAPL', '2024-06-13', 190);
  rawCandle(db, 'AAPL', '2024-06-14', 195);
  rawCandle(db, 'ALPHA', '2024-05-05', 7);

  const rows = db.getMyListAssetsSyncStatus();
  const byTicker = Object.fromEntries(rows.map(r => [r.ticker, r]));

  // 8 rows no total (3 stocks + 5 custom), 5 únicas após dedup UPPER(TRIM()).
  assert.equal(rows.length, 5, 'dedup deve colapsar alpha/AAPL/MSFT duplicados');
  assert.deepEqual(rows.map(r => r.ticker), ['AAPL', 'ALPHA', 'EDP.LS', 'MSFT', 'TOTA.LS'], 'ordem ASC por ticker');

  // Prioridade de name/index_name: stocks ganha sobre custom.
  assert.equal(byTicker.AAPL.name, 'Apple Inc (stocks)');
  assert.equal(byTicker.AAPL.index_name, 'SP500');
  assert.equal(byTicker.ALPHA.name, 'Alpha Motors (stocks)', "' alpha ' em custom não pode sobrepor stocks");
  assert.equal(byTicker.ALPHA.index_name, 'PSI20');

  // Virgens continuam presentes com last_date null.
  assert.equal(byTicker.MSFT.last_date, null, 'ativo sem histórico aparece com last_date null');
  assert.equal(byTicker['EDP.LS'].last_date, null);
  assert.equal(byTicker['TOTA.LS'].last_date, null);

  // last_date = MAX(date) em formato YYYY-MM-DD.
  assert.equal(byTicker.AAPL.last_date, '2024-06-14');
  assert.equal(byTicker.ALPHA.last_date, '2024-05-05');

  // Sem indexFilter entram todos, incl. index_name NULL (EDP.LS) e '' (TOTA.LS).
  assert.ok(rows.some(r => r.ticker === 'EDP.LS'), 'NULL index_name incluído sem filtro');
  assert.ok(rows.some(r => r.ticker === 'TOTA.LS'), "'\' index_name incluído sem filtro");
  assert.equal(byTicker['EDP.LS'].index_name, '', 'NULL normalizado para string vazia no output');
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. indexFilter específico — PSI20 + NULL/'' (regra implementada)
// ═══════════════════════════════════════════════════════════════════════════
test('indexFilter PSI20: inclui matches PSI20 E ativos com index NULL/\'\' e nunca devolve 0 quando há matches', dbTodo, t => {
  const db = openDb(t);

  rawStock(db, { ticker: 'FCTX.LS', name: 'Jerónimo Martins', indexName: 'PSI20' });
  rawStock(db, { ticker: 'GALP.LS', name: 'Galp', indexName: 'psi20' }); // casing diferente
  rawStock(db, { ticker: 'AAPL', name: 'Apple', indexName: 'SP500' });   // não deve entrar
  rawStock(db, { ticker: 'BLANKIX', name: 'Sem Índice', indexName: '' });
  rawCustom(db, { ticker: 'NULLIX', name: 'Índice NULL', indexName: null });

  const psi = db.getMyListAssetsSyncStatus('PSI20');
  const tickers = psi.map(r => r.ticker);

  assert.ok(psi.length > 0, 'indexFilter com matches nunca pode devolver 0');
  assert.deepEqual([...tickers].sort(), ['BLANKIX', 'FCTX.LS', 'GALP.LS', 'NULLIX']);
  assert.ok(!tickers.includes('AAPL'), 'ativos de outro índice ficam de fora');

  // 'ALL' comporta-se como sem filtro.
  assert.equal(db.getMyListAssetsSyncStatus('ALL').length, 5);

  // Filtro para índice inexistente: só entram os NULL/'' (continuam auditáveis).
  const ibex = db.getMyListAssetsSyncStatus('IBEX35').map(r => r.ticker);
  assert.deepEqual([...ibex].sort(), ['BLANKIX', 'NULLIX']);
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. saveSingleAssetCandles para ticker só existente em custom_tickers
// ═══════════════════════════════════════════════════════════════════════════
test('saveSingleAssetCandles: ticker só em custom_tickers cria row em stocks com name/index_name herdados', dbTodo, t => {
  const db = openDb(t);

  rawCustom(db, { ticker: 'NOVO.LS', name: 'Novo Banco', country: 'PT', indexName: 'PSI20' });
  assert.equal(db.db.prepare('SELECT COUNT(*) n FROM stocks WHERE ticker = ?').get('NOVO.LS').n, 0);

  const saved = db.saveSingleAssetCandles([
    candle('novo.ls', '2024-06-10', 1.5),   // casing/espacos por normalizar
    candle('NOVO.LS', '2024-06-11', 1.6)
  ]);
  assert.equal(saved, 2);

  // Velas gravadas com ticker canónico.
  const hist = db.db.prepare('SELECT date, close FROM historical_prices WHERE ticker = ? ORDER BY date').all('NOVO.LS');
  assert.equal(hist.length, 2);
  assert.equal(hist[0].date, '2024-06-10');
  assert.equal(hist[1].date, '2024-06-11');

  // Row criada em stocks com metadata copiada de custom_tickers.
  const stock = db.db.prepare('SELECT ticker, name, country, index_name FROM stocks WHERE ticker = ?').get('NOVO.LS');
  assert.ok(stock, 'stocks deve ter row para ativo que só estava em custom_tickers');
  assert.equal(stock.name, 'Novo Banco');
  assert.equal(stock.country, 'PT');
  assert.equal(stock.index_name, 'PSI20');

  // first_date retro-alimentado a partir do histórico.
  const sd = db.db.prepare('SELECT first_date FROM stocks WHERE ticker = ?').get('NOVO.LS');
  assert.equal(sd.first_date, '2024-06-10');

  // Idempotência: repetir não duplica nem altera metadata.
  db.saveSingleAssetCandles([candle('NOVO.LS', '2024-06-11', 1.65)]);
  assert.equal(db.db.prepare('SELECT COUNT(*) n FROM stocks WHERE ticker = ?').get('NOVO.LS').n, 1);
  assert.equal(db.db.prepare('SELECT close c FROM historical_prices WHERE ticker = ? AND date = ?').get('NOVO.LS', '2024-06-11').c, 1.65);
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. main.js — asserts estáticos (entry Electron não é requerível)
// ═══════════════════════════════════════════════════════════════════════════
const mainSrc = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');

test('main.js: failedTickers.push publica objeto { ticker, index_name, reason }', () => {
  assert.match(
    mainSrc,
    /failedTickers\.push\(\s*\{[^}]*\bticker:[^}]*index_name:[^}]*reason:\s*classifySyncError\(err\)[^}]*\}\s*\)/s,
    'falhas devem ser tipadas com ticker + index_name + motivo classificado'
  );
});

test('main.js: classifySyncError distingue 429, 404 e timeout', () => {
  const idx = mainSrc.indexOf('const classifySyncError');
  assert.ok(idx !== -1, 'classifySyncError deve existir em main.js');
  const block = mainSrc.slice(idx, idx + 1200);
  assert.match(block, /429/, 'classificação de rate limit');
  assert.match(block, /rate.?limit/i, 'padrão textual de rate limit');
  assert.match(block, /404/, 'classificação de ticker inexistente');
  assert.match(block, /not found|invalid symbol|deslistado/i, 'padrão textual de 404');
  assert.match(block, /timeout|ETIMEDOUT|ECONNABORTED/, 'classificação de timeout');
});

test('main.js: loop sequencial totalPending e pace sleep(100) mantidos', () => {
  assert.match(mainSrc, /for \(let i = 0; i < totalPending[,;)]/, 'sync-recent deve continuar sequencial');
  assert.match(mainSrc, /await sleep\(100\)/, 'pace de 100ms entre tickers deve ser preservado');
});

test('main.js: payload sync-all-done inclui updated, skipped e failedCount', () => {
  const idx = mainSrc.indexOf("sendEvent('sync-all-done'");
  assert.ok(idx !== -1, 'evento sync-all-done deve existir');
  const block = mainSrc.slice(idx, idx + 900);
  assert.match(block, /updated:/, 'contador de atualizados no payload');
  assert.match(block, /skipped:/, 'contador de ignorados no payload');
  assert.match(block, /failedCount:\s*failedTickers\.length/, 'failedCount derivado das falhas');
  assert.match(block, /failedTickers,/, 'lista de falhas viaja no payload');
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. yahooClient.fetchLatestCandlesForSingleTicker — fallback de virgens
// ═══════════════════════════════════════════════════════════════════════════
test('yahoo fallback: ativo virgem (lastDate null) usa range=5d e normaliza o ticker no URL', async () => {
  const original = axios.get;
  let capturedUrl = '';
  try {
    axios.get = async (url) => { capturedUrl = url; return { data: { chart: { result: [] } } }; };
    const candles = await yahooClient.fetchLatestCandlesForSingleTicker(' edp.ls ', null);
    assert.deepEqual(candles, [], 'payload vazio → sem velas, sem throw');
    assert.ok(capturedUrl.includes('/EDP.LS?'), `ticker trim/case-insensitive no path: ${capturedUrl}`);
    assert.match(capturedUrl, /range=5d&interval=1d/, 'virgens usam janela de contingência 5d');
    assert.ok(!capturedUrl.includes('period1='), 'sem period1 quando não há histórico');
  } finally { axios.get = original; }
});

test('yahoo fallback: lastDate presente → period1 corresponde ao dia seguinte', async () => {
  const original = axios.get;
  let capturedUrl = '';
  try {
    axios.get = async (url) => { capturedUrl = url; return { data: { chart: { result: [] } } }; };
    await yahooClient.fetchLatestCandlesForSingleTicker('AAPL', '2024-06-14');
    const expectedP1 = Date.UTC(2024, 5, 14) / 1000 + 86400; // 2024-06-15 UTC
    assert.ok(capturedUrl.includes(`period1=${expectedP1}`), `period1 deve ser dia seguinte (${expectedP1}): ${capturedUrl}`);
    assert.match(capturedUrl, /period2=\d+&interval=1d/);
    assert.ok(!capturedUrl.includes('range='), 'incremental não usa range');
  } finally { axios.get = original; }
});

test('yahoo fallback: OHLCV convertidos com Number e velas com close null são skipadas', async t => {
  const original = axios.get;
  const t0 = Date.UTC(2024, 5, 10) / 1000;
  const t1 = Date.UTC(2024, 5, 11) / 1000;
  const t2 = Date.UTC(2024, 5, 12) / 1000;
  const payload = chartResponse({
    timestamps: [t0, t1, t2],
    open: ['10.25', null, '19'],      // strings → Number; '19' ok
    high: ['10.75', null, '20.5'],
    low: ['10.05', null, '18.5'],
    close: ['10.5', null, 20],        // close null no meio → vela skipada
    volume: [null, 999, '4321']       // volume null → 0; string → Number
  });
  try {
    axios.get = async () => payload;
    const candles = await yahooClient.fetchLatestCandlesForSingleTicker('ACME', null);
    assert.equal(candles.length, 2, 'vela com close null deve ser descartada');
    assert.equal(candles.every(c => c.ticker === 'ACME'), true);

    const [a, b] = candles;
    assert.equal(a.date, '2024-06-10');
    assert.equal(b.date, '2024-06-12');
    assert.equal(typeof a.close, 'number', 'close string → number');
    assert.equal(a.close, 10.5);
    assert.equal(a.open, 10.25);
    assert.equal(a.high, 10.75);
    assert.equal(a.low, 10.05);
    assert.equal(a.volume, 0, 'volume null → 0');
    assert.equal(b.volume, 4321, 'volume string → number');
    assert.equal(typeof b.close, 'number');
  } finally { axios.get = original; }
  void t;
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. Modal de diagnóstico — asserts estáticos renderer/* + preload
// ═══════════════════════════════════════════════════════════════════════════
const htmlSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'index.html'), 'utf8');
const rendererSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'renderer.js'), 'utf8');
const preloadSrc = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8');

test('index.html: modal e todos os ids de diagnóstico existem', () => {
  for (const id of [
    'modal-sync-diagnostics', 'diag-total-val', 'diag-updated-val', 'diag-skipped-val',
    'diag-failed-val', 'diag-failed-tbody', 'btn-copy-failed-tickers',
    'btn-retry-failed-tickers', 'btn-close-diag-modal', 'btn-close-diag-btn'
  ]) {
    assert.ok(
      new RegExp(`id="${id}"`).test(htmlSrc),
      `id em falta no modal de diagnóstico: ${id}`
    );
  }
  // Modal começa fechado.
  assert.match(htmlSrc, /<div class="modal-backdrop" id="modal-sync-diagnostics" hidden>/);
});

test('renderer.js: openSyncDiagnosticsModal exported, normalizeFailedEntries e modal aberto em sync-all-done com falhas', () => {
  assert.match(rendererSrc, /window\.openSyncDiagnosticsModal\s*=\s*openSyncDiagnosticsModal/, 'API exposta na window');
  assert.match(rendererSrc, /function normalizeFailedEntries\(/, 'normalizador de entradas de falha');
  assert.match(rendererSrc, /function openSyncDiagnosticsModal\(report\)/);

  const idx = rendererSrc.indexOf("subscribeApiEvent('on', 'sync-all-done'");
  assert.ok(idx !== -1, 'subscrição sync-all-done existente');
  const block = rendererSrc.slice(idx, idx + 4500);
  assert.match(block, /normalizeFailedEntries\(p\.failedTickers \|\| p\.failed/, 'payload normalizado no handler');
  assert.match(block, /failedEntries\.length > 0[\s\S]{0,200}openSyncDiagnosticsModal/, 'modal abre automaticamente quando há falhas');
});

test('renderer.js: render do tbody usa innerHTML atómico (sem +=) e escapeHtml — sem injeção progressiva', () => {
  assert.ok(!rendererSrc.includes("diag-failed-tbody.innerHTML +="), 'proibido acumulacao com += no tbody');

  const fnMatch = rendererSrc.match(/function openSyncDiagnosticsModal\(report\)[\s\S]*?\n {2}\}/);
  assert.ok(fnMatch, 'funcao openSyncDiagnosticsModal encontrada');
  const fnBody = fnMatch[0];
  assert.ok(!fnBody.includes('innerHTML +='), 'render da tabela deve substituir, nunca anexar');
  assert.match(fnBody, /tbody\.innerHTML = entries\.map/, 'tbody reconstruído de uma só vez');
  assert.match(fnBody, /escapeHtml\(e\.ticker/, 'ticker escapado');
  assert.match(fnBody, /escapeHtml\(e\.reason/, 'razão escapada');
});

test('preload.js: nenhum canal novo necessário — sync-all-done/SYNC_RECENT_PROGRESS já whitelistados', () => {
  assert.ok(preloadSrc.includes("'sync-all-done'"), 'canal sync-all-done já exposto');
  assert.ok(preloadSrc.includes("'SYNC_RECENT_PROGRESS'"), 'canal de progresso já exposto');
  // O modal é 100% renderer-side: não deve haver IPC novo dedicado.
  assert.ok(!/['"]diag[-:]/.test(preloadSrc), 'nenhum canal IPC de diagnóstico introduzido');
});

// ── limitações de ambiente conhecidas (documentadas, não silenciadas) ──────
test.todo('end-to-end: sync-recent com 429 intermitente deve listar ticker+index_name+reason no modal (exige harness Electron completo para o handler de main.js)');
test.todo('end-to-end: botão Repetir Sincronização re-executa apenas a lista de falhas (só testável com DOM/jsdom harness no renderer)');
