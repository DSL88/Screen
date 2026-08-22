// ─────────────────────────────────────────────────────────────────────────────
//  Matriz de testes: camada de concorrência e sincronização
//
//   A. fetchWithBackoff        — retry/backoff exponencial (sleepFn injetável)
//   B. syncTickersBatch        — orquestrador de sync (fetchOne injetável, zero rede)
//   C. createProgressReporter  — throttle de progresso (relógio now injetável)
//   D. saveBulkHistoricalCandles — gravação SQLite em bloco (guard dinâmico da casa)
//
//  Determinismo: zero rede real (todas as dependências de rede são injetadas),
//  zero timers longos (sleepFn/now substituídos ou sleeps de ≤20ms apenas para
//  medir picos de concorrência). A DB nativa segue o padrão do resto do suite:
//  sonda dinâmica + skip informativo quando o addon não carrega sob node puro.
// ─────────────────────────────────────────────────────────────────────────────
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { fetchWithBackoff, syncTickersBatch, networkLimit } = require('../src/data/yahooClient');

// O módulo de throttle pode estar a ser criado por um agente em paralelo.
let createProgressReporter = null;
try {
  ({ createProgressReporter } = require('../src/utils/progressThrottle'));
} catch (_) {
  // Ausente: os testes C saltam com motivo informativo.
}

// Padrão da casa (database.test.js / most-recent.test.js): sonda dinâmica do
// addon nativo; se falhar (ABI Electron vs Node), os testes D saltam.
let Sqlite;
let DB;
let SQLITE_AVAILABLE = false;
try {
  Sqlite = require('better-sqlite3');
  DB = require('../src/db/database');
  const probe = new Sqlite(':memory:');
  probe.close();
  SQLITE_AVAILABLE = true;
} catch (_) {
  // Native addon may be unavailable when Node/Electron ABIs differ.
}

const PROGRESS_SKIP_REASON = 'src/utils/progressThrottle.js ainda indisponível (agente paralelo pode não o ter criado a tempo)';
const DB_SKIP_REASON = 'better-sqlite3 nativo indisponível sob node puro neste repo (ERR_DLOPEN_FAILED pré-existente; corre após electron-rebuild)';

const sleep = ms => new Promise(res => setTimeout(res, ms));
const mkCandle = (ticker, date, close = 10) =>
  ({ ticker, date, open: close, high: close + 1, low: close - 1, close, volume: 1000 });

// ═════════════════════════════════════════════════════════════════════════════
//  A. fetchWithBackoff — retry com backoff exponencial + jitter; 429 duplica
// ═════════════════════════════════════════════════════════════════════════════

test('fetchWithBackoff devolve o valor à primeira tentativa sem dormir', async () => {
  let calls = 0;
  const sleeps = [];
  const result = await fetchWithBackoff(
    async () => { calls += 1; return { ok: true }; },
    { sleepFn: async ms => sleeps.push(ms) }
  );
  assert.deepEqual(result, { ok: true });
  assert.equal(calls, 1);
  assert.deepEqual(sleeps, []);
});

test('fetchWithBackoff recupera de falhas transitórias com delays exponenciais na janela esperada', async () => {
  let calls = 0;
  const sleeps = [];
  const fn = async () => {
    calls += 1;
    if (calls < 3) throw Object.assign(new Error('ETIMEDOUT'), { code: 'ETIMEDOUT' });
    return { ok: true };
  };
  const result = await fetchWithBackoff(fn, { retries: 3, baseDelay: 500, sleepFn: async ms => sleeps.push(ms) });
  assert.deepEqual(result, { ok: true });
  assert.equal(calls, 3);
  assert.equal(sleeps.length, 2);
  // Jitter ∈ [0, 200): tentativa 1 → ~500±jitter, tentativa 2 → ~1000±jitter
  assert.ok(sleeps[0] >= 500 && sleeps[0] < 700, `delay 1 fora da janela [500,700): ${sleeps[0]}`);
  assert.ok(sleeps[1] >= 1000 && sleeps[1] < 1200, `delay 2 fora da janela [1000,1200): ${sleeps[1]}`);
});

test('fetchWithBackoff produz a sequência exata [500, 1000] quando o jitter é eliminado', async () => {
  const originalRandom = Math.random;
  Math.random = () => 0; // jitter determinístico = 0
  try {
    const sleeps = [];
    await assert.rejects(
      fetchWithBackoff(
        async () => { throw new Error('ECONNRESET'); },
        { retries: 3, baseDelay: 500, sleepFn: async ms => sleeps.push(ms) }
      ),
      /ECONNRESET/
    );
    assert.deepEqual(sleeps, [500, 1000]);
  } finally {
    Math.random = originalRandom;
  }
});

test('fetchWithBackoff duplica o delay base em erros 429 detetados por qualquer canal', async () => {
  const make429 = channel => {
    const err = new Error('limite de pedidos excedido');
    if (channel === 'message') err.message = 'HTTP 429 Too Many Requests';
    else if (channel === 'statusCode') err.statusCode = 429;
    else if (channel === 'status') err.status = 429;
    else if (channel === 'code') err.code = 429;
    else if (channel === 'codeStr') err.code = '429';
    return err;
  };

  for (const channel of ['message', 'statusCode', 'status', 'code', 'codeStr']) {
    const sleeps = [];
    await assert.rejects(
      fetchWithBackoff(
        async () => { throw make429(channel); },
        { retries: 3, baseDelay: 500, sleepFn: async ms => sleeps.push(ms) }
      ),
      /429|limite de pedidos excedido/
    );
    assert.equal(sleeps.length, 2, `canal ${channel}: devia dormir 2x`);
    // 429 → base duplicada: tentativa 1 → ~1000±jitter, tentativa 2 → ~2000±jitter
    assert.ok(sleeps[0] >= 1000 && sleeps[0] < 1200, `canal ${channel}: delay 1 fora de [1000,1200): ${sleeps[0]}`);
    assert.ok(sleeps[1] >= 2000 && sleeps[1] < 2200, `canal ${channel}: delay 2 fora de [2000,2200): ${sleeps[1]}`);
  }
});

test('fetchWithBackoff lança o erro original após esgotar as tentativas', async () => {
  let calls = 0;
  const sleeps = [];
  const fatal = new Error('falha persistente simulada');
  await assert.rejects(
    fetchWithBackoff(
      async () => { calls += 1; throw fatal; },
      { retries: 3, baseDelay: 500, sleepFn: async ms => sleeps.push(ms) }
    ),
    err => err === fatal
  );
  assert.equal(calls, 3);              // total de chamadas = retries
  assert.equal(sleeps.length, 2);      // dorme só entre tentativas
});

test('fetchWithBackoff não gasta retries em erros definitivos (404/inativo)', async () => {
  let calls = 0;
  const sleeps = [];
  await assert.rejects(
    fetchWithBackoff(
      async () => { calls += 1; throw new Error('Ticker X não encontrado / 404 no Yahoo Finance.'); },
      { retries: 3, baseDelay: 500, sleepFn: async ms => sleeps.push(ms) }
    ),
    /404/
  );
  assert.equal(calls, 1);
  assert.deepEqual(sleeps, []);        // backoff ignorado por completo
});

// ═════════════════════════════════════════════════════════════════════════════
//  B. syncTickersBatch — orquestrador (sempre com fetchOne injetável, zero rede)
// ═════════════════════════════════════════════════════════════════════════════

test('syncTickersBatch mapeia os 6 estados num lote misto', async () => {
  const fetched = [];
  const fetchOne = async (ticker, lastDate) => {
    fetched.push(`${ticker}:${lastDate}`);
    if (ticker === 'BOOM') throw new Error('kaboom injetado');
    if (ticker === 'EMPTY') return [];
    return [mkCandle(ticker, '2026-08-20'), mkCandle(ticker, '2026-08-21')];
  };

  const results = await syncTickersBatch(['OK', 'EMPTY', 'FRESH', 'NODATE', 'BOOM', 'HALT'], {
    getLastDate: ticker => ({ OK: '2026-08-19', EMPTY: '2026-08-19', FRESH: '2026-08-21', BOOM: '2026-08-18' }[ticker] ?? null),
    expectedTradingDay: '2026-08-21',
    shouldContinue: ticker => ticker !== 'HALT',
    fetchOne
  });

  const byTicker = Object.fromEntries(results.map(r => [r.ticker, r]));
  assert.equal(results.length, 6);

  // SUCCESS: velas devolvidas intactas + última data normalizada
  assert.equal(byTicker.OK.status, 'SUCCESS');
  assert.equal(byTicker.OK.count, 2);
  assert.equal(byTicker.OK.lastDate, '2026-08-21');
  assert.equal(byTicker.OK.candles.length, 2);

  // NOOP: rede consumida, zero velas novas
  assert.equal(byTicker.EMPTY.status, 'NOOP');
  assert.equal(byTicker.EMPTY.count, 0);

  // ALREADY_UP_TO_DATE: decisão local, sem rede
  assert.equal(byTicker.FRESH.status, 'ALREADY_UP_TO_DATE');
  assert.equal(byTicker.FRESH.lastDate, '2026-08-21');

  // SKIPPED_NO_INITIAL_DATE: decisão local, sem rede
  assert.equal(byTicker.NODATE.status, 'SKIPPED_NO_INITIAL_DATE');

  // ERROR: isolado, mensagem preservada
  assert.equal(byTicker.BOOM.status, 'ERROR');
  assert.match(byTicker.BOOM.error, /kaboom injetado/);
  assert.equal(byTicker.BOOM.lastDate, '2026-08-18');

  // CANCELLED: verificação prévia a tudo o resto
  assert.equal(byTicker.HALT.status, 'CANCELLED');

  // Só OK, EMPTY e BOOM chegaram ao fetchOne — SKIPPED/CANCELLED não gastam rede
  assert.deepEqual(fetched.slice().sort(), ['BOOM:2026-08-18', 'EMPTY:2026-08-19', 'OK:2026-08-19']);
});

test('erro num ticker não interrompe os restantes nem altera a ordem dos resultados', async () => {
  const tickers = Array.from({ length: 12 }, (_, i) => `T${String(i).padStart(2, '0')}`);
  const results = await syncTickersBatch(tickers, {
    getLastDate: () => '2026-08-19',
    expectedTradingDay: '2026-08-21',
    fetchOne: async ticker => {
      if (ticker === 'T05') throw new Error('falha isolada T05');
      return [mkCandle(ticker, '2026-08-20')];
    }
  });

  assert.equal(results.length, 12);
  assert.deepEqual(results.map(r => r.ticker), tickers); // Promise.all preserva a ordem
  assert.equal(results.filter(r => r.status === 'SUCCESS').length, 11);
  const failures = results.filter(r => r.status === 'ERROR');
  assert.equal(failures.length, 1);
  assert.equal(failures[0].ticker, 'T05');
  assert.match(failures[0].error, /falha isolada T05/);
});

test('shouldContinue falso desde o início cancela todas as tarefas sem tocar no fetchOne', async () => {
  let fetchCalls = 0;
  const results = await syncTickersBatch(['AAA', 'BBB', 'CCC'], {
    getLastDate: () => '2026-08-19',
    shouldContinue: () => false,
    fetchOne: async ticker => { fetchCalls += 1; return [mkCandle(ticker, '2026-08-20')]; }
  });
  assert.equal(fetchCalls, 0);
  assert.equal(results.length, 3);
  assert.equal(results.every(r => r.status === 'CANCELLED'), true);
});

test('cancelamento a meio permite apenas as primeiras tarefas e aborta o resto', async () => {
  let allowed = 3;
  let fetchCalls = 0;
  const tickers = Array.from({ length: 10 }, (_, i) => `K${i}`);
  const results = await syncTickersBatch(tickers, {
    getLastDate: () => '2026-08-19',
    expectedTradingDay: '2026-08-21',
    shouldContinue: () => allowed-- > 0,
    fetchOne: async ticker => { fetchCalls += 1; return [mkCandle(ticker, '2026-08-20')]; }
  });
  assert.equal(fetchCalls, 3);
  assert.equal(results.filter(r => r.status === 'SUCCESS').length, 3);
  assert.equal(results.filter(r => r.status === 'CANCELLED').length, 7);
});

test('networkLimit satura em pico exatamente igual a 5 com 12 tarefas enfileiradas', async () => {
  // É aqui que vive o teto real de concorrência de rede (p-limit(5)).
  let active = 0;
  let peak = 0;
  let executed = 0;
  const slowJob = async () => {
    active += 1;
    peak = Math.max(peak, active);
    await sleep(20); // timer curto: garante sobreposição sem depender de velocidade
    active -= 1;
    executed += 1;
  };
  await Promise.all(Array.from({ length: 12 }, () => networkLimit(slowJob)));
  assert.equal(executed, 12, 'todas as tarefas devem executar');
  assert.ok(peak <= 5, `pico ${peak} excede o limite da pool`);
  assert.equal(peak, 5, `a pool devia saturar em 5; pico observado: ${peak}`);
});

test('syncTickersBatch corre o fetchOne injetado sem pool própria (teto real vive nas funções de rede)', async () => {
  // Documenta a decisão de design do orquestrador: as tasks NÃO são embrulhadas
  // em networkLimit (p-limit não é reentrante); quem adquire slots são as
  // funções de rede finais. Com fetchOne injetado, o fan-out Promise.all corre
  // tudo em paralelo.
  let active = 0;
  let peak = 0;
  const tickers = Array.from({ length: 12 }, (_, i) => `SLOW${i}`);
  const results = await syncTickersBatch(tickers, {
    getLastDate: () => '2026-08-19',
    expectedTradingDay: '2026-08-21',
    fetchOne: async ticker => {
      active += 1;
      peak = Math.max(peak, active);
      await sleep(20);
      active -= 1;
      return [mkCandle(ticker, '2026-08-20')];
    }
  });
  assert.equal(results.every(r => r.status === 'SUCCESS'), true);
  assert.equal(peak, 12, `fan-out Promise.all devia correr as 12 em paralelo; pico: ${peak}`);
});

test('forceFull força a busca completa quando não há data inicial', async () => {
  const receivedLastDates = [];
  const results = await syncTickersBatch(['AAA'], {
    forceFull: true,
    fetchOne: async (ticker, lastDate) => { receivedLastDates.push(lastDate); return [mkCandle(ticker, '2020-01-01')]; }
  });
  assert.deepEqual(receivedLastDates, [null]); // lastDate normalizado a null
  assert.equal(results[0].status, 'SUCCESS');
  assert.equal(results[0].count, 1);
  assert.equal(results[0].lastDate, '2020-01-01');
});

test('getLastDate que lança é tratado como ausência de data inicial', async () => {
  let fetchCalls = 0;
  const results = await syncTickersBatch(['AAA'], {
    getLastDate: () => { throw new Error('db indisponível'); },
    fetchOne: async () => { fetchCalls += 1; return []; }
  });
  assert.equal(fetchCalls, 0);
  assert.equal(results[0].status, 'SKIPPED_NO_INITIAL_DATE');
});

test('tickers nulos ou vazios são filtrados antes do agendamento', async () => {
  const results = await syncTickersBatch(['AAA', null, '', 'BBB'], {
    getLastDate: () => null,
    fetchOne: async () => []
  });
  assert.deepEqual(results.map(r => r.ticker), ['AAA', 'BBB']);
  assert.equal(results.every(r => r.status === 'SKIPPED_NO_INITIAL_DATE'), true);
});

// ═════════════════════════════════════════════════════════════════════════════
//  C. createProgressReporter — throttle com relógio injetável
// ═════════════════════════════════════════════════════════════════════════════

function fakeClock(start = 10000) {
  let t = start;
  return {
    now: () => t,
    advance: ms => { t += ms; }
  };
}

test('createProgressReporter emite a primeira conclusão e suprime dentro da janela', { skip: createProgressReporter ? false : PROGRESS_SKIP_REASON }, () => {
  const clock = fakeClock();
  const reporter = createProgressReporter({ minIntervalMs: 100, everyN: 10, now: clock.now });
  assert.equal(reporter.report({ ticker: 'AAA' }), true);   // primeira: estado limpo emite sempre
  clock.advance(50);
  assert.equal(reporter.report({ ticker: 'BBB' }), false);  // 50ms < 100ms
  clock.advance(30);
  assert.equal(reporter.report({ ticker: 'CCC' }), false);  // 80ms < 100ms
  clock.advance(19);
  assert.equal(reporter.report({ ticker: 'DDD' }), false);  // 99ms < 100ms
  clock.advance(1);
  assert.equal(reporter.report({ ticker: 'EEE' }), true);   // fronteira inclusiva: 100ms >= 100ms
});

test('createProgressReporter emite a cada everyN conclusões mesmo com relógio parado', { skip: createProgressReporter ? false : PROGRESS_SKIP_REASON }, () => {
  const clock = fakeClock();
  const reporter = createProgressReporter({ minIntervalMs: 100, everyN: 10, now: clock.now });
  assert.equal(reporter.report({}), true); // emissão inicial
  for (let i = 2; i <= 10; i++) {
    assert.equal(reporter.report({}), false, `conclusão ${i} devia ser suprimida (< everyN, sem gap temporal)`);
  }
  assert.equal(reporter.report({}), true); // 10.ª conclusão desde o último emit
  assert.equal(reporter.report({}), false); // contador reinicia após cada emit
});

test('createProgressReporter emite sempre a última conclusão (isLast) mesmo dentro da janela', { skip: createProgressReporter ? false : PROGRESS_SKIP_REASON }, () => {
  const clock = fakeClock();
  const reporter = createProgressReporter({ minIntervalMs: 100, everyN: 10, now: clock.now });
  assert.equal(reporter.report({}), true);
  clock.advance(1);
  assert.equal(reporter.report({}), false);
  assert.equal(reporter.report({ ticker: 'ZZZ', isLast: true }), true); // fim de operação nunca é engolido
  clock.advance(1);
  assert.equal(reporter.report({}), false); // isLast também reinicia contador/janela
});

test('createProgressReporter.reset repõe o estado interno do throttle', { skip: createProgressReporter ? false : PROGRESS_SKIP_REASON }, () => {
  const clock = fakeClock();
  const reporter = createProgressReporter({ minIntervalMs: 100, everyN: 10, now: clock.now });
  assert.equal(reporter.report({}), true);
  clock.advance(10);
  assert.equal(reporter.report({}), false); // dentro da janela
  reporter.reset();
  assert.equal(reporter.report({}), true);  // volta a comportar-se como primeira conclusão
  clock.advance(10);
  assert.equal(reporter.report({}), false); // nova janela em curso a partir do novo emit
});

// ═════════════════════════════════════════════════════════════════════════════
//  D. saveBulkHistoricalCandles — gravação SQLite em bloco (padrão da casa)
// ═════════════════════════════════════════════════════════════════════════════

function makeDb(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'markov-concurrency-test-'));
  const db = new DB(dir);
  db.init();
  t.after(() => {
    try { db.close(); } catch (_) { /* já fechada */ }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return db;
}

function dateAt(start, offsetDays) {
  return new Date(new Date(start + 'T00:00:00Z').getTime() + offsetDays * 86400000).toISOString().slice(0, 10);
}

test('saveBulkHistoricalCandles é idempotente: segunda execução com dados iguais devolve changes 0', { skip: SQLITE_AVAILABLE ? false : DB_SKIP_REASON }, t => {
  const db = makeDb(t);
  db.upsertStock({ ticker: 'AAA', name: 'AAA', country: 'Portugal', indexName: 'PSI' });
  const rows = [
    { ticker: 'AAA', date: '2024-06-10', open: 10, high: 11, low: 9, close: 10.5, volume: 1000 },
    { ticker: 'AAA', date: '2024-06-11', open: 10.5, high: 12, low: 10, close: 11, volume: 1200 },
    { ticker: 'AAA', date: '2024-06-12', open: 11, high: 12.5, low: 10.5, close: 12, volume: 900 }
  ];

  const first = db.saveBulkHistoricalCandles(rows);
  assert.deepEqual(first, { changes: 3, skipped: 0 });

  const second = db.saveBulkHistoricalCandles(rows);
  assert.deepEqual(second, { changes: 0, skipped: 0 }); // UPSERT condicional: nada mudou

  // Alteração pontual conta exatamente 1 change e não cria linha nova
  const bump = db.saveBulkHistoricalCandles([
    { ticker: 'AAA', date: '2024-06-11', open: 10.5, high: 12, low: 10, close: 99, volume: 1200 }
  ]);
  assert.deepEqual(bump, { changes: 1, skipped: 0 });
  assert.equal(db.getLocalHistoricalPrices('AAA').find(c => c.date === '2024-06-11').close, 99);
  assert.equal(db.db.prepare('SELECT COUNT(*) AS n FROM historical_prices').get().n, 3);
});

test('saveBulkHistoricalCandles faz coerção: ticker canónico, date slice(0,10), números e volume||0', { skip: SQLITE_AVAILABLE ? false : DB_SKIP_REASON }, t => {
  const db = makeDb(t);
  db.upsertStock({ ticker: 'bbb.ls', name: 'BBB', country: 'Portugal', indexName: 'PSI' });
  const res = db.saveBulkHistoricalCandles([
    // ticker sujo, date ISO completa, preços em string, sem volume
    { ticker: ' bbb.ls ', date: '2024-06-14T21:00:00.000Z', open: '10', high: '11.5', low: '9.25', close: '10.75' },
    // volume nulo → 0
    { ticker: 'BBB.LS', date: '2024-06-17', open: 10, high: 11, low: 9, close: 10.5, volume: null }
  ]);
  assert.deepEqual(res, { changes: 2, skipped: 0 });

  const rows = db.getLocalHistoricalPrices('BBB.LS');
  assert.deepEqual(rows.map(r => r.date), ['2024-06-14', '2024-06-17']); // slice(0,10) + ordenação ASC
  assert.equal(rows[0].close, 10.75); // Number('10.75')
  assert.equal(rows[0].volume, 0);    // volume ausente → 0
  assert.equal(rows[0].open, 10);     // Number('10')
  assert.equal(rows[1].volume, 0);    // volume null → 0
});

test('linhas inválidas incrementam skipped sem abortar o lote', { skip: SQLITE_AVAILABLE ? false : DB_SKIP_REASON }, t => {
  const db = makeDb(t);
  db.upsertStock({ ticker: 'CCC', name: 'CCC', country: 'EUA', indexName: 'SP500' });
  const res = db.saveBulkHistoricalCandles([
    { ticker: 'CCC', date: '2024-06-10', open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 },   // válida
    { ticker: 'CCC', date: '', open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 },             // date vazia
    { ticker: '', date: '2024-06-11', open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 },      // ticker vazio
    { ticker: 'CCC', date: '2024-06-12', open: NaN, high: 2, low: 0.5, close: 1.5, volume: 10 }, // preço não finito
    { ticker: 'CCC', date: '2024-06-13', open: Infinity, high: 2, low: 0.5, close: 1.5, volume: 10 },
    {},                                                                                           // tudo em falta
    { ticker: 'CCC', date: '2024-06-14', open: 1, high: 2, low: 0.5, close: 1.6, volume: 10 }    // válida
  ]);
  assert.deepEqual(res, { changes: 2, skipped: 5 });
  assert.deepEqual(db.getLocalHistoricalPrices('CCC').map(r => r.date), ['2024-06-10', '2024-06-14']);

  // Entradas degeneradas não rebentam
  assert.deepEqual(db.saveBulkHistoricalCandles([]), { changes: 0, skipped: 0 });
  assert.deepEqual(db.saveBulkHistoricalCandles(null), { changes: 0, skipped: 0 });
  assert.deepEqual(db.saveBulkHistoricalCandles(undefined), { changes: 0, skipped: 0 });
});

test('gravação em bloco: 500 velas numa única transação fica abaixo do orçamento de tempo', { skip: SQLITE_AVAILABLE ? false : DB_SKIP_REASON }, t => {
  const db = makeDb(t);
  const tickers = ['PERFA', 'PERFB', 'PERFC', 'PERFD', 'PERFE'];
  for (const tk of tickers) db.upsertStock({ ticker: tk, name: tk, country: 'EUA', indexName: 'SP500' });
  const rows = [];
  for (const tk of tickers) {
    for (let d = 0; d < 100; d++) {
      rows.push({
        ticker: tk,
        date: dateAt('2020-01-01', d),
        open: 10 + d * 0.01, high: 11 + d * 0.01, low: 9 + d * 0.01, close: 10.5 + d * 0.01,
        volume: 1000 + d
      });
    }
  }
  assert.equal(rows.length, 500);

  const t0 = process.hrtime.bigint();
  const res = db.saveBulkHistoricalCandles(rows);
  const elapsedMs = Number(process.hrtime.bigint() - t0) / 1e6;

  assert.deepEqual(res, { changes: 500, skipped: 0 });
  console.log(`[perf] saveBulkHistoricalCandles: 500 velas gravadas em ${elapsedMs.toFixed(1)}ms`);
  // Alvo interno <50ms; margem frouxa (200ms) para CI partilhado.
  assert.ok(elapsedMs < 200, `lote de 500 velas demorou ${elapsedMs.toFixed(1)}ms (orçamento frouxo de CI)`);
});

test('saveHistoricalCandlesBatch mantém o contrato {changes} com UPSERT condicional', { skip: SQLITE_AVAILABLE ? false : DB_SKIP_REASON }, t => {
  const db = makeDb(t);
  db.upsertStock({ ticker: 'DDD', name: 'DDD', country: 'Portugal', indexName: 'PSI' });
  const entry = (date, close) => ({
    ticker: 'DDD',
    candles: [{ ticker: 'DDD', date, open: close, high: close + 1, low: close - 1, close, volume: 100 }]
  });

  assert.deepEqual(
    db.saveHistoricalCandlesBatch([entry('2024-07-01', 10), entry('2024-07-02', 11)]),
    { changes: 2 }
  );
  // Reenvio idêntico → 0; atualização → 1
  assert.equal(db.saveHistoricalCandlesBatch([entry('2024-07-02', 11)]).changes, 0);
  assert.equal(db.saveHistoricalCandlesBatch([entry('2024-07-02', 12)]).changes, 1);
  assert.equal(db.getLocalHistoricalPrices('DDD').find(c => c.date === '2024-07-02').close, 12);
  // Lista vazia mantém a API estável
  assert.deepEqual(db.saveHistoricalCandlesBatch([]), { changes: 0 });
});
