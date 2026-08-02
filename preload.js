const { contextBridge, ipcRenderer } = require('electron');

const ALLOWED_EVENTS = new Set([
  'scan:progress',
  'scan:row',
  'scan:done',
  'scan:error',
  'import-success',
  'scanner-sync-status',
  'ticker:synced',
  'sync-all-progress',
  'sync-all-done',
  'index-download-progress',
  'first-date-fetch-progress',
  'index-first-date-progress',
  'index-date-progress',
  'UPDATE_INDEX_DATE_PROGRESS',
  'country-index-progress'
]);

contextBridge.exposeInMainWorld('api', {
  startScan: (tickers, params) => ipcRenderer.invoke('scan:start', { tickers, params }),
  cancelScan: (runId) => ipcRenderer.invoke('scan:cancel', { runId }),
  cancelIndexOperation: (operationId) => ipcRenderer.invoke('index:cancel', { operationId }),
  searchTicker: (query, limit) => ipcRenderer.invoke('ticker:search', { query, limit }),
  addTicker: (t) => ipcRenderer.invoke('ticker:add', t),
  addBulkTickers: (tickers) => ipcRenderer.invoke('ticker:addBulk', { tickers }),
  removeTicker: (ticker) => ipcRenderer.invoke('ticker:remove', { ticker }),
  listTickers: () => ipcRenderer.invoke('ticker:list'),
  clearTickers: () => ipcRenderer.invoke('ticker:clear'),
  getParams: () => ipcRenderer.invoke('params:get'),
  setParam: (key, value) => ipcRenderer.invoke('params:set', { key, value }),
  backtestScan: (payload) => ipcRenderer.invoke('scan:backtest', payload),
  addTrade: (trade) => ipcRenderer.invoke('trade:add', trade),
  listTrades: () => ipcRenderer.invoke('trade:list'),
  updateTrades: () => ipcRenderer.invoke('trade:update'),
  removeTrade: (id) => ipcRenderer.invoke('trade:remove', { id }),
  clearTrades: () => ipcRenderer.invoke('trade:clear'),
  clearClosedTrades: () => ipcRenderer.invoke('trade:clearClosed'),
  addShortcut: (s) => ipcRenderer.invoke('shortcut:add', s),
  listShortcuts: () => ipcRenderer.invoke('shortcut:list'),
  removeShortcut: (ticker) => ipcRenderer.invoke('shortcut:remove', { ticker }),
  importBulk: (data) => ipcRenderer.invoke('import:bulk', data),
  checkHistory: (ticker) => ipcRenderer.invoke('history:check', { ticker }),
  getTickerDetail: (ticker) => ipcRenderer.invoke('ticker:getDetail', { ticker }),
  syncTickerYahoo: (ticker) => ipcRenderer.invoke('ticker:syncYahoo', { ticker }),
  downloadFullYahooHistory: (ticker) => ipcRenderer.invoke('download-full-yahoo-history', { ticker }),
  deleteTickerHistory: (ticker) => ipcRenderer.invoke('ticker:deleteHistory', { ticker }),
  getTickerDataRange: (ticker) => ipcRenderer.invoke('get-ticker-data-range', { ticker }),
  purgeInactiveStocks: (daysCutoff = 60) => ipcRenderer.invoke('db:purgeInactive', { daysCutoff }),
  syncAllListStocks: (indexFilter) => ipcRenderer.invoke('sync-all-list-stocks', indexFilter),
  checkListFreshness: (indexFilter) => ipcRenderer.invoke('check-list-freshness', indexFilter),
  deleteIndexWithStocks: (indexName) => ipcRenderer.invoke('delete-index-with-stocks', indexName),
  downloadIndexFullHistory: (indexId, operationId) => ipcRenderer.invoke('download-full-history-for-index', { indexId, operationId }),
  onIndexDownloadProgress: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('index-download-progress', handler);
    return () => ipcRenderer.removeListener('index-download-progress', handler);
  },
  // One canonical main-process handler; these aliases exist only for old UI callers.
  fetchIndexFirstDate: (indexId, operationId) => ipcRenderer.invoke('UPDATE_INDEX_FIRST_DATES', { indexId, operationId }),
  fetchIndexFirstDates: (indexId, operationId) => ipcRenderer.invoke('UPDATE_INDEX_FIRST_DATES', { indexId, operationId }),
  updateIndexFirstDates: (indexId, operationId) => ipcRenderer.invoke('UPDATE_INDEX_FIRST_DATES', { indexId, operationId }),
  fetchAndAddCountryIndexStocks: (country, operationId) => ipcRenderer.invoke('fetch-and-add-country-index-stocks', { country, operationId }),
  onCountryIndexProgress: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('country-index-progress', handler);
    return () => ipcRenderer.removeListener('country-index-progress', handler);
  },
  syncIndexFirstDates: (indexId, operationId) => ipcRenderer.invoke('UPDATE_INDEX_FIRST_DATES', { indexId, operationId }),
  onIndexDateProgress: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('UPDATE_INDEX_DATE_PROGRESS', handler);
    return () => ipcRenderer.removeListener('UPDATE_INDEX_DATE_PROGRESS', handler);
  },
  onIndexOperationProgress: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('index-download-progress', handler);
    ipcRenderer.on('UPDATE_INDEX_DATE_PROGRESS', handler);
    ipcRenderer.on('country-index-progress', handler);
    return () => {
      ipcRenderer.removeListener('index-download-progress', handler);
      ipcRenderer.removeListener('UPDATE_INDEX_DATE_PROGRESS', handler);
      ipcRenderer.removeListener('country-index-progress', handler);
    };
  },
  onIndexFirstDateProgress: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('UPDATE_INDEX_DATE_PROGRESS', handler);
    return () => ipcRenderer.removeListener('UPDATE_INDEX_DATE_PROGRESS', handler);
  },
  checkIndexStatus: (indexName) => ipcRenderer.invoke('check-index-status', indexName),
  onFirstDateProgress: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('UPDATE_INDEX_DATE_PROGRESS', handler);
    return () => ipcRenderer.removeListener('UPDATE_INDEX_DATE_PROGRESS', handler);
  },
  importHistoricalCsv: () => ipcRenderer.invoke('import-historical-csv'),
  importHistoricalData: (data) => ipcRenderer.invoke('import-historical-data', data),
  on: (channel, callback) => {
    if (!ALLOWED_EVENTS.has(channel)) {
      throw new Error(`Channel "${channel}" is not allowed`);
    }
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  }
});
