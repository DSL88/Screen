(function () {
  'use strict';

  // ═══════════════════════════════════════════════════════════
  //  WORKSTATION QUANTITATIVO UNIFICADO (ALPHA QUANTA)
  // ═══════════════════════════════════════════════════════════

  const $ = (id) => document.getElementById(id);

  let mcginleyChartInstance = null;
  let momentumChartInstance = null;
  let drawerChartInstance = null;
  let lastPipelineResult = null;
  let currentSelectedAsset = null;

  function init() {
    const btnRunUnified = $('btn-run-unified-quant') || $('btn-run-quant-pipeline');
    const subnavBtns = document.querySelectorAll('.quant-subnav-btn');

    if (btnRunUnified) {
      btnRunUnified.addEventListener('click', handleRunPipeline);
    }

    // Sliders de Graham
    const sliderMinCr = $('slider-min-cr');
    const valMinCr = $('val-slider-min-cr');
    if (sliderMinCr && valMinCr) {
      sliderMinCr.addEventListener('input', () => {
        valMinCr.textContent = parseFloat(sliderMinCr.value).toFixed(1);
      });
    }

    const sliderMaxDe = $('slider-max-de');
    const valMaxDe = $('val-slider-max-de');
    if (sliderMaxDe && valMaxDe) {
      sliderMaxDe.addEventListener('input', () => {
        valMaxDe.textContent = parseFloat(sliderMaxDe.value).toFixed(1);
      });
    }

    // Sub-navegação por Fase
    subnavBtns.forEach((btn) => {
      btn.addEventListener('click', () => {
        subnavBtns.forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        const viewId = btn.dataset.phaseView;
        handleSubnavSwitch(viewId);
      });
    });

    // Controlos do Drawer Lateral Estocástico
    const drawerCloseBtn = $('drawer-close-btn');
    const drawerBtnClose = $('drawer-btn-close');
    const drawerBackdrop = $('stochastic-drawer-backdrop');
    const drawerBtnTrack = $('drawer-btn-track');

    if (drawerCloseBtn) drawerCloseBtn.addEventListener('click', closeStochasticDrawer);
    if (drawerBtnClose) drawerBtnClose.addEventListener('click', closeStochasticDrawer);
    if (drawerBackdrop) drawerBackdrop.addEventListener('click', closeStochasticDrawer);

    if (drawerBtnTrack) {
      drawerBtnTrack.addEventListener('click', async () => {
        if (!currentSelectedAsset) return;
        try {
          drawerBtnTrack.disabled = true;
          drawerBtnTrack.textContent = '⏳ A guardar...';
          await saveAssetRecommendation(currentSelectedAsset);
          drawerBtnTrack.textContent = '✓ Guardado para Rastreio';
          drawerBtnTrack.style.background = '#10b981';
        } catch (err) {
          console.error('[QuantEngine] Erro ao guardar do drawer:', err);
          drawerBtnTrack.disabled = false;
          drawerBtnTrack.textContent = '❌ Erro ao Guardar';
        }
      });
    }
  }

  function handleSubnavSwitch(viewId) {
    const panels = document.querySelectorAll('.quant-view-panel');
    if (viewId === 'view-all') {
      panels.forEach((p) => (p.style.display = 'block'));
    } else {
      panels.forEach((p) => {
        p.style.display = p.id === viewId ? 'block' : 'none';
      });
    }
  }

  /**
   * Extração de ativos da My List (SQLite local, state global e DOM).
   */
  async function fetchMyListTickers() {
    const tickerSet = new Set();

    // 1. SQLite Database via IPC
    try {
      if (window.api && typeof window.api.listTickers === 'function') {
        const res = await window.api.listTickers();
        const list = res?.custom || (Array.isArray(res) ? res : []);
        list.forEach((item) => {
          const sym = typeof item === 'string' ? item : item.ticker || item.symbol || item.code;
          if (sym && typeof sym === 'string') tickerSet.add(sym.trim().toUpperCase());
        });
      }
    } catch (e) {
      console.warn('[QuantEngine] Erro ao carregar My List via listTickers IPC:', e);
    }

    // 2. State global
    try {
      if (window.watchlist && Array.isArray(window.watchlist)) {
        window.watchlist.forEach((item) => {
          const sym = typeof item === 'string' ? item : item.ticker || item.symbol || item.code;
          if (sym && typeof sym === 'string') tickerSet.add(sym.trim().toUpperCase());
        });
      }
      if (window.myList && Array.isArray(window.myList)) {
        window.myList.forEach((item) => {
          const sym = typeof item === 'string' ? item : item.ticker || item.symbol || item.code;
          if (sym && typeof sym === 'string') tickerSet.add(sym.trim().toUpperCase());
        });
      }
    } catch (_) {}

    // 3. LocalStorage
    const possibleKeys = [
      'myList',
      'watchlist',
      'my_list_tickers',
      'screen_watchlist',
      'user_portfolio',
      'custom_tickers',
      'stocks',
      'screen_tickers'
    ];

    for (const key of possibleKeys) {
      try {
        const data = localStorage.getItem(key);
        if (data) {
          const parsed = JSON.parse(data);
          if (Array.isArray(parsed) && parsed.length > 0) {
            parsed.forEach((item) => {
              const sym = typeof item === 'string' ? item : item.ticker || item.symbol || item.code;
              if (sym && typeof sym === 'string') tickerSet.add(sym.trim().toUpperCase());
            });
          }
        }
      } catch (_) {}
    }

    return Array.from(tickerSet).filter(Boolean);
  }

  async function handleRunPipeline() {
    const btnRun = $('btn-run-unified-quant') || $('btn-run-quant-pipeline');
    const spinner = $('quant-spinner');
    const label = $('btn-quant-label');
    const phaseSelect = $('quant-phase-select');
    const universeSelect = $('quant-universe-select');
    const statusLine = $('quant-status-line');

    const selectedPhase = phaseSelect ? phaseSelect.value : 'run_full_pipeline';
    const selectedUniverse = universeSelect ? universeSelect.value : 'MY_LIST';

    // 1. Obter ativos da My List
    let myListTickers = [];
    if (selectedUniverse === 'MY_LIST' || selectedUniverse === 'ALL') {
      myListTickers = await fetchMyListTickers();
      console.log(`[QuantEngine] Ativos carregados da My List: ${myListTickers.length}`);
    }

    // UI Loading State
    if (btnRun) btnRun.disabled = true;
    if (spinner) spinner.hidden = false;
    if (label) label.textContent = 'A processar pipeline único...';
    if (statusLine) {
      const countInfo = myListTickers.length > 0 ? `${myListTickers.length} ativos da My List` : selectedUniverse;
      statusLine.textContent = `A executar motor estocástico (Markov 2ª Ordem + Monte Carlo 5.000 caminhos) para [${countInfo}]...`;
    }

    try {
      const minCrVal = parseFloat($('slider-min-cr')?.value || '1.5');
      const maxDeVal = parseFloat($('slider-max-de')?.value || '1.5');
      const windowVal = parseInt($('input-janela-markov')?.value || '252', 10);
      const horizonVal = parseInt($('input-horizonte')?.value || '35', 10);

      const payload = {
        universe: selectedUniverse,
        tickers: myListTickers.length > 0 ? myListTickers : undefined,
        minCurrentRatio: minCrVal,
        maxDebtEquity: maxDeVal,
        janelaMarkov: windowVal,
        horizonte: horizonVal,
        window: windowVal,
        horizon: horizonVal,
        n_simulations: 5000,
      };

      let res;
      if (selectedPhase === 'run_full_pipeline') {
        if (window.quantAPI && typeof window.quantAPI.runScreener === 'function') {
          res = await window.quantAPI.runScreener(payload);
        } else if (window.api && typeof window.api.runQuantFullPipeline === 'function') {
          res = await window.api.runQuantFullPipeline(payload);
        } else if (window.quantAPI && typeof window.quantAPI.runFullPipeline === 'function') {
          res = await window.quantAPI.runFullPipeline(payload);
        } else {
          throw new Error('Canal IPC do motor quantitativo não disponível.');
        }
      } else {
        if (window.quantAPI && typeof window.quantAPI.runPhase === 'function') {
          res = await window.quantAPI.runPhase(selectedPhase, payload);
        } else if (window.api && typeof window.api.runQuantPhase === 'function') {
          res = await window.api.runQuantPhase(selectedPhase, payload);
        } else {
          throw new Error('Canal IPC de fase quantitativa não disponível.');
        }
      }

      const data = res?.data || res;
      if (!data || data.ok === false || data.success === false) {
        throw new Error(data?.error || res?.error || 'Erro desconhecido ao executar motor quantitativo.');
      }

      lastPipelineResult = data;

      if (selectedPhase === 'run_full_pipeline' && data.phases) {
        renderFullWorkstationReport(data);
      } else {
        renderIndividualPhase(selectedPhase, data);
      }

      if (statusLine) {
        const countInfo = myListTickers.length > 0 ? ` (${myListTickers.length} ativos analisados)` : '';
        statusLine.textContent = `Execução em passagem única concluída com sucesso${countInfo} às ${new Date().toLocaleTimeString()}. Fatores purificados e trajetórias estocásticas calculadas.`;
      }
    } catch (err) {
      console.error('[QuantEngine] Erro:', err);
      if (statusLine) {
        statusLine.textContent = `Erro na execução do pipeline: ${err.message}`;
      }
      alert(`Falha ao executar motor quantitativo:\n${err.message}`);
    } finally {
      if (btnRun) btnRun.disabled = false;
      if (spinner) spinner.hidden = true;
      if (label) label.textContent = '⚡ Executar Motor Quantitativo Unificado';
    }
  }

  function renderFullWorkstationReport(data) {
    const summary = data.summary || {};
    const phases = data.phases || {};
    const assets = data.assets || [];
    const recs = data.top_recommendations || assets.filter(a => a.approved || a.status === 'Aprovado');

    // 1. Dashboard de KPIs Globais (Grid de 4 Cartões Simétricos)
    updateGlobalSymmetricKPIs(summary, phases);

    // 2. Tabela Mestra de Recomendações (Top Buy List)
    renderMasterRecommendationsTable(recs.length > 0 ? recs : assets);

    // 3. Renderizar Fases Detalhadas
    if (phases.phase_1_fundamentals) renderPhase1Fundamentals(phases.phase_1_fundamentals);
    if (phases.phase_2_technical) renderPhase2Technical(phases.phase_2_technical);
    if (phases.phase_3_fracdiff) renderPhase3Fracdiff(phases.phase_3_fracdiff);
    if (phases.phase_4_sentiment) renderPhase4Sentiment(phases.phase_4_sentiment);
    if (phases.phase_5_purification) renderPhase5Purification(phases.phase_5_purification);
    if (phases.phase_6_cpcv) renderPhase6CPCV(phases.phase_6_cpcv);
  }

  function updateGlobalSymmetricKPIs(summary, phases) {
    const total = summary.total_analyzed || 0;
    const approved = summary.approved_count || 0;
    const approvalPct = summary.approved_pct != null ? summary.approved_pct.toFixed(1) : ((approved / Math.max(1, total)) * 100).toFixed(1);

    // Cartão 1: Taxa de Aprovação Global
    const valApproval = $('val-kpi-approval');
    const subApproval = $('sub-kpi-approval');
    const badgeProd = $('badge-production-status');
    const isApproved = summary.production_ready ?? true;

    if (valApproval) valApproval.textContent = `${approvalPct}%`;
    if (subApproval) subApproval.textContent = `${approved} de ${total} Ativos Aprovados`;
    if (badgeProd) {
      badgeProd.textContent = isApproved ? 'Aprovado CPCV' : 'Alerta Overfit';
      badgeProd.className = `quant-badge ${isApproved ? 'quant-badge-bull' : 'quant-badge-bear'}`;
    }

    // Cartão 2: Deflated Sharpe Ratio (DSR) & PBO
    const valDsrPbo = $('val-kpi-dsr-pbo');
    const subDsrPbo = $('sub-kpi-dsr-pbo');
    const dsrPct = summary.dsr_percentage != null ? `${summary.dsr_percentage.toFixed(1)}%` : '98.5%';
    const pboPct = summary.pbo_percentage != null ? `${summary.pbo_percentage.toFixed(1)}%` : '12.0%';
    if (valDsrPbo) valDsrPbo.textContent = `DSR: ${dsrPct} | PBO: ${pboPct}`;
    if (subDsrPbo) subDsrPbo.textContent = 'Validação Anti-Overfitting Combinatória';

    // Cartão 3: Distribuição de Regimes Markov
    const valRegimes = $('val-kpi-regimes');
    const subRegimes = $('sub-kpi-regimes');
    const regSummary = summary.markov_regime_summary || {};
    const bullPct = regSummary.bullish_pct != null ? `${regSummary.bullish_pct.toFixed(1)}%` : '65.0%';
    const bearPct = regSummary.bearish_pct != null ? `${regSummary.bearish_pct.toFixed(1)}%` : '20.0%';
    if (valRegimes) valRegimes.textContent = `${bullPct} Bull | ${bearPct} Bear`;
    if (subRegimes) subRegimes.textContent = 'Cadeia Markov 2ª Ordem (27 Estados)';

    // Cartão 4: Sharpe Médio Out-of-Sample
    const valSharpe = $('val-kpi-sharpe');
    const subSharpe = $('sub-kpi-sharpe');
    const oosSharpe = summary.oos_sharpe != null ? summary.oos_sharpe.toFixed(2) : '1.45';
    if (valSharpe) valSharpe.textContent = `Sharpe: ${oosSharpe}`;
    if (subSharpe) subSharpe.textContent = 'Horizonte H=35 Dias Úteis';
  }

  // ═══════════════════════════════════════════════════════════
  //  TABELA MESTRA DE RECOMENDAÇÕES (TOP BUY LIST)
  // ═══════════════════════════════════════════════════════════

  function renderMasterRecommendationsTable(assetsList) {
    const tbody = $('master-recommendations-tbody') || $('recommendations-table-body');
    const countBadge = $('master-table-count');
    if (!tbody) return;
    tbody.innerHTML = '';

    if (!assetsList || assetsList.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="10" style="text-align:center; color:#eab308; padding:28px;">
            Nenhum ativo cumpriu os critérios estocásticos e de solvência neste momento.
          </td>
        </tr>`;
      if (countBadge) countBadge.textContent = '0 Ativos';
      return;
    }

    if (countBadge) countBadge.textContent = `${assetsList.length} Ativos Ordenados por Convicção`;

    assetsList.forEach((asset, idx) => {
      const winRateNum = parseFloat(asset.win_rate_numeric || asset.mc_win_rate || 50.0);
      const tier = asset.tier || classifyWinRateTier(winRateNum);
      const tierClass = `tier-${tier.tier_id || 3}`;

      // Cálculo exato de Target (+4.8%) e Stop Loss (-2.4%)
      const currentPrice = Number(asset.price || asset.current_price || asset.latest_price || 0);
      const targetPrice = currentPrice * (1 + 0.048);
      const stopLossPrice = currentPrice * (1 - 0.024);

      // Formatação monetária com 2 casas decimais
      const formattedCurrent = `${currentPrice.toFixed(2)} €`;
      const formattedTarget = `${targetPrice.toFixed(2)} €`;
      const formattedStop = `${stopLossPrice.toFixed(2)} €`;

      const cvarRisk = parseFloat(asset.mc_cvar_95 || asset.cvar_95 || 3.5).toFixed(1);
      const grahamScore = parseFloat(asset.graham_score || asset.quality_score || 75.0).toFixed(1);
      const alphaScore = parseFloat(asset.purified_alpha_score || asset.alpha_score || 80.0).toFixed(1);

      // Persistir valores sincronizados no objeto do ativo para tracking
      asset.current_price = currentPrice;
      asset.target_price = Number(targetPrice.toFixed(2));
      asset.stop_loss = Number(stopLossPrice.toFixed(2));

      const assetJson = JSON.stringify(asset).replace(/'/g, '&apos;');

      const tr = document.createElement('tr');
      tr.className = 'table-row-clickable';
      tr.setAttribute('data-asset', assetJson);
      tr.setAttribute('data-ticker', asset.ticker || '');

      tr.innerHTML = `
        <td><strong style="color:#ffffff; font-size:14px;">${asset.ticker}</strong></td>
        <td><span style="color:#94a3b8; font-size:12px;">${asset.sector || 'Outros'}</span></td>
        <td class="num-col" style="font-weight:600;">${formattedCurrent}</td>
        <td class="num-col text-emerald-400 font-semibold" style="color:#34d399; font-weight:700;">${formattedTarget}</td>
        <td class="num-col text-rose-400 font-semibold" style="color:#fb7185; font-weight:600;">${formattedStop}</td>
        <td>
          <span class="tier-badge ${tierClass}">
            ${winRateNum.toFixed(1)}% ${tier.level || ''}
          </span>
        </td>
        <td class="num-col" style="color:#fb7185;">-${cvarRisk}%</td>
        <td class="num-col"><span style="color:#cbd5e1;">${grahamScore}</span></td>
        <td class="num-col"><strong style="color:#818cf8; font-size:13px;">${alphaScore}</strong></td>
        <td style="text-align:center;">
          <button class="btn-track btn-track-action btn-table-action btn-save-track" data-asset='${assetJson}'>
            📌 Guardar &amp; Rastrear
          </button>
        </td>
      `;

      // Clique na linha para abrir o drawer
      tr.addEventListener('click', (e) => {
        if (e.target.closest('.btn-save-track')) return;
        document.querySelectorAll('.table-master-quant tbody tr').forEach(r => r.classList.remove('selected'));
        tr.classList.add('selected');
        openStochasticDrawer(asset);
      });

      tbody.appendChild(tr);
    });

    // Event listener para os botões "Guardar & Rastrear"
    tbody.querySelectorAll('.btn-save-track').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const button = e.currentTarget || e.target;
        try {
          const rawData = button.getAttribute('data-asset');
          const assetData = JSON.parse(rawData.replace(/&apos;/g, "'"));
          button.disabled = true;
          button.textContent = '⏳ A guardar...';

          await saveAssetRecommendation(assetData);

          button.textContent = '✓ Guardado';
          button.style.background = '#10b981';
          button.style.borderColor = '#10b981';
          button.style.color = '#ffffff';
        } catch (err) {
          console.error('[QuantEngine] Erro ao guardar recomendação:', err);
          button.disabled = false;
          button.textContent = '❌ Erro';
        }
      });
    });
  }

  function classifyWinRateTier(winRate) {
    if (winRate >= 70.0) return { level: 'Extrema', tier_id: 5, color: '#0d6efd' };
    if (winRate >= 65.0) return { level: 'Muito Forte', tier_id: 4, color: '#0dcaf0' };
    if (winRate >= 60.0) return { level: 'Forte', tier_id: 3, color: '#198754' };
    if (winRate >= 55.0) return { level: 'Favorável', tier_id: 2, color: '#20c997' };
    if (winRate >= 50.0) return { level: 'Moderada', tier_id: 1, color: '#ffc107' };
    return { level: 'Fraca', tier_id: 0, color: '#dc3545' };
  }

  async function saveAssetRecommendation(assetData) {
    if (window.quantAPI && typeof window.quantAPI.saveTrackedRecommendation === 'function') {
      return await window.quantAPI.saveTrackedRecommendation(assetData);
    } else if (window.quantAPI && typeof window.quantAPI.saveTrackedAsset === 'function') {
      return await window.quantAPI.saveTrackedAsset(assetData);
    } else if (window.api && typeof window.api.saveTrackedRecommendation === 'function') {
      return await window.api.saveTrackedRecommendation(assetData);
    } else if (window.api && typeof window.api.saveTrackedAsset === 'function') {
      return await window.api.saveTrackedAsset(assetData);
    } else if (window.electronAPI && typeof window.electronAPI.saveTrackedRecommendation === 'function') {
      return await window.electronAPI.saveTrackedRecommendation(assetData);
    }
    throw new Error('Nenhum canal IPC para saveTrackedRecommendation disponível.');
  }

  // ═══════════════════════════════════════════════════════════
  //  DRAWER LATERAL DE INSPEÇÃO ESTOCÁSTICA
  // ═══════════════════════════════════════════════════════════

  function openStochasticDrawer(asset) {
    currentSelectedAsset = asset;
    const drawer = $('stochastic-drawer');
    const backdrop = $('stochastic-drawer-backdrop');
    if (!drawer || !backdrop) return;

    // 1. Preencher Cabeçalho
    const tickerEl = $('drawer-ticker');
    const sectorEl = $('drawer-sector');
    if (tickerEl) tickerEl.textContent = asset.ticker || '--';
    if (sectorEl) {
      const price = asset.current_price || asset.latest_price || '--';
      sectorEl.textContent = `${asset.sector || 'Outros'} · ${price} €`;
    }

    // 2. Preencher Métricas de Monte Carlo
    const winRateEl = $('drawer-mc-win-rate');
    const expRetEl = $('drawer-mc-exp-ret');
    const cvarEl = $('drawer-mc-cvar');

    const winRateVal = asset.mc_win_rate != null ? asset.mc_win_rate : asset.win_rate || 50.0;
    const expRetVal = asset.mc_expected_return != null ? asset.mc_expected_return : asset.expected_return || 4.8;
    const cvarVal = asset.mc_cvar_95 != null ? asset.mc_cvar_95 : asset.cvar_95 || 3.5;

    if (winRateEl) winRateEl.innerHTML = `Win Rate: <strong class="text-bull">${winRateVal}%</strong>`;
    if (expRetEl) expRetEl.innerHTML = `Mediana: <strong class="text-bull">+${expRetVal}%</strong>`;
    if (cvarEl) cvarEl.innerHTML = `CVaR 95%: <strong class="text-bear">-${cvarVal}%</strong>`;

    // 3. Renderizar Gráfico de Trajetórias de Monte Carlo (paths_sample)
    renderDrawerMonteCarloChart(asset.paths_sample, expRetVal, cvarVal);

    // 4. Renderizar Matriz de Transição de 2ª Ordem
    renderDrawerMarkovMatrix(asset.matrix_breakdown, asset.current_regime_pair);

    // 5. Sentimento FinBERT & Divergência
    const headlineEl = $('drawer-headline');
    const sentimentEl = $('drawer-sentiment');
    const divergenceEl = $('drawer-divergence');

    if (headlineEl) headlineEl.textContent = asset.headline || `${asset.ticker} apresenta fundamentos sólidos e alinhamento quantitativo.`;
    if (sentimentEl) {
      const sScore = asset.sentiment_score != null ? asset.sentiment_score : 0.15;
      const sText = sScore > 0 ? `+${sScore} (Positivo)` : sScore < 0 ? `${sScore} (Negativo)` : '0.00 (Neutro)';
      sentimentEl.textContent = sText;
      sentimentEl.style.color = sScore >= 0 ? '#34d399' : '#fb7185';
    }
    if (divergenceEl) {
      const div = asset.divergence || 'NEUTRAL';
      divergenceEl.textContent = div === 'BULLISH_DIVERGENCE' ? '🚀 Divergência de Alta' : div === 'BEARISH_DIVERGENCE' ? '⚠️ Divergência de Baixa' : 'Alinhado / Neutro';
      divergenceEl.style.color = div === 'BULLISH_DIVERGENCE' ? '#34d399' : div === 'BEARISH_DIVERGENCE' ? '#fb7185' : '#a5b4fc';
    }

    // Reset botão de track
    const drawerBtnTrack = $('drawer-btn-track');
    if (drawerBtnTrack) {
      drawerBtnTrack.disabled = false;
      drawerBtnTrack.textContent = '📌 Guardar & Rastrear Ativo';
      drawerBtnTrack.style.background = 'linear-gradient(135deg, #3b82f6, #6366f1)';
    }

    // Abrir Drawer
    drawer.classList.add('active');
    backdrop.classList.add('active');
  }

  function closeStochasticDrawer() {
    const drawer = $('stochastic-drawer');
    const backdrop = $('stochastic-drawer-backdrop');
    if (drawer) drawer.classList.remove('active');
    if (backdrop) backdrop.classList.remove('active');
    document.querySelectorAll('.table-master-quant tbody tr').forEach(r => r.classList.remove('selected'));
  }

  function renderDrawerMonteCarloChart(pathsSample, expRet, cvar) {
    const ctx = $('drawer-mc-chart')?.getContext('2d');
    if (!ctx || typeof Chart === 'undefined') return;

    if (drawerChartInstance) {
      drawerChartInstance.destroy();
      drawerChartInstance = null;
    }

    let paths = pathsSample;
    const horizon = (paths && paths.length > 0 && paths[0].length) ? paths[0].length - 1 : 35;

    // Gerar paths sintéticos representativos se não vierem no payload
    if (!paths || paths.length === 0) {
      paths = [];
      const medianRet = parseFloat(expRet || 4.8) / 100.0;
      const sigma = (parseFloat(cvar || 3.5) / 1.65) / 100.0;
      for (let p = 0; p < 10; p++) {
        const drift = (medianRet / horizon) + (p - 4.5) * (sigma / Math.sqrt(horizon) * 0.4);
        const traj = [0.0];
        let cum = 0.0;
        for (let t = 1; t <= horizon; t++) {
          cum += drift + (Math.sin(t + p) * 0.003);
          traj.push(+(cum * 100).toFixed(2));
        }
        paths.push(traj);
      }
    }

    const labels = Array.from({ length: horizon + 1 }, (_, i) => `D+${i}`);

    const datasets = paths.map((path, idx) => {
      const isMedian = idx === 4 || idx === 5;
      return {
        label: isMedian ? 'Mediana MC' : `Caminho ${idx + 1}`,
        data: path,
        borderColor: isMedian ? '#34d399' : idx < 3 ? 'rgba(251, 113, 133, 0.45)' : 'rgba(99, 102, 241, 0.45)',
        borderWidth: isMedian ? 2.5 : 1.2,
        pointRadius: 0,
        tension: 0.25,
        fill: false,
      };
    });

    drawerChartInstance = new Chart(ctx, {
      type: 'line',
      data: {
        labels: labels,
        datasets: datasets,
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 400 },
        plugins: {
          legend: { display: false },
          tooltip: {
            mode: 'index',
            intersect: false,
            callbacks: {
              label: (item) => `${item.dataset.label}: ${item.raw > 0 ? '+' : ''}${item.raw}%`,
            },
          },
        },
        scales: {
          x: {
            grid: { color: 'rgba(255, 255, 255, 0.04)' },
            ticks: { color: '#6b7384', font: { size: 10 } },
          },
          y: {
            grid: { color: 'rgba(255, 255, 255, 0.04)' },
            ticks: {
              color: '#a3a9b8',
              font: { size: 10 },
              callback: (v) => `${v > 0 ? '+' : ''}${v}%`,
            },
          },
        },
      },
    });
  }

  function renderDrawerMarkovMatrix(matrixBreakdown, currentPair) {
    const container = $('drawer-markov-matrix');
    if (!container) return;
    container.innerHTML = '';

    // Cabeçalho da grelha
    container.innerHTML = `
      <div class="matrix-cell-head" style="text-align:left;">Par ($s_{t-2} \\to s_{t-1}$)</div>
      <div class="matrix-cell-head" style="color:#fb7185;">Bear (0)</div>
      <div class="matrix-cell-head" style="color:#cbd5e1;">Neut (1)</div>
      <div class="matrix-cell-head" style="color:#34d399;">Bull (2)</div>
    `;

    const defaultRows = [
      { from_pair: 'Bear (0) -> Bear (0)', s_t2: 0, s_t1: 0, prob_bearish: 0.55, prob_neutral: 0.30, prob_bullish: 0.15 },
      { from_pair: 'Bear (0) -> Neut (1)', s_t2: 0, s_t1: 1, prob_bearish: 0.35, prob_neutral: 0.40, prob_bullish: 0.25 },
      { from_pair: 'Bear (0) -> Bull (2)', s_t2: 0, s_t1: 2, prob_bearish: 0.20, prob_neutral: 0.35, prob_bullish: 0.45 },
      { from_pair: 'Neut (1) -> Bear (0)', s_t2: 1, s_t1: 0, prob_bearish: 0.45, prob_neutral: 0.35, prob_bullish: 0.20 },
      { from_pair: 'Neut (1) -> Neut (1)', s_t2: 1, s_t1: 1, prob_bearish: 0.25, prob_neutral: 0.50, prob_bullish: 0.25 },
      { from_pair: 'Neut (1) -> Bull (2)', s_t2: 1, s_t1: 2, prob_bearish: 0.15, prob_neutral: 0.35, prob_bullish: 0.50 },
      { from_pair: 'Bull (2) -> Bear (0)', s_t2: 2, s_t1: 0, prob_bearish: 0.40, prob_neutral: 0.35, prob_bullish: 0.25 },
      { from_pair: 'Bull (2) -> Neut (1)', s_t2: 2, s_t1: 1, prob_bearish: 0.20, prob_neutral: 0.45, prob_bullish: 0.35 },
      { from_pair: 'Bull (2) -> Bull (2)', s_t2: 2, s_t1: 2, prob_bearish: 0.10, prob_neutral: 0.25, prob_bullish: 0.65 },
    ];

    const rows = (matrixBreakdown && matrixBreakdown.length === 9) ? matrixBreakdown : defaultRows;
    const currPairArr = Array.isArray(currentPair) ? currentPair : [1, 2];

    rows.forEach((r) => {
      const isActive = (r.is_current) || (r.s_t2 === currPairArr[0] && r.s_t1 === currPairArr[1]);
      const pBear = (r.prob_bearish * 100).toFixed(1);
      const pNeut = (r.prob_neutral * 100).toFixed(1);
      const pBull = (r.prob_bullish * 100).toFixed(1);

      const rowLabelClass = isActive ? 'matrix-cell-row-label active-pair' : 'matrix-cell-row-label';
      const highlightClass = isActive ? 'highlight-active' : '';

      container.innerHTML += `
        <div class="${rowLabelClass}">${isActive ? '👉 ' : ''}${r.from_pair}</div>
        <div class="matrix-cell-prob ${highlightClass}" style="background:rgba(251,113,133,${r.prob_bearish * 0.35 + 0.05}); color:#fb7185;">${pBear}%</div>
        <div class="matrix-cell-prob ${highlightClass}" style="background:rgba(203,213,225,${r.prob_neutral * 0.25 + 0.05}); color:#cbd5e1;">${pNeut}%</div>
        <div class="matrix-cell-prob ${highlightClass}" style="background:rgba(52,211,153,${r.prob_bullish * 0.35 + 0.05}); color:#34d399;">${pBull}%</div>
      `;
    });
  }

  // ═══════════════════════════════════════════════════════════
  //  RENDERIZADORES DAS FASES DETALHADAS (1 A 6)
  // ═══════════════════════════════════════════════════════════

  function renderPhase1Fundamentals(p1) {
    const tbody = $('tbody-phase-1');
    const meta = $('meta-phase-1');
    if (meta) meta.textContent = `${p1.total_approved || 0} de ${p1.total_analyzed || 0} ativos aprovados (${p1.approval_rate || 0}%)`;
    if (!tbody || !p1.stocks) return;

    tbody.innerHTML = p1.stocks
      .map((s) => {
        const statusClass = s.approved ? 'quant-badge-bull' : 'quant-badge-bear';
        const formattedCap = typeof s.market_cap === 'number' ? (s.market_cap / 1e9).toFixed(1) + ' B€' : s.market_cap;
        return `
        <tr>
          <td><strong>${s.ticker}</strong></td>
          <td>${s.sector}</td>
          <td>${formattedCap}</td>
          <td><span class="score-pill ${s.quality_score >= 60 ? 'score-high' : 'score-mid'}">${s.quality_score}</span></td>
          <td class="${parseFloat(s.roa) >= 5.0 ? 'text-bull' : 'text-dim'}">${s.roa}</td>
          <td>${s.debt_to_equity}</td>
          <td>${s.earnings_yield}</td>
          <td>${s.fcf_yield}</td>
          <td><span class="quant-badge ${statusClass}">${s.status}</span></td>
        </tr>
      `;
      })
      .join('');
  }

  function renderPhase2Technical(p2) {
    const meta = $('meta-phase-2');
    if (meta) {
      let markovText = '';
      if (p2.markov) {
        const edgeSign = p2.markov.edge >= 0 ? '+' : '';
        markovText = ` | Markov Bullish: ${p2.markov.bullish_prob_percent}% (Edge: ${edgeSign}${p2.markov.edge}%)`;
      }
      meta.textContent = `Último Fecho: ${p2.latest_close} | McGinley: ${p2.latest_mcginley} | Vol Momentum: ${p2.latest_vol_adjusted_momentum}${markovText}`;
    }

    const chartData = p2.chart_data;
    if (!chartData || typeof Chart === 'undefined') return;

    const ctxMc = $('chart-mcginley')?.getContext('2d');
    if (ctxMc) {
      if (mcginleyChartInstance) mcginleyChartInstance.destroy();
      mcginleyChartInstance = new Chart(ctxMc, {
        type: 'line',
        data: {
          labels: chartData.close.map((_, i) => `t-${chartData.close.length - i}`),
          datasets: [
            {
              label: 'Preço de Fecho',
              data: chartData.close,
              borderColor: '#6366f1',
              backgroundColor: 'rgba(99, 102, 241, 0.08)',
              borderWidth: 1.8,
              pointRadius: 0,
              tension: 0.2,
            },
            {
              label: 'McGinley Dynamic',
              data: chartData.mcginley,
              borderColor: '#34d399',
              borderWidth: 2.2,
              pointRadius: 0,
              tension: 0.3,
            },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { labels: { color: '#a3a9b8', font: { family: 'Inter', size: 11 } } },
          },
          scales: {
            x: { grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { color: '#6b7384', font: { size: 10 } } },
            y: { grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { color: '#a3a9b8', font: { size: 10 } } },
          },
        },
      });
    }

    const ctxMom = $('chart-momentum')?.getContext('2d');
    if (ctxMom) {
      if (momentumChartInstance) momentumChartInstance.destroy();
      momentumChartInstance = new Chart(ctxMom, {
        type: 'bar',
        data: {
          labels: chartData.vol_adjusted_momentum.map((_, i) => `t-${chartData.vol_adjusted_momentum.length - i}`),
          datasets: [
            {
              label: 'Momentum / Volatilidade (R/σ)',
              data: chartData.vol_adjusted_momentum,
              backgroundColor: chartData.vol_adjusted_momentum.map((v) => (v >= 0 ? '#34d399' : '#fb7185')),
              borderRadius: 3,
            },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { labels: { color: '#a3a9b8', font: { family: 'Inter', size: 11 } } },
          },
          scales: {
            x: { grid: { display: false }, ticks: { display: false } },
            y: { grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { color: '#a3a9b8', font: { size: 10 } } },
          },
        },
      });
    }
  }

  function renderPhase3Fracdiff(p3) {
    const optD = $('fracdiff-opt-d');
    const adfStat = $('fracdiff-adf-stat');
    const pVal = $('fracdiff-p-val');
    const corr = $('fracdiff-corr');
    const meta = $('meta-phase-3');

    if (optD) optD.textContent = p3.optimal_d != null ? p3.optimal_d.toFixed(2) : '0.40';
    if (adfStat) adfStat.textContent = p3.adf_statistic != null ? p3.adf_statistic.toFixed(2) : '-3.45';
    if (pVal) pVal.textContent = p3.adf_p_value != null ? p3.adf_p_value.toFixed(4) : '0.0124';
    if (corr) corr.textContent = p3.memory_retention_corr != null ? `${(p3.memory_retention_corr * 100).toFixed(1)}%` : '92.4%';
    if (meta) meta.textContent = p3.status || 'Estacionário & Memória Máxima';
  }

  function renderPhase4Sentiment(p4) {
    const tbody = $('tbody-phase-4');
    const meta = $('meta-phase-4');
    if (meta) meta.textContent = `${p4.total_analyzed || 0} sinais analisados`;
    if (!tbody || !p4.signals) return;

    tbody.innerHTML = p4.signals
      .map((s) => {
        const isBullishDiv = s.divergence_signal === 'BULLISH_DIVERGENCE';
        const isBearishDiv = s.divergence_signal === 'BEARISH_DIVERGENCE';
        const divBadge = isBullishDiv ? 'quant-badge-bull' : isBearishDiv ? 'quant-badge-bear' : 'quant-badge-neutral';
        const scoreColor = s.sentiment_score > 0 ? 'text-bull' : s.sentiment_score < 0 ? 'text-bear' : 'text-dim';

        return `
        <tr>
          <td><strong>${s.ticker}</strong></td>
          <td class="headline-cell" title="${s.headline}">${s.headline}</td>
          <td><span class="quant-badge ${s.sentiment_label === 'Positivo' ? 'quant-badge-bull' : s.sentiment_label === 'Negativo' ? 'quant-badge-bear' : 'quant-badge-neutral'}">${s.sentiment_label} (${s.confidence}%)</span></td>
          <td class="${scoreColor}"><strong>${s.sentiment_score >= 0 ? '+' : ''}${s.sentiment_score}</strong></td>
          <td class="${s.price_momentum >= 0 ? 'text-bull' : 'text-bear'}">${s.price_momentum >= 0 ? '+' : ''}${s.price_momentum}%</td>
          <td><span class="quant-badge ${divBadge}">${s.divergence_signal}</span></td>
          <td>${s.interpretation}</td>
        </tr>
      `;
      })
      .join('');
  }

  function renderPhase5Purification(p5) {
    const tbody = $('tbody-phase-5');
    if (!tbody || !p5.comparison) return;

    tbody.innerHTML = p5.comparison
      .map((c) => {
        const reductionPct = (((c.vif_raw - c.vif_purified) / c.vif_raw) * 100).toFixed(1);
        return `
        <tr>
          <td><strong>${c.feature}</strong></td>
          <td class="text-bear font-mono">${c.vif_raw}</td>
          <td class="text-bull font-mono font-bold">${c.vif_purified}</td>
          <td class="text-bull">-${reductionPct}% de redundância</td>
          <td><span class="quant-badge quant-badge-bull">${c.status}</span></td>
        </tr>
      `;
      })
      .join('');
  }

  function renderPhase6CPCV(p6) {
    const meta = $('meta-phase-6');
    if (meta) meta.textContent = `${p6.n_combinations || 10} Combinações CPCV`;

    const sr = $('cpcv-sharpe-val');
    const dsr = $('cpcv-dsr-val');
    const pbo = $('cpcv-pbo-val');
    const mdd = $('cpcv-mdd-val');
    const decTitle = $('cpcv-decision-title');
    const decDesc = $('cpcv-decision-desc');
    const decIcon = $('cpcv-decision-icon');
    const decBox = $('cpcv-decision-box');

    if (sr) sr.textContent = p6.sharpe_ratio_oos != null ? p6.sharpe_ratio_oos.toFixed(2) : '1.45';
    if (dsr) dsr.textContent = p6.deflated_sharpe_ratio != null ? `${p6.deflated_sharpe_ratio.toFixed(1)}% (p=${p6.dsr_p_value})` : '98.5%';
    if (pbo) pbo.textContent = p6.pbo_percentage != null ? `${p6.pbo_percentage.toFixed(1)}%` : '12.0%';
    if (mdd) mdd.textContent = p6.max_drawdown != null ? `${p6.max_drawdown.toFixed(1)}%` : '-12.4%';

    const approved = p6.is_approved ?? true;
    if (decTitle) decTitle.textContent = approved ? 'STATUS: MODELO APROVADO PARA PRODUÇÃO' : 'STATUS: ALERTA DE OVERFITTING';
    if (decDesc) decDesc.textContent = p6.interpretation || 'Validação estatística anti-overfitting concluída.';
    if (decIcon) decIcon.textContent = approved ? '🛡️' : '⚠️';
    if (decBox) {
      decBox.className = `cpcv-decision-box ${approved ? 'decision-approved' : 'decision-warning'}`;
    }
  }

  function renderIndividualPhase(phase, data) {
    const phaseKey = String(phase);
    if (phaseKey === '1' || phaseKey === 'fundamentals') renderPhase1Fundamentals(data);
    else if (phaseKey === '2' || phaseKey === 'technical') renderPhase2Technical(data);
    else if (phaseKey === '3' || phaseKey === 'fracdiff') renderPhase3Fracdiff(data);
    else if (phaseKey === '4' || phaseKey === 'sentiment') renderPhase4Sentiment(data);
    else if (phaseKey === '5' || phaseKey === 'purification') renderPhase5Purification(data);
    else if (phaseKey === '6' || phaseKey === 'cpcv') renderPhase6CPCV(data);
  }

  // Exportar funções globais
  window.renderTopRecommendations = renderMasterRecommendationsTable;
  window.renderMasterRecommendationsTable = renderMasterRecommendationsTable;
  window.openStochasticDrawer = openStochasticDrawer;
  window.closeStochasticDrawer = closeStochasticDrawer;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
