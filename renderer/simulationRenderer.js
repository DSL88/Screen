(function () {
  'use strict';

  // ═══════════════════════════════════════════════════════════
  //  SIMULAÇÃO DE ESTRATÉGIAS — Renderer da aba de Backtesting
  //  Contrato window.api (implementado no processo main):
  //    api.simulationOptions()            → { ok, indices, assets }
  //    api.simulationStart(payload)       → { ok, runId } | { ok:false, error }
  //    api.simulationCancel(runId)        → { ok }
  //    api.onSimulationProgress(cb)       → unsubscribe
  //    api.onSimulationResult(cb)         → unsubscribe
  //    api.onSimulationError(cb)          → unsubscribe
  // ═══════════════════════════════════════════════════════════

  const $ = (id) => document.getElementById(id);

  const els = {
    subtitle: $('sim-subtitle'),
    universe: $('sim-universe'),
    index: $('sim-index'),
    asset: $('sim-asset'),
    indexField: $('sim-index-field'),
    assetField: $('sim-asset-field'),
    direction: $('sim-direction'),
    exitMode: $('sim-exit-mode'),
    stopType: $('sim-stop-type'),
    stopLoss: $('sim-stop-loss'),
    takeProfit: $('sim-take-profit'),
    trailing: $('sim-trailing'),
    trailingOffset: $('sim-trailing-offset'),
    vwapGate: $('sim-vwap-gate'),
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
    progressFill: $('sim-progress-fill'),
    progressText: $('sim-progress-text'),
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

  const state = {
    currentRunId: null,
    lastResult: null,
    sortKey: 'exitDate',
    sortDir: 'desc',
    page: 0,
    pageSize: 50,
    searchQuery: '',
    running: false,
    unsubscribers: []
  };

  const REASON_LABELS = { TP: 'Take Profit', SL: 'Stop Loss', Trailing: 'Trailing', Sinal: 'Sinal' };

  function init() {
    if (!els.universe) return;
    setDefaultDates();
    loadOptions();
    bindListeners();
    bindApiEvents();
  }

  // ── Datas por defeito ──
  function pad(n) { return String(n).padStart(2, '0'); }
  function toInputDate(d) {
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  function setDefaultDates() {
    const today = new Date();
    const start = new Date(today.getFullYear() - 6, today.getMonth(), today.getDate());
    if (els.startDate && !els.startDate.value) els.startDate.value = toInputDate(start);
    if (els.endDate && !els.endDate.value) els.endDate.value = toInputDate(today);
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
    if (!window.api || typeof window.api.simulationOptions !== 'function') return;
    try {
      const res = await window.api.simulationOptions();
      if (!res || !res.ok) return;
      fillSelect(els.index, res.indices, (i) => ({ value: i.id, label: i.name }));
      fillSelect(els.asset, res.assets, (a) => ({
        value: a.ticker,
        label: a.ticker + (a.name ? ' — ' + a.name : '') + (a.indexName ? ' [' + a.indexName + ']' : '')
      }));
    } catch (err) {
      console.warn('[sim] simulationOptions falhou:', err);
    }
  }

  // ── Visibilidade do universo ──
  function updateUniverseVisibility() {
    const mode = els.universe ? els.universe.value : 'all';
    if (els.indexField) els.indexField.hidden = mode !== 'index';
    if (els.assetField) els.assetField.hidden = mode !== 'single';
  }

  // ── Listeners de UI ──
  function bindListeners() {
    if (els.universe) els.universe.addEventListener('change', updateUniverseVisibility);
    if (els.btnStart) els.btnStart.addEventListener('click', startSimulation);
    if (els.btnCancel) els.btnCancel.addEventListener('click', cancelSimulation);

    if (els.tradesSearch) {
      els.tradesSearch.addEventListener('input', (e) => {
        state.searchQuery = String(e.target.value || '').trim().toLowerCase();
        state.page = 0;
        renderTrades();
      });
    }
    if (els.pagePrev) {
      els.pagePrev.addEventListener('click', () => {
        if (state.page > 0) { state.page--; renderTrades(); }
      });
    }
    if (els.pageNext) {
      els.pageNext.addEventListener('click', () => {
        state.page++;
        renderTrades();
      });
    }

    const sortableThs = document.querySelectorAll('#sim-trades-table thead th[data-sort]');
    sortableThs.forEach((th) => th.addEventListener('click', () => onSortClick(th)));
  }

  // ── Eventos do main process (progress / result / error) ──
  function bindApiEvents() {
    if (!window.api) return;
    const api = window.api;
    if (typeof api.onSimulationProgress === 'function') {
      const un = api.onSimulationProgress(onProgress);
      if (typeof un === 'function') state.unsubscribers.push(un);
    }
    if (typeof api.onSimulationResult === 'function') {
      const un = api.onSimulationResult(onResult);
      if (typeof un === 'function') state.unsubscribers.push(un);
    }
    if (typeof api.onSimulationError === 'function') {
      const un = api.onSimulationError(onError);
      if (typeof un === 'function') state.unsubscribers.push(un);
    }
  }

  function isCurrentRun(data) {
    if (!state.currentRunId) return true;
    return !data || !data.runId || data.runId === state.currentRunId;
  }

  function onProgress(data) {
    if (!data || !isCurrentRun(data)) return;
    const pct = Math.min(100, Math.max(0, Number(data.percent) || 0));
    if (els.progressFill) els.progressFill.style.width = pct + '%';
    if (els.progressText) {
      const parts = [];
      if (data.ticker) parts.push(data.ticker);
      if (data.message) parts.push(data.message);
      els.progressText.textContent = Math.round(pct) + '%' + (parts.length ? ' · ' + parts.join(' · ') : '');
    }
  }

  function onResult(data) {
    if (!data || !isCurrentRun(data)) return;
    const result = data.result || null;
    state.currentRunId = null;
    resetControls();
    if (els.progressFill) els.progressFill.style.width = '0%';
    if (els.progressText) els.progressText.textContent = '0%';
    if (!result) {
      setStatus('A simulação terminou sem dados de resultado.');
      return;
    }
    state.lastResult = result;
    state.page = 0;
    state.sortKey = 'exitDate';
    state.sortDir = 'desc';
    state.searchQuery = els.tradesSearch ? String(els.tradesSearch.value || '').trim().toLowerCase() : '';
    renderResult(result);
  }

  function onError(data) {
    if (!data || !isCurrentRun(data)) return;
    state.currentRunId = null;
    resetControls();
    setStatus('Erro na simulação: ' + ((data && data.message) || 'erro desconhecido.'));
  }

  // ── Controlo de estado "a correr" ──
  function setStartLabel(text) {
    if (!els.btnStart) return;
    const label = els.btnStart.querySelector('.btn-label');
    if (label) label.textContent = text;
  }

  function resetControls() {
    state.running = false;
    if (els.btnStart) els.btnStart.disabled = false;
    setStartLabel('Iniciar Simulação');
    if (els.btnCancel) { els.btnCancel.hidden = true; els.btnCancel.disabled = false; }
    if (els.progressWrap) els.progressWrap.hidden = true;
  }

  function setRunningUi() {
    state.running = true;
    if (els.btnStart) els.btnStart.disabled = true;
    setStartLabel('A simular...');
    if (els.btnCancel) { els.btnCancel.hidden = false; els.btnCancel.disabled = false; }
    if (els.progressWrap) els.progressWrap.hidden = false;
    if (els.progressFill) els.progressFill.style.width = '0%';
    if (els.progressText) els.progressText.textContent = '0%';
  }

  function setStatus(msg) {
    if (!els.status) return;
    els.status.textContent = msg || '';
    els.status.hidden = !msg;
  }

  // ── Iniciar / cancelar ──
  function toNum(input, fallback) {
    if (!input) return fallback;
    const n = Number(input.value);
    return isNaN(n) ? fallback : n;
  }

  function buildPayload() {
    const universeMode = els.universe ? els.universe.value : 'all';
    const universe = { mode: universeMode };
    if (universeMode === 'index') universe.index = els.index ? els.index.value : '';
    if (universeMode === 'single') universe.ticker = els.asset ? els.asset.value : '';
    if (universeMode !== 'all' && !universe.index && !universe.ticker) {
      setStatus('Seleciona um índice ou ativo antes de iniciar a simulação.');
      return null;
    }

    const params = {
      direction: els.direction ? els.direction.value : 'both',
      exitMode: els.exitMode ? els.exitMode.value : 'full',
      stopType: els.stopType ? els.stopType.value : 'pct',
      stopLoss: toNum(els.stopLoss, 1.4),
      takeProfit: toNum(els.takeProfit, 2.8),
      trailing: !!(els.trailing && els.trailing.checked),
      trailingOffset: toNum(els.trailingOffset, 1.0),
      vwapGate: !!(els.vwapGate && els.vwapGate.checked),
      mcMin: toNum(els.mcMin, 50),
      markovMin: toNum(els.markovMin, 55),
      startDate: els.startDate ? els.startDate.value : '',
      endDate: els.endDate ? els.endDate.value : '',
      capital: toNum(els.capital, 10000),
      risk: toNum(els.risk, 2),
      commission: toNum(els.commission, 0.05),
      slippage: toNum(els.slippage, 0.05)
    };
    return { universe, params };
  }

  function startSimulation() {
    if (state.running) return;
    if (!window.api || typeof window.api.simulationStart !== 'function') {
      setStatus('API de simulação indisponível neste contexto.');
      return;
    }
    const payload = buildPayload();
    if (!payload) return;

    setRunningUi();
    setStatus('');
    if (els.results) els.results.hidden = true;

    window.api.simulationStart(payload)
      .then((res) => {
        if (res && res.ok && res.runId) {
          state.currentRunId = res.runId;
        } else {
          state.currentRunId = null;
          resetControls();
          setStatus((res && res.error) || 'Falha ao iniciar a simulação.');
        }
      })
      .catch((err) => {
        state.currentRunId = null;
        resetControls();
        setStatus('Erro ao iniciar a simulação: ' + (err && err.message ? err.message : String(err)));
      });
  }

  function cancelSimulation() {
    if (!state.currentRunId) return;
    if (window.api && typeof window.api.simulationCancel === 'function') {
      try { window.api.simulationCancel(state.currentRunId); } catch (_) { /* ignora */ }
    }
  }

  // ── Resultado ──
  function renderResult(result) {
    const msgs = (result.messages || []).filter(Boolean);
    if (result.cancelled) msgs.unshift('Simulação cancelada.');
    setStatus(msgs.join(' · '));

    renderKpis(result.kpis || {});
    drawChart(result.equityCurve || [], result.benchmark || [], result.drawdownSeries || []);
    renderTrades();
    if (els.results) els.results.hidden = false;
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
    const kpis = els.kpis;
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
  function fmtAxisDate(d, spanDays) {
    if (spanDays > 800) {
      return d.toLocaleDateString('pt-PT', { month: '2-digit', year: '2-digit' });
    }
    return d.toLocaleDateString('pt-PT', { day: '2-digit', month: '2-digit' });
  }

  function drawChart(equity, benchmark, drawdown) {
    const canvas = els.canvas;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const cssWidth = canvas.clientWidth || 900;
    const cssHeight = 300;
    canvas.width = Math.round(cssWidth * dpr);
    canvas.height = Math.round(cssHeight * dpr);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const W = cssWidth;
    const H = cssHeight;
    const padL = 74, padR = 18, padT = 26, padB = 34;
    const bandH = 56;
    const plotX0 = padL, plotX1 = W - padR;
    const plotY0 = padT, plotY1 = H - padB - bandH;
    const bandY0 = plotY1 + 12, bandY1 = H - padB;

    const all = (equity || []).concat(benchmark || []);
    let minV = Infinity, maxV = -Infinity;
    for (const p of all) {
      const v = Number(p.value);
      if (!isNaN(v)) {
        if (v < minV) minV = v;
        if (v > maxV) maxV = v;
      }
    }
    if (!isFinite(minV) || !isFinite(maxV)) {
      ctx.clearRect(0, 0, W, H);
      ctx.fillStyle = 'rgba(255,255,255,0.45)';
      ctx.font = '12px Inter, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('Sem dados de curva de capital', W / 2, H / 2);
      return;
    }
    if (minV === maxV) { minV -= 1; maxV += 1; }
    const range = maxV - minV;
    const paddedMin = minV - range * 0.08;
    const paddedMax = maxV + range * 0.08;

    const timePoints = [];
    for (const p of all) if (p.date) timePoints.push(new Date(p.date).getTime());
    let tMin = Infinity, tMax = -Infinity;
    for (const t of timePoints) {
      if (isNaN(t)) continue;
      if (t < tMin) tMin = t;
      if (t > tMax) tMax = t;
    }
    if (!isFinite(tMin) || !isFinite(tMax)) { tMin = Date.now() - 86400000; tMax = Date.now(); }
    if (tMin === tMax) { tMin -= 86400000; tMax += 86400000; }

    const xOf = (date) => {
      const t = new Date(date).getTime();
      if (isNaN(t)) return plotX0;
      return plotX0 + (t - tMin) / (tMax - tMin) * (plotX1 - plotX0);
    };
    const yOf = (v) => plotY1 - (v - paddedMin) / (paddedMax - paddedMin) * (plotY1 - plotY0);

    ctx.clearRect(0, 0, W, H);

    // ── Grid horizontal + labels Y ──
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.lineWidth = 1;
    ctx.font = '10px JetBrains Mono, monospace';
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    const steps = 5;
    for (let i = 0; i <= steps; i++) {
      const v = paddedMax - (paddedMax - paddedMin) * i / steps;
      const y = plotY0 + (plotY1 - plotY0) * i / steps;
      ctx.beginPath();
      ctx.moveTo(plotX0, y);
      ctx.lineTo(plotX1, y);
      ctx.stroke();
      ctx.fillText(shortMoney(v), plotX0 - 8, y);
    }

    // ── Labels X (datas) ──
    const spanDays = (tMax - tMin) / 86400000;
    const xSteps = Math.min(6, Math.max(2, Math.floor((plotX1 - plotX0) / 90)));
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (let i = 0; i <= xSteps; i++) {
      const t = tMin + (tMax - tMin) * i / xSteps;
      const x = plotX0 + (plotX1 - plotX0) * i / xSteps;
      ctx.fillText(fmtAxisDate(new Date(t), spanDays), x, plotY1 + 8);
    }

    // ── Série ──
    const drawSeries = (series, color, width) => {
      if (!series || series.length < 2) return;
      ctx.beginPath();
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      let started = false;
      for (const p of series) {
        const v = Number(p.value);
        if (isNaN(v)) continue;
        const x = xOf(p.date);
        const y = yOf(v);
        if (!started) { ctx.moveTo(x, y); started = true; }
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    };
    drawSeries(benchmark, 'rgba(245, 158, 11, 0.75)', 1.4);
    drawSeries(equity, '#6366f1', 2);

    // ── Área de drawdown (banda inferior) ──
    if (drawdown && drawdown.length > 0) {
      let ddMin = Infinity, ddMax = -Infinity;
      for (const p of drawdown) {
        const v = Number(p.value);
        if (!isNaN(v)) {
          if (v < ddMin) ddMin = v;
          if (v > ddMax) ddMax = v;
        }
      }
      if (isFinite(ddMin) && isFinite(ddMax)) {
        if (ddMin === ddMax) { ddMin -= 1; ddMax += 1; }
        ctx.beginPath();
        const first = drawdown[0];
        ctx.moveTo(xOf(first.date), bandY1);
        let lastPoint = first;
        for (const p of drawdown) {
          const v = Number(p.value);
          if (isNaN(v)) continue;
          const norm = (v - ddMin) / (ddMax - ddMin);
          const x = xOf(p.date);
          const y = bandY1 - norm * (bandY1 - bandY0);
          ctx.lineTo(x, y);
          lastPoint = p;
        }
        ctx.lineTo(xOf(lastPoint.date), bandY1);
        ctx.closePath();
        const grad = ctx.createLinearGradient(0, bandY0, 0, bandY1);
        grad.addColorStop(0, 'rgba(251, 113, 133, 0.55)');
        grad.addColorStop(1, 'rgba(251, 113, 133, 0.05)');
        ctx.fillStyle = grad;
        ctx.fill();
        ctx.strokeStyle = 'rgba(251, 113, 133, 0.8)';
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.fillStyle = 'rgba(251, 113, 133, 0.85)';
        ctx.font = '9px JetBrains Mono, monospace';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'bottom';
        ctx.fillText('Drawdown', plotX1 - 2, bandY0 - 2);
      }
    }

    // ── Legenda ──
    ctx.font = '10px Inter, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const legendY = plotY0;
    ctx.fillStyle = '#6366f1';
    ctx.fillRect(plotX0, legendY - 2, 12, 3);
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.fillText('Curva de Capital', plotX0 + 16, legendY);
    ctx.fillStyle = '#f59e0b';
    ctx.fillRect(plotX0 + 132, legendY - 2, 12, 3);
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.fillText('Benchmark', plotX0 + 148, legendY);
    if (drawdown && drawdown.length > 0) {
      ctx.fillStyle = '#fb7185';
      ctx.fillRect(plotX0 + 224, legendY - 2, 12, 3);
      ctx.fillStyle = 'rgba(255,255,255,0.75)';
      ctx.fillText('Drawdown', plotX0 + 240, legendY);
    }
  }

  // ── Tabela de trades ──
  function getFilteredTrades() {
    const trades = (state.lastResult && state.lastResult.trades) || [];
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
        return String(va).localeCompare(String(vb)) * dir;
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
    if (!els.tradesBody) return;
    const filtered = getFilteredTrades();
    const totalPages = Math.max(1, Math.ceil(filtered.length / state.pageSize));
    if (state.page >= totalPages) state.page = totalPages - 1;
    const start = state.page * state.pageSize;
    const pageItems = filtered.slice(start, start + state.pageSize);

    els.tradesBody.innerHTML = '';
    if (pageItems.length === 0) {
      const tr = document.createElement('tr');
      tr.className = 'empty';
      const td = document.createElement('td');
      td.colSpan = 9;
      td.textContent = state.lastResult && (state.lastResult.trades || []).length > 0
        ? 'Nenhum trade corresponde à pesquisa.'
        : 'Nenhum trade no resultado da simulação.';
      tr.appendChild(td);
      els.tradesBody.appendChild(tr);
    } else {
      for (const t of pageItems) els.tradesBody.appendChild(buildTradeRow(t));
    }

    updateSortIndicators();
    updatePagination(filtered.length, totalPages);
  }

  function updatePagination(total, totalPages) {
    if (els.pageInfo) {
      const from = total === 0 ? 0 : state.page * state.pageSize + 1;
      const to = Math.min(total, (state.page + 1) * state.pageSize);
      els.pageInfo.textContent = from + '–' + to + ' de ' + total.toLocaleString('pt-PT');
    }
    if (els.pagePrev) els.pagePrev.disabled = state.page <= 0 || total === 0;
    if (els.pageNext) els.pageNext.disabled = state.page >= totalPages - 1 || total === 0;
  }

  function onSortClick(th) {
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
