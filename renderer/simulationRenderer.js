(function () {
  'use strict';

  // ═══════════════════════════════════════════════════════════
  //  SIMULAÇÃO DE ESTRATÉGIAS QUANTITATIVAS — RENDERER
  //  Dashboard unificado de parâmetros e pop-up modal detalhado.
  // ═══════════════════════════════════════════════════════════

  const $ = (id) => document.getElementById(id);

  let activeSimulationReport = null;
  let equityChartInstance = null;
  let drawdownChartInstance = null;

  // Estado global em memória para persistência entre navegação de abas e testes
  const currentSimulationState = {
    isRunning: false,
    progress: 0,
    currentTicker: '',
    totalTickers: 0,
    completedTickers: 0,
    message: '',
    results: null,
    error: null,
    lastRunId: null
  };

  window.simulationState = currentSimulationState;

  const state = {
    currentRunId: null,
    running: false,
    unsubscribers: []
  };

  function getUIElements() {
    return {
      // Inputs do Dashboard
      universe: $('sim-asset-universe') || $('sim-universe'),
      direction: $('sim-direction'),
      stopLoss: $('sim-stop-loss'),
      takeProfit: $('sim-take-profit'),
      horizonDays: $('sim-horizon') || $('sim-horizon-days'),
      riskPerTrade: $('sim-risk-per-trade') || $('sim-risk'),
      toggleVwap: $('sim-toggle-vwap') || $('sim-vwap-gate'),
      minMc: $('sim-min-mc') || $('sim-mc-min'),
      markovWindow: $('sim-markov-window'),
      startDate: $('sim-start-date'),
      endDate: $('sim-end-date'),
      initialCapital: $('sim-initial-capital') || $('sim-capital'),

      // Botões de Ação
      btnStart: $('btn-start-simulation') || $('btn-sim-start'),
      btnReset: $('btn-reset-params'),
      btnCancel: $('btn-sim-cancel'),

      // Progresso e Estado
      progressWrap: $('sim-progress-wrap'),
      progressBar: $('sim-progress-fill') || $('simulation-progress-bar'),
      progressText: $('sim-progress-text') || $('simulation-progress-text'),
      status: $('sim-status'),

      // Card Único de Resumo
      summaryContainer: $('simulation-summary-card-container'),
      btnOpenModal: $('btn-open-simulation-modal'),
      summaryTitle: $('summary-card-title'),
      summaryDates: $('summary-card-dates'),
      summaryGain: $('summary-gain'),
      summaryWinrate: $('summary-winrate'),
      summaryPf: $('summary-pf'),
      summaryDd: $('summary-dd'),

      // Modal Detalhado
      modal: $('modal-simulation-details'),
      modalSubtitle: $('modal-sim-subtitle'),
      btnCloseModal: $('btn-close-sim-modal'),
      modalFinalCapital: $('modal-final-capital'),
      modalTotalTrades: $('modal-total-trades'),
      modalWinningTrades: $('modal-winning-trades'),
      modalExpectedValue: $('modal-expected-value'),
      canvasEquity: $('canvas-equity-curve'),
      canvasDrawdown: $('canvas-drawdown-curve'),
      tbodyTrades: $('tbody-trades-log')
    };
  }

  function init() {
    bindApiEvents();
    bindTabNavigation();
    setDefaultDates();
    bindListeners();
  }

  // ── Datas por defeito (6 anos de histórico) ──
  function pad(n) { return String(n).padStart(2, '0'); }
  function toInputDate(d) {
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  function setDefaultDates() {
    const ui = getUIElements();
    const today = new Date();
    const start = new Date(today.getFullYear() - 6, today.getMonth(), today.getDate());
    if (ui.startDate && !ui.startDate.value) ui.startDate.value = toInputDate(start);
    if (ui.endDate && !ui.endDate.value) ui.endDate.value = toInputDate(today);
  }

  function resetDefaultParams() {
    const ui = getUIElements();
    if (ui.universe) ui.universe.value = 'ALL';
    if (ui.direction) ui.direction.value = 'LONG';
    if (ui.stopLoss) ui.stopLoss.value = '2.4';
    if (ui.takeProfit) ui.takeProfit.value = '4.8';
    if (ui.horizonDays) ui.horizonDays.value = '35';
    if (ui.riskPerTrade) ui.riskPerTrade.value = '2.0';
    if (ui.toggleVwap) ui.toggleVwap.checked = true;
    if (ui.minMc) ui.minMc.value = '50';
    if (ui.markovWindow) ui.markovWindow.value = '200';
    if (ui.initialCapital) ui.initialCapital.value = '10000';

    const today = new Date();
    const start = new Date(today.getFullYear() - 6, today.getMonth(), today.getDate());
    if (ui.startDate) ui.startDate.value = toInputDate(start);
    if (ui.endDate) ui.endDate.value = toInputDate(today);

    setStatus('Parâmetros restaurados para os valores padrão.');
  }

  // ── Listeners de UI ──
  function bindListeners() {
    const ui = getUIElements();
    if (ui.btnStart) ui.btnStart.addEventListener('click', startSimulation);
    if (ui.btnReset) ui.btnReset.addEventListener('click', resetDefaultParams);
    if (ui.btnCancel) ui.btnCancel.addEventListener('click', cancelSimulation);

    // Abertura do Modal pelo Card Resumo
    if (ui.btnOpenModal) {
      ui.btnOpenModal.addEventListener('click', () => {
        if (!activeSimulationReport) return;
        openSimulationModal(activeSimulationReport);
      });
    }

    // Fecho do Modal
    if (ui.btnCloseModal) {
      ui.btnCloseModal.addEventListener('click', closeSimulationModal);
    }

    if (ui.modal) {
      ui.modal.addEventListener('click', (e) => {
        if (e.target === ui.modal) {
          closeSimulationModal();
        }
      });
    }

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        closeSimulationModal();
      }
    });
  }

  function bindTabNavigation() {
    document.querySelectorAll('.tab-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (btn.dataset.tab === 'simulation') {
          setTimeout(restoreSimulationViewState, 30);
        }
      });
    });
  }

  // ── Subscrição de eventos IPC ──
  function bindApiEvents() {
    const api = window.electronAPI || window.api;
    if (!api) return;

    const onProg = (data) => onProgress(data);
    const onRes = (data) => onSimulationFinished(data);
    const onErr = (data) => onError(data);

    if (typeof api.onSimulationProgress === 'function') {
      const un = api.onSimulationProgress(onProg);
      if (typeof un === 'function') state.unsubscribers.push(un);
    }
    if (typeof api.onSimulationProgressSpec === 'function') {
      const un = api.onSimulationProgressSpec(onProg);
      if (typeof un === 'function') state.unsubscribers.push(un);
    }
    if (typeof api.onSimulationComplete === 'function') {
      const un = api.onSimulationComplete(onRes);
      if (typeof un === 'function') state.unsubscribers.push(un);
    } else if (typeof api.onSimulationResult === 'function') {
      const un = api.onSimulationResult(onRes);
      if (typeof un === 'function') state.unsubscribers.push(un);
    }
    if (typeof api.onSimulationError === 'function') {
      const un = api.onSimulationError(onErr);
      if (typeof un === 'function') state.unsubscribers.push(un);
    }
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
    currentSimulationState.message = data.message || '';

    updateSimulationUIProgress();
  }

  function updateSimulationUIProgress() {
    const ui = getUIElements();
    const percent = currentSimulationState.progress || 0;
    const ticker = currentSimulationState.currentTicker || '';
    const msg = currentSimulationState.message;

    if (ui.progressWrap) ui.progressWrap.hidden = false;
    if (ui.progressBar) ui.progressBar.style.width = `${percent}%`;
    const simBar = document.getElementById('simulation-progress-bar');
    if (simBar) simBar.style.width = `${percent}%`;

    const txt = `${percent}% ${ticker ? '(' + ticker + ')' : ''}`;
    if (ui.progressText) ui.progressText.textContent = txt;
    const simTxt = document.getElementById('simulation-progress-text');
    if (simTxt) simTxt.textContent = txt;

    if (ui.btnStart) ui.btnStart.disabled = true;
    if (ui.btnCancel) ui.btnCancel.hidden = false;

    if (msg) {
      setStatus(msg);
    } else if (ticker) {
      setStatus(`A simular ativo ${ticker}... (${percent}%)`);
    }
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
    if (ui.progressText) ui.progressText.textContent = '0%';
  }

  function onError(data) {
    if (!data || !isCurrentRun(data)) return;
    const msg = (data && data.message) || (data && data.error) || 'Erro na simulação.';
    currentSimulationState.error = msg;

    if (!(data && data.ticker)) {
      state.currentRunId = null;
      currentSimulationState.lastRunId = null;
      currentSimulationState.isRunning = false;
      state.running = false;
      updateSimulationUIComplete();
    }
    setStatus('Aviso: ' + msg);
  }

  function restoreSimulationViewState() {
    if (currentSimulationState.isRunning) {
      updateSimulationUIProgress();
    } else if (currentSimulationState.results || activeSimulationReport) {
      updateSimulationUIComplete();
      const report = activeSimulationReport || normalizeSimulationReport(currentSimulationState.results);
      renderSimulationSummaryCard(report);
    } else if (currentSimulationState.error) {
      updateSimulationUIComplete();
      setStatus('Erro na simulação: ' + currentSimulationState.error);
    }
  }

  window.restoreSimulationViewState = restoreSimulationViewState;

  function setStatus(msg) {
    const ui = getUIElements();
    if (!ui.status) return;
    ui.status.textContent = msg || '';
    ui.status.hidden = !msg;
  }

  // ── Normalização dos dados do relatório ──
  function normalizeSimulationReport(raw) {
    if (!raw) return {};
    const kpis = raw.kpis || {};
    const trades = Array.isArray(raw.trades) ? raw.trades : [];

    const totalGain = raw.totalGain ?? kpis.netProfitPct ?? kpis.netProfit ?? 0;
    const winRate = raw.winRate ?? kpis.winRate ?? 0;
    const profitFactor = raw.profitFactor ?? kpis.profitFactor ?? 0;
    const maxDrawdown = raw.maxDrawdown ?? kpis.maxDrawdownPct ?? kpis.maxDrawdown ?? 0;

    const initialCap = Number(raw.initialCapital || raw.capital || 10000);
    const netProfit = kpis.netProfit != null ? Number(kpis.netProfit) : (totalGain * initialCap / 100);
    const finalCapital = raw.finalCapital ?? (initialCap + netProfit);

    const winningTradesCount = raw.winningTradesCount ?? trades.filter(t => (t.profit || 0) > 0).length;
    const expectedValue = raw.expectedValue ?? kpis.expectancy ?? (trades.length > 0 ? (netProfit / trades.length) : 0);

    const equityCurve = (raw.equityCurve || []).map(p => ({
      date: p.date,
      capital: p.capital ?? p.value ?? initialCap
    }));

    const drawdownCurve = (raw.drawdownCurve || raw.drawdownSeries || []).map(p => ({
      date: p.date,
      drawdown: p.drawdown ?? p.value ?? 0
    }));

    return {
      totalGain: Number(totalGain),
      winRate: Number(winRate),
      profitFactor: Number(profitFactor),
      maxDrawdown: Number(maxDrawdown),
      finalCapital: Number(finalCapital),
      totalTrades: trades.length,
      winningTradesCount: Number(winningTradesCount),
      expectedValue: Number(expectedValue),
      equityCurve,
      drawdownCurve,
      trades
    };
  }

  // ── 1. RENDERIZAÇÃO DO CARD RESUMO ÚNICO ──
  function renderSimulationSummaryCard(results) {
    const data = results?.totalGain != null ? results : normalizeSimulationReport(results);
    const container = document.getElementById('simulation-summary-card-container');
    if (container) {
      container.classList.remove('hidden');
    }

    const simResultsEl = document.getElementById('sim-results');
    if (simResultsEl) {
      simResultsEl.hidden = false;
    }

    const totalGain = data.totalGain || 0;
    const winRate = data.winRate || 0;
    const profitFactor = data.profitFactor || 0;
    const maxDrawdown = data.maxDrawdown || 0;

    const gainEl = document.getElementById('summary-gain');
    const winrateEl = document.getElementById('summary-winrate');
    const pfEl = document.getElementById('summary-pf');
    const ddEl = document.getElementById('summary-dd');

    if (gainEl) gainEl.textContent = `${totalGain >= 0 ? '+' : ''}${totalGain.toFixed(1)}%`;
    if (winrateEl) winrateEl.textContent = `${winRate.toFixed(0)}%`;
    if (pfEl) pfEl.textContent = profitFactor.toFixed(2);
    if (ddEl) ddEl.textContent = `${maxDrawdown.toFixed(2)}%`;

    const titleEl = document.getElementById('summary-card-title');
    const datesEl = document.getElementById('summary-card-dates');
    if (titleEl) titleEl.textContent = 'Simulação Concluída';
    if (datesEl) datesEl.textContent = `${data.totalTrades || 0} operações executadas • Clique para ver o relatório completo`;

    const riskInfoEl = document.getElementById('sim-risk-info') ||
      (typeof document.querySelector === 'function' ? (document.querySelector('.risk-info') || document.querySelector('.simulation-card-row .risk-info')) : null);
    if (riskInfoEl) {
      riskInfoEl.textContent = 'SL: 2.4% / TP: 4.8% (35d)';
    }

    setStatus(`Simulação concluída com sucesso (${data.totalTrades || 0} operações).`);
  }

  // ── 2. CONTROLO E RENDERIZAÇÃO DO MODAL POP-UP ──
  function openSimulationModal(data) {
    const modal = document.getElementById('modal-simulation-details');
    if (!modal) return;
    modal.classList.remove('hidden');

    const report = data?.totalGain != null ? data : normalizeSimulationReport(data);

    // Atualizar KPIs Detalhados
    const finalCapEl = document.getElementById('modal-final-capital');
    const totalTradesEl = document.getElementById('modal-total-trades');
    const winningTradesEl = document.getElementById('modal-winning-trades');
    const expValueEl = document.getElementById('modal-expected-value');

    if (finalCapEl) {
      finalCapEl.textContent = (report.finalCapital || 0).toLocaleString('pt-PT', {
        style: 'currency',
        currency: 'EUR'
      });
    }

    if (totalTradesEl) {
      totalTradesEl.textContent = String(report.trades ? report.trades.length : 0);
    }

    if (winningTradesEl) {
      const winCount = report.winningTradesCount || 0;
      const winPct = report.winRate || 0;
      winningTradesEl.textContent = `${winCount} (${winPct.toFixed(0)}%)`;
    }

    if (expValueEl) {
      const ev = report.expectedValue || 0;
      expValueEl.textContent = `${ev >= 0 ? '+' : ''}${ev.toFixed(2)}% / trade`;
    }

    // Desenhar Gráficos
    renderModalCharts(report);

    // Preencher Tabela de Operações
    renderTradesTable(report.trades || []);
  }

  function closeSimulationModal() {
    const modal = document.getElementById('modal-simulation-details');
    if (modal) modal.classList.add('hidden');
  }

  // ── 3. GRÁFICOS (EQUITY CURVE & DRAWDOWN) VIA CHART.JS ──
  function renderModalCharts(data) {
    if (equityChartInstance && typeof equityChartInstance.destroy === 'function') {
      equityChartInstance.destroy();
      equityChartInstance = null;
    }
    if (drawdownChartInstance && typeof drawdownChartInstance.destroy === 'function') {
      drawdownChartInstance.destroy();
      drawdownChartInstance = null;
    }

    const canvasEquity = document.getElementById('canvas-equity-curve');
    const canvasDD = document.getElementById('canvas-drawdown-curve');
    const ctxEquity = canvasEquity?.getContext ? canvasEquity.getContext('2d') : null;
    const ctxDD = canvasDD?.getContext ? canvasDD.getContext('2d') : null;

    const ChartLib = window.Chart;

    if (ChartLib && ctxEquity && data.equityCurve && data.equityCurve.length > 0) {
      equityChartInstance = new ChartLib(ctxEquity, {
        type: 'line',
        data: {
          labels: data.equityCurve.map(p => p.date),
          datasets: [{
            label: 'Capital (€)',
            data: data.equityCurve.map(p => p.capital ?? p.value),
            borderColor: '#FFE600',
            backgroundColor: 'rgba(255, 230, 0, 0.1)',
            fill: true,
            tension: 0.1,
            pointRadius: data.equityCurve.length > 150 ? 0 : 2
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          animation: { duration: 400 },
          plugins: {
            legend: { labels: { color: '#cfd8dc' } }
          },
          scales: {
            x: {
              grid: { color: 'rgba(255,255,255,0.05)' },
              ticks: { color: '#8a99ad', maxTicksLimit: 8 }
            },
            y: {
              grid: { color: 'rgba(255,255,255,0.05)' },
              ticks: {
                color: '#8a99ad',
                callback: (val) => `${Number(val).toLocaleString('pt-PT')} €`
              }
            }
          }
        }
      });
    } else if (ctxEquity && data.equityCurve && data.equityCurve.length > 0) {
      drawCanvasFallback(canvasEquity, data.equityCurve, 'capital', '#FFE600');
    }

    if (ChartLib && ctxDD && data.drawdownCurve && data.drawdownCurve.length > 0) {
      drawdownChartInstance = new ChartLib(ctxDD, {
        type: 'line',
        data: {
          labels: data.drawdownCurve.map(p => p.date),
          datasets: [{
            label: 'Drawdown (%)',
            data: data.drawdownCurve.map(p => p.drawdown ?? p.value),
            borderColor: '#FF5252',
            backgroundColor: 'rgba(255, 82, 82, 0.15)',
            fill: true,
            tension: 0.1,
            pointRadius: data.drawdownCurve.length > 150 ? 0 : 2
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          animation: { duration: 400 },
          plugins: {
            legend: { labels: { color: '#cfd8dc' } }
          },
          scales: {
            x: {
              grid: { color: 'rgba(255,255,255,0.05)' },
              ticks: { color: '#8a99ad', maxTicksLimit: 8 }
            },
            y: {
              grid: { color: 'rgba(255,255,255,0.05)' },
              ticks: {
                color: '#8a99ad',
                callback: (val) => `${Number(val).toFixed(1)}%`
              }
            }
          }
        }
      });
    } else if (ctxDD && data.drawdownCurve && data.drawdownCurve.length > 0) {
      drawCanvasFallback(canvasDD, data.drawdownCurve, 'drawdown', '#FF5252');
    }
  }

  function drawCanvasFallback(canvas, series, valKey, color) {
    if (!canvas || !canvas.getContext) return;
    const ctx = canvas.getContext('2d');
    const w = canvas.width || 400;
    const h = canvas.height || 200;
    ctx.clearRect(0, 0, w, h);
    if (!series || series.length === 0) return;

    const values = series.map(p => Number(p[valKey] ?? p.value ?? 0));
    const min = Math.min(...values);
    const max = Math.max(...values);
    const range = (max - min) || 1;

    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    for (let i = 0; i < values.length; i++) {
      const x = (i / (values.length - 1 || 1)) * (w - 20) + 10;
      const y = h - 15 - ((values[i] - min) / range) * (h - 30);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  // ── 4. PREENCHIMENTO DA TABELA DE OPERAÇÕES ──
  function renderTradesTable(trades) {
    const tbody = document.getElementById('tbody-trades-log');
    if (!tbody) return;

    if (!trades || trades.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="9" style="text-align:center; color:#8a99ad; padding:24px;">
            Nenhuma operação executada no período configurado.
          </td>
        </tr>
      `;
      return;
    }

    tbody.innerHTML = trades.map(t => {
      const profit = Number(t.profit || 0);
      const profitPct = Number(t.profitPct || 0);
      const isWin = profit >= 0;
      const colorClass = isWin ? 'text-green' : 'text-red';
      const side = t.type || t.side || 'LONG';
      const reason = t.exitReason || t.reason || 'Sinal';

      return `
        <tr>
          <td><strong>${escapeHtml(t.ticker)}</strong></td>
          <td><span style="font-weight:600; color:${side === 'LONG' ? '#00e676' : '#ff5252'}">${escapeHtml(side)}</span></td>
          <td>${escapeHtml(String(t.entryDate || '-').slice(0, 10))}</td>
          <td>${Number(t.entryPrice || 0).toFixed(2)} €</td>
          <td>${escapeHtml(String(t.exitDate || '-').slice(0, 10))}</td>
          <td>${Number(t.exitPrice || 0).toFixed(2)} €</td>
          <td>${escapeHtml(reason)}</td>
          <td class="${colorClass}">${isWin ? '+' : ''}${profit.toFixed(2)} €</td>
          <td class="${colorClass}">${isWin ? '+' : ''}${profitPct.toFixed(2)}%</td>
        </tr>
      `;
    }).join('');
  }

  function escapeHtml(str) {
    if (str == null) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  // ── 5. DISPARO E CANCELAMENTO DA SIMULAÇÃO ──
  function toNum(input, fallback) {
    if (!input) return fallback;
    const n = Number(input.value);
    return isNaN(n) ? fallback : n;
  }

  function buildPayload() {
    const ui = getUIElements();
    const universeValue = ui.universe ? ui.universe.value : 'ALL';

    const universe = {};
    if (universeValue === 'ALL' || universeValue === 'all') {
      universe.mode = 'all';
    } else {
      universe.mode = 'index';
      universe.index = universeValue;
    }

    const directionValue = ui.direction ? ui.direction.value : 'LONG';
    const direction = directionValue.toLowerCase();

    const params = {
      direction,
      exitMode: 'full',
      markovOrder: 1,
      stateSpace: '9',
      stopType: 'pct',
      stopLoss: toNum(ui.stopLoss, 2.4),
      takeProfit: toNum(ui.takeProfit, 4.8),
      horizonDays: toNum(ui.horizonDays, 35),
      risk: toNum(ui.riskPerTrade, 2.0),
      vwapGate: ui.toggleVwap ? !!ui.toggleVwap.checked : true,
      minMC: toNum(ui.minMc, 50),
      mcMin: toNum(ui.minMc, 50),
      markovWindow: toNum(ui.markovWindow, 200),
      startDate: ui.startDate && ui.startDate.value ? String(ui.startDate.value).slice(0, 10) : null,
      endDate: ui.endDate && ui.endDate.value ? String(ui.endDate.value).slice(0, 10) : null,
      capital: toNum(ui.initialCapital, 10000),
      initialCapital: toNum(ui.initialCapital, 10000),
      commission: 0.05,
      slippage: 0.05
    };

    return { universe, params };
  }

  async function startSimulation() {
    if (state.running || currentSimulationState.isRunning) return;
    const api = window.electronAPI || window.api;
    if (!api || typeof api.simulationStart !== 'function') {
      setStatus('API de simulação indisponível no Electron.');
      return;
    }

    const payload = buildPayload();
    if (!payload) return;

    // Ocultar card de resumo anterior ao iniciar nova simulação
    const summaryCard = document.getElementById('simulation-summary-card-container');
    if (summaryCard) summaryCard.classList.add('hidden');

    currentSimulationState.isRunning = true;
    currentSimulationState.progress = 0;
    currentSimulationState.error = null;
    currentSimulationState.results = null;
    state.running = true;

    updateSimulationUIProgress();
    setStatus('A inicializar motor de simulação...');

    try {
      const res = await api.simulationStart(payload);
      if (!res || !res.ok) {
        throw new Error(res && res.error ? res.error : 'Falha ao iniciar simulação.');
      }
      state.currentRunId = res.runId;
      currentSimulationState.lastRunId = res.runId;
    } catch (err) {
      currentSimulationState.isRunning = false;
      state.running = false;
      updateSimulationUIComplete();
      setStatus('Erro: ' + (err.message || String(err)));
    }
  }

  async function cancelSimulation() {
    const api = window.electronAPI || window.api;
    if (!api || typeof api.simulationCancel !== 'function') return;
    const runId = state.currentRunId || currentSimulationState.lastRunId;
    try {
      await api.simulationCancel(runId);
      setStatus('A cancelar simulação...');
    } catch (err) {
      console.warn('[sim] Erro ao cancelar:', err);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
