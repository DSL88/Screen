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

  function escapeHtml(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

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

  // Controlo de Duplicados e Seleção
  let chkFilterDuplicates;
  let btnDeleteDuplicates;
  let countDuplicatesBadge;
  let chkSelectAllTracker;
  let btnDeleteSelected;
  let btnClearAllTracker;
  let countSelectedBadge;
  let btnCountSelected;

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

    chkFilterDuplicates = document.getElementById('chk-filter-duplicates');
    btnDeleteDuplicates = document.getElementById('btn-delete-duplicates');
    countDuplicatesBadge = document.getElementById('count-duplicates-badge');
    chkSelectAllTracker = document.getElementById('chk-select-all-tracker');
    btnDeleteSelected = document.getElementById('btn-delete-selected');
    btnClearAllTracker = document.getElementById('btn-clear-all-tracker');
    countSelectedBadge = document.getElementById('count-selected-badge');
    btnCountSelected = document.getElementById('btn-count-selected');

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

  // Fonte física e exclusiva da Aba 6: alphaquant_top20_tracker (trades.db).
  async function fetchTop20OnlyRecords() {
    const bridges = [window.electronAPI, window.api, window.quantAPI].filter(Boolean);
    for (const bridge of bridges) {
      if (typeof bridge.getTrackerTable !== 'function') continue;
      const res = await bridge.getTrackerTable();
      if (Array.isArray(res)) return res;
      if (res && Array.isArray(res.records)) return res.records;
      return [];
    }
    return null;
  }

  function computeTierLabel(winRate) {
    if (winRate >= 70.0) return 'Extrema (70%+)';
    if (winRate >= 65.0) return 'Muito Forte (65-69%)';
    if (winRate >= 60.0) return 'Forte (60-64%)';
    if (winRate >= 55.0) return 'Favorável (55-59%)';
    if (winRate >= 50.0) return 'Moderada (50-54%)';
    return 'Fraca (<50%)';
  }

  function buildDashboardFromTop20(rows, legacy) {
    const legacyByTicker = new Map();
    if (legacy && Array.isArray(legacy.items)) {
      for (const item of legacy.items) {
        const key = String((item && item.ticker) || '').trim().toUpperCase();
        if (key) legacyByTicker.set(key, item);
      }
    }

    const items = (rows || []).map((row) => {
      const ticker = String(row.ticker || '').trim().toUpperCase();
      const legacyItem = legacyByTicker.get(ticker) || {};
      const winRate = Number(row.win_rate_mc || legacyItem.mc_win_rate || 0);
      const entryPrice = Number(row.entry_price || 0);
      const currentPrice = Number(legacyItem.current_price || row.current_price || entryPrice);
      let pnl = legacyItem.realized_pnl_pct;
      if (pnl == null) pnl = row.pnl_pct;
      if (pnl == null && entryPrice > 0) pnl = ((currentPrice - entryPrice) / entryPrice) * 100;
      const stopLoss = Number(row.stop_loss || legacyItem.stop_loss_price || 0);
      return {
        id: row.id,
        ticker,
        sector: row.sector || 'Outros',
        recommendation_date: row.recommendation_date || legacyItem.recommendation_date || '',
        entry_date: row.recommendation_date || '',
        entry_price: entryPrice,
        current_price: currentPrice,
        target_price: Number(row.target_price || 0),
        stop_loss_price: stopLoss,
        stop_loss: stopLoss,
        mc_win_rate: winRate,
        predicted_win_rate: winRate,
        mc_tier_label: legacyItem.mc_tier_label || computeTierLabel(winRate),
        alpha_score: Number(row.alpha_score || 0),
        horizon_days: 35,
        status: legacyItem.status || row.status || 'PENDENTE',
        exit_price: legacyItem.exit_price != null ? legacyItem.exit_price : row.exit_price,
        exit_date: legacyItem.exit_date || row.exit_date || null,
        realized_pnl_pct: Number(pnl || 0),
        max_favorable_excursion: Number(legacyItem.max_favorable_excursion || 0),
        max_adverse_excursion: Number(legacyItem.max_adverse_excursion || 0),
        days_to_exit: legacyItem.days_to_exit != null ? legacyItem.days_to_exit : null
      };
    });

    const total = items.length;
    const targetHits = items.filter((it) => it.status === 'TARGET_ATINGIDO').length;
    const stopHits = items.filter((it) => it.status === 'STOP_LOSS_ATINGIDO' || it.status === 'STOP_ATINGIDO').length;
    const expired = items.filter((it) => it.status === 'EXPIRADO').length;
    const pending = items.filter((it) => it.status === 'PENDENTE' || it.status === 'MONITORIZANDO').length;
    const resolved = targetHits + stopHits + expired;
    const hitRate = resolved > 0 ? (targetHits / resolved) * 100 : 0;

    const gains = items.filter((it) => it.realized_pnl_pct > 0).reduce((acc, it) => acc + it.realized_pnl_pct, 0);
    const losses = items.filter((it) => it.realized_pnl_pct < 0).reduce((acc, it) => acc + Math.abs(it.realized_pnl_pct), 0);
    const profitFactor = losses > 0 ? gains / losses : (gains > 0 ? gains : 1);
    const avgReturn = total > 0 ? items.reduce((acc, it) => acc + it.realized_pnl_pct, 0) / total : 0;

    const targetDays = items
      .filter((it) => it.status === 'TARGET_ATINGIDO' && Number(it.days_to_exit) > 0)
      .map((it) => Number(it.days_to_exit));
    const avgDays = targetDays.length > 0 ? targetDays.reduce((a, b) => a + b, 0) / targetDays.length : 0;

    const cohortDates = Array.from(new Set(items.map((it) => it.recommendation_date).filter(Boolean)))
      .sort()
      .reverse();

    const tierMap = new Map();
    for (const it of items) {
      const key = it.mc_tier_label;
      if (!tierMap.has(key)) {
        tierMap.set(key, {
          tier_label: key,
          suggestions_count: 0,
          targets_hit: 0,
          stops_hit: 0,
          hit_rate_real: 0,
          avg_return: 0,
          status_calibration: 'Amostragem em Curso'
        });
      }
      const bucket = tierMap.get(key);
      bucket.suggestions_count++;
      if (it.status === 'TARGET_ATINGIDO') bucket.targets_hit++;
      else if (it.status === 'STOP_LOSS_ATINGIDO' || it.status === 'STOP_ATINGIDO') bucket.stops_hit++;
      bucket.avg_return += it.realized_pnl_pct;
    }
    const tierMatrix = Array.from(tierMap.values()).map((bucket) => {
      const tierResolved = bucket.targets_hit + bucket.stops_hit;
      bucket.hit_rate_real = tierResolved > 0 ? Math.round((bucket.targets_hit / tierResolved) * 1000) / 10 : 0;
      bucket.avg_return = bucket.suggestions_count > 0
        ? Math.round((bucket.avg_return / bucket.suggestions_count) * 100) / 100
        : 0;
      if (bucket.suggestions_count >= 5 && bucket.hit_rate_real >= 60) bucket.status_calibration = 'Calibrado com Sucesso';
      else if (bucket.suggestions_count >= 5 && bucket.hit_rate_real < 50) bucket.status_calibration = 'Alerta de Subdesempenho';
      return bucket;
    });

    return {
      kpis: {
        total_recommendations: total,
        active_pending: pending,
        target_hits: targetHits,
        stop_hits: stopHits,
        expired_count: expired,
        resolved_trades: resolved,
        hit_rate: Math.round(hitRate * 10) / 10,
        profit_factor: Math.round(profitFactor * 100) / 100,
        avg_return_pct: Math.round(avgReturn * 100) / 100,
        avg_days_to_target: Math.round(avgDays * 10) / 10
      },
      cohort_dates: cohortDates,
      tier_matrix: tierMatrix,
      items
    };
  }

  // Fonte legada (Python / quant_tracker.db) — usada apenas como fallback.
  async function fetchLegacyTrackerDashboardData() {
    try {
      let res;
      if (window.quantAPI && typeof window.quantAPI.fetchTrackerData === 'function') {
        res = await window.quantAPI.fetchTrackerData({});
      } else if (window.quantAPI && typeof window.quantAPI.getTrackerDashboard === 'function') {
        res = await window.quantAPI.getTrackerDashboard({});
      } else if (window.api && typeof window.api.fetchTrackerData === 'function') {
        res = await window.api.fetchTrackerData({});
      } else if (window.api && typeof window.api.getTrackerDashboard === 'function') {
        res = await window.api.getTrackerDashboard({});
      } else if (window.electronAPI && typeof window.electronAPI.fetchTrackerData === 'function') {
        res = await window.electronAPI.fetchTrackerData({});
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

  async function fetchTrackerDashboardData() {
    // 1) Fonte física e exclusiva da Aba 6: alphaquant_top20_tracker (trades.db).
    try {
      const top20Rows = await fetchTop20OnlyRecords();
      if (top20Rows) {
        let legacy = null;
        try {
          legacy = await fetchLegacyTrackerDashboardData();
        } catch (_) { /* enriquecimento de estado é opcional */ }
        return buildDashboardFromTop20(top20Rows, legacy);
      }
    } catch (err) {
      console.error('[QuantTracker] Erro ao ler alphaquant_top20_tracker:', err);
    }

    // 2) Fallback de compatibilidade quando o canal dedicado não está exposto.
    return fetchLegacyTrackerDashboardData();
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
        const raw = String(d == null ? '' : d);
        const safeDate = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : escapeHtml(raw);
        optionsHtml += `<option value="date_${safeDate}">${escapeHtml(raw)}</option>`;
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

    tbodyMatrix.innerHTML = tierMatrix.map((t) => {
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

      return `
        <tr>
          <td><strong>${escapeHtml(t.tier_label)}</strong></td>
          <td class="num-col">${escapeHtml(t.suggestions_count)}</td>
          <td class="num-col text-success">${escapeHtml(t.targets_hit)}</td>
          <td class="num-col text-danger">${escapeHtml(t.stops_hit)}</td>
          <td class="num-col ${t.hit_rate_real >= 60 ? 'text-success' : 'text-warning'}">
            ${escapeHtml(t.hit_rate_real)}%
          </td>
          <td class="num-col ${retClass}">
            ${retSign}${escapeHtml(t.avg_return)}%
          </td>
          <td>
            <span class="${diagClass}">
              ${escapeHtml(t.status_calibration)}
            </span>
          </td>
        </tr>
      `;
    }).join('');
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
          <td colspan="11" class="text-center text-muted py-4">
            Nenhuma recomendação corresponde aos filtros selecionados.
          </td>
        </tr>`;
      updateMasterCheckboxState();
      updateDuplicateCountBadge();
      return;
    }

    // Contagem de ocorrências para deteção de duplicados na tabela
    const tickerCounts = {};
    items.forEach((r) => {
      const t = String(r.ticker || '').toUpperCase().trim();
      if (t) tickerCounts[t] = (tickerCounts[t] || 0) + 1;
    });

    const rowsHtml = items.map((rec) => {
      const cleanTicker = String(rec.ticker || '').toUpperCase().trim();
      const isDuplicate = (tickerCounts[cleanTicker] || 0) > 1;

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

      const fmt = (val) => {
        if (typeof window.formatPriceWithCurrency === 'function') {
          return window.formatPriceWithCurrency(val, rec);
        }
        return `${Number(val || 0).toFixed(2)} €`;
      };

      const safeDate = escapeHtml(rec.recommendation_date || '');
      const safeTicker = escapeHtml(rec.ticker || '');
      const safeSector = escapeHtml(rec.sector || '');
      const safeTierLabel = escapeHtml(rec.mc_tier_label || '');

      return `
        <tr class="${isDuplicate ? 'row-duplicate' : ''}">
          <td style="width: 38px; text-align: center;">
            <input type="checkbox" class="chk-tracker-row" data-id="${rec.id}" data-ticker="${safeTicker}" data-duplicate="${isDuplicate}" style="cursor: pointer; width: 15px; height: 15px; accent-color: #3b82f6;">
          </td>
          <td class="text-secondary" style="font-family: var(--mono); font-size: 12px;">${safeDate}</td>
          <td>
            <strong class="text-white" style="font-size: 1rem;">${safeTicker}</strong>
            ${isDuplicate ? '<span class="badge-duplicate">Duplicado</span>' : ''}
          </td>
          <td><span class="text-secondary small">${safeSector}</span></td>
          <td class="num-col">${fmt(rec.entry_price)}</td>
          <td class="num-col" style="font-weight: 700; color: #fff;">${fmt(rec.current_price || rec.exit_price || rec.entry_price)}</td>
          <td class="num-col text-success">${fmt(rec.target_price)}</td>
          <td class="num-col text-danger">${fmt(rec.stop_loss_price || rec.stop_loss)}</td>
          <td>
            <span class="badge ${badgeClass}" style="font-size: 0.8rem; font-weight: 600; padding: 4px 8px;">
              ${Number(rec.mc_win_rate || 0)}% (${safeTierLabel})
            </span>
          </td>
          <td class="num-col ${pnlClass}">
            ${pnlSign}${pnlVal}%
          </td>
          <td>${statusHtml}</td>
        </tr>
      `;
    });
    tbodyTracker.innerHTML = rowsHtml.join('');

    attachRowCheckboxListeners();
    updateSelectionCounts();
    updateDuplicateCountBadge();
  }

  function attachRowCheckboxListeners() {
    const rowCheckboxes = document.querySelectorAll('.chk-tracker-row');
    rowCheckboxes.forEach((cb) => {
      cb.addEventListener('change', () => {
        updateSelectionCounts();
      });
    });
  }

  function updateSelectionCounts() {
    const checkedBoxes = document.querySelectorAll('.chk-tracker-row:checked');
    const count = checkedBoxes.length;
    if (countSelectedBadge) countSelectedBadge.textContent = count;
    if (btnCountSelected) btnCountSelected.textContent = count;
    updateMasterCheckboxState();
  }

  function updateMasterCheckboxState() {
    if (!chkSelectAllTracker) return;
    const total = document.querySelectorAll('.chk-tracker-row');
    const checked = document.querySelectorAll('.chk-tracker-row:checked');
    if (total.length === 0) {
      chkSelectAllTracker.checked = false;
      chkSelectAllTracker.indeterminate = false;
    } else {
      chkSelectAllTracker.checked = checked.length === total.length;
      chkSelectAllTracker.indeterminate = checked.length > 0 && checked.length < total.length;
    }
  }

  async function updateDuplicateCountBadge() {
    try {
      const api = window.electronAPI || window.api || window.quantAPI;
      if (!api || typeof api.getDuplicateTrackedAssets !== 'function') return;
      const duplicates = await api.getDuplicateTrackedAssets();
      const badge = document.getElementById('count-duplicates-badge');
      if (!badge) return;
      const tickers = new Set((duplicates || []).map((d) => String(d.ticker || '').toUpperCase().trim()));
      const removableCount = Math.max(0, (duplicates || []).length - tickers.size);
      badge.textContent = removableCount;
    } catch (err) {
      console.error('[QuantTracker] Erro ao atualizar badge de duplicados:', err);
    }
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
      if (window.quantAPI && typeof window.quantAPI.updateTrackerPrices === 'function') {
        res = await window.quantAPI.updateTrackerPrices({});
      } else if (window.quantAPI && typeof window.quantAPI.evaluateTrackedAssets === 'function') {
        res = await window.quantAPI.evaluateTrackedAssets({});
      } else if (window.api && typeof window.api.updateTrackerPrices === 'function') {
        res = await window.api.updateTrackerPrices({});
      } else if (window.api && typeof window.api.evaluateTrackedAssets === 'function') {
        res = await window.api.evaluateTrackedAssets({});
      } else if (window.electronAPI && typeof window.electronAPI.updateTrackerPrices === 'function') {
        res = await window.electronAPI.updateTrackerPrices({});
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

    // Checkbox Master "Selecionar Todos"
    if (chkSelectAllTracker) {
      chkSelectAllTracker.addEventListener('change', (e) => {
        const isChecked = e.target.checked;
        document.querySelectorAll('.chk-tracker-row').forEach((cb) => {
          cb.checked = isChecked;
        });
        if (chkFilterDuplicates && !isChecked) {
          chkFilterDuplicates.checked = false;
        }
        updateSelectionCounts();
      });
    }

    // Checkbox "Marcar Duplicados"
    if (chkFilterDuplicates) {
      chkFilterDuplicates.addEventListener('change', (e) => {
        const markOnlyDuplicates = e.target.checked;
        const seenTickers = new Set();

        const rows = Array.from(document.querySelectorAll('.chk-tracker-row'));
        rows.forEach((chk) => {
          const ticker = String(chk.dataset.ticker || '').toUpperCase().trim();
          const isDup = chk.dataset.duplicate === 'true';

          if (markOnlyDuplicates && isDup) {
            if (seenTickers.has(ticker)) {
              chk.checked = true; // Marca cópias antigas excedentes
            } else {
              seenTickers.add(ticker);
              chk.checked = false; // Mantém a cópia mais recente desmarcada
            }
          } else {
            chk.checked = false;
          }
        });
        updateSelectionCounts();
      });
    }

    // Botão 1: "Apagar Selecionados" (elimina as linhas atualmente marcadas com checkbox)
    if (btnDeleteSelected) {
      btnDeleteSelected.addEventListener('click', async () => {
        const api = window.electronAPI || window.api || window.quantAPI;
        if (!api) return;

        const checkedBoxes = Array.from(document.querySelectorAll('.chk-tracker-row:checked'));
        if (checkedBoxes.length === 0) {
          alert('Nenhum registo selecionado para apagar.\nPor favor, marque as caixas de seleção dos ativos que deseja eliminar.');
          return;
        }

        const ids = checkedBoxes.map((cb) => Number(cb.dataset.id)).filter((id) => id > 0);
        if (ids.length === 0) return;

        if (!confirm(`Deseja apagar os ${ids.length} registo(s) selecionado(s) do Tracker?`)) {
          return;
        }

        btnDeleteSelected.disabled = true;
        try {
          const res = (typeof api.deleteTrackedAssetsByIds === 'function')
            ? await api.deleteTrackedAssetsByIds(ids)
            : { success: false, error: 'Função de eliminação por IDs indisponível' };

          if (res && res.success) {
            alert(`✅ Foram eliminados ${res.deletedCount} registo(s) selecionado(s) do Tracker com sucesso.`);
            if (chkFilterDuplicates) chkFilterDuplicates.checked = false;
            if (chkSelectAllTracker) chkSelectAllTracker.checked = false;
            await loadTrackerDashboard();
          } else {
            alert(`Erro ao eliminar registos: ${res?.error || 'Erro desconhecido'}`);
          }
        } catch (err) {
          alert(`Erro na eliminação: ${err.message}`);
        } finally {
          btnDeleteSelected.disabled = false;
        }
      });
    }

    // Botão 2: "Apagar Duplicados" (purga automática mantendo o registo mais recente)
    if (btnDeleteDuplicates) {
      btnDeleteDuplicates.addEventListener('click', async () => {
        const api = window.electronAPI || window.api || window.quantAPI;
        if (!api) return;

        if (!confirm('Deseja apagar automaticamente todas as cópias duplicadas do Tracker, mantendo apenas o registo mais recente de cada ativo?')) {
          return;
        }

        btnDeleteDuplicates.disabled = true;
        try {
          const res = (typeof api.deleteDuplicateTrackedAssets === 'function')
            ? await api.deleteDuplicateTrackedAssets()
            : { success: false, error: 'Função de purga de duplicados indisponível' };

          if (res && res.success) {
            alert(`✅ Limpeza de duplicados concluída: ${res.deletedCount} duplicado(s) removido(s).`);
            if (chkFilterDuplicates) chkFilterDuplicates.checked = false;
            if (chkSelectAllTracker) chkSelectAllTracker.checked = false;
            await loadTrackerDashboard();
          } else {
            alert(`Erro ao eliminar duplicados: ${res?.error || 'Erro desconhecido'}`);
          }
        } catch (err) {
          alert(`Erro na limpeza de duplicados: ${err.message}`);
        } finally {
          btnDeleteDuplicates.disabled = false;
        }
      });
    }

    // Botão 3: "Apagar Tudo" (limpar todo o histórico guardado no Tracker)
    if (btnClearAllTracker) {
      btnClearAllTracker.addEventListener('click', async () => {
        const api = window.electronAPI || window.api || window.quantAPI;
        if (!api) return;

        if (!confirm('⚠️ ATENÇÃO: Tem a certeza de que deseja apagar TODOS os registos guardados no Tracker?\n\nEsta ação irá eliminar permanentemente todo o histórico de acompanhamento e não pode ser revertida.')) {
          return;
        }

        btnClearAllTracker.disabled = true;
        try {
          const res = (typeof api.clearAllTrackerData === 'function')
            ? await api.clearAllTrackerData()
            : { success: false, error: 'Função de limpeza total indisponível' };

          if (res && res.success) {
            alert(`✅ Todo o histórico do Tracker foi apagado com sucesso (${res.deletedCount} registo(s) eliminado(s)).`);
            if (chkFilterDuplicates) chkFilterDuplicates.checked = false;
            if (chkSelectAllTracker) chkSelectAllTracker.checked = false;
            await loadTrackerDashboard();
          } else {
            alert(`Erro ao apagar todos os registos: ${res?.error || 'Erro desconhecido'}`);
          }
        } catch (err) {
          alert(`Erro na limpeza total: ${err.message}`);
        } finally {
          btnClearAllTracker.disabled = false;
        }
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
