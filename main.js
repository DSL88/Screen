const { app, BrowserWindow, ipcMain, Menu, dialog } = require('electron');
const { Worker } = require('worker_threads');
const path = require('path');
const fs = require('fs');
const os = require('os');
const Database = require('./src/db/database');
const yahooClient = require('./src/data/yahooClient');
const tickerLists = require('./src/data/tickerLists');
const { getCountryIndex } = require('./src/data/countryIndexMap');
const wikipediaScraper = require('./src/services/wikipediaScraper');
const marketDataService = require('./src/services/marketDataService');
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
let simulationWorker = null;
let activeSimulationRunId = null;
let activePipelineOperation = null;

function operationId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function beginPipelineOperation(type, requestedId) {
  if (activePipelineOperation) {
    return {
      busy: true,
      result: {
        ok: false,
        success: false,
        status: 'failed',
        error: 'operation-in-progress',
        operationId: activePipelineOperation.operationId,
        operationType: activePipelineOperation.type
      }
    };
  }
  const operation = {
    type,
    operationId: requestedId || operationId(type.replace(/[^a-z0-9]+/gi, '-')),
    cancelled: false
  };
  activePipelineOperation = operation;
  return { operation };
}

function finishPipelineOperation(operation) {
  if (activePipelineOperation === operation) activePipelineOperation = null;
}

function isPipelineCancelled(operation) {
  return !!operation.cancelled;
}

function sendPipelineProgress(event, channel, payload) {
  const sender = event && event.sender;
  if (sender && !sender.isDestroyed()) sender.send(channel, payload);
  else if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

function operationStatus(total, errors, cancelled, processed = total, successful = 0) {
  if (cancelled) return successful > 0 ? 'partial' : 'failed';
  if (errors.length === 0 && processed >= total) return 'success';
  if (processed >= total && successful === 0) return 'failed';
  return processed > 0 ? 'partial' : 'failed';
}

function indexInput(value) {
  if (value && typeof value === 'object') {
    return {
      index: String(value.indexId || value.indexName || value.index || '').trim(),
      operationId: value.operationId
    };
  }
  return { index: typeof value === 'string' ? value.trim() : '', operationId: null };
}

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
//  Worker Thread — gestão da simulação fora do Main Process
// ═══════════════════════════════════════════════════════════
function getSimulationWorker() {
  if (simulationWorker && !simulationWorker.isTerminated) return simulationWorker;

  simulationWorker = new Worker(path.join(__dirname, 'src/engine/simulationWorker.js'));

  simulationWorker.on('message', (msg) => {
    switch (msg.type) {
      case 'simProgress':
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('simulation:progress', msg.payload);
        }
        break;

      case 'simResult':
        if (activeSimulationRunId === msg.payload.runId) activeSimulationRunId = null;
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('simulation:result', msg.payload);
        }
        break;

      case 'simError':
        if (activeSimulationRunId === msg.payload.runId) activeSimulationRunId = null;
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('simulation:error', msg.payload);
        }
        break;

      case 'getAllHistoricalPrices': {
        const requestId = msg.requestId;
        try {
          const prices = db.getAllHistoricalPrices(msg.payload.ticker);
          simulationWorker.postMessage({
            type: 'dbResponse',
            requestId,
            ok: true,
            data: prices
          });
        } catch (err) {
          simulationWorker.postMessage({
            type: 'dbResponse',
            requestId,
            ok: false,
            error: err.message
          });
        }
        break;
      }

      case 'getHistoricalPricesForSimulation': {
        const requestId = msg.requestId;
        try {
          const prices = db.getHistoricalPricesForSimulation(
            msg.payload.ticker,
            msg.payload.startDate,
            msg.payload.endDate
          );
          simulationWorker.postMessage({
            type: 'dbResponse',
            requestId,
            ok: true,
            data: prices
          });
        } catch (err) {
          simulationWorker.postMessage({
            type: 'dbResponse',
            requestId,
            ok: false,
            error: err.message
          });
        }
        break;
      }
    }
  });

  simulationWorker.on('error', (err) => {
    console.error('[SimWorker] Erro fatal:', err);
    activeSimulationRunId = null;
    simulationWorker = null;
  });

  simulationWorker.on('exit', (code) => {
    if (code !== 0) console.error('[SimWorker] Terminou com código', code);
    activeSimulationRunId = null;
    simulationWorker = null;
  });

  return simulationWorker;
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
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'pasteAndMatchStyle' },
        { role: 'delete' },
        { role: 'selectAll' }
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

    // All index imports share one mutex.  Cancellation is cooperative: an
    // in-flight HTTP request is allowed to finish, but its result is never
    // persisted after cancellation.
    ipcMain.handle('index:cancel', async (_event, payload) => {
      const requestedId = payload && (payload.operationId || payload.runId);
      if (!activePipelineOperation) {
        return { ok: false, status: 'failed', error: 'no-operation' };
      }
      if (requestedId && requestedId !== activePipelineOperation.operationId) {
        return { ok: false, status: 'failed', error: 'operation-not-found' };
      }
      activePipelineOperation.cancelled = true;
      return {
        ok: true,
        status: 'partial',
        operationId: activePipelineOperation.operationId,
        cancelled: true
      };
    });

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
    //  SIMULATION — Execução via Worker Thread
    // ═══════════════════════════════════════════════════════
    ipcMain.handle('simulation:options', async () => {
      try {
        const stocks = db.getStocksByIndex('ALL');
        const seen = new Set();
        const indices = [];
        for (const s of stocks) {
          const id = s.index_name || '';
          if (id && !seen.has(id)) {
            seen.add(id);
            indices.push({ id, name: indexNames[id] || id });
          }
        }
        const custom = db.getCustomTickers();
        const assets = (Array.isArray(custom) ? custom : []).map(t => {
          const stock = db.getStockByTicker(t.ticker);
          return {
            ticker: t.ticker,
            name: t.name || t.ticker,
            indexName: (stock && stock.index_name) || t.index_name || ''
          };
        });
        return { ok: true, indices, assets };
      } catch (err) {
        console.error('[simulation:options] Error:', err.message);
        return { ok: false, error: err.message || String(err) };
      }
    });

    ipcMain.handle('simulation:start', async (_event, payload) => {
      if (!mainWindow) return { ok: false, error: 'window-unavailable' };
      if (activeSimulationRunId) return { ok: false, error: 'simulation-in-progress' };
      const universeInput = payload?.universe || {};
      const mode = universeInput.mode || 'all';
      let universe = [];

      if (mode === 'index') {
        // Consistente com o modo "all" (My List): o universo por índice
        // são os ativos de custom_tickers desse índice. Fallback para a
        // tabela stocks se a My List não tiver ativos desse índice.
        const indexName = String(universeInput.index || '').trim();
        let rows = [];
        try {
          rows = db.db.prepare(
            'SELECT ticker, name FROM custom_tickers WHERE LOWER(TRIM(index_name)) = LOWER(TRIM(?)) ORDER BY ticker'
          ).all(indexName);
        } catch (_) { /* fallback abaixo */ }
        if (rows.length === 0) {
          const stocks = db.getStocksByIndex(indexName);
          rows = (Array.isArray(stocks) ? stocks : []).map(s => ({ ticker: s.ticker, name: s.name }));
        }
        universe = rows.map(r => ({ ticker: r.ticker, name: r.name || r.ticker }));
      } else if (mode === 'single') {
        const ticker = String(universeInput.ticker || '').toUpperCase().trim();
        if (ticker) universe = [{ ticker, name: ticker }];
      } else {
        const custom = db.getCustomTickers();
        universe = (Array.isArray(custom) ? custom : []).map(t => ({ ticker: t.ticker, name: t.name || t.ticker }));
      }

      if (universe.length === 0) {
        return { ok: false, error: 'empty-universe' };
      }

      const runId = 'sim_' + Date.now();
      activeSimulationRunId = runId;
      const dbPath = path.join(app.getPath('userData'), 'trades.db');
      const rawStart = payload?.params?.startDate;
      const rawEnd = payload?.params?.endDate;
      const startDate = rawStart ? String(rawStart).slice(0, 10) : null;
      const endDate = rawEnd ? String(rawEnd).slice(0, 10) : null;
      const normalizedUniverse = (Array.isArray(universe) ? universe : []).map(t => ({
        ticker: String(t.ticker || '').trim().toUpperCase(),
        name: t.name || t.ticker
      }));
      try {
        getSimulationWorker().postMessage({
          action: 'start',
          runId,
          universe: normalizedUniverse,
          params: payload?.params,
          dbPath,
          startDate,
          endDate
        });
      } catch (err) {
        activeSimulationRunId = null;
        console.error('[simulation:start] Falha ao iniciar:', err.message || err);
        return { ok: false, error: err.message || String(err) };
      }

      return { ok: true, runId, count: universe.length };
    });

    ipcMain.handle('simulation:cancel', async (_event, payload) => {
      const worker = getSimulationWorker();
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
                  db.closeActiveTrade(c.id, c.exitPrice, c.resultado, c.motivo_fecho);
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
      const lock = beginPipelineOperation('file-import', payload.operationId);
      if (lock.busy) return lock.result;
      const operation = lock.operation;

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
          return { ok: false, success: false, status: 'failed', error: 'missing-ticker-or-file' };
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
            return { ok: false, success: false, status: 'failed', error: parseResult.error };
         }
         if (isPipelineCancelled(operation)) {
           return { ok: false, success: false, status: 'partial', cancelled: true, errors: [] };
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
          success: true,
          status: 'success',
          count,
          ticker,
          firstDate,
          lastDate,
          summary: newSummary,
          message: `${count} velas importadas para ${ticker}`
        };
      } catch (err) {
        console.error('[import:bulk] Error:', err.message);
         return { ok: false, success: false, status: 'failed', error: err.message || String(err) };
      } finally {
        // Clean up temp file
        if (tmpPath) {
          try { fs.unlinkSync(tmpPath); } catch (_) { /* ignore */ }
        }
        finishPipelineOperation(operation);
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
      const lock = beginPipelineOperation('file-import', payload.operationId);
      if (lock.busy) return lock.result;
      const operation = lock.operation;

      try {
        const parseResult = parseFile(payload.filePath);
        if (!parseResult.ok) {
          return { ok: false, error: parseResult.error };
        }
        if (isPipelineCancelled(operation)) {
          return { ok: false, success: false, status: 'partial', cancelled: true, errors: [] };
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
          success: true,
          status: 'success',
          count,
          ticker,
          firstDate,
          lastDate,
          summary: newSummary,
          message: `${count} velas importadas para ${ticker}`
        };
      } catch (err) {
        console.error('[import-historical-data] Error:', err.message);
        return { ok: false, success: false, status: 'failed', error: err.message || String(err) };
      } finally {
        finishPipelineOperation(operation);
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
      const lock = beginPipelineOperation('file-import', null);
      if (lock.busy) return lock.result;
      const operation = lock.operation;

      try {
        const importResult = await importFromCsvFile(filePath, db);
        if (!importResult.ok) {
          return { ok: false, success: false, status: 'failed', error: importResult.error };
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
          success: true,
          status: 'success',
          inserted: importResult.inserted,
          skipped: importResult.skipped,
          firstDate: importResult.firstDate,
          lastDate: importResult.lastDate,
          message: `${importResult.inserted} velas importadas (${importResult.skipped} ignoradas)`
        };
      } catch (err) {
        console.error('[import-historical-csv] Error:', err.message);
        return { ok: false, success: false, status: 'failed', error: err.message || String(err) };
      } finally {
        finishPipelineOperation(operation);
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

    ipcMain.handle('update-stock-metadata', async (_event, payload) => {
      const ticker = payload && payload.ticker ? String(payload.ticker).toUpperCase().trim() : '';
      if (!ticker) return { ok: false, error: 'missing-ticker' };
      try {
        const result = db.updateStockMetadata(ticker, payload && payload.data);
        if (!result || result.success === false) {
          return { ok: false, error: (result && result.error) || 'invalid-input' };
        }
        return { ok: true, ...result };
      } catch (err) {
        return { ok: false, error: err.message || String(err) };
      }
    });

    ipcMain.handle('get-distinct-indices', async () => {
      try {
        const indices = db.getAllDistinctIndices();
        return { ok: true, indices };
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
      const lock = beginPipelineOperation('ticker-full-history', payload && payload.operationId);
      if (lock.busy) return lock.result;
      const operation = lock.operation;
      try {
        const candles = await yahooClient.fetchFullYahooHistory(ticker);
        if (isPipelineCancelled(operation)) {
          return { ok: false, success: false, status: 'partial', operationId: operation.operationId,
            ticker, cancelled: true, errors: [] };
        }
        if (candles && candles.length > 0) {
          const result = db.saveHistoricalCandlesFromImport(ticker, candles);
          db.cacheOHLCV(ticker, candles);
          db.setFullHistoryFetched(ticker);
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
            success: true,
            status: 'success',
            operationId: operation.operationId,
            ticker,
            totalCandles: newSummary ? newSummary.totalCandles : result.changes,
            summary: newSummary
          };
        }
        return { ok: false, success: false, status: 'failed', operationId: operation.operationId,
          ticker, totalCandles: 0, summary: null, error: 'empty-history' };
      } catch (err) {
        return { ok: false, error: err.message || String(err) };
      } finally {
        finishPipelineOperation(operation);
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
      const requested = indexInput(indexFilter);
      const lock = beginPipelineOperation('index-incremental-sync', requested.operationId);
      if (lock.busy) return lock.result;
      const operation = lock.operation;
      const filter = requested.index || null;

      const SYNC_CHUNK_SIZE = 5;
      const SYNC_IPC_BATCH = 10;
      const sleep = ms => new Promise(res => setTimeout(res, ms));

      try {
        const tickers = db.getCustomTickersByIndex(filter);
        if (!tickers || tickers.length === 0) {
          return { ok: false, success: false, status: 'failed', totalStocks: 0, updatedCount: 0,
            totalNewCandles: 0, errors: [], error: 'no-stocks', message: 'Nenhum ativo na lista para sincronizar.' };
        }

        let updatedCount = 0;
        let totalNewCandles = 0;
        const errors = [];
        const expected = db.getLastExpectedTradingDay();
        const updatedSummaries = [];
        let completed = 0;

        for (let i = 0; i < tickers.length; i += SYNC_CHUNK_SIZE) {
          if (isPipelineCancelled(operation)) break;
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
          if (isPipelineCancelled(operation)) {
            for (const result of updatedEntries) result.status = 'cancelled';
          } else if (updatedEntries.length > 0) {
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
                percent: tickers.length > 0 ? Math.round(completed / tickers.length * 100) : 0,
                status: 'batch',
                updated: updatedSummaries.splice(0)
              });
            }
          }

          if (i + SYNC_CHUNK_SIZE < tickers.length) {
            await sleep(150 + Math.random() * 150);
          }
        }

        const status = operationStatus(tickers.length, errors, operation.cancelled, completed, updatedCount);
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('sync-all-done', {
            totalStocks: tickers.length,
            updatedCount,
            totalNewCandles,
            errorCount: errors.length,
            status: 'done',
            state: status,
            cancelled: operation.cancelled
          });
        }

        return {
          ok: status !== 'failed',
          success: status !== 'failed',
          status,
          totalStocks: tickers.length,
          updatedCount,
          totalNewCandles,
          errors
        };
      } catch (err) {
        return { ok: false, error: err.message || String(err) };
      } finally {
        finishPipelineOperation(operation);
      }
    });

    ipcMain.handle('download-full-history-for-index', async (event, input) => {
      const { index, operationId: requestedId } = indexInput(input);
      if (!index) return { ok: false, success: false, status: 'failed', error: 'missing-index-name' };
      if (!mainWindow || mainWindow.isDestroyed()) return { ok: false, error: 'window-unavailable' };
      const lock = beginPipelineOperation('index-full-history', requestedId);
      if (lock.busy) return lock.result;
      const operation = lock.operation;

      const CHUNK_SIZE = 3;
      const sleep = ms => new Promise(res => setTimeout(res, ms));
      const errors = [];
      let completed = 0;
      let total = 0;
      let updated = 0;

      try {
        const stocks = db.getStocksByIndex(index);
        if (!stocks || stocks.length === 0) {
          sendPipelineProgress(event, 'index-download-progress', {
            operationId: operation.operationId, indexId: index, current: 0, total: 0,
            ticker: '', status: 'done', state: 'failed', errorCount: 0
          });
          return { ok: false, success: false, status: 'failed', operationId: operation.operationId,
            total: 0, updated: 0, errorCount: 0, errors: [], error: 'no-stocks' };
        }

        const tickers = stocks.map(s => s.ticker);
        total = tickers.length;

        for (let i = 0; i < tickers.length; i += CHUNK_SIZE) {
          if (isPipelineCancelled(operation)) break;
          const chunk = tickers.slice(i, i + CHUNK_SIZE);

          const results = await Promise.all(chunk.map(async (ticker, chunkIdx) => {
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('index-download-progress', {
                operationId: operation.operationId, indexId: index,
                current: completed + chunkIdx + 1,
                total,
                ticker,
                status: 'syncing'
              });
            }
            try {
              const candles = await yahooClient.fetchFullYahooHistory(ticker);
              if (isPipelineCancelled(operation)) return { ticker, status: 'cancelled' };
              if (!candles || candles.length === 0) {
                return { ticker, status: 'noop' };
              }
              return { ticker, candles, status: 'updated' };
            } catch (err) {
              return { ticker, status: 'error', error: err.message || String(err) };
            }
          }));

          const updatedEntries = results.filter(r => r.status === 'updated');
          for (const r of updatedEntries) {
            try {
              if (isPipelineCancelled(operation)) {
                r.status = 'cancelled';
                delete r.candles;
                continue;
              }
              // Persist and mark only this ticker after its complete history
              // has been fetched and persisted successfully.
              db.saveHistoricalCandlesFromImport(r.ticker, r.candles);
              db.cacheOHLCV(r.ticker, r.candles);
              db.setFullHistoryFetched(r.ticker);
              r.summary = db.getHistoricalSummary(r.ticker);
            } catch (err) {
              r.status = 'error';
              r.error = err.message || String(err);
              delete r.candles;
            }
          }

          completed += chunk.length;

          for (const r of results) {
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('index-download-progress', {
                operationId: operation.operationId,
                indexId: index,
                current: completed,
                total,
                ticker: r.ticker,
                status: r.status,
                state: r.status === 'updated' ? 'success' : (r.status === 'error' ? 'failed' : r.status),
                summary: r.summary || null,
                firstDate: (r.summary && r.summary.firstDate) || null,
                candles: (r.candles && r.candles.length) || 0,
                error: r.error || null
              });
            }
            if (r.status === 'error' || r.status === 'noop') {
              if (r.status === 'noop') r.error = 'empty-history';
              errors.push({ ticker: r.ticker, error: r.error });
            } else if (r.status === 'updated') {
              updated++;
            }
          }

          if (i + CHUNK_SIZE < tickers.length && !isPipelineCancelled(operation)) {
            await sleep(200 + Math.random() * 300);
          }
        }

        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('index-download-progress', {
            operationId: operation.operationId,
            indexId: index,
            current: completed,
            total,
            ticker: '',
            status: 'done',
            state: operationStatus(total, errors, operation.cancelled, completed, updated),
            updated,
            errorCount: errors.length,
            firstDate: null
          });
        }

        const status = operationStatus(total, errors, operation.cancelled, completed, updated);
        return { ok: status !== 'failed', success: status !== 'failed', status,
          operationId: operation.operationId, total, updated, errorCount: errors.length,
          errors, cancelled: operation.cancelled };
      } catch (err) {
        const error = err.message || String(err);
        errors.push({ ticker: null, error });
        sendPipelineProgress(event, 'index-download-progress', {
          operationId: operation.operationId, indexId: index, current: 0, total: 0,
          ticker: '', status: 'done', state: 'failed', error, errorCount: errors.length
        });
        return { ok: false, success: false, status: 'failed', operationId: operation.operationId, errors, error };
      } finally {
        finishPipelineOperation(operation);
      }
    });

    ipcMain.handle('check-index-status', async (_event, indexName) => {
      const index = indexName && typeof indexName === 'string' ? indexName.trim() : '';
      if (!index) return { ok: false, error: 'missing-index-name' };
      try {
        const status = db.checkIndexStatus(index);
        return { ok: true, ...status };
      } catch (err) {
        return { ok: false, error: err.message || String(err) };
      }
    });

    ipcMain.handle('first-registo-index', async (event, input) => {
      const { index, operationId: requestedId } = indexInput(input);
      if (!index) return { ok: false, success: false, status: 'failed', error: 'missing-index-name' };
      if (!mainWindow || mainWindow.isDestroyed()) return { ok: false, success: false, status: 'failed', error: 'window-unavailable' };
      const lock = beginPipelineOperation('first-registo', requestedId);
      if (lock.busy) return lock.result;
      const operation = lock.operation;

      const CHUNK_SIZE = 3;
      const sleep = ms => new Promise(res => setTimeout(res, ms));
      const errors = [];
      let completed = 0;
      let total = 0;
      let updated = 0;

      try {
        const stocks = db.getStocksByIndex(index);
        if (!stocks || stocks.length === 0) {
          sendPipelineProgress(event, 'first-registo-progress', {
            operationId: operation.operationId, index, current: 0, total: 0,
            ticker: '', status: 'done', state: 'failed', errorCount: 0
          });
          return { ok: false, success: false, status: 'failed', operationId: operation.operationId,
            total: 0, updated: 0, errorCount: 0, errors: [], error: 'no-stocks' };
        }

        const tickers = stocks.map(s => s.ticker);
        total = tickers.length;

        for (let i = 0; i < tickers.length; i += CHUNK_SIZE) {
          if (isPipelineCancelled(operation)) break;
          const chunk = tickers.slice(i, i + CHUNK_SIZE);

          const results = await Promise.all(chunk.map(async (ticker, chunkIdx) => {
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('first-registo-progress', {
                operationId: operation.operationId, index,
                current: completed + chunkIdx + 1,
                total,
                ticker,
                status: 'syncing'
              });
            }
            try {
              const stock = stocks.find(s => s.ticker === ticker);
              let firstDate = (stock && stock.first_date) || null;
              if (!firstDate) {
                firstDate = await yahooClient.fetchFirstTradeDate(ticker);
              }
              if (isPipelineCancelled(operation)) return { ticker, status: 'cancelled' };
              if (firstDate) {
                db.updateStockFirstDate(ticker, firstDate);
              }

              const candles = await yahooClient.fetchHistorySince(ticker, firstDate);
              if (isPipelineCancelled(operation)) return { ticker, status: 'cancelled' };
              if (!candles || candles.length === 0) {
                return { ticker, status: 'noop', firstDate };
              }
              return { ticker, candles, firstDate, status: 'updated' };
            } catch (err) {
              return { ticker, status: 'error', error: err.message || String(err) };
            }
          }));

          const updatedEntries = results.filter(r => r.status === 'updated');
          for (const r of updatedEntries) {
            try {
              if (isPipelineCancelled(operation)) {
                r.status = 'cancelled';
                delete r.candles;
                continue;
              }
              db.saveHistoricalCandlesFromImport(r.ticker, r.candles);
              db.cacheOHLCV(r.ticker, r.candles);
              db.setFullHistoryFetched(r.ticker);
              r.summary = db.getHistoricalSummary(r.ticker);
            } catch (err) {
              r.status = 'error';
              r.error = err.message || String(err);
              delete r.candles;
            }
          }

          completed += chunk.length;

          for (const r of results) {
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('first-registo-progress', {
                operationId: operation.operationId,
                index,
                current: completed,
                total,
                ticker: r.ticker,
                percent: total > 0 ? Math.round(completed / total * 100) : 0,
                firstDate: r.firstDate || null,
                status: r.status,
                state: r.status === 'updated' ? 'success' : (r.status === 'error' ? 'failed' : r.status),
                summary: r.summary || null,
                error: r.error || null
              });
            }
            if (r.status === 'error' || r.status === 'noop') {
              if (r.status === 'noop') r.error = 'empty-history';
              errors.push({ ticker: r.ticker, error: r.error });
            } else if (r.status === 'updated') {
              updated++;
            }
          }

          if (i + CHUNK_SIZE < tickers.length && !isPipelineCancelled(operation)) {
            await sleep(200 + Math.random() * 200);
          }
        }

        const status = operationStatus(total, errors, operation.cancelled, completed, updated);
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('first-registo-progress', {
            operationId: operation.operationId,
            index,
            current: completed,
            total,
            ticker: '',
            percent: total > 0 ? Math.round(completed / total * 100) : 0,
            status: 'done',
            state: status,
            updated,
            errorCount: errors.length,
            firstDate: null
          });
        }

        return { ok: status !== 'failed', success: status !== 'failed', status,
          operationId: operation.operationId, total, updated, errorCount: errors.length,
          errors, cancelled: operation.cancelled };
      } catch (err) {
        const error = err.message || String(err);
        errors.push({ ticker: null, error });
        sendPipelineProgress(event, 'first-registo-progress', {
          operationId: operation.operationId, index, current: 0, total: 0,
          ticker: '', status: 'done', state: 'failed', error, errorCount: errors.length
        });
        return { ok: false, success: false, status: 'failed', operationId: operation.operationId, errors, error };
      } finally {
        finishPipelineOperation(operation);
      }
    });

    ipcMain.handle('audit-index', async (_event, indexName) => {
      const index = indexName && typeof indexName === 'string' ? indexName.trim() : '';
      if (!index) return { ok: false, error: 'missing-index-name' };
      try {
        const audit = db.auditIndexStocks(index);
        return { ok: true, ...audit };
      } catch (err) {
        return { ok: false, error: err.message || String(err) };
      }
    });

    ipcMain.handle('sync-index-first-records', async (event, input) => {
      const { index, operationId: requestedId } = indexInput(input);
      if (!index) return { ok: false, success: false, status: 'failed', error: 'missing-index-name' };
      if (!mainWindow || mainWindow.isDestroyed()) return { ok: false, success: false, status: 'failed', error: 'window-unavailable' };
      const lock = beginPipelineOperation('first-registo', requestedId);
      if (lock.busy) return lock.result;
      const operation = lock.operation;

      const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
      const jitterSleep = () => sleep(350 + Math.random() * 350);
      const errors = [];
      let completed = 0;
      let updated = 0;
      const emit = payload => sendPipelineProgress(event, 'index-sync-progress', {
        operationId: operation.operationId, indexId: index, ...payload
      });

      try {
        const audit = db.auditIndexStocks(index);
        const pending = audit.stocks.filter(s => !s.isComplete);

        if (audit.totalStocks === 0 || pending.length === 0) {
          emit({ current: 0, total: audit.totalStocks, ticker: '', status: 'done',
            state: 'complete', totalStocks: audit.totalStocks, completeCount: audit.completeCount });
          return { ok: true, success: true, status: 'complete', operationId: operation.operationId,
            total: audit.totalStocks, updated: 0, errorCount: 0, errors: [], cancelled: false };
        }

        const total = pending.length;

        for (let i = 0; i < pending.length; i++) {
          if (isPipelineCancelled(operation)) break;
          const stock = pending[i];
          const ticker = stock.ticker;
          emit({ current: i + 1, total, ticker, name: stock.name || '', status: 'syncing', state: 'syncing' });

          try {
            // 1) first_date: reutilizar o existente ou obter do Yahoo.
            let firstDate = stock.firstDate || null;
            if (!firstDate) {
              firstDate = await yahooClient.fetchFirstAvailableDate(ticker);
            }
            if (isPipelineCancelled(operation)) break;
            if (firstDate) db.updateStockFirstDate(ticker, firstDate);

            // 2) Bloco histórico diário desde a origem.
            const candles = await yahooClient.fetchFullHistoryFromIPO(ticker);
            if (isPipelineCancelled(operation)) break;

            if (!candles || candles.length === 0) {
              const error = 'empty-history';
              errors.push({ ticker, error });
              emit({ current: i + 1, total, ticker, name: stock.name || '', firstDate: firstDate || null,
                status: 'error', state: 'failed', error, errorCount: errors.length });
            } else {
              db.saveHistoricalCandlesFromImport(ticker, candles);
              db.cacheOHLCV(ticker, candles);
              db.setFullHistoryFetched(ticker);
              updated++;
              emit({ current: i + 1, total, ticker, name: stock.name || '', firstDate: firstDate || null,
                percent: Math.round((i + 1) / total * 100), status: 'updated', state: 'success',
                candles: candles.length, errorCount: errors.length });
            }
          } catch (err) {
            const error = err.message || String(err);
            errors.push({ ticker, error });
            console.error(`[sync-index-first-records] ${ticker}: ${error}`);
            emit({ current: i + 1, total, ticker, name: stock.name || '', status: 'error', state: 'failed',
              error, errorCount: errors.length });
          }

          completed++;
          if (i + 1 < pending.length && !isPipelineCancelled(operation)) {
            await jitterSleep();
          }
        }

        const finalStatus = operationStatus(total, errors, operation.cancelled, completed, updated);
        const finalAudit = db.auditIndexStocks(index);
        emit({ current: completed, total, ticker: '', status: 'done', state: finalStatus,
          updated, errorCount: errors.length, errors, cancelled: operation.cancelled,
          totalStocks: finalAudit.totalStocks, completeCount: finalAudit.completeCount });

        return { ok: finalStatus !== 'failed', success: finalStatus !== 'failed', status: finalStatus,
          operationId: operation.operationId, total, updated, errorCount: errors.length,
          errors, cancelled: operation.cancelled };
      } catch (err) {
        const error = err.message || String(err);
        errors.push({ ticker: null, error });
        emit({ current: completed, total, ticker: '', status: 'done', state: 'failed', error, errorCount: errors.length });
        return { ok: false, success: false, status: 'failed', operationId: operation.operationId,
          total, updated, errorCount: errors.length, errors, cancelled: operation.cancelled, error };
      } finally {
        finishPipelineOperation(operation);
      }
    });

    ipcMain.handle('delete-index-with-stocks', async (_event, indexName) => {
      if (!indexName || typeof indexName !== 'string' || !indexName.trim()) {
        return { ok: false, error: 'missing-index-name' };
      }
      try {
        const result = db.deleteIndexAndStocks(indexName);
        return { ok: true, ...result };
      } catch (err) {
        return { ok: false, error: err.message || String(err) };
      }
    });

    ipcMain.handle('UPDATE_INDEX_FIRST_DATES', async (event, input) => {
      const { index, operationId: requestedId } = indexInput(input);
      if (!index) return { ok: false, success: false, status: 'failed', error: 'missing-index-name' };
      if (!mainWindow || mainWindow.isDestroyed()) return { ok: false, success: false, status: 'failed', error: 'window-unavailable' };
      const lock = beginPipelineOperation('index-first-date', requestedId);
      if (lock.busy) return lock.result;
      const operation = lock.operation;
      const errors = [];
      let updated = 0;
      let completed = 0;
      let total = 0;
      const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
      const emit = payload => sendPipelineProgress(event, 'UPDATE_INDEX_DATE_PROGRESS', {
        operationId: operation.operationId, indexId: index, ...payload
      });

      try {
        const stocks = db.getStocksByIndex(index);
        total = stocks.length;
        if (total === 0) {
          emit({ current: 0, total: 0, ticker: '', status: 'done', state: 'failed', errorCount: 0 });
          return { ok: false, success: false, status: 'failed', operationId: operation.operationId,
            total: 0, updated: 0, errors: [], error: 'no-stocks' };
        }
        for (const stock of stocks) {
          if (isPipelineCancelled(operation)) break;
          const ticker = stock.ticker;
          let firstDate = null;
          let status = 'skipped';
          let error = null;
          try {
            firstDate = await yahooClient.fetchFirstTradeDate(ticker);
            if (isPipelineCancelled(operation)) break;
            if (firstDate) {
              db.updateStockFirstDate(ticker, firstDate);
              updated++;
              status = 'success';
            } else {
              status = 'failed';
              error = 'first-date-unavailable';
              errors.push({ ticker, error });
            }
          } catch (err) {
            status = 'failed';
            error = err.message || String(err);
            errors.push({ ticker, error });
          }
          completed++;
          emit({ current: completed, total, ticker, firstDate, status, state: status, error });
          if (completed < total && !isPipelineCancelled(operation)) await sleep(200);
        }
        const finalStatus = operationStatus(total, errors, operation.cancelled, completed, updated);
        emit({ current: completed, total, ticker: '', status: 'done', state: finalStatus,
          errorCount: errors.length, cancelled: operation.cancelled, updated });
        return { ok: finalStatus !== 'failed', success: finalStatus !== 'failed', status: finalStatus,
          operationId: operation.operationId, total, updated, count: updated,
          errorCount: errors.length, errors, cancelled: operation.cancelled };
      } catch (err) {
        const error = err.message || String(err);
        errors.push({ ticker: null, error });
        emit({ current: completed, total, ticker: '', status: 'done', state: 'failed', error, errorCount: errors.length });
        return { ok: false, success: false, status: 'failed', operationId: operation.operationId,
          total, updated, count: updated, errors, error };
      } finally {
        finishPipelineOperation(operation);
      }
    });

    /* Legacy implementation removed in favour of the single canonical
       UPDATE_INDEX_FIRST_DATES handler above.
    // historical implementation intentionally kept in this comment for migration reference
    legacyHandler('UPDATE_INDEX_FIRST_DATES', async (event, indexName) => {
      const index = indexName && typeof indexName === 'string' ? indexName.trim() : '';
      if (!index) return { success: false, message: 'missing-index-name' };

      const sleep = ms => new Promise(res => setTimeout(res, ms));
      const USER_AGENT = 'Mozilla/5.0';
      const suffixIndex = index.split(/[—–|]/).pop().trim();
      const normalizedIndex = suffixIndex.toLowerCase().replace(/[^a-z0-9]/g, '');
      const indexSuffix = INDEX_SUFFIX_MAP[normalizedIndex] ||
        (normalizedIndex.includes('psi') ? '.LS' : '');

      const resolveTicker = (rawTicker) => {
        const t = String(rawTicker || '').trim().toUpperCase();
        if (!t) return null;
        if (!indexSuffix) return t;
        if (/\.\w+$/.test(t)) return t;
        return t + indexSuffix;
      };

      const fetchFirstDate = async (ticker) => {
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=max&interval=1mo`;
        const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
        if (!res || !res.ok) return null;
        const json = await res.json();
        const resultArr = json && json.chart && Array.isArray(json.chart.result) ? json.chart.result : null;
        const result = resultArr && resultArr.length > 0 ? resultArr[0] : null;
        const timestamps = result && result.timestamp;
        if (Array.isArray(timestamps) && timestamps.length > 0) {
          const d = new Date(timestamps[0] * 1000);
          if (!Number.isNaN(d.getTime())) return d.toISOString().split('T')[0];
        }
        return null;
      };

      try {
        const tickers = db.getTickersForIndex(index);
        console.log(`[DEBUG] Pesquisa para o índice "${index}": encontrados ${tickers ? tickers.length : 0} tickers.`);
        if (!tickers || tickers.length === 0) {
          return { success: false, message: 'Nenhum ativo encontrado para atualizar.' };
        }

        const total = tickers.length;
        let updatedCount = 0;
        let current = 0;

        for (const rawTicker of tickers) {
          current++;
          const ticker = resolveTicker(rawTicker);
          let firstDate = null;
          let error = null;
          if (ticker) {
            try {
              firstDate = await fetchFirstDate(ticker);
              if (firstDate) {
                db.updateStockFirstDate(ticker, firstDate);
                updatedCount++;
              }
            } catch (err) {
              error = err.message || String(err);
              console.error(`[UPDATE_INDEX_FIRST_DATES] Erro para ${ticker}:`, err);
            }
          }
          if (event.sender && !event.sender.isDestroyed()) {
            event.sender.send('UPDATE_INDEX_DATE_PROGRESS', {
              current,
              total,
              ticker: ticker || rawTicker,
              firstDate,
              error
            });
          }
          if (current < total) await sleep(200);
        }

        return { success: true, count: updatedCount };
      } catch (error) {
        console.error('[UPDATE_INDEX_FIRST_DATES] Falha:', error);
        return { success: false, error: error.message || String(error) };
      }
    });

    });
    */

    ipcMain.handle('fetch-and-add-country-index-stocks', async (event, input) => {
      const country = input && typeof input === 'object' ? input.country : input;
      const mapping = getCountryIndex(country);
      if (!mapping) {
        return { ok: false, success: false, status: 'failed', message: `País sem índice oficial configurado: ${country || 'desconhecido'}.` };
      }
      const requestedId = input && typeof input === 'object' ? input.operationId : null;
      const lock = beginPipelineOperation('country-index-import', requestedId);
      if (lock.busy) return lock.result;
      const operation = lock.operation;

      try {
        const constituents = await wikipediaScraper.getIndexConstituents(country);
        if (!constituents || constituents.length === 0) {
          sendPipelineProgress(event, 'country-index-progress', {
            operationId: operation.operationId, current: 0, total: 0, ticker: '',
            status: 'done', state: 'failed', errorCount: 0
          });
          return { ok: false, success: false, status: 'failed', operationId: operation.operationId,
            message: `Não foi possível obter constituintes para o índice ${mapping.indexName}.`, errors: [] };
        }

        const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
        const total = constituents.length;
        const indexId = db.canonicalIndexId(mapping.indexName);
        const stocks = [];
        const errors = [];

        for (let i = 0; i < total; i++) {
          if (isPipelineCancelled(operation)) break;
          const constituent = constituents[i];
          const ticker = String(constituent.ticker || '').trim().toUpperCase();
          let name = constituent.name || ticker;
          let firstDate = null;
          let error = null;

          try {
            const history = await marketDataService.fetchStockHistory(ticker);
            if (isPipelineCancelled(operation)) break;
            if (history.length > 0) {
              firstDate = history[0].date;
              db.saveHistoricalCandlesFromImport(ticker, history);
            } else {
              error = 'empty-history';
              errors.push({ ticker, error });
            }
          } catch (err) {
            error = err.message || String(err);
            errors.push({ ticker, error });
            console.error(`[fetch-and-add-country-index-stocks] ${ticker}:`, error);
          }

          if (isPipelineCancelled(operation)) break;

          db.upsertStock({
            ticker,
            name,
            country: String(country || '').trim(),
            indexName: mapping.indexName,
            firstDate
          });
          db.addCustomTicker({
            ticker,
            name,
            country: String(country || '').trim(),
            indexName: mapping.indexName,
            exchange: '',
            type: 'EQUITY'
          });

          const item = { ticker, name, country, indexName: mapping.indexName, firstDate, error };
          stocks.push(item);
          if (event.sender && !event.sender.isDestroyed()) {
              event.sender.send('country-index-progress', {
                operationId: operation.operationId,
              current: i + 1,
              total,
              ticker,
                name,
                firstDate,
                indexId,
                indexName: mapping.indexName,
                status: error ? 'failed' : (firstDate ? 'success' : 'skipped'),
                state: error ? 'failed' : (firstDate ? 'success' : 'skipped'),
                error
            });
          }
          if (i < total - 1) await sleep(200);
        }

        const processed = stocks.length;
        const status = operationStatus(total, errors, operation.cancelled, processed, stocks.length);
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('country-index-progress', {
            operationId: operation.operationId, current: processed, total, ticker: '',
            status: 'done', state: status, errorCount: errors.length, cancelled: operation.cancelled
          });
        }
        return {
          ok: status !== 'failed',
          success: status !== 'failed',
          status,
          operationId: operation.operationId,
          count: stocks.length,
          total,
          country,
          indexId,
          indexName: mapping.indexName,
          stocks,
          errors
        };
      } catch (error) {
        console.error(`[fetch-and-add-country-index-stocks] Falha para ${country}:`, error);
        sendPipelineProgress(event, 'country-index-progress', {
          operationId: operation.operationId, current: 0, total: 0, ticker: '',
          status: 'done', state: 'failed', errorCount: 1, error: error.message || String(error)
        });
        return { ok: false, success: false, status: 'failed', operationId: operation.operationId,
          message: error.message || String(error), errors: [{ ticker: null, error: error.message || String(error) }] };
      } finally {
        finishPipelineOperation(operation);
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
  if (simulationWorker && !simulationWorker.isTerminated) {
    simulationWorker.terminate();
  }
  if (db) db.close();
});
