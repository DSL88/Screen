'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { PortfolioBacktester, runPortfolioSimulation } = require('../src/engine/portfolioBacktester');

function pad(n) { return String(n).padStart(2, '0'); }
function dayGrid(n, start = new Date(Date.UTC(2024, 0, 1))) {
  const out = [];
  for (let i = 0; i < n; i++) { const d = new Date(start); d.setUTCDate(d.getUTCDate() + i); out.push(d.toISOString().slice(0, 10)); }
  return out;
}
// flat series à volta de `base`; aplica overrides por índice absoluto
function flatCandles(dates, base, overrides = {}) {
  return dates.map((date, i) => {
    const o = overrides[i] || {};
    return { date, open: base, high: o.high != null ? o.high : base, low: o.low != null ? o.low : base, close: o.close != null ? o.close : base, volume: 1e6 };
  });
}
// stub determinístico: decide aprovação e winRateMC por ticker/dia
function stubGatekeeper(approvals) {
  return (slice, quantEngine, ticker) => {
    const date = slice[slice.length - 1].date;
    const t = ticker;
    const key = `${t}|${date}`;
    const a = approvals.get(key);
    if (!a) return null;
    return { approved: true, winRateMC: a.winRateMC, mcTier: a.winRateMC >= 65 ? 'ELITE' : 'MODERATE', side: 'LONG' };
  };
}
function attachTicker(candles, ticker) { const a = candles.map(c => ({ ...c, _t: undefined })); Object.defineProperty(a, '_ticker', { value: ticker }); return a; }

// ── CRITÉRIO 1: nunca excede posições simultâneas nem o capital ──
test('Portfolio C1: respeita o limite de posições simultâneas e o capital de 10.000 €', async () => {
  const dates = dayGrid(240);
  const tickers = ['A', 'B', 'C', 'D', 'E', 'F'];
  const map = new Map(tickers.map(t => [t, attachTicker(flatCandles(dates, 100), t)]));
  // Aprova todos os tickers todos os dias (caso extremo de escassez de vagas)
  const approvals = new Map();
  for (const t of tickers) for (const d of dates) approvals.set(`${t}|${d}`, { winRateMC: 60 });

  const bt = new PortfolioBacktester({ initialCapital: 10000, maxPositions: 5, positionAllocationPct: 0.20, warmup: 0 });
  bt.evaluateAssetGatekeepers = stubGatekeeper(approvals);
  const res = await bt.run(map, dates);

  // Nunca mais de 5 posições abertas
  for (const p of res.equityCurve) assert.ok(p.openPositionsCount <= 5, `slots excedidos: ${p.openPositionsCount}`);
  // Nunca investiu mais do que tinha: cash>=0 sempre
  for (const p of res.equityCurve) assert.ok(p.cash >= -1e-6, `cash negativo: ${p.cash}`);
  // Cada trade aloca ~20% (<= equity*20%)
  for (const t of res.trades) assert.ok(t.investedAmount <= 10000 * 0.20 + 1e-6);
  assert.equal(res.initialCapital, 10000);
});

// ── CRITÉRIO 2: desempate por maior probabilidade MC ──
test('Portfolio C2: com mais sinais que vagas, abre os de maior convicção Monte Carlo', async () => {
  const dates = dayGrid(230);
  const specs = [['A', 55], ['B', 60], ['C', 90], ['D', 70], ['E', 80], ['F', 65]];
  const map = new Map(specs.map(([t]) => [t, attachTicker(flatCandles(dates, 100), t)]));
  const approvals = new Map();
  for (const [t, wr] of specs) approvals.set(`${t}|${dates[220]}`, { winRateMC: wr });

  const bt = new PortfolioBacktester({ initialCapital: 10000, maxPositions: 2, positionAllocationPct: 0.20, warmup: 200 });
  bt.evaluateAssetGatekeepers = stubGatekeeper(approvals);
  const res = await bt.run(map, dates);

  const opened = new Set(res.trades.map(t => t.ticker));
  assert.ok(opened.has('C'), 'deve abrir o de maior convicção (90)');
  assert.ok(opened.has('E'), 'deve abrir o 2º maior (80)');
  assert.ok(!opened.has('A') && !opened.has('B'), 'não deve abrir os de menor convicção');
  assert.equal(res.trades.filter(t => t.entryDate === dates[220]).length, 2);
});

// ── CRITÉRIO 3: saídas rigorosas TP +4.8% / SL −2.4% / expira 35d ──
test('Portfolio C3: TP a +4.8%, SL a −2.4% e fecho no 35º dia útil', async () => {
  const dates = dayGrid(260);
  const base = 100; // entry price (close) no dia 200
  // A → STOP_LOSS no dia 201 (low <= 97.6); B → TAKE_PROFIT dia 201 (high>=104.8); C → EXPIRED_HORIZON ao dia 235
  const candlesA = attachTicker(flatCandles(dates, base, { 201: { low: 95, high: 100, close: 99 } }), 'A');
  const candlesB = attachTicker(flatCandles(dates, base, { 201: { high: 106, low: 100, close: 103 } }), 'B');
  const candlesC = attachTicker(flatCandles(dates, base), 'C');
  const map = new Map([['A', candlesA], ['B', candlesB], ['C', candlesC]]);

  const approvals = new Map([['A|' + dates[200], { winRateMC: 70 }], ['B|' + dates[200], { winRateMC: 70 }], ['C|' + dates[200], { winRateMC: 70 }]]);
  const bt = new PortfolioBacktester({ initialCapital: 10000, maxPositions: 3, positionAllocationPct: 0.20, stopLoss: 2.4, takeProfit: 4.8, horizonDays: 35, warmup: 200 });
  bt.evaluateAssetGatekeepers = stubGatekeeper(approvals);
  const res = await bt.run(map, dates);

  const A = res.trades.find(t => t.ticker === 'A');
  const B = res.trades.find(t => t.ticker === 'B');
  const C = res.trades.find(t => t.ticker === 'C');
  assert.equal(A.reason, 'STOP_LOSS');
  assert.equal(A.exitPrice, +(100 * (1 - 0.024)).toFixed(2));
  assert.ok(Math.abs(A.pnlPct - (-2.4)) < 0.01, `SL % = ${A.pnlPct}`);
  assert.equal(B.reason, 'TAKE_PROFIT');
  assert.equal(B.exitPrice, +(100 * (1 + 0.048)).toFixed(2));
  assert.ok(Math.abs(B.pnlPct - 4.8) < 0.01, `TP % = ${B.pnlPct}`);
  assert.equal(C.reason, 'EXPIRED_HORIZON');
  assert.equal(C.daysHeld, 35);
});

// ── CRITÉRIO 4: capital restituído ao saldo no fecho ──
test('Portfolio C4: capital investido é devolvido ao cash no encerramento', async () => {
  const dates = dayGrid(240);
  // entrada no dia 200, fecho por SL apenas no dia 205 (hold multi-dia)
  const map = new Map([['A', attachTicker(flatCandles(dates, 100, { 205: { low: 95, high: 100, close: 99 } }), 'A')]]);
  const approvals = new Map([['A|' + dates[200], { winRateMC: 70 }]]);
  const bt = new PortfolioBacktester({ initialCapital: 10000, maxPositions: 5, positionAllocationPct: 0.20, stopLoss: 2.4, takeProfit: 4.8, horizonDays: 35, warmup: 200 });
  bt.evaluateAssetGatekeepers = stubGatekeeper(approvals);
  const res = await bt.run(map, dates);

  const midHold = res.equityCurve.find(p => p.date === dates[203]);
  const afterClose = res.equityCurve.find(p => p.date === dates[205]);
  assert.ok(midHold.invested > 1000 && midHold.cash < 10000, 'capital investido durante a posição');
  assert.equal(midHold.openPositionsCount, 1);
  assert.equal(afterClose.invested, 0, 'após o fecho nada fica investido');
  assert.equal(afterClose.openPositionsCount, 0);
  assert.equal(afterClose.cash, afterClose.equity, 'cash = equity após libertar tudo');
  for (const p of res.equityCurve) assert.ok(Math.abs(p.equity - (p.cash + p.invested)) < 0.5, `equity=${p.equity} cash=${p.cash} inv=${p.invested}`);
});

// ── CRITÉRIO 5: curva de equity = Cash + MtM consolidado ──
test('Portfolio C5: equity curve é o património diário (cash + posições)', async () => {
  const dates = dayGrid(240);
  const map = new Map([['A', attachTicker(flatCandles(dates, 100, { 205: { close: 110, high: 110, low: 100 } }), 'A')]]);
  const approvals = new Map([['A|' + dates[200], { winRateMC: 70 }]]);
  const bt = new PortfolioBacktester({ initialCapital: 10000, maxPositions: 5, positionAllocationPct: 0.20, stopLoss: 2.4, takeProfit: 4.8, horizonDays: 35, warmup: 200 });
  bt.evaluateAssetGatekeepers = stubGatekeeper(approvals);
  const res = await bt.run(map, dates);
  assert.ok(res.equityCurve.every(p => Number.isFinite(p.equity) && p.equity > 0));
  assert.equal(res.equityCurve[0].equity, 10000);
  // no dia 205 a posição valoriza → equity > 10000 (ganho não realizado incluído)
  assert.ok(res.equityCurve.find(p => p.date === dates[205]).equity > 10000);
});

// ── Warm-up: nenhuma entrada antes de 200 velas ──
test('Portfolio: warm-up de 200 velas bloqueia entradas prematuras', async () => {
  const dates = dayGrid(240);
  const map = new Map([['A', attachTicker(flatCandles(dates, 100), 'A')]]);
  const approvals = new Map();
  for (const d of dates) approvals.set(`A|${d}`, { winRateMC: 70 }); // aprova TODOS os dias
  const bt = new PortfolioBacktester({ initialCapital: 10000, maxPositions: 5, positionAllocationPct: 0.20, warmup: 200 });
  bt.evaluateAssetGatekeepers = stubGatekeeper(approvals);
  const res = await bt.run(map, dates);
  const firstEntry = res.trades[0];
  assert.ok(firstEntry, 'deve haver pelo menos uma entrada após o warm-up');
  assert.ok(firstEntry.entryDate >= dates[200], `entrada ${firstEntry.entryDate} antes da 201ª vela`);
});

// ── Integração: wrapper produz os 5 blocos analíticos ──
test('runPortfolioSimulation: devolve relatório com blocos A–E', async () => {
  const mk = (seed, n, y) => { let z = seed >>> 0; const r = () => { z = (z * 1664525 + 1013904223) >>> 0; return z / 4294967296; }; const o = []; let p = 60; for (let i = 0; i < n; i++) { p = Math.max(1, p * (1 + (r() - 0.46) * 0.05)); const d = new Date(Date.UTC(y, 0, 1)); d.setUTCDate(d.getUTCDate() + i); o.push({ date: d.toISOString().slice(0, 10), open: p, high: p * 1.03, low: p * 0.96, close: p, volume: 1e6 }); } return o; };
  const universe = [['MSFT', 7], ['XOM', 13]].map(([t, sd]) => ({ ticker: t, name: t, candles: mk(sd, 1200, 2020) }));
  const res = await runPortfolioSimulation({ universe, params: { slotSize: '20', stopLoss: 2.4, takeProfit: 4.8, horizonDays: 35, mcIterations: 400 } });
  assert.equal(res.engine, 'portfolio');
  assert.ok(res.globalKpis && typeof res.globalKpis.sharpe === 'number'); // A
  assert.ok(Array.isArray(res.yearlyMatrix));                              // B
  assert.ok(res.calibrationTiers && res.calibrationTiers.ELITE);           // C
  assert.ok(res.equityCurve.length && res.drawdownSeries.length);          // D
  assert.ok(Array.isArray(res.trades));                                    // E
});

// ── A3: slot 2% / 10.000 € → até 50 posições de 200 €, nunca excede 50 ──
test('Portfolio slot 2%: abre até 50 posições de 200 € e nunca excede 50', async () => {
  const dates = dayGrid(240);
  const tickers = Array.from({ length: 60 }, (_, i) => 'T' + i);
  const map = new Map(tickers.map(t => [t, attachTicker(flatCandles(dates, 100), t)]));
  const approvals = new Map();
  for (const t of tickers) for (const d of dates) approvals.set(`${t}|${d}`, { winRateMC: 70 });

  const bt = new PortfolioBacktester({ initialCapital: 10000, slotSize: '2', warmup: 0, maxPositions: undefined });
  assert.equal(bt.maxPositions, 50, 'slot 2% ⇒ floor(1/0.02)=50 slots');
  bt.evaluateAssetGatekeepers = stubGatekeeper(approvals);
  const res = await bt.run(map, dates);

  for (const p of res.equityCurve) assert.ok(p.openPositionsCount <= 50, 'teto de 50 posições');
  const firstDayOpens = res.trades.filter(t => t.entryDate === dates[0]);
  assert.ok(firstDayOpens.length <= 50);
  // capital por trade ≈ 2% de 10.000 = 200 €
  for (const t of res.trades) assert.ok(Math.abs(t.investedAmount - 200) <= 200, `alocado ${t.investedAmount}`);
  assert.ok(Math.max(...res.equityCurve.map(p => p.openPositionsCount)) >= 2, 'chega a abrir várias posições');
});

// ── A4: slot 5% (20) e 7,5% (13): capital uniforme + por convicção ──
test('Portfolio slot 5% e 7,5%: capital uniforme por trade e seleção por convicção MC', async () => {
  const dates = dayGrid(240);
  for (const [slotKey, expectedMax, expectedPerTrade] of [['5', 20, 500], ['7.5', 13, 750]]) {
    const specs = Array.from({ length: 25 }, (_, i) => ['X' + i, 50 + i]); // convicção crescente
    const map = new Map(specs.map(([t]) => [t, attachTicker(flatCandles(dates, 100), t)]));
    const approvals = new Map();
    for (const [t, wr] of specs) approvals.set(`${t}|${dates[220]}`, { winRateMC: wr });

    const bt = new PortfolioBacktester({ initialCapital: 10000, slotSize: slotKey, warmup: 200 });
    assert.equal(bt.maxPositions, expectedMax, `slot ${slotKey}% ⇒ ${expectedMax} slots`);
    bt.evaluateAssetGatekeepers = stubGatekeeper(approvals);
    const res = await bt.run(map, dates);

    const opened = res.trades.filter(t => t.entryDate === dates[220]);
    assert.equal(opened.length, expectedMax, `abre ${expectedMax} no dia`);
    // capital uniforme
    for (const t of opened) assert.ok(Math.abs(t.investedAmount - expectedPerTrade) < 1, `alocado ${t.investedAmount} ≠ ${expectedPerTrade}`);
    // os abertos são os de maior convicção (top-N por winRateMC)
    const sortedDesc = specs.slice().sort((a, b) => b[1] - a[1]).slice(0, expectedMax).map(x => x[0]).sort();
    assert.deepEqual(opened.map(t => t.ticker).sort(), sortedDesc, 'seleção por convicção MC');
  }
});

// ── Recálculo dinâmico de capital: preset derivado do slot e do capital ──
test('Portfolio: maxPositions deriva de floor(1/slotPct) e alocação usa património', async () => {
  const bt = new PortfolioBacktester({ positionAllocationPct: 0.05 }); // sem maxPositions explícito
  assert.equal(bt.maxPositions, 20);
  const bt2 = new PortfolioBacktester({ slotSize: '7.5' });
  assert.equal(bt2.maxPositions, 13);
  assert.ok(Math.abs(bt2.positionAllocationPct - 0.075) < 1e-9);
});

// ── A5: saídas SL 2.4 / TP 4.8 / 35d imutáveis mesmo com 50 slots ──
test('Portfolio: regras de saída imutáveis com 50 slots (2%)', async () => {
  const dates = dayGrid(240);
  const t0 = 'S0';
  const candles = attachTicker(flatCandles(dates, 100, { 1: { low: 95, high: 100, close: 99 } }), t0); // SL no dia 1
  const map = new Map([[t0, candles]]);
  const approvals = new Map([[`${t0}|${dates[0]}`, { winRateMC: 80 }]]);
  const bt = new PortfolioBacktester({ initialCapital: 10000, slotSize: '2', stopLoss: 2.4, takeProfit: 4.8, horizonDays: 35, warmup: 0 });
  bt.evaluateAssetGatekeepers = stubGatekeeper(approvals);
  const res = await bt.run(map, dates);
  const tr = res.trades.find(x => x.ticker === t0);
  assert.equal(tr.reason, 'STOP_LOSS');
  assert.ok(Math.abs(tr.pnlPct - (-2.4)) < 0.01);
});
