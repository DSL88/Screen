const { app, BrowserWindow, ipcMain, Menu, dialog } = require('electron');
const { Worker } = require('worker_threads');
const path = require('path');
const fs = require('fs');
const os = require('os');
const Database = require('./src/db/database');
const yahooClient = require('./src/data/yahooClient');
const tickerLists = require('./src/data/tickerLists');
const { isIncrementalUpToDate, addDays } = require('./src/utils/dateUtils');
const { parseFile, importFromCsvFile } = require('./src/importer/historicalImporter');

// Pre-calculate mapping from ticker to index ID for fast lookup
const tickerToIndexMap = {};
const indexNames = {};

for (const [indexId, list] of Object.entries(tickerLists.INDICES || {})) {
  for (const item of list) {
    if (item.ticker) {
      tickerToIndexMap[item.ticker.toUpperCase().trim()] = indexId;
    }
  }
}

for (const idx of tickerLists.WORLD_INDICES || []) {
  indexNames[idx.id] = idx.name;
}


let mainWindow = null;
let db = null;
let scannerWorker = null;

// ═══════════════════════════════════════════════════════════
//  Worker Thread — gestão do scanner fora do Main Process
// ═══════════════════════════════════════════════════════════
function getScannerWorker() {
  if (scannerWorker && !scannerWorker.isTerminated) return scannerWorker;

  scannerWorker = new Worker(path.join(__dirname, 'src/engine/scanner.worker.js'));

  scannerWorker.on('message', (msg) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;

    switch (msg.type) {
      case 'progress':
        mainWindow.webContents.send('scan:progress', msg.payload);
        break;

      case 'row': {
        // ── Guard clause: validar campos NOT NULL antes do INSERT ──
        const p = msg.payload;
        if (p.p_stay == null || !Number.isFinite(p.p_stay)) {
          console.error(`[Worker] Insert bloqueado: p_stay inválido (${p.p_stay}) para ${p.ticker}`);
          break;
        }
        if (p.edge == null || !Number.isFinite(p.edge)) {
          console.error(`[Worker] Insert bloqueado: edge inválido (${p.edge}) para ${p.ticker}`);
          break;
        }
        if (p.preco_entrada == null || !Number.isFinite(p.preco_entrada) || p.preco_entrada <= 0) {
          console.error(`[Worker] Insert bloqueado: preco_entrada inválido (${p.preco_entrada}) para ${p.ticker}`);
          break;
        }

        try {
          const id = db.insertSignal(p);
          // Enviar ao renderer com os campos camelCase
          const rendererData = p._renderer || {};
          mainWindow.webContents.send('scan:row', { id, ...rendererData });
        } catch (err) {
          console.error(`[Worker] Falha ao inserir sinal (${p.ticker}):`, err.message);
        }
        break;
      }

      case 'error':
        mainWindow.webContents.send('scan:error', msg.payload);
        break;

      case 'done':
        // Auto-tuning adaptativo no processo principal (precisa de DB)
        try {
          _tuneAdaptiveParams();
        } catch (_) { /* ignorar falhas de tuning */ }
        mainWindow.webContents.send('scan:done', msg.payload);
        break;

      case 'sync-status':
        mainWindow.webContents.send('scanner-sync-status', msg.payload);
        break;

      case 'cacheOHLCV':
        // Cache de candles no DB a partir do processo principal
        try {
          db.cacheOHLCV(msg.payload.key, msg.payload.candles);
        } catch (_) { /* ignorar */ }
        break;

      case 'getLastStoredDate': {
        // Worker pede a última data guardada para um ticker
        const requestId = msg.requestId;
        try {
          const lastDate = db.getLastStoredDate(msg.payload.ticker);
          scannerWorker.postMessage({
            type: 'dbResponse',
            requestId,
            ok: true,
            data: lastDate
          });
        } catch (err) {
          scannerWorker.postMessage({
            type: 'dbResponse',
            requestId,
            ok: false,
            error: err.message
          });
        }
        break;
      }

      case 'getLocalHistoricalPrices': {
        // Worker pede o histórico local completo para um ticker
        const requestId = msg.requestId;
        try {
          const prices = db.getLocalHistoricalPrices(msg.payload.ticker);
          scannerWorker.postMessage({
            type: 'dbResponse',
            requestId,
            ok: true,
            data: prices
          });
        } catch (err) {
          scannerWorker.postMessage({
            type: 'dbResponse',
            requestId,
            ok: false,
            error: err.message
          });
        }
        break;
      }

      case 'getLocalHistoricalPricesLimit': {
        const requestId = msg.requestId;
        try {
          const prices = db.getLocalHistoricalPricesLimit(msg.payload.ticker, msg.payload.limit);
          scannerWorker.postMessage({
            type: 'dbResponse',
            requestId,
            ok: true,
            data: prices
          });
        } catch (err) {
          scannerWorker.postMessage({
            type: 'dbResponse',
            requestId,
            ok: false,
            error: err.message
          });
        }
        break;
      }

      case 'saveHistoricalCandles': {
        const requestId = msg.requestId;
        try {
          const result = db.saveHistoricalCandles(msg.payload.candles);          scannerWorker.postMessage({
            type: 'dbResponse',
            requestId,
            ok: true,
            data: result
          });
        } catch (err) {
          scannerWorker.postMessage({
            type: 'dbResponse',
            requestId,
            ok: false,
            error: err.message
          });
        }
        break;
      }

      case 'getTickerDataRange': {
        const requestId = msg.requestId;
        try {
          const range = db.getTickerDataRange(msg.payload.ticker);
          scannerWorker.postMessage({
            type: 'dbResponse',
            requestId,
            ok: true,
            data: range
          });
        } catch (err) {
          scannerWorker.postMessage({
            type: 'dbResponse',
            requestId,
            ok: false,
            error: err.message
          });
        }
        break;
      }

      case 'backtestResult':
        // Tratado via Promise no handler, não reencaminhar
        break;

      case 'updateResult':
        // Tratado via Promise no handler
        break;
    }
  });

  scannerWorker.on('error', (err) => {
    console.error('[Worker] Erro fatal:', err);
    scannerWorker = null;
  });

  scannerWorker.on('exit', (code) => {
    if (code !== 0) console.error('[Worker] Terminou com código', code);
    scannerWorker = null;
  });

  return scannerWorker;
}

// ═══════════════════════════════════════════════════════════
//  Auto-tuning adaptativo (replicado do Scanner, mas no main)
// ═══════════════════════════════════════════════════════════
function _tuneAdaptiveParams() {
  const ADAPTIVE_WINDOW = 50;
  const EDGE_MIN = 0.10;
  const EDGE_MAX = 0.30;
  const WINDOW_MIN = 100;
  const WINDOW_MAX = 200;

  const closed = db.getClosedTrades(ADAPTIVE_WINDOW);
  if (closed.length < ADAPTIVE_WINDOW) return;

  const sorted = [...closed].sort((a, b) => a.edge - b.edge);
  const quartiles = [[], [], [], []];
  sorted.forEach((t, i) => quartiles[Math.min(3, Math.floor(i / sorted.length * 4))].push(t));

  let bestQ = 0;
  let bestExpectancy = -Infinity;
  quartiles.forEach((bucket, idx) => {
    if (bucket.length === 0) return;
    const wins = bucket.filter(t => (t.resultado_pct || 0) > 0).length;
    const avg = bucket.reduce((a, t) => a + (t.resultado_pct || 0), 0) / bucket.length;
    const winRate = wins / bucket.length;
    const expectancy = winRate * avg - (1 - winRate) * Math.abs(avg);
    if (expectancy > bestExpectancy) {
      bestExpectancy = expectancy;
      bestQ = idx;
    }
  });

  const current = db.getAdaptiveParams();
  const step = 0.02;
  const targetEdge = bestQ === 0
    ? current.edge_threshold - step
    : bestQ === 3
      ? current.edge_threshold + step
      : current.edge_threshold;
  const newEdge = Math.max(EDGE_MIN, Math.min(EDGE_MAX, targetEdge));
  if (newEdge !== current.edge_threshold) {
    db.setAdaptiveParam('edge_threshold', newEdge);
  }

  const newWindow = bestQ === 3
    ? Math.min(WINDOW_MAX, current.markov_window + 10)
    : bestQ === 0
      ? Math.max(WINDOW_MIN, current.markov_window - 10)
      : current.markov_window;
  if (newWindow !== current.markov_window) {
    db.setAdaptiveParam('markov_window', newWindow);
  }
}

// ═══════════════════════════════════════════════════════════
//  Resolução de parâmetros (UI > SQLite)
// ═══════════════════════════════════════════════════════════
function resolveParams(uiParams) {
  const dbParams = db.getAdaptiveParams();

  const uiEdge = uiParams?.edge_threshold ?? uiParams?.edgeThreshold;
  const uiWindow = uiParams?.markov_window ?? uiParams?.markovWindow;
  const uiVolume = uiParams?.volume_mult ?? uiParams?.volumeMult;
  const uiHorizon = uiParams?.horizon_days ?? uiParams?.horizonDays;
  const uiUseVolFilter = uiParams?.useVolFilter;
  const uiUseLatestClosed = uiParams?.useLatestClosed ?? uiParams?.use_latest_closed;
  const uiTimeframe = uiParams?.timeframe;

  return {
    edge_threshold: uiEdge != null ? Number(uiEdge) : Number(dbParams.edge_threshold),
    markov_window: uiWindow != null ? Number(uiWindow) : Number(dbParams.markov_window),
    volume_mult: uiVolume != null ? Number(uiVolume) : Number(dbParams.volume_mult),
    horizon_days: uiHorizon != null ? Number(uiHorizon) : Number(dbParams.horizon_days),
    useVolFilter: uiUseVolFilter !== undefined ? Boolean(uiUseVolFilter) : true,
    useLatestClosed: uiUseLatestClosed === true,
    timeframe: uiTimeframe || '1d'
  };
}

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

    // ═══════════════════════════════════════════════════════
    //  SCAN — Execução via Worker Thread
    // ═══════════════════════════════════════════════════════
    ipcMain.handle('scan:start', async (_event, payload) => {
      if (!mainWindow) return { ok: false, error: 'window-unavailable' };
      const runId = `run_${Date.now()}`;
      const tickers = Array.isArray(payload?.tickers) ? payload.tickers : [];
      const params = resolveParams(payload?.params);
      const timeframe = payload?.params?.timeframe || params.timeframe || '1d';

      const worker = getScannerWorker();
      worker.postMessage({
        action: 'scan',
        runId,
        tickers,
        params,
        timeframe
      });

      return { ok: true, runId };
    });

    // ═══════════════════════════════════════════════════════
    //  CANCEL — Encaminhar para Worker
    // ═══════════════════════════════════════════════════════
    ipcMain.handle('scan:cancel', async (_event, payload) => {
      const worker = getScannerWorker();
      worker.postMessage({ action: 'cancel', runId: payload?.runId });
      return { ok: true };
    });

    // ═══════════════════════════════════════════════════════
    //  BACKTEST — Execução via Worker Thread
    // ═══════════════════════════════════════════════════════
    ipcMain.handle('scan:backtest', async (_event, payload) => {
      const tickers = (payload && payload.tickers) || [];
      const startDate = (payload && payload.startDate) || '';
      const endDate = (payload && payload.endDate) || '';
      const params = resolveParams(payload?.params || {});
      const timeframe = payload?.params?.timeframe || params.timeframe || '1d';

      // Pré-carregar candles do cache DB para o worker
      const cachedCandles = {};
      for (const t of tickers) {
        const cacheKey = `${t.ticker}_${timeframe}`;
        try {
          const cached = db.getCachedOHLCV(cacheKey);
          if (cached) cachedCandles[cacheKey] = cached;
        } catch (_) { /* sem cache disponível */ }
      }

      const requestId = `bt_${Date.now()}`;

      return new Promise((resolve) => {
        const worker = getScannerWorker();
        const timeout = setTimeout(() => {
          worker.removeListener('message', handler);
          resolve({ ok: false, error: 'Worker timeout (10 min)' });
        }, 600000);

        const handler = (msg) => {
          if (msg.type === 'backtestResult' && msg.payload.requestId === requestId) {
            clearTimeout(timeout);
            worker.removeListener('message', handler);
            resolve({ ok: true, results: msg.payload.results });
          }
        };

        worker.on('message', handler);
        worker.postMessage({
          action: 'backtest',
          requestId,
          tickers,
          params,
          timeframe,
          startDate,
          endDate,
          cachedCandles
        });
      });
    });

    // ═══════════════════════════════════════════════════════
    //  TRADE UPDATE — Execução via Worker Thread
    // ═══════════════════════════════════════════════════════
    ipcMain.handle('trade:update', async () => {
      const activeTrades = db.getActiveTrades();
      if (!Array.isArray(activeTrades) || activeTrades.length === 0) {
        return { ok: true, updated: 0, closed: [], states: [], message: 'Nenhum trade ativo para monitorizar.' };
      }

      return new Promise((resolve) => {
        const worker = getScannerWorker();
        const timeout = setTimeout(() => {
          worker.removeListener('message', handler);
          resolve({ ok: false, error: 'Worker timeout' });
        }, 120000);

        const handler = (msg) => {
          if (msg.type === 'updateResult') {
            clearTimeout(timeout);
            worker.removeListener('message', handler);

            // Fechar trades no DB a partir do processo principal
            if (msg.payload.closed && msg.payload.closed.length > 0) {
              for (const c of msg.payload.closed) {
                try {
                  db.closeActiveTrade(c.id, c.exitPrice, c.resultado);
                } catch (err) {
                  console.error('[trade:update] Falha ao fechar trade:', err.message);
                }
              }
            }

            resolve({ ok: true, updated: msg.payload.updated, closed: msg.payload.closed, states: msg.payload.states, message: msg.payload.message });
          }
        };

        worker.on('message', handler);
        worker.postMessage({ action: 'updateTrades', activeTrades });
      });
    });

    // ═══════════════════════════════════════════════════════
    //  Restantes handlers (sem alterações)
    // ═══════════════════════════════════════════════════════
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
      const symbolUpper = String(payload.ticker).toUpperCase().trim();
      const country = payload.country || '';
      const indexName = payload.indexName || payload.index_name || payload.index;

      if (!indexName) {
        return { ok: false, error: 'missing-index-name' };
      }

      // 1. Guardar na tabela custom_tickers
      db.addCustomTicker({
        ticker: symbolUpper,
        name: payload.name || symbolUpper,
        exchange: payload.exchange || '',
        type: payload.type || 'EQUITY',
        country,
        indexName
      });

      // 2. Guardar/Atualizar na tabela stocks garantindo que index_name guarda rigorosamente o índice selecionado pelo utilizador
      db.upsertStock({
        ticker: symbolUpper,
        name: payload.name || symbolUpper,
        country,
        indexName
      });

      // 3. Atualizar o mapa em memória
      tickerToIndexMap[symbolUpper] = indexName;

      return { ok: true };
    });

    ipcMain.handle('ticker:addBulk', async (_event, payload) => {
      if (!payload || !Array.isArray(payload.tickers) || payload.tickers.length === 0) {
        return { ok: false, error: 'missing-tickers' };
      }
      try {
        const result = db.addCustomTickersBulk(payload.tickers);
        return { ok: true, count: result.changes || 0, total: result.total || payload.tickers.length };
      } catch (err) {
        return { ok: false, error: err.message || String(err) };
      }
    });

    ipcMain.handle('ticker:remove', async (_event, payload) => {
      if (!payload || !payload.ticker) return { ok: false, error: 'missing-ticker' };
      db.removeCustomTicker(payload.ticker);
      return { ok: true };
    });

    ipcMain.handle('ticker:list', async () => {
      const custom = db.getCustomTickers();
      const tickerSymbols = custom.map(t => String(t.ticker || '').toUpperCase().trim());
      const batchSummary = db.getHistoricalSummaryBatch(tickerSymbols);

      const cutoffDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

      const lastDateMap = {};
      if (tickerSymbols.length > 0) {
        const lastDateRows = db.db.prepare(`
          SELECT ticker, MAX(date) as max_date
          FROM historical_prices
          WHERE ticker IN (${tickerSymbols.map(() => '?').join(',')})
          GROUP BY ticker
        `).all(...tickerSymbols);
        for (const r of lastDateRows) {
          lastDateMap[r.ticker] = r.max_date;
        }
      }

      const enrichedCustom = custom.map(t => {
        const symbolUpper = String(t.ticker || '').toUpperCase().trim();
        const stockRecord = db.getStockByTicker(symbolUpper);
        
        const customIdx = stockRecord?.index_name || t.index_name || t.indexName || t.index;
        const indexId = customIdx || tickerToIndexMap[symbolUpper] || 'CUSTOM';
        const indexName = indexNames[indexId] || indexId || 'Outros Ativos / Manuais';
        const summary = batchSummary[symbolUpper];
        const maxDate = lastDateMap[symbolUpper] || null;
        const inativo = summary && summary.hasData && (!maxDate || maxDate < cutoffDate);
        return {
          ...t,
          country: stockRecord?.country || t.country || '',
          indexId,
          indexName,
          temHistorico: !!(summary && summary.hasData),
          primeiroRegisto: (summary && summary.firstDate) || null,
          ultimaData: (summary && summary.lastDate) || null,
          totalVelas: (summary && summary.totalCandles) || 0,
          inativo: !!inativo,
          fullHistoryFetched: !!(summary && summary.fullHistoryFetched),
          first_date: stockRecord?.first_date || null
        };
      });
      return { ok: true, custom: enrichedCustom };
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

    ipcMain.handle('trade:remove', async (_event, payload) => {
      if (!payload || (!payload.id && !payload.ticker)) {
        return { ok: false, error: 'missing-id-or-ticker' };
      }
      try {
        let result;
        if (payload.id != null) {
          result = db.removeActiveTrade(payload.id);
        } else {
          const r = db.db.prepare("DELETE FROM active_trades WHERE ticker = ? AND status = 'aberto'")
            .run(String(payload.ticker).toUpperCase().trim());
          result = r;
        }
        return { ok: true, changes: result && typeof result.changes === 'number' ? result.changes : 0 };
      } catch (err) {
        return { ok: false, error: err.message || String(err) };
      }
    });

    ipcMain.handle('trade:clear', async () => {
      try {
        const result = db.clearActiveTrades();
        return { ok: true, changes: result && typeof result.changes === 'number' ? result.changes : 0 };
      } catch (err) {
        return { ok: false, error: err.message || String(err) };
      }
    });

    ipcMain.handle('trade:clearClosed', async () => {
      try {
        const result = db.clearClosedTrades();
        return { ok: true, changes: result && typeof result.changes === 'number' ? result.changes : 0 };
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

    // ═══════════════════════════════════════════════════════
    //  IMPORT BULK — Import historical data from CSV/XLSX
    // ═══════════════════════════════════════════════════════
    ipcMain.handle('import:bulk', async (_event, payload) => {
      if (!payload || !payload.ticker || (!payload.filePath && !payload.fileData)) {
        return { ok: false, error: 'missing-ticker-or-file' };
      }

      let tmpPath = null;

      try {
        let filePath = payload.filePath;

        // If fileData (binary array) was sent instead of a path, write to temp file
        if (!filePath && payload.fileData && payload.fileName) {
          const ext = path.extname(payload.fileName).toLowerCase();
          tmpPath = path.join(os.tmpdir(), `bulk-import-${Date.now()}${ext}`);
          fs.writeFileSync(tmpPath, Buffer.from(payload.fileData));
          filePath = tmpPath;
        }

        if (!filePath) {
          return { ok: false, error: 'missing-ticker-or-file' };
        }

        const ticker = payload.ticker.toUpperCase().trim();

        db.upsertStock({
          ticker,
          name: payload.name || payload.ticker,
          country: payload.country || '',
          indexName: payload.indexName || ''
        });

        const parseResult = parseFile(filePath);
        if (!parseResult.ok) {
          return { ok: false, error: parseResult.error };
        }

        const result = db.saveHistoricalCandlesFromImport(ticker, parseResult.candles);
        const count = result.changes;
        const firstDate = parseResult.candles[0].date;
        const lastDate = parseResult.candles[parseResult.candles.length - 1].date;

        const newSummary = db.getHistoricalSummary(ticker);

        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('import-success', {
            ticker,
            totalCandles: count,
            startDate: firstDate,
            endDate: lastDate,
            summary: newSummary
          });
        }

        return {
          ok: true,
          count,
          ticker,
          firstDate,
          lastDate,
          summary: newSummary,
          message: `${count} velas importadas para ${ticker}`
        };
      } catch (err) {
        console.error('[import:bulk] Error:', err.message);
        return { ok: false, error: err.message || String(err) };
      } finally {
        // Clean up temp file
        if (tmpPath) {
          try { fs.unlinkSync(tmpPath); } catch (_) { /* ignore */ }
        }
      }
    });

    // ═══════════════════════════════════════════════════════
    //  IMPORT HISTORICAL DATA — Import from file path (CSV/XLSX)
    // ═══════════════════════════════════════════════════════
    ipcMain.handle('import-historical-data', async (_event, payload) => {
      if (!payload || !payload.ticker || !payload.filePath) {
        return { ok: false, error: 'missing-ticker-or-filePath' };
      }

      const ticker = payload.ticker.toUpperCase().trim();

      try {
        const parseResult = parseFile(payload.filePath);
        if (!parseResult.ok) {
          return { ok: false, error: parseResult.error };
        }

        db.upsertStock({
          ticker,
          name: payload.name || ticker,
          country: payload.country || '',
          indexName: payload.indexName || ''
        });

        const result = db.saveHistoricalCandlesFromImport(ticker, parseResult.candles);
        const count = result.changes;
        const firstDate = parseResult.candles[0].date;
        const lastDate = parseResult.candles[parseResult.candles.length - 1].date;
        const newSummary = db.getHistoricalSummary(ticker);

        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('import-success', {
            ticker,
            totalCandles: count,
            startDate: firstDate,
            endDate: lastDate,
            summary: newSummary
          });
        }

        return {
          ok: true,
          count,
          ticker,
          firstDate,
          lastDate,
          summary: newSummary,
          message: `${count} velas importadas para ${ticker}`
        };
      } catch (err) {
        console.error('[import-historical-data] Error:', err.message);
        return { ok: false, error: err.message || String(err) };
      }
    });

    // ═══════════════════════════════════════════════════════
    //  IMPORT HISTORICAL CSV — Manual CSV import via native dialog
    // ═══════════════════════════════════════════════════════
    ipcMain.handle('import-historical-csv', async () => {
      if (!mainWindow || mainWindow.isDestroyed()) {
        return { ok: false, error: 'window-unavailable' };
      }

      const result = await dialog.showOpenDialog(mainWindow, {
        title: 'Selecionar ficheiro CSV histórico',
        properties: ['openFile'],
        filters: [{ name: 'CSV Files', extensions: ['csv'] }]
      });

      if (result.canceled || !result.filePaths.length) {
        return { ok: false, error: 'cancelled' };
      }

      const filePath = result.filePaths[0];

      try {
        const importResult = await importFromCsvFile(filePath, db);
        if (!importResult.ok) {
          return { ok: false, error: importResult.error };
        }

        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('import-success', {
            ticker: null,
            totalCandles: importResult.inserted,
            startDate: importResult.firstDate,
            endDate: importResult.lastDate,
            summary: null
          });
        }

        return {
          ok: true,
          inserted: importResult.inserted,
          skipped: importResult.skipped,
          firstDate: importResult.firstDate,
          lastDate: importResult.lastDate,
          message: `${importResult.inserted} velas importadas (${importResult.skipped} ignoradas)`
        };
      } catch (err) {
        console.error('[import-historical-csv] Error:', err.message);
        return { ok: false, error: err.message || String(err) };
      }
    });

    // ═══════════════════════════════════════════════════════
    //  HISTORY CHECK — Verify if ticker has imported data
    // ═══════════════════════════════════════════════════════
    ipcMain.handle('history:check', async (_event, payload) => {
      const ticker = payload && payload.ticker ? String(payload.ticker).toUpperCase().trim() : '';
      if (!ticker) return { ok: false, error: 'missing-ticker' };
      try {
        const hasData = db.hasHistoricalData(ticker);
        const summary = db.getHistoricalSummary(ticker);
        return { ok: true, ticker, hasData, summary };
      } catch (err) {
        return { ok: false, error: err.message || String(err) };
      }
    });

    ipcMain.handle('ticker:getDetail', async (_event, payload) => {
      const ticker = payload && payload.ticker ? String(payload.ticker).toUpperCase().trim() : '';
      if (!ticker) return { ok: false, error: 'missing-ticker' };
      try {
        const stock = db.getStockByTicker(ticker);
        const summary = db.getHistoricalSummary(ticker);
        const customTicker = db.db.prepare(
          'SELECT ticker, name, exchange, type FROM custom_tickers WHERE ticker = ?'
        ).get(ticker);
        return {
          ok: true,
          ticker,
          stock: stock || null,
          summary,
          custom: customTicker || null
        };
      } catch (err) {
        return { ok: false, error: err.message || String(err) };
      }
    });

    ipcMain.handle('ticker:syncYahoo', async (_event, payload) => {
      const ticker = payload && payload.ticker ? String(payload.ticker).toUpperCase().trim() : '';
      if (!ticker) return { ok: false, error: 'missing-ticker' };
      try {
        const lastDate = db.getLastStoredDate(ticker);
        const expected = db.getLastExpectedTradingDay();
        if (isIncrementalUpToDate(lastDate, expected)) {
          return { ok: true, ticker, newCandles: 0, message: 'Dados já atualizados.' };
        }
        const next = lastDate ? addDays(lastDate, 1) : null;
        const customPeriod1 = next ? new Date(next + 'T00:00:00Z') : null;

        let candles;
        try {
          candles = await yahooClient.fetchWithRetry(ticker, '1d', 3, customPeriod1);
        } catch (fetchErr) {
          if (lastDate) {
            return {
              ok: false,
              error: fetchErr.message || String(fetchErr),
              hasLocalData: true,
              ticker,
              warning: 'Falha na sincronização online. A usar histórico local desatualizado.'
            };
          }
          throw fetchErr;
        }

        if (!candles || candles.length === 0) {
          return { ok: true, ticker, newCandles: 0, message: 'Dados já atualizados.' };
        }

        const result = db.saveHistoricalCandlesFromImport(ticker, candles);
        db.cacheOHLCV(ticker, candles);

        const newSummary = db.getHistoricalSummary(ticker);

        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('ticker:synced', {
            ticker,
            newCandles: result.changes,
            summary: newSummary
          });
        }

        return {
          ok: true,
          ticker,
          newCandles: result.changes,
          summary: newSummary
        };
      } catch (err) {
        return { ok: false, error: err.message || String(err) };
      }
    });

    ipcMain.handle('download-full-yahoo-history', async (_event, payload) => {
      const ticker = payload && payload.ticker ? String(payload.ticker).toUpperCase().trim() : '';
      if (!ticker) return { ok: false, error: 'missing-ticker' };
      try {
        const candles = await yahooClient.fetchFullYahooHistory(ticker);
        if (candles && candles.length > 0) {
          const result = db.saveHistoricalCandlesFromImport(ticker, candles);
          db.cacheOHLCV(ticker, candles);
          try { db.setFullHistoryFetched(ticker); } catch (_e) { /* ignore */ }
          const newSummary = db.getHistoricalSummary(ticker);
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('ticker:synced', {
              ticker,
              newCandles: result.changes,
              summary: newSummary
            });
          }
          return {
            ok: true,
            ticker,
            totalCandles: newSummary ? newSummary.totalCandles : result.changes,
            summary: newSummary
          };
        }
        return { ok: true, ticker, totalCandles: 0, summary: null };
      } catch (err) {
        return { ok: false, error: err.message || String(err) };
      }
    });

    ipcMain.handle('ticker:deleteHistory', async (_event, payload) => {
      const ticker = payload && payload.ticker ? String(payload.ticker).toUpperCase().trim() : '';
      if (!ticker) return { ok: false, error: 'missing-ticker' };
      try {
        const result = db.deleteHistoricalPrices(ticker);
        return { ok: true, ticker, deleted: result.changes };
      } catch (err) {
        return { ok: false, error: err.message || String(err) };
      }
    });

    ipcMain.handle('get-ticker-data-range', async (_event, payload) => {
      const ticker = payload && payload.ticker ? String(payload.ticker).toUpperCase().trim() : '';
      if (!ticker) return { ok: false, error: 'missing-ticker' };
      try {
        const result = db.getTickerDataRange(ticker);
        return { ok: true, ticker, data: result };
      } catch (err) {
        return { ok: false, error: err.message || String(err) };
      }
    });

    ipcMain.handle('db:purgeInactive', async (_event, payload) => {
      try {
        const days = payload && payload.daysCutoff ? Number(payload.daysCutoff) : 60;
        const result = db.purgeInactiveStocks(days);
        return { ok: true, ...result };
      } catch (err) {
        return { ok: false, error: err.message || String(err) };
      }
    });

    ipcMain.handle('check-list-freshness', async (_event, indexFilter) => {
      try {
        const result = db.checkListFreshness(indexFilter || null);
        return { ok: true, ...result };
      } catch (err) {
        return { ok: false, error: err.message || String(err) };
      }
    });

    ipcMain.handle('sync-all-list-stocks', async (_event, indexFilter) => {
      if (!mainWindow || mainWindow.isDestroyed()) return { ok: false, error: 'window-unavailable' };

      const SYNC_CHUNK_SIZE = 5;
      const SYNC_IPC_BATCH = 10;
      const sleep = ms => new Promise(res => setTimeout(res, ms));

      try {
        const tickers = db.getTickersByIndex(indexFilter || null);
        if (!tickers || tickers.length === 0) {
          return { ok: true, totalStocks: 0, updatedCount: 0, totalNewCandles: 0, errors: [], message: 'Nenhum ativo na lista para sincronizar.' };
        }

        let updatedCount = 0;
        let totalNewCandles = 0;
        const errors = [];
        const expected = db.getLastExpectedTradingDay();
        const updatedSummaries = [];
        let completed = 0;

        for (let i = 0; i < tickers.length; i += SYNC_CHUNK_SIZE) {
          const chunk = tickers.slice(i, i + SYNC_CHUNK_SIZE);

          const results = await Promise.all(chunk.map(async (ticker) => {
            try {
              const lastDate = db.getLastStoredDate(ticker);
              if (!lastDate || isIncrementalUpToDate(lastDate, expected)) {
                return { ticker, status: 'skipped' };
              }

              const candles = await yahooClient.fetchIncrementalYahooHistory(ticker, lastDate);
              if (!candles || candles.length === 0) {
                return { ticker, status: 'noop' };
              }

              return { ticker, candles, status: 'updated' };
            } catch (err) {
              return { ticker, status: 'error', error: err.message || String(err) };
            }
          }));

          const updatedEntries = results.filter(r => r.status === 'updated');
          if (updatedEntries.length > 0) {
            const saved = db.saveHistoricalCandlesBatch(updatedEntries.map(r => ({ ticker: r.ticker, candles: r.candles })));
            totalNewCandles += saved.changes;
            updatedCount += updatedEntries.length;
            for (const r of updatedEntries) {
              db.cacheOHLCV(r.ticker, r.candles);
              updatedSummaries.push({ ticker: r.ticker, summary: db.getHistoricalSummary(r.ticker) });
            }
          }

          for (const r of results) {
            if (r.status === 'error') {
              errors.push({ ticker: r.ticker, error: r.error });
            }
          }

          completed += chunk.length;

          if (mainWindow && !mainWindow.isDestroyed()) {
            if (completed % SYNC_IPC_BATCH === 0 || completed >= tickers.length) {
              mainWindow.webContents.send('sync-all-progress', {
                current: completed,
                total: tickers.length,
                status: 'batch',
                updated: updatedSummaries.splice(0)
              });
            }
          }

          if (i + SYNC_CHUNK_SIZE < tickers.length) {
            await sleep(150 + Math.random() * 150);
          }
        }

        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('sync-all-done', {
            totalStocks: tickers.length,
            updatedCount,
            totalNewCandles,
            errorCount: errors.length
          });
        }

        return {
          ok: true,
          totalStocks: tickers.length,
          updatedCount,
          totalNewCandles,
          errors
        };
      } catch (err) {
        return { ok: false, error: err.message || String(err) };
      }
    });

    ipcMain.handle('download-full-history-for-index', async (_event, indexName) => {
      const index = indexName && typeof indexName === 'string' ? indexName.trim() : '';
      if (!index) return { ok: false, error: 'missing-index-name' };
      if (!mainWindow || mainWindow.isDestroyed()) return { ok: false, error: 'window-unavailable' };

      const CHUNK_SIZE = 3;
      const sleep = ms => new Promise(res => setTimeout(res, ms));

      try {
        const stocks = db.getStocksByIndex(index);
        if (!stocks || stocks.length === 0) {
          return { ok: true, total: 0, updated: 0, errorCount: 0, errors: [], message: 'Nenhum ativo para este índice na SQLite.' };
        }

        const tickers = stocks.map(s => s.ticker);
        const total = tickers.length;
        const errors = [];
        let updated = 0;
        let completed = 0;

        for (let i = 0; i < tickers.length; i += CHUNK_SIZE) {
          const chunk = tickers.slice(i, i + CHUNK_SIZE);

          const results = await Promise.all(chunk.map(async (ticker, chunkIdx) => {
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('index-download-progress', {
                current: completed + chunkIdx + 1,
                total,
                ticker,
                status: 'syncing'
              });
            }
            try {
              const candles = await yahooClient.fetchFullYahooHistory(ticker);
              if (!candles || candles.length === 0) {
                return { ticker, status: 'noop' };
              }
              return { ticker, candles, status: 'updated' };
            } catch (err) {
              return { ticker, status: 'error', error: err.message || String(err) };
            }
          }));

          const updatedEntries = results.filter(r => r.status === 'updated');
          if (updatedEntries.length > 0) {
            try {
              db.saveHistoricalCandlesBatch(updatedEntries.map(r => ({ ticker: r.ticker, candles: r.candles })));
              for (const r of updatedEntries) {
                db.cacheOHLCV(r.ticker, r.candles);
                try { db.setFullHistoryFetched(r.ticker); } catch (_) {}
                r.summary = db.getHistoricalSummary(r.ticker);
              }
            } catch (err) {
              const message = err.message || String(err);
              for (const r of updatedEntries) {
                r.status = 'error';
                r.error = message;
                delete r.candles;
              }
            }
          }

          completed += chunk.length;

          for (const r of results) {
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('index-download-progress', {
                current: completed,
                total,
                ticker: r.ticker,
                status: r.status,
                summary: r.summary || null,
                firstDate: (r.summary && r.summary.firstDate) || null,
                candles: (r.candles && r.candles.length) || 0,
                error: r.error || null
              });
            }
            if (r.status === 'error') {
              errors.push({ ticker: r.ticker, error: r.error });
            } else if (r.status === 'updated') {
              updated++;
            }
          }

          if (i + CHUNK_SIZE < tickers.length) {
            await sleep(200 + Math.random() * 300);
          }
        }

        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('index-download-progress', {
            current: total,
            total,
            ticker: '',
            status: 'done',
            updated,
            errorCount: errors.length,
            firstDate: null
          });
        }

        return { ok: true, total, updated, errorCount: errors.length, errors };
      } catch (err) {
        return { ok: false, error: err.message || String(err) };
      }
    });

    ipcMain.handle('fetch-first-date-index', async (_event, indexName) => {
      const index = indexName && typeof indexName === 'string' ? indexName.trim() : '';
      if (!index) return { ok: false, error: 'missing-index-name' };
      if (!mainWindow || mainWindow.isDestroyed()) return { ok: false, error: 'window-unavailable' };

      const CHUNK_SIZE = 3;
      const sleep = ms => new Promise(res => setTimeout(res, ms));

      try {
        const stocks = db.getStocksByIndex(index);
        if (!stocks || stocks.length === 0) {
          return { ok: true, total: 0, updated: 0, errorCount: 0, errors: [], message: 'Nenhum ativo para este índice na SQLite.' };
        }

        const tickers = stocks.map(s => s.ticker);
        const total = tickers.length;
        const errors = [];
        let updated = 0;
        let completed = 0;

        for (let i = 0; i < tickers.length; i += CHUNK_SIZE) {
          const chunk = tickers.slice(i, i + CHUNK_SIZE);

          const results = await Promise.all(chunk.map(async (ticker) => {
            try {
              const firstDate = await yahooClient.fetchFirstTradeDate(ticker);
              if (firstDate) {
                return { ticker, firstDate, status: 'done' };
              }
              return { ticker, firstDate: null, status: 'skipped' };
            } catch (err) {
              return { ticker, firstDate: null, status: 'error', error: err.message || String(err) };
            }
          }));

          for (const r of results) {
            if (r.status === 'done') {
              db.updateStockFirstDate(r.ticker, r.firstDate);
              updated++;
            } else if (r.status === 'error') {
              errors.push({ ticker: r.ticker, error: r.error });
            }
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('first-date-fetch-progress', {
                current: completed,
                total,
                ticker: r.ticker,
                firstDate: r.firstDate || null,
                status: r.status,
                error: r.error || null
              });
            }
            completed++;
          }

          if (i + CHUNK_SIZE < tickers.length) {
            await sleep(200 + Math.random() * 300);
          }
        }

        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('first-date-fetch-progress', {
            current: total,
            total,
            ticker: '',
            status: 'done',
            updated,
            errorCount: errors.length
          });
        }

        return { ok: true, total, updated, errorCount: errors.length, errors };
      } catch (err) {
        return { ok: false, error: err.message || String(err) };
      }
    });

    ipcMain.handle('check-index-status', async (_event, indexName) => {
      const index = indexName && typeof indexName === 'string' ? indexName.trim() : '';
      if (!index) return { ok: false, error: 'missing-index-name' };
      try {
        const status = db.checkIndexDataStatus(index);
        return { ok: true, ...status };
      } catch (err) {
        return { ok: false, error: err.message || String(err) };
      }
    });

    ipcMain.handle('sync-index-first-dates', async (event, indexName) => {
      try {
        const index = indexName && typeof indexName === 'string' ? indexName.trim() : '';
        if (!index) return { success: false, message: 'missing-index-name' };
        const stocks = db.getStocksByIndex(index);
        if (!stocks || stocks.length === 0) {
          return { success: false, message: `Nenhuma ação encontrada para o índice: ${index}` };
        }
        let processed = 0;
        const total = stocks.length;
        for (const stock of stocks) {
          processed++;
          try {
            const firstDate = await yahooClient.fetchFirstTradeDate(stock.ticker);
            if (firstDate) {
              db.updateStockFirstDate(stock.ticker, firstDate);
              if (event.sender && !event.sender.isDestroyed()) {
                event.sender.send('index-first-date-progress', {
                  ticker: stock.ticker,
                  firstDate,
                  current: processed,
                  total
                });
              }
            }
          } catch (err) {
            console.error(`Erro ao obter 1ª data no Yahoo para ${stock.ticker}:`, err);
          }
          await new Promise(r => setTimeout(r, 200));
        }
        return { success: true, count: processed };
      } catch (error) {
        console.error('Falha na sincronização do índice:', error);
        return { success: false, error: error.message || String(error) };
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
  if (scannerWorker && !scannerWorker.isTerminated) {
    scannerWorker.terminate();
  }
  if (db) db.close();
});
