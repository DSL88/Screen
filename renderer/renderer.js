(function () {
  const btn = document.getElementById('btn-scan');
  const btnCancelScan = document.getElementById('btn-cancel-scan');
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
  if (watchlistEl) {
    watchlistEl.addEventListener('click', (e) => {
      const removeBtn = e.target.closest('.wl-remove');
      const groupHeader = e.target.closest('.watchlist-group-header');
      if (removeBtn || groupHeader) return;

      const item = e.target.closest('.watchlist-item');
      if (item && item.dataset.ticker) {
        openAssetDetailModal(item.dataset.ticker);
      }
    });

    let currentHoverItem = null;

    watchlistEl.addEventListener('mouseover', (e) => {
      const item = e.target.closest('.watchlist-item');
      if (!item || item === currentHoverItem) return;
      currentHoverItem = item;
      if (hoverCard) {
        hoverCardName.textContent = item.dataset.name || item.dataset.ticker || '--';
        hoverCardTicker.textContent = item.dataset.ticker || '--';
        hoverCardFirstDate.textContent = item.dataset.firstDate || 'Sem Registos';
        hoverCard.classList.remove('hidden');
      }
      positionHoverCard(e);
    });

    watchlistEl.addEventListener('mousemove', (e) => {
      if (hoverCard && !hoverCard.classList.contains('hidden')) {
        positionHoverCard(e);
      }
    });

    watchlistEl.addEventListener('mouseout', (e) => {
      if (!hoverCard || hoverCard.classList.contains('hidden')) return;
      const item = e.target.closest('.watchlist-item');
      if (item !== currentHoverItem) return;
      const related = e.relatedTarget;
      if (!related || !item.contains(related)) {
        hoverCard.classList.add('hidden');
        currentHoverItem = null;
      }
    });
  }
  const watchlistEmpty = document.getElementById('watchlist-empty');
  const watchlistCount = document.getElementById('watchlist-count');
  const btnClearAll = document.getElementById('btn-clear-all');
  const myListSearchInput = document.getElementById('mylist-search-input');
  const myListSearchClear = document.getElementById('my-list-search-clear');
  const btnDownloadAllMylist = document.getElementById('btn-download-all-mylist');
  const syncAllSpinner = document.getElementById('sync-all-spinner');
  const freshnessBanner = document.getElementById('freshness-banner');
  const freshnessBannerMessage = document.getElementById('freshness-banner-message');
  const btnFreshnessGoMylist = document.getElementById('btn-freshness-go-mylist');
  const btnFreshnessContinue = document.getElementById('btn-freshness-continue');
  let freshnessOverride = false;
  let expectedTradingDay = null;
  const toastContainer = document.getElementById('toast-container');
  const hoverCard = document.getElementById('stock-hover-card');
  const hoverCardName = document.getElementById('hover-card-name');
  const hoverCardTicker = document.getElementById('hover-card-ticker');
  const hoverCardFirstDate = document.getElementById('hover-card-first-date');
  const selectCountryFilter = document.getElementById('select-country-filter');
  const selectIndexBulkFetch = document.getElementById('select-index-bulk-fetch');
  const btnFetchFirstDate = document.getElementById('btn-update-index-dates');
  const btnDeleteIndex = document.getElementById('btn-delete-index');
  const btnFirstRegisto = document.getElementById('btn-first-registo');
  const btnMostRecent = document.getElementById('btn-most-recent');
  const btnIndexActions = document.getElementById('btn-index-actions');
  const indexActionsDropdown = document.getElementById('index-actions-dropdown');
  const indexStatusBadge = document.getElementById('index-status-badge');
  const btnCancelCountryImport = document.getElementById('btn-cancel-country-import');
  const indexBulkProgress = document.getElementById('index-bulk-progress');
  const indexBulkProgressLabel = document.getElementById('index-bulk-progress-label');
  const indexBulkProgressFill = document.getElementById('index-bulk-progress-fill');

  // IDs are stable application data. Labels are presentation only; never use
  // the translated/friendly label as the group's identity or as a filter key.
  const INDEX_META = {
    PSI: { label: 'PSI (Portugal)', dbNames: ['PSI'] },
    IBEX35: { label: 'IBEX 35 (Espanha)', dbNames: ['IBEX 35', 'IBEX35'] },
    DAX40: { label: 'DAX 40 (Alemanha)', dbNames: ['DAX 40', 'DAX40'] },
    SP500: { label: 'S&P 500 (EUA)', dbNames: ['S&P 500', 'SP500'] },
    CAC40: { label: 'CAC 40 (França)', dbNames: ['CAC 40', 'CAC40'] },
    AEX25: { label: 'AEX 25 (Holanda)', dbNames: ['AEX 25', 'AEX25'] },
    SMI: { label: 'SMI (Suíça)', dbNames: ['SMI'] },
    FTSEMIB: { label: 'FTSE MIB (Itália)', dbNames: ['FTSE MIB', 'FTSEMIB'] },
    FTSE100: { label: 'FTSE 100 (Reino Unido)', dbNames: ['FTSE 100', 'FTSE100'] },
    NIKKEI30: { label: 'Nikkei 225 (Japão)', dbNames: ['Nikkei 225', 'NIKKEI30'] },
    HANGSENG30: { label: 'Hang Seng (Hong Kong)', dbNames: ['Hang Seng', 'HANGSENG30'] },
    BOVESPA: { label: 'Ibovespa (Brasil)', dbNames: ['Ibovespa', 'BOVESPA'] }
  };

  function canonicalIndexId(raw) {
    const value = String(raw || '').trim();
    if (!value) return 'CUSTOM';
    const compact = value
      .replace(/[—–|].*$/, '')
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
    const aliases = {
      IBEX: 'IBEX35', 'IBEX35': 'IBEX35', DAX: 'DAX40', DAX40: 'DAX40',
      'SP500': 'SP500', SP: 'SP500', CAC: 'CAC40', CAC40: 'CAC40',
      AEX: 'AEX25', AEX25: 'AEX25', FTSEMIB: 'FTSEMIB', FTSE100: 'FTSE100',
      NIKKEI: 'NIKKEI30', NIKKEI225: 'NIKKEI30', HANGSENG: 'HANGSENG30',
      HANGSENG30: 'HANGSENG30', BOVESPA: 'BOVESPA', IBOVESPA: 'BOVESPA'
    };
    return aliases[compact] || (INDEX_META[compact] ? compact : compact || 'CUSTOM');
  }

  function indexLabel(indexId, fallback) {
    return (INDEX_META[indexId] && INDEX_META[indexId].label) || fallback || 'Outros Ativos / Manuais';
  }

  function normaliseWatchlistEntry(entry) {
    const rawId = entry && (entry.indexId || entry.index_id || entry.indexName || entry.index_name);
    const id = canonicalIndexId(rawId);
    const rawLabel = entry && (entry.indexName || entry.index_name);
    return {
      ...(entry || {}),
      ticker: String(entry && entry.ticker || '').toUpperCase().trim(),
      indexId: id,
      indexName: indexLabel(id, rawLabel),
      // Kept only for IPC operations that still accept the legacy DB label.
      indexDbName: rawLabel || id
    };
  }

  let countryImport = null;
  const apiUnsubscribers = [];
  let mostRecentActive = false;
  let firstRegistoActive = false;
  const indexStatusCache = new Map();

  function subscribeApiEvent(method, channel, callback) {
    try {
      const subscribe = window.api && window.api[method];
      if (typeof subscribe !== 'function') return;
      const unsubscribe = method === 'on' ? subscribe(channel, callback) : subscribe(callback);
      if (typeof unsubscribe === 'function') apiUnsubscribers.push(unsubscribe);
    } catch (err) {
      console.warn(`Não foi possível subscrever ${channel}:`, err);
    }
  }

  // Contract markers for the single-subscription adapter below:
  // window.api.on('scan:progress', ...), window.api.on('scan:done', ...),
  // window.api.on('sync-all-progress', ...).

  function positionHoverCard(e) {
    if (!hoverCard) return;
    const margin = 15;
    const rect = hoverCard.getBoundingClientRect();
    let x = e.clientX + margin;
    let y = e.clientY + margin;
    if (x + rect.width > window.innerWidth - margin) x = Math.max(margin, e.clientX - rect.width - margin);
    if (y + rect.height > window.innerHeight - margin) y = Math.max(margin, e.clientY - rect.height - margin);
    hoverCard.style.left = x + 'px';
    hoverCard.style.top = y + 'px';
  }

  function filterMyList(query) {
    const term = String(query || '').toLowerCase().trim();
    const items = watchlistEl.querySelectorAll('.watchlist-item');
    const headers = watchlistEl.querySelectorAll('.watchlist-group-header');
    const groups = watchlistEl.querySelectorAll('.watchlist-group-items');
    const cards = watchlistEl.querySelectorAll('.watchlist-group-card');

    if (!term) {
      items.forEach(item => {
        item.classList.remove('is-filtered-out');
      });
      headers.forEach(header => header.classList.remove('is-filtered-out'));
      groups.forEach(group => group.classList.remove('is-filtered-out'));
      cards.forEach(card => card.classList.remove('is-filtered-out'));
      const filterEmptyMsg = watchlistEl.querySelector('.watchlist-filter-empty');
      if (filterEmptyMsg) filterEmptyMsg.remove();
      const wlEmpty = document.getElementById('watchlist-empty');
      if (wlEmpty) wlEmpty.style.display = watchlist.length === 0 ? 'block' : 'none';
      return;
    }

    let visibleCount = 0;
    cards.forEach(card => {
      const groupItems = card.querySelectorAll('.watchlist-item');
      const header = card.querySelector('.watchlist-group-header');
      let groupVisibleCount = 0;

      groupItems.forEach(item => {
        if (item.classList.contains('is-inactive')) {
          item.classList.add('is-filtered-out');
          return;
        }
        const symbol = item.querySelector('.wl-symbol');
        const name = item.querySelector('.wl-name');
        const symbolText = symbol ? symbol.textContent.toLowerCase() : '';
        const nameText = name ? name.textContent.toLowerCase() : '';

        if (symbolText.includes(term) || nameText.includes(term)) {
          item.classList.remove('is-filtered-out');
          groupVisibleCount++;
          visibleCount++;
        } else {
          item.classList.add('is-filtered-out');
        }
      });

      if (groupVisibleCount === 0) {
        card.classList.add('is-filtered-out');
      } else {
        card.classList.remove('is-filtered-out');
      }
    });

    const filterEmptyMsg = watchlistEl.querySelector('.watchlist-filter-empty');
    if (visibleCount === 0) {
      const wlEmpty = document.getElementById('watchlist-empty');
      if (wlEmpty) wlEmpty.style.display = 'none';
      if (!filterEmptyMsg) {
        const emptyDiv = document.createElement('div');
        emptyDiv.className = 'watchlist-filter-empty';
        emptyDiv.textContent = `Nenhum ativo encontrado para "${query}"`;
        watchlistEl.appendChild(emptyDiv);
      } else {
        filterEmptyMsg.textContent = `Nenhum ativo encontrado para "${query}"`;
      }
    } else {
      if (filterEmptyMsg) filterEmptyMsg.remove();
      const wlEmpty = document.getElementById('watchlist-empty');
      if (wlEmpty) wlEmpty.style.display = 'none';
    }
  }

  if (myListSearchInput) {
    myListSearchInput.addEventListener('input', (e) => {
      const v = e.target.value;
      if (myListSearchClear) myListSearchClear.hidden = v.length === 0;
      filterMyList(v);
    });

    myListSearchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        myListSearchInput.value = '';
        if (myListSearchClear) myListSearchClear.hidden = true;
        filterMyList('');
        myListSearchInput.blur();
      }
    });
  }

  if (myListSearchClear) {
    myListSearchClear.addEventListener('click', () => {
      if (myListSearchInput) {
        myListSearchInput.value = '';
        myListSearchInput.focus();
      }
      myListSearchClear.hidden = true;
      filterMyList('');
    });
  }

  let watchlist = [];
  let currentIndexBulkLabel = '';
  let indexDateErrors = 0;
  let searchDebounceId = null;
  let searchSeq = 0;
  let running = false;
  let activeScanRunId = null;
  let activeScanTotal = 0;
  let scanCancelRequested = false;
  let totalProcessed = 0;
  let totalEmitted = 0;
  let scanErrors = []; // Agregação de erros durante o scan
  let scannerRows = []; // Armazenar dados das rows para ordenação
  let currentSort = { column: null, direction: 'asc' }; // Estado de ordenação atual

  const modalAdd = document.getElementById('modal-add');
  const modalTicker = document.getElementById('modal-ticker');
  const modalName = document.getElementById('modal-name');
  const modalCountry = document.getElementById('modal-country');
  const modalIndexSelect = document.getElementById('manual-stock-index') || document.getElementById('modal-index-select');
  const modalIndexCustom = document.getElementById('modal-index-custom');
  const groupCustomIndex = document.getElementById('group-custom-index');
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
    const needle = String(ticker || '').toUpperCase().trim();
    return watchlist.some(t => String(t.ticker || '').toUpperCase().trim() === needle);
  }

  function setRunning(state) {
    running = state;
    btn.disabled = state;
    if (btnCancelScan) {
      btnCancelScan.hidden = !state;
      btnCancelScan.disabled = !state;
    }
    spinner.hidden = !state;
    btnLabel.textContent = state ? 'A analisar...' : 'Iniciar Análise Diária';
  }

  function updateWatchlistCount() {
    watchlistCount.textContent = watchlist.length;
    watchlistEmpty.style.display = watchlist.length === 0 ? 'block' : 'none';
    if (btnClearAll) btnClearAll.disabled = watchlist.length === 0;
  }

  // Track collapsed state per index group
  const collapsedGroups = new Set();

  async function refreshExpectedTradingDay() {
    try {
      const freshness = await window.api.checkListFreshness(null);
      if (freshness && freshness.ok && freshness.expectedDate) {
        const next = String(freshness.expectedDate);
        if (next !== expectedTradingDay) {
          expectedTradingDay = next;
          renderWatchlist();
        }
      }
    } catch (err) {
      console.warn('refreshExpectedTradingDay failed:', err);
    }
  }

  function getCardSyncState(t) {
    if (t.ultimaData && expectedTradingDay) {
      if (t.ultimaData >= expectedTradingDay) return 'card-synced';
      return t.temHistorico ? 'card-outdated' : 'card-pending';
    }
    if (t.fullHistoryFetched) return 'card-synced';
    if (t.temHistorico) return 'card-outdated';
    return 'card-pending';
  }

  function applyCardSyncState(item, t) {
    if (!item) return;
    item.classList.remove('card-pending', 'card-outdated', 'card-synced');
    const syncState = getCardSyncState(t);
    if (syncState) item.classList.add(syncState);
  }

  function renderWatchlist(highlightTicker) {
    const wlEmpty = document.getElementById('watchlist-empty');

    watchlistEl.innerHTML = '';

    if (watchlist.length === 0) {
      if (wlEmpty) {
        wlEmpty.style.display = 'block';
        watchlistEl.appendChild(wlEmpty);
      }
      updateWatchlistCount();
      return;
    }

    const groups = {};
    for (const t of watchlist) {
      const idxId = canonicalIndexId(t.indexId || t.indexName);
      const idxName = indexLabel(idxId, t.indexName);
      if (!groups[idxId]) {
        groups[idxId] = {
          name: idxName,
          items: []
        };
      }
      groups[idxId].items.push(t);
    }

    const sortedGroupKeys = Object.keys(groups).sort((a, b) => {
      if (a === 'CUSTOM') return 1;
      if (b === 'CUSTOM') return -1;
      return groups[a].name.localeCompare(groups[b].name);
    });

    for (const key of sortedGroupKeys) {
      const g = groups[key];
      const isCollapsed = collapsedGroups.has(key);

      const groupCard = document.createElement('div');
      groupCard.className = 'watchlist-group-card';
      groupCard.dataset.groupId = key;

      const header = document.createElement('div');
      header.className = 'watchlist-group-header' + (isCollapsed ? ' is-collapsed' : '');
      header.dataset.groupId = key;
      header.innerHTML = `
        <span class="wl-group-chevron">▾</span>
        <span class="wl-group-title">${escapeHtml(g.name)}</span>
        ${key !== 'CUSTOM' ? `<span class="wl-group-status index-status-badge" data-group-status="${escapeHtml(key)}" hidden></span>` : ''}
        <span class="wl-group-count">${g.items.length}</span>
      `;
      if (key !== 'CUSTOM') {
        const dbName = g.items[0] && (g.items[0].indexDbName || g.items[0].indexName);
        if (dbName) {
          void refreshGroupStatusBadge(key, dbName);
        }
      }
      header.addEventListener('click', () => {
        if (collapsedGroups.has(key)) {
          collapsedGroups.delete(key);
        } else {
          collapsedGroups.add(key);
        }
        renderWatchlist();
      });

      const itemsContainer = document.createElement('div');
      itemsContainer.className = 'watchlist-group-items' + (isCollapsed ? ' is-hidden' : '');

      for (const t of g.items) {
        const item = document.createElement('div');
        const syncState = getCardSyncState(t);
        item.className = 'watchlist-item is-clickable' + (t.inativo ? ' is-inactive' : '') + (syncState ? ' ' + syncState : '');
        item.dataset.ticker = t.ticker;
        item.dataset.name = t.name || t.ticker;
        item.dataset.firstDate = t.first_date
          ? fmtShortDate(t.first_date)
          : (t.temHistorico && t.primeiroRegisto)
            ? fmtShortDate(t.primeiroRegisto)
            : 'Pendente';
        if (highlightTicker && t.ticker === highlightTicker) {
          item.classList.add('just-added');
        }

        const badge = renderHistoryBadgeBadge(t);

        item.innerHTML = `
          <span class="wl-symbol">${escapeHtml(t.ticker)}</span>
          <span class="wl-name" title="${escapeHtml(t.name || '')}">${escapeHtml(t.name || '')}</span>
          ${badge}
          <button class="wl-remove" title="Remover">×</button>
        `;
        item.querySelector('.wl-remove').addEventListener('click', (e) => {
          e.stopPropagation();
          removeTicker(t.ticker);
        });
        itemsContainer.appendChild(item);
      }

      groupCard.appendChild(header);
      groupCard.appendChild(itemsContainer);
      watchlistEl.appendChild(groupCard);
    }

    updateWatchlistCount();

    if (highlightTicker) {
      const newItem = watchlistEl.querySelector(`.watchlist-item[data-ticker="${CSS.escape(highlightTicker)}"]`);
      if (newItem) {
        newItem.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        setTimeout(() => newItem.classList.remove('just-added'), 1600);
      }
    }

    if (myListSearchInput && myListSearchInput.value.trim().length > 0) {
      filterMyList(myListSearchInput.value);
    }
  }

  function fmtShortDate(iso) {
    if (!iso) return '-';
    const [year, month, day] = iso.split('-');
    return `${day}-${month}-${year}`;
  }

  function showToast(message, type = 'success', duration = 4000) {
    if (!toastContainer) return;
    const toast = document.createElement('div');
    toast.className = 'toast toast-' + type;
    toast.innerHTML = `<span class="toast-icon">${type === 'success' ? '✓' : type === 'error' ? '✕' : 'ℹ'}</span><span class="toast-text">${escapeHtml(message)}</span>`;
    toastContainer.appendChild(toast);
    setTimeout(() => {
      toast.classList.add('toast-fadeout');
      setTimeout(() => toast.remove(), 300);
    }, duration);
  }

  function renderHistoryBadgeBadge(t) {
    const firstShown = t.first_date || (t.temHistorico ? t.primeiroRegisto : null);
    const lastShown = t.ultimaData || t.last_date || null;
    const hasData = !!(t.temHistorico || firstShown || lastShown || Number(t.totalVelas) > 0);
    const historyState = t.fullHistoryFetched ? 'full' : hasData ? 'partial' : 'empty';
    const historyLabel = historyState === 'full' ? 'Completo' : historyState === 'partial' ? 'Parcial' : 'Sem dados';
    return `<span class="wl-history-pills" data-ticker="${escapeHtml(t.ticker)}">
      <span class="wl-pill wl-pill-first ${firstShown ? '' : 'wl-pill-empty'}" title="first_date / primeiro registo: ${escapeHtml(firstShown || 'Sem registo')}">${firstShown ? fmtShortDate(firstShown) : '1ª —'}</span>
      <span class="wl-pill wl-pill-last ${lastShown ? '' : 'wl-pill-empty'}" title="last_date / última atualização: ${escapeHtml(lastShown || 'Sem registo')}">${lastShown ? fmtShortDate(lastShown) : 'Últ. —'}</span>
      <span class="wl-pill wl-pill-full wl-pill-history-${historyState}" title="Estado do histórico local: ${historyLabel}">${historyLabel}</span>
    </span>`;
  }

  async function updateWatchlistBadge(ticker, summary) {
    const item = watchlistEl.querySelector(`.watchlist-item[data-ticker="${CSS.escape(ticker)}"]`);
    if (!item) return;
    const oldPills = item.querySelector('.wl-history-pills');
    if (!oldPills) return;

    const wlEntry = watchlist.find(w => w.ticker === String(ticker).toUpperCase());
    if (wlEntry && summary) {
      wlEntry.temHistorico = !!summary.hasData;
      wlEntry.primeiroRegisto = summary.firstDate || null;
      wlEntry.ultimaData = summary.lastDate || null;
      wlEntry.last_date = summary.lastDate || null;
      wlEntry.totalVelas = summary.totalCandles || 0;
      wlEntry.fullHistoryFetched = !!summary.fullHistoryFetched;
    } else if (wlEntry) {
      try {
        const detail = await window.api.getTickerDetail(ticker);
        if (detail && detail.ok && detail.summary) {
          wlEntry.temHistorico = !!detail.summary.hasData;
          wlEntry.primeiroRegisto = detail.summary.firstDate || null;
          wlEntry.ultimaData = detail.summary.lastDate || null;
          wlEntry.last_date = detail.summary.lastDate || null;
          wlEntry.totalVelas = detail.summary.totalCandles || 0;
          wlEntry.fullHistoryFetched = !!detail.summary.fullHistoryFetched;
        }
      } catch (_) { /* ignore */ }
    }

    const updated = watchlist.find(w => w.ticker === ticker);
    if (!updated) return;
    item.dataset.firstDate = updated.first_date
      ? fmtShortDate(updated.first_date)
      : (updated.temHistorico && updated.primeiroRegisto) ? fmtShortDate(updated.primeiroRegisto) : 'Pendente';
    const newHtml = renderHistoryBadgeBadge(updated);
    const temp = document.createElement('div');
    temp.innerHTML = newHtml.trim();
    const newBadge = temp.firstChild;
    oldPills.replaceWith(newBadge);

    applyCardSyncState(item, updated);
  }

  function guessStockMetadata(ticker, exchange) {
    const sym = String(ticker || '').toUpperCase().trim();
    const ex = String(exchange || '').toLowerCase().trim();

    if (sym.endsWith('.LS') || ex.includes('lisbon')) {
      return { country: 'Portugal', indexName: 'PSI' };
    }
    if (sym.endsWith('.MC') || ex.includes('madrid') || ex.includes('bme')) {
      return { country: 'Espanha', indexName: 'IBEX35' };
    }
    if (sym.endsWith('.DE') || ex.includes('xetra') || ex.includes('frankfurt')) {
      return { country: 'Alemanha', indexName: 'DAX40' };
    }
    if (sym.endsWith('.PA') || ex.includes('paris')) {
      return { country: 'França', indexName: 'CAC40' };
    }
    if (sym.endsWith('.AS') || ex.includes('amsterdam')) {
      return { country: 'Holanda', indexName: 'AEX25' };
    }
    if (sym.endsWith('.SW') || ex.includes('six') || ex.includes('zurich')) {
      return { country: 'Suíça', indexName: 'SMI' };
    }
    if (sym.endsWith('.MI') || ex.includes('milan') || ex.includes('borsa italiana')) {
      return { country: 'Itália', indexName: 'FTSEMIB' };
    }
    if (sym.endsWith('.L') || ex.includes('london')) {
      return { country: 'Reino Unido', indexName: 'FTSE100' };
    }
    if (sym.endsWith('.HK') || ex.includes('hong kong')) {
      return { country: 'Hong Kong', indexName: 'HANGSENG30' };
    }
    if (sym.endsWith('.T') || ex.includes('tokyo')) {
      return { country: 'Japão', indexName: 'NIKKEI30' };
    }
    if (sym.endsWith('.SA') || ex.includes('sao paulo')) {
      return { country: 'Brasil', indexName: 'BOVESPA' };
    }

    return { country: 'EUA', indexName: 'SP500' };
  }

  function setModalIndexValue(idxName) {
    if (!modalIndexSelect) return;
    const clean = String(idxName || '').trim().toUpperCase();
    if (!clean) {
      modalIndexSelect.selectedIndex = 0;
      if (groupCustomIndex) groupCustomIndex.hidden = true;
      return;
    }

    const options = Array.from(modalIndexSelect.options);
    const matchedOpt = options.find(opt => opt.value.toUpperCase() === clean);

    if (matchedOpt) {
      modalIndexSelect.value = matchedOpt.value;
      if (groupCustomIndex) groupCustomIndex.hidden = true;
    } else {
      modalIndexSelect.value = 'CUSTOM_NEW';
      if (groupCustomIndex) groupCustomIndex.hidden = false;
      if (modalIndexCustom) modalIndexCustom.value = clean;
    }
  }

  function getSelectedModalIndex() {
    if (!modalIndexSelect) return '';
    if (modalIndexSelect.value === 'CUSTOM_NEW') {
      return modalIndexCustom ? modalIndexCustom.value.trim().toUpperCase() : '';
    }
    return modalIndexSelect.value.trim().toUpperCase();
  }

  function addIndexOptionToSelect(idxName) {
    if (!modalIndexSelect || !idxName) return;
    const clean = idxName.trim().toUpperCase();
    const exists = Array.from(modalIndexSelect.options).some(opt => opt.value.toUpperCase() === clean);
    if (!exists) {
      const opt = document.createElement('option');
      opt.value = clean;
      opt.textContent = clean;
      const customNewOpt = modalIndexSelect.querySelector('option[value="CUSTOM_NEW"]');
      if (customNewOpt) {
        modalIndexSelect.insertBefore(opt, customNewOpt);
      } else {
        modalIndexSelect.appendChild(opt);
      }
    }
  }

  if (modalIndexSelect) {
    modalIndexSelect.addEventListener('change', () => {
      if (modalIndexSelect.value === 'CUSTOM_NEW') {
        if (groupCustomIndex) groupCustomIndex.hidden = false;
        if (modalIndexCustom) modalIndexCustom.focus();
      } else {
        if (groupCustomIndex) groupCustomIndex.hidden = true;
      }
    });
  }

  function promptAddTickerWithIndex(t) {
    if (isInWatchlist(t.ticker)) {
      if (typeof status !== 'undefined' && status) {
        status.textContent = `${t.ticker} já está na watchlist.`;
      }
      return;
    }

    if (modalSearch && !modalSearch.hidden) {
      closeSearchModal();
    }
    hideSuggestions();

    const meta = guessStockMetadata(t.ticker, t.exchange);

    openAddModal();

    if (modalTicker) modalTicker.value = t.ticker;
    if (modalName) modalName.value = t.name || t.ticker;
    if (modalCountry) modalCountry.value = t.country || meta.country || '';
    setModalIndexValue(meta.indexName);

    showModalHint('valid', '✓ Escolhe/confirma o Índice para onde queres enviar a ação.');
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
        const handler = (e) => {
          e.stopPropagation();
          promptAddTickerWithIndex(r);
        };
        div.querySelector('.suggestion-add').addEventListener('click', handler);
        div.addEventListener('click', handler);
      }
      suggestionsEl.appendChild(div);
    }
    suggestionsEl.hidden = false;
  }

  function hideSuggestions() {
    if (suggestionsEl) {
      suggestionsEl.hidden = true;
      suggestionsEl.innerHTML = '';
    }
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

  const PREDEFINED_INDEXES = [
    { id: 'PSI', label: 'PSI (Portugal)' },
    { id: 'IBEX35', label: 'IBEX35 (Espanha)' },
    { id: 'SP500', label: 'SP500 (EUA)' },
    { id: 'EUROSTOXX50', label: 'EUROSTOXX50 (Europa)' },
    { id: 'NASDAQ', label: 'NASDAQ (EUA)' },
    { id: 'DAX40', label: 'DAX40 (Alemanha)' },
    { id: 'CAC40', label: 'CAC40 (França)' },
    { id: 'AEX25', label: 'AEX25 (Holanda)' },
    { id: 'SMI', label: 'SMI (Suíça)' },
    { id: 'BEL20', label: 'BEL20 (Bélgica)' },
    { id: 'OMXS30', label: 'OMXS30 (Suécia)' },
    { id: 'FTSE100', label: 'FTSE100 (Reino Unido)' },
    { id: 'FTSEMIB', label: 'FTSEMIB (Itália)' },
    { id: 'OMXC20', label: 'OMXC20 (Dinamarca)' },
    { id: 'NIKKEI30', label: 'NIKKEI30 (Japão)' },
    { id: 'HANGSENG30', label: 'HANGSENG30 (Hong Kong)' },
    { id: 'BOVESPA', label: 'BOVESPA (Brasil)' },
    { id: 'Outros', label: 'Outros' },
  ];

  function populateIndexDropdown() {
    if (!modalIndexSelect) return;
    const currentIndexes = new Map();
    for (const t of watchlist) {
      const idxId = canonicalIndexId(t.indexId || t.indexName);
      if (idxId && !currentIndexes.has(idxId)) {
        currentIndexes.set(idxId, t.indexName || idxId);
      }
    }
    modalIndexSelect.innerHTML = '';
    const defaultOpt = document.createElement('option');
    defaultOpt.value = '';
    defaultOpt.disabled = true;
    defaultOpt.selected = true;
    defaultOpt.textContent = '-- Seleciona o Índice --';
    modalIndexSelect.appendChild(defaultOpt);
    if (currentIndexes.size > 0) {
      const groupCurrent = document.createElement('optgroup');
      groupCurrent.label = '⭐ Índices Atuais na My List';
      for (const [idxId, idxName] of currentIndexes) {
        const opt = document.createElement('option');
        opt.value = idxId;
        opt.textContent = idxName || idxId;
        groupCurrent.appendChild(opt);
      }
      modalIndexSelect.appendChild(groupCurrent);
    }
    const groupOther = document.createElement('optgroup');
    groupOther.label = '🌐 Outros Índices de Mercado';
    let hasOther = false;
    for (const idx of PREDEFINED_INDEXES) {
      if (!currentIndexes.has(idx.id.toUpperCase())) {
        const opt = document.createElement('option');
        opt.value = idx.id;
        opt.textContent = idx.label;
        groupOther.appendChild(opt);
        hasOther = true;
      }
    }
    if (hasOther) {
      modalIndexSelect.appendChild(groupOther);
    }
    const groupCustom = document.createElement('optgroup');
    groupCustom.label = '➕ Personalizado';
    const customOpt = document.createElement('option');
    customOpt.value = 'CUSTOM_NEW';
    customOpt.textContent = '+ Digitar Novo Índice / Personalizado...';
    groupCustom.appendChild(customOpt);
    modalIndexSelect.appendChild(groupCustom);
  }

  function cleanIndexId(raw) {
    if (!raw) return '';
    let clean = String(raw).trim();
    if (clean.includes('—')) clean = clean.split('—')[1].trim();
    if (clean.includes('–')) clean = clean.split('–')[1].trim();
    if (clean.includes('|')) {
      const parts = clean.split('|');
      clean = parts[1] ? parts[1].trim() : parts[0].trim();
    }
    return clean.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
  }

  function populateIndexBulkFetchDropdown() {
    if (!selectIndexBulkFetch) return;
    const currentIndexes = new Map();
    for (const t of watchlist) {
      const idxId = canonicalIndexId(t.indexId || t.indexName);
      if (!idxId || idxId === 'CUSTOM') continue;
      if (!currentIndexes.has(idxId)) {
        currentIndexes.set(idxId, { label: indexLabel(idxId, t.indexName), dbName: t.indexDbName || t.indexName || idxId });
      }
    }
    const previous = selectIndexBulkFetch.value;
    selectIndexBulkFetch.innerHTML = '';
    const all = document.createElement('option');
    all.value = 'ALL';
    all.textContent = 'Todos os Índices';
    all.selected = true;
    selectIndexBulkFetch.appendChild(all);
    for (const [idxId, idxInfo] of currentIndexes) {
      const opt = document.createElement('option');
      opt.value = idxId;
      opt.textContent = idxInfo.label || idxId;
      opt.dataset.dbName = idxInfo.dbName || idxId;
      selectIndexBulkFetch.appendChild(opt);
    }
    if (previous && previous !== 'ALL' && currentIndexes.has(previous)) {
      selectIndexBulkFetch.value = previous;
    }
  }

  async function refreshIndexStatusBadge() {
    if (!indexStatusBadge || !selectIndexBulkFetch) return;
    const idx = selectIndexBulkFetch.value;
    if (!idx || idx === 'ALL') {
      indexStatusBadge.hidden = true;
      return;
    }
    const selectedOption = selectIndexBulkFetch.selectedOptions && selectIndexBulkFetch.selectedOptions[0];
    const requestIndex = (selectedOption && selectedOption.dataset.dbName) || idx;
    try {
      const auditPromise = typeof window.api.auditIndex === 'function'
        ? window.api.auditIndex(requestIndex)
        : Promise.resolve(null);
      const statusPromise = typeof window.api.checkIndexStatus === 'function'
        ? window.api.checkIndexStatus(requestIndex)
        : Promise.resolve(null);
      const [audit, s] = await Promise.all([auditPromise, statusPromise]);
      const auditOk = !!audit && audit.ok !== false && typeof audit.totalStocks === 'number';
      // Auditoria "1º Registo por Índice": badge verde COMPLETO ou resumo X/Y.
      if (auditOk) {
        if (audit.totalStocks === 0) {
          indexStatusBadge.hidden = true;
          return;
        }
        const fullStatus = (s && s.ok && s.status) || null;
        // COMPLETO exige também a dimensão "recente": todos os ativos com
        // histórico desde a origem E última data >= dia esperado (checkIndexStatus).
        if (audit.pendingCount === 0 && fullStatus === 'COMPLETO') {
          indexStatusBadge.hidden = false;
          indexStatusBadge.textContent = 'COMPLETO';
          indexStatusBadge.className = 'index-status-badge is-complete';
          indexStatusBadge.title = `${audit.completeCount}/${audit.totalStocks} ativos completos`;
          return;
        }
        // Histórico desde a origem OK mas última data desatualizada.
        if (audit.pendingCount === 0 && fullStatus === 'pendente-recente') {
          indexStatusBadge.hidden = false;
          indexStatusBadge.textContent = 'Pendente: Recente';
          indexStatusBadge.className = 'index-status-badge is-pending-recent';
          indexStatusBadge.title = `${audit.completeCount}/${audit.totalStocks} ativos completos desde a origem`;
          return;
        }
        indexStatusBadge.hidden = false;
        indexStatusBadge.textContent = `${audit.completeCount}/${audit.totalStocks} ativos completos`;
        indexStatusBadge.className = 'index-status-badge is-audit-summary';
        indexStatusBadge.title = `${audit.pendingCount} pendente(s) de 1º registo`;
        return;
      }
      // Fallback: estado qualitativo do índice (checkIndexStatus).
      if (s && s.ok && s.status) {
        indexStatusBadge.hidden = false;
        indexStatusBadge.textContent = s.label || s.status;
        indexStatusBadge.className = 'index-status-badge' + (s.status === 'COMPLETO'
          ? ' is-complete'
          : s.status === 'pendente-recente'
            ? ' is-pending-recent'
            : ' is-pending-first');
        return;
      }
      indexStatusBadge.hidden = true;
    } catch (_) {
      indexStatusBadge.hidden = true;
    }
  }

  async function refreshGroupStatusBadge(groupId, dbName) {
    const el = document.querySelector(`.watchlist-group-header[data-group-id="${CSS.escape(groupId)}"] .wl-group-status`);
    if (!el || !dbName) return;
    const cached = indexStatusCache.get(dbName);
    if (cached) {
      applyIndexStatusBadge(el, cached);
      return;
    }
    try {
      const s = await window.api.checkIndexStatus(dbName);
      if (s && s.ok && s.status) {
        indexStatusCache.set(dbName, s);
        applyIndexStatusBadge(el, s);
      } else {
        el.hidden = true;
      }
    } catch (_) {
      el.hidden = true;
    }
  }

  function applyIndexStatusBadge(el, s) {
    if (!el || !s || !s.status) {
      if (el) el.hidden = true;
      return;
    }
    el.hidden = false;
    el.textContent = s.label || s.status;
    el.className = 'wl-group-status index-status-badge' + (s.status === 'COMPLETO'
      ? ' is-complete'
      : s.status === 'pendente-recente'
        ? ' is-pending-recent'
        : ' is-pending-first');
  }

  if (btnFetchFirstDate) {
    btnFetchFirstDate.addEventListener('click', async () => {
      const idx = selectIndexBulkFetch ? selectIndexBulkFetch.value : '';
      if (!idx || idx === 'ALL') { showToast('Seleciona um índice específico para atualizar.', 'error'); return; }
      const selectedOption = selectIndexBulkFetch && selectIndexBulkFetch.selectedOptions && selectIndexBulkFetch.selectedOptions[0];
      const requestIndex = (selectedOption && selectedOption.dataset.dbName) || idx;
      const idxLabel = selectedOption
        ? selectIndexBulkFetch.selectedOptions[0].textContent : idx;
      currentIndexBulkLabel = idxLabel;
      indexDateErrors = 0;
      btnFetchFirstDate.disabled = true;
      if (selectIndexBulkFetch) selectIndexBulkFetch.disabled = true;
      const btnOriginalLabel = btnFetchFirstDate.querySelector('span');
      if (btnOriginalLabel) btnOriginalLabel.textContent = `⏳ [0/...] A atualizar ${idxLabel}...`;
      if (indexBulkProgress) indexBulkProgress.hidden = false;
      if (indexBulkProgressLabel) indexBulkProgressLabel.textContent = `A atualizar 1ª data do índice ${idxLabel}: iniciando...`;
      if (indexBulkProgressFill) indexBulkProgressFill.style.width = '0%';
      if (typeof status !== 'undefined' && status) status.textContent = `A atualizar ${idxLabel}...`;
      try {
        const res = await window.api.updateIndexFirstDates(requestIndex);
        const operationErrors = Number(res && res.errorCount || indexDateErrors || 0);
        if (res && res.success && operationErrors === 0) {
          const updated = res.count ?? res.updatedCount ?? 0;
          const msg = `Primeiras datas atualizadas com sucesso para ${updated} ativos do índice ${idxLabel}!`;
          if (indexBulkProgressLabel) indexBulkProgressLabel.textContent = msg;
          if (indexBulkProgressFill) indexBulkProgressFill.style.width = '100%';
          if (typeof status !== 'undefined' && status) status.textContent = msg;
          if (btnOriginalLabel) btnOriginalLabel.textContent = '✅ Concluído!';
          showToast(msg, 'success');
          await reloadMyListFromDatabase();
        } else if (res && res.success) {
          const processed = res.total || res.count || res.updated || 0;
          const errMsg = `Atualização parcial: ${res.count || res.updated || 0}/${processed} ativos; ${operationErrors} falha(s).`;
          if (indexBulkProgressLabel) indexBulkProgressLabel.textContent = errMsg;
          if (btnOriginalLabel) btnOriginalLabel.textContent = '⚠️ Parcial';
          showToast(errMsg, 'info');
          await reloadMyListFromDatabase();
        } else {
          const errMsg = (res && res.message) || (res && res.error) || 'Erro desconhecido';
          if (indexBulkProgressLabel) indexBulkProgressLabel.textContent = 'Erro: ' + errMsg;
          if (btnOriginalLabel) btnOriginalLabel.textContent = '❌ Falhou';
          showToast('Erro na atualização: ' + errMsg, 'error');
        }
      } catch (err) {
        if (indexBulkProgressLabel) indexBulkProgressLabel.textContent = 'Erro: ' + (err.message || String(err));
        if (btnOriginalLabel) btnOriginalLabel.textContent = '❌ Falhou';
        showToast('Erro na atualização: ' + (err.message || String(err)), 'error');
      } finally {
        setTimeout(() => {
          btnFetchFirstDate.disabled = false;
          if (selectIndexBulkFetch) selectIndexBulkFetch.disabled = false;
          if (btnOriginalLabel) btnOriginalLabel.textContent = 'Atualizar Data';
        }, 3000);
      }
    });
  }

  if (btnDeleteIndex) {
    btnDeleteIndex.addEventListener('click', async () => {
      const idx = selectIndexBulkFetch ? selectIndexBulkFetch.value : '';
      if (!idx || idx === 'ALL') {
        showToast('Seleciona primeiro um índice específico para eliminar.', 'error');
        return;
      }
      const selectedOption = selectIndexBulkFetch && selectIndexBulkFetch.selectedOptions && selectIndexBulkFetch.selectedOptions[0];
      const idxLabel = selectedOption ? selectedOption.textContent : idx;
      const indexId = idx;
      const assets = watchlist.filter(w => canonicalIndexId(w.indexId || w.indexName) === indexId);
      const count = assets.length;

      const ok = await openConfirmModal({
        title: `Eliminar Índice ${idxLabel}`,
        message: `Tens a certeza que desejas apagar o Índice <strong>${escapeHtml(idxLabel)}</strong> e todos os <strong>${count}</strong> ${count === 1 ? 'ativo' : 'ativos'} pertencentes a esta lista? Esta ação irá eliminar o histórico e os metadados associados da base de dados.`,
        confirmLabel: 'Sim, Apagar Tudo',
        cancelLabel: 'Cancelar',
        danger: true
      });
      if (!ok) return;

      btnDeleteIndex.disabled = true;
      const span = btnDeleteIndex.querySelector('span');
      const originalText = span ? span.textContent : btnDeleteIndex.textContent;
      if (span) span.textContent = 'A eliminar...';

      try {
        const res = await window.api.deleteIndexWithStocks(indexId);
        if (!res || !res.ok) {
          const errMsg = (res && res.error) || 'desconhecido';
          showToast('Erro ao eliminar índice: ' + errMsg, 'error');
          if (typeof status !== 'undefined' && status) status.textContent = 'Erro ao eliminar índice: ' + errMsg;
          return;
        }
        const deleted = res.deletedStocksCount || 0;
        const msg = `Índice ${idxLabel} e ${deleted} ${deleted === 1 ? 'ativo' : 'ativos'} eliminados com sucesso.`;
        showToast(msg, 'success');
        if (typeof status !== 'undefined' && status) status.textContent = msg;
        await reloadMyListFromDatabase();
        if (selectIndexBulkFetch) selectIndexBulkFetch.value = 'ALL';
      } catch (err) {
        showToast('Erro ao eliminar índice: ' + (err.message || String(err)), 'error');
        if (typeof status !== 'undefined' && status) status.textContent = 'Erro: ' + (err.message || String(err));
      } finally {
        btnDeleteIndex.disabled = false;
        if (span) span.textContent = originalText;
      }
    });
  }

  if (selectIndexBulkFetch) {
    selectIndexBulkFetch.addEventListener('change', async () => {
      const idx = selectIndexBulkFetch.value;
      if (!idx) return;
      const selectedOption = selectIndexBulkFetch.selectedOptions && selectIndexBulkFetch.selectedOptions[0];
      const requestIndex = (selectedOption && selectedOption.dataset.dbName) || idx;
      try {
        // Auditoria automática do 1º Registo por índice selecionado.
        const [audit, s] = await Promise.all([
          typeof window.api.auditIndex === 'function'
            ? window.api.auditIndex(requestIndex)
            : Promise.resolve(null),
          typeof window.api.checkIndexStatus === 'function'
            ? window.api.checkIndexStatus(requestIndex)
            : Promise.resolve(null)
        ]);
        if (audit && audit.ok !== false && typeof audit.totalStocks === 'number') {
          if (audit.totalStocks === 0) {
            if (typeof status !== 'undefined' && status) status.textContent = 'Nenhum ativo associado ao índice.';
          } else if (audit.pendingCount === 0) {
            if (typeof status !== 'undefined' && status) {
              status.textContent = `Índice ${idx}: ${audit.totalStocks}/${audit.totalStocks} ativos COMPLETOS.`;
            }
          } else {
            if (typeof status !== 'undefined' && status) {
              status.textContent = `Índice ${idx}: ${audit.completeCount}/${audit.totalStocks} ativos completos (${audit.pendingCount} pendentes de 1º registo).`;
            }
          }
        } else if (s && s.ok) {
          if (s.totalStocks === 0) {
            if (typeof status !== 'undefined' && status) status.textContent = 'Nenhum ativo associado ao índice.';
          } else {
            if (typeof status !== 'undefined' && status) {
              status.textContent = s.complete
                ? `Índice ${idx}: ${s.totalStocks}/${s.totalStocks} ativos COMPLETOS.`
                : `Índice ${idx}: ${s.stocksCompleteCount}/${s.totalStocks} ativos completos (${s.label}).`;
            }
          }
        } else if (s && s.error) {
          if (typeof status !== 'undefined' && status) status.textContent = 'Erro: ' + s.error;
        }
      } catch (_) { /* ignora */ }
      await refreshIndexStatusBadge();
    });
  }

  if (selectCountryFilter) {
    function setCountryImportBusy(isBusy) {
      // Country import and index-wide downloads touch the same records. Keep
      // those controls coherent, but do not freeze search, add, purge or the
      // rest of My List.
      [selectCountryFilter, selectIndexBulkFetch, btnFetchFirstDate, btnDeleteIndex]
        .filter(Boolean).forEach(control => { control.disabled = isBusy; });
      if (btnCancelCountryImport) {
        btnCancelCountryImport.hidden = !isBusy;
        btnCancelCountryImport.disabled = !isBusy;
      }
    }

    async function cancelCountryImport() {
      if (!countryImport || countryImport.finished) return;
      countryImport.cancelled = true;
      countryImport.finished = true;
      setCountryImportBusy(false);
      if (indexBulkProgressLabel) indexBulkProgressLabel.textContent = 'Importação cancelada. A terminar operações já iniciadas...';
      if (typeof status !== 'undefined' && status) status.textContent = 'Importação cancelada; não foi anunciado sucesso.';
      showToast('Importação cancelada.', 'info');
    }

    if (btnCancelCountryImport) btnCancelCountryImport.addEventListener('click', cancelCountryImport);

    selectCountryFilter.addEventListener('change', async () => {
      const country = selectCountryFilter.value;
      if (!country) return;

      if (countryImport && !countryImport.finished) return;
      const operation = { country, cancelled: false, finished: false };
      countryImport = operation;
      setCountryImportBusy(true);
      currentIndexBulkLabel = country;
      if (indexBulkProgress) indexBulkProgress.hidden = false;
      if (indexBulkProgressLabel) indexBulkProgressLabel.textContent = `A carregar o índice oficial de ${country}...`;
      if (indexBulkProgressFill) indexBulkProgressFill.style.width = '0%';
      if (typeof status !== 'undefined' && status) status.textContent = `A consultar Yahoo Finance para ${country}...`;

      try {
        const result = await window.api.fetchAndAddCountryIndexStocks(country);
        if (operation.cancelled) return;
        const errors = Array.isArray(result && result.errors) ? result.errors : [];
        const total = Number(result && result.total) || 0;
        const count = Number(result && result.count) || 0;
        const failed = errors.length || Math.max(0, total - count);
        if (result && result.success && count > 0 && failed === 0 && (!total || count >= total)) {
          const message = `${count} ativos de ${result.indexName || country} importados/atualizados para ${country}.`;
          if (indexBulkProgressLabel) indexBulkProgressLabel.textContent = `Concluído: ${message}`;
          if (indexBulkProgressFill) indexBulkProgressFill.style.width = '100%';
          if (typeof status !== 'undefined' && status) status.textContent = message;
          showToast(message, 'success');
        } else if (result && result.success && count > 0) {
          const message = `Importação parcial: ${count}/${total || count} ativos processados; ${failed} falha(s).`;
          if (indexBulkProgressLabel) indexBulkProgressLabel.textContent = message;
          if (indexBulkProgressFill) indexBulkProgressFill.style.width = total ? Math.round(count / total * 100) + '%' : '0%';
          if (typeof status !== 'undefined' && status) status.textContent = message;
          showToast(message, 'info');
        } else {
          const message = (result && result.message) || 'Não foi possível importar o índice do país.';
          if (indexBulkProgressLabel) indexBulkProgressLabel.textContent = 'Erro: ' + message;
          if (typeof status !== 'undefined' && status) status.textContent = 'Falha na importação: ' + message;
          showToast(message, 'error');
        }
      } catch (err) {
        if (operation.cancelled) return;
        const message = err.message || String(err);
        if (indexBulkProgressLabel) indexBulkProgressLabel.textContent = 'Erro: ' + message;
        if (typeof status !== 'undefined' && status) status.textContent = 'Falha na importação: ' + message;
        showToast('Erro na importação: ' + message, 'error');
      } finally {
        // The main process has no cancellation IPC for this legacy operation;
        // the token prevents late progress/results from lying about the UI.
        try { await reloadMyListFromDatabase(); } catch (reloadErr) {
          if (!operation.cancelled && typeof status !== 'undefined' && status) {
            status.textContent = 'Importação concluída, mas falhou o reload da My List: ' + (reloadErr.message || reloadErr);
          }
        }
        operation.finished = true;
        if (countryImport === operation) {
          setCountryImportBusy(false);
          // Resetting the value makes the same country selectable again.
          selectCountryFilter.value = '';
          countryImport = null;
        }
      }
    });
  }

  function openAddModal() {
    if (!modalAdd) return;
    populateIndexDropdown();
    modalAdd.hidden = false;
    showModalError(null);
    if (modalCountry) modalCountry.value = '';
    setModalIndexValue('');
    if (modalIndexCustom) modalIndexCustom.value = '';
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
    if (modalCountry) modalCountry.value = '';
    setModalIndexValue('');
    if (modalIndexCustom) modalIndexCustom.value = '';
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

  function updateIndexDatalist(idxName) {
    const listEl = document.getElementById('index-datalist');
    if (!listEl || !idxName) return;
    const clean = idxName.trim().toUpperCase();
    const exists = Array.from(listEl.options).some(opt => opt.value.toUpperCase() === clean);
    if (!exists) {
      const opt = document.createElement('option');
      opt.value = clean;
      opt.textContent = clean;
      listEl.appendChild(opt);
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

    const name = (modalName ? modalName.value : '').trim();
    if (!name) {
      showModalError('Nome da Empresa é obrigatório.');
      if (modalName) modalName.focus();
      return;
    }

    const country = (modalCountry ? modalCountry.value : '').trim();
    if (!country) {
      showModalError('País é obrigatório.');
      if (modalCountry) modalCountry.focus();
      return;
    }

    const indexName = getSelectedModalIndex();
    if (!indexName) {
      showModalError('Seleção de Índice é obrigatória. Por favor, seleciona um índice da lista.');
      showModalHint('invalid', '⚠️ Seleção de Índice é obrigatória.');
      if (modalIndexSelect) modalIndexSelect.focus();
      return;
    }

    await addTicker({ ticker: raw, name, country, indexName, index: indexName });
    addIndexOptionToSelect(indexName);
    status.textContent = `${raw} (${indexName}) adicionado à watchlist.`;
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
        if (modalCountry) modalCountry.value = t.country || '';
        setModalIndexValue('');
        showModalHint('invalid', '⚠️ Ticker preenchido. Seleciona obrigatoriamente o Índice na caixa de seleção.');
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
        <div class="modal-search-empty-icon" aria-hidden="true"></div>
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
    const all = (res && res.tickers) || [];
    const bulkItems = all.filter(r => r && r.isBulk === true);
    const tickers = all.filter(r => r && !r.isBulk && !/^BULK:/i.test(String(r.ticker || '')));

    if (tickers.length === 0 && bulkItems.length === 0) {
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

    if (bulkItems.length > 0) {
      const bulkSection = document.createElement('div');
      bulkSection.className = 'modal-search-section';
      bulkSection.innerHTML = `
        <div class="modal-search-section-header">
          <div class="modal-search-section-title">🌍 Mercados</div>
          <div class="modal-search-section-count">${bulkItems.length}</div>
        </div>
      `;
      for (const b of bulkItems) {
        const div = document.createElement('div');
        div.className = 'modal-search-result modal-search-bulk';
        div.innerHTML = `
          <span class="modal-search-symbol">${escapeHtml(b.ticker)}</span>
          <div class="modal-search-info">
            <div class="modal-search-name">${escapeHtml(b.name)}</div>
            <div class="modal-search-meta">${escapeHtml(b.exchange || '')} · ${b.bulkCount || 0} componentes</div>
          </div>
          <button class="modal-search-add-btn">Adicionar todas</button>
        `;
        const btnEl = div.querySelector('.modal-search-add-btn');
        const handler = async (e) => {
          if (e) e.stopPropagation();
          btnEl.disabled = true;
          btnEl.textContent = 'A guardar...';
          try {
            const tickerList = Array.isArray(b.bulkTickers) ? b.bulkTickers : [];
            if (tickerList.length === 0) {
              btnEl.textContent = 'Erro';
              btnEl.disabled = false;
              if (typeof status !== 'undefined' && status) {
                status.textContent = 'Erro: lista de componentes vazia para ' + b.bulkId;
              }
              return;
            }
            const r = await window.api.addBulkTickers(tickerList);
            if (r && r.ok) {
              btnEl.textContent = `✓ ${r.count || tickerList.length} na watchlist`;
              div.classList.add('is-added');
              await loadInitial();
              if (typeof status !== 'undefined' && status) {
                status.textContent = `${r.count || tickerList.length} ações de ${b.bulkId} adicionadas à Watchlist.`;
              }
              setTimeout(() => closeSearchModal(), 900);
            } else {
              btnEl.textContent = 'Erro';
              btnEl.disabled = false;
              if (typeof status !== 'undefined' && status) {
                status.textContent = 'Erro: ' + (r && r.error ? r.error : 'desconhecido');
              }
            }
          } catch (err) {
            btnEl.textContent = 'Erro';
            btnEl.disabled = false;
            if (typeof status !== 'undefined' && status) {
              status.textContent = 'Erro: ' + (err && err.message ? err.message : String(err));
            }
          }
        };
        btnEl.addEventListener('click', handler);
        div.addEventListener('click', handler);
        bulkSection.appendChild(div);
      }
      modalSearchResults.appendChild(bulkSection);
    }

    if (tickers.length > 0) {
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
          const add = () => promptAddTickerWithIndex(r);
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

  async function reloadMyListFromDatabase() {
    const res = await window.api.listTickers();
    if (!res || !res.ok) throw new Error((res && res.error) || 'Não foi possível recarregar a My List.');
    // Keep the search input and collapsedGroups untouched. renderWatchlist()
    // reapplies the current filter after replacing the DB snapshot.
    watchlist = (res.custom || []).map(normaliseWatchlistEntry).filter(t => t.ticker);
    indexStatusCache.clear();
    renderWatchlist();
    populateIndexBulkFetchDropdown();
    await refreshIndexStatusBadge();
    return watchlist;
  }

  async function loadInitial() {
    try {
      await reloadMyListFromDatabase();
      void refreshExpectedTradingDay();

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
    const idxName = t.indexName || t.index_name || t.index;
    if (!idxName) {
      console.warn('addTicker falhou: Seleção de Índice é obrigatória.');
      if (typeof status !== 'undefined' && status) {
        status.textContent = 'Erro: É obrigatório selecionar um índice para a ação.';
      }
      return;
    }
    const country = t.country || '';
    const canonicalId = canonicalIndexId(idxName);
    const entry = { ticker: t.ticker, name: t.name || '', indexId: canonicalId, indexName: indexLabel(canonicalId, idxName), indexDbName: idxName, country };
    watchlist.push(entry);
    renderWatchlist(t.ticker);
    status.textContent = `${t.ticker} adicionado à watchlist (${idxName}).`;
    try {
      await window.api.addTicker({
        ticker: t.ticker,
        name: t.name,
        exchange: t.exchange,
        type: t.type,
        country: country,
        indexName: idxName
      });
      await loadInitial();
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
    if (watchlist.length === 0) {
      if (typeof status !== 'undefined' && status) {
        status.textContent = 'Watchlist já está vazia.';
      }
      return;
    }
    const count = watchlist.length;
    const ok = await openConfirmModal({
      title: 'Limpar Watchlist',
      message: `Tens a certeza que queres remover todos os <strong>${count}</strong> ${count === 1 ? 'ticker' : 'tickers'} da Watchlist?`,
      confirmLabel: 'Sim, limpar tudo',
      cancelLabel: 'Cancelar',
      danger: true
    });
    if (!ok) return;

    if (btnClearAll) btnClearAll.disabled = true;
    const prev = watchlist;
    watchlist = [];
    renderWatchlist();
    try {
      const res = await window.api.clearTickers();
      if (!res || !res.ok) {
        watchlist = prev;
        renderWatchlist();
        if (typeof status !== 'undefined' && status) {
          status.textContent = 'Erro ao limpar watchlist: ' + (res && res.error ? res.error : 'desconhecido');
        }
        return;
      }
      if (typeof status !== 'undefined' && status) {
        status.textContent = `Watchlist limpa (${count} ${count === 1 ? 'ticker removido' : 'tickers removidos'}).`;
      }
      await loadInitial();
    } catch (err) {
      watchlist = prev;
      renderWatchlist();
      if (typeof status !== 'undefined' && status) {
        status.textContent = 'Erro: ' + (err && err.message ? err.message : String(err));
      }
    } finally {
      if (btnClearAll) btnClearAll.disabled = watchlist.length === 0;
    }
  }

  function clearTable() {
    body.innerHTML = '<tr class="empty"><td colspan="12">A processar...</td></tr>';
    scannerRows = []; // Limpar dados armazenados
    currentSort = { column: null, direction: 'asc' }; // Reset ordenação
    updateSortIndicator();
  }

  function passesMcFilter(r) {
    const mcFilter = document.getElementById('mc-filter');
    if (!mcFilter || mcFilter.value !== 'elite') return true;
    return r.mcTier === 'ELITE' || (r.mcWinRate != null && r.mcWinRate >= 65);
  }

  function appendRow(r) {
    const empty = body.querySelector('tr.empty');
    if (empty) empty.remove();
    
    scannerRows.push(r);
    
    if (!currentSort.column) {
      if (passesMcFilter(r)) {
        renderRowToDOM(r, body.children.length);
      }
    }
  }
  
  function renderRowToDOM(r, index) {
    const tr = document.createElement('tr');
    tr.className = 'flash-in';
    tr.innerHTML = `
      <td class="col-idx">${index}</td>
      <td class="col-ticker ticker">${escapeHtml(r.ticker)}</td>
      <td class="col-name name">${escapeHtml(r.name || '')}</td>
      <td class="col-dir"><span class="dir-badge dir-${r.direction}">${r.direction}</span></td>
      <td class="col-num edge-val">${(r.edge * 100).toFixed(2)}%</td>
      <td class="col-num pStay-val">${(r.pStay * 100).toFixed(2)}%</td>
      <td class="col-vol ${r.volumeValid ? 'vol-yes' : 'vol-no'}">${r.volumeValid ? 'SIM' : 'NÃO'}</td>
      <td class="col-num price-val">${r.close != null ? r.close.toFixed(2) : '—'}</td>
      <td class="col-num sl-val">${r.stopLoss != null ? r.stopLoss.toFixed(2) : '—'}</td>
      <td class="col-num tp-val">${r.takeProfit != null ? r.takeProfit.toFixed(2) : '—'}</td>
      <td class="col-num col-mc">${r.mcWinRate != null ? (() => {
        const tierClass = r.mcTier === 'ELITE' ? 'badge-mc-elite' : r.mcTier === 'MODERATE' ? 'badge-mc-moderate' : 'badge-mc-rejected';
        const tierLabel = r.mcTier === 'ELITE' ? 'Elite' : r.mcTier === 'MODERATE' ? 'Moderado' : 'Rejeitado';
        const tp = r.mcTpHits ?? 0;
        const sl = r.mcSlHits ?? 0;
        const exp = r.mcExpired ?? 0;
        const wr = Math.round(r.mcWinRate * 10) / 10;
        const expectation = ((wr / 100) * 2.8 - (1 - wr / 100) * 1.4).toFixed(2);
        const tooltipLines = [
          'Classificação: ' + (r.mcLabel || tierLabel),
          'Taxa de Sucesso: ' + wr + '%',
          'Simulações: 1.000 trajetórias (20 dias úteis)',
          '  Sucessos (TP 2,8%): ' + tp,
          '  Derrotas (SL 1,4%): ' + sl,
          '  Expirados: ' + exp,
          'Expectativa Matemática: +' + expectation + '% por trade'
        ];
        return '<span class="mc-pill ' + tierClass + '" data-mc-tooltip="' + escapeHtml(tooltipLines.join('\\n')) + '" style="cursor:default">MC: ' + Math.round(wr) + '% (' + tierLabel + ')</span>';
      })() : '—'}</td>
      <td class="col-action"><button class="btn-investir" data-ticker="${escapeHtml(r.ticker)}" data-nome="${escapeHtml(r.name || '')}" data-direcao="${escapeHtml(r.direction)}" data-preco="${r.close}" data-stop="${r.stopLoss}" data-tp="${r.takeProfit}">Investir</button></td>
    `;
    body.appendChild(tr);
    tr.querySelector('.btn-investir').addEventListener('click', (e) => {
      e.stopPropagation();
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
    tr.addEventListener('click', (e) => {
      if (e.target.closest('.btn-investir')) return;
      if (r && r.ticker) openAssetDetailModal(r.ticker);
    });
  }
  
  function renderAllRows() {
    body.innerHTML = '';
    if (scannerRows.length === 0) {
      body.innerHTML = '<tr class="empty"><td colspan="12">Aguardando execução do scanner...</td></tr>';
      return;
    }
    
    let rowIndex = 0;
    scannerRows.forEach((r) => {
      if (passesMcFilter(r)) {
        rowIndex++;
        renderRowToDOM(r, rowIndex);
      }
    });
  }
  
  function sortByDirection() {
    // Alternar direção
    if (currentSort.column === 'direction') {
      currentSort.direction = currentSort.direction === 'asc' ? 'desc' : 'asc';
    } else {
      currentSort.column = 'direction';
      currentSort.direction = 'asc';
    }
    
    // Ordenar dados: primeiro por direção, depois por edge (decrescente)
    scannerRows.sort((a, b) => {
      const dirA = a.direction || '';
      const dirB = b.direction || '';
      
      // COMPRA antes de VENDA em ordem ascendente
      const order = { 'COMPRA': 0, 'VENDA': 1 };
      const valA = order[dirA] !== undefined ? order[dirA] : 2;
      const valB = order[dirB] !== undefined ? order[dirB] : 2;
      
      // Primeiro critério: direção
      if (valA !== valB) {
        return currentSort.direction === 'asc' ? valA - valB : valB - valA;
      }
      
      // Segundo critério: edge (sempre decrescente - maior edge primeiro)
      const edgeA = a.edge || 0;
      const edgeB = b.edge || 0;
      return edgeB - edgeA;
    });
    
    // Re-renderizar tabela
    renderAllRows();
    updateSortIndicator();
  }
  
  function updateSortIndicator() {
    const indicator = document.getElementById('sort-indicator-direction');
    const header = document.getElementById('sort-direction');
    
    if (!indicator || !header) return;
    
    // Remover classe active de todos os headers
    document.querySelectorAll('.sortable').forEach(th => th.classList.remove('sort-active'));
    
    if (currentSort.column === 'direction') {
      header.classList.add('sort-active');
      indicator.textContent = currentSort.direction === 'asc' ? '↑' : '↓';
    } else {
      indicator.textContent = '';
    }
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
          hideSuggestions();
          promptAddTickerWithIndex({ ticker: v.toUpperCase(), name: v.toUpperCase() });
          searchInput.value = '';
          if (searchClear) searchClear.hidden = true;
        }
      }
    });
  }

  document.addEventListener('click', (e) => {
    if (suggestionsEl && !suggestionsEl.contains(e.target) && e.target !== searchInput) {
      hideSuggestions();
    }
  });

  document.addEventListener('mouseover', (e) => {
    const badge = e.target.closest('[data-mc-tooltip]');
    if (!badge) return;
    let tip = document.querySelector('.mc-tooltip');
    if (!tip) {
      tip = document.createElement('div');
      tip.className = 'mc-tooltip';
      document.body.appendChild(tip);
    }
    tip.innerHTML = badge.dataset.mcTooltip.replace(/\\n/g, '<br>');
    const rect = badge.getBoundingClientRect();
    tip.style.left = rect.left + 'px';
    tip.style.top = (rect.bottom + 6) + 'px';
    tip.style.display = 'block';
  });

  document.addEventListener('mouseout', (e) => {
    if (e.target.closest('[data-mc-tooltip]')) {
      const tip = document.querySelector('.mc-tooltip');
      if (tip) tip.style.display = 'none';
    }
  });

  const mcFilterEl = document.getElementById('mc-filter');
  if (mcFilterEl) {
    mcFilterEl.addEventListener('change', () => {
      renderAllRows();
    });
  }

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

  const btnImportCsv = document.getElementById('btn-import-csv');
  if (btnImportCsv) {
    btnImportCsv.addEventListener('click', async () => {
      btnImportCsv.disabled = true;
      btnImportCsv.querySelector('span').textContent = 'A importar...';
      try {
        const res = await window.api.importHistoricalCsv();
        if (res && res.ok) {
          status.textContent = res.message || `${res.inserted} velas importadas.`;
          await loadInitial();
        } else if (res && res.error !== 'cancelled') {
          status.textContent = 'Erro na importação: ' + (res.error || 'desconhecido');
        }
      } catch (err) {
        status.textContent = 'Erro na importação: ' + (err.message || String(err));
      } finally {
        btnImportCsv.disabled = false;
        btnImportCsv.querySelector('span').textContent = 'Importar CSV';
      }
    });
  }

  const btnPurgeInactive = document.getElementById('btn-purge-inactive');
  if (btnPurgeInactive) {
    btnPurgeInactive.addEventListener('click', async () => {
      const ok = await openConfirmModal({
        title: 'Limpar Ativos Inativos / Antigos do Índice',
        message: 'Tens a certeza que desejas remover da base de dados todos os ativos de índices sem registos de cotação atualizados nos últimos 60 dias?',
        confirmLabel: 'Sim, limpar inativos',
        cancelLabel: 'Cancelar',
        danger: true
      });
      if (!ok) return;

      btnPurgeInactive.disabled = true;
      const span = btnPurgeInactive.querySelector('span');
      const originalText = span ? span.textContent : btnPurgeInactive.textContent;
      if (span) span.textContent = 'A limpar...';

      try {
        const res = await window.api.purgeInactiveStocks(60);
        if (res && res.ok) {
          const count = res.totalPurged || 0;
          const msg = count > 0 
            ? `Limpeza concluída: ${count} ativos inativos/antigos removidos da base de dados.`
            : 'Nenhum ativo inativo encontrado (todos os registos estão atualizados nos últimos 60 dias).';
          if (typeof status !== 'undefined' && status) {
            status.textContent = msg;
          }
          await loadInitial();
        } else {
          if (typeof status !== 'undefined' && status) {
            status.textContent = 'Erro na limpeza: ' + (res && res.error ? res.error : 'desconhecido');
          }
        }
      } catch (err) {
        if (typeof status !== 'undefined' && status) {
          status.textContent = 'Erro ao limpar ativos: ' + (err.message || String(err));
        }
      } finally {
        btnPurgeInactive.disabled = false;
        if (span) span.textContent = originalText;
      }
    });
  }

  // --- Sync All Stocks ---
  if (btnDownloadAllMylist) {
    btnDownloadAllMylist.addEventListener('click', async () => {
      btnDownloadAllMylist.disabled = true;
      const label = btnDownloadAllMylist.querySelector('span');
      const originalLabel = label.textContent;
      label.textContent = 'A sincronizar novos dias...';

      try {
        const res = await window.api.syncAllListStocks(null);
        if (res && res.ok) {
          const msg = res.totalNewCandles > 0
            ? `Lista atualizada com sucesso! ${res.totalNewCandles} novas velas gravadas.`
            : res.message || 'Lista já estava atualizada. Nenhuma vela nova.';
          showToast(msg, 'success');
          if (typeof status !== 'undefined' && status) status.textContent = msg;
        } else {
          const errMsg = res && res.error ? res.error : 'Erro desconhecido';
          showToast('Erro na sincronização: ' + errMsg, 'error');
          if (typeof status !== 'undefined' && status) status.textContent = 'Erro na sincronização: ' + errMsg;
        }
      } catch (err) {
        showToast('Erro na sincronização: ' + (err.message || String(err)), 'error');
        if (typeof status !== 'undefined' && status) status.textContent = 'Erro: ' + (err.message || String(err));
      } finally {
        btnDownloadAllMylist.disabled = false;
        label.textContent = originalLabel;
      }
    });
  }

  const btnAddStockModal = document.getElementById('btn-add-stock-modal');
  if (btnAddStockModal) {
    btnAddStockModal.addEventListener('click', () => openAddModal());
  }

  // --- Index actions dropdown toggle ---
  if (btnIndexActions && indexActionsDropdown) {
    btnIndexActions.addEventListener('click', (e) => {
      e.stopPropagation();
      indexActionsDropdown.hidden = !indexActionsDropdown.hidden;
    });
    document.addEventListener('click', (e) => {
      const menu = document.getElementById('index-actions-menu');
      if (indexActionsDropdown && !indexActionsDropdown.hidden && menu && !menu.contains(e.target)) {
        indexActionsDropdown.hidden = true;
      }
    });
  }

  function getSelectedIndexDbName() {
    if (!selectIndexBulkFetch) return null;
    const idx = selectIndexBulkFetch.value;
    if (!idx || idx === 'ALL') return null;
    const selectedOption = selectIndexBulkFetch.selectedOptions && selectIndexBulkFetch.selectedOptions[0];
    return (selectedOption && selectedOption.dataset.dbName) || idx;
  }

  // --- 1º Registo (Auditoria + download do histórico desde o IPO/Origem) ---
  function setFirstRegistoBusy(busy) {
    // A operação serializa no main process; congelar as ações da toolbar para
    // evitar cliques múltiplos sem bloquear a pesquisa nem os cards.
    [btnFirstRegisto, btnMostRecent, btnAddStockModal, btnIndexActions]
      .filter(Boolean).forEach((btn) => { if (btn) btn.disabled = busy; });
  }

  if (btnFirstRegisto) {
    btnFirstRegisto.addEventListener('click', async () => {
      const requestIndex = getSelectedIndexDbName();
      const idx = selectIndexBulkFetch ? selectIndexBulkFetch.value : '';
      const idxLabel = idx === 'ALL' ? 'Todos os Índices'
        : (selectIndexBulkFetch && selectIndexBulkFetch.selectedOptions && selectIndexBulkFetch.selectedOptions[0]
          ? selectIndexBulkFetch.selectedOptions[0].textContent : idx);
      const requestName = requestIndex || idx || 'ALL';

      if (!requestIndex && (!idx || idx === 'ALL')) {
        showToast('Seleciona um índice específico para a auditoria do 1º Registo.', 'error');
        return;
      }

      firstRegistoActive = true;
      setFirstRegistoBusy(true);
      const label = btnFirstRegisto.querySelector('span');
      const originalLabel = label.textContent;
      label.textContent = 'A auditar 1º registo...';
      if (indexBulkProgress) indexBulkProgress.hidden = false;
      if (indexBulkProgressLabel) indexBulkProgressLabel.textContent = `A auditar e descarregar 1º registo de ${idxLabel}: a iniciar...`;
      if (indexBulkProgressFill) indexBulkProgressFill.style.width = '0%';

      try {
        let res;
        if (typeof window.api.syncIndexFirstRecords === 'function') {
          res = await window.api.syncIndexFirstRecords(requestName);
        } else {
          // Fallback legado mantido para contratos antigos do preload.
          res = await window.api.firstRegisto(requestName);
        }
        const errors = Array.isArray(res && res.errors) ? res.errors : [];
        const errorCount = Number(res && res.errorCount) || errors.length || 0;

        if (res && res.ok && errorCount === 0) {
          const msg = res.status === 'complete'
            ? `1º Registo: ${idxLabel} já está completo (${res.total} ativos com histórico desde a origem).`
            : `1º Registo concluído: ${res.updated} ativos com histórico desde a origem (${idxLabel}).`;
          showToast(msg, 'success');
          if (typeof status !== 'undefined' && status) status.textContent = msg;
          if (indexBulkProgressLabel) indexBulkProgressLabel.textContent = `✅ ${msg}`;
          if (indexBulkProgressFill) indexBulkProgressFill.style.width = '100%';
        } else if (res && (res.cancelled || (res.ok && errorCount > 0))) {
          const msg = res.cancelled
            ? `1º Registo cancelado (${res.updated || 0} ativos atualizados, ${errorCount} falha(s)).`
            : `1º Registo parcial: ${res.updated}/${res.total} ativos atualizados (${idxLabel}); ${errorCount} falha(s).`;
          showToast(msg, 'info');
          if (typeof status !== 'undefined' && status) status.textContent = msg;
          if (indexBulkProgressLabel) indexBulkProgressLabel.textContent = `⚠️ ${msg}`;
          const firstErr = errors[0];
          if (firstErr && typeof status !== 'undefined' && status) {
            status.textContent += ` Ex.: ${firstErr.ticker || '?'}: ${firstErr.error || firstErr}`;
          }
        } else {
          const errMsg = (res && (res.error || res.message)) || 'Erro desconhecido';
          showToast('Erro no 1º Registo: ' + errMsg, 'error');
          if (typeof status !== 'undefined' && status) status.textContent = 'Erro no 1º Registo: ' + errMsg;
          if (indexBulkProgressLabel) indexBulkProgressLabel.textContent = '❌ ' + errMsg;
        }
      } catch (err) {
        showToast('Erro no 1º Registo: ' + (err.message || String(err)), 'error');
        if (typeof status !== 'undefined' && status) status.textContent = 'Erro no 1º Registo: ' + (err.message || String(err));
        if (indexBulkProgressLabel) indexBulkProgressLabel.textContent = '❌ ' + (err.message || String(err));
      } finally {
        firstRegistoActive = false;
        setFirstRegistoBusy(false);
        label.textContent = originalLabel;
        await reloadMyListFromDatabase();
        await refreshIndexStatusBadge();
      }
    });
  }

  // --- Mais Recente (sincronizar até à última sessão de mercado) ---
  if (btnMostRecent) {
    btnMostRecent.addEventListener('click', async () => {
      const requestIndex = getSelectedIndexDbName();
      const idx = selectIndexBulkFetch ? selectIndexBulkFetch.value : '';
      const idxLabel = idx === 'ALL' ? 'Todos os Índices'
        : (selectIndexBulkFetch && selectIndexBulkFetch.selectedOptions && selectIndexBulkFetch.selectedOptions[0]
          ? selectIndexBulkFetch.selectedOptions[0].textContent : idx);

      btnMostRecent.disabled = true;
      mostRecentActive = true;
      const label = btnMostRecent.querySelector('span');
      const originalLabel = label.textContent;
      label.textContent = 'A sincronizar...';
      if (indexBulkProgress) indexBulkProgress.hidden = false;
      if (indexBulkProgressLabel) indexBulkProgressLabel.textContent = `Mais Recente de ${idxLabel}: a iniciar...`;
      if (indexBulkProgressFill) indexBulkProgressFill.style.width = '0%';

      try {
        const res = await window.api.syncAllListStocks(requestIndex);
        if (res && res.ok) {
          const msg = res.totalNewCandles > 0
            ? `Lista atualizada! ${res.totalNewCandles} novas velas gravadas (${idxLabel}).`
            : (res.message || 'Lista já estava atualizada até ao último dia de mercado.');
          showToast(msg, 'success');
          if (typeof status !== 'undefined' && status) status.textContent = msg;
          if (indexBulkProgressLabel) indexBulkProgressLabel.textContent = `✅ ${msg}`;
          if (indexBulkProgressFill) indexBulkProgressFill.style.width = '100%';
        } else {
          const errMsg = res && res.error ? res.error : 'Erro desconhecido';
          showToast('Erro na sincronização: ' + errMsg, 'error');
          if (typeof status !== 'undefined' && status) status.textContent = 'Erro na sincronização: ' + errMsg;
        }
      } catch (err) {
        showToast('Erro na sincronização: ' + (err.message || String(err)), 'error');
        if (typeof status !== 'undefined' && status) status.textContent = 'Erro na sincronização: ' + (err.message || String(err));
      } finally {
        btnMostRecent.disabled = false;
        mostRecentActive = false;
        label.textContent = originalLabel;
        await reloadMyListFromDatabase();
        await refreshIndexStatusBadge();
      }
    });
  }

  // Freshness banner "Go to My List" button
  if (btnFreshnessGoMylist) {
    btnFreshnessGoMylist.addEventListener('click', () => {
      if (freshnessBanner) freshnessBanner.hidden = true;
      const myListTabBtn = document.querySelector('.tab-btn[data-tab="mylist"]');
      if (myListTabBtn) myListTabBtn.click();
    });
  }

  // Freshness banner "Continue Anyway" button
  if (btnFreshnessContinue) {
    btnFreshnessContinue.addEventListener('click', () => {
      freshnessOverride = true;
      if (freshnessBanner) freshnessBanner.hidden = true;
      if (btn) btn.click();
    });
  }

  // Ordenação por direção
  const sortDirectionHeader = document.getElementById('sort-direction');
  if (sortDirectionHeader) {
    sortDirectionHeader.addEventListener('click', sortByDirection);
    sortDirectionHeader.style.cursor = 'pointer';
  }

  btn.addEventListener('click', async () => {
    if (running) return;
    if (watchlist.length === 0) {
      status.textContent = 'Adiciona pelo menos um ticker à watchlist.';
      return;
    }

    // Freshness check before scan
    if (freshnessOverride) {
      freshnessOverride = false;
    } else if (freshnessBanner) {
      try {
        const freshness = await window.api.checkListFreshness(null);
        if (freshness && freshness.ok && !freshness.isUpdated && freshness.outdatedTickers && freshness.outdatedTickers.length > 0) {
          const expectedDateFormatted = freshness.expectedDate
            ? freshness.expectedDate.split('-').reverse().join('-')
            : '—';
          const maxDateFormatted = freshness.maxStoredDate
            ? freshness.maxStoredDate.split('-').reverse().join('-')
            : '—';
          freshnessBannerMessage.innerHTML =
            `⚠️ A sua base de dados local tem cotações pendentes de atualização ` +
            `(dados até <strong>${maxDateFormatted}</strong>, última sessão de mercado esperada <strong>${expectedDateFormatted}</strong>). ` +
            `Atualize a <strong>"My List"</strong> para resultados 100% precisos.`;
          freshnessBanner.hidden = false;
          return; // Stop the scan initiation
        }
      } catch (err) {
        console.warn('Freshness check failed, proceeding with scan:', err);
      }
    }

    // Hide freshness banner if it was previously shown
    if (freshnessBanner && !freshnessBanner.hidden) {
      freshnessBanner.hidden = true;
    }

    setRunning(true);
    totalProcessed = 0;
    activeScanTotal = 0;
    scanCancelRequested = false;
    totalEmitted = 0;
    scanErrors = []; // Reset erros do scan anterior
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
      activeScanRunId = res && res.runId != null ? res.runId : null;
      if (!res || !res.ok) {
        status.textContent = 'Erro ao iniciar scanner.';
        setRunning(false);
      }
    } catch (err) {
      status.textContent = 'Erro: ' + (err.message || err);
      setRunning(false);
    }
  });

  if (btnCancelScan) {
    btnCancelScan.addEventListener('click', async () => {
      if (!running || typeof window.api.cancelScan !== 'function') return;
      btnCancelScan.disabled = true;
      try {
        await window.api.cancelScan(activeScanRunId);
        scanCancelRequested = true;
        status.textContent = 'Cancelamento solicitado; a aguardar o scanner terminar...';
      } catch (err) {
        btnCancelScan.disabled = false;
        status.textContent = 'Erro ao cancelar: ' + (err.message || String(err));
      }
    });
  }

  subscribeApiEvent('on', 'scan:progress', (p) => {
    if (p.total > 0) {
      activeScanTotal = Number(p.total) || activeScanTotal;
      totalProcessed = Number(p.processed) || 0;
      const pct = (p.processed / p.total) * 100;
      progressFill.style.width = pct.toFixed(1) + '%';
      progressText.textContent = `${p.processed} / ${p.total}`;
      status.textContent = `A processar: ${p.currentTicker || ''} (${p.processed}/${p.total})`;
    }
  });

  subscribeApiEvent('on', 'scan:row', (r) => {
    totalEmitted++;
    appendRow(r);
  });

  subscribeApiEvent('on', 'scan:error', (e) => {
    // Agregar erro para resumo final
    scanErrors.push(e);

    // Erros esperados (dados insuficientes, delistados) → log discreto
    // Erros inesperados (rede, timeout) → warn para debugging
    const isExpected = /insuficientes|delisted|No data found/i.test(e.message || '');
    if (isExpected) {
      console.log(`[Scanner] ${e.ticker}: ${e.message}`);
    } else {
      console.warn('Scanner error:', e);
    }
    if (running && e && e.ticker) {
      status.textContent = `Falha em ${e.ticker}; a análise continua (${totalProcessed}/${e.total || '?'})`;
    }
  });

  subscribeApiEvent('on', 'scan:done', (d) => {
    setRunning(false);
    activeScanRunId = null;
    totalProcessed = Number(d.totalProcessed || d.processed || 0);
    const total = Number(d.total || activeScanTotal || totalProcessed);
    progressFill.style.width = total > 0 ? Math.round(totalProcessed / total * 100) + '%' : '100%';
    progressText.textContent = `${totalProcessed} / ${total}`;

    // Construir mensagem de resumo com erros
    const wasCancelled = d.cancelled === true || d.status === 'cancelled' || scanCancelRequested;
    let summaryMsg = wasCancelled
      ? `Cancelado: ${totalProcessed}/${total} tickers processados — ${d.totalSignals || 0} sinais.`
      : scanErrors.length > 0
        ? `Concluído parcialmente em ${((d.elapsedMs || 0) / 1000).toFixed(1)}s — ${d.totalSignals || 0} sinais.`
        : `Concluído em ${((d.elapsedMs || 0) / 1000).toFixed(1)}s — ${d.totalSignals || 0} sinais.`;
    if (scanErrors.length > 0) {
      const expectedCount = scanErrors.filter(e => /insuficientes|delisted|No data found/i.test(e.message || '')).length;
      const unexpectedCount = scanErrors.length - expectedCount;
      if (expectedCount > 0) {
        summaryMsg += ` (${expectedCount} tickers com dados insuficientes/delistados`;
        if (unexpectedCount > 0) summaryMsg += `, ${unexpectedCount} erros inesperados`;
        summaryMsg += ')';
      } else if (unexpectedCount > 0) {
        summaryMsg += ` (${unexpectedCount} erros inesperados)`;
      }
    }

    status.textContent = summaryMsg;
    footerSummary.textContent = `${d.totalSignals || 0} sinais emitidos · ${totalProcessed}/${total} tickers processados`;
    if (!wasCancelled && (d.totalSignals || 0) === 0) {
      body.innerHTML = '<tr class="empty"><td colspan="12">Nenhum ativo cumpriu os critérios (Edge ≥ 15%, Volume ≥ 1.2× SMA20, direção válida).</td></tr>';
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

      // Helper: color a KPI card based on semantic value
      const colorCard = (el, kind) => {
        if (!el) return;
        const card = el.closest('.metric-card');
        if (!card) return;
        card.classList.remove('is-good', 'is-bad', 'is-warn', 'is-neutral');
        card.classList.add(kind);
      };

      if (metricTrades) {
        metricTrades.textContent = r.totalTrades;
        colorCard(metricTrades, 'is-neutral');
      }
      if (metricWinrate) {
        metricWinrate.textContent = (r.winRate * 100).toFixed(1) + '%';
        colorCard(metricWinrate, r.winRate >= 0.5 ? 'is-good' : 'is-bad');
      }
      if (metricNetreturn) {
        metricNetreturn.textContent = (r.netReturn).toFixed(2) + '%';
        colorCard(metricNetreturn, r.netReturn >= 0 ? 'is-good' : 'is-bad');
      }
      if (metricSharpe) {
        metricSharpe.textContent = r.sharpeRatio.toFixed(2);
        colorCard(metricSharpe, r.sharpeRatio >= 1 ? 'is-good' : (r.sharpeRatio >= 0 ? 'is-warn' : 'is-bad'));
      }
      if (metricDrawdown) {
        metricDrawdown.textContent = (r.maxDrawdown * 100).toFixed(1) + '%';
        colorCard(metricDrawdown, 'is-warn');
      }
      if (metricExpectancy) {
        metricExpectancy.textContent = (r.expectancy * 100).toFixed(2) + '%';
        colorCard(metricExpectancy, r.expectancy >= 0 ? 'is-good' : 'is-bad');
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
  const portfolioStatus = document.getElementById('portfolio-status');
  const btnSyncTrades = document.getElementById('btn-sync-trades');
  const btnReanalisar = document.getElementById('btn-reanalisar');
  const btnClearTrades = document.getElementById('btn-clear-trades');

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
        return `<span class="alerta-badge alerta-badge-stop">Próximo do Stop!</span><span class="alerta-dist">dist: ${fmt(distStop)}</span>`;
      case 'alerta_tp':
        return `<span class="alerta-badge alerta-badge-tp">Quase no Alvo!</span><span class="alerta-dist">dist: ${fmt(distTp)}</span>`;
      case 'alerta_inversao':
        return `<span class="alerta-badge alerta-badge-inversao">Inversão de Tendência!</span><span class="alerta-dist">Markov → ${escapeHtml(state.current_direction || '?')}</span>`;
      case 'fechado':
        return '<span class="alerta-badge alerta-badge-manter">Fechado</span>';
      case 'manter':
      default:
        return `<span class="alerta-badge alerta-badge-manter">A manter</span><span class="alerta-dist">SL: ${fmt(distStop)} · TP: ${fmt(distTp)}</span>`;
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
      <td class="col-action">
        <button class="portfolio-row-remove" data-trade-id="${trade.id}" data-ticker="${escapeHtml(trade.ticker)}" title="Apagar esta posição">×</button>
      </td>
    `;
    const removeBtn = tr.querySelector('.portfolio-row-remove');
    if (removeBtn) {
      removeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        removeOneTrade(trade, removeBtn);
      });
    }
    return tr;
  }

  function renderPortfolioTable() {
    portfolioBody.innerHTML = '';
    if (lastActiveTrades.length === 0) {
      portfolioBody.innerHTML = '<tr class="empty"><td colspan="12">Nenhuma posição ativa. Clique em "Investir" num sinal do scanner para começar.</td></tr>';
      if (btnClearTrades) btnClearTrades.disabled = true;
      return;
    }
    for (const t of lastActiveTrades) {
      const state = lastStatesByTicker[t.ticker] || null;
      portfolioBody.appendChild(renderPortfolioRow(t, state));
    }
    if (btnClearTrades) btnClearTrades.disabled = false;
  }

  async function loadPortfolio() {
    try {
      const res = await window.api.listTrades();
      if (!res || !res.ok) {
        portfolioBody.innerHTML = '<tr class="empty"><td colspan="11">Erro ao carregar posições.</td></tr>';
        return;
      }

      lastActiveTrades = res.active || [];

      renderPortfolioTable();

      const hasStates = Object.keys(lastStatesByTicker).length > 0;
      portfolioStatus.textContent = lastActiveTrades.length > 0
        ? `${lastActiveTrades.length} posição(ões) ativa(s) em monitorização.${hasStates ? ' (última reanálise aplicada)' : ''}`
        : 'Posições ativas abertas a partir dos sinais do scanner.';
    } catch (err) {
      portfolioStatus.textContent = 'Erro: ' + (err.message || String(err));
    }
  }

  async function removeOneTrade(trade, btnEl) {
    const ticker = trade && trade.ticker ? trade.ticker : '';
    if (!trade || trade.id == null) return;
    const ok = await openConfirmModal({
      title: 'Apagar posição',
      message: `Queres mesmo apagar a posição <strong>${escapeHtml(ticker)}</strong> (${escapeHtml(trade.direcao || '')})? Esta ação não pode ser revertida.`,
      confirmLabel: 'Apagar',
      cancelLabel: 'Cancelar',
      danger: true
    });
    if (!ok) return;

    const row = btnEl && btnEl.closest ? btnEl.closest('tr') : null;
    if (row) row.classList.add('removing');
    if (btnEl) btnEl.disabled = true;

    try {
      const res = await window.api.removeTrade(trade.id);
      if (!res || !res.ok) {
        if (row) row.classList.remove('removing');
        if (btnEl) btnEl.disabled = false;
        portfolioStatus.textContent = 'Erro ao apagar: ' + (res && res.error ? res.error : 'desconhecido');
        return;
      }
      if (lastStatesByTicker && lastStatesByTicker[ticker]) {
        delete lastStatesByTicker[ticker];
      }
      await loadPortfolio();
      portfolioStatus.textContent = `Posição ${ticker} removida.`;
    } catch (err) {
      if (row) row.classList.remove('removing');
      if (btnEl) btnEl.disabled = false;
      portfolioStatus.textContent = 'Erro: ' + (err.message || String(err));
    }
  }

  async function clearAllTrades() {
    if (lastActiveTrades.length === 0) {
      portfolioStatus.textContent = 'Não há posições ativas para apagar.';
      return;
    }
    const count = lastActiveTrades.length;
    const ok = await openConfirmModal({
      title: 'Apagar todas as posições',
      message: `Tens a certeza que queres apagar <strong>todas as ${count} posições ativas</strong>? Esta ação não pode ser revertida e o histórico de trades fechados não é afetado.`,
      confirmLabel: 'Sim, apagar tudo',
      cancelLabel: 'Cancelar',
      danger: true
    });
    if (!ok) return;

    if (btnClearTrades) btnClearTrades.disabled = true;
    const prev = lastActiveTrades;
    lastActiveTrades = [];
    renderPortfolioTable();
    try {
      const res = await window.api.clearTrades();
      if (!res || !res.ok) {
        lastActiveTrades = prev;
        renderPortfolioTable();
        portfolioStatus.textContent = 'Erro ao apagar: ' + (res && res.error ? res.error : 'desconhecido');
        return;
      }
      lastStatesByTicker = {};
      portfolioStatus.textContent = `${res.changes || count} ${(res.changes || count) === 1 ? 'posição removida' : 'posições removidas'}.`;
      await loadPortfolio();
    } catch (err) {
      lastActiveTrades = prev;
      renderPortfolioTable();
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
    btnReanalisar.querySelector('span').textContent = 'A analisar...';

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
  if (btnClearTrades) {
    btnClearTrades.addEventListener('click', clearAllTrades);
  }

  const portfolioTab = document.querySelector('.tab-btn[data-tab="portfolio"]');
  if (portfolioTab) {
    portfolioTab.addEventListener('click', loadPortfolio);
  }

  // ═══════════════════════════════════════════════════════════
  //  HISTÓRICO DE TRADES
  // ═══════════════════════════════════════════════════════════
  const historyBody = document.getElementById('history-body');
  const historyStatus = document.getElementById('history-status');
  const historySummary = document.getElementById('history-summary');
  const btnClearHistory = document.getElementById('btn-clear-history');
  const historySummaryPanel = document.getElementById('history-summary-panel');
  const historySummaryTp = document.getElementById('history-summary-tp');
  const historySummarySl = document.getElementById('history-summary-sl');
  const historySummaryNet = document.getElementById('history-summary-net');
  const historySummaryNetCard = document.getElementById('history-summary-net-card');

  function renderHistoryRow(trade) {
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
      <td class="col-num sl-val">${trade.stop_loss != null ? trade.stop_loss.toFixed(2) : '—'}</td>
      <td class="col-num tp-val">${trade.take_profit != null ? trade.take_profit.toFixed(2) : '—'}</td>
      <td class="col-num">${trade.preco_fecho != null ? trade.preco_fecho.toFixed(2) : '—'}</td>
      <td class="col-num" style="color: ${resultColor}; font-weight: 600;">${resultText}</td>
      <td class="col-motivo"><span class="dir-badge" style="background: var(--surface-2); border-color: var(--border-strong); color: var(--text-dim); padding: 2px 8px; font-size: 10px;">${escapeHtml(motivoLabel)}</span></td>
      <td class="col-data" style="font-family: var(--mono); font-size: 11px; color: var(--text-dim);">${escapeHtml(trade.data_entrada || '')}</td>
      <td class="col-data" style="font-family: var(--mono); font-size: 11px; color: var(--text-dim);">${escapeHtml(trade.fechado_em || '')}</td>
    `;
    return tr;
  }

  async function loadHistory() {
    try {
      const res = await window.api.listTrades();
      if (!res || !res.ok) {
        historyBody.innerHTML = '<tr class="empty"><td colspan="11">Erro ao carregar histórico.</td></tr>';
        return;
      }

      const closed = res.closed || [];
      historyBody.innerHTML = '';
      
      if (closed.length === 0) {
        historyBody.innerHTML = '<tr class="empty"><td colspan="11">Nenhum trade no histórico. As operações fechadas aparecerão aqui.</td></tr>';
        if (btnClearHistory) btnClearHistory.disabled = true;
      } else {
        // Ordenar por data de fecho (mais recente primeiro)
        const sorted = [...closed].sort((a, b) => {
          const dateA = a.fechado_em || a.data_entrada || '';
          const dateB = b.fechado_em || b.data_entrada || '';
          return dateB.localeCompare(dateA);
        });
        
        sorted.forEach(t => historyBody.appendChild(renderHistoryRow(t)));
        if (btnClearHistory) btnClearHistory.disabled = false;
      }

      renderHistorySummary(closed);

      historySummary.textContent = `${closed.length} trade${closed.length !== 1 ? 's' : ''} no histórico`;
      historyStatus.textContent = closed.length > 0
        ? `${closed.length} operações fechadas registadas.`
        : 'Registo completo de todas as operações fechadas.';
    } catch (err) {
      historyStatus.textContent = 'Erro: ' + (err.message || String(err));
    }
  }

  function renderHistorySummary(closed) {
    if (!historySummaryPanel) return;
    if (!Array.isArray(closed) || closed.length === 0) {
      historySummaryPanel.hidden = true;
      return;
    }
    historySummaryPanel.hidden = false;

    let totalTp = 0;
    let totalSl = 0;
    let countTp = 0;
    let countSl = 0;

    for (const t of closed) {
      const r = Number(t.resultado_pct) || 0;
      const motivo = String(t.motivo_fecho || '').toLowerCase();
      let kind = 'manual';
      if (motivo === 'take_profit') kind = 'tp';
      else if (motivo === 'stop_loss') kind = 'sl';
      else if (motivo === 'auto' || motivo === '') kind = r >= 0 ? 'tp' : 'sl';

      if (kind === 'tp') { totalTp += r; countTp++; }
      else if (kind === 'sl') { totalSl += r; countSl++; }
    }

    const net = totalTp + totalSl;
    const fmt = v => (v * 100).toFixed(2) + '%';

    if (historySummaryTp) {
      historySummaryTp.textContent = `${fmt(totalTp)}`;
      historySummaryTp.parentElement.querySelector('.metric-lbl').textContent =
        `Take Profit · ${countTp} trade${countTp !== 1 ? 's' : ''}`;
    }
    if (historySummarySl) {
      historySummarySl.textContent = `${fmt(totalSl)}`;
      historySummarySl.parentElement.querySelector('.metric-lbl').textContent =
        `Stop Loss · ${countSl} trade${countSl !== 1 ? 's' : ''}`;
    }

    if (historySummaryNet) {
      const label = net > 0
        ? `Ganho Global · ${fmt(net)}`
        : net < 0
          ? `Perda Global · ${fmt(net)}`
          : `Neutro · ${fmt(net)}`;
      historySummaryNet.textContent = `${net > 0 ? '+' : ''}${(net * 100).toFixed(2)}%`;
      historySummaryNet.parentElement.querySelector('.metric-lbl').textContent = label;
      if (historySummaryNetCard) {
        historySummaryNetCard.classList.remove('is-good', 'is-bad', 'is-warn', 'is-neutral');
        historySummaryNetCard.classList.add(net > 0 ? 'is-good' : net < 0 ? 'is-bad' : 'is-neutral');
      }
    }
  }

  async function clearHistory() {
    const res = await window.api.listTrades();
    const closed = (res && res.closed) || [];
    
    if (closed.length === 0) {
      historyStatus.textContent = 'O histórico já está vazio.';
      return;
    }
    
    const count = closed.length;
    const ok = await openConfirmModal({
      title: 'Limpar Histórico',
      message: `Tens a certeza que queres apagar <strong>todos os ${count} trades</strong> do histórico? Esta ação não pode ser revertida.`,
      confirmLabel: 'Sim, limpar tudo',
      cancelLabel: 'Cancelar',
      danger: true
    });
    
    if (!ok) return;

    if (btnClearHistory) btnClearHistory.disabled = true;
    
    try {
      const clearRes = await window.api.clearClosedTrades();
      if (!clearRes || !clearRes.ok) {
        historyStatus.textContent = 'Erro ao limpar histórico: ' + (clearRes && clearRes.error ? clearRes.error : 'desconhecido');
        await loadHistory();
        return;
      }
      
      historyStatus.textContent = `Histórico limpo (${count} ${count === 1 ? 'trade removido' : 'trades removidos'}).`;
      await loadHistory();
    } catch (err) {
      historyStatus.textContent = 'Erro: ' + (err.message || String(err));
      await loadHistory();
    }
  }

  if (btnClearHistory) {
    btnClearHistory.addEventListener('click', clearHistory);
  }

  const historyTab = document.querySelector('.tab-btn[data-tab="history"]');
  if (historyTab) {
    historyTab.addEventListener('click', loadHistory);
  }

  // ═══════════════════════════════════════════════════════════
  //  MODAL DE CONFIRMAÇÃO GENÉRICO
  // ═══════════════════════════════════════════════════════════
  const confirmModal = document.getElementById('modal-confirm');
  const confirmTitle = document.getElementById('modal-confirm-title');
  const confirmMessage = document.getElementById('modal-confirm-message');
  const confirmOk = document.getElementById('modal-confirm-ok');
  const confirmCancel = document.getElementById('modal-confirm-cancel');
  const confirmClose = document.getElementById('modal-confirm-close');
  let confirmResolver = null;

  function openConfirmModal(opts) {
    if (!confirmModal) return Promise.resolve(false);
    const cfg = Object.assign({
      title: 'Confirmar',
      message: 'Tens a certeza?',
      confirmLabel: 'Confirmar',
      cancelLabel: 'Cancelar',
      danger: false
    }, opts || {});
    if (confirmTitle) confirmTitle.textContent = cfg.title;
    if (confirmMessage) confirmMessage.innerHTML = cfg.message;
    if (confirmOk) {
      confirmOk.textContent = cfg.confirmLabel;
      confirmOk.className = cfg.danger ? 'btn-primary btn-danger' : 'btn-primary';
    }
    if (confirmCancel) confirmCancel.textContent = cfg.cancelLabel;
    confirmModal.hidden = false;
    return new Promise(resolve => {
      confirmResolver = resolve;
    });
  }

  function closeConfirmModal(result) {
    if (!confirmModal) return;
    confirmModal.hidden = true;
    if (confirmResolver) {
      const r = confirmResolver;
      confirmResolver = null;
      r(result === true);
    }
  }

  if (confirmOk) confirmOk.addEventListener('click', () => closeConfirmModal(true));
  if (confirmCancel) confirmCancel.addEventListener('click', () => closeConfirmModal(false));
  if (confirmClose) confirmClose.addEventListener('click', () => closeConfirmModal(false));
  if (confirmModal) {
    confirmModal.addEventListener('click', (e) => {
      if (e.target === confirmModal) closeConfirmModal(false);
    });
  }
  document.addEventListener('keydown', (e) => {
    if (!confirmModal || confirmModal.hidden) return;
    if (e.key === 'Escape') closeConfirmModal(false);
    else if (e.key === 'Enter' && document.activeElement !== confirmCancel) {
      e.preventDefault();
      closeConfirmModal(true);
    }
  });

  // ═══════════════════════════════════════════════════════════
  //  ASSET DETAIL MODAL (Contextual per-ticker)
  // ═══════════════════════════════════════════════════════════
  const modalAssetDetail = document.getElementById('modal-asset-detail');
  const assetDetailClose = document.getElementById('asset-detail-close');
  const assetDetailTickerEl = document.getElementById('asset-detail-ticker');
  const assetDetailNameEl = document.getElementById('asset-detail-name');
  const modalStockName = document.getElementById('modal-stock-name');
  const modalStockCountry = document.getElementById('modal-stock-country');
  const modalStockIndex = document.getElementById('modal-stock-index');
  const modalStockIndexCustom = document.getElementById('modal-stock-index-custom');
  const btnSaveStockMetadata = document.getElementById('btn-save-stock-metadata');
  const assetMetadataError = document.getElementById('asset-metadata-error');
  const assetDetailFirstDate = document.getElementById('asset-detail-first-date');
  const assetDetailLastDate = document.getElementById('asset-detail-last-date');
  const assetDetailTotalCandles = document.getElementById('asset-detail-total-candles');
  const assetDetailSyncBtn = document.getElementById('asset-detail-sync-yahoo');
  const assetDetailSyncSpinner = document.getElementById('asset-detail-sync-spinner');
  const assetDetailSyncStatus = document.getElementById('asset-detail-sync-status');
  const assetFileUploadArea = document.getElementById('asset-file-upload-area');
  const assetFileInput = document.getElementById('asset-import-file');
  const assetFilePlaceholder = document.getElementById('asset-file-upload-placeholder');
  const assetFileSelected = document.getElementById('asset-file-upload-selected');
  const assetFileFilename = document.getElementById('asset-file-upload-filename');
  const assetFileRemove = document.getElementById('asset-file-upload-remove');
  const assetImportProgressWrap = document.getElementById('asset-import-progress-wrap');
  const assetImportProgressFill = document.getElementById('asset-import-progress-fill');
  const assetImportProgressText = document.getElementById('asset-import-progress-text');
  const assetImportError = document.getElementById('asset-import-error');
  const assetImportSuccess = document.getElementById('asset-import-success');
  const assetSummaryZone = document.getElementById('history-summary-zone');
  const assetUploadZone = document.getElementById('upload-zone');
  const assetDeleteBtn = document.getElementById('asset-detail-delete-history');

  let currentAssetTicker = null;
  let assetSelectedFile = null;

  function fmtDate(d) {
    if (!d) return '—';
    const str = String(d).split('T')[0];
    const p = str.split('-');
    if (p.length === 3 && p[0].length === 4) {
      return `${p[2]}-${p[1]}-${p[0]}`;
    }
    return String(d);
  }

  function renderModalState(hasData, details) {
    const summary = details || {};
    const uploadZone = document.getElementById('upload-zone');
    const historySummaryZone = document.getElementById('history-summary-zone');
    const firstEl = document.getElementById('asset-detail-first-date');
    const lastEl = document.getElementById('asset-detail-last-date');
    const candlesEl = document.getElementById('asset-detail-total-candles');

    const hasFirstDateMetadata = !!summary.firstDate;
    if (hasData || hasFirstDateMetadata) {
      if (historySummaryZone) historySummaryZone.style.display = 'block';
      if (firstEl) firstEl.textContent = fmtDate(summary.firstDate);
      if (lastEl) lastEl.textContent = hasData ? fmtDate(summary.lastDate) : '—';
      if (candlesEl) candlesEl.textContent = summary.totalCandles != null ? Number(summary.totalCandles).toLocaleString('pt-PT') : '—';
    } else {
      if (historySummaryZone) historySummaryZone.style.display = 'none';
      if (firstEl) firstEl.textContent = '—';
      if (lastEl) lastEl.textContent = '—';
      if (candlesEl) candlesEl.textContent = '0';
    }
    if (uploadZone) uploadZone.style.display = 'block';
  }

  function updateAssetHistoryUI(summary) {
    renderModalState(!!(summary && summary.hasData), summary || {});
  }

  async function openAssetDetailModal(ticker) {
    if (!modalAssetDetail || !ticker) return;
    const cleanTicker = String(ticker).toUpperCase().trim();

    watchlistEl.querySelectorAll('.watchlist-item.is-active').forEach(el => el.classList.remove('is-active'));
    const activeItem = watchlistEl.querySelector(`.watchlist-item[data-ticker="${CSS.escape(cleanTicker)}"]`);
    if (activeItem) activeItem.classList.add('is-active');

    // 1. Explicitly set active ticker for this session
    currentAssetTicker = cleanTicker;
    assetSelectedFile = null;

    // 2. Full clean reset of all modal DOM elements & inputs
    if (assetDetailTickerEl) assetDetailTickerEl.textContent = cleanTicker;
    if (assetDetailNameEl) assetDetailNameEl.textContent = '';
    if (modalStockName) modalStockName.value = '';
    if (modalStockCountry) modalStockCountry.value = '';
    if (modalStockIndex) {
      modalStockIndex.innerHTML = '<option value="" disabled selected>-- Seleciona o Índice --</option>';
    }
    if (modalStockIndexCustom) {
      modalStockIndexCustom.value = '';
      modalStockIndexCustom.hidden = true;
    }
    if (btnSaveStockMetadata) btnSaveStockMetadata.disabled = false;
    if (assetMetadataError) { assetMetadataError.textContent = ''; assetMetadataError.hidden = true; }

    const firstEl = document.getElementById('asset-detail-first-date');
    const lastEl = document.getElementById('asset-detail-last-date');
    const candlesEl = document.getElementById('asset-detail-total-candles');
    if (firstEl) firstEl.textContent = '—';
    if (lastEl) lastEl.textContent = '—';
    if (candlesEl) candlesEl.textContent = '—';

    if (assetDetailSyncStatus) {
      assetDetailSyncStatus.textContent = '';
      assetDetailSyncStatus.hidden = true;
      assetDetailSyncStatus.className = 'asset-detail-sync-status';
    }
    if (assetImportError) { assetImportError.textContent = ''; assetImportError.hidden = true; }
    if (assetImportSuccess) { assetImportSuccess.textContent = ''; assetImportSuccess.hidden = true; }
    if (assetImportProgressWrap) assetImportProgressWrap.hidden = true;
    if (assetFileInput) assetFileInput.value = '';
    if (assetFilePlaceholder) assetFilePlaceholder.hidden = false;
    if (assetFileSelected) assetFileSelected.hidden = true;
    if (assetFileFilename) assetFileFilename.textContent = '';
    if (assetDetailSyncBtn) assetDetailSyncBtn.disabled = false;
    if (assetDetailSyncSpinner) assetDetailSyncSpinner.hidden = true;
    if (assetDetailSyncBtn) {
      const label = assetDetailSyncBtn.querySelector('.btn-label');
      if (label) label.textContent = 'Sincronizar via Yahoo Finance';
    }

    const fullDownloadBtnReset = document.getElementById('asset-detail-full-download');
    const fullDownloadSpinnerReset = document.getElementById('asset-detail-full-download-spinner');
    const fullDownloadStatusReset = document.getElementById('asset-detail-full-download-status');
    if (fullDownloadBtnReset) fullDownloadBtnReset.disabled = false;
    if (fullDownloadSpinnerReset) fullDownloadSpinnerReset.hidden = true;
    if (fullDownloadBtnReset) {
      const label = fullDownloadBtnReset.querySelector('.btn-label');
      if (label) label.textContent = 'Descarregar Histórico Completo (Yahoo Finance)';
    }
    if (fullDownloadStatusReset) {
      fullDownloadStatusReset.hidden = true;
      fullDownloadStatusReset.textContent = '';
      fullDownloadStatusReset.className = 'asset-detail-full-download-status';
    }

    // 3. Temporarily hide BOTH zones during async IPC database query
    const uploadZone = document.getElementById('upload-zone');
    const historySummaryZone = document.getElementById('history-summary-zone');
    if (uploadZone) uploadZone.style.display = 'none';
    if (historySummaryZone) historySummaryZone.style.display = 'none';

    modalAssetDetail.hidden = false;

    // 4. Query IPC database for currentAssetTicker specifically
    try {
      const res = await window.api.getTickerDetail(cleanTicker);
      // Guard against race conditions if user clicked another row quickly
      if (currentAssetTicker !== cleanTicker) return;

      if (res && res.ok) {
        if (res.stock) {
          if (assetDetailNameEl) assetDetailNameEl.textContent = res.stock.name || '';
          if (modalStockName) modalStockName.value = res.stock.name || '';
          if (modalStockCountry) modalStockCountry.value = res.stock.country || '';
          populateModalStockIndexDropdown(res.stock.index_name);
        } else if (res.custom) {
          if (assetDetailNameEl) assetDetailNameEl.textContent = res.custom.name || '';
          if (modalStockName) modalStockName.value = res.custom.name || '';
          if (modalStockCountry) modalStockCountry.value = '';
          populateModalStockIndexDropdown('');
        }
        const summary = res.summary || {};
        renderModalState(!!summary.hasData, summary);
      } else {
        renderModalState(false, {});
      }
    } catch (err) {
      console.error('[openAssetDetailModal] Error fetching ticker detail:', err);
      if (currentAssetTicker === cleanTicker) {
        renderModalState(false, {});
      }
    }
  }

  function closeAssetDetailModal() {
    if (!modalAssetDetail) return;
    modalAssetDetail.hidden = true;
    currentAssetTicker = null;
    assetSelectedFile = null;
  }

  // ── Edição de Metadados do Ativo (Nome / País / Índice) ──
  function getModalStockNameValue() {
    return modalStockName ? modalStockName.value.trim() : '';
  }

  function getModalStockCountryValue() {
    return modalStockCountry ? modalStockCountry.value.trim() : '';
  }

  function getModalStockIndexValue() {
    if (!modalStockIndex) return '';
    if (modalStockIndex.value === 'CUSTOM_NEW') {
      return modalStockIndexCustom ? modalStockIndexCustom.value.trim() : '';
    }
    return modalStockIndex.value.trim();
  }

  function setModalStockIndexCustomVisible(visible) {
    if (modalStockIndexCustom) modalStockIndexCustom.hidden = !visible;
  }

  // Seleciona o índice atual do ativo por defeito. O valor vindo da BD é o ID
  // canónico (ex.: 'PSI', 'IBEX35') ou o nome de um índice personalizado; os
  // nomes amigáveis são apenas apresentação. Se não houver opção equivalente,
  // ativa o modo "+ Digitar Novo Índice / Personalizado..." com o valor preenchido.
  function setModalStockIndexValue(raw) {
    if (!modalStockIndex) return;
    const clean = String(raw || '').trim();
    if (!clean) {
      modalStockIndex.value = '';
      setModalStockIndexCustomVisible(false);
      return;
    }
    const canonical = canonicalIndexId(clean);
    const options = Array.from(modalStockIndex.options);
    const matchedOpt = options.find((opt) => {
      if (!opt.value || opt.value === 'CUSTOM_NEW') return false;
      return opt.value.toUpperCase() === clean.toUpperCase()
        || canonicalIndexId(opt.value) === canonical;
    });
    if (matchedOpt) {
      modalStockIndex.value = matchedOpt.value;
      setModalStockIndexCustomVisible(false);
    } else {
      modalStockIndex.value = 'CUSTOM_NEW';
      if (modalStockIndexCustom) modalStockIndexCustom.value = clean;
      setModalStockIndexCustomVisible(true);
    }
  }

  // Preenche o dropdown de índice do modal com os índices da BD (watchlist +
  // PREDEFINED_INDEXES), seguindo o padrão de populateIndexDropdown().
  function populateModalStockIndexDropdown(selectedRaw) {
    if (!modalStockIndex) return;
    const currentIndexes = new Map();
    for (const t of watchlist) {
      const idxId = canonicalIndexId(t.indexId || t.indexName);
      if (idxId && !currentIndexes.has(idxId)) {
        currentIndexes.set(idxId, t.indexName || idxId);
      }
    }
    modalStockIndex.innerHTML = '';
    const defaultOpt = document.createElement('option');
    defaultOpt.value = '';
    defaultOpt.disabled = true;
    defaultOpt.selected = true;
    defaultOpt.textContent = '-- Seleciona o Índice --';
    modalStockIndex.appendChild(defaultOpt);
    if (currentIndexes.size > 0) {
      const groupCurrent = document.createElement('optgroup');
      groupCurrent.label = '⭐ Índices Atuais na My List';
      for (const [idxId, idxName] of currentIndexes) {
        const opt = document.createElement('option');
        opt.value = idxId;
        opt.textContent = idxName || idxId;
        groupCurrent.appendChild(opt);
      }
      modalStockIndex.appendChild(groupCurrent);
    }
    const groupOther = document.createElement('optgroup');
    groupOther.label = '🌐 Outros Índices de Mercado';
    let hasOther = false;
    for (const idx of PREDEFINED_INDEXES) {
      if (!currentIndexes.has(idx.id.toUpperCase())) {
        const opt = document.createElement('option');
        opt.value = idx.id;
        opt.textContent = idx.label;
        groupOther.appendChild(opt);
        hasOther = true;
      }
    }
    if (hasOther) modalStockIndex.appendChild(groupOther);
    const groupCustom = document.createElement('optgroup');
    groupCustom.label = '➕ Personalizado';
    const customOpt = document.createElement('option');
    customOpt.value = 'CUSTOM_NEW';
    customOpt.textContent = '+ Digitar Novo Índice / Personalizado...';
    groupCustom.appendChild(customOpt);
    modalStockIndex.appendChild(groupCustom);
    setModalStockIndexValue(selectedRaw);
  }

  if (modalStockIndex) {
    modalStockIndex.addEventListener('change', () => {
      if (modalStockIndex.value === 'CUSTOM_NEW') {
        setModalStockIndexCustomVisible(true);
        if (modalStockIndexCustom) modalStockIndexCustom.focus();
      } else {
        setModalStockIndexCustomVisible(false);
      }
    });
  }

  async function saveStockMetadata() {
    if (!currentAssetTicker) return;
    const ticker = currentAssetTicker;
    if (btnSaveStockMetadata) btnSaveStockMetadata.disabled = true;
    if (assetMetadataError) { assetMetadataError.textContent = ''; assetMetadataError.hidden = true; }
    try {
      const name = getModalStockNameValue();
      const country = getModalStockCountryValue();
      const indexName = getModalStockIndexValue();
      if (!name && !country && !indexName) {
        showToast('Erro: preenche pelo menos um campo (Nome, País ou Índice)', 'error');
        return;
      }
      const data = {};
      if (name) data.name = name;
      if (country) data.country = country;
      if (indexName) data.index_name = indexName;

      const res = await window.api.updateStockMetadata(ticker, data);
      // O utilizador mudou de ativo enquanto a gravação decorria: aborta a
      // atualização da UI (a BD já foi atualizada, o próximo open reflete-a).
      if (currentAssetTicker !== ticker) return;

      if (!res || !res.ok) {
        showToast('Erro: ' + ((res && res.error) || 'desconhecido'), 'error');
        return;
      }

      showToast('Metadados atualizados com sucesso', 'success');
      if (name && assetDetailNameEl) assetDetailNameEl.textContent = name;

      // Recarregar a My List a partir da BD (preserva busca/grupos) e fechar
      // o modal para refletir as mudanças. reloadMyListFromDatabase() já
      // repovoa o dropdown de bulk-fetch e o badge de estado do índice; as
      // chamadas explícitas seguintes são idempotentes e cobrem falhas parciais.
      closeAssetDetailModal();
      try {
        await reloadMyListFromDatabase();
      } catch (err) {
        console.warn('saveStockMetadata: reloadMyListFromDatabase failed:', err);
      }
      populateIndexBulkFetchDropdown();
      await refreshIndexStatusBadge();
    } catch (err) {
      showToast('Erro: ' + (err.message || String(err)), 'error');
    } finally {
      if (btnSaveStockMetadata) btnSaveStockMetadata.disabled = false;
    }
  }

  if (btnSaveStockMetadata) btnSaveStockMetadata.addEventListener('click', saveStockMetadata);

  if (assetDetailClose) assetDetailClose.addEventListener('click', closeAssetDetailModal);
  if (modalAssetDetail) {
    modalAssetDetail.addEventListener('click', (e) => {
      if (e.target === modalAssetDetail) closeAssetDetailModal();
    });
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modalAssetDetail && !modalAssetDetail.hidden) {
      closeAssetDetailModal();
    }
  });

  async function syncAssetYahoo() {
    if (!currentAssetTicker || !assetDetailSyncBtn) return;
    const syncingTicker = currentAssetTicker;
    assetDetailSyncBtn.disabled = true;
    if (assetDetailSyncSpinner) assetDetailSyncSpinner.hidden = false;
    if (assetDetailSyncBtn) {
      const label = assetDetailSyncBtn.querySelector('.btn-label');
      if (label) label.textContent = 'A sincronizar...';
    }
    if (assetDetailSyncStatus) {
      assetDetailSyncStatus.hidden = true;
      assetDetailSyncStatus.className = 'asset-detail-sync-status';
    }

    try {
      const res = await window.api.syncTickerYahoo(syncingTicker);
      if (currentAssetTicker !== syncingTicker) return;
      if (!res || !res.ok) {
        if (assetDetailSyncStatus) {
          assetDetailSyncStatus.textContent = res && res.warning
            ? res.warning
            : ('Erro: ' + (res && res.error ? res.error : 'desconhecido'));
          assetDetailSyncStatus.className = 'asset-detail-sync-status' + (res && res.hasLocalData ? ' is-error' : ' is-error');
          assetDetailSyncStatus.hidden = false;
        }
        if (res && res.summary) updateAssetHistoryUI(res.summary);
        return;
      }

      if (assetDetailSyncStatus) {
        const msg = res.newCandles > 0
          ? `Sincronizado! +${res.newCandles} velas novas.`
          : 'Dados já atualizados.';
        assetDetailSyncStatus.textContent = msg;
        assetDetailSyncStatus.className = 'asset-detail-sync-status is-success';
        assetDetailSyncStatus.hidden = false;
      }
      if (res.summary) updateAssetHistoryUI(res.summary);
      await updateWatchlistBadge(currentAssetTicker, res.summary);
    } catch (err) {
      if (currentAssetTicker === syncingTicker && assetDetailSyncStatus) {
        assetDetailSyncStatus.textContent = 'Erro: ' + (err.message || String(err));
        assetDetailSyncStatus.className = 'asset-detail-sync-status is-error';
        assetDetailSyncStatus.hidden = false;
      }
    } finally {
      if (currentAssetTicker !== syncingTicker) return;
      assetDetailSyncBtn.disabled = false;
      if (assetDetailSyncSpinner) assetDetailSyncSpinner.hidden = true;
      if (assetDetailSyncBtn) {
        const label = assetDetailSyncBtn.querySelector('.btn-label');
        if (label) label.textContent = 'Sincronizar via Yahoo Finance';
      }
    }
  }

  if (assetDetailSyncBtn) assetDetailSyncBtn.addEventListener('click', syncAssetYahoo);

  const fullDownloadBtn = document.getElementById('asset-detail-full-download');
  const fullDownloadSpinner = document.getElementById('asset-detail-full-download-spinner');
  const fullDownloadStatus = document.getElementById('asset-detail-full-download-status');

  if (fullDownloadBtn) {
    fullDownloadBtn.addEventListener('click', async () => {
      if (!currentAssetTicker) return;
      const ticker = currentAssetTicker;
      fullDownloadBtn.disabled = true;
      const btnLabel = fullDownloadBtn.querySelector('.btn-label');
      const originalLabel = btnLabel.textContent;
      btnLabel.textContent = 'A descarregar histórico completo...';
      if (fullDownloadSpinner) fullDownloadSpinner.hidden = false;
      if (fullDownloadStatus) {
        fullDownloadStatus.hidden = false;
        fullDownloadStatus.textContent = 'A descarregar histórico do Yahoo Finance desde o IPO...';
        fullDownloadStatus.className = 'asset-detail-full-download-status is-loading';
      }

      try {
        const result = await window.api.downloadFullYahooHistory(ticker);
        if (currentAssetTicker !== ticker) return;
        if (result && result.ok) {
          if (fullDownloadStatus) {
            fullDownloadStatus.textContent = `Sucesso: ${result.totalCandles} velas históricas descarregadas e guardadas!`;
            fullDownloadStatus.className = 'asset-detail-full-download-status is-success';
          }
          if (result.summary) {
            const firstDateEl = document.getElementById('asset-detail-first-date');
            const lastDateEl = document.getElementById('asset-detail-last-date');
            const totalCandlesEl = document.getElementById('asset-detail-total-candles');
            if (firstDateEl) firstDateEl.textContent = fmtShortDate(result.summary.firstDate);
            if (lastDateEl) lastDateEl.textContent = fmtShortDate(result.summary.lastDate);
            if (totalCandlesEl) totalCandlesEl.textContent = result.summary.totalCandles.toLocaleString('pt-PT');

            const historyZone = document.getElementById('history-summary-zone');
            if (historyZone) {
              historyZone.hidden = false;
              historyZone.style.display = 'block';
            }

            const uploadZone = document.getElementById('upload-zone');
            if (uploadZone) {
              uploadZone.hidden = true;
              uploadZone.style.display = 'none';
            }

            await updateWatchlistBadge(ticker, result.summary);
            const wlEntry = watchlist.find(w => w.ticker === ticker);
            if (wlEntry) wlEntry.fullHistoryFetched = true;
            const cardEl = watchlistEl.querySelector('.watchlist-item[data-ticker="' + CSS.escape(ticker) + '"]');
            if (cardEl) {
              applyCardSyncState(cardEl, wlEntry || { ticker, temHistorico: true, ultimaData: result.summary.lastDate, fullHistoryFetched: true });
            }
          }
        } else {
          const errorMsg = result && result.error ? result.error : 'Erro desconhecido';
          if (fullDownloadStatus) {
            fullDownloadStatus.textContent = `Erro: ${errorMsg}`;
            fullDownloadStatus.className = 'asset-detail-full-download-status is-error';
          }
        }
      } catch (err) {
        if (currentAssetTicker === ticker && fullDownloadStatus) {
          fullDownloadStatus.textContent = `Erro ao contactar Yahoo Finance: ${err.message || String(err)}`;
          fullDownloadStatus.className = 'asset-detail-full-download-status is-error';
        }
      } finally {
        if (currentAssetTicker !== ticker) return;
        fullDownloadBtn.disabled = false;
        btnLabel.textContent = originalLabel;
        if (fullDownloadSpinner) fullDownloadSpinner.hidden = true;
      }
    });
  }

  async function deleteAssetHistory() {
    if (!currentAssetTicker) return;
    const ok = await openConfirmModal({
      title: 'Apagar Histórico',
      message: `Tens a certeza que queres apagar <strong>todo o histórico local</strong> de <strong>${escapeHtml(currentAssetTicker)}</strong>?<br><br>Esta ação não pode ser revertida. O histórico será removido da base de dados, mas o ativo permanece na watchlist.`,
      confirmLabel: 'Sim, apagar',
      cancelLabel: 'Cancelar',
      danger: true
    });
    if (!ok) return;

    try {
      const res = await window.api.deleteTickerHistory(currentAssetTicker);
      if (!res || !res.ok) {
        if (assetDetailSyncStatus) {
          assetDetailSyncStatus.textContent = 'Erro ao apagar: ' + (res && res.error ? res.error : 'desconhecido');
          assetDetailSyncStatus.className = 'asset-detail-sync-status is-error';
          assetDetailSyncStatus.hidden = false;
        }
        return;
      }
      renderModalState(false, { hasData: false, firstDate: null, lastDate: null, totalCandles: 0 });
      await updateWatchlistBadge(currentAssetTicker, { hasData: false, firstDate: null, lastDate: null, totalCandles: 0 });
    } catch (err) {
      if (assetDetailSyncStatus) {
        assetDetailSyncStatus.textContent = 'Erro: ' + (err.message || String(err));
        assetDetailSyncStatus.className = 'asset-detail-sync-status is-error';
        assetDetailSyncStatus.hidden = false;
      }
    }
  }

  if (assetDeleteBtn) assetDeleteBtn.addEventListener('click', deleteAssetHistory);

  function handleAssetFileSelect(file) {
    if (!file) return;
    const ext = file.name.split('.').pop().toLowerCase();
    if (!['csv', 'xlsx'].includes(ext)) {
      if (assetImportError) {
        assetImportError.textContent = 'Formato não suportado. Usa .csv ou .xlsx';
        assetImportError.hidden = false;
      }
      return;
    }
    assetSelectedFile = file;
    if (assetImportError) assetImportError.hidden = true;
    if (assetImportSuccess) assetImportSuccess.hidden = true;
    if (assetFilePlaceholder) assetFilePlaceholder.hidden = true;
    if (assetFileSelected) assetFileSelected.hidden = false;
    if (assetFileFilename) assetFileFilename.textContent = file.name;
    submitAssetImport();
  }

  async function submitAssetImport() {
    if (!assetSelectedFile || !currentAssetTicker) return;
    const activeTicker = currentAssetTicker;

    if (assetImportError) { assetImportError.textContent = ''; assetImportError.hidden = true; }
    if (assetImportSuccess) { assetImportSuccess.textContent = ''; assetImportSuccess.hidden = true; }
    if (assetImportProgressWrap) assetImportProgressWrap.hidden = false;
    if (assetImportProgressFill) assetImportProgressFill.style.width = '30%';
    if (assetImportProgressText) assetImportProgressText.textContent = 'A ler ficheiro...';

    try {
      const arrayBuffer = await assetSelectedFile.arrayBuffer();
      const uint8Array = new Uint8Array(arrayBuffer);

      if (assetImportProgressFill) assetImportProgressFill.style.width = '60%';
      if (assetImportProgressText) assetImportProgressText.textContent = 'A processar dados...';

      const res = await window.api.importBulk({
        ticker: activeTicker,
        name: getModalStockNameValue() || (assetDetailNameEl && assetDetailNameEl.textContent) || activeTicker,
        country: getModalStockCountryValue(),
        indexName: getModalStockIndexValue(),
        fileData: Array.from(uint8Array),
        fileName: assetSelectedFile.name
      });

      if (assetImportProgressFill) assetImportProgressFill.style.width = '100%';

      if (!res || !res.ok) {
        throw new Error(res ? res.error : 'Erro desconhecido');
      }

      if (assetImportProgressText) assetImportProgressText.textContent = 'Concluído!';

      // Re-query database immediately for activeTicker
      const freshDetail = await window.api.getTickerDetail(activeTicker);
      const summary = (freshDetail && freshDetail.ok && freshDetail.summary) ? freshDetail.summary : res.summary;

      // Update modal immediately if user is still on this ticker
      if (currentAssetTicker === activeTicker) {
        renderModalState(!!(summary && summary.hasData), summary);
      }

       if (assetImportSuccess && currentAssetTicker === activeTicker) {
        assetImportSuccess.innerHTML = `✓ ${res.count} velas importadas para <strong>${escapeHtml(activeTicker)}</strong>`;
        assetImportSuccess.hidden = false;
      }

       if (currentAssetTicker === activeTicker) {
         assetSelectedFile = null;
         if (assetFileInput) assetFileInput.value = '';
         if (assetFilePlaceholder) assetFilePlaceholder.hidden = false;
         if (assetFileSelected) assetFileSelected.hidden = true;
       }

      // Update main table (My List) row immediately to show the two date pills
      await updateWatchlistBadge(activeTicker, summary);
    } catch (err) {
      if (currentAssetTicker === activeTicker && assetImportProgressWrap) assetImportProgressWrap.hidden = true;
      if (currentAssetTicker === activeTicker && assetImportError) {
        assetImportError.textContent = 'Erro na importação: ' + (err.message || String(err));
        assetImportError.hidden = false;
      }
    }
  }

  if (assetFileUploadArea) {
    assetFileUploadArea.addEventListener('click', () => assetFileInput?.click());
    assetFileUploadArea.addEventListener('dragover', (e) => {
      e.preventDefault();
      assetFileUploadArea.classList.add('dragover');
    });
    assetFileUploadArea.addEventListener('dragleave', () => {
      assetFileUploadArea.classList.remove('dragover');
    });
    assetFileUploadArea.addEventListener('drop', (e) => {
      e.preventDefault();
      assetFileUploadArea.classList.remove('dragover');
      if (e.dataTransfer.files.length > 0) {
        handleAssetFileSelect(e.dataTransfer.files[0]);
      }
    });
  }

  if (assetFileInput) {
    assetFileInput.addEventListener('change', (e) => {
      if (e.target.files.length > 0) {
        handleAssetFileSelect(e.target.files[0]);
      }
    });
  }

  if (assetFileRemove) {
    assetFileRemove.addEventListener('click', (e) => {
      e.stopPropagation();
      assetSelectedFile = null;
      if (assetFileInput) assetFileInput.value = '';
      if (assetFilePlaceholder) assetFilePlaceholder.hidden = false;
      if (assetFileSelected) assetFileSelected.hidden = true;
    });
  }

  subscribeApiEvent('on', 'ticker:synced', (s) => {
    if (s.ticker && s.summary) {
      updateWatchlistBadge(s.ticker, s.summary);
      if (currentAssetTicker && s.ticker === currentAssetTicker) {
        updateAssetHistoryUI(s.summary);
      }
    }
  });

  subscribeApiEvent('on', 'import-success', (s) => {
    if (s.ticker && s.summary) {
      updateWatchlistBadge(s.ticker, s.summary);
      if (currentAssetTicker && s.ticker === currentAssetTicker) {
        updateAssetHistoryUI(s.summary);
      }
    }
  });

  subscribeApiEvent('on', 'scanner-sync-status', (s) => {
    const statusLine = document.getElementById('status-line');
    if (!statusLine) return;
    const labels = {
      'syncing': `A sincronizar ${s.ticker}...`,
      'up-to-date': s.warning
        ? `${s.ticker} — API indisponível, a usar dados locais`
        : `${s.ticker} — dados atualizados`,
      'downloaded-new': `${s.ticker} — +${s.newDataCount} velas novas`
    };
    statusLine.textContent = labels[s.status] || s.status;
  });

  // Listeners for sync-all progress and done events
  subscribeApiEvent('on', 'sync-all-progress', (p) => {
    if (!p) return;
    const label = btnMostRecent && btnMostRecent.querySelector('span');
    if (mostRecentActive && label && p.current != null && p.total != null) {
      label.textContent = `A sincronizar ${p.current}/${p.total}...`;
    }
    if (p.current != null && p.total != null && p.total > 0) {
      const pct = Math.round(p.current / p.total * 100);
      if (indexBulkProgressFill) indexBulkProgressFill.style.width = pct + '%';
      if (indexBulkProgressLabel) indexBulkProgressLabel.textContent = `${mostRecentActive ? 'Mais Recente' : 'Baixar Tudo'}: ${p.current}/${p.total} ativos (${pct}%)...`;
    }
    if (Array.isArray(p.updated)) {
      for (const u of p.updated) {
        if (u && u.ticker && u.summary) {
          void updateWatchlistBadge(u.ticker, u.summary);
        }
      }
    }
  });

  subscribeApiEvent('on', 'sync-all-done', (p) => {
    if (p && p.errorCount > 0 && typeof status !== 'undefined' && status) {
      status.textContent = `Sincronização concluída: ${p.updatedCount} atualizados, ${p.errorCount} erros.`;
    }
  });

  if (typeof window.api.onFirstRegistoProgress === 'function') {
    subscribeApiEvent('onFirstRegistoProgress', null, (p) => {
      if (!p) return;
      if (p.status === 'done' && !p.ticker) {
        if (indexBulkProgressFill) indexBulkProgressFill.style.width = '100%';
        return;
      }
      if (!p.ticker) return;
      const pct = typeof p.percent === 'number' ? p.percent : (p.total > 0 ? Math.round(p.current / p.total * 100) : 0);
      if (indexBulkProgressLabel) {
        indexBulkProgressLabel.textContent =
          `1º Registo: Processando ${p.current}/${p.total} (${p.ticker}) - ${pct}%...`;
      }
      if (indexBulkProgressFill) indexBulkProgressFill.style.width = pct + '%';
      if (p.status === 'updated' && p.summary) {
        void updateWatchlistBadge(p.ticker, p.summary);
      } else if (p.status === 'updated' && p.firstDate) {
        const item = watchlistEl.querySelector(`.watchlist-item[data-ticker="${CSS.escape(p.ticker)}"]`);
        if (item) {
          item.dataset.firstDate = p.firstDate ? fmtShortDate(p.firstDate) : 'Sem Registos';
          const wlEntry = watchlist.find(w => w.ticker === p.ticker);
          applyCardSyncState(item, wlEntry || { ticker: p.ticker, temHistorico: true, ultimaData: p.lastDate });
        }
      }
    });
  }

  // Auditoria + download do 1º registo por índice (nova pipeline
  // sync-index-first-records). Atualiza a barra e os cards reativamente.
  if (typeof window.api.onIndexSyncProgress === 'function') {
    subscribeApiEvent('onIndexSyncProgress', null, (p) => {
      if (!p || !firstRegistoActive) return;
      if (p.status === 'done') {
        if (indexBulkProgressFill) indexBulkProgressFill.style.width = '100%';
        return;
      }
      if (!p.ticker) return;
      const pct = typeof p.percent === 'number' ? p.percent
        : (p.total > 0 ? Math.round(p.current / p.total * 100) : 0);
      if (indexBulkProgressLabel) {
        indexBulkProgressLabel.textContent = p.status === 'syncing'
          ? `A auditar e descarregar ${p.ticker} (${p.current} de ${p.total})...`
          : `1º Registo: ${p.ticker} (${p.current} de ${p.total}) - ${pct}%...`;
      }
      if (indexBulkProgressFill) indexBulkProgressFill.style.width = pct + '%';
      if (typeof status !== 'undefined' && status) {
        status.textContent = p.status === 'error'
          ? `Falha em ${p.ticker}: ${p.error || 'erro'} (a operação continua).`
          : `1º Registo: ${p.current}/${p.total} (${p.ticker})...`;
      }
      if (p.status === 'updated' && p.ticker) {
        // Atualização seletiva do card do ticker processado (sem reload global).
        const wlEntry = watchlist.find(w => w.ticker === String(p.ticker).toUpperCase());
        if (wlEntry && p.firstDate) wlEntry.first_date = p.firstDate;
        void updateWatchlistBadge(p.ticker, null);
      }
    });
  }

  if (typeof window.api.onIndexDownloadProgress === 'function') {
    subscribeApiEvent('onIndexDownloadProgress', null, (p) => {
      if (!p) return;
      if (p.status === 'done' && !p.ticker) {
        if (indexBulkProgressFill) indexBulkProgressFill.style.width = '100%';
        return;
      }
      if (!p.ticker) return;
      const pct = p.total > 0 ? Math.round(p.current / p.total * 100) : 0;
      const idxLabel = currentIndexBulkLabel || '';
      if (indexBulkProgressLabel) {
        indexBulkProgressLabel.textContent =
          `A descarregar histórico do Índice ${idxLabel}: Processando ${p.current}/${p.total} (${p.ticker}) - ${pct}%...`;
      }
      if (indexBulkProgressFill) indexBulkProgressFill.style.width = pct + '%';
      if (p.status === 'updated' && p.summary) {
        void updateWatchlistBadge(p.ticker, p.summary);
      } else if (p.status === 'updated' && p.firstDate) {
        const item = watchlistEl.querySelector(`.watchlist-item[data-ticker="${CSS.escape(p.ticker)}"]`);
        if (item) {
          item.dataset.firstDate = p.firstDate ? fmtShortDate(p.firstDate) : 'Sem Registos';
          const wlEntry = watchlist.find(w => w.ticker === p.ticker);
          applyCardSyncState(item, wlEntry || { ticker: p.ticker, temHistorico: true, ultimaData: p.lastDate });
        }
      }
    });
  }

  if (typeof window.api.onFirstDateProgress === 'function') {
    subscribeApiEvent('onFirstDateProgress', null, (p) => {
      if (!p) return;
      if (p.status === 'done' && !p.ticker) {
        if (indexBulkProgressFill) indexBulkProgressFill.style.width = '100%';
        return;
      }
      if (!p.ticker) return;
      const pct = p.total > 0 ? Math.round(p.current / p.total * 100) : 0;
      if (indexBulkProgressLabel) {
        indexBulkProgressLabel.textContent =
          `A mapear 1ª data do Índice ${currentIndexBulkLabel || ''}: Processando ${p.current}/${p.total} (${p.ticker}) - ${pct}%...`;
      }
      if (indexBulkProgressFill) indexBulkProgressFill.style.width = pct + '%';
      if (p.firstDate) {
        const item = watchlistEl.querySelector(`.watchlist-item[data-ticker="${CSS.escape(p.ticker)}"]`);
        if (item) {
          item.dataset.firstDate = fmtShortDate(p.firstDate);
          const pillFirst = item.querySelector('.wl-pill-first');
          if (pillFirst) pillFirst.textContent = fmtShortDate(p.firstDate);
          const wlEntry = watchlist.find(w => w.ticker === p.ticker);
          if (wlEntry) wlEntry.first_date = p.firstDate;
        }
      }
    });
  }

  if (typeof window.api.onIndexFirstDateProgress === 'function') {
    subscribeApiEvent('onIndexFirstDateProgress', null, (data) => {
      if (!data || !data.ticker || !data.firstDate) return;
      const { ticker, firstDate, current, total } = data;
      const item = watchlistEl.querySelector(`.watchlist-item[data-ticker="${CSS.escape(ticker)}"]`);
      if (item) {
        item.dataset.firstDate = fmtShortDate(firstDate);
        const pillFirst = item.querySelector('.wl-pill-first');
        if (pillFirst) {
          pillFirst.textContent = fmtShortDate(firstDate);
          pillFirst.classList.add('synced-green');
        }
        const wlEntry = watchlist.find(w => w.ticker === ticker);
        if (wlEntry) wlEntry.first_date = firstDate;
      }
      if (typeof status !== 'undefined' && status) {
        status.textContent = `[${current}/${total}] ${ticker}: 1ª data Yahoo = ${fmtShortDate(firstDate)}`;
      }
    });
  }

  if (typeof window.api.onIndexDateProgress === 'function') {
    subscribeApiEvent('onIndexDateProgress', null, (data) => {
      if (!data || !data.ticker) return;
      const { ticker, current, total } = data;
      const pct = total > 0 ? Math.round(current / total * 100) : 0;
      const btnLabel = btnFetchFirstDate ? btnFetchFirstDate.querySelector('span') : null;
      if (data.firstDate) {
        if (btnLabel) btnLabel.textContent = `⏳ [${current}/${total}] ${ticker}: ${fmtShortDate(data.firstDate)}`;
      } else if (btnLabel) {
        btnLabel.textContent = `⏳ [${current}/${total}] ${ticker}`;
      }
      if (indexBulkProgressLabel) {
        const idxLabel = currentIndexBulkLabel || '';
        const label = data.firstDate
          ? `A atualizar ${idxLabel}: [${current}/${total}] ${ticker} -> ${fmtShortDate(data.firstDate)} (${pct}%)`
          : `A atualizar ${idxLabel}: [${current}/${total}] ${ticker} (sem 1ª data) (${pct}%)`;
        indexBulkProgressLabel.textContent = label;
      }
      if (indexBulkProgressFill) indexBulkProgressFill.style.width = pct + '%';
      if (data.firstDate) {
        const item = watchlistEl.querySelector(`.watchlist-item[data-ticker="${CSS.escape(ticker)}"]`);
        if (item) {
          item.dataset.firstDate = fmtShortDate(data.firstDate);
          const pillFirst = item.querySelector('.wl-pill-first');
          if (pillFirst) {
            pillFirst.textContent = fmtShortDate(data.firstDate);
            pillFirst.classList.add('synced-green');
          }
          const wlEntry = watchlist.find(w => w.ticker === ticker);
          if (wlEntry) wlEntry.first_date = data.firstDate;
        }
      }
      if (data.error) indexDateErrors++;
    });
  }

  if (typeof window.api.onCountryIndexProgress === 'function') {
    subscribeApiEvent('onCountryIndexProgress', null, (data) => {
      if (!data || !data.ticker || !countryImport || countryImport.cancelled || countryImport.finished) return;
      const { current, total, ticker, firstDate, name, error } = data;
      const pct = total > 0 ? Math.round(current / total * 100) : 0;
      const dateLabel = firstDate ? fmtShortDate(firstDate) : (error ? 'erro Yahoo' : 'sem data');
      if (indexBulkProgressLabel) {
        indexBulkProgressLabel.textContent = error
          ? `A importar ${data.indexName || ''}: [${current}/${total}] ${ticker} — falha: ${error}`
          : `A importar ${data.indexName || ''}: [${current}/${total}] ${ticker} — ${name || ticker}: ${dateLabel}`;
      }
      if (indexBulkProgressFill) indexBulkProgressFill.style.width = pct + '%';
      if (typeof status !== 'undefined' && status) {
        status.textContent = error
          ? `Falha em ${ticker}; a importação continua (${current}/${total}).`
          : `A importar ${ticker} (${current}/${total})...`;
      }
    });
  }

  // Unsubscribe on renderer teardown. The preload API returns one cleanup
  // function per subscription, so a reopened/hot-reloaded window cannot
  // accumulate callbacks or update detached DOM.
  window.addEventListener('beforeunload', () => {
    for (const unsubscribe of apiUnsubscribers.splice(0)) {
      try { unsubscribe(); } catch (_) { /* window is already closing */ }
    }
    countryImport = null;
    activeScanRunId = null;
  }, { once: true });
})();
