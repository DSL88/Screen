const { contextBridge, ipcRenderer } = require('electron');

const ALLOWED_EVENTS = new Set([
  'scan:progress',
  'scan:row',
  'scan:done',
  'scan:error'
]);

contextBridge.exposeInMainWorld('api', {
  startScan: (tickers) => ipcRenderer.invoke('scan:start', { tickers }),
  cancelScan: (runId) => ipcRenderer.invoke('scan:cancel', { runId }),
  searchTicker: (query) => ipcRenderer.invoke('ticker:search', { query }),
  addTicker: (t) => ipcRenderer.invoke('ticker:add', t),
  removeTicker: (ticker) => ipcRenderer.invoke('ticker:remove', { ticker }),
  listTickers: () => ipcRenderer.invoke('ticker:list'),
  clearTickers: () => ipcRenderer.invoke('ticker:clear'),
  getParams: () => ipcRenderer.invoke('params:get'),
  setParam: (key, value) => ipcRenderer.invoke('params:set', { key, value }),
  backtestScan: (payload) => ipcRenderer.invoke('scan:backtest', payload),
  on: (channel, callback) => {
    if (!ALLOWED_EVENTS.has(channel)) {
      throw new Error(`Channel "${channel}" is not allowed`);
    }
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  }
});
