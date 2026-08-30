/**
 * AlphaQuant Tracker & Performance (Audit Trail / Walk-Forward Tracking Log)
 * Gestão e renderização do histórico de sugestões, KPIs globais e matriz de validação de patamares.
 */

(function () {
  'use strict';

  let cachedDashboardData = null;
  let activeDateFilter = 'all';
  let activeStatusFilter = 'all';
  let activeSearchQuery = '';

  // ═══════════════════════════════════════════════════════════
  //  ELEMENTOS DOM
  // ═══════════════════════════════════════════════════════════
  let btnRefreshTracker;
  let btnUpdateTrackerPrices;
  let lblUpdateTracker;
  let spinnerUpdateTracker;
  let selectFilterDate;
  let selectFilterStatus;
  let inputSearchTicker;
  let btnClearSearch;
  let tbodyTracker;
  let tbodyMatrix;
  let badgeRowsCount;

  // KPI elements
  let elKpiHitRate;
  let elKpiHitMeta;
  let elKpiHitBar;
  let elKpiProfitFactor;
  let elKpiAvgReturn;
  let elKpiAvgDays;
  let elKpiTotalMonitored;

  function cacheDomElements() {
    btnRefreshTracker = document.getElementById('btn-refresh-tracker');
    btnUpdateTrackerPrices = document.getElementById('btn-update-tracker-prices');
    lblUpdateTracker = document.getElementById('lbl-update-tracker');
    spinnerUpdateTracker = document.getElementById('spinner-update-tracker');
    selectFilterDate = document.getElementById('tracker-filter-date');
    selectFilterStatus = document.getElementById('tracker-filter-status');
    inputSearchTicker = document.getElementById('tracker-search-ticker');
    btnClearSearch = document.getElementById('btn-tracker-clear-search');
    tbodyTracker = document.getElementById('tracker-table-body');
    tbodyMatrix = document.getElementById('tracker-matrix-body');
    badgeRowsCount = document.getElementById('tracker-rows-count');

    elKpiHitRate = document.getElementById('tracker-kpi-hit-rate');
    elKpiHitMeta = document.getElementById('tracker-kpi-hit-meta');
    elKpiHitBar = document.getElementById('tracker-kpi-hit-bar');
    elKpiProfitFactor = document.getElementById('tracker-kpi-profit-factor');
    elKpiAvgReturn = document.getElementById('tracker-kpi-avg-return');
    elKpiAvgDays = document.getElementById('tracker-kpi-avg-days');
    elKpiTotalMonitored = document.getElementById('tracker-kpi-total-monitored');
  }

  // ═══════════════════════════════════════════════════════════
  //  OBTENÇÃO DE DADOS VIA IPC BRIDGE
  // ═══════════════════════════════════════════════════════════
  async function fetchTrackerDashboardData() {
    try {
      let res;
      if (window.quantAPI && typeof window.quantAPI.getTrackerDashboard === 'function') {
        res = await window.quantAPI.getTrackerDashboard({});
      } else if (window.api && typeof window.api.getTrackerDashboard === 'function') {
        res = await window.api.getTrackerDashboard({});
      } else if (window.electronAPI && typeof window.electronAPI.getTrackerDashboard === 'function') {
        res = await window.electronAPI.getTrackerDashboard({});
      }

      if (res && res.data) {
        return res.data;
      } else if (res && res.kpis) {
        return res;
      }
      return null;
    } catch (err) {
      console.error('[QuantTracker] Erro ao carregar dashboard de rastreio:', err);
      return null;
    }
  }

  async function loadTrackerDashboard() {
    cacheDomElements();
    if (tbodyTracker) {
      tbodyTracker.innerHTML = `
        <tr>
          <td colspan="11" class="text-center text-muted py-4">
            <span class="spinner-border spinner-border-sm me-2"></span> A carregar histórico de recomendações...
          </td>
        </tr>`;
    }

    const data = await fetchTrackerDashboardData();
    if (!data) {
      if (tbodyTracker) {
        tbodyTracker.innerHTML = `
          <tr>
            <td colspan="11" class="text-center text-warning py-4">
              Nenhum registo de rastreio encontrado ou erro de comunicação com o banco SQLite.
            </td>
          </tr>`;
      }
      return;
    }

    cachedDashboardData = data;
    renderKPIs(data.kpis);
    renderCohortOptions(data.cohort_dates);
    renderTierMatrix(data.tier_matrix);
    applyFiltersAndRenderTable();
  }

  // ═══════════════════════════════════════════════════════════
  //  RENDERIZAÇÃO DE KPIS
  // ═══════════════════════════════════════════════════════════
  function renderKPIs(kpis) {
    if (!kpis) return;

    if (elKpiHitRate) {
      elKpiHitRate.textContent = `${kpis.hit_rate}%`;
      elKpiHitRate.className = kpis.hit_rate >= 60 ? 'tracker-kpi-value text-success' : kpis.hit_rate >= 50 ? 'tracker-kpi-value text-warning' : 'tracker-kpi-value text-danger';
    }
    if (elKpiHitMeta) {
      elKpiHitMeta.textContent = `${kpis.target_hits} Targets / ${kpis.resolved_trades} Encerrados (${kpis.active_pending} Pendentes)`;
    }
    if (elKpiHitBar) {
      elKpiHitBar.style.width = `${Math.min(100, Math.max(0, kpis.hit_rate))}%`;
      elKpiHitBar.className = kpis.hit_rate >= 60 ? 'tracker-kpi-fill bg-success' : kpis.hit_rate >= 50 ? 'tracker-kpi-fill bg-warning' : 'tracker-kpi-fill bg-danger';
    }

    if (elKpiProfitFactor) {
      elKpiProfitFactor.textContent = kpis.profit_factor >= 99 ? '∞' : `${kpis.profit_factor}x`;
      elKpiProfitFactor.className = kpis.profit_factor >= 1.5 ? 'tracker-kpi-value text-primary' : kpis.profit_factor >= 1.0 ? 'tracker-kpi-value text-info' : 'tracker-kpi-value text-danger';
    }

    if (elKpiAvgReturn) {
      const sign = kpis.avg_return_pct > 0 ? '+' : '';
      elKpiAvgReturn.textContent = `${sign}${kpis.avg_return_pct}%`;
      elKpiAvgReturn.className = kpis.avg_return_pct >= 0 ? 'tracker-kpi-value text-success' : 'tracker-kpi-value text-danger';
    }

    if (elKpiAvgDays) {
      elKpiAvgDays.textContent = `${kpis.avg_days_to_target} d`;
    }
    if (elKpiTotalMonitored) {
      elKpiTotalMonitored.textContent = `Total: ${kpis.total_recommendations} ativos registados`;
    }
  }

  // ═══════════════════════════════════════════════════════════
  //  OPÇÕES DE COORTE / DATAS
  // ═══════════════════════════════════════════════════════════
  function renderCohortOptions(cohortDates) {
    if (!selectFilterDate) return;
    const currentVal = selectFilterDate.value;

    let optionsHtml = `
      <option value="all">Todas as Datas</option>
      <option value="today">Hoje</option>
      <option value="7d">Últimos 7 Dias</option>
      <option value="30d">Últimos 30 Dias</option>
    `;

    if (cohortDates && cohortDates.length > 0) {
      optionsHtml += `<optgroup label="Coortes Específicas">`;
      cohortDates.forEach((d) => {
        optionsHtml += `<option value="date_${d}">${d}</option>`;
      });
      optionsHtml += `</optgroup>`;
    }

    selectFilterDate.innerHTML = optionsHtml;
    if (currentVal) {
      selectFilterDate.value = currentVal;
    }
  }

  // ═══════════════════════════════════════════════════════════
  //  MATRIZ DE VALIDAÇÃO DE PATAMARES (TIER MATRIX)
  // ═══════════════════════════════════════════════════════════
  function renderTierMatrix(tierMatrix) {
    if (!tbodyMatrix) return;
    tbodyMatrix.innerHTML = '';

    if (!tierMatrix || tierMatrix.length === 0) {
      tbodyMatrix.innerHTML = `
        <tr>
          <td colspan="7" class="text-center text-muted py-4">Sem dados de patamares para apresentar.</td>
        </tr>`;
      return;
    }

    tierMatrix.forEach((t) => {
      let diagClass = 'text-secondary';
      if (t.status_calibration === 'Calibrado com Sucesso') {
        diagClass = 'text-success fw-bold';
      } else if (t.status_calibration === 'Alerta de Subdesempenho') {
        diagClass = 'text-danger fw-bold';
      } else if (t.status_calibration === 'Amostragem em Curso') {
        diagClass = 'text-info';
      }

      const retSign = t.avg_return > 0 ? '+' : '';
      const retClass = t.avg_return >= 0 ? 'text-success' : 'text-danger';

      const row = `
        <tr>
          <td><strong>${t.tier_label}</strong></td>
          <td class="num-col">${t.suggestions_count}</td>
          <td class="num-col text-success">${t.targets_hit}</td>
          <td class="num-col text-danger">${t.stops_hit}</td>
          <td class="num-col ${t.hit_rate_real >= 60 ? 'text-success' : 'text-warning'}">
            ${t.hit_rate_real}%
          </td>
          <td class="num-col ${retClass}">
            ${retSign}${t.avg_return}%
          </td>
          <td>
            <span class="${diagClass}">
              ${t.status_calibration}
            </span>
          </td>
        </tr>
      `;
      tbodyMatrix.innerHTML += row;
    });
  }

  // ═══════════════════════════════════════════════════════════
  //  FILTRAGEM E TABELA DE AUDITORIA
  // ═══════════════════════════════════════════════════════════
  function applyFiltersAndRenderTable() {
    if (!cachedDashboardData || !tbodyTracker) return;

    let items = cachedDashboardData.items || [];
    const now = new Date();

    // Filtro por Data
    if (activeDateFilter === 'today') {
      const todayStr = now.toISOString().split('T')[0];
      items = items.filter((it) => it.recommendation_date === todayStr);
    } else if (activeDateFilter === '7d') {
      const cutoff = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      items = items.filter((it) => new Date(it.recommendation_date) >= cutoff);
    } else if (activeDateFilter === '30d') {
      const cutoff = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      items = items.filter((it) => new Date(it.recommendation_date) >= cutoff);
    } else if (activeDateFilter.startsWith('date_')) {
      const targetDate = activeDateFilter.replace('date_', '');
      items = items.filter((it) => it.recommendation_date === targetDate);
    }

    // Filtro por Estado
    if (activeStatusFilter !== 'all') {
      items = items.filter((it) => it.status === activeStatusFilter);
    }

    // Filtro por Pesquisa Ticker
    if (activeSearchQuery) {
      const q = activeSearchQuery.toUpperCase().trim();
      items = items.filter((it) => (it.ticker && it.ticker.toUpperCase().includes(q)) || (it.sector && it.sector.toUpperCase().includes(q)));
    }

    if (badgeRowsCount) {
      badgeRowsCount.textContent = `${items.length} registos`;
    }

    tbodyTracker.innerHTML = '';

    if (items.length === 0) {
      tbodyTracker.innerHTML = `
        <tr>
          <td colspan="10" class="text-center text-muted py-4">
            Nenhuma recomendação corresponde aos filtros selecionados.
          </td>
        </tr>`;
      return;
    }

    items.forEach((rec) => {
      // Estado badge (Pills limpas)
      let statusHtml = '';
      if (rec.status === 'TARGET_ATINGIDO') {
        statusHtml = `<span class="status-pill target">🟢 TARGET ATINGIDO</span>`;
      } else if (rec.status === 'STOP_LOSS_ATINGIDO') {
        statusHtml = `<span class="status-pill stop">🔴 STOP ATINGIDO</span>`;
      } else if (rec.status === 'EXPIRADO') {
        statusHtml = `<span class="status-pill expired">⚪ EXPIRADO</span>`;
      } else {
        statusHtml = `<span class="status-pill pending">🟡 PENDENTE</span>`;
      }

      // PnL
      const pnlVal = rec.realized_pnl_pct || 0.0;
      const pnlSign = pnlVal > 0 ? '+' : '';
      const pnlClass = pnlVal >= 0 ? 'text-success fw-bold' : 'text-danger fw-bold';

      // Tier badge
      let badgeClass = 'bg-primary';
      if (rec.mc_win_rate >= 70.0) badgeClass = 'bg-primary';
      else if (rec.mc_win_rate >= 65.0) badgeClass = 'bg-info text-dark';
      else if (rec.mc_win_rate >= 60.0) badgeClass = 'bg-success';
      else if (rec.mc_win_rate >= 55.0) badgeClass = 'bg-teal';
      else if (rec.mc_win_rate >= 50.0) badgeClass = 'bg-warning text-dark';
      else badgeClass = 'bg-danger';

      const row = `
        <tr>
          <td class="text-secondary" style="font-family: var(--mono); font-size: 12px;">${rec.recommendation_date}</td>
          <td><strong class="text-white" style="font-size: 1rem;">${rec.ticker}</strong></td>
          <td><span class="text-secondary small">${rec.sector}</span></td>
          <td class="num-col">${rec.entry_price} €</td>
          <td class="num-col" style="font-weight: 700; color: #fff;">${rec.current_price || rec.exit_price || rec.entry_price} €</td>
          <td class="num-col text-success">${rec.target_price} €</td>
          <td class="num-col text-danger">${rec.stop_loss_price || rec.stop_loss} €</td>
          <td>
            <span class="badge ${badgeClass}" style="font-size: 0.8rem; font-weight: 600; padding: 4px 8px;">
              ${rec.mc_win_rate}% (${rec.mc_tier_label})
            </span>
          </td>
          <td class="num-col ${pnlClass}">
            ${pnlSign}${pnlVal}%
          </td>
          <td>${statusHtml}</td>
        </tr>
      `;
      tbodyTracker.innerHTML += row;
    });
  }

  // ═══════════════════════════════════════════════════════════
  //  ATUALIZAÇÃO DE COTAÇÕES VIA YAHOO FINANCE
  // ═══════════════════════════════════════════════════════════
  async function handleUpdateTrackerPrices() {
    if (!btnUpdateTrackerPrices) return;
    btnUpdateTrackerPrices.disabled = true;
    if (spinnerUpdateTracker) spinnerUpdateTracker.hidden = false;
    if (lblUpdateTracker) lblUpdateTracker.textContent = 'A consultar Yahoo Finance...';

    try {
      let res;
      if (window.quantAPI && typeof window.quantAPI.evaluateTrackedAssets === 'function') {
        res = await window.quantAPI.evaluateTrackedAssets({});
      } else if (window.api && typeof window.api.evaluateTrackedAssets === 'function') {
        res = await window.api.evaluateTrackedAssets({});
      }

      await loadTrackerDashboard();

      if (lblUpdateTracker) lblUpdateTracker.textContent = '✓ Cotações Atualizadas';
      setTimeout(() => {
        if (lblUpdateTracker) lblUpdateTracker.textContent = 'Atualizar Cotações & Avaliar Saídas';
        btnUpdateTrackerPrices.disabled = false;
        if (spinnerUpdateTracker) spinnerUpdateTracker.hidden = true;
      }, 2000);
    } catch (err) {
      console.error('[QuantTracker] Erro ao atualizar cotações:', err);
      if (lblUpdateTracker) lblUpdateTracker.textContent = '❌ Erro ao Atualizar';
      btnUpdateTrackerPrices.disabled = false;
      if (spinnerUpdateTracker) spinnerUpdateTracker.hidden = true;
    }
  }

  // ═══════════════════════════════════════════════════════════
  //  INICIALIZAÇÃO & EVENT LISTENERS
  // ═══════════════════════════════════════════════════════════
  function setupEventListeners() {
    cacheDomElements();

    if (btnRefreshTracker) {
      btnRefreshTracker.addEventListener('click', loadTrackerDashboard);
    }

    if (btnUpdateTrackerPrices) {
      btnUpdateTrackerPrices.addEventListener('click', handleUpdateTrackerPrices);
    }

    if (selectFilterDate) {
      selectFilterDate.addEventListener('change', (e) => {
        activeDateFilter = e.target.value;
        applyFiltersAndRenderTable();
      });
    }

    if (selectFilterStatus) {
      selectFilterStatus.addEventListener('change', (e) => {
        activeStatusFilter = e.target.value;
        applyFiltersAndRenderTable();
      });
    }

    if (inputSearchTicker) {
      inputSearchTicker.addEventListener('input', (e) => {
        activeSearchQuery = e.target.value;
        applyFiltersAndRenderTable();
      });
    }

    if (btnClearSearch) {
      btnClearSearch.addEventListener('click', () => {
        if (inputSearchTicker) inputSearchTicker.value = '';
        activeSearchQuery = '';
        applyFiltersAndRenderTable();
      });
    }

    // Carregamento automático quando o utilizador clica na aba 'AlphaQuant Tracker & Performance'
    const tabTrackerBtn = document.querySelector('.tab-btn[data-tab="quant-tracker"]');
    if (tabTrackerBtn) {
      tabTrackerBtn.addEventListener('click', () => {
        loadTrackerDashboard();
      });
    }
  }

  function init() {
    setupEventListeners();
  }

  window.quantTracker = {
    init,
    loadTrackerDashboard,
    handleUpdateTrackerPrices
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
