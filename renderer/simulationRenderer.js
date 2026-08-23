(function () {
  'use strict';

  // ═══════════════════════════════════════════════════════════
  //  SIMULAÇÃO DE ESTRATÉGIAS — Renderer da aba de Backtesting
  //  Blindado contra crash em troca de abas e desacoplado de nós DOM.
  // ═══════════════════════════════════════════════════════════

  const $ = (id) => document.getElementById(id);

  // Estado global em memória para persistência entre navegação de abas
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

  // Exposição global para integração e testes
  window.simulationState = currentSimulationState;

  const state = {
    currentRunId: null,
    lastResult: null,
    sortKey: 'exitDate',
    sortDir: 'desc',
    page: 0,
    pageSize: 50,
    searchQuery: '',
    running: false,
    dataToastShown: false,
    unsubscribers: []
  };

  const REASON_LABELS = { TP: 'Take Profit', SL: 'Stop Loss', Trailing: 'Trailing', Sinal: 'Sinal' };
  const INSUFFICIENT_DATA_RE = /não foram encontrados dados|sem registos suficientes|sem candles disponíveis|dados insuficientes/i;

  function getUIElements() {
    return {
      subtitle: $('sim-subtitle'),
      universe: $('sim-universe'),
      index: $('sim-index'),
      asset: $('sim-asset'),
      indexField: $('sim-index-field'),
      assetField: $('sim-asset-field'),
      direction: $('sim-direction'),
      exitMode: $('sim-exit-mode'),
      markovOrder: $('sim-markov-order'),
      stateSpace: $('sim-state-space'),
      stopType: $('sim-stop-type'),
      stopLoss: $('sim-stop-loss'),
      takeProfit: $('sim-take-profit'),
      trailing: $('sim-trailing'),
      trailingOffset: $('sim-trailing-offset'),
      vwapGate: $('sim-vwap-gate'),
      rvolGate: $('sim-rvol-gate'),
      mcMin: $('sim-mc-min'),
      markovMin: $('sim-markov-min'),
      startDate: $('sim-start-date'),
      endDate: $('sim-end-date'),
      capital: $('sim-capital'),
      risk: $('sim-risk'),
      commission: $('sim-commission'),
      slippage: $('sim-slippage'),
      btnStart: $('btn-sim-start'),
      btnCancel: $('btn-sim-cancel'),
      progressWrap: $('sim-progress-wrap'),
      progressBar: $('simulation-progress-bar') || $('sim-progress-fill'),
      progressText: $('simulation-progress-text') || $('sim-progress-text'),
      activeTickerEl: $('simulation-current-ticker') || $('sim-status'),
      status: $('sim-status'),
      results: $('sim-results'),
      canvas: $('sim-equity-chart'),
      tradesBody: $('sim-trades-body'),
      tradesSearch: $('sim-trades-search'),
      pagePrev: $('sim-page-prev'),
      pageNext: $('sim-page-next'),
      pageInfo: $('sim-page-info'),
      kpis: {
        net: $('sim-kpi-net'),
        netPct: $('sim-kpi-net-pct'),
        winrate: $('sim-kpi-winrate'),
        profitFactor: $('sim-kpi-profit-factor'),
        maxDd: $('sim-kpi-max-dd'),
        maxDdPct: $('sim-kpi-max-dd-pct'),
        payoff: $('sim-kpi-payoff'),
        total: $('sim-kpi-total'),
        longs: $('sim-kpi-longs'),
        shorts: $('sim-kpi-shorts'),
        duration: $('sim-kpi-duration')
      }
    };
  }

  function isSimulationTabVisible() {
    const tab = $('tab-simulation');
    return !!(tab && tab.classList.contains('active') && tab.offsetParent !== null);
  }

  function init() {
    bindApiEvents();
    bindTabNavigation();
    const ui = getUIElements();
    if (!ui.universe) return;
    setDefaultDates();
    loadOptions();
    bindListeners();
  }

  // ── Datas por defeito ──
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

  // ── Opções (índices / ativos) ──
  function fillSelect(select, items, mapFn) {
    if (!select) return;
    select.innerHTML = '';
    const list = Array.isArray(items) ? items : [];
    if (list.length === 0) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = '— sem opções —';
      select.appendChild(opt);
      return;
    }
    for (const item of list) {
      const mapped = mapFn(item);
      const opt = document.createElement('option');
      opt.value = mapped.value;
      opt.textContent = mapped.label;
      select.appendChild(opt);
    }
  }

  async function loadOptions() {
    const api = window.api || window.electronAPI;
    if (!api || typeof api.simulationOptions !== 'function') return;
    try {
      const res = await api.simulationOptions();
      if (!res || !res.ok) return;
      const ui = getUIElements();
      fillSelect(ui.index, res.indices, (i) => ({ value: i.id, label: i.name }));
      fillSelect(ui.asset, res.assets, (a) => ({
        value: a.ticker,
        label: a.ticker + (a.name ? ' — ' + a.name : '') + (a.indexName ? ' [' + a.indexName + ']' : '')
      }));
    } catch (err) {
      console.warn('[sim] simulationOptions falhou:', err);
    }
  }

  // ── Visibilidade do universo ──
  function updateUniverseVisibility() {
    const ui = getUIElements();
    const mode = ui.universe ? ui.universe.value : 'all';
    if (ui.indexField) ui.indexField.hidden = mode !== 'index';
    if (ui.assetField) ui.assetField.hidden = mode !== 'single';
  }

  // ── Listeners de UI ──
  function bindListeners() {
    const ui = getUIElements();
    if (ui.universe) ui.universe.addEventListener('change', updateUniverseVisibility);
    if (ui.btnStart) ui.btnStart.addEventListener('click', startSimulation);
    if (ui.btnCancel) ui.btnCancel.addEventListener('click', cancelSimulation);

    if (ui.tradesSearch) {
      ui.tradesSearch.addEventListener('input', (e) => {
        state.searchQuery = String(e.target.value || '').trim().toLowerCase();
        state.page = 0;
        renderTrades();
      });
    }
    if (ui.pagePrev) {
      ui.pagePrev.addEventListener('click', () => {
        if (state.page > 0) { state.page--; renderTrades(); }
      });
    }
    if (ui.pageNext) {
      ui.pageNext.addEventListener('click', () => {
        state.page++;
        renderTrades();
      });
    }

    const sortableThs = document.querySelectorAll('#sim-trades-table thead th[data-sort]');
    sortableThs.forEach((th) => {
      if (th) th.addEventListener('click', () => onSortClick(th));
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

  // ── Eventos do main process (progress / result / error) ──
  function bindApiEvents() {
    const api = window.api || window.electronAPI;
    if (!api) return;

    const onProg = (data) => onProgress(data);
    const onRes = (data) => onResult(data);
    const onErr = (data) => onError(data);

    if (typeof api.onSimulationProgress === 'function') {
      const un = api.onSimulationProgress(onProg);
      if (typeof un === 'function') state.unsubscribers.push(un);
    }
    if (typeof api.onSimulationProgressSpec === 'function') {
      const un = api.onSimulationProgressSpec(onProg);
      if (typeof un === 'function') state.unsubscribers.push(un);
    }
    if (typeof api.onSimulationResult === 'function') {
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

  // ── Throttled UI Progress Updates ──
  let progressRafId = null;
  let lastProgressUpdateTime = 0;

  function scheduleProgressUpdate() {
    const now = Date.now();
    if (now - lastProgressUpdateTime > 80) {
      lastProgressUpdateTime = now;
      if (progressRafId) cancelAnimationFrame(progressRafId);
      progressRafId = null;
      updateSimulationUIProgress();
    } else if (!progressRafId) {
      progressRafId = requestAnimationFrame(() => {
        progressRafId = null;
        lastProgressUpdateTime = Date.now();
        updateSimulationUIProgress();
      });
    }
  }

  function onProgress(data) {
    if (!data || !isCurrentRun(data)) return;

    currentSimulationState.isRunning = true;
    state.running = true;
    if (data.runId) {
      currentSimulationState.lastRunId = data.runId;
      state.currentRunId = data.runId;
    }

    if (data.current != null && data.total != null && data.total > 0) {
      currentSimulationState.completedTickers = Number(data.current) || 0;
      currentSimulationState.totalTickers = Number(data.total) || 0;
      currentSimulationState.progress = Math.min(100, Math.max(0, (currentSimulationState.completedTickers / currentSimulationState.totalTickers) * 100));
    } else if (data.percent != null) {
      currentSimulationState.progress = Math.min(100, Math.max(0, Number(data.percent) || 0));
    }

    if (data.ticker) currentSimulationState.currentTicker = String(data.ticker);
    if (data.message) currentSimulationState.message = String(data.message);

    scheduleProgressUpdate();
  }

  function updateSimulationUIProgress() {
    const ui = getUIElements();
    const isRunning = currentSimulationState.isRunning;
    const pct = Math.min(100, Math.max(0, currentSimulationState.progress));

    if (ui.progressWrap) {
      ui.progressWrap.hidden = !isRunning;
    }

    if (ui.btnStart) {
      ui.btnStart.disabled = isRunning;
      const label = ui.btnStart.querySelector('.btn-label');
      if (label) label.textContent = isRunning ? 'A simular...' : 'Iniciar Simulação';
    }

    if (ui.btnCancel) {
      ui.btnCancel.hidden = !isRunning;
      ui.btnCancel.disabled = !isRunning;
    }

    if (ui.progressBar) {
      ui.progressBar.style.width = `${pct}%`;
    }

    if (ui.progressText) {
      const parts = [];
      if (currentSimulationState.currentTicker) parts.push(currentSimulationState.currentTicker);
      if (currentSimulationState.message) parts.push(currentSimulationState.message);
      else if (currentSimulationState.totalTickers > 0 && currentSimulationState.completedTickers > 0) {
        parts.push(`(${currentSimulationState.completedTickers}/${currentSimulationState.totalTickers})`);
      }
      const suffix = parts.length ? ' · ' + parts.join(' · ') : '';
      ui.progressText.textContent = `${Math.round(pct)}%${suffix}`;
    }

    if (ui.activeTickerEl && isRunning) {
      if (currentSimulationState.currentTicker) {
        const countInfo = currentSimulationState.totalTickers > 0
          ? ` (${currentSimulationState.completedTickers}/${currentSimulationState.totalTickers})`
          : '';
        ui.activeTickerEl.textContent = `A simular: ${currentSimulationState.currentTicker}${countInfo}`;
        ui.activeTickerEl.hidden = false;
      }
    }
  }

  function onResult(data) {
    if (!data || !isCurrentRun(data)) return;
    const result = data.result || data.results || (data.trades ? data : null);

    state.currentRunId = null;
    currentSimulationState.lastRunId = null;
    currentSimulationState.isRunning = false;
    currentSimulationState.progress = 100;
    currentSimulationState.results = result;
    state.running = false;

    updateSimulationUIComplete();

    if (!result) {
      setStatus('A simulação terminou sem dados de resultado.');
      return;
    }

    state.lastResult = result;
    state.page = 0;
    state.sortKey = 'exitDate';
    state.sortDir = 'desc';
    const ui = getUIElements();
    state.searchQuery = ui.tradesSearch ? String(ui.tradesSearch.value || '').trim().toLowerCase() : '';

    renderResult(result);

    const trades = result.trades || [];
    if (trades.length === 0) {
      const bad = (result.messages || []).filter(Boolean).find((m) => INSUFFICIENT_DATA_RE.test(String(m)));
      if (bad) {
        const ticker = String(bad).split(':')[0].trim() || '';
        showDataToast(ticker);
      }
    }
  }

  function updateSimulationUIComplete() {
    const ui = getUIElements();
    state.running = false;
    currentSimulationState.isRunning = false;

    if (ui.btnStart) {
      ui.btnStart.disabled = false;
      const label = ui.btnStart.querySelector('.btn-label');
      if (label) label.textContent = 'Iniciar Simulação';
    }

    if (ui.btnCancel) {
      ui.btnCancel.hidden = true;
      ui.btnCancel.disabled = false;
    }

    if (ui.progressWrap) {
      ui.progressWrap.hidden = true;
    }

    if (ui.progressBar) {
      ui.progressBar.style.width = '0%';
    }

    if (ui.progressText) {
      ui.progressText.textContent = '0%';
    }
  }

  function onError(data) {
    if (!data || !isCurrentRun(data)) return;
    const msg = (data && data.message) || (data && data.error) || 'erro desconhecido.';
    currentSimulationState.error = msg;

    if (!(data && data.ticker)) {
      state.currentRunId = null;
      currentSimulationState.lastRunId = null;
      currentSimulationState.isRunning = false;
      state.running = false;
      updateSimulationUIComplete();
    }

    if (INSUFFICIENT_DATA_RE.test(msg)) {
      showDataToast(data.ticker || '');
    }
    setStatus('Erro na simulação: ' + msg);
  }

  function restoreSimulationViewState() {
    if (currentSimulationState.isRunning) {
      updateSimulationUIProgress();
    } else if (currentSimulationState.results) {
      updateSimulationUIComplete();
      renderResult(currentSimulationState.results);
    } else if (currentSimulationState.error) {
      updateSimulationUIComplete();
      setStatus('Erro na simulação: ' + currentSimulationState.error);
    }
  }

  // Expor para chamada no switch de abas
  window.restoreSimulationViewState = restoreSimulationViewState;

  function setStatus(msg) {
    const ui = getUIElements();
    if (!ui.status) return;
    ui.status.textContent = msg || '';
    ui.status.hidden = !msg;
  }

  function showToast(message, type) {
    const container = document.getElementById('toast-container');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = 'toast toast-' + (type || 'error');
    toast.innerHTML = '<span class="toast-icon">' + (type === 'success' ? '✓' : type === 'error' ? '✕' : 'ℹ') + '</span><span class="toast-text">' + escapeHtml(message) + '</span>';
    container.appendChild(toast);
    setTimeout(() => {
      toast.classList.add('toast-fadeout');
      setTimeout(() => toast.remove(), 300);
    }, 4000);
  }

  function showDataToast(ticker) {
    if (state.dataToastShown) return;
    state.dataToastShown = true;
    showToast('⚠️ Não foram encontrados dados suficientes na SQLite para ' + (ticker || 'o ativo selecionado') + '. Por favor, atualiza o histórico na aba My List.');
  }

  // ── Iniciar / cancelar ──
  function toNum(input, fallback) {
    if (!input) return fallback;
    const n = Number(input.value);
    return isNaN(n) ? fallback : n;
  }

  function buildPayload() {
    const ui = getUIElements();
    const universeMode = ui.universe ? ui.universe.value : 'all';
    const universe = { mode: universeMode };
    if (universeMode === 'index') universe.index = ui.index ? ui.index.value : '';
    if (universeMode === 'single') universe.ticker = String(ui.asset ? ui.asset.value : '').trim().toUpperCase();
    if (universeMode !== 'all' && !universe.index && !universe.ticker) {
      setStatus('Seleciona um índice ou ativo antes de iniciar a simulação.');
      return null;
    }

    const params = {
      direction: ui.direction ? ui.direction.value : 'both',
      exitMode: ui.exitMode ? ui.exitMode.value : 'full',
      markovOrder: Number(ui.markovOrder && ui.markovOrder.value) === 2 ? 2 : 1,
      stateSpace: (ui.stateSpace && ui.stateSpace.value) || '9',
      stopType: ui.stopType ? ui.stopType.value : 'pct',
      stopLoss: toNum(ui.stopLoss, 1.4),
      takeProfit: toNum(ui.takeProfit, 2.8),
      trailing: !!(ui.trailing && ui.trailing.checked),
      trailingOffset: toNum(ui.trailingOffset, 1.0),
      vwapGate: !!(ui.vwapGate && ui.vwapGate.checked),
      rvolGate: !!(ui.rvolGate && ui.rvolGate.checked),
      minRVOL: 1.0,
      mcMin: toNum(ui.mcMin, 50),
      markovMin: toNum(ui.markovMin, 55),
      startDate: ui.startDate && ui.startDate.value ? String(ui.startDate.value).slice(0, 10) : null,
      endDate: ui.endDate && ui.endDate.value ? String(ui.endDate.value).slice(0, 10) : null,
      capital: toNum(ui.capital, 10000),
      risk: toNum(ui.risk, 2),
      commission: toNum(ui.commission, 0.05),
      slippage: toNum(ui.slippage, 0.05)
    };
    return { universe, params };
  }

  function startSimulation() {
    if (state.running || currentSimulationState.isRunning) return;
    const api = window.api || window.electronAPI;
    if (!api || typeof api.simulationStart !== 'function') {
      setStatus('API de simulação indisponível neste contexto.');
      return;
    }
    const payload = buildPayload();
    if (!payload) return;

    state.dataToastShown = false;
    currentSimulationState.isRunning = true;
    currentSimulationState.progress = 0;
    currentSimulationState.results = null;
    currentSimulationState.error = null;
    state.running = true;
    state.lastResult = null;

    updateSimulationUIProgress();
    setStatus('');
    const ui = getUIElements();
    if (ui.results) ui.results.hidden = true;

    api.simulationStart(payload)
      .then((res) => {
        if (res && res.ok && res.runId) {
          state.currentRunId = res.runId;
          currentSimulationState.lastRunId = res.runId;
        } else {
          state.currentRunId = null;
          currentSimulationState.lastRunId = null;
          updateSimulationUIComplete();
          setStatus((res && res.error) || 'Falha ao iniciar a simulação.');
        }
      })
      .catch((err) => {
        state.currentRunId = null;
        currentSimulationState.lastRunId = null;
        updateSimulationUIComplete();
        setStatus('Erro ao iniciar a simulação: ' + (err && err.message ? err.message : String(err)));
      });
  }

  function cancelSimulation() {
    const runId = state.currentRunId || currentSimulationState.lastRunId;
    const api = window.api || window.electronAPI;
    if (api && typeof api.simulationCancel === 'function') {
      try { api.simulationCancel(runId); } catch (_) { /* ignora */ }
    }
  }

  // ── Resultado ──
  function renderResult(result) {
    if (!result) return;
    const ui = getUIElements();
    const msgs = (result.messages || []).filter(Boolean);
    if (result.cancelled) msgs.unshift('Simulação cancelada.');

    const meta = result.meta || {};
    const orderLabel = Number(meta.markovOrder) === 2 ? '2ª Ordem (2 Velas)' : '1ª Ordem (1 Vela)';
    const spaceLabel = meta.stateSpace === '3' ? '3 Estados (Bear/Neutro/Bull)'
      : meta.stateSpace === '6' ? '6 Estados (ADX + Bollinger)'
      : '9 Estados (ADX×Bollinger)';
    if (meta.markovOrder != null || meta.stateSpace != null) {
      msgs.unshift('Motor Markov: ' + orderLabel + ' · ' + spaceLabel);
    }

    setStatus(msgs.join(' · '));
    renderKpis(result.kpis || {});

    // Renderiza chart apenas se a aba estiver visível (evita canvas width=0)
    drawChart(result.equityCurve || [], result.benchmark || [], result.drawdownSeries || []);
    renderTrades();

    if (ui.results) ui.results.hidden = false;
  }

  // ── Formatação ──
  function fmtMoney(v) {
    if (v == null || isNaN(Number(v))) return '—';
    return new Intl.NumberFormat('pt-PT', { style: 'currency', currency: 'EUR', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(v));
  }
  function fmtNum(v, dec) {
    if (v == null || isNaN(Number(v))) return '—';
    return Number(v).toFixed(dec == null ? 1 : dec);
  }
  function fmtPct(v, dec) {
    if (v == null || isNaN(Number(v))) return '—';
    return fmtNum(v, dec == null ? 2 : dec) + '%';
  }
  function fmtInt(v) {
    if (v == null || isNaN(Number(v))) return '—';
    return Number(v).toLocaleString('pt-PT');
  }
  function shortMoney(v) {
    const n = Number(v);
    if (isNaN(n)) return '—';
    const abs = Math.abs(n);
    const sign = n < 0 ? '-' : '';
    if (abs >= 1000000) return sign + (abs / 1000000).toFixed(1).replace('.', ',') + 'M €';
    if (abs >= 1000) return sign + (abs / 1000).toFixed(1).replace('.', ',') + 'k €';
    return sign + Math.round(abs) + ' €';
  }
  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ── KPI cards ──
  function setKpi(card, text, mood) {
    if (!card) return;
    const val = card.querySelector('.sim-kpi-val');
    if (val) val.textContent = text;
    card.classList.remove('is-good', 'is-bad', 'is-warn', 'is-neutral');
    if (mood) card.classList.add(mood);
    else card.classList.add('is-neutral');
  }
  function moodOf(v, goodWhenPositive) {
    const n = Number(v);
    if (isNaN(n)) return 'is-neutral';
    if (n === 0) return 'is-neutral';
    if (goodWhenPositive) return n > 0 ? 'is-good' : 'is-bad';
    return n > 0 ? 'is-bad' : 'is-good';
  }

  function drawdownValue(v) {
    const n = Number(v);
    if (isNaN(n)) return null;
    return n > 0 ? -n : n;
  }

  function renderKpis(k) {
    const ui = getUIElements();
    const kpis = ui.kpis;
    if (!kpis) return;
    setKpi(kpis.net, fmtMoney(k.netProfit), moodOf(k.netProfit, true));
    setKpi(kpis.netPct, fmtPct(k.netProfitPct), moodOf(k.netProfitPct, true));
    setKpi(kpis.winrate, fmtPct(k.winRate, 1), Number(k.winRate) >= 50 ? 'is-good' : 'is-neutral');
    setKpi(kpis.profitFactor, fmtNum(k.profitFactor, 2), Number(k.profitFactor) >= 1 ? 'is-good' : 'is-bad');
    const dd = drawdownValue(k.maxDrawdown);
    setKpi(kpis.maxDd, dd == null ? '—' : fmtMoney(dd), 'is-bad');
    const ddPct = drawdownValue(k.maxDrawdownPct);
    setKpi(kpis.maxDdPct, ddPct == null ? '—' : fmtPct(ddPct), 'is-bad');
    setKpi(kpis.payoff, fmtNum(k.payoffRatio, 2), Number(k.payoffRatio) >= 1 ? 'is-good' : 'is-neutral');
    setKpi(kpis.total, fmtInt(k.totalTrades), 'is-neutral');
    setKpi(kpis.longs, fmtInt(k.longTrades), 'is-neutral');
    setKpi(kpis.shorts, fmtInt(k.shortTrades), 'is-neutral');
    setKpi(kpis.duration, k.avgDurationDays == null ? '—' : fmtNum(k.avgDurationDays, 0) + ' d', 'is-neutral');
  }

  // ── Gráfico canvas (sem bibliotecas) ──
  const CHART_COLORS = {
    grid: 'rgba(255,255,255,0.06)',
    axis: 'rgba(255,255,255,0.35)',
    legendText: '#a3a9b8',
    muted: '#6b7384',
    accent: '#818cf8',
    bear: '#fb7185',
    benchLine: 'rgba(255,255,255,0.35)',
    crosshair: 'rgba(255,255,255,0.18)',
    tooltipBg: 'rgba(14,16,23,0.95)',
    tooltipBorder: 'rgba(255,255,255,0.12)'
  };

  const chartRef = {
    bound: false,
    hoverIndex: null,
    mouseY: null,
    geom: null,
    pendingDraw: null
  };

  function fmtAxisDate(d, spanDays) {
    if (spanDays > 800) {
      return d.toLocaleDateString('pt-PT', { month: '2-digit', year: '2-digit' });
    }
    return d.toLocaleDateString('pt-PT', { day: '2-digit', month: '2-digit' });
  }

  function fmtTooltipDate(d) {
    const dt = new Date(d);
    if (isNaN(dt.getTime())) return '—';
    return dt.toLocaleDateString('pt-PT', { day: '2-digit', month: '2-digit', year: '2-digit' });
  }

  function roundRectPath(ctx, x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }

  function prepSeries(series) {
    const out = [];
    if (!Array.isArray(series)) return out;
    for (const p of series) {
      if (!p) continue;
      const v = Number(p.value);
      const t = new Date(p.date).getTime();
      if (!isFinite(v) || isNaN(t)) continue;
      out.push({ t, v, date: p.date });
    }
    return out;
  }

  function nearestPointByX(pts, x, tol) {
    let bestI = -1, bestD = Infinity;
    for (let i = 0; i < pts.length; i++) {
      const d = Math.abs(pts[i].x - x);
      if (d < bestD) { bestD = d; bestI = i; }
      else if (pts[i].x > x && bestD <= tol) break;
    }
    return bestI >= 0 && bestD <= tol ? bestI : -1;
  }

  function bindChartHover(canvas) {
    if (chartRef.bound || !canvas) return;
    chartRef.bound = true;
    canvas.addEventListener('mousemove', onChartMove);
    canvas.addEventListener('mouseleave', onChartLeave);
  }

  function onChartMove(e) {
    const g = chartRef.geom;
    const ui = getUIElements();
    if (!g || !g.hoverable || g.eqPts.length === 0 || !ui.canvas) return;
    const rect = ui.canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    chartRef.mouseY = e.clientY - rect.top;
    const cx = Math.min(g.plotX1, Math.max(g.plotX0, mx));
    chartRef.hoverIndex = nearestPointByX(g.eqPts, cx, g.W);
    renderChart();
  }

  function onChartLeave() {
    if (chartRef.hoverIndex == null) return;
    chartRef.hoverIndex = null;
    chartRef.mouseY = null;
    renderChart();
  }

  function drawEmptyState(ctx, W, H) {
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '12px JetBrains Mono, monospace';
    ctx.fillStyle = CHART_COLORS.muted;
    ctx.fillText('Sem dados de curva de capital', W / 2, H / 2 - 9);
    ctx.font = '10px JetBrains Mono, monospace';
    ctx.fillStyle = 'rgba(107,115,132,0.75)';
    ctx.fillText('Executa uma simulação para veres a curva', W / 2, H / 2 + 11);
  }

  function computeChartGeom(equityRaw, benchmarkRaw, drawdownRaw, W, H) {
    const eq = prepSeries(equityRaw);
    const bm = prepSeries(benchmarkRaw);
    const dd = prepSeries(drawdownRaw);
    if (eq.length === 0 && bm.length === 0) return null;

    const padL = 74, padR = 18, padT = 26, padB = 34;
    const bandH = 56;
    const plotX0 = padL, plotX1 = W - padR;
    const plotY0 = padT, plotY1 = H - padB - bandH;
    const bandY0 = plotY1 + 12, bandY1 = H - padB;

    let minV = Infinity, maxV = -Infinity;
    for (const p of eq) { if (p.v < minV) minV = p.v; if (p.v > maxV) maxV = p.v; }
    for (const p of bm) { if (p.v < minV) minV = p.v; if (p.v > maxV) maxV = p.v; }
    if (minV === maxV) { minV -= 1; maxV += 1; }
    const range = maxV - minV;
    const paddedMin = minV - range * 0.08;
    const paddedMax = maxV + range * 0.08;

    let tMin = Infinity, tMax = -Infinity;
    for (const p of eq) { if (p.t < tMin) tMin = p.t; if (p.t > tMax) tMax = p.t; }
    for (const p of bm) { if (p.t < tMin) tMin = p.t; if (p.t > tMax) tMax = p.t; }
    if (!isFinite(tMin) || !isFinite(tMax)) { tMin = Date.now() - 86400000; tMax = Date.now(); }
    if (tMin === tMax) { tMin -= 86400000; tMax += 86400000; }

    const spanT = tMax - tMin;
    const xOf = (t) => plotX0 + ((t - tMin) / spanT) * (plotX1 - plotX0);
    const yOf = (v) => plotY1 - ((v - paddedMin) / (paddedMax - paddedMin)) * (plotY1 - plotY0);

    const mapPts = (arr) => arr.map((p) => ({ x: xOf(p.t), y: yOf(p.v), v: p.v, date: p.date }));

    let ddMaxAbs = 0;
    for (const p of dd) { const a = Math.abs(p.v); if (a > ddMaxAbs) ddMaxAbs = a; }

    return {
      W, H, plotX0, plotX1, plotY0, plotY1, bandY0, bandY1,
      tMin, tMax, spanDays: spanT / 86400000,
      paddedMin, paddedMax,
      eqPts: mapPts(eq),
      bmPts: mapPts(bm),
      ddPts: dd.map((p) => ({ x: xOf(p.t), v: p.v })),
      ddActive: dd.length > 0 && ddMaxAbs > 1e-9,
      ddMaxAbs,
      hoverable: eq.length > 0
    };
  }

  function strokePath(ctx, pts, style, width, dash) {
    if (pts.length < 2) return false;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.strokeStyle = style;
    ctx.lineWidth = width;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    if (dash) ctx.setLineDash(dash);
    ctx.stroke();
    ctx.restore();
    return true;
  }

  function fillEquityArea(ctx, g) {
    const pts = g.eqPts;
    if (pts.length < 2) return;
    let curveTop = Infinity;
    for (const p of pts) if (p.y < curveTop) curveTop = p.y;
    const top = Math.max(g.plotY0, curveTop);
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.lineTo(pts[pts.length - 1].x, g.plotY1);
    ctx.lineTo(pts[0].x, g.plotY1);
    ctx.closePath();
    ctx.clip();
    const grad = ctx.createLinearGradient(0, top, 0, g.plotY1);
    grad.addColorStop(0, 'rgba(99,102,241,0.25)');
    grad.addColorStop(1, 'rgba(99,102,241,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(g.plotX0, top - 1, g.plotX1 - g.plotX0, g.plotY1 - top + 1);
    ctx.restore();
  }

  function drawDrawdownBand(ctx, g) {
    const n = g.ddPts.length;
    if (!g.ddActive || n === 0) return;
    const hBand = g.bandY1 - g.bandY0;
    const yBand = (v) => g.bandY0 + Math.min(1, Math.abs(v) / g.ddMaxAbs) * hBand;

    ctx.beginPath();
    ctx.moveTo(g.ddPts[0].x, g.bandY1);
    for (let i = 0; i < n; i++) ctx.lineTo(g.ddPts[i].x, yBand(g.ddPts[i].v));
    ctx.lineTo(g.ddPts[n - 1].x, g.bandY1);
    ctx.closePath();
    ctx.fillStyle = 'rgba(251,113,133,0.08)';
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(g.ddPts[0].x, yBand(g.ddPts[0].v));
    for (let i = 1; i < n; i++) ctx.lineTo(g.ddPts[i].x, yBand(g.ddPts[i].v));
    ctx.strokeStyle = 'rgba(251,113,133,0.45)';
    ctx.lineWidth = 1;
    ctx.lineJoin = 'round';
    ctx.stroke();

    ctx.font = '9px JetBrains Mono, monospace';
    ctx.fillStyle = 'rgba(251,113,133,0.55)';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'top';
    ctx.fillText('DD', g.plotX1, g.bandY0 + 3);
  }

  function drawLegend(ctx, g) {
    const items = [
      { label: 'Equidade', kind: 'fill', color: CHART_COLORS.accent },
      { label: 'Benchmark', kind: 'dashed' }
    ];
    if (g.ddActive) items.push({ label: 'Drawdown', kind: 'fill', color: CHART_COLORS.bear });

    ctx.font = '10px JetBrains Mono, monospace';
    ctx.textBaseline = 'middle';
    const chip = 10, chipGap = 6, itemGap = 16;
    const cy = g.plotY0 + 5;

    let widths = items.map((it) => chip + chipGap + ctx.measureText(it.label).width);
    let total = widths.reduce((a, b) => a + b, 0) + itemGap * (items.length - 1);

    let x = g.plotX1 - total;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      roundRectPath(ctx, x, cy - chip / 2, chip, chip, 2);
      if (it.kind === 'dashed') {
        ctx.strokeStyle = CHART_COLORS.benchLine;
        ctx.lineWidth = 1.25;
        ctx.setLineDash([3, 2]);
        ctx.stroke();
        ctx.setLineDash([]);
      } else {
        ctx.fillStyle = it.color;
        ctx.fill();
      }
      ctx.fillStyle = CHART_COLORS.legendText;
      ctx.textAlign = 'left';
      ctx.fillText(it.label, x + chip + chipGap, cy + 0.5);
      x += widths[i] + itemGap;
    }
  }

  function drawCrosshair(ctx, g) {
    const idx = chartRef.hoverIndex;
    if (idx == null || idx < 0 || idx >= g.eqPts.length) return null;
    const hp = g.eqPts[idx];

    ctx.strokeStyle = CHART_COLORS.crosshair;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(hp.x, g.plotY0);
    ctx.lineTo(hp.x, g.plotY1);
    ctx.stroke();

    let bmPt = null;
    if (g.bmPts.length > 0) {
      const j = nearestPointByX(g.bmPts, hp.x, 20);
      if (j >= 0) {
        bmPt = g.bmPts[j];
        ctx.beginPath();
        ctx.arc(bmPt.x, bmPt.y, 3, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255,255,255,0.75)';
        ctx.fill();
      }
    }

    ctx.beginPath();
    ctx.arc(hp.x, hp.y, 7, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(129,140,248,0.22)';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(hp.x, hp.y, 3.5, 0, Math.PI * 2);
    ctx.fillStyle = CHART_COLORS.accent;
    ctx.fill();
    ctx.strokeStyle = 'rgba(14,16,23,0.9)';
    ctx.lineWidth = 1;
    ctx.stroke();

    return { equity: hp, benchmark: bmPt };
  }

  function drawTooltip(ctx, g, hits) {
    const rows = [{ label: 'Data', value: fmtTooltipDate(hits.equity.date) }];
    rows.push({ label: 'Equidade', value: fmtMoney(hits.equity.v) });
    if (hits.benchmark) rows.push({ label: 'Benchmark', value: fmtMoney(hits.benchmark.v) });
    if (g.ddActive && g.ddPts.length > 0) {
      const k = nearestPointByX(g.ddPts, hits.equity.x, 20);
      if (k >= 0) {
        const ddPct = drawdownValue(g.ddPts[k].v);
        rows.push({ label: 'Drawdown', value: ddPct == null ? '—' : fmtPct(ddPct, 2) });
      }
    }

    ctx.textBaseline = 'middle';
    ctx.font = '9px Inter, sans-serif';
    let labelW = 0;
    for (const r of rows) labelW = Math.max(labelW, ctx.measureText(r.label).width);
    ctx.font = '11px JetBrains Mono, monospace';
    let valW = 0;
    for (const r of rows) valW = Math.max(valW, ctx.measureText(r.value).width);

    const pad = 10, rowH = 17, gap = 14;
    const boxW = Math.ceil(pad * 2 + labelW + gap + valW);
    const boxH = Math.ceil(pad * 2 + rows.length * rowH);

    let bx = hits.equity.x + 14;
    if (bx + boxW > g.W - 4) bx = hits.equity.x - 14 - boxW;
    bx = Math.min(Math.max(4, bx), g.W - boxW - 4);
    const my = chartRef.mouseY == null ? g.plotY0 : chartRef.mouseY;
    const by = Math.min(Math.max(4, my - boxH / 2), g.H - boxH - 4);

    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.45)';
    ctx.shadowBlur = 16;
    ctx.shadowOffsetY = 4;
    roundRectPath(ctx, bx, by, boxW, boxH, 8);
    ctx.fillStyle = CHART_COLORS.tooltipBg;
    ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;
    roundRectPath(ctx, bx, by, boxW, boxH, 8);
    ctx.strokeStyle = CHART_COLORS.tooltipBorder;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();

    const valRight = bx + boxW - pad;
    rows.forEach((r, i) => {
      const ry = by + pad + rowH * i + rowH / 2;
      ctx.font = '9px Inter, sans-serif';
      ctx.fillStyle = CHART_COLORS.muted;
      ctx.textAlign = 'left';
      ctx.fillText(r.label, bx + pad, ry);
      ctx.font = '11px JetBrains Mono, monospace';
      ctx.fillStyle = 'rgba(255,255,255,0.96)';
      ctx.textAlign = 'right';
      ctx.fillText(r.value, valRight, ry);
    });
  }

  function renderChart() {
    const ui = getUIElements();
    const canvas = ui.canvas;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const g = chartRef.geom;
    const W = g ? g.W : (canvas.clientWidth || 900);
    const H = 300;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    if (!g) { drawEmptyState(ctx, W, H); return; }

    ctx.strokeStyle = CHART_COLORS.grid;
    ctx.lineWidth = 1;
    ctx.font = '10px JetBrains Mono, monospace';
    ctx.fillStyle = CHART_COLORS.axis;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    const steps = 5;
    for (let i = 0; i <= steps; i++) {
      const frac = i / steps;
      const v = g.paddedMax - (g.paddedMax - g.paddedMin) * frac;
      const y = g.plotY0 + (g.plotY1 - g.plotY0) * frac;
      ctx.beginPath();
      ctx.moveTo(g.plotX0, y);
      ctx.lineTo(g.plotX1, y);
      ctx.stroke();
      ctx.fillText(shortMoney(v), g.plotX0 - 8, y);
    }

    const xSteps = Math.max(2, Math.min(4, Math.floor((g.plotX1 - g.plotX0) / 170)));
    ctx.font = '10px JetBrains Mono, monospace';
    ctx.fillStyle = CHART_COLORS.axis;
    ctx.textBaseline = 'top';
    for (let i = 0; i <= xSteps; i++) {
      const frac = i / xSteps;
      const t = g.tMin + (g.tMax - g.tMin) * frac;
      const x = g.plotX0 + (g.plotX1 - g.plotX0) * frac;
      ctx.textAlign = i === 0 ? 'left' : (i === xSteps ? 'right' : 'center');
      ctx.fillText(fmtAxisDate(new Date(t), g.spanDays), x, g.plotY1 + 8);
    }

    if (g.ddActive) drawDrawdownBand(ctx, g);
    fillEquityArea(ctx, g);

    strokePath(ctx, g.bmPts, CHART_COLORS.benchLine, 1.25, [4, 4]);
    strokePath(ctx, g.eqPts, CHART_COLORS.accent, 2);
    if (g.eqPts.length === 1) {
      ctx.beginPath();
      ctx.arc(g.eqPts[0].x, g.eqPts[0].y, 3.5, 0, Math.PI * 2);
      ctx.fillStyle = CHART_COLORS.accent;
      ctx.fill();
    } else if (g.eqPts.length === 0 && g.bmPts.length === 1) {
      ctx.beginPath();
      ctx.arc(g.bmPts[0].x, g.bmPts[0].y, 3, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,255,255,0.55)';
      ctx.fill();
    }

    const hits = drawCrosshair(ctx, g);
    drawLegend(ctx, g);
    if (hits) drawTooltip(ctx, g, hits);
  }

  function drawChart(equity, benchmark, drawdown) {
    const ui = getUIElements();
    const canvas = ui.canvas;
    if (!canvas) return;

    const cssWidth = canvas.clientWidth || 0;
    if (cssWidth <= 0 || !isSimulationTabVisible()) {
      chartRef.pendingDraw = { equity, benchmark, drawdown };
      return;
    }
    chartRef.pendingDraw = null;

    bindChartHover(canvas);

    const dpr = window.devicePixelRatio || 1;
    const cssHeight = 300;
    const pw = Math.round(cssWidth * dpr);
    const ph = Math.round(cssHeight * dpr);
    if (canvas.width !== pw || canvas.height !== ph) {
      canvas.width = pw;
      canvas.height = ph;
    }

    chartRef.geom = computeChartGeom(equity, benchmark, drawdown, cssWidth, cssHeight);
    chartRef.hoverIndex = null;
    chartRef.mouseY = null;
    renderChart();
  }

  // ── Tabela de trades ──
  function getFilteredTrades() {
    const result = state.lastResult || currentSimulationState.results;
    const trades = (result && result.trades) || [];
    let list = trades;
    const q = state.searchQuery;
    if (q) {
      list = trades.filter((t) =>
        String(t.ticker || '').toLowerCase().includes(q) ||
        String(t.name || '').toLowerCase().includes(q)
      );
    }
    const key = state.sortKey;
    if (key) {
      const dir = state.sortDir === 'asc' ? 1 : -1;
      list = list.slice().sort((a, b) => {
        const va = a[key];
        const vb = b[key];
        if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * dir;
        return String(va || '').localeCompare(String(vb || '')) * dir;
      });
    }
    return list;
  }

  function buildTradeRow(t) {
    const tr = document.createElement('tr');
    const side = String(t.side || '').toUpperCase();
    const reasonKey = REASON_LABELS[t.reason] ? t.reason : 'na';
    const reasonLabel = REASON_LABELS[t.reason] || t.reason || '—';
    const profit = Number(t.profit);
    const profitPct = Number(t.profitPct);
    const isProfitNum = t.profit != null && !isNaN(profit);
    const isPctNum = t.profitPct != null && !isNaN(profitPct);

    tr.innerHTML = '' +
      '<td class="sim-td-ticker">' + escapeHtml(t.ticker || '—') + '</td>' +
      '<td><span class="sim-side sim-side-' + escapeHtml(side || 'na') + '">' + (side === 'LONG' ? 'Long' : side === 'SHORT' ? 'Short' : escapeHtml(t.side || '—')) + '</span></td>' +
      '<td class="sim-td-date">' + escapeHtml(t.entryDate || '—') + '</td>' +
      '<td class="sim-td-num">' + (t.entryPrice != null ? fmtNum(t.entryPrice, 2) : '—') + '</td>' +
      '<td class="sim-td-date">' + escapeHtml(t.exitDate || '—') + '</td>' +
      '<td class="sim-td-num">' + (t.exitPrice != null ? fmtNum(t.exitPrice, 2) : '—') + '</td>' +
      '<td><span class="sim-reason sim-reason-' + escapeHtml(reasonKey) + '">' + escapeHtml(reasonLabel) + '</span></td>' +
      '<td class="sim-td-num ' + (isProfitNum ? (profit >= 0 ? 'is-pos' : 'is-neg') : '') + '">' + (isProfitNum ? fmtMoney(profit) : '—') + '</td>' +
      '<td class="sim-td-num ' + (isPctNum ? (profitPct >= 0 ? 'is-pos' : 'is-neg') : '') + '">' + (isPctNum ? fmtPct(profitPct, 2) : '—') + '</td>';
    return tr;
  }

  function renderTrades() {
    const ui = getUIElements();
    if (!ui.tradesBody) return;
    const filtered = getFilteredTrades();
    const totalPages = Math.max(1, Math.ceil(filtered.length / state.pageSize));
    if (state.page >= totalPages) state.page = totalPages - 1;
    const start = state.page * state.pageSize;
    const pageItems = filtered.slice(start, start + state.pageSize);

    ui.tradesBody.innerHTML = '';
    const result = state.lastResult || currentSimulationState.results;
    if (pageItems.length === 0) {
      const tr = document.createElement('tr');
      tr.className = 'empty';
      const td = document.createElement('td');
      td.colSpan = 9;
      td.textContent = result && (result.trades || []).length > 0
        ? 'Nenhum trade corresponde à pesquisa.'
        : 'Nenhum trade no resultado da simulação.';
      tr.appendChild(td);
      ui.tradesBody.appendChild(tr);
    } else {
      for (const t of pageItems) ui.tradesBody.appendChild(buildTradeRow(t));
    }

    updateSortIndicators();
    updatePagination(filtered.length, totalPages);
  }

  function updatePagination(total, totalPages) {
    const ui = getUIElements();
    if (ui.pageInfo) {
      const from = total === 0 ? 0 : state.page * state.pageSize + 1;
      const to = Math.min(total, (state.page + 1) * state.pageSize);
      ui.pageInfo.textContent = from + '–' + to + ' de ' + total.toLocaleString('pt-PT');
    }
    if (ui.pagePrev) ui.pagePrev.disabled = state.page <= 0 || total === 0;
    if (ui.pageNext) ui.pageNext.disabled = state.page >= totalPages - 1 || total === 0;
  }

  function onSortClick(th) {
    if (!th || !th.dataset) return;
    const key = th.dataset.sort;
    if (state.sortKey === key) {
      state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
    } else {
      state.sortKey = key;
      state.sortDir = 'asc';
    }
    state.page = 0;
    renderTrades();
  }

  function updateSortIndicators() {
    const ths = document.querySelectorAll('#sim-trades-table thead th[data-sort]');
    ths.forEach((th) => {
      if (!th) return;
      th.classList.toggle('sort-active', th.dataset.sort === state.sortKey);
      const arrow = th.querySelector('.sim-sort-arrow');
      if (arrow) arrow.textContent = th.dataset.sort === state.sortKey ? (state.sortDir === 'asc' ? ' ▲' : ' ▼') : '';
    });
  }

  // ── Limpeza em recarregamento / fecho ──
  function teardown() {
    for (const un of state.unsubscribers.splice(0)) {
      try { un(); } catch (_) { /* janela a fechar */ }
    }
    state.currentRunId = null;
  }

  window.addEventListener('beforeunload', teardown, { once: true });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
