'use strict';

/**
 * Endurecimento (F1-F11) do motor `evaluateMonitoringAssetsDaily()` e dos KPIs
 * de `getMonitoringAnalytics()`.
 *
 * Semântica validada:
 *  - Janela de preços `[analysis_date, analysis_date + 35d]`, velas por ordem
 *    ASC e resolução no primeiro toque:
 *      COMPRA: high >= target -> TARGET; low <= stop -> STOP.
 *      VENDA:  low <= target -> TARGET; high >= stop -> STOP.
 *    Empate na mesma vela (target e stop tocados) -> TARGET.
 *  - Só sem toque dentro da janela E `daysPassed >= 35` -> EXPIRADO, fechando
 *    no close e data da última vela da janela. Um toque dentro da janela numa
 *    avaliação atrasada (40 dias) permanece TARGET; toques fora da janela não
 *    resolvem.
 *  - `exit_date` é a data da vela do toque em COMPRA e VENDA.
 *  - `target_price`/`stop_loss` <= 0 nunca resolvem; `direction` só
 *    COMPRA/VENDA (case-insensitive, com trim).
 *  - Velas com `close <= 0` são ignoradas; `high`/`low` <= 0 usam o close.
 *  - `analysis_date` inválida cai para `created_at`; sem fallback válido a
 *    linha não é tocada.
 *  - `pendingCount` inclui qualquer estado não resolvido (incl. desconhecidos).
 *  - Tiers `[50,55) [55,60) [60,65) [65,70) [70,100]`.
 *  - `records` limitado a 1000, ordenado `analysis_date DESC, alpha_score DESC`
 *    com `recordsTotal` = total real.
 *  - Idempotência da 2ª execução e rollback total da transação do motor.
 *
 * Rede real: nenhuma. SQLite sempre temporário e `QUANT_TRACKER_DB_PATH`
 * apontado para um diretório temporário (nunca o `quant_tracker.db` canónico).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { makeTempDir, removeTempDir } = require('./helpers');

let DB = null;
let SQLITE_AVAILABLE = false;
try {
  require('better-sqlite3');
  DB = require('../src/db/database');
  SQLITE_AVAILABLE = true;
} catch (_) {
  // ABI nativo indisponível: os testes de DB ficam em skip.
}

// Isolamento do tracker canónico (o motor não o toca, mas o construtor da DB
// pode sincronizar noutros caminhos; garantir que nunca escreve no real).
const NOSYNC_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'test-monitoring-hardening-nosync-'));
const ORIGINAL_QUANT_TRACKER_DB_PATH = process.env.QUANT_TRACKER_DB_PATH;
process.env.QUANT_TRACKER_DB_PATH = path.join(NOSYNC_DIR, 'quant_tracker.db');

test.after(() => {
  if (ORIGINAL_QUANT_TRACKER_DB_PATH === undefined) {
    delete process.env.QUANT_TRACKER_DB_PATH;
  } else {
    process.env.QUANT_TRACKER_DB_PATH = ORIGINAL_QUANT_TRACKER_DB_PATH;
  }
  removeTempDir(NOSYNC_DIR);
});

// ── helpers determinísticos ────────────────────────────────────────────
const DAY_MS = 86400000;
const todayIso = () => new Date().toISOString().split('T')[0];
const isoDayOffset = (days) => new Date(Date.now() + days * DAY_MS).toISOString().split('T')[0];

async function withDb(fn) {
  const dir = makeTempDir('test-monitoring-hardening-');
  let db;
  try {
    db = new DB(dir);
    await db.init();
    await fn(db);
  } finally {
    if (db) db.close();
    removeTempDir(dir);
  }
}

function monitoringRow(overrides = {}) {
  return {
    ticker: 'T',
    company_name: 'T Corp',
    country: 'PT',
    sector: 'Tecnologia',
    direction: 'COMPRA',
    entry_price: 100,
    target_price: 110,
    stop_loss: 95,
    current_price: 100,
    win_rate_mc: 60,
    cvar_95: 4,
    graham_score: 55,
    alpha_score: 70,
    analysis_date: todayIso(),
    status: 'MONITORIZANDO',
    exit_date: null,
    exit_price: null,
    pnl_pct: null,
    created_at: null,
    ...overrides
  };
}

const MONITORING_COLS = [
  'ticker', 'company_name', 'country', 'sector', 'direction',
  'entry_price', 'target_price', 'stop_loss', 'current_price',
  'win_rate_mc', 'cvar_95', 'graham_score', 'alpha_score', 'analysis_date',
  'status', 'exit_date', 'exit_price', 'pnl_pct', 'created_at'
];
const MONITORING_PARAMS = MONITORING_COLS.map((c) => `@${c}`).join(', ');

function insertMonitoringRows(db, rows) {
  const stmt = db.db.prepare(
    `INSERT INTO investment_monitoring_universe (${MONITORING_COLS.join(', ')}) VALUES (${MONITORING_PARAMS})`
  );
  const tx = db.db.transaction((items) => {
    for (const item of items) stmt.run(monitoringRow(item));
  });
  tx(rows);
}

function insertMonitoringRow(db, overrides = {}) {
  insertMonitoringRows(db, [overrides]);
}

function insertCandle(db, ticker, date, values) {
  const candle = { open: values.close, high: values.close, low: values.close, volume: 1000, ...values };
  db.db.prepare(
    'INSERT INTO historical_prices (ticker, date, open, high, low, close, volume) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(ticker, date, candle.open, candle.high, candle.low, candle.close, candle.volume);
}

const getRow = (db, ticker) => db.db.prepare(
  'SELECT * FROM investment_monitoring_universe WHERE ticker = ?'
).get(ticker);

const snapshot = (db) => db.db.prepare(
  'SELECT * FROM investment_monitoring_universe ORDER BY ticker ASC'
).all();

// ── F1: janela [analysis_date, analysis_date + 35d] ────────────────────
test('F1a: toque dentro da janela resolve TARGET mesmo com avaliação 40 dias atrasada', { skip: !SQLITE_AVAILABLE }, async () => {
  await withDb(async (db) => {
    const analysis = isoDayOffset(-40);
    insertMonitoringRows(db, [
      { ticker: 'F1A_IN', analysis_date: analysis, direction: 'COMPRA', entry_price: 100, target_price: 110, stop_loss: 95 },
      { ticker: 'F1A_EDGE', analysis_date: analysis, direction: 'COMPRA', entry_price: 100, target_price: 110, stop_loss: 95 }
    ]);
    // 30 dias após a análise (dentro da janela).
    insertCandle(db, 'F1A_IN', isoDayOffset(-30), { close: 100, high: 111, low: 99 });
    // Exatamente no fecho da janela: analysis + 35d (limite inclusivo).
    insertCandle(db, 'F1A_EDGE', isoDayOffset(-5), { close: 100, high: 111, low: 99 });

    const result = db.evaluateMonitoringAssetsDaily();
    assert.deepEqual(result, { updatedCount: 2, resolvedCount: 2 });

    const inside = getRow(db, 'F1A_IN');
    assert.equal(inside.status, 'TARGET_ATINGIDO');
    assert.equal(inside.exit_price, 110);
    assert.equal(inside.exit_date, isoDayOffset(-30), 'exit_date é a data da vela do toque');
    assert.equal(inside.pnl_pct, 10);
    assert.equal(inside.analysis_date, analysis, 'analysis_date não é reescrita');

    const edge = getRow(db, 'F1A_EDGE');
    assert.equal(edge.status, 'TARGET_ATINGIDO', 'analysis_date + 35d pertence à janela');
    assert.equal(edge.exit_date, isoDayOffset(-5));
    assert.equal(edge.exit_price, 110);
  });
});

test('F1b: toques fora da janela não resolvem -> EXPIRADO no último close da janela', { skip: !SQLITE_AVAILABLE }, async () => {
  await withDb(async (db) => {
    const analysis = isoDayOffset(-40);
    insertMonitoringRows(db, [
      { ticker: 'F1B_AFTER', analysis_date: analysis, direction: 'COMPRA', entry_price: 100, target_price: 110, stop_loss: 95 },
      { ticker: 'F1B_BEFORE', analysis_date: analysis, direction: 'COMPRA', entry_price: 100, target_price: 110, stop_loss: 95 }
    ]);
    // Toque tardio: analysis + 38d (fora da janela, que fecha em analysis+35d).
    insertCandle(db, 'F1B_AFTER', isoDayOffset(-6), { close: 100, high: 101, low: 99 });
    insertCandle(db, 'F1B_AFTER', isoDayOffset(-2), { close: 105, high: 111, low: 99 });
    // Toque antes da análise (fora da janela).
    insertCandle(db, 'F1B_BEFORE', isoDayOffset(-43), { close: 100, high: 111, low: 99 });
    insertCandle(db, 'F1B_BEFORE', isoDayOffset(-6), { close: 102, high: 103, low: 101 });

    const result = db.evaluateMonitoringAssetsDaily();
    assert.deepEqual(result, { updatedCount: 2, resolvedCount: 2 });

    const after = getRow(db, 'F1B_AFTER');
    assert.equal(after.status, 'EXPIRADO', 'toque depois do horizonte não resolve');
    assert.equal(after.exit_price, 100, 'fecha no último close da janela, não no toque fora dela');
    assert.equal(after.exit_date, isoDayOffset(-6));
    assert.equal(after.pnl_pct, 0);

    const before = getRow(db, 'F1B_BEFORE');
    assert.equal(before.status, 'EXPIRADO', 'toque antes da análise não resolve');
    assert.equal(before.exit_price, 102);
    assert.equal(before.exit_date, isoDayOffset(-6));
    assert.equal(before.pnl_pct, 2);
  });
});

test('F1c: sem toques -> EXPIRADO com o close/data da última vela da janela (COMPRA e VENDA)', { skip: !SQLITE_AVAILABLE }, async () => {
  await withDb(async (db) => {
    const analysis = isoDayOffset(-40);
    insertMonitoringRows(db, [
      { ticker: 'F1C_BUY', analysis_date: analysis, direction: 'COMPRA', entry_price: 100, target_price: 200, stop_loss: 10 },
      { ticker: 'F1C_SELL', analysis_date: analysis, direction: 'VENDA', entry_price: 100, target_price: 10, stop_loss: 500 }
    ]);
    // Última vela dentro da janela: analysis + 35d.
    insertCandle(db, 'F1C_BUY', isoDayOffset(-39), { close: 100, high: 101, low: 99 });
    insertCandle(db, 'F1C_BUY', isoDayOffset(-5), { close: 105, high: 106, low: 104 });
    // Vela posterior à janela: não pode influenciar o fecho nem `current_price`.
    insertCandle(db, 'F1C_BUY', isoDayOffset(-1), { close: 130, high: 140, low: 129 });

    insertCandle(db, 'F1C_SELL', isoDayOffset(-39), { close: 100, high: 101, low: 99 });
    insertCandle(db, 'F1C_SELL', isoDayOffset(-5), { close: 102, high: 103, low: 101 });
    insertCandle(db, 'F1C_SELL', isoDayOffset(-1), { close: 80, high: 81, low: 79 });

    const result = db.evaluateMonitoringAssetsDaily();
    assert.deepEqual(result, { updatedCount: 2, resolvedCount: 2 });

    const buy = getRow(db, 'F1C_BUY');
    assert.equal(buy.status, 'EXPIRADO');
    assert.equal(buy.exit_price, 105);
    assert.equal(buy.exit_date, isoDayOffset(-5));
    assert.equal(buy.pnl_pct, 5);
    assert.equal(buy.current_price, 105, 'current_price usa a última vela da janela, não a mais recente global');

    const sell = getRow(db, 'F1C_SELL');
    assert.equal(sell.status, 'EXPIRADO');
    assert.equal(sell.exit_price, 102);
    assert.equal(sell.exit_date, isoDayOffset(-5));
    assert.equal(sell.pnl_pct, -2);
    assert.equal(sell.current_price, 102);
  });
});

// ── F2: primeiro toque ASC e empate na mesma vela ──────────────────────
test('F2: stop no dia 1 e target no dia 2 -> STOP; na mesma vela -> TARGET (COMPRA e VENDA)', { skip: !SQLITE_AVAILABLE }, async () => {
  await withDb(async (db) => {
    const analysis = isoDayOffset(-3);
    const day1 = isoDayOffset(-3);
    const day2 = isoDayOffset(-2);

    insertMonitoringRows(db, [
      { ticker: 'F2_BUY_1ST', analysis_date: analysis, direction: 'COMPRA', entry_price: 100, target_price: 110, stop_loss: 95 },
      { ticker: 'F2_SELL_1ST', analysis_date: analysis, direction: 'VENDA', entry_price: 100, target_price: 90, stop_loss: 105 },
      { ticker: 'F2_BUY_SAME', analysis_date: analysis, direction: 'COMPRA', entry_price: 100, target_price: 110, stop_loss: 95 },
      { ticker: 'F2_SELL_SAME', analysis_date: analysis, direction: 'VENDA', entry_price: 100, target_price: 90, stop_loss: 105 }
    ]);

    // COMPRA: stop no dia 1, target no dia 2.
    insertCandle(db, 'F2_BUY_1ST', day1, { close: 96, high: 101, low: 94 });
    insertCandle(db, 'F2_BUY_1ST', day2, { close: 111, high: 112, low: 99 });
    // VENDA: target no dia 1, stop no dia 2.
    insertCandle(db, 'F2_SELL_1ST', day1, { close: 91, high: 102, low: 89 });
    insertCandle(db, 'F2_SELL_1ST', day2, { close: 104, high: 106, low: 95 });
    // Mesma vela toca target e stop.
    insertCandle(db, 'F2_BUY_SAME', day2, { close: 100, high: 111, low: 94 });
    insertCandle(db, 'F2_SELL_SAME', day2, { close: 100, high: 106, low: 89 });

    const result = db.evaluateMonitoringAssetsDaily();
    assert.deepEqual(result, { updatedCount: 4, resolvedCount: 4 });

    const buyFirst = getRow(db, 'F2_BUY_1ST');
    assert.equal(buyFirst.status, 'STOP_ATINGIDO', 'o primeiro toque é o stop no dia 1');
    assert.equal(buyFirst.exit_price, 95);
    assert.equal(buyFirst.exit_date, day1);
    assert.equal(buyFirst.pnl_pct, -5);

    const sellFirst = getRow(db, 'F2_SELL_1ST');
    assert.equal(sellFirst.status, 'TARGET_ATINGIDO', 'o primeiro toque é o target no dia 1');
    assert.equal(sellFirst.exit_price, 90);
    assert.equal(sellFirst.exit_date, day1);
    assert.equal(sellFirst.pnl_pct, 10);

    const buySame = getRow(db, 'F2_BUY_SAME');
    assert.equal(buySame.status, 'TARGET_ATINGIDO', 'empate na COMPRA resolve TARGET');
    assert.equal(buySame.exit_price, 110);
    assert.equal(buySame.exit_date, day2);

    const sellSame = getRow(db, 'F2_SELL_SAME');
    assert.equal(sellSame.status, 'TARGET_ATINGIDO', 'empate na VENDA resolve TARGET');
    assert.equal(sellSame.exit_price, 90);
    assert.equal(sellSame.exit_date, day2);
  });
});

// ── F4: exit_date da VENDA é a data da vela do toque ───────────────────
test('F4: VENDA usa a data da vela do toque em target e stop', { skip: !SQLITE_AVAILABLE }, async () => {
  await withDb(async (db) => {
    const analysis = isoDayOffset(-10);
    const targetDay = isoDayOffset(-7);
    const stopDay = isoDayOffset(-6);
    insertMonitoringRows(db, [
      { ticker: 'F4_SELL_T', analysis_date: analysis, direction: 'VENDA', entry_price: 100, target_price: 90, stop_loss: 105 },
      { ticker: 'F4_SELL_S', analysis_date: analysis, direction: 'VENDA', entry_price: 100, target_price: 10, stop_loss: 105 }
    ]);
    insertCandle(db, 'F4_SELL_T', targetDay, { close: 95, high: 101, low: 89 });
    // Vela posterior toca o stop; não pode reescrever o target já resolvido.
    insertCandle(db, 'F4_SELL_T', isoDayOffset(-2), { close: 106, high: 107, low: 100 });
    insertCandle(db, 'F4_SELL_S', stopDay, { close: 104, high: 106, low: 99 });

    const result = db.evaluateMonitoringAssetsDaily();
    assert.deepEqual(result, { updatedCount: 2, resolvedCount: 2 });

    const target = getRow(db, 'F4_SELL_T');
    assert.equal(target.status, 'TARGET_ATINGIDO');
    assert.equal(target.exit_price, 90);
    assert.equal(target.exit_date, targetDay, 'exit_date da VENDA é a data da vela');
    assert.equal(target.pnl_pct, 10);

    const stop = getRow(db, 'F4_SELL_S');
    assert.equal(stop.status, 'STOP_ATINGIDO');
    assert.equal(stop.exit_price, 105);
    assert.equal(stop.exit_date, stopDay);
    assert.equal(stop.pnl_pct, -5);
  });
});

// ── F3: target/stop <= 0 nunca resolvem ────────────────────────────────
test('F3: target 0/negativo nunca dá TARGET e stop 0/negativo nunca dá STOP', { skip: !SQLITE_AVAILABLE }, async () => {
  await withDb(async (db) => {
    insertMonitoringRows(db, [
      { ticker: 'F3_ZERO_NOW', analysis_date: todayIso(), direction: 'COMPRA', entry_price: 100, target_price: 0, stop_loss: 0 },
      { ticker: 'F3_ZERO_OLD', analysis_date: isoDayOffset(-40), direction: 'COMPRA', entry_price: 100, target_price: 0, stop_loss: 10 },
      { ticker: 'F3_NEG_OLD', analysis_date: isoDayOffset(-40), direction: 'COMPRA', entry_price: 100, target_price: -5, stop_loss: -1 }
    ]);
    insertCandle(db, 'F3_ZERO_NOW', todayIso(), { close: 101, high: 999, low: 0.01 });
    insertCandle(db, 'F3_ZERO_OLD', isoDayOffset(-38), { close: 100, high: 999, low: 99 });
    insertCandle(db, 'F3_NEG_OLD', isoDayOffset(-38), { close: 100, high: 999, low: -999 });

    const result = db.evaluateMonitoringAssetsDaily();
    assert.deepEqual(result, { updatedCount: 3, resolvedCount: 2 });

    const zeroNow = getRow(db, 'F3_ZERO_NOW');
    assert.equal(zeroNow.status, 'MONITORIZANDO', 'target/stop 0 são ignorados');
    assert.equal(zeroNow.current_price, 101);
    assert.equal(zeroNow.exit_price, null);

    const zeroOld = getRow(db, 'F3_ZERO_OLD');
    assert.equal(zeroOld.status, 'EXPIRADO', 'sem stop válido, expira em vez de resolver');
    assert.notEqual(zeroOld.status, 'TARGET_ATINGIDO');
    assert.equal(zeroOld.exit_price, 100);

    const negOld = getRow(db, 'F3_NEG_OLD');
    assert.equal(negOld.status, 'EXPIRADO');
    assert.notEqual(negOld.status, 'TARGET_ATINGIDO');
    assert.notEqual(negOld.status, 'STOP_ATINGIDO');
    assert.equal(negOld.exit_price, 100);
  });
});

// ── F5: direction só COMPRA/VENDA (case-insensitive) ───────────────────
test('F5: direction buy/short/vazio fica intocada; variações de COMPRA/VENDA resolvem', { skip: !SQLITE_AVAILABLE }, async () => {
  await withDb(async (db) => {
    const today = todayIso();
    const badDirections = ['buy', 'short', '', 'BUY ', ' short', 'comprado'];
    badDirections.forEach((direction, i) => {
      insertMonitoringRow(db, {
        ticker: `F5_BAD_${i}`, direction, analysis_date: today,
        entry_price: 100, target_price: 110, stop_loss: 95, current_price: 100
      });
      insertCandle(db, `F5_BAD_${i}`, today, { close: 100, high: 999, low: 1 });
    });
    insertMonitoringRow(db, {
      ticker: 'F5_OK', direction: '  venda  ', analysis_date: today,
      entry_price: 100, target_price: 90, stop_loss: 105, current_price: 100
    });
    insertCandle(db, 'F5_OK', today, { close: 95, high: 101, low: 89 });

    const before = snapshot(db);
    const beforeBad = before.filter((r) => r.ticker.startsWith('F5_BAD_'));

    const result = db.evaluateMonitoringAssetsDaily();
    assert.deepEqual(result, { updatedCount: 1, resolvedCount: 1 });

    const ok = getRow(db, 'F5_OK');
    assert.equal(ok.status, 'TARGET_ATINGIDO', 'VENDA em minúsculas com espaços é aceite');
    assert.equal(ok.exit_date, today);

    const afterBad = snapshot(db).filter((r) => r.ticker.startsWith('F5_BAD_'));
    assert.deepEqual(afterBad, beforeBad, 'linhas com direction inválida ficam exatamente iguais');
    for (const row of afterBad) {
      assert.equal(row.status, 'MONITORIZANDO');
      assert.equal(row.exit_date, null);
      assert.equal(row.current_price, 100, 'nem o current_price é atualizado');
    }
  });
});

// ── F9: fallback de analysis_date para created_at ──────────────────────
test('F9: analysis_date inválida usa created_at; sem created_at válido a linha fica intocada', { skip: !SQLITE_AVAILABLE }, async () => {
  await withDb(async (db) => {
    const createdAt = `${isoDayOffset(-10)} 08:15:00`;
    insertMonitoringRows(db, [
      { ticker: 'F9_FALLBACK', analysis_date: 'não-é-data', created_at: createdAt, direction: 'COMPRA', entry_price: 100, target_price: 110, stop_loss: 95 },
      { ticker: 'F9_NOCREATED', analysis_date: 'também-má', created_at: null, direction: 'COMPRA', entry_price: 100, target_price: 110, stop_loss: 95 },
      { ticker: 'F9_BADCREATED', analysis_date: 'também-má', created_at: 'mau-demais', direction: 'COMPRA', entry_price: 100, target_price: 110, stop_loss: 95 }
    ]);
    insertCandle(db, 'F9_FALLBACK', isoDayOffset(-5), { close: 108, high: 111, low: 105 });
    insertCandle(db, 'F9_NOCREATED', todayIso(), { close: 120, high: 130, low: 80 });
    insertCandle(db, 'F9_BADCREATED', todayIso(), { close: 120, high: 130, low: 80 });

    const result = db.evaluateMonitoringAssetsDaily();
    assert.deepEqual(result, { updatedCount: 1, resolvedCount: 1 });

    const fallback = getRow(db, 'F9_FALLBACK');
    assert.equal(fallback.status, 'TARGET_ATINGIDO', 'created_at válido serve de analysis_date');
    assert.equal(fallback.exit_price, 110);
    assert.equal(fallback.exit_date, isoDayOffset(-5));
    assert.equal(fallback.analysis_date, 'não-é-data', 'o valor inválido persistido não é reescrito');

    for (const ticker of ['F9_NOCREATED', 'F9_BADCREATED']) {
      const row = getRow(db, ticker);
      assert.equal(row.status, 'MONITORIZANDO', `${ticker} sem fallback válido não é avaliada`);
      assert.equal(row.current_price, 100);
      assert.equal(row.exit_date, null);
      assert.equal(row.exit_price, null);
    }
  });
});

// ── F11: high/low <= 0 usam o close; close <= 0 ignora a vela ──────────
test('F11: high/low a 0/negativos usam o close; vela com close 0 é ignorada', { skip: !SQLITE_AVAILABLE }, async () => {
  await withDb(async (db) => {
    const day = isoDayOffset(-5);
    insertMonitoringRows(db, [
      { ticker: 'F11_HIGH_ZERO', analysis_date: day, direction: 'COMPRA', entry_price: 100, target_price: 110, stop_loss: 95 },
      { ticker: 'F11_LOW_ZERO', analysis_date: day, direction: 'COMPRA', entry_price: 100, target_price: 200, stop_loss: 97 },
      { ticker: 'F11_NEG', analysis_date: day, direction: 'COMPRA', entry_price: 100, target_price: 110, stop_loss: 95 },
      { ticker: 'F11_CLOSE_ZERO', analysis_date: day, direction: 'COMPRA', entry_price: 100, target_price: 110, stop_loss: 95 }
    ]);
    insertCandle(db, 'F11_HIGH_ZERO', day, { close: 120, high: 0, low: 0 });
    insertCandle(db, 'F11_LOW_ZERO', day, { close: 90, high: 0, low: 0 });
    insertCandle(db, 'F11_NEG', day, { close: 120, high: -5, low: -9 });
    insertCandle(db, 'F11_CLOSE_ZERO', day, { close: 0, high: 999, low: 1 });

    const result = db.evaluateMonitoringAssetsDaily();
    assert.deepEqual(result, { updatedCount: 3, resolvedCount: 3 });

    const highZero = getRow(db, 'F11_HIGH_ZERO');
    assert.equal(highZero.status, 'TARGET_ATINGIDO', 'high 0 usa o close (120 >= 110)');
    assert.equal(highZero.exit_price, 110);
    assert.equal(highZero.exit_date, day);

    const lowZero = getRow(db, 'F11_LOW_ZERO');
    assert.equal(lowZero.status, 'STOP_ATINGIDO', 'low 0 usa o close (90 <= 97)');
    assert.equal(lowZero.exit_price, 97);
    assert.equal(lowZero.exit_date, day);

    const negative = getRow(db, 'F11_NEG');
    assert.equal(negative.status, 'TARGET_ATINGIDO', 'high negativo usa o close');
    assert.equal(negative.exit_price, 110);

    const closeZero = getRow(db, 'F11_CLOSE_ZERO');
    assert.equal(closeZero.status, 'MONITORIZANDO', 'vela com close 0 é descartada');
    assert.equal(closeZero.current_price, 100, 'sem velas válidas a linha não é tocada');
    assert.equal(closeZero.exit_price, null);
  });
});

// ── F7: pendingCount inclui estados desconhecidos ──────────────────────
test('F7: PENDENTE/FOO/estados desconhecidos contam em pendingCount e a soma fecha o total', { skip: !SQLITE_AVAILABLE }, async () => {
  await withDb(async (db) => {
    insertMonitoringRows(db, [
      { ticker: 'F7_PEND', status: 'PENDENTE', win_rate_mc: 52 },
      { ticker: 'F7_FOO', status: 'FOO', win_rate_mc: 53 },
      { ticker: 'F7_MON', status: 'MONITORIZANDO', win_rate_mc: 54 },
      { ticker: 'F7_NULL', status: null, win_rate_mc: 55 },
      { ticker: 'F7_LOW', status: 'aguarda', win_rate_mc: 56 },
      { ticker: 'F7_T', status: 'TARGET_ATINGIDO', pnl_pct: 5, win_rate_mc: 57 },
      { ticker: 'F7_S', status: 'STOP_ATINGIDO', pnl_pct: -5, win_rate_mc: 58 },
      { ticker: 'F7_E', status: 'EXPIRADO', pnl_pct: 1, win_rate_mc: 59 }
    ]);

    const { kpis } = db.getMonitoringAnalytics();
    assert.equal(kpis.totalMonitored, 8);
    assert.equal(kpis.targetHits, 1);
    assert.equal(kpis.stopHits, 1);
    assert.equal(kpis.expiredCount, 1);
    assert.equal(kpis.pendingCount, 5, 'qualquer estado não resolvido conta como pendente');
    assert.equal(kpis.closedCount, 3);
    assert.equal(
      kpis.targetHits + kpis.stopHits + kpis.expiredCount + kpis.pendingCount,
      kpis.totalMonitored,
      'a partição dos estados fecha o total'
    );
  });
});

// ── F10: fronteiras dos tiers de win rate ──────────────────────────────
test('F10: tiers [50,55) [55,60) [60,65) [65,70) [70,100] com fronteiras exatas', { skip: !SQLITE_AVAILABLE }, async () => {
  await withDb(async (db) => {
    const rates = [49.999, 50, 54.995, 55.0, 59.999, 60, 70.0, 100.0, 100.001];
    insertMonitoringRows(db, rates.map((win_rate_mc, i) => ({
      ticker: `F10_${i}`,
      win_rate_mc,
      status: 'TARGET_ATINGIDO',
      pnl_pct: 1
    })));

    const { tierAccuracy } = db.getMonitoringAnalytics();
    assert.deepEqual(
      tierAccuracy.map((t) => t.tier),
      ['50-54%', '55-59%', '60-64%', '65-69%', '70%+']
    );
    const byTier = Object.fromEntries(tierAccuracy.map((t) => [t.tier, t]));

    assert.equal(byTier['50-54%'].totalCount, 2, '50 e 54.995 pertencem a 50-54%');
    assert.equal(byTier['55-59%'].totalCount, 2, '55.0 e 59.999 pertencem a 55-59%');
    assert.equal(byTier['60-64%'].totalCount, 1);
    assert.equal(byTier['65-69%'].totalCount, 0);
    assert.equal(byTier['70%+'].totalCount, 2, '70.0 e 100.0 pertencem a 70%+');
    assert.equal(
      tierAccuracy.reduce((sum, t) => sum + t.totalCount, 0),
      7,
      '49.999 e 100.001 ficam fora de todos os tiers'
    );
  });
});

// ── F8: records limitado a 1000 com recordsTotal real e ordem DESC ─────
test('F8: >1000 registos -> records.length 1000, recordsTotal real e ordem date DESC/alpha DESC', { skip: !SQLITE_AVAILABLE }, async () => {
  await withDb(async (db) => {
    const rows = [];
    for (let i = 0; i < 1005; i += 1) {
      rows.push({ ticker: `R${i}`, analysis_date: '2026-01-01', alpha_score: i, win_rate_mc: 60 });
    }
    // Data mais recente com alpha mais baixo: a data domina a ordenação.
    rows.push({ ticker: 'LATEST', analysis_date: '2026-02-01', alpha_score: -100, win_rate_mc: 60 });
    insertMonitoringRows(db, rows);

    const analytics = db.getMonitoringAnalytics();
    assert.equal(analytics.kpis.totalMonitored, 1006);
    assert.equal(analytics.recordsTotal, 1006, 'recordsTotal reflete o total real');
    assert.equal(analytics.records.length, 1000, 'a tabela é limitada a 1000');

    assert.equal(analytics.records[0].ticker, 'LATEST', 'analysis_date DESC domina alpha DESC');
    assert.equal(analytics.records[1].alpha_score, 1004);
    assert.equal(analytics.records[999].alpha_score, 6);

    for (let i = 1; i < analytics.records.length; i += 1) {
      const prev = analytics.records[i - 1];
      const cur = analytics.records[i];
      if (prev.analysis_date === cur.analysis_date) {
        assert.ok(Number(prev.alpha_score) >= Number(cur.alpha_score), `alpha DESC no índice ${i}`);
      } else {
        assert.ok(String(prev.analysis_date) > String(cur.analysis_date), `analysis_date DESC no índice ${i}`);
      }
    }

    const excluded = analytics.records.find((r) => r.ticker === 'R0');
    assert.equal(excluded, undefined, 'os alphas mais baixos ficam fora do corte');
  });
});

// ── Cenário misto: falhas isoladas não bloqueiam os restantes ──────────
test('misto: tickers resolvidos são persistidos e falhas (sem velas/direction/close 0) ficam intocadas', { skip: !SQLITE_AVAILABLE }, async () => {
  await withDb(async (db) => {
    const today = todayIso();
    insertMonitoringRows(db, [
      { ticker: 'MIX_RESOLVE', analysis_date: today, direction: 'COMPRA', entry_price: 100, target_price: 110, stop_loss: 95 },
      { ticker: 'MIX_PENDING', analysis_date: today, direction: 'COMPRA', entry_price: 100, target_price: 200, stop_loss: 10 },
      { ticker: 'MIX_NODATA', analysis_date: today, direction: 'COMPRA', entry_price: 100, target_price: 110, stop_loss: 95 },
      { ticker: 'MIX_BADDIR', analysis_date: today, direction: 'short', entry_price: 100, target_price: 110, stop_loss: 95 },
      { ticker: 'MIX_ZEROCLOSE', analysis_date: today, direction: 'COMPRA', entry_price: 100, target_price: 110, stop_loss: 95 }
    ]);
    insertCandle(db, 'MIX_RESOLVE', today, { close: 108, high: 111, low: 99 });
    insertCandle(db, 'MIX_PENDING', today, { close: 150, high: 151, low: 140 });
    insertCandle(db, 'MIX_BADDIR', today, { close: 120, high: 130, low: 80 });
    insertCandle(db, 'MIX_ZEROCLOSE', today, { close: 0, high: 999, low: 1 });

    const result = db.evaluateMonitoringAssetsDaily();
    assert.deepEqual(result, { updatedCount: 2, resolvedCount: 1 });

    const resolved = getRow(db, 'MIX_RESOLVE');
    assert.equal(resolved.status, 'TARGET_ATINGIDO');
    assert.equal(resolved.exit_price, 110);
    assert.equal(resolved.pnl_pct, 10);

    const pending = getRow(db, 'MIX_PENDING');
    assert.equal(pending.status, 'MONITORIZANDO');
    assert.equal(pending.current_price, 150);

    for (const ticker of ['MIX_NODATA', 'MIX_BADDIR', 'MIX_ZEROCLOSE']) {
      const row = getRow(db, ticker);
      assert.equal(row.status, 'MONITORIZANDO', `${ticker} fica pendente`);
      assert.equal(row.current_price, 100, `${ticker} não é tocado`);
      assert.equal(row.exit_price, null);
      assert.equal(row.exit_date, null);
      assert.equal(row.pnl_pct, null);
    }
  });
});

// ── k) Idempotência ────────────────────────────────────────────────────
test('k) idempotência: a 2ª execução só revê pendentes e não reescreve resolvidos', { skip: !SQLITE_AVAILABLE }, async () => {
  await withDb(async (db) => {
    const today = todayIso();
    insertMonitoringRows(db, [
      { ticker: 'IDEM_T', analysis_date: today, direction: 'COMPRA', entry_price: 100, target_price: 110, stop_loss: 95 },
      { ticker: 'IDEM_S', analysis_date: today, direction: 'COMPRA', entry_price: 100, target_price: 200, stop_loss: 95 },
      { ticker: 'IDEM_E', analysis_date: isoDayOffset(-40), direction: 'COMPRA', entry_price: 100, target_price: 200, stop_loss: 10 },
      { ticker: 'IDEM_P', analysis_date: today, direction: 'COMPRA', entry_price: 100, target_price: 200, stop_loss: 10 }
    ]);
    insertCandle(db, 'IDEM_T', today, { close: 111, high: 112, low: 109 });
    insertCandle(db, 'IDEM_S', today, { close: 94, high: 96, low: 93 });
    insertCandle(db, 'IDEM_E', isoDayOffset(-38), { close: 100, high: 101, low: 99 });
    insertCandle(db, 'IDEM_P', today, { close: 105, high: 106, low: 104 });

    const first = db.evaluateMonitoringAssetsDaily();
    assert.deepEqual(first, { updatedCount: 4, resolvedCount: 3 });

    const resolvedBefore = db.db.prepare(
      "SELECT * FROM investment_monitoring_universe WHERE status != 'MONITORIZANDO' ORDER BY ticker ASC"
    ).all();
    assert.equal(resolvedBefore.length, 3);

    // Novas velas que, se fossem reavaliadas, mudariam o resultado dos resolvidos.
    insertCandle(db, 'IDEM_T', isoDayOffset(1), { close: 90, high: 91, low: 89 });
    insertCandle(db, 'IDEM_S', isoDayOffset(1), { close: 500, high: 501, low: 499 });

    const second = db.evaluateMonitoringAssetsDaily();
    assert.deepEqual(second, { updatedCount: 1, resolvedCount: 0 }, 'só o pendente é revisto');

    const resolvedAfter = db.db.prepare(
      "SELECT * FROM investment_monitoring_universe WHERE status != 'MONITORIZANDO' ORDER BY ticker ASC"
    ).all();
    assert.deepEqual(resolvedAfter, resolvedBefore, 'nenhum campo dos resolvidos muda');
    assert.equal(getRow(db, 'IDEM_T').status, 'TARGET_ATINGIDO');
    assert.equal(getRow(db, 'IDEM_S').status, 'STOP_ATINGIDO');
    assert.equal(getRow(db, 'IDEM_P').current_price, 105);
  });
});

// ── k) Rollback atómico com erro forçado por trigger ───────────────────
test('k) rollback: erro forçado a meio do motor desfaz todas as atualizações da transação', { skip: !SQLITE_AVAILABLE }, async () => {
  await withDb(async (db) => {
    const today = todayIso();
    insertMonitoringRows(db, [
      { ticker: 'ROLL_A', analysis_date: today, direction: 'COMPRA', entry_price: 100, target_price: 110, stop_loss: 95 },
      { ticker: 'ROLL_BOOM', analysis_date: today, direction: 'COMPRA', entry_price: 100, target_price: 110, stop_loss: 95 },
      { ticker: 'ROLL_B', analysis_date: today, direction: 'COMPRA', entry_price: 100, target_price: 110, stop_loss: 95 }
    ]);
    for (const ticker of ['ROLL_A', 'ROLL_BOOM', 'ROLL_B']) {
      insertCandle(db, ticker, today, { close: 108, high: 112, low: 99 });
    }
    const before = snapshot(db);

    db.db.exec(`
      CREATE TRIGGER trg_eval_fail
      BEFORE UPDATE ON investment_monitoring_universe
      WHEN NEW.ticker = 'ROLL_BOOM'
      BEGIN
        SELECT RAISE(ABORT, 'forced-eval-failure');
      END;
    `);

    assert.throws(() => db.evaluateMonitoringAssetsDaily(), /forced-eval-failure/);
    assert.deepEqual(snapshot(db), before, 'rollback total: nem as linhas anteriores ao erro mudam');

    db.db.exec('DROP TRIGGER trg_eval_fail');
    const recovered = db.evaluateMonitoringAssetsDaily();
    assert.deepEqual(recovered, { updatedCount: 3, resolvedCount: 3 }, 'sem o erro o motor volta a resolver tudo');
    assert.equal(getRow(db, 'ROLL_BOOM').status, 'TARGET_ATINGIDO');
  });
});

// ── B1: daysPassed >= 35 sem velas válidas na janela -> EXPIRADO ───────
test('B1a: ativo vencido com zero velas na janela -> EXPIRADO com fecho null, contado e idempotente', { skip: !SQLITE_AVAILABLE }, async () => {
  await withDb(async (db) => {
    const analysis = isoDayOffset(-40);
    const horizonEnd = isoDayOffset(-5);
    insertMonitoringRows(db, [
      // Sem qualquer vela dentro de [analysis_date, analysis_date+35d].
      { ticker: 'B1A_NOCANDLES', analysis_date: analysis, direction: 'COMPRA', entry_price: 100, target_price: 110, stop_loss: 95 },
      // Companheiro válido na mesma execução: confirma que a aresta B1 não
      // bloqueia a resolução dos restantes (cenário misto).
      { ticker: 'B1A_RESOLVE', analysis_date: analysis, direction: 'COMPRA', entry_price: 100, target_price: 110, stop_loss: 95 }
    ]);
    // Única vela do B1A_NOCANDLES existe, mas fora da janela (depois de +35d).
    insertCandle(db, 'B1A_NOCANDLES', isoDayOffset(-1), { close: 130, high: 140, low: 129 });
    insertCandle(db, 'B1A_RESOLVE', isoDayOffset(-30), { close: 108, high: 111, low: 99 });

    const first = db.evaluateMonitoringAssetsDaily();
    assert.deepEqual(first, { updatedCount: 2, resolvedCount: 2 }, 'a linha vencida sem velas conta em updated/resolved');

    const expired = getRow(db, 'B1A_NOCANDLES');
    assert.equal(expired.status, 'EXPIRADO', 'daysPassed >= 35 sem velas na janela resolve como EXPIRADO');
    assert.equal(expired.current_price, null, 'sem velas na janela não há current_price');
    assert.equal(expired.exit_price, null);
    assert.equal(expired.pnl_pct, null);
    assert.equal(expired.exit_date, horizonEnd, 'exit_date = analysis_date + 35d');
    assert.equal(expired.analysis_date, analysis, 'analysis_date não é reescrita');

    const resolved = getRow(db, 'B1A_RESOLVE');
    assert.equal(resolved.status, 'TARGET_ATINGIDO', 'o companheiro válido é resolvido na mesma execução');
    assert.equal(resolved.exit_price, 110);
    assert.equal(resolved.exit_date, isoDayOffset(-30));

    // 2ª execução: a linha EXPIRADO deixa de ser selecionada e nada muda.
    const afterFirst = snapshot(db);
    const second = db.evaluateMonitoringAssetsDaily();
    assert.deepEqual(second, { updatedCount: 0, resolvedCount: 0 }, 'EXPIRADO sem velas não é revisto');
    assert.deepEqual(snapshot(db), afterFirst, 'a 2ª execução não altera nenhuma linha resolvida');
  });
});

test('B1b: ativo dentro do horizonte sem velas fica MONITORIZANDO exatamente igual', { skip: !SQLITE_AVAILABLE }, async () => {
  await withDb(async (db) => {
    insertMonitoringRow(db, {
      ticker: 'B1B_NOCANDLES',
      analysis_date: isoDayOffset(-10),
      direction: 'COMPRA',
      entry_price: 100,
      target_price: 110,
      stop_loss: 95,
      current_price: 100
    });

    const before = snapshot(db);
    const result = db.evaluateMonitoringAssetsDaily();
    assert.deepEqual(result, { updatedCount: 0, resolvedCount: 0 }, 'daysPassed < 35 e sem velas não toca a linha');
    assert.deepEqual(snapshot(db), before, 'nem o current_price original é alterado');
    assert.equal(getRow(db, 'B1B_NOCANDLES').status, 'MONITORIZANDO');
  });
});

// ── B2: analysis_date com hora não exclui a vela do próprio dia ────────
test('B2: analysis_date com hora inclui a vela do próprio dia (toque -> TARGET, sem toque -> pendente)', { skip: !SQLITE_AVAILABLE }, async () => {
  await withDb(async (db) => {
    const day = isoDayOffset(-5);
    const analysisWithTime = `${day}T12:00:00Z`;
    insertMonitoringRows(db, [
      { ticker: 'B2_TOUCH', analysis_date: analysisWithTime, direction: 'COMPRA', entry_price: 100, target_price: 110, stop_loss: 95 },
      { ticker: 'B2_NOTOUCH', analysis_date: analysisWithTime, direction: 'COMPRA', entry_price: 100, target_price: 120, stop_loss: 80 }
    ]);
    // Vela à meia-noite do próprio dia do analysis_date com o high a tocar o alvo.
    insertCandle(db, 'B2_TOUCH', day, { close: 108, high: 111, low: 99 });
    // Sem toque: continua pendente, mas o current_price é atualizado.
    insertCandle(db, 'B2_NOTOUCH', day, { close: 105, high: 109, low: 98 });

    const result = db.evaluateMonitoringAssetsDaily();
    assert.deepEqual(result, { updatedCount: 2, resolvedCount: 1 }, 'a vela do próprio dia é incluída pela normalização do limite inferior');

    const touch = getRow(db, 'B2_TOUCH');
    assert.equal(touch.status, 'TARGET_ATINGIDO');
    assert.equal(touch.exit_price, 110);
    assert.equal(touch.exit_date, day, 'exit_date é a data da vela do toque');
    assert.equal(touch.pnl_pct, 10);
    assert.equal(touch.analysis_date, analysisWithTime, 'analysis_date com hora não é reescrita');

    const noTouch = getRow(db, 'B2_NOTOUCH');
    assert.equal(noTouch.status, 'MONITORIZANDO', 'sem toque não rebenta nem resolve');
    assert.equal(noTouch.current_price, 105);
    assert.equal(noTouch.exit_date, null);
    assert.equal(noTouch.exit_price, null);
    assert.equal(noTouch.pnl_pct, null);
  });
});
