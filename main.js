const { app, BrowserWindow, ipcMain, Menu } = require('electron');
const path = require('path');
const Database = require('./src/db/database');
const Scanner = require('./src/engine/scanner');
const yahooClient = require('./src/data/yahooClient');

let mainWindow = null;
let db = null;
let scanner = null;

const singleInstanceLock = app.requestSingleInstanceLock();
if (!singleInstanceLock) {
  app.quit();
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#0d0f12',
    title: 'Markov Stock Scanner',
    titleBarStyle: process.platform === 'darwin' ? 'hidden' : 'default',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: true
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  const template = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        process.platform === 'darwin' ? { role: 'close' } : { role: 'quit' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(async () => {
  try {
    db = new Database(app.getPath('userData'));
    await db.init();
    scanner = new Scanner(db);

    ipcMain.handle('scan:start', async (_event, payload) => {
      if (!mainWindow) return { ok: false, error: 'window-unavailable' };
      const runId = `run_${Date.now()}`;
      const tickers = Array.isArray(payload?.tickers) ? payload.tickers : [];
      scanner.run({ tickers, ...payload?.params }, runId, {
        onProgress: (p) => mainWindow.webContents.send('scan:progress', p),
        onRow: (r) => mainWindow.webContents.send('scan:row', r),
        onError: (e) => mainWindow.webContents.send('scan:error', e),
        onDone: (d) => mainWindow.webContents.send('scan:done', d)
      });
      return { ok: true, runId };
    });

    ipcMain.handle('scan:cancel', async (_event, payload) => {
      if (scanner) scanner.cancel(payload?.runId);
      return { ok: true };
    });

    ipcMain.handle('ticker:search', async (_event, payload) => {
      const query = (payload && payload.query) || '';
      const limit = (payload && payload.limit) || 5;
      try {
        const tickerResults = await yahooClient.searchTickers(query, limit);
        return { ok: true, tickers: Array.isArray(tickerResults) ? tickerResults : [] };
      } catch (err) {
        console.error('[ticker:search] falha na pesquisa Yahoo:', err && err.message ? err.message : err);
        return { ok: false, error: err && err.message ? err.message : String(err), tickers: [] };
      }
    });

    ipcMain.handle('ticker:add', async (_event, payload) => {
      if (!payload || !payload.ticker) return { ok: false, error: 'missing-ticker' };
      db.addCustomTicker({
        ticker: payload.ticker,
        name: payload.name || '',
        exchange: payload.exchange || '',
        type: payload.type || ''
      });
      return { ok: true };
    });

    ipcMain.handle('ticker:remove', async (_event, payload) => {
      if (!payload || !payload.ticker) return { ok: false, error: 'missing-ticker' };
      db.removeCustomTicker(payload.ticker);
      return { ok: true };
    });

    ipcMain.handle('ticker:list', async () => {
      const custom = db.getCustomTickers();
      return {
        ok: true,
        custom
      };
    });

    ipcMain.handle('ticker:clear', async () => {
      db.clearCustomTickers();
      return { ok: true };
    });

    ipcMain.handle('params:get', async () => {
      const params = db.getAdaptiveParams();
      return { ok: true, params };
    });

    ipcMain.handle('params:set', async (_event, payload) => {
      if (!payload || !payload.key) return { ok: false, error: 'missing-key' };
      db.setAdaptiveParam(payload.key, payload.value);
      return { ok: true };
    });

    ipcMain.handle('scan:backtest', async (_event, payload) => {
      const tickers = (payload && payload.tickers) || [];
      const startDate = (payload && payload.startDate) || '';
      const endDate = (payload && payload.endDate) || '';
      if (!scanner) return { ok: false, error: 'scanner-not-initialized' };
      try {
        const runId = Math.random().toString(36).substring(7);
        const results = await scanner.runBacktest({ tickers, startDate, endDate }, runId);
        return { ok: true, results };
      } catch (err) {
        return { ok: false, error: err.message || String(err) };
      }
    });

    ipcMain.handle('trade:add', async (_event, payload) => {
      if (!payload) return { ok: false, error: 'missing-payload' };
      try {
        db.addActiveTrade(payload);
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err.message || String(err) };
      }
    });

    ipcMain.handle('trade:list', async () => {
      try {
        const active = db.getActiveTrades();
        const closed = db.getClosedActiveTrades(50);
        return { ok: true, active, closed };
      } catch (err) {
        return { ok: false, error: err.message || String(err) };
      }
    });

    ipcMain.handle('trade:update', async () => {
      if (!scanner) return { ok: false, error: 'scanner-not-initialized' };
      try {
        const result = await scanner.updateActiveTrades();
        return { ok: true, ...result };
      } catch (err) {
        return { ok: false, error: err.message || String(err) };
      }
    });

    ipcMain.handle('shortcut:add', async (_event, payload) => {
      if (!payload || !payload.ticker) return { ok: false, error: 'missing-ticker' };
      try {
        if (payload.isBulk === true || /^MERCADO_/i.test(String(payload.ticker))) {
          const marketId = String(payload.ticker).replace(/^MERCADO_/i, '');
          const bulkInfo = yahooClient.getBulkIndexTickers(marketId);
          if (!bulkInfo || !Array.isArray(bulkInfo.tickers) || bulkInfo.tickers.length === 0) {
            return { ok: false, error: 'unknown-market:' + marketId };
          }
          const items = bulkInfo.tickers.map(t => ({
            ticker: t.ticker,
            name: t.name,
            exchange: t.exchange || bulkInfo.exchange || '',
            type: t.type || 'EQUITY',
            mercado: bulkInfo.id,
            tipo: 'EQUITY'
          }));
          const result = db.addShortcut(items);
          return { ok: true, bulk: true, mercado: bulkInfo.id, count: result && typeof result.changes === 'number' ? result.changes : items.length };
        }

        db.addShortcut(
          payload.ticker,
          payload.nome || payload.ticker,
          payload.mercado || '',
          payload.tipo || ''
        );
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err.message || String(err) };
      }
    });

    ipcMain.handle('shortcut:list', async () => {
      try {
        const shortcuts = db.getShortcuts();
        return { ok: true, shortcuts };
      } catch (err) {
        return { ok: false, error: err.message || String(err) };
      }
    });

    ipcMain.handle('shortcut:remove', async (_event, payload) => {
      if (!payload || !payload.ticker) return { ok: false, error: 'missing-ticker' };
      try {
        db.removeShortcut(payload.ticker);
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err.message || String(err) };
      }
    });

    createWindow();
  } catch (err) {
    console.error('Fatal init error:', err);
    app.quit();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

app.on('before-quit', () => {
  if (db) db.close();
});
