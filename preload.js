const { contextBridge, ipcRenderer } = require('electron');

const ALLOWED_EVENTS = new Set([
  'scan:progress',
  'scan:row',
  'scan:done',
  'scan:error'
]);

contextBridge.exposeInMainWorld('api', {
  startScan: (tickers, params) => ipcRenderer.invoke('scan:start', { tickers, params }),
  cancelScan: (runId) => ipcRenderer.invoke('scan:cancel', { runId }),
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
  addShortcut: (s) => ipcRenderer.invoke('shortcut:add', s),
  listShortcuts: () => ipcRenderer.invoke('shortcut:list'),
  removeShortcut: (ticker) => ipcRenderer.invoke('shortcut:remove', { ticker }),
  on: (channel, callback) => {
    if (!ALLOWED_EVENTS.has(channel)) {
      throw new Error(`Channel "${channel}" is not allowed`);
    }
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  }
});
