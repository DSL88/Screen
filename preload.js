const { contextBridge, ipcRenderer } = require('electron');

const ALLOWED_EVENTS = new Set([
  'SIMULATION_PROGRESS',
  'SCAN_PROGRESS',
  'scan:progress',
  'scan:row',
  'scan:done',
  'scan:error',
  'import-success',
  'scanner-sync-status',
  'ticker:synced',
  'SYNC_PROGRESS',
  'SYNC_PROGRESS_UPDATE',
  'SYNC_RECENT_PROGRESS',
  'sync-all-progress',
  'sync-all-done',
  'index-download-progress',
  'first-date-fetch-progress',
  'index-first-date-progress',
  'index-date-progress',
  'UPDATE_INDEX_DATE_PROGRESS',
  'country-index-progress',
  'first-registo-progress',
  'index-sync-progress',
  'simulation:progress',
  'simulation:result',
  'simulation:error'
]);

const apiBridge = {
  startScan: (tickers, params) => ipcRenderer.invoke('scan:start', { tickers, params }),
  cancelScan: (runId) => ipcRenderer.invoke('scan:cancel', { runId }),
  cancelIndexOperation: (operationId) => ipcRenderer.invoke('index:cancel', { operationId }),
  searchTicker: (query, limit) => ipcRenderer.invoke('ticker:search', { query, limit }),
  addTicker: (t) => ipcRenderer.invoke('ticker:add', t),
  addStockToWatchlist: (stockData) => ipcRenderer.invoke('add-stock-to-watchlist', stockData),
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
  getStockDetails: (ticker) => ipcRenderer.invoke('get-stock-details', { ticker }),
  getStockDividends: (ticker) => ipcRenderer.invoke('get-stock-dividends', ticker),
  downloadStockDividends: (ticker) => ipcRenderer.invoke('download-stock-dividends', ticker),
  syncIndexDataBatch: (params) => ipcRenderer.invoke('sync-index-data-batch', params),
  onSyncProgressUpdate: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('SYNC_PROGRESS_UPDATE', handler);
    return () => ipcRenderer.removeListener('SYNC_PROGRESS_UPDATE', handler);
  },
  reconcileAllDates: () => ipcRenderer.invoke('reconcile-all-dates'),
  updateStockMetadata: (ticker, data) => ipcRenderer.invoke('update-stock-metadata', { ticker, data }),
  getDistinctIndices: () => ipcRenderer.invoke('get-distinct-indices'),
  getDistinctCountries: () => ipcRenderer.invoke('get-distinct-countries'),
  syncTickerYahoo: (ticker) => ipcRenderer.invoke('ticker:syncYahoo', { ticker }),
  downloadFullYahooHistory: (ticker) => ipcRenderer.invoke('download-full-yahoo-history', { ticker }),
  deleteTickerHistory: (ticker) => ipcRenderer.invoke('ticker:deleteHistory', { ticker }),
  getTickerDataRange: (ticker) => ipcRenderer.invoke('get-ticker-data-range', { ticker }),
  purgeInactiveStocks: (daysCutoff = 60) => ipcRenderer.invoke('db:purgeInactive', { daysCutoff }),
  syncAudit: (indexFilter) => ipcRenderer.invoke('sync-audit', { indexFilter }),
  syncStartDownload: (indexFilter) => ipcRenderer.invoke('sync-start-download', { indexFilter }),
  syncAllRecentPrices: (indexFilter) => ipcRenderer.invoke('sync-all-recent-prices', indexFilter),
  syncAllListStocks: (indexFilter) => ipcRenderer.invoke('sync-all-recent-prices', indexFilter),
  checkListFreshness: (indexFilter) => ipcRenderer.invoke('check-list-freshness', indexFilter),
  syncIncrementalBatch: (tickers, expectedTradingDay) => ipcRenderer.invoke('sync-incremental-batch', { tickers, expectedTradingDay }),
  processAssetSync: (payload) => ipcRenderer.invoke('process-asset-sync', payload),
  onSyncProgress: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('SYNC_PROGRESS', handler);
    return () => ipcRenderer.removeListener('SYNC_PROGRESS', handler);
  },
  onSyncProgressUpdate: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('SYNC_PROGRESS_UPDATE', handler);
    return () => ipcRenderer.removeListener('SYNC_PROGRESS_UPDATE', handler);
  },
  onSyncRecentProgress: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('SYNC_RECENT_PROGRESS', handler);
    return () => ipcRenderer.removeListener('SYNC_RECENT_PROGRESS', handler);
  },
  runMarketScan: (indexFilter) => ipcRenderer.invoke('RUN_MARKET_SCAN', { indexFilter }),
  onScanProgress: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('SCAN_PROGRESS', handler);
    return () => ipcRenderer.removeListener('SCAN_PROGRESS', handler);
  },
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
  auditIndex: (indexName) => ipcRenderer.invoke('audit-index', indexName),
  syncIndexFirstRecords: (index, operationId) => ipcRenderer.invoke('sync-index-first-records', { index, operationId }),
  onIndexSyncProgress: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('index-sync-progress', handler);
    return () => ipcRenderer.removeListener('index-sync-progress', handler);
  },
  firstRegisto: (index, operationId) => ipcRenderer.invoke('first-registo-index', { index, operationId }),
  onFirstRegistoProgress: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('first-registo-progress', handler);
    return () => ipcRenderer.removeListener('first-registo-progress', handler);
  },
  onFirstDateProgress: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('UPDATE_INDEX_DATE_PROGRESS', handler);
    return () => ipcRenderer.removeListener('UPDATE_INDEX_DATE_PROGRESS', handler);
  },
  importHistoricalCsv: () => ipcRenderer.invoke('import-historical-csv'),
  importHistoricalData: (data) => ipcRenderer.invoke('import-historical-data', data),
  simulationStart: (payload) => ipcRenderer.invoke('simulation:start', payload),
  startSimulation: (params) => ipcRenderer.invoke('START_SIMULATION', params),
  onSimulationProgressSpec: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('SIMULATION_PROGRESS', handler);
    return () => ipcRenderer.removeListener('SIMULATION_PROGRESS', handler);
  },
  simulationCancel: (runId) => ipcRenderer.invoke('simulation:cancel', { runId }),
  simulationOptions: () => ipcRenderer.invoke('simulation:options'),
  onSimulationProgress: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('simulation:progress', handler);
    return () => ipcRenderer.removeListener('simulation:progress', handler);
  },
  onSimulationResult: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('simulation:result', handler);
    return () => ipcRenderer.removeListener('simulation:result', handler);
  },
  onSimulationComplete: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('simulation:result', handler);
    return () => ipcRenderer.removeListener('simulation:result', handler);
  },
  onSimulationError: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('simulation:error', handler);
    return () => ipcRenderer.removeListener('simulation:error', handler);
  },
  runQuantFullPipeline: (payload) => ipcRenderer.invoke('quant:run-full-pipeline', payload),
  runQuantPhase: (phase, params) => ipcRenderer.invoke('quant:run-phase', { phase, params }),
  executeScreener: (payload) => ipcRenderer.invoke('execute-screener', payload),
  saveTrackedAsset: (data) => ipcRenderer.invoke('save-tracked-recommendation', data),
  saveTrackedRecommendation: (data) => ipcRenderer.invoke('save-tracked-recommendation', data),
  evaluateTrackedAssets: (payload) => ipcRenderer.invoke('update-tracker-prices', payload),
  updateTrackerPrices: (payload) => ipcRenderer.invoke('update-tracker-prices', payload),
  getTrackerMetrics: (payload) => ipcRenderer.invoke('quant:get-tracker-metrics', payload),
  getTrackedAssets: (payload) => ipcRenderer.invoke('quant:get-tracked-assets', payload),
  getTrackerDashboard: (payload) => ipcRenderer.invoke('fetch-tracker-data', payload),
  fetchTrackerData: (payload) => ipcRenderer.invoke('fetch-tracker-data', payload),
  on: (channel, callback) => {
    if (!ALLOWED_EVENTS.has(channel)) {
      throw new Error(`Channel "${channel}" is not allowed`);
    }
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  }
};

const quantApiBridge = {
  runScreener: (payload) => ipcRenderer.invoke('execute-screener', payload),
  executeScreener: (payload) => ipcRenderer.invoke('execute-screener', payload),
  runFullPipeline: (payload) => ipcRenderer.invoke('quant:run-full-pipeline', payload),
  runPhase: (phase, params) => ipcRenderer.invoke('quant:run-phase', { phase, params }),
  saveTrackedAsset: (data) => ipcRenderer.invoke('save-tracked-recommendation', data),
  saveTrackedRecommendation: (data) => ipcRenderer.invoke('save-tracked-recommendation', data),
  evaluateTrackedAssets: (payload) => ipcRenderer.invoke('update-tracker-prices', payload),
  updateTrackerPrices: (payload) => ipcRenderer.invoke('update-tracker-prices', payload),
  getTrackerMetrics: (payload) => ipcRenderer.invoke('quant:get-tracker-metrics', payload),
  getTrackedAssets: (payload) => ipcRenderer.invoke('quant:get-tracked-assets', payload),
  getTrackerDashboard: (payload) => ipcRenderer.invoke('fetch-tracker-data', payload),
  fetchTrackerData: (payload) => ipcRenderer.invoke('fetch-tracker-data', payload),
};

contextBridge.exposeInMainWorld('api', apiBridge);
contextBridge.exposeInMainWorld('electronAPI', apiBridge);
contextBridge.exposeInMainWorld('quantAPI', quantApiBridge);


