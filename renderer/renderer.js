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
  let seeds = {};
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

  function isIndexFullyAdded(indexId) {
    const localList = (seeds && seeds[indexId]) || [];
    if (localList.length > 0) {
      return localList.every(t => isInWatchlist(t.ticker));
    }
    return false;
  }

  function renderSuggestions(res, query) {
    const indices = (res && res.indices) || [];
    const tickers = (res && res.tickers) || [];
    if (indices.length === 0 && tickers.length === 0) {
      suggestionsEl.innerHTML = `<div class="suggestion-empty">Sem resultados para "${escapeHtml(query)}"</div>`;
      suggestionsEl.hidden = false;
      return;
    }
    suggestionsEl.innerHTML = '';

    if (indices.length > 0) {
      const header = document.createElement('div');
      header.className = 'suggestion-section-header';
      header.innerHTML = '<span class="section-icon">📊</span> Índices';
      suggestionsEl.appendChild(header);

      for (const idx of indices) {
        const div = document.createElement('div');
        div.className = 'suggestion suggestion-index';
        div.dataset.id = idx.id;
        const isAdded = isIndexFullyAdded(idx.id);
        if (isAdded) div.classList.add('is-added');
        const countLabel = idx.count != null
          ? `${idx.count} ações`
          : 'não disponível';
        div.innerHTML = `
          <span class="suggestion-index-flag flag">${escapeHtml(idx.flag)}</span>
          <span class="suggestion-index-name">
            <span class="suggestion-index-title">${escapeHtml(idx.name)}</span>
            <span class="suggestion-index-country">${escapeHtml(idx.country || '')}</span>
          </span>
          <span class="suggestion-count">${countLabel}</span>
          <button class="suggestion-add">${isAdded ? 'Adicionado' : 'Adicionar todos'}</button>
        `;
        if (!isAdded) {
          const add = () => addIndexToWatchlist(idx);
          div.querySelector('.suggestion-add').addEventListener('click', (e) => { e.stopPropagation(); add(); });
          div.addEventListener('click', add);
        }
        suggestionsEl.appendChild(div);
      }
    }

    if (tickers.length > 0) {
      if (indices.length > 0) {
        const header = document.createElement('div');
        header.className = 'suggestion-section-header';
        header.innerHTML = '<span class="section-icon">📈</span> Ações';
        suggestionsEl.appendChild(header);
      }
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
      const res = await window.api.searchTicker(query);
      if (seq !== searchSeq) return;
      if (!res || !res.ok) {
        renderSuggestions({ indices: [], tickers: [] }, query);
      } else {
        renderSuggestions(res, query);
      }
    } catch (err) {
      if (seq !== searchSeq) return;
      suggestionsEl.innerHTML = `<div class="suggestion-empty">Erro: ${escapeHtml(err.message || String(err))}</div>`;
      suggestionsEl.hidden = false;
    }
  }

  async function addIndexToWatchlist(idx) {
    const indexId = idx.id;
    const indexName = idx.name || indexId;
    const localList = (seeds && seeds[indexId]) || [];

    if (localList.length === 0) {
      status.textContent = `Lista de ${indexName} não disponível. Adiciona tickers individuais pela pesquisa.`;
      return;
    }

    let added = 0;
    let lastAdded = null;
    for (const t of localList) {
      if (!isInWatchlist(t.ticker)) {
        await addTicker({ ticker: t.ticker, name: t.name || '', index: indexId });
        added++;
        lastAdded = t.ticker;
      }
    }
    if (lastAdded) {
      renderWatchlist(lastAdded);
    }
    status.textContent = added > 0
      ? `Adicionados ${added} tickers de ${indexName} (Yahoo).`
      : `Todos os ${localList.length} tickers de ${indexName} já estavam na watchlist.`;
    hideSuggestions();
  }

  function updateSeedBadges() {
    document.querySelectorAll('.seed-btn').forEach(btn => {
      const idx = btn.dataset.seed;
      const seedList = seeds[idx] || [];
      const countEl = btn.querySelector('.seed-count');
      if (countEl) countEl.textContent = seedList.length;
      btn.classList.toggle('is-added', watchlist.some(t => t.index === idx));
    });
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
    const indices = (res && res.indices) || [];
    const tickers = (res && res.tickers) || [];

    if (indices.length === 0 && tickers.length === 0) {
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

    if (indices.length > 0) {
      const section = document.createElement('div');
      section.className = 'modal-search-section';
      section.innerHTML = `
        <div class="modal-search-section-header">
          <div class="modal-search-section-title">📊 Índices</div>
          <div class="modal-search-section-count">${indices.length}</div>
        </div>
      `;
      for (const idx of indices) {
        const div = document.createElement('div');
        div.className = 'modal-search-result modal-search-result-index';
        const isAdded = isIndexFullyAdded(idx.id);
        if (isAdded) div.classList.add('is-added');
        const countLabel = idx.count != null ? `${idx.count} ações` : 'não disponível';
        div.innerHTML = `
          <span class="modal-search-flag">${escapeHtml(idx.flag)}</span>
          <div class="modal-search-info">
            <div class="modal-search-name">${escapeHtml(idx.name)}</div>
            <div class="modal-search-meta">${escapeHtml(idx.country || '')} · ${countLabel}</div>
          </div>
          <button class="modal-search-add-btn">${isAdded ? 'Adicionado' : 'Adicionar todos'}</button>
        `;
        if (!isAdded) {
          const add = () => addIndexToWatchlist(idx);
          div.querySelector('.modal-search-add-btn').addEventListener('click', (e) => { e.stopPropagation(); add(); });
          div.addEventListener('click', add);
        }
        section.appendChild(div);
      }
      modalSearchResults.appendChild(section);
    }

    if (tickers.length > 0) {
      const section = document.createElement('div');
      section.className = 'modal-search-section';
      section.innerHTML = `
        <div class="modal-search-section-header">
          <div class="modal-search-section-title">📈 Ações</div>
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
  }

  async function doModalSearch(query) {
    const seq = ++modalSearchSeq;
    renderSearchModalLoading();
    try {
      const res = await window.api.searchTicker(query);
      if (seq !== modalSearchSeq) return;
      if (!res || !res.ok) {
        renderSearchModalResults({ indices: [], tickers: [] }, query);
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
        seeds = res.seeds || {};
        watchlist = (res.custom || []).map(t => ({ ...t, index: 'CUSTOM' }));
        renderWatchlist();
        Object.keys(seeds).forEach(idx => {
          const countEl = document.getElementById('seed-count-' + idx);
          if (countEl) countEl.textContent = (seeds[idx] || []).length;
        });
        updateSeedBadges();
      }

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
    updateSeedBadges();
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
        updateSeedBadges();
      }, 180);
    } else {
      watchlist = watchlist.filter(t => t.ticker !== ticker);
      renderWatchlist();
      updateSeedBadges();
    }
    try {
      await window.api.removeTicker(ticker);
    } catch (err) {
      console.warn('removeTicker failed:', err);
    }
  }

  async function addSeed(idx) {
    const seedList = seeds[idx] || [];
    if (seedList.length === 0) return;
    let added = 0;
    for (const t of seedList) {
      if (!isInWatchlist(t.ticker)) {
        await addTicker({ ...t, index: idx });
        added++;
      }
    }
    status.textContent = added > 0
      ? `Adicionados ${added} tickers de ${idx}.`
      : `Todos os tickers de ${idx} já estavam na watchlist.`;
  }

  async function clearAll() {
    if (watchlist.length === 0) return;
    if (!confirm(`Remover todos os ${watchlist.length} tickers da watchlist?`)) return;
    watchlist = [];
    renderWatchlist();
    updateSeedBadges();
    try {
      await window.api.clearTickers();
    } catch (err) {
      console.warn('clearTickers failed:', err);
    }
  }

  function clearTable() {
    body.innerHTML = '<tr class="empty"><td colspan="10">A processar...</td></tr>';
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
    `;
    body.appendChild(tr);
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

  document.querySelectorAll('.seed-btn').forEach(b => {
    b.addEventListener('click', () => addSeed(b.dataset.seed));
  });

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
      const params = {};
      if (!isNaN(edgeVal)) params.edge_threshold = edgeVal;
      if (!isNaN(windowVal)) params.markov_window = windowVal;
      if (!isNaN(horizonVal)) params.horizon_days = horizonVal;
      if (!isNaN(volumeVal)) params.volume_mult = volumeVal;

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
      body.innerHTML = '<tr class="empty"><td colspan="10">Nenhum ativo cumpriu os critérios (Edge ≥ 15%, Volume ≥ 1.2× SMA20, direção válida).</td></tr>';
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

  registerParamChangeListeners();
  loadInitial();
})();
