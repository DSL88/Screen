(function () {
  const btn = document.getElementById('btn-scan');
  const spinner = document.getElementById('spinner');
  const btnLabel = btn.querySelector('.btn-label');
  const status = document.getElementById('status-line');
  const body = document.getElementById('results-body');
  const progressWrap = document.getElementById('progress-wrap');
  const progressFill = document.getElementById('progress-fill');
  const progressText = document.getElementById('progress-text');
  const footerSummary = document.getElementById('footer-summary');

  const searchInput = document.getElementById('ticker-search');
  const searchClear = document.getElementById('search-clear');
  const suggestionsEl = document.getElementById('suggestions');
  const watchlistEl = document.getElementById('watchlist');
  const watchlistEmpty = document.getElementById('watchlist-empty');
  const watchlistCount = document.getElementById('watchlist-count');
  const btnClearAll = document.getElementById('btn-clear-all');

  let watchlist = [];
  let searchDebounceId = null;
  let searchSeq = 0;
  let running = false;
  let totalProcessed = 0;
  let totalEmitted = 0;

  const modalAdd = document.getElementById('modal-add');
  const modalTicker = document.getElementById('modal-ticker');
  const modalName = document.getElementById('modal-name');
  const modalResults = document.getElementById('modal-results');
  const modalError = document.getElementById('modal-error');
  const modalHint = document.getElementById('modal-ticker-hint');
  const modalCloseBtn = document.getElementById('modal-close');
  const modalCancel = document.getElementById('modal-cancel');
  const modalSubmit = document.getElementById('modal-submit');
  let modalSeq = 0;
  let modalSearchDebounce = null;

  const modalSearch = document.getElementById('modal-search');
  const modalSearchInput = document.getElementById('modal-search-input');
  const modalSearchResults = document.getElementById('modal-search-results');
  const modalSearchHint = document.getElementById('modal-search-hint');
  const modalSearchCloseBtn = document.getElementById('modal-search-close');
  const btnOpenSearch = document.getElementById('btn-open-search');
  const btnOpenAddFromSearch = document.getElementById('btn-open-add-from-search');
  let modalSearchSeq = 0;
  let modalSearchDebounceId = null;

  const inputEdge = document.getElementById('input-edge');
  const inputWindow = document.getElementById('input-window');
  const inputHorizon = document.getElementById('input-horizon');
  const inputVolume = document.getElementById('input-volume');
  const inputTimeframe = document.getElementById('input-timeframe');

  const modalBacktest = document.getElementById('modal-backtest');
  const modalBacktestClose = document.getElementById('modal-backtest-close');
  const btnOpenBacktest = document.getElementById('btn-open-backtest');
  const btnRunBacktest = document.getElementById('btn-run-backtest');
  const backtestStartDate = document.getElementById('backtest-start-date');
  const backtestEndDate = document.getElementById('backtest-end-date');
  const backtestLoading = document.getElementById('backtest-loading');
  const backtestResultsPanel = document.getElementById('backtest-results-panel');
  const metricTrades = document.getElementById('metric-trades');
  const metricWinrate = document.getElementById('metric-winrate');
  const metricNetreturn = document.getElementById('metric-netreturn');
  const metricSharpe = document.getElementById('metric-sharpe');
  const metricDrawdown = document.getElementById('metric-drawdown');
  const metricExpectancy = document.getElementById('metric-expectancy');
  const backtestTradesBody = document.getElementById('backtest-trades-body');
  const backtestError = document.getElementById('backtest-error');

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function isInWatchlist(ticker) {
    return watchlist.some(t => t.ticker === ticker);
  }

  function setRunning(state) {
    running = state;
    btn.disabled = state;
    spinner.hidden = !state;
    btnLabel.textContent = state ? 'A analisar...' : 'Iniciar Análise Diária';
  }

  function updateWatchlistCount() {
    watchlistCount.textContent = watchlist.length;
    watchlistEmpty.style.display = watchlist.length === 0 ? 'block' : 'none';
  }

  function renderWatchlist(highlightTicker) {
    const items = watchlistEl.querySelectorAll('.watchlist-item');
    items.forEach(el => el.remove());

    for (const t of watchlist) {
      const item = document.createElement('div');
      item.className = 'watchlist-item';
      item.dataset.ticker = t.ticker;
      if (highlightTicker && t.ticker === highlightTicker) {
        item.classList.add('just-added');
      }
      item.innerHTML = `
        <span class="wl-symbol">${escapeHtml(t.ticker)}</span>
        <span class="wl-name" title="${escapeHtml(t.name || '')}">${escapeHtml(t.name || '')}</span>
        <button class="wl-remove" title="Remover">×</button>
      `;
      item.querySelector('.wl-remove').addEventListener('click', () => removeTicker(t.ticker));
      watchlistEl.appendChild(item);
    }
    updateWatchlistCount();

    if (highlightTicker) {
      const newItem = watchlistEl.querySelector(`.watchlist-item[data-ticker="${CSS.escape(highlightTicker)}"]`);
      if (newItem) {
        newItem.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        setTimeout(() => newItem.classList.remove('just-added'), 1600);
      }
    }
  }

  function renderSuggestions(res, query) {
    const tickers = (res && res.tickers) || [];
    if (tickers.length === 0) {
      suggestionsEl.innerHTML = `<div class="suggestion-empty">Sem resultados para "${escapeHtml(query)}"</div>`;
      suggestionsEl.hidden = false;
      return;
    }
    suggestionsEl.innerHTML = '';

    for (const r of tickers) {
      const div = document.createElement('div');
      div.className = 'suggestion';
      if (isInWatchlist(r.ticker)) div.classList.add('is-added');
      div.innerHTML = `
        <span class="suggestion-symbol">${escapeHtml(r.ticker)}</span>
        <span class="suggestion-name" title="${escapeHtml(r.name)}">${escapeHtml(r.name)}</span>
        ${r.exchange ? `<span class="suggestion-exchange">${escapeHtml(r.exchange)}</span>` : ''}
        <button class="suggestion-add">${isInWatchlist(r.ticker) ? 'Adicionado' : 'Adicionar'}</button>
      `;
      if (!isInWatchlist(r.ticker)) {
        div.querySelector('.suggestion-add').addEventListener('click', (e) => {
          e.stopPropagation();
          addTicker(r);
        });
        div.addEventListener('click', () => addTicker(r));
      }
      suggestionsEl.appendChild(div);
    }
    suggestionsEl.hidden = false;
  }

  function hideSuggestions() {
    suggestionsEl.hidden = true;
    suggestionsEl.innerHTML = '';
  }

  function renderLoading() {
    suggestionsEl.innerHTML = '<div class="suggestion-loading">A pesquisar...</div>';
    suggestionsEl.hidden = false;
  }

  async function doSearch(query) {
    const seq = ++searchSeq;
    renderLoading();
    try {
      const res = await window.api.searchTicker(query, 8);
      if (seq !== searchSeq) return;
      if (!res || !res.ok) {
        renderSuggestions({ tickers: [] }, query);
      } else {
        renderSuggestions(res, query);
      }
    } catch (err) {
      if (seq !== searchSeq) return;
      suggestionsEl.innerHTML = `<div class="suggestion-empty">Erro: ${escapeHtml(err.message || String(err))}</div>`;
      suggestionsEl.hidden = false;
    }
  }

  function openAddModal() {
    if (!modalAdd) return;
    modalAdd.hidden = false;
    showModalError(null);
    modalResults.innerHTML = '<div class="modal-result-empty">Escreve um símbolo para ver sugestões.</div>';
    modalHint.className = 'form-hint';
    modalHint.textContent = '';
    setTimeout(() => modalTicker.focus(), 50);
  }

  function closeAddModal() {
    if (!modalAdd) return;
    modalAdd.hidden = true;
    modalTicker.value = '';
    modalName.value = '';
    modalResults.innerHTML = '<div class="modal-result-empty">Escreve um símbolo para ver sugestões.</div>';
    modalError.hidden = true;
    modalHint.className = 'form-hint';
    modalHint.textContent = '';
  }

  function validateTickerSymbol(s) {
    if (!s) return { valid: false, msg: 'Símbolo é obrigatório' };
    if (s.length > 15) return { valid: false, msg: 'Máximo 15 caracteres' };
    if (!/^[A-Z0-9.\-^]{1,15}$/.test(s)) return { valid: false, msg: 'Apenas letras, números, . - ^' };
    if (isInWatchlist(s)) return { valid: false, msg: `${s} já está na watchlist` };
    return { valid: true };
  }

  function showModalHint(state, msg) {
    if (!modalHint) return;
    modalHint.className = 'form-hint ' + (state === 'valid' ? 'is-valid' : state === 'invalid' ? 'is-invalid' : '');
    modalHint.textContent = msg || '';
  }

  function showModalError(msg) {
    if (!modalError) return;
    if (msg) {
      modalError.textContent = msg;
      modalError.hidden = false;
    } else {
      modalError.hidden = true;
    }
  }

  async function submitAddModal() {
    showModalError(null);
    const raw = modalTicker.value.trim().toUpperCase();
    const v = validateTickerSymbol(raw);
    if (!v.valid) {
      showModalError(v.msg);
      showModalHint('invalid', v.msg);
      modalTicker.focus();
      return;
    }
    const name = (modalName.value || '').trim() || raw;
    await addTicker({ ticker: raw, name, index: 'CUSTOM' });
    status.textContent = `${raw} adicionado à watchlist.`;
    closeAddModal();
  }

  function renderModalResults(tickers) {
    if (!tickers || tickers.length === 0) {
      modalResults.innerHTML = '<div class="modal-result-empty">Sem resultados para esta pesquisa.</div>';
      return;
    }
    modalResults.innerHTML = '';
    for (const t of tickers) {
      const div = document.createElement('div');
      div.className = 'modal-result';
      div.innerHTML = `
        <span class="modal-result-ticker">${escapeHtml(t.ticker)}</span>
        <span class="modal-result-name" title="${escapeHtml(t.name)}">${escapeHtml(t.name)}</span>
        ${t.exchange ? `<span class="modal-result-exchange">${escapeHtml(t.exchange)}</span>` : ''}
      `;
      div.addEventListener('click', () => {
        modalTicker.value = t.ticker;
        modalName.value = t.name;
        showModalHint('valid', '✓');
        modalResults.innerHTML = '';
      });
      modalResults.appendChild(div);
    }
  }

  async function modalLiveSearch(query) {
    const seq = ++modalSeq;
    if (!query || query.length === 0) {
      modalResults.innerHTML = '<div class="modal-result-empty">Escreve um símbolo para ver sugestões.</div>';
      return;
    }
    modalResults.innerHTML = '<div class="modal-result-loading">A pesquisar no Yahoo...</div>';
    try {
      const res = await window.api.searchTicker(query);
      if (seq !== modalSeq) return;
      const tickers = (res && res.tickers) || [];
      renderModalResults(tickers);
    } catch (err) {
      if (seq !== modalSeq) return;
      modalResults.innerHTML = `<div class="modal-result-empty">Erro: ${escapeHtml(err.message || String(err))}</div>`;
    }
  }

  if (modalCloseBtn) {
    modalCloseBtn.addEventListener('click', closeAddModal);
  }
  if (modalCancel) {
    modalCancel.addEventListener('click', closeAddModal);
  }
  if (modalSubmit) {
    modalSubmit.addEventListener('click', submitAddModal);
  }
  if (modalAdd) {
    modalAdd.addEventListener('click', (e) => {
      if (e.target === modalAdd) closeAddModal();
    });
  }
  if (modalTicker) {
    modalTicker.addEventListener('input', (e) => {
      let v = e.target.value.toUpperCase().replace(/[^A-Z0-9.\-^]/g, '');
      if (v !== e.target.value) e.target.value = v;
      showModalError(null);
      if (modalSearchDebounce) clearTimeout(modalSearchDebounce);
      if (v.length === 0) {
        modalResults.innerHTML = '<div class="modal-result-empty">Escreve um símbolo para ver sugestões.</div>';
        showModalHint(null);
        return;
      }
      const check = validateTickerSymbol(v);
      if (check.valid) {
        showModalHint('valid', '✓');
      } else {
        showModalHint('invalid', check.msg);
      }
      modalSearchDebounce = setTimeout(() => modalLiveSearch(v), 280);
    });
    modalTicker.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeAddModal();
      else if (e.key === 'Enter') submitAddModal();
    });
  }
  if (modalName) {
    modalName.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeAddModal();
      else if (e.key === 'Enter') submitAddModal();
    });
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modalAdd && !modalAdd.hidden) {
      closeAddModal();
    }
  });

  function openSearchModal() {
    if (!modalSearch) return;
    modalSearch.hidden = false;
    modalSearchInput.value = '';
    modalSearchHint.textContent = 'ESC para fechar';
    setTimeout(() => modalSearchInput.focus(), 50);
    renderSearchModalEmpty();
  }

  function closeSearchModal() {
    if (!modalSearch) return;
    modalSearch.hidden = true;
    if (modalSearchDebounceId) clearTimeout(modalSearchDebounceId);
    modalSearchInput.value = '';
  }

  function renderSearchModalEmpty() {
    modalSearchResults.innerHTML = `
      <div class="modal-search-empty">
        <div class="modal-search-empty-icon">🔍</div>
        <div class="modal-search-empty-title">Começa a escrever para pesquisar</div>
        <div class="modal-search-empty-text">
          Procura por <strong>tickers</strong> (AAPL, NVDA, GALP.LS) ou por <strong>índices/países</strong> (Portugal, Alemanha, FTSE, DAX, Nikkei).
        </div>
        <div class="modal-search-empty-actions">
          <button class="link-btn" id="btn-open-add-from-search">+ Adicionar manualmente</button>
        </div>
      </div>
    `;
    const btn = document.getElementById('btn-open-add-from-search');
    if (btn) btn.addEventListener('click', openAddModal);
  }

  function renderSearchModalLoading() {
    modalSearchResults.innerHTML = '<div class="modal-search-loading">A pesquisar...</div>';
  }

  function renderSearchModalResults(res, query) {
    const tickers = (res && res.tickers) || [];

    if (tickers.length === 0) {
      modalSearchResults.innerHTML = `
        <div class="modal-search-no-results">
          Sem resultados para <strong>"${escapeHtml(query)}"</strong>
          <div style="margin-top: 12px;">
            <button class="link-btn" id="btn-open-add-from-search">+ Adicionar manualmente</button>
          </div>
        </div>
      `;
      const btn = document.getElementById('btn-open-add-from-search');
      if (btn) {
        btn.addEventListener('click', () => {
          closeSearchModal();
          openAddModal();
          if (modalTicker) modalTicker.value = query.toUpperCase();
        });
      }
      return;
    }

    modalSearchResults.innerHTML = '';

    const section = document.createElement('div');
    section.className = 'modal-search-section';
    section.innerHTML = `
      <div class="modal-search-section-header">
        <div class="modal-search-section-title">📈 Resultados</div>
        <div class="modal-search-section-count">${tickers.length}</div>
      </div>
    `;
    for (const r of tickers) {
      const div = document.createElement('div');
      div.className = 'modal-search-result';
      const isAdded = isInWatchlist(r.ticker);
      if (isAdded) div.classList.add('is-added');
      div.innerHTML = `
        <span class="modal-search-symbol">${escapeHtml(r.ticker)}</span>
        <div class="modal-search-info">
          <div class="modal-search-name">${escapeHtml(r.name)}</div>
          <div class="modal-search-meta">${escapeHtml(r.type || '')}</div>
        </div>
        ${r.exchange ? `<span class="modal-search-exchange">${escapeHtml(r.exchange)}</span>` : ''}
        <button class="modal-search-add-btn">${isAdded ? 'Adicionado' : 'Adicionar'}</button>
      `;
      if (!isAdded) {
        const add = () => addTicker(r);
        div.querySelector('.modal-search-add-btn').addEventListener('click', (e) => { e.stopPropagation(); add(); });
        div.addEventListener('click', add);
      }
      section.appendChild(div);
    }
    modalSearchResults.appendChild(section);
  }

  async function doModalSearch(query) {
    const seq = ++modalSearchSeq;
    renderSearchModalLoading();
    try {
      const res = await window.api.searchTicker(query, 8);
      if (seq !== modalSearchSeq) return;
      if (!res || !res.ok) {
        renderSearchModalResults({ tickers: [] }, query);
      } else {
        renderSearchModalResults(res, query);
      }
    } catch (err) {
      if (seq !== modalSearchSeq) return;
      modalSearchResults.innerHTML = `<div class="modal-search-no-results">Erro: ${escapeHtml(err.message || String(err))}</div>`;
    }
  }

  if (btnOpenSearch) {
    btnOpenSearch.addEventListener('click', openSearchModal);
  }
  if (modalSearchCloseBtn) {
    modalSearchCloseBtn.addEventListener('click', closeSearchModal);
  }
  if (modalSearch) {
    modalSearch.addEventListener('click', (e) => {
      if (e.target === modalSearch) closeSearchModal();
    });
  }
  if (modalSearchInput) {
    modalSearchInput.addEventListener('input', (e) => {
      const v = e.target.value.trim();
      modalSearchHint.textContent = v.length === 0 ? 'ESC para fechar' : 'ESC para fechar · ↵ para 1º';
      if (modalSearchDebounceId) clearTimeout(modalSearchDebounceId);
      if (v.length === 0) {
        renderSearchModalEmpty();
        return;
      }
      modalSearchDebounceId = setTimeout(() => doModalSearch(v), 220);
    });
    modalSearchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        closeSearchModal();
      } else if (e.key === 'Enter') {
        const v = e.target.value.trim();
        if (v.length > 0) {
          const firstBtn = modalSearchResults.querySelector('.modal-search-result:not(.is-added) .modal-search-add-btn');
          if (firstBtn) firstBtn.click();
        }
      }
    });
  }
  document.addEventListener('keydown', (e) => {
    if ((e.key === 'Escape') && modalSearch && !modalSearch.hidden) {
      closeSearchModal();
    }
    if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K') && modalSearch && modalSearch.hidden) {
      e.preventDefault();
      openSearchModal();
    }
  });

  async function loadInitial() {
    try {
      const res = await window.api.listTickers();
      if (res && res.ok) {
        watchlist = (res.custom || []).map(t => ({ ...t, index: 'CUSTOM' }));
        renderWatchlist();
      }

      await loadShortcuts();

      const paramsRes = await window.api.getParams();
      if (paramsRes && paramsRes.ok) {
        const p = paramsRes.params;
        if (p) {
          if (inputEdge) inputEdge.value = (p.edge_threshold * 100).toFixed(1);
          if (inputWindow) inputWindow.value = p.markov_window;
          if (inputHorizon) inputHorizon.value = p.horizon_days;
          if (inputVolume) inputVolume.value = p.volume_mult;
        }
      }
    } catch (err) {
      console.warn('loadInitial failed:', err);
    }
  }

  async function addTicker(t) {
    if (isInWatchlist(t.ticker)) {
      status.textContent = `${t.ticker} já está na watchlist.`;
      return;
    }
    const entry = { ticker: t.ticker, name: t.name || '', index: t.index || 'CUSTOM' };
    watchlist.push(entry);
    renderWatchlist(t.ticker);
    status.textContent = `${t.ticker} adicionado à watchlist.`;
    try {
      await window.api.addTicker({ ticker: t.ticker, name: t.name, exchange: t.exchange, type: t.type });
    } catch (err) {
      console.warn('addTicker failed:', err);
    }
  }

  async function removeTicker(ticker) {
    const item = watchlistEl.querySelector(`.watchlist-item[data-ticker="${CSS.escape(ticker)}"]`);
    if (item) {
      item.classList.add('removing');
      setTimeout(() => {
        watchlist = watchlist.filter(t => t.ticker !== ticker);
        renderWatchlist();
      }, 180);
    } else {
      watchlist = watchlist.filter(t => t.ticker !== ticker);
      renderWatchlist();
    }
    try {
      await window.api.removeTicker(ticker);
    } catch (err) {
      console.warn('removeTicker failed:', err);
    }
  }

  async function clearAll() {
    if (watchlist.length === 0) return;
    if (!confirm(`Remover todos os ${watchlist.length} tickers da watchlist?`)) return;
    watchlist = [];
    renderWatchlist();
    try {
      await window.api.clearTickers();
    } catch (err) {
      console.warn('clearTickers failed:', err);
    }
  }

  function clearTable() {
    body.innerHTML = '<tr class="empty"><td colspan="11">A processar...</td></tr>';
  }

  function appendRow(r) {
    const empty = body.querySelector('tr.empty');
    if (empty) empty.remove();
    const tr = document.createElement('tr');
    tr.className = 'flash-in';
    tr.innerHTML = `
      <td class="col-idx">${body.children.length + 1}</td>
      <td class="col-ticker ticker">${escapeHtml(r.ticker)}</td>
      <td class="col-name name">${escapeHtml(r.name || '')}</td>
      <td class="col-dir"><span class="dir-badge dir-${r.direction}">${r.direction}</span></td>
      <td class="col-num edge-val">${(r.edge * 100).toFixed(2)}%</td>
      <td class="col-num pStay-val">${(r.pStay * 100).toFixed(2)}%</td>
      <td class="col-vol ${r.volumeValid ? 'vol-yes' : 'vol-no'}">${r.volumeValid ? 'SIM' : 'NÃO'}</td>
      <td class="col-num price-val">${r.close != null ? r.close.toFixed(2) : '—'}</td>
      <td class="col-num sl-val">${r.stopLoss != null ? r.stopLoss.toFixed(2) : '—'}</td>
      <td class="col-num tp-val">${r.takeProfit != null ? r.takeProfit.toFixed(2) : '—'}</td>
      <td class="col-action"><button class="btn-investir" data-ticker="${escapeHtml(r.ticker)}" data-nome="${escapeHtml(r.name || '')}" data-direcao="${escapeHtml(r.direction)}" data-preco="${r.close}" data-stop="${r.stopLoss}" data-tp="${r.takeProfit}">Investir</button></td>
    `;
    body.appendChild(tr);
    tr.querySelector('.btn-investir').addEventListener('click', (e) => {
      const btn = e.currentTarget;
      openInvestModal({
        ticker: btn.dataset.ticker,
        nome: btn.dataset.nome,
        direcao: btn.dataset.direcao,
        preco_entrada: parseFloat(btn.dataset.preco),
        stop_loss: parseFloat(btn.dataset.stop),
        take_profit: parseFloat(btn.dataset.tp)
      });
    });
  }

  if (searchInput) {
    searchInput.addEventListener('input', (e) => {
      const v = e.target.value.trim();
      if (searchClear) searchClear.hidden = v.length === 0;
      if (searchDebounceId) clearTimeout(searchDebounceId);
      if (v.length === 0) {
        hideSuggestions();
        return;
      }
      searchDebounceId = setTimeout(() => doSearch(v), 280);
    });

    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        hideSuggestions();
        searchInput.blur();
      } else if (e.key === 'Enter') {
        const v = searchInput.value.trim();
        if (v.length === 0) return;
        const indexFirst = suggestionsEl ? suggestionsEl.querySelector('.suggestion-index:not(.is-added)') : null;
        const tickerFirst = suggestionsEl ? suggestionsEl.querySelector('.suggestion:not(.is-added):not(.suggestion-index)') : null;
        if (indexFirst) {
          indexFirst.click();
        } else if (tickerFirst) {
          tickerFirst.click();
        } else if (!isInWatchlist(v)) {
          addTicker({ ticker: v.toUpperCase(), name: v.toUpperCase() });
          searchInput.value = '';
          if (searchClear) searchClear.hidden = true;
          hideSuggestions();
        }
      }
    });
  }

  document.addEventListener('click', (e) => {
    if (suggestionsEl && !suggestionsEl.contains(e.target) && e.target !== searchInput) {
      hideSuggestions();
    }
  });

  if (searchClear) {
    searchClear.addEventListener('click', () => {
      if (searchInput) {
        searchInput.value = '';
        searchInput.focus();
      }
      searchClear.hidden = true;
      hideSuggestions();
    });
  }

  btnClearAll.addEventListener('click', clearAll);

  btn.addEventListener('click', async () => {
    if (running) return;
    if (watchlist.length === 0) {
      status.textContent = 'Adiciona pelo menos um ticker à watchlist.';
      return;
    }

    setRunning(true);
    totalProcessed = 0;
    totalEmitted = 0;
    clearTable();
    progressWrap.hidden = false;
    progressFill.style.width = '0%';
    progressText.textContent = '0 / 0';
    status.textContent = 'A iniciar análise...';

    try {
      const edgeVal = parseFloat(inputEdge?.value) / 100;
      const windowVal = parseInt(inputWindow?.value, 10);
      const horizonVal = parseInt(inputHorizon?.value, 10);
      const volumeVal = parseFloat(inputVolume?.value);
      const timeframeVal = inputTimeframe?.value || '1d';
      const params = {};
      if (!isNaN(edgeVal)) params.edge_threshold = edgeVal;
      if (!isNaN(windowVal)) params.markov_window = windowVal;
      if (!isNaN(horizonVal)) params.horizon_days = horizonVal;
      if (!isNaN(volumeVal)) params.volume_mult = volumeVal;
      params.timeframe = timeframeVal;

      const res = await window.api.startScan(watchlist, params);
      if (!res || !res.ok) {
        status.textContent = 'Erro ao iniciar scanner.';
        setRunning(false);
      }
    } catch (err) {
      status.textContent = 'Erro: ' + (err.message || err);
      setRunning(false);
    }
  });

  window.api.on('scan:progress', (p) => {
    if (p.total > 0) {
      const pct = (p.processed / p.total) * 100;
      progressFill.style.width = pct.toFixed(1) + '%';
      progressText.textContent = `${p.processed} / ${p.total}`;
      status.textContent = `A processar: ${p.currentTicker || ''} (${p.processed}/${p.total})`;
    }
  });

  window.api.on('scan:row', (r) => {
    totalEmitted++;
    appendRow(r);
  });

  window.api.on('scan:error', (e) => {
    console.warn('Scanner error:', e);
  });

  window.api.on('scan:done', (d) => {
    setRunning(false);
    totalProcessed = d.totalProcessed;
    progressFill.style.width = '100%';
    progressText.textContent = `${d.totalProcessed} / ${d.totalProcessed}`;
    status.textContent = `Concluído em ${(d.elapsedMs / 1000).toFixed(1)}s — ${d.totalSignals} sinais.`;
    footerSummary.textContent = `${d.totalSignals} sinais emitidos · ${d.totalProcessed} tickers processados`;
    if (d.totalSignals === 0) {
      body.innerHTML = '<tr class="empty"><td colspan="11">Nenhum ativo cumpriu os critérios (Edge ≥ 15%, Volume ≥ 1.2× SMA20, direção válida).</td></tr>';
    }
  });

  function registerParamChangeListeners() {
    if (inputEdge) {
      inputEdge.addEventListener('change', async (e) => {
        const val = parseFloat(e.target.value) / 100;
        if (!isNaN(val) && val >= 0.05 && val <= 0.5) {
          await window.api.setParam('edge_threshold', val);
          status.textContent = `Edge mínimo atualizado para ${(val*100).toFixed(1)}%.`;
        } else {
          status.textContent = 'Erro: Edge inválido (deve ser entre 5% e 50%).';
        }
      });
    }
    if (inputWindow) {
      inputWindow.addEventListener('change', async (e) => {
        const val = parseInt(e.target.value, 10);
        if (!isNaN(val) && val >= 50 && val <= 252) {
          await window.api.setParam('markov_window', val);
          status.textContent = `Janela Markov atualizada para ${val} dias.`;
        } else {
          status.textContent = 'Erro: Janela inválida (deve ser entre 50 e 252 dias).';
        }
      });
    }
    if (inputHorizon) {
      inputHorizon.addEventListener('change', async (e) => {
        const val = parseInt(e.target.value, 10);
        if (!isNaN(val) && val >= 1 && val <= 20) {
          await window.api.setParam('horizon_days', val);
          status.textContent = `Horizonte atualizado para ${val} dias.`;
        } else {
          status.textContent = 'Erro: Horizonte inválido (deve ser entre 1 e 20 dias).';
        }
      });
    }
    if (inputVolume) {
      inputVolume.addEventListener('change', async (e) => {
        const val = parseFloat(e.target.value);
        if (!isNaN(val) && val >= 0.5 && val <= 5.0) {
          await window.api.setParam('volume_mult', val);
          status.textContent = `Volume Multiplicador atualizado para ${val.toFixed(1)}x.`;
        } else {
          status.textContent = 'Erro: Volume inválido (deve ser entre 0.5x e 5.0x).';
        }
      });
    }
  }

  function openBacktestModal() {
    if (!modalBacktest) return;
    modalBacktest.hidden = false;
    const end = new Date();
    const start = new Date();
    start.setFullYear(start.getFullYear() - 1);
    if (backtestEndDate) backtestEndDate.value = end.toISOString().slice(0, 10);
    if (backtestStartDate) backtestStartDate.value = start.toISOString().slice(0, 10);
    if (backtestResultsPanel) backtestResultsPanel.hidden = true;
    if (backtestError) {
      backtestError.textContent = '';
      backtestError.hidden = true;
    }
  }

  function closeBacktestModal() {
    if (!modalBacktest) return;
    modalBacktest.hidden = true;
  }

  async function runBacktestSimulation() {
    if (backtestError) {
      backtestError.textContent = '';
      backtestError.hidden = true;
    }
    if (backtestResultsPanel) backtestResultsPanel.hidden = true;
    
    if (watchlist.length === 0) {
      if (backtestError) {
        backtestError.textContent = 'A watchlist está vazia. Adicione ativos na sidebar antes de executar o backtest.';
        backtestError.hidden = false;
      }
      return;
    }
    
    const startDate = backtestStartDate ? backtestStartDate.value : '';
    const endDate = backtestEndDate ? backtestEndDate.value : '';
    
    if (!startDate || !endDate) {
      if (backtestError) {
        backtestError.textContent = 'Por favor, selecione as datas de início e fim.';
        backtestError.hidden = false;
      }
      return;
    }
    
    if (startDate > endDate) {
      if (backtestError) {
        backtestError.textContent = 'A data de início deve ser anterior ou igual à data de fim.';
        backtestError.hidden = false;
      }
      return;
    }
    
    if (backtestLoading) backtestLoading.hidden = false;
    if (btnRunBacktest) btnRunBacktest.disabled = true;
    
    try {
      const res = await window.api.backtestScan({
        tickers: watchlist,
        startDate,
        endDate
      });
      
      if (backtestLoading) backtestLoading.hidden = true;
      if (btnRunBacktest) btnRunBacktest.disabled = false;
      
      if (!res || !res.ok) {
        throw new Error(res ? res.error : 'Erro desconhecido');
      }
      
      const r = res.results;
      
      if (metricTrades) metricTrades.textContent = r.totalTrades;
      if (metricWinrate) metricWinrate.textContent = (r.winRate * 100).toFixed(1) + '%';
      if (metricNetreturn) {
        metricNetreturn.textContent = (r.netReturn).toFixed(2) + '%';
        metricNetreturn.style.color = r.netReturn >= 0 ? '#10b981' : '#ef4444';
      }
      if (metricSharpe) metricSharpe.textContent = r.sharpeRatio.toFixed(2);
      if (metricDrawdown) metricDrawdown.textContent = (r.maxDrawdown * 100).toFixed(1) + '%';
      if (metricExpectancy) {
        metricExpectancy.textContent = (r.expectancy * 100).toFixed(2) + '%';
        metricExpectancy.style.color = r.expectancy >= 0 ? '#10b981' : '#ef4444';
      }
      
      if (backtestTradesBody) {
        backtestTradesBody.innerHTML = '';
        if (r.trades.length === 0) {
          backtestTradesBody.innerHTML = '<tr><td colspan="8" class="text-center">Nenhum sinal gerado no período.</td></tr>';
        } else {
          for (const tr of r.trades) {
            const row = document.createElement('tr');
            const sign = tr.profitPct >= 0 ? 'vol-yes' : 'vol-no';
            const profitStr = (tr.profitPct * 100).toFixed(2) + '%';
            row.innerHTML = `
              <td><strong>${escapeHtml(tr.ticker)}</strong></td>
              <td><span class="dir-badge dir-${tr.direction}">${escapeHtml(tr.direction)}</span></td>
              <td>${escapeHtml(tr.entryDate)}</td>
              <td>${escapeHtml(tr.exitDate || 'aberto')}</td>
              <td>${tr.entryPrice != null ? tr.entryPrice.toFixed(2) : '—'}</td>
              <td>${tr.exitPrice != null ? tr.exitPrice.toFixed(2) : '—'}</td>
              <td class="${sign}"><strong>${profitStr}</strong></td>
              <td><span class="dir-badge" style="background: var(--surface-2); border-color: var(--border-strong); color: var(--text-dim); padding: 2px 6px; font-size: 10px;">${escapeHtml(tr.reason)}</span></td>
            `;
            backtestTradesBody.appendChild(row);
          }
        }
      }
      
      if (backtestResultsPanel) backtestResultsPanel.hidden = false;
      
    } catch (err) {
      if (backtestLoading) backtestLoading.hidden = true;
      if (btnRunBacktest) btnRunBacktest.disabled = false;
      if (backtestError) {
        backtestError.textContent = 'Erro no Backtest: ' + (err.message || String(err));
        backtestError.hidden = false;
      }
    }
  }

  if (btnOpenBacktest) btnOpenBacktest.addEventListener('click', openBacktestModal);
  if (modalBacktestClose) modalBacktestClose.addEventListener('click', closeBacktestModal);
  if (btnRunBacktest) btnRunBacktest.addEventListener('click', runBacktestSimulation);
  if (modalBacktest) {
    modalBacktest.addEventListener('click', (e) => {
      if (e.target === modalBacktest) closeBacktestModal();
    });
  }

  // ═══════════════════════════════════════════════════════════
  //  ATALHOS DE MERCADO (pesquisa livre via Yahoo)
  // ═══════════════════════════════════════════════════════════
  const shortcutSearchInput = document.getElementById('ticker-search-input');
  const shortcutSearchBtn = document.getElementById('btn-shortcuts-search');
  const shortcutResultsEl = document.getElementById('shortcuts-results');
  const shortcutGridEl = document.getElementById('shortcuts-grid');
  const shortcutEmptyEl = document.getElementById('shortcuts-empty');

  let shortcuts = [];
  let shortcutSearchSeq = 0;
  let lastShortcutTickers = [];

  function renderShortcuts() {
    if (!shortcutGridEl) return;
    const existing = shortcutGridEl.querySelectorAll('.shortcut-chip');
    existing.forEach(el => el.remove());

    if (shortcuts.length === 0) {
      if (shortcutEmptyEl) shortcutEmptyEl.style.display = 'block';
      return;
    }
    if (shortcutEmptyEl) shortcutEmptyEl.style.display = 'none';

    for (const s of shortcuts) {
      const chip = document.createElement('div');
      chip.className = 'shortcut-chip';
      chip.dataset.ticker = s.ticker;
      chip.title = `Clica para adicionar ${s.ticker} à watchlist. Botão × remove o atalho.`;
      chip.innerHTML = `
        <span class="shortcut-chip-symbol">${escapeHtml(s.ticker)}</span>
        <span class="shortcut-chip-name">${escapeHtml(s.nome || '')}</span>
        ${s.mercado ? `<span class="shortcut-chip-market">${escapeHtml(s.mercado)}</span>` : ''}
        <button class="shortcut-chip-remove" title="Remover atalho">×</button>
      `;
      chip.addEventListener('click', (e) => {
        if (e.target.classList.contains('shortcut-chip-remove')) return;
        addTicker({
          ticker: s.ticker,
          name: s.nome || s.ticker,
          exchange: s.mercado || '',
          type: s.tipo || ''
        });
      });
      chip.querySelector('.shortcut-chip-remove').addEventListener('click', async (e) => {
        e.stopPropagation();
        await removeShortcut(s.ticker);
      });
      shortcutGridEl.appendChild(chip);
    }
  }

  async function loadShortcuts() {
    try {
      const res = await window.api.listShortcuts();
      if (res && res.ok) {
        shortcuts = res.shortcuts || [];
        renderShortcuts();
      }
    } catch (err) {
      console.warn('loadShortcuts failed:', err);
    }
  }

  async function addShortcut(trade) {
    try {
      const res = await window.api.addShortcut({
        ticker: trade.ticker,
        nome: trade.nome || trade.ticker,
        mercado: trade.mercado || trade.exchange || '',
        tipo: trade.tipo || trade.type || ''
      });
      if (!res || !res.ok) {
        status.textContent = 'Erro ao guardar atalho: ' + (res ? res.error : 'desconhecido');
        return;
      }
      status.textContent = `Atalho ${trade.ticker} guardado.`;
      await loadShortcuts();
    } catch (err) {
      status.textContent = 'Erro: ' + (err.message || String(err));
    }
  }

  async function removeShortcut(ticker) {
    try {
      const res = await window.api.removeShortcut(ticker);
      if (res && res.ok) {
        await loadShortcuts();
      }
    } catch (err) {
      console.warn('removeShortcut failed:', err);
    }
  }

  function renderShortcutResults(tickers) {
    if (!shortcutResultsEl) return;
    if (!tickers || tickers.length === 0) {
      shortcutResultsEl.innerHTML = '<div class="shortcuts-empty-results">Sem resultados para esta pesquisa.</div>';
      shortcutResultsEl.hidden = false;
      return;
    }

    shortcutResultsEl.innerHTML = '';
    const addedTickers = new Set(shortcuts.map(s => s.ticker));

    for (const t of tickers) {
      const isAdded = addedTickers.has(t.ticker);
      const div = document.createElement('div');
      div.className = 'shortcut-result' + (isAdded ? ' is-added' : '');
      div.innerHTML = `
        <span class="shortcut-result-symbol">${escapeHtml(t.ticker)}</span>
        <div class="shortcut-result-info">
          <div class="shortcut-result-name">${escapeHtml(t.name || '')}</div>
          <div class="shortcut-result-meta">${escapeHtml(t.exchange || t.type || '')}</div>
        </div>
        <button class="shortcut-result-add">${isAdded ? 'Adicionado' : '➕ Adicionar'}</button>
      `;
      if (!isAdded) {
        const btn = div.querySelector('.shortcut-result-add');
        btn.addEventListener('click', async (e) => {
          e.stopPropagation();
          btn.disabled = true;
          btn.textContent = 'A guardar...';
          await addShortcut({
            ticker: t.ticker,
            nome: t.name || t.ticker,
            mercado: t.exchange || '',
            tipo: t.type || ''
          });
          renderShortcutResults(lastShortcutTickers);
        });
      }
      shortcutResultsEl.appendChild(div);
    }
    shortcutResultsEl.hidden = false;
  }

  function renderShortcutLoading() {
    if (!shortcutResultsEl) return;
    shortcutResultsEl.innerHTML = '<div class="shortcuts-loading">A pesquisar no Yahoo...</div>';
    shortcutResultsEl.hidden = false;
  }

  function renderShortcutError(msg) {
    if (!shortcutResultsEl) return;
    shortcutResultsEl.innerHTML = `<div class="shortcuts-error">${escapeHtml(msg)}</div>`;
    shortcutResultsEl.hidden = false;
  }

  async function doShortcutSearch() {
    if (!shortcutSearchInput || !shortcutResultsEl) return;
    const query = shortcutSearchInput.value.trim();
    if (query.length === 0) {
      shortcutResultsEl.hidden = true;
      shortcutResultsEl.innerHTML = '';
      return;
    }
    const seq = ++shortcutSearchSeq;
    renderShortcutLoading();
    if (typeof status !== 'undefined' && status) {
      status.textContent = `A pesquisar "${query}"...`;
    }
    try {
      const res = await window.api.searchTicker(query, 5);
      if (seq !== shortcutSearchSeq) return;
      if (!res || !res.ok) {
        renderShortcutError(res && res.error ? res.error : 'Erro desconhecido');
        if (typeof status !== 'undefined' && status) {
          status.textContent = 'Erro na pesquisa: ' + (res && res.error ? res.error : 'desconhecido');
        }
        return;
      }
      lastShortcutTickers = res.tickers || [];
      renderShortcutResults(lastShortcutTickers);
      if (typeof status !== 'undefined' && status) {
        const n = lastShortcutTickers.length;
        status.textContent = n > 0
          ? `${n} resultado(s) para "${query}".`
          : `Sem resultados para "${query}".`;
      }
    } catch (err) {
      if (seq !== shortcutSearchSeq) return;
      renderShortcutError(err.message || String(err));
      if (typeof status !== 'undefined' && status) {
        status.textContent = 'Erro: ' + (err.message || String(err));
      }
    }
  }

  if (shortcutSearchBtn) {
    shortcutSearchBtn.addEventListener('click', doShortcutSearch);
  }
  if (shortcutSearchInput) {
    shortcutSearchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        doShortcutSearch();
      } else if (e.key === 'Escape') {
        shortcutResultsEl.hidden = true;
      }
    });
    shortcutSearchInput.addEventListener('input', () => {
      if (shortcutSearchInput.value.trim().length === 0) {
        shortcutResultsEl.hidden = true;
      }
    });
  }
  document.addEventListener('click', (e) => {
    if (!shortcutResultsEl) return;
    if (shortcutResultsEl.hidden) return;
    if (e.target === shortcutSearchInput) return;
    if (e.target === shortcutSearchBtn) return;
    if (shortcutResultsEl.contains(e.target)) return;
    shortcutResultsEl.hidden = true;
  });

  registerParamChangeListeners();
  loadInitial();

  // ═══════════════════════════════════════════════════════════
  //  TABS
  // ═══════════════════════════════════════════════════════════
  const tabBtns = document.querySelectorAll('.tab-btn');
  const tabContents = document.querySelectorAll('.tab-content');

  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      tabBtns.forEach(b => b.classList.remove('active'));
      tabContents.forEach(c => c.classList.remove('active'));
      btn.classList.add('active');
      const target = document.getElementById('tab-' + btn.dataset.tab);
      if (target) target.classList.add('active');
    });
  });

  // ═══════════════════════════════════════════════════════════
  //  MODAL INVESTIR
  // ═══════════════════════════════════════════════════════════
  const modalInvestir = document.getElementById('modal-investir');
  const modalInvestirClose = document.getElementById('modal-investir-close');
  const modalInvestirCancel = document.getElementById('modal-investir-cancel');
  const modalInvestirConfirm = document.getElementById('modal-investir-confirm');
  const investError = document.getElementById('invest-error');
  let currentInvestTrade = null;

  function openInvestModal(trade) {
    if (!modalInvestir) return;
    currentInvestTrade = trade;
    document.getElementById('inv-ticker').textContent = trade.ticker;
    document.getElementById('inv-nome').textContent = trade.nome || trade.ticker;
    document.getElementById('inv-direcao').textContent = trade.direcao;
    document.getElementById('inv-direcao').className = 'invest-value ' + (trade.direcao === 'COMPRA' ? 'invest-bull' : 'invest-bear');
    document.getElementById('inv-preco').textContent = trade.preco_entrada != null ? trade.preco_entrada.toFixed(2) : '—';
    document.getElementById('inv-stop').textContent = trade.stop_loss != null ? trade.stop_loss.toFixed(2) : '—';
    document.getElementById('inv-tp').textContent = trade.take_profit != null ? trade.take_profit.toFixed(2) : '—';
    investError.hidden = true;
    modalInvestir.hidden = false;
    modalInvestirConfirm.disabled = false;
    modalInvestirConfirm.querySelector('.btn-label') && (modalInvestirConfirm.querySelector('.btn-label').textContent = 'Confirmar Investimento');
  }

  function closeInvestModal() {
    if (!modalInvestir) return;
    modalInvestir.hidden = true;
    currentInvestTrade = null;
    investError.hidden = true;
  }

  async function confirmInvest() {
    if (!currentInvestTrade) return;
    investError.hidden = true;
    modalInvestirConfirm.disabled = true;

    try {
      const res = await window.api.addTrade({
        ticker: currentInvestTrade.ticker,
        nome: currentInvestTrade.nome || currentInvestTrade.ticker,
        direcao: currentInvestTrade.direcao,
        preco_entrada: currentInvestTrade.preco_entrada,
        stop_loss: currentInvestTrade.stop_loss,
        take_profit: currentInvestTrade.take_profit
      });

      if (!res || !res.ok) {
        investError.textContent = 'Erro ao registar investimento: ' + (res ? res.error : 'desconhecido');
        investError.hidden = false;
        modalInvestirConfirm.disabled = false;
        return;
      }

      status.textContent = `Investimento em ${currentInvestTrade.ticker} registado com sucesso.`;
      closeInvestModal();
    } catch (err) {
      investError.textContent = 'Erro: ' + (err.message || String(err));
      investError.hidden = false;
      modalInvestirConfirm.disabled = false;
    }
  }

  if (modalInvestirClose) modalInvestirClose.addEventListener('click', closeInvestModal);
  if (modalInvestirCancel) modalInvestirCancel.addEventListener('click', closeInvestModal);
  if (modalInvestirConfirm) modalInvestirConfirm.addEventListener('click', confirmInvest);
  if (modalInvestir) {
    modalInvestir.addEventListener('click', (e) => {
      if (e.target === modalInvestir) closeInvestModal();
    });
  }

  // ═══════════════════════════════════════════════════════════
  //  PORTFOLIO / MONITORIZAÇÃO
  // ═══════════════════════════════════════════════════════════
  const portfolioBody = document.getElementById('portfolio-body');
  const portfolioClosedBody = document.getElementById('portfolio-closed-body');
  const portfolioClosedSection = document.getElementById('portfolio-closed-section');
  const portfolioStatus = document.getElementById('portfolio-status');
  const btnSyncTrades = document.getElementById('btn-sync-trades');
  const btnReanalisar = document.getElementById('btn-reanalisar');

  // Cache local de estados calculados na última reanálise (ticker -> state)
  let lastStatesByTicker = {};
  let lastActiveTrades = [];

  function renderProgresso(trade, state) {
    if (!trade.stop_loss || !trade.take_profit || !trade.preco_entrada) return '<span style="color: var(--text-mute);">—</span>';

    const refPrice = (state && state.preco_atual != null) ? state.preco_atual : trade.preco_entrada;
    const range = Math.abs(trade.take_profit - trade.stop_loss);
    if (range === 0) return '<span style="color: var(--text-mute);">—</span>';

    let pct;
    if (trade.direcao === 'COMPRA') {
      pct = ((refPrice - trade.stop_loss) / range) * 100;
    } else {
      pct = ((trade.stop_loss - refPrice) / range) * 100;
    }
    pct = Math.max(0, Math.min(100, pct));

    return `
      <div class="portfolio-progress-wrap">
        <div class="portfolio-progress-bar">
          <div class="portfolio-progress-fill" style="width:${pct.toFixed(0)}%"></div>
        </div>
        <span class="portfolio-progress-text">${pct.toFixed(0)}%</span>
      </div>
    `;
  }

  function renderAlerta(state) {
    if (!state) {
      return '<span class="alerta-badge alerta-badge-manter">— Sem reanálise —</span>';
    }

    const distStop = state.distancia_stop_pct;
    const distTp = state.distancia_tp_pct;
    const fmt = (n) => (n != null ? n.toFixed(2) + '%' : '—');

    switch (state.status) {
      case 'alerta_stop':
        return `<span class="alerta-badge alerta-badge-stop">⚠️ Próximo do Stop!</span><span class="alerta-dist">dist: ${fmt(distStop)}</span>`;
      case 'alerta_tp':
        return `<span class="alerta-badge alerta-badge-tp">🚀 Quase no Alvo!</span><span class="alerta-dist">dist: ${fmt(distTp)}</span>`;
      case 'alerta_inversao':
        return `<span class="alerta-badge alerta-badge-inversao">🚨 Inversão de Tendência!</span><span class="alerta-dist">Markov → ${escapeHtml(state.current_direction || '?')}</span>`;
      case 'fechado':
        return '<span class="alerta-badge alerta-badge-manter">FECHADO</span>';
      case 'manter':
      default:
        return `<span class="alerta-badge alerta-badge-manter">✓ A manter</span><span class="alerta-dist">SL: ${fmt(distStop)} · TP: ${fmt(distTp)}</span>`;
    }
  }

  function renderPortfolioRow(trade, state) {
    const tr = document.createElement('tr');
    const dirClass = trade.direcao === 'COMPRA' ? 'dir-COMPRA' : 'dir-VENDA';

    // Mapear status para classe de linha
    let rowClass = '';
    if (state) {
      if (state.status === 'alerta_stop') rowClass = 'row-alerta-stop';
      else if (state.status === 'alerta_tp') rowClass = 'row-alerta-tp';
      else if (state.status === 'alerta_inversao') rowClass = 'row-alerta-inversao';
    }
    if (rowClass) tr.classList.add(rowClass);

    const precoAtual = (state && state.preco_atual != null) ? state.preco_atual : trade.preco_atual;
    const resultadoAtual = state && state.resultado_pct_atual != null ? state.resultado_pct_atual : null;
    const resultadoColor = resultadoAtual == null ? 'var(--text-mute)'
      : resultadoAtual >= 0 ? 'var(--bull)' : 'var(--bear)';
    const resultadoText = resultadoAtual != null
      ? (resultadoAtual >= 0 ? '+' : '') + resultadoAtual.toFixed(2) + '%'
      : '—';

    tr.innerHTML = `
      <td class="col-ticker ticker">${escapeHtml(trade.ticker)}</td>
      <td class="col-name name">${escapeHtml(trade.nome || '')}</td>
      <td class="col-dir"><span class="dir-badge ${dirClass}">${escapeHtml(trade.direcao)}</span></td>
      <td class="col-num">${trade.preco_entrada != null ? trade.preco_entrada.toFixed(2) : '—'}</td>
      <td class="col-num sl-val">${trade.stop_loss != null ? trade.stop_loss.toFixed(2) : '—'}</td>
      <td class="col-num tp-val">${trade.take_profit != null ? trade.take_profit.toFixed(2) : '—'}</td>
      <td class="col-num price-val">${precoAtual != null ? precoAtual.toFixed(2) : '—'}</td>
      <td class="col-progresso">${renderProgresso(trade, state)}</td>
      <td class="col-status"><span class="portfolio-status-badge portfolio-status-aberto">ABERTO</span></td>
      <td class="col-alerta">${renderAlerta(state)}</td>
      <td class="col-num" style="color: ${resultadoColor}; font-weight: 600;">${resultadoText}</td>
    `;
    return tr;
  }

  function renderClosedPortfolioRow(trade) {
    const tr = document.createElement('tr');
    const dirClass = trade.direcao === 'COMPRA' ? 'dir-COMPRA' : 'dir-VENDA';
    const resultColor = (trade.resultado_pct || 0) >= 0 ? 'var(--bull)' : 'var(--bear)';
    const resultText = trade.resultado_pct != null ? (trade.resultado_pct * 100).toFixed(2) + '%' : '—';
    const motivoLabel = trade.motivo_fecho === 'stop_loss' ? 'Stop Loss' : trade.motivo_fecho === 'take_profit' ? 'Take Profit' : (trade.motivo_fecho || 'manual');
    tr.innerHTML = `
      <td class="col-ticker ticker">${escapeHtml(trade.ticker)}</td>
      <td class="col-name name">${escapeHtml(trade.nome || '')}</td>
      <td class="col-dir"><span class="dir-badge ${dirClass}">${escapeHtml(trade.direcao)}</span></td>
      <td class="col-num">${trade.preco_entrada != null ? trade.preco_entrada.toFixed(2) : '—'}</td>
      <td class="col-num">${trade.preco_fecho != null ? trade.preco_fecho.toFixed(2) : '—'}</td>
      <td class="col-num" style="color: ${resultColor}; font-weight: 600;">${resultText}</td>
      <td class="col-motivo"><span class="dir-badge" style="background: var(--surface-2); border-color: var(--border-strong); color: var(--text-dim); padding: 2px 8px; font-size: 10px;">${escapeHtml(motivoLabel)}</span></td>
      <td class="col-data" style="font-family: var(--mono); font-size: 11px; color: var(--text-dim);">${escapeHtml(trade.fechado_em || trade.data_entrada || '')}</td>
    `;
    return tr;
  }

  function renderPortfolioTable() {
    portfolioBody.innerHTML = '';
    if (lastActiveTrades.length === 0) {
      portfolioBody.innerHTML = '<tr class="empty"><td colspan="11">Nenhuma posição ativa. Clique em "Investir" num sinal do scanner para começar.</td></tr>';
      return;
    }
    for (const t of lastActiveTrades) {
      const state = lastStatesByTicker[t.ticker] || null;
      portfolioBody.appendChild(renderPortfolioRow(t, state));
    }
  }

  async function loadPortfolio() {
    try {
      const res = await window.api.listTrades();
      if (!res || !res.ok) {
        portfolioBody.innerHTML = '<tr class="empty"><td colspan="11">Erro ao carregar posições.</td></tr>';
        return;
      }

      lastActiveTrades = res.active || [];
      const closed = res.closed || [];

      renderPortfolioTable();

      portfolioClosedBody.innerHTML = '';
      if (closed.length > 0) {
        portfolioClosedSection.hidden = false;
        closed.forEach(t => portfolioClosedBody.appendChild(renderClosedPortfolioRow(t)));
      } else {
        portfolioClosedSection.hidden = true;
      }

      const hasStates = Object.keys(lastStatesByTicker).length > 0;
      portfolioStatus.textContent = lastActiveTrades.length > 0
        ? `${lastActiveTrades.length} posição(ões) ativa(s) em monitorização.${hasStates ? ' (última reanálise aplicada)' : ''}`
        : 'Posições ativas abertas a partir dos sinais do scanner.';
    } catch (err) {
      portfolioStatus.textContent = 'Erro: ' + (err.message || String(err));
    }
  }

  async function syncTrades() {
    if (!btnSyncTrades) return;
    btnSyncTrades.disabled = true;
    btnSyncTrades.querySelector('span').textContent = 'A sincronizar...';

    try {
      const res = await window.api.updateTrades();
      if (!res || !res.ok) {
        portfolioStatus.textContent = 'Erro na sincronização: ' + (res ? res.error : 'desconhecido');
        return;
      }

      // Atualizar cache de estados com o resultado da reanálise
      if (Array.isArray(res.states)) {
        lastStatesByTicker = {};
        for (const s of res.states) lastStatesByTicker[s.ticker] = s;
      }

      const closedCount = (res.closed && res.closed.length) || 0;
      const alertCount = res.states ? res.states.filter(s => s.status !== 'manter').length : 0;
      const parts = [];
      if (closedCount > 0) parts.push(`${closedCount} trade(s) fechado(s)`);
      if (alertCount > 0) parts.push(`${alertCount} alerta(s) ativo(s)`);
      portfolioStatus.textContent = parts.length > 0
        ? `Sincronização concluída: ${parts.join(', ')}.`
        : (res.message || 'Sincronização concluída. Sem alertas.');

      await loadPortfolio();
    } catch (err) {
      portfolioStatus.textContent = 'Erro: ' + (err.message || String(err));
    } finally {
      btnSyncTrades.disabled = false;
      btnSyncTrades.querySelector('span').textContent = 'Sincronizar Posições';
    }
  }

  async function reanalisarTrades() {
    if (!btnReanalisar) return;
    if (lastActiveTrades.length === 0) {
      portfolioStatus.textContent = 'Sem posições ativas para analisar.';
      return;
    }
    btnReanalisar.disabled = true;
    const originalLabel = btnReanalisar.querySelector('span').textContent;
    btnReanalisar.querySelector('span').textContent = '🔍 A analisar...';

    try {
      // Reutiliza o mesmo endpoint trade:update para não duplicar IPC
      const res = await window.api.updateTrades();
      if (!res || !res.ok) {
        portfolioStatus.textContent = 'Erro na reanálise: ' + (res ? res.error : 'desconhecido');
        return;
      }

      if (Array.isArray(res.states)) {
        lastStatesByTicker = {};
        for (const s of res.states) lastStatesByTicker[s.ticker] = s;
      }

      const alertCount = res.states ? res.states.filter(s => s.status !== 'manter').length : 0;
      const closedCount = (res.closed && res.closed.length) || 0;

      const parts = [];
      parts.push(`Reanálise concluída em ${res.states ? res.states.length : 0} posição(ões).`);
      if (closedCount > 0) parts.push(`${closedCount} trade(s) fechado(s).`);
      if (alertCount > 0) parts.push(`${alertCount} alerta(s) ativo(s).`);
      portfolioStatus.textContent = parts.join(' ');

      // Re-renderizar para aplicar alertas visuais
      renderPortfolioTable();
    } catch (err) {
      portfolioStatus.textContent = 'Erro: ' + (err.message || String(err));
    } finally {
      btnReanalisar.disabled = false;
      btnReanalisar.querySelector('span').textContent = originalLabel;
    }
  }

  if (btnSyncTrades) {
    btnSyncTrades.addEventListener('click', syncTrades);
  }
  if (btnReanalisar) {
    btnReanalisar.addEventListener('click', reanalisarTrades);
  }

  const portfolioTab = document.querySelector('.tab-btn[data-tab="portfolio"]');
  if (portfolioTab) {
    portfolioTab.addEventListener('click', loadPortfolio);
  }
})();
