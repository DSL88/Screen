(function () {
  'use strict';

  // ═══════════════════════════════════════════════════════════
  //  MOTOR INTEGRAL DA WORKSTATION — RENDERER
  //  Dashboard (horizontes 1–20 anos), Card Resumo e Modal
  //  com 5 blocos analíticos (A–E).
  // ═══════════════════════════════════════════════════════════

  const $ = (id) => document.getElementById(id);

  let activeSimulationReport = null;
  let equityChartInstance = null;
  let drawdownChartInstance = null;
  let tradesSort = { key: null, dir: 1 };

  const currentSimulationState = {
    isRunning: false, progress: 0, currentTicker: '', totalTickers: 0,
    completedTickers: 0, message: '', results: null, error: null, lastRunId: null,
    horizonYears: 5
  };
  window.simulationState = currentSimulationState;

  const state = { currentRunId: null, running: false, unsubscribers: [] };

  function pad(n) { return String(n).padStart(2, '0'); }
  function toInputDate(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }

  function getUIElements() {
    return {
      universe: $('sim-asset-universe'),
      convictionTier: $('sim-conviction-tier'),
      direction: $('sim-direction'),
      stopMode: $('sim-stop-mode'),
      stopLoss: $('sim-stop-loss'),
      takeProfit: $('sim-take-profit'),
      riskPerTrade: $('sim-risk-per-trade'),
      rebalanceDays: $('sim-rebalance-days'),
      slotSize: $('sim-slot-size'),
      horizonExp: $('sim-horizon-exp'),
      maxPositions: $('sim-max-positions'),
      previewMax: $('preview-max-positions'),
      previewCap: $('preview-capital-per-trade'),
      initialCapital: $('sim-initial-capital'),
      startDate: $('sim-start-date'),
      endDate: $('sim-end-date'),
      btnStart: $('btn-start-simulation'),
      btnReset: $('btn-reset-params'),
      btnCancel: $('btn-sim-cancel'),
      progressWrap: $('sim-progress-wrap'),
      progressBar: $('sim-progress-fill'),
      progressText: $('sim-progress-text'),
      status: $('sim-status'),
      summaryContainer: $('simulation-summary-card-container'),
      btnOpenModal: $('btn-open-simulation-modal'),
      modal: $('modal-simulation-details'),
      btnCloseModal: $('btn-close-sim-modal')
    };
  }

  function init() {
    bindApiEvents();
    bindTabNavigation();
    bindHorizonButtons();
    setDefaultDates();
    bindListeners();
  }

  function setDefaultDates() {
    const ui = getUIElements();
    const today = new Date();
    if (ui.endDate && !ui.endDate.value) ui.endDate.value = toInputDate(today);
    if (ui.startDate && !ui.startDate.value) {
      const start = new Date(today.getFullYear() - 5, today.getMonth(), today.getDate());
      ui.startDate.value = toInputDate(start);
    }
  }

  function bindHorizonButtons() {
    const group = $('ws-horizon-group');
    if (!group) return;
    group.querySelectorAll('.horizon-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        group.querySelectorAll('.horizon-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const years = Number(btn.dataset.years);
        currentSimulationState.horizonYears = years;
        const custom = $('ws-custom-dates');
        if (custom) custom.hidden = years !== 0;
        if (years > 0) {
          const ui = getUIElements();
          const end = ui.endDate && ui.endDate.value ? new Date(ui.endDate.value) : new Date();
          const start = new Date(end.getFullYear() - years, end.getMonth(), end.getDate());
          if (ui.startDate) ui.startDate.value = toInputDate(start);
          if (ui.endDate) ui.endDate.value = toInputDate(end);
        }
      });
    });
  }

  // Matriz de slots (2/5/7,5/10/15/20%) — máx. posições = floor(100/slot)
  const SLOT_DEFINITIONS = {
    '2': { slotPct: 0.020, maxPositions: Math.floor(1 / 0.020) },
    '5': { slotPct: 0.050, maxPositions: Math.floor(1 / 0.050) },
    '7.5': { slotPct: 0.075, maxPositions: Math.floor(1 / 0.075) },
    '10': { slotPct: 0.100, maxPositions: Math.floor(1 / 0.100) },
    '15': { slotPct: 0.150, maxPositions: Math.floor(1 / 0.150) },
    '20': { slotPct: 0.200, maxPositions: Math.floor(1 / 0.200) }
  };
  const SLOT_PRESETS = SLOT_DEFINITIONS;

  function currentSlotConfig() {
    const ui = getUIElements();
    const key = ui.slotSize ? String(ui.slotSize.value) : '20';
    return SLOT_DEFINITIONS[key] || SLOT_DEFINITIONS['20'];
  }

  function formatEur(v) {
    try { return Number(v).toLocaleString('pt-PT', { style: 'currency', currency: 'EUR' }); }
    catch (_) { return Number(v).toFixed(2) + ' €'; }
  }

  function updateSlotPreview() {
    const ui = getUIElements();
    const capital = toNum(ui.initialCapital, 10000);
    const config = currentSlotConfig();
    if (ui.previewMax) ui.previewMax.textContent = `${config.maxPositions} Posições`;
    if (ui.previewCap) ui.previewCap.textContent = formatEur(capital * config.slotPct);
    if (ui.maxPositions) ui.maxPositions.value = String(config.maxPositions);
  }

  function syncSlotsFromPositionSize() { updateSlotPreview(); }

  function resetDefaultParams() {
    const ui = getUIElements();
    if (ui.universe) ui.universe.value = 'ALL';
    if (ui.convictionTier) ui.convictionTier.value = 'moderate';
    if (ui.direction) ui.direction.value = 'BOTH';
    if (ui.stopMode) ui.stopMode.value = 'pct';
    if (ui.stopLoss) ui.stopLoss.value = '2.4';
    if (ui.takeProfit) ui.takeProfit.value = '4.8';
    if (ui.horizonExp) ui.horizonExp.value = '35';
    if (ui.slotSize) ui.slotSize.value = '20';
    if (ui.rebalanceDays) ui.rebalanceDays.value = '35';
    if (ui.initialCapital) ui.initialCapital.value = '10000';
    updateSlotPreview();
    const group = $('ws-horizon-group');
    if (group) {
      group.querySelectorAll('.horizon-btn').forEach(b => b.classList.toggle('active', b.dataset.years === '5'));
    }
    setDefaultDates();
    setStatus('Parâmetros restaurados para os valores padrão (carteira 10.000 €, 20% × 5 slots, SL 2.4% / TP 4.8% / 35d).');
  }

  function bindListeners() {
    const ui = getUIElements();
    if (ui.btnStart) ui.btnStart.addEventListener('click', startSimulation);
    if (ui.btnReset) ui.btnReset.addEventListener('click', resetDefaultParams);
    if (ui.slotSize) ui.slotSize.addEventListener('change', updateSlotPreview);
    if (ui.initialCapital) ui.initialCapital.addEventListener('input', updateSlotPreview);
    updateSlotPreview();
    if (ui.btnCancel) ui.btnCancel.addEventListener('click', cancelSimulation);
    if (ui.btnOpenModal) ui.btnOpenModal.addEventListener('click', () => {
      if (activeSimulationReport) openSimulationModal(activeSimulationReport);
    });
    if (ui.btnCloseModal) ui.btnCloseModal.addEventListener('click', closeSimulationModal);
    if (ui.modal) ui.modal.addEventListener('click', (e) => { if (e.target === ui.modal) closeSimulationModal(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSimulationModal(); });
    const search = $('ws-trades-search');
    if (search) search.addEventListener('input', () => renderTradesTable(activeSimulationReport ? activeSimulationReport.trades : []));
    const exportBtn = $('btn-export-trades-csv');
    if (exportBtn) exportBtn.addEventListener('click', exportTradesCSV);
    if (ui.modal) {
      const sortHeaders = typeof ui.modal.querySelectorAll === 'function'
        ? ui.modal.querySelectorAll('#table-trades-log th[data-sort]') : [];
      sortHeaders.forEach((th) => {
        th.addEventListener('click', () => {
          const key = th.dataset.sort;
          tradesSort.dir = tradesSort.key === key ? -tradesSort.dir : 1;
          tradesSort.key = key;
          renderTradesTable(activeSimulationReport ? activeSimulationReport.trades : []);
        });
      });
    }
  }

  function bindTabNavigation() {
    document.querySelectorAll('.tab-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (btn.dataset.tab === 'simulation') setTimeout(restoreSimulationViewState, 30);
      });
    });
  }

  // ── IPC ──
  function bindApiEvents() {
    const api = window.electronAPI || window.api;
    if (!api) return;
    const onProg = (data) => onProgress(data);
    const onRes = (data) => onSimulationFinished(data);
    const onErr = (data) => onError(data);
    if (typeof api.onSimulationProgress === 'function') state.unsubscribers.push(api.onSimulationProgress(onProg));
    if (typeof api.onSimulationProgressSpec === 'function') state.unsubscribers.push(api.onSimulationProgressSpec(onProg));
    if (typeof api.onSimulationComplete === 'function') state.unsubscribers.push(api.onSimulationComplete(onRes));
    else if (typeof api.onSimulationResult === 'function') state.unsubscribers.push(api.onSimulationResult(onRes));
    if (typeof api.onSimulationError === 'function') state.unsubscribers.push(api.onSimulationError(onErr));
  }

  function isCurrentRun(data) {
    if (!state.currentRunId && !currentSimulationState.lastRunId) return true;
    const runId = state.currentRunId || currentSimulationState.lastRunId;
    return !data || !data.runId || data.runId === runId;
  }

  function onProgress(data) {
    if (!data || !isCurrentRun(data)) return;
    const percent = Math.min(100, Math.max(0, Math.round(data.percent || 0)));
    currentSimulationState.isRunning = true;
    currentSimulationState.progress = percent;
    currentSimulationState.currentTicker = data.ticker || '';
    currentSimulationState.completedTickers = data.current || 0;
    currentSimulationState.totalTickers = data.total || 0;
    updateSimulationUIProgress();
  }

  function updateSimulationUIProgress() {
    const ui = getUIElements();
    const percent = currentSimulationState.progress || 0;
    const ticker = currentSimulationState.currentTicker || '';
    const txt = `${percent}% ${ticker ? '(' + ticker + ')' : ''}`;
    if (ui.progressWrap) ui.progressWrap.hidden = false;
    if (ui.progressBar) ui.progressBar.style.width = `${percent}%`;
    if (ui.progressText) ui.progressText.textContent = txt;
    // ids legados (compatibilidade com restore em outros mounts de DOM)
    const legacyBar = $('simulation-progress-bar'); if (legacyBar && legacyBar.style) legacyBar.style.width = `${percent}%`;
    const legacyTxt = $('simulation-progress-text'); if (legacyTxt) legacyTxt.textContent = txt;
    if (ui.btnStart) ui.btnStart.disabled = true;
    if (ui.btnCancel) ui.btnCancel.hidden = false;
    setStatus(ticker ? `A simular ativo ${ticker}... (${percent}%)` : `A processar pipeline Workstation... (${percent}%)`);
  }

  function onSimulationFinished(data) {
    const payload = data && data.result ? data.result : data;
    if (!payload) return;
    currentSimulationState.isRunning = false;
    currentSimulationState.progress = 100;
    currentSimulationState.results = payload;
    activeSimulationReport = normalizeSimulationReport(payload);
    updateSimulationUIComplete();
    renderSimulationSummaryCard(activeSimulationReport);
  }

  function updateSimulationUIComplete() {
    const ui = getUIElements();
    state.running = false;
    currentSimulationState.isRunning = false;
    if (ui.btnStart) ui.btnStart.disabled = false;
    if (ui.btnCancel) ui.btnCancel.hidden = true;
    if (ui.progressWrap) ui.progressWrap.hidden = true;
    if (ui.progressBar) ui.progressBar.style.width = '0%';
  }

  function onError(data) {
    if (!data || !isCurrentRun(data)) return;
    const msg = (data && data.message) || (data && data.error) || 'Erro na simulação.';
    currentSimulationState.error = msg;
    if (!(data && data.ticker)) {
      state.currentRunId = null; currentSimulationState.lastRunId = null;
      currentSimulationState.isRunning = false; state.running = false;
      updateSimulationUIComplete();
    }
    setStatus('Aviso: ' + msg);
  }

  function restoreSimulationViewState() {
    if (currentSimulationState.isRunning) updateSimulationUIProgress();
    else if (activeSimulationReport) { renderSimulationSummaryCard(activeSimulationReport); }
    else if (currentSimulationState.error) setStatus('Erro na simulação: ' + currentSimulationState.error);
  }
  window.restoreSimulationViewState = restoreSimulationViewState;

  function setStatus(msg) {
    const ui = getUIElements();
    if (!ui.status) return;
    ui.status.textContent = msg || '';
    ui.status.hidden = !msg;
  }

  // ── Normalização ──
  function normalizeSimulationReport(raw) {
    if (!raw) return {};
    const k = raw.kpis || raw.globalKpis || {};
    const trades = Array.isArray(raw.trades) ? raw.trades : [];
    const totalGain = k.rentabilidadePct ?? k.netProfitPct ?? 0;
    return {
      engine: raw.engine,
      summary: raw.summary || {},
      totalGain: Number(totalGain),
      winRate: Number(k.winRateReal ?? k.winRate ?? 0),
      profitFactor: Number(k.profitFactor ?? 0),
      maxDrawdown: Number(k.maxDrawdown ?? k.maxDrawdownPct ?? 0),
      sharpe: Number(k.sharpe ?? 0),
      finalCapital: Number(k.finalCapital ?? 0),
      totalTrades: trades.length,
      kpis: k,
      globalKpis: raw.globalKpis || k,
      yearlyMatrix: Array.isArray(raw.yearlyMatrix) ? raw.yearlyMatrix : [],
      calibrationTiers: raw.calibrationTiers || null,
      risk: raw.risk || {},
      validation: raw.validation || null,
      equityCurve: (raw.equityCurve || []).map(p => ({ date: p.date, capital: p.value ?? p.capital })),
      benchmark: (raw.benchmark || []).map(p => ({ date: p.date, value: p.value })),
      drawdownCurve: (raw.drawdownSeries || []).map(p => ({ date: p.date, drawdown: p.value })),
      trades,
      meta: raw.meta || {}
    };
  }

  function fmtPct(v, dp = 1) { v = Number(v) || 0; return `${v >= 0 ? '+' : ''}${v.toFixed(dp)}%`; }
  function fmtEur(v) { return (Number(v) || 0).toLocaleString('pt-PT', { style: 'currency', currency: 'EUR' }); }

  // ── CARD RESUMO (mantém ecrã limpo) ──
  function renderSimulationSummaryCard(r) {
    const container = $('simulation-summary-card-container');
    if (container) container.classList.remove('hidden');
    // Legacy: secção de resultados (utilizada pelo restauro de estado em outras abas)
    const legacyResults = $('sim-results');
    if (legacyResults) legacyResults.hidden = false;
    const titleEl = $('summary-card-title');
    const datesEl = $('summary-card-dates');
    if (titleEl) titleEl.textContent = r.summary && r.summary.title ? r.summary.title : 'Simulação Workstation';
    if (datesEl) datesEl.textContent = `${r.totalTrades} operações · ${(r.yearlyMatrix || []).length} anos · ${r.meta.universe || 0} ativos`;
    const setTxt = (id, v) => { const e = $(id); if (e) e.textContent = v; };
    setTxt('summary-gain', fmtPct(r.totalGain));
    setTxt('summary-winrate', `${(r.winRate || 0).toFixed(0)}%`);
    setTxt('summary-pf', (r.profitFactor || 0).toFixed(2));
    setTxt('summary-dd', `${(r.maxDrawdown || 0).toFixed(1)}%`);
    setTxt('summary-sharpe', (r.sharpe || 0).toFixed(2));
    setStatus(`Simulação concluída (${r.totalTrades} operações).`);
  }

  // ── MODAL: 5 BLOCOS ──
  function openSimulationModal(r) {
    const modal = $('modal-simulation-details');
    if (modal) modal.classList.remove('hidden');
    renderBlockA(r);
    renderBlockB(r);
    renderBlockC(r);
    renderModalCharts(r);
    renderTailRisk(r);
    tradesSort = { key: null, dir: 1 };
    renderTradesTable(r.trades || []);
    const sub = $('modal-sim-subtitle');
    if (sub) sub.textContent = (r.summary && r.summary.title) || 'Workstation Quantitativa';
  }

  function closeSimulationModal() {
    const modal = $('modal-simulation-details');
    if (modal) modal.classList.add('hidden');
  }

  function kpiCard(label, val) {
    return `<div class="kpi-card"><div class="kpi-label">${escapeHtml(label)}</div><div class="kpi-val-yellow">${escapeHtml(String(val))}</div></div>`;
  }

  function renderBlockA(r) {
    const bar = $('ws-kpis-bar');
    if (!bar) return;
    const k = r.globalKpis || r.kpis || {};
    bar.innerHTML = [
      kpiCard('Capital Inicial', fmtEur(k.initialCapital)),
      kpiCard('Capital Final', fmtEur(k.finalCapital)),
      kpiCard('Rentabilidade', fmtPct(k.netProfitPct)),
      kpiCard('CAGR', fmtPct(k.cagr)),
      kpiCard('Sharpe Anual', (k.sharpe || 0).toFixed(2)),
      kpiCard('Sortino', (k.sortino || 0).toFixed(2)),
      kpiCard('Calmar', (k.calmar || 0).toFixed(2)),
      kpiCard('Max Drawdown', `${(k.maxDrawdownPct || 0).toFixed(1)}%`),
      kpiCard('Total de Trades', k.totalTrades || 0),
      kpiCard('Win Rate', `${(k.winRate || 0).toFixed(1)}%`),
      kpiCard('Profit Factor', (k.profitFactor || 0).toFixed(2)),
      kpiCard('Payoff Ratio', (k.payoffRatio || 0).toFixed(2)),
      kpiCard('Expectativa', fmtEur(k.expectancy) + ' /trade'),
      kpiCard('Duração Média', k.avgDurationDays != null ? `${k.avgDurationDays} d` : '—'),
      kpiCard('Exposição Média', `${(k.exposurePct || 0).toFixed(0)}%`)
    ].join('');
  }

  function renderBlockB(r) {
    const tbody = $('tbody-yearly');
    if (!tbody) return;
    const rows = r.yearlyMatrix || [];
    if (!rows.length) { tbody.innerHTML = `<tr><td colspan="6" class="ws-empty">Sem dados anuais.</td></tr>`; return; }
    tbody.innerHTML = rows.map(y => {
      const cls = y.returnPct >= 0 ? 'ws-pos' : 'ws-neg';
      return `<tr class="${cls}"><td><strong>${escapeHtml(y.year)}</strong></td><td>${fmtPct(y.returnPct)}</td><td>${y.trades}</td><td>${y.winRate.toFixed(0)}%</td><td>${y.maxDrawdownPct.toFixed(1)}%</td><td>${y.sharpe.toFixed(2)}</td></tr>`;
    }).join('');
  }

  function renderBlockC(r) {
    const tbody = $('tbody-tiers');
    if (!tbody) return;
    const t = r.calibrationTiers || {};
    const order = ['ELITE', 'MODERATE'];
    tbody.innerHTML = order.map(name => {
      const row = t[name]; if (!row) return '';
      return `<tr><td><strong>${escapeHtml(row.tier)}</strong></td><td>${escapeHtml(row.range)}</td><td>${row.trades}</td><td>${row.winRateReal.toFixed(1)}%</td><td>${row.winRateTheoretical.toFixed(1)}%</td><td class="${row.pnl >= 0 ? 'ws-pos' : 'ws-neg'}">${fmtEur(row.pnl)}</td><td class="${row.alpha >= 0 ? 'ws-pos' : 'ws-neg'}">${row.alpha >= 0 ? '+' : ''}${row.alpha.toFixed(1)}</td></tr>`;
    }).join('');
  }

  function renderTailRisk(r) {
    const el = $('ws-tail-risk');
    if (!el) return;
    const risk = r.risk || {};
    const v = r.validation || {};
    const cards = [
      ['VaR 95%', `${(risk.var95 || 0).toFixed(2)}%`],
      ['CVaR 95% (ES)', `${(risk.cvar95 || 0).toFixed(2)}%`]
    ];
    if (v && (v.valid || v.dsr != null)) {
      cards.push(['Sharpe OOS', (v.sharpeOOS || 0).toFixed(2)]);
      cards.push(['DSR', `${(v.dsrPercent || 0).toFixed(1)}%`]);
      cards.push(['PBO', `${(v.pboPercent || 0).toFixed(1)}%`]);
      cards.push(['Validação CPCV', v.isApproved ? '✓ Aprovado' : '⚠ Alerta Overfitting']);
    }
    el.innerHTML = cards.map(c => `<div class="ws-risk-card"><span class="ws-risk-label">${escapeHtml(c[0])}</span><span class="ws-risk-val">${escapeHtml(String(c[1]))}</span></div>`).join('');
  }

  function renderModalCharts(r) {
    if (equityChartInstance && equityChartInstance.destroy) { equityChartInstance.destroy(); equityChartInstance = null; }
    if (drawdownChartInstance && drawdownChartInstance.destroy) { drawdownChartInstance.destroy(); drawdownChartInstance = null; }
    const cE = $('canvas-equity-curve'), cD = $('canvas-drawdown-curve');
    const ctxE = cE && cE.getContext ? cE.getContext('2d') : null;
    const ctxD = cD && cD.getContext ? cD.getContext('2d') : null;
    const ChartLib = window.Chart;
    const eqLabels = (r.equityCurve || []).map(p => p.date);

    if (ChartLib && ctxE && r.equityCurve && r.equityCurve.length) {
      const datasets = [{ label: 'Curva de Capital (€)', data: r.equityCurve.map(p => p.capital), borderColor: '#FFE600', backgroundColor: 'rgba(255,230,0,0.1)', fill: true, tension: 0.1, pointRadius: 0 }];
      if (r.benchmark && r.benchmark.length) {
        datasets.push({ label: 'Benchmark B&H (€)', data: r.benchmark.map(p => p.value), borderColor: '#4fc3f7', backgroundColor: 'transparent', borderDash: [5, 4], tension: 0.1, pointRadius: 0, fill: false });
      }
      equityChartInstance = new ChartLib(ctxE, { type: 'line', data: { labels: eqLabels, datasets }, options: chartOptions('€') });
    } else if (ctxE && r.equityCurve) { drawCanvasFallback(cE, r.equityCurve, 'capital', '#FFE600'); }

    if (ChartLib && ctxD && r.drawdownCurve && r.drawdownCurve.length) {
      drawdownChartInstance = new ChartLib(ctxD, {
        type: 'line',
        data: { labels: r.drawdownCurve.map(p => p.date), datasets: [{ label: 'Drawdown (%)', data: r.drawdownCurve.map(p => -Math.abs(p.drawdown)), borderColor: '#FF5252', backgroundColor: 'rgba(255,82,82,0.15)', fill: true, tension: 0.1, pointRadius: 0 }] },
        options: chartOptions('%')
      });
    } else if (ctxD && r.drawdownCurve) { drawCanvasFallback(cD, r.drawdownCurve, 'drawdown', '#FF5252'); }
  }

  function chartOptions(kind) {
    return {
      responsive: true, maintainAspectRatio: false, animation: { duration: 300 },
      plugins: { legend: { labels: { color: '#cfd8dc' } }, tooltip: { mode: 'index', intersect: false } },
      scales: {
        x: { grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: '#8a99ad', maxTicksLimit: 8 } },
        y: { grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: '#8a99ad', callback: (v) => kind === '€' ? `${Number(v).toLocaleString('pt-PT')} €` : `${Number(v).toFixed(1)}%` } }
      }
    };
  }

  function drawCanvasFallback(canvas, series, key, color) {
    if (!canvas || !canvas.getContext) return;
    const ctx = canvas.getContext('2d'); const w = canvas.width || 400; const h = canvas.height || 200;
    ctx.clearRect(0, 0, w, h);
    if (!series || !series.length) return;
    const values = series.map(p => Number(p[key] ?? p.value ?? 0));
    const min = Math.min(...values), max = Math.max(...values), range = (max - min) || 1;
    ctx.beginPath(); ctx.strokeStyle = color; ctx.lineWidth = 2;
    values.forEach((v, i) => { const x = (i / (values.length - 1 || 1)) * (w - 20) + 10; const y = h - 15 - ((v - min) / range) * (h - 30); i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y); });
    ctx.stroke();
  }

  // ── BLOCO E: TRADE LOG ──
  function renderTradesTable(trades) {
    const tbody = $('tbody-trades-log');
    if (!tbody) return;
    let list = Array.isArray(trades) ? trades.slice() : [];
    const q = ($('ws-trades-search') && $('ws-trades-search').value || '').trim().toUpperCase();
    if (q) list = list.filter(t => String(t.ticker).toUpperCase().includes(q));
    if (tradesSort.key) {
      list.sort((a, b) => { const av = a[tradesSort.key], bv = b[tradesSort.key]; return (av > bv ? 1 : av < bv ? -1 : 0) * tradesSort.dir; });
    }
    if (!list.length) { tbody.innerHTML = `<tr><td colspan="11" class="ws-empty">Nenhuma operação executada no período configurado.</td></tr>`; return; }
    tbody.innerHTML = list.map(t => {
      const win = Number(t.profit || 0) >= 0; const cc = win ? 'text-green' : 'text-red';
      return `<tr>
        <td><strong>${escapeHtml(t.ticker)}</strong></td>
        <td style="color:${t.side === 'LONG' ? '#00e676' : '#ff5252'};font-weight:600">${escapeHtml(t.side || 'LONG')}</td>
        <td>${escapeHtml(String(t.entryDate || '-').slice(0, 10))}</td>
        <td>${Number(t.entryPrice || 0).toFixed(2)}</td>
        <td>${escapeHtml(String(t.exitDate || '-').slice(0, 10))}</td>
        <td>${Number(t.exitPrice || 0).toFixed(2)}</td>
        <td>${escapeHtml(t.reason || '-')}</td>
        <td class="${cc}">${Number(t.profit || 0).toFixed(2)} €</td>
        <td class="${cc}">${fmtPct(t.profitPct, 1)}</td>
        <td class="text-green">${Number(t.mfePct || 0).toFixed(1)}%</td>
        <td class="text-red">${Number(t.maePct || 0).toFixed(1)}%</td>
      </tr>`;
    }).join('');
  }

  function exportTradesCSV() {
    if (!activeSimulationReport || !activeSimulationReport.trades) return;
    const cols = ['Ticker', 'Direcao', 'DataEntrada', 'PrecoEntrada', 'DataSaida', 'PrecoSaida', 'Motivo', 'PnL_EUR', 'PnL_Pct', 'MFE_Pct', 'MAE_Pct', 'WinRateMC', 'Escalao'];
    const rows = activeSimulationReport.trades.map(t => [
      t.ticker, t.side, t.entryDate, t.entryPrice, t.exitDate, t.exitPrice, t.reason, t.profit, t.profitPct, t.mfePct, t.maePct, t.winRateMC, t.mcTier
    ]);
    const csv = [cols.join(',')].concat(rows.map(r => r.map(v => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`).join(','))).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = 'trade_log_workstation.csv'; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // ── PAYLOAD ──
  function toNum(input, fallback) { if (!input) return fallback; const n = Number(input.value); return isNaN(n) ? fallback : n; }

  function buildPayload() {
    const ui = getUIElements();
    const uv = ui.universe ? ui.universe.value : 'ALL';
    const universe = (uv === 'ALL' || uv === 'MYLIST') ? { mode: 'all' } : { mode: 'index', index: uv };
    const years = currentSimulationState.horizonYears || 0;
    const useCustom = years === 0;
    const tier = ui.convictionTier ? ui.convictionTier.value : 'moderate';
    const slotKey = ui.slotSize ? String(ui.slotSize.value) : '20';
    const preset = currentSlotConfig(); // { slotPct, maxPositions } derivado de floor(1/slotPct)

    const params = {
      engine: 'portfolio',
      portfolio: true,
      workstation: false,
      horizonYears: useCustom ? null : years,
      startDate: ui.startDate && ui.startDate.value ? String(ui.startDate.value).slice(0, 10) : null,
      endDate: ui.endDate && ui.endDate.value ? String(ui.endDate.value).slice(0, 10) : toInputDate(new Date()),
      convictionTier: tier,
      minMCWinRate: tier === 'elite' ? 65 : 50,
      minWinRateMC: tier === 'elite' ? 65 : 50,
      direction: ui.direction ? ui.direction.value.toLowerCase() : 'both',
      stopType: ui.stopMode ? ui.stopMode.value : 'pct',
      stopLoss: toNum(ui.stopLoss, 2.4),
      takeProfit: toNum(ui.takeProfit, 4.8),
      horizonDays: toNum(ui.horizonExp, 35),
      slotSize: slotKey,
      positionAllocationPct: preset.slotPct,
      maxPositions: preset.maxPositions,
      risk: preset.slotPct * 100,
      riskPerTradePct: preset.slotPct * 100,
      rebalanceDays: toNum(ui.rebalanceDays, 35),
      capital: toNum(ui.initialCapital, 10000),
      initialCapital: toNum(ui.initialCapital, 10000),
      commission: 0, slippage: 0,
      warmup: 200,
      grahamGate: true, ffdGate: true, sentimentGate: true, vwapGate: true, rvolGate: true
    };
    return { universe, params };
  }

  async function startSimulation() {
    if (state.running || currentSimulationState.isRunning) return;
    const api = window.electronAPI || window.api;
    if (!api || typeof api.simulationStart !== 'function') { setStatus('API de simulação indisponível no Electron.'); return; }
    const payload = buildPayload();
    const summaryCard = $('simulation-summary-card-container');
    if (summaryCard) summaryCard.classList.add('hidden');
    currentSimulationState.isRunning = true; currentSimulationState.progress = 0;
    currentSimulationState.error = null; currentSimulationState.results = null;
    state.running = true;
    updateSimulationUIProgress();
    setStatus('A iniciar motor Workstation...');
    try {
      const res = await api.simulationStart(payload);
      if (!res || !res.ok) throw new Error(res && res.error ? res.error : 'Falha ao iniciar simulação.');
      state.currentRunId = res.runId; currentSimulationState.lastRunId = res.runId;
    } catch (err) {
      currentSimulationState.isRunning = false; state.running = false;
      updateSimulationUIComplete(); setStatus('Erro: ' + (err.message || String(err)));
    }
  }

  async function cancelSimulation() {
    const api = window.electronAPI || window.api;
    if (!api || typeof api.simulationCancel !== 'function') return;
    try { await api.simulationCancel(state.currentRunId || currentSimulationState.lastRunId); setStatus('A cancelar...'); } catch (_) {}
  }

  function escapeHtml(str) {
    if (str == null) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
