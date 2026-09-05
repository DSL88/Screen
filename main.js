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
const { createProgressReporter } = require('./src/utils/progressThrottle');
const { parseFile, importFromCsvFile } = require('./src/importer/historicalImporter');
const { scanStock } = require('./src/scanner');
const { PythonBridge } = require('./src/services/pythonBridge');
let quantEngine = null;
try { quantEngine = require('./src/native'); } catch (_) { quantEngine = null; }

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

// Spec 3.1 – Throttling IPC 100ms (PASSO 1)
let processedCount = 0;
let lastEmitTime = Date.now();
function emitThrottledProgress(sender, channel, data) {
  processedCount++;
  const now = Date.now();
  if (now - lastEmitTime > 100 || processedCount === data.total) {
    sender.send(channel, {
      current: processedCount,
      total: data.total,
      ticker: data.ticker,
      status: data.status
    });
    lastEmitTime = now;
  }
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
  const uiUseRvolGate = uiParams?.useRvolGate ?? uiParams?.rvolGate;
  const uiRvolMin = uiParams?.rvol_min ?? uiParams?.rvolMin;

  return {
    edge_threshold: uiEdge != null ? Number(uiEdge) : Number(dbParams.edge_threshold),
    markov_window: uiWindow != null ? Number(uiWindow) : Number(dbParams.markov_window),
    volume_mult: uiVolume != null ? Number(uiVolume) : Number(dbParams.volume_mult),
    horizon_days: uiHorizon != null ? Number(uiHorizon) : Number(dbParams.horizon_days),
    useVolFilter: uiUseVolFilter !== undefined ? Boolean(uiUseVolFilter) : true,
    useLatestClosed: uiUseLatestClosed === true,
    useRvolGate: uiUseRvolGate !== undefined ? Boolean(uiUseRvolGate) : true,
    rvol_min: uiRvolMin != null ? Number(uiRvolMin) : 1.0,
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

    // Auditoria e reconciliação global: repõe o MIN(date) real na coluna
    // first_date de todos os ativos ANTES de a UI carregar, para que o
    // "PRIMEIRO REGISTO" do modal e da My List nunca apresente a data de um
    // download incremental recente em vez da vela mais antiga guardada.
    db.reconcileAllStocksFirstDate();

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
    //  QUANT PIPELINE — Python Engine Bridge (Fases 1 a 6)
    // ═══════════════════════════════════════════════════════
    const resolveMyListTickers = (payload) => {
      const p = payload ? { ...payload } : {};
      if ((!p.tickers || p.tickers.length === 0) && (p.universe === 'MY_LIST' || p.universe === 'my_list' || p.universe === 'ALL')) {
        try {
          const custom = db.getCustomTickers();
          if (custom && custom.length > 0) {
            p.tickers = custom.map(t => String(t.ticker || '').toUpperCase().trim()).filter(Boolean);
          }
        } catch (e) {
          console.warn('[QuantEngine] Erro ao carregar custom_tickers do SQLite:', e);
        }
      }
      // Metadados de identificação (nome, país, índice) para o motor e para o drawer.
      try {
        const tickers = Array.isArray(p.tickers) ? p.tickers : [];
        if (tickers.length > 0) {
          const metadata = db.getTickersMetadata(tickers);
          p.asset_meta = { ...(p.asset_meta || {}), ...metadata };
        }
      } catch (e) {
        console.warn('[QuantEngine] Erro ao anexar asset_meta ao payload do pipeline:', e);
      }
      return p;
    };

    ipcMain.handle('quant:run-full-pipeline', async (_event, payload) => {
      try {
        const enrichedPayload = resolveMyListTickers(payload);
        const result = await PythonBridge.runPipeline('run_full_pipeline', enrichedPayload);
        return { ok: true, data: result };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    });

    ipcMain.handle('execute-screener', async (_event, payload) => {
      try {
        const enrichedPayload = resolveMyListTickers(payload);
        const result = await PythonBridge.runPipeline('run_full_pipeline', enrichedPayload);
        return { ok: true, data: result };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    });

    ipcMain.handle('quant:run-phase', async (_event, { phase, params } = {}) => {
      try {
        const actionMap = {
          1: 'run_fundamentals',
          2: 'run_technical',
          3: 'run_fracdiff',
          4: 'run_sentiment',
          5: 'run_purification',
          6: 'run_cpcv',
          'fundamentals': 'run_fundamentals',
          'technical': 'run_technical',
          'fracdiff': 'run_fracdiff',
          'sentiment': 'run_sentiment',
          'purification': 'run_purification',
          'cpcv': 'run_cpcv',
        };
        const action = actionMap[phase] || 'run_full_pipeline';
        const enrichedParams = resolveMyListTickers(params);
        const result = await PythonBridge.runPipeline(action, enrichedParams);
        return { ok: true, data: result };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    });

    ipcMain.handle('quant:save-tracked-asset', async (_event, payload) => {
      try {
        const result = await PythonBridge.runPipeline('save_tracked_asset', payload);
        return { ok: true, data: result };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    });

    ipcMain.handle('save-tracked-recommendation', async (_event, payload) => {
      try {
        const result = await PythonBridge.runPipeline('save_tracked_recommendation', payload);
        return { ok: true, data: result };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    });

    ipcMain.handle('quant:evaluate-tracked', async (_event, payload) => {
      try {
        const result = await PythonBridge.runPipeline('evaluate_tracked_assets', payload || {});
        return { ok: true, data: result };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    });

    ipcMain.handle('update-tracker-prices', async (_event, payload) => {
      try {
        const result = await PythonBridge.runPipeline('update_tracker_prices', payload || {});
        return { ok: true, data: result };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    });

    ipcMain.handle('quant:get-tracker-metrics', async (_event, payload) => {
      try {
        const result = await PythonBridge.runPipeline('get_tracker_metrics', payload || {});
        return { ok: true, data: result };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    });

    ipcMain.handle('quant:get-tracked-assets', async (_event, payload) => {
      try {
        const result = await PythonBridge.runPipeline('get_tracked_assets', payload || {});
        return { ok: true, data: result };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    });

    ipcMain.handle('quant:get-tracker-dashboard', async (_event, payload) => {
      try {
        const result = await PythonBridge.runPipeline('get_tracker_dashboard', payload || {});
        return { ok: true, data: result };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    });

    ipcMain.handle('fetch-tracker-data', async (_event, payload) => {
      try {
        const result = await PythonBridge.runPipeline('fetch_tracker_data', payload || {});
        return { ok: true, data: result };
      } catch (err) {
        return { ok: false, error: err.message };
      }
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

    // Spec Passo 2 – 3.1 Handler RUN_MARKET_SCAN 100% offline com validação prévia
    ipcMain.handle('RUN_MARKET_SCAN', async (event, { indexFilter } = {}) => {
      const freshness = db.checkListFreshness(indexFilter);
      if (!freshness.isUpdated) {
        return {
          success: false,
          outdated: true,
          maxStoredDate: freshness.maxStoredDate,
          expectedDate: freshness.expectedDate,
          message: `A base de dados necessita de sincronização. Última cotação: ${freshness.maxStoredDate || 'N/A'}, Esperada: ${freshness.expectedDate}.`
        };
      }
      const stocks = db.getStocksByIndex(indexFilter);
      const results = [];
      for (let i = 0; i < stocks.length; i++) {
        const stock = stocks[i];
        const scanRes = await scanStock(stock.ticker, db, quantEngine);
        results.push({ ...scanRes, name: stock.name, country: stock.country });
        if (i % 5 === 0 || i === stocks.length - 1) {
          try { event.sender.send('SCAN_PROGRESS', { current: i + 1, total: stocks.length, ticker: stock.ticker }); } catch (_) {}
        }
      }
      // ordena Elite primeiro
      const order = { ELITE: 0, MODERATE: 1, REJECTED: 2 };
      results.sort((a,b) => (order[a.mcTier] ?? 9) - (order[b.mcTier] ?? 9));
      return { success: true, results };
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

    // Spec: Handler START_SIMULATION com Pool Paralela de Worker Threads baseada em os.cpus().length
    ipcMain.handle('START_SIMULATION', async (event, params) => {
      return new Promise((resolve, reject) => {
        const dbPath = path.join(app.getPath('userData'), 'trades.db');
        const workerScript = (() => {
          const candidates = [
            path.join(__dirname, '../engine/simulationWorker.js'),
            path.join(__dirname, 'src/engine/simulationWorker.js'),
            path.join(__dirname, 'engine/simulationWorker.js'),
            path.join(app.getAppPath(), 'src/engine/simulationWorker.js')
          ];
          for (const c of candidates) {
            try { if (fs.existsSync(c)) return c; } catch (_) {}
          }
          return path.join(__dirname, 'src/engine/simulationWorker.js');
        })();
        const rawTickers = params.tickers || params.universe || [];
        const startDate = params.startDate || params.params?.startDate || null;
        const endDate = params.endDate || params.params?.endDate || null;
        const config = params.config || params.params || {};
        const normTickers = (Array.isArray(rawTickers) ? rawTickers : []).map(t => typeof t === 'string' ? t : (t.ticker || '')).filter(Boolean);

        if (normTickers.length === 0) {
          return resolve({ success: true, results: [] });
        }

        const numCores = Math.max(1, os.cpus().length - 1);
        const workerCount = Math.min(numCores, normTickers.length);
        const chunks = Array.from({ length: workerCount }, () => []);

        normTickers.forEach((t, index) => {
          chunks[index % workerCount].push(t);
        });

        let completedWorkers = 0;
        let totalProcessed = 0;
        const allResults = [];
        let hasError = false;

        chunks.forEach((tickerChunk) => {
          if (tickerChunk.length === 0) {
            completedWorkers++;
            if (completedWorkers === workerCount && !hasError) {
              resolve({ success: true, results: allResults });
            }
            return;
          }

          const worker = new Worker(workerScript, {
            workerData: {
              ...params,
              tickers: tickerChunk,
              startDate,
              endDate,
              config,
              dbPath
            }
          });

          worker.on('message', (msg) => {
            if (msg.type === 'PROGRESS') {
              totalProcessed += (msg.data && msg.data.deltaProcessed) || 1;
              if (event && event.sender && !event.sender.isDestroyed()) {
                event.sender.send('SIMULATION_PROGRESS', {
                  current: totalProcessed,
                  total: normTickers.length,
                  ticker: msg.data.ticker,
                  tradesCount: allResults.length + (msg.data.tradesCount || 0)
                });
              }
            } else if (msg.type === 'COMPLETE') {
              if (Array.isArray(msg.results)) {
                allResults.push(...msg.results);
              }
              completedWorkers++;
              if (completedWorkers === workerCount && !hasError) {
                resolve({ success: true, results: allResults });
              }
            } else if (msg.type === 'ERROR') {
              console.error('[Simulation Worker Error]', msg.error);
              completedWorkers++;
              if (completedWorkers === workerCount && !hasError) {
                resolve({ success: true, results: allResults });
              }
            }
          });

          worker.on('error', (err) => {
            console.error('[Simulation Worker Fatal Error]', err);
            completedWorkers++;
            if (completedWorkers === workerCount && !hasError) {
              resolve({ success: true, results: allResults });
            }
          });

          worker.on('exit', (code) => {
            if (code !== 0) {
              console.warn(`[Simulation Worker] Terminou com código de saída ${code}`);
            }
          });
        });
      });
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

    ipcMain.handle('add-stock-to-watchlist', async (event, stockData) => {
      try {
        if (!stockData || !stockData.ticker) {
          return { success: false, error: 'missing-ticker' };
        }
        const result = db.addOrUpdateStockRecord(stockData);
        if (result && result.ticker && stockData.index_name) {
          tickerToIndexMap[result.ticker] = stockData.index_name;
        }
        return { success: true, ...result };
      } catch (error) {
        console.error('[IPC Error add-stock-to-watchlist]:', error);
        return { success: false, error: error.message };
      }
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
        const historySummary = db.getStockHistorySummary(ticker);
        const summary = {
          hasData: !!(historySummary && historySummary.total_candles > 0),
          firstDate: historySummary ? historySummary.first_date : null,
          lastDate: historySummary ? historySummary.last_date : null,
          totalCandles: historySummary ? historySummary.total_candles : 0,
          fullHistoryFetched: !!(stock && stock.full_history_fetched)
        };
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

    ipcMain.handle('get-stock-details', async (_event, payload) => {
      const ticker = payload && payload.ticker ? String(payload.ticker).toUpperCase().trim() : '';
      if (!ticker) return { ok: false, error: 'missing-ticker' };
      try {
        const stockInfo = db.getStockByTicker(ticker) || {};
        // getStockHistorySummary recalcula o MIN/MAX/COUNT real e auto-corrige
        // first_date caso esta esteja vazia ou divergente.
        const historySummary = db.getStockHistorySummary(ticker);
        return {
          ok: true,
          ticker,
          name: stockInfo.name || ticker,
          country: stockInfo.country || '--',
          index_name: stockInfo.index_name || '--',
          first_date: historySummary.first_date,
          last_date: historySummary.last_date,
          total_candles: historySummary.total_candles
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

    ipcMain.handle('get-stock-dividends', async (_event, payload) => {
      const ticker = (payload && typeof payload === 'object') ? payload.ticker : payload;
      try {
        return db.getStockDividends(ticker);
      } catch (error) {
        console.error(`Erro ao obter dividendos para ${ticker}:`, error.message);
        return { dividends: [], totalCount: 0, totalAmount: 0, lastDividend: null };
      }
    });

    ipcMain.handle('download-stock-dividends', async (_event, payload) => {
      const rawTicker = (payload && typeof payload === 'object') ? payload.ticker : payload;
      const cleanTicker = String(rawTicker || '').trim().toUpperCase();
      try {
        const dividends = await yahooClient.fetchStockDividendsFromYahoo(cleanTicker, 0);
        if (dividends && dividends.length > 0) {
          db.saveStockDividends(cleanTicker, dividends);
        }
        const updatedData = db.getStockDividends(cleanTicker);
        return {
          success: true,
          count: (dividends && dividends.length) || 0,
          ...updatedData
        };
      } catch (error) {
        console.error(`Erro ao descarregar dividendos para ${cleanTicker}:`, error.message);
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle('sync-index-data-batch', async (event, input) => {
      try {
        const { indexFilter, mode = 'BOTH' } = input || {};
        const assets = db.getStocksByIndex(indexFilter);
        if (!assets || assets.length === 0) {
          return { success: false, message: 'Nenhum ativo associado ao índice selecionado.' };
        }

        let updatedCount = 0;
        const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

        for (let i = 0; i < assets.length; i++) {
          const stock = assets[i];
          const ticker = (stock.ticker || '').trim().toUpperCase();
          if (!ticker) continue;

          if (event && event.sender && !event.sender.isDestroyed()) {
            event.sender.send('SYNC_PROGRESS_UPDATE', {
              current: i + 1,
              total: assets.length,
              ticker: ticker,
              label: mode === 'DIVIDENDS_ONLY' ? 'Dividendos' : (mode === 'PRICES_ONLY' ? '1º Registo' : 'Preços + Dividendos')
            });
          }

          if (mode === 'PRICES_ONLY' || mode === 'BOTH') {
            try {
              const candles = await yahooClient.fetchFullHistoryFromIPO(ticker);
              if (candles && candles.length > 0) {
                if (typeof db.saveHistoricalCandlesBatch === 'function') {
                  db.saveHistoricalCandlesBatch(ticker, candles);
                } else if (typeof db.saveHistoricalCandlesFromImport === 'function') {
                  db.saveHistoricalCandlesFromImport(ticker, candles);
                }
                if (typeof db.setFullHistoryFetched === 'function') {
                  db.setFullHistoryFetched(ticker);
                }
              }
            } catch (priceErr) {
              console.warn(`[Aviso Preços] ${ticker}: ${priceErr.message}`);
            }
          }

          if (mode === 'DIVIDENDS_ONLY' || mode === 'BOTH') {
            try {
              const dividends = await yahooClient.fetchStockDividendsFromYahoo(ticker, 0);
              if (dividends && dividends.length > 0) {
                db.saveStockDividends(ticker, dividends);
              }
            } catch (divErr) {
              console.warn(`[Aviso Dividendos] ${ticker}: ${divErr.message}`);
            }
          }

          updatedCount++;
          await sleep(200);
        }

        if (mode === 'PRICES_ONLY' || mode === 'BOTH') {
          if (typeof db.reconcileAllStocksFirstDate === 'function') {
            db.reconcileAllStocksFirstDate();
          }
        }

        return {
          success: true,
          updatedCount,
          total: assets.length
        };
      } catch (error) {
        console.error('Erro na sincronização em lote:', error);
        return { success: false, error: error.message };
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

    // Países já existentes na base de dados (autocomplete do modal de adição).
    ipcMain.handle('get-distinct-countries', async () => {
      try {
        const countries = db.getAllDistinctCountries();
        return { ok: true, countries };
      } catch (err) {
        return { ok: false, error: err.message || String(err) };
      }
    });

    // Auditoria/reconciliação manual: força a correção global de first_date
    // para o MIN(date) real em todos os ativos (usa também no arranque).
    ipcMain.handle('reconcile-all-dates', async () => {
      try {
        const result = db.reconcileAllStocksFirstDate();
        return { ok: !!result.success, ...result };
      } catch (err) {
        return { ok: false, success: false, error: err.message || String(err) };
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

    // Spec 3.2 – Handler consolidado sync-incremental-batch (PASSO 1)
    ipcMain.handle('sync-incremental-batch', async (event, { tickers, expectedTradingDay }) => {
      processedCount = 0;
      lastEmitTime = Date.now();
      const total = Array.isArray(tickers) ? tickers.length : 0;
      const allCandlesToInsert = [];
      const updatedTickers = [];

      const results = await yahooClient.syncTickersBatch(tickers, {
        expectedTradingDay,
        getLastDate: (t) => db.getLastStoredDate(t),
        fetchMethod: (t, lastDate) => yahooClient.fetchIncrementalYahooHistory(t, lastDate, { throwOnError: true })
      });

      for (const res of results) {
        if (res.status === 'SUCCESS' && res.candles && res.candles.length > 0) {
          allCandlesToInsert.push(...res.candles.map(c => ({ ...c, ticker: res.ticker })));
          updatedTickers.push(res.ticker);
        }
        emitThrottledProgress(event.sender, 'SYNC_PROGRESS', { total, ticker: res.ticker, status: res.status });
      }

      if (allCandlesToInsert.length > 0) {
        db.saveBulkHistoricalCandles(allCandlesToInsert);
      }

      return {
        success: true,
        totalProcessed: total,
        updatedCount: updatedTickers.length,
        updatedTickers
      };
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

    let syncRecentInProgress = false;

    const classifySyncError = (err) => {
      const status = err && (err.response?.status || err.status || err.statusCode);
      const msg = (err && err.message) ? String(err.message) : '';
      if (status === 429 || /429|rate.?limit|too many requests/i.test(msg)) return 'Rate Limit (429)';
      if (status === 404 || /404|not found|invalid symbol|no data/i.test(msg)) return 'Ticker não encontrado / deslistado (404)';
      if ((err && /timeout|ETIMEDOUT|ECONNABORTED/i.test(String(err.code || '') + ' ' + msg))) return 'Timeout';
      return msg || 'Erro desconhecido';
    };

    ipcMain.handle('sync-audit', async (_event, input = {}) => {
      const startTime = Date.now();
      const indexFilter = (input && typeof input === 'object')
        ? (input.indexFilter || input.index || input.indexName || null)
        : (typeof input === 'string' ? input : null);

      console.log('[sync-audit] Starting audit with indexFilter:', indexFilter);

      try {
        const allStoredStocks = typeof db.auditMyListAssets === 'function'
          ? db.auditMyListAssets(indexFilter)
          : db.getMyListAssetsSyncStatus(indexFilter);
        
        console.log('[sync-audit] Audit completed in', Date.now() - startTime, 'ms, found', allStoredStocks?.length || 0, 'stocks');

        const expectedTradingDay = db.getLastExpectedTradingDay();

        if (!allStoredStocks || allStoredStocks.length === 0) {
          return {
            ok: true, total: 0, pending: 0, upToDate: 0,
            pendingList: [], upToDateList: []
          };
        }

        const pendingList = [];
        const upToDateList = [];

        for (const asset of allStoredStocks) {
          if (asset.last_date && expectedTradingDay && asset.last_date >= expectedTradingDay) {
            upToDateList.push(asset);
          } else {
            pendingList.push(asset);
          }
        }

        console.log('[sync-audit] Pending:', pendingList.length, 'Up to date:', upToDateList.length);

        return {
          ok: true,
          total: allStoredStocks.length,
          pending: pendingList.length,
          upToDate: upToDateList.length,
          pendingList,
          upToDateList,
          expectedTradingDay
        };
      } catch (err) {
        console.error('[sync-audit] Error:', err);
        return { ok: false, error: err.message || String(err), total: 0, pending: 0, upToDate: 0 };
      }
    });

    ipcMain.handle('process-asset-sync', async (event, input = {}) => {
      try {
        const { mode, targetTicker = null, indexFilter = null } = (input || {});
        // 1. Execução obrigatória da FASE 1: Diagnóstico total prévio em SQLite
        const fullAudit = db.auditAllAssetsStatus(indexFilter);
        const expectedTradingDay = db.getLastExpectedTradingDay();

        // 2. Determinar quais os ativos alvo
        let queue = [];
        if (targetTicker) {
          queue = fullAudit.filter(a => a.ticker.toUpperCase() === String(targetTicker).trim().toUpperCase());
        } else {
          queue = fullAudit;
        }

        if (queue.length === 0) {
          return { success: false, message: 'Nenhum ativo encontrado para processar.' };
        }

        let updatedCount = 0;
        let skippedCount = 0;
        let failedCount = 0;
        const allCandlesToSave = [];

        // 3. Execução da FASE 2: Download sequencial controlado
        for (let i = 0; i < queue.length; i++) {
          const asset = queue[i];
          const ticker = asset.ticker;

          try {
            if (mode === 'LAST_DAY') {
              // Apenas o dia/sessão mais recente
              if (asset.last_date && expectedTradingDay && asset.last_date >= expectedTradingDay) {
                skippedCount++;
              } else {
                const candles = await yahooClient.fetchIncrementalCandles(ticker, asset.last_date);
                if (candles && candles.length > 0) {
                  allCandlesToSave.push(...candles.map(c => ({ ...c, ticker })));
                  updatedCount++;
                }
              }
            } else if (mode === 'FULL_HISTORY') {
              // Todo o histórico desde a origem (IPO / period1 = 0)
              const candles = await yahooClient.fetchFullHistoryFromIPO(ticker);
              if (candles && candles.length > 0) {
                allCandlesToSave.push(...candles.map(c => ({ ...c, ticker })));
                updatedCount++;
              }
            }

            // Emissão de progresso para a UI
            if (event && event.sender && !event.sender.isDestroyed()) {
              event.sender.send('SYNC_PROGRESS_UPDATE', {
                current: i + 1,
                total: queue.length,
                ticker,
                mode
              });
            }

            // Pausa de proteção (jitter) para evitar Erro 429 do Yahoo Finance
            await new Promise(resolve => setTimeout(resolve, 100));
          } catch (assetErr) {
            console.warn(`[Sync Error] Falha em ${ticker}: ${assetErr.message}`);
            failedCount++;
          }
        }

        // Gravação consolidada em lote na SQLite
        if (allCandlesToSave.length > 0) {
          db.saveHistoricalCandlesBatch(allCandlesToSave);
          // Se descarregou histórico completo, reconcilia a first_date
          if (mode === 'FULL_HISTORY') {
            db.reconcileAllStocksFirstDate();
          }
        }

        return {
          success: true,
          mode,
          total: queue.length,
          updatedCount,
          skippedCount,
          failedCount
        };
      } catch (err) {
        console.error('[Sync Fatal Error]:', err);
        return { success: false, error: err.message };
      }
    });

    ipcMain.handle('sync-start-download', async (event, input = {}) => {
      if (syncRecentInProgress) {
        return { ok: false, error: 'sync-already-in-progress' };
      }

      const indexFilter = (input && typeof input === 'object')
        ? (input.indexFilter || input.index || input.indexName || null)
        : (typeof input === 'string' ? input : null);

      const sender = event && event.sender && !event.sender.isDestroyed()
        ? event.sender
        : (mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : null);

      const sendEvent = (channel, payload) => {
        if (sender && !sender.isDestroyed()) sender.send(channel, payload);
      };

      let allStoredStocks;
      let expectedTradingDay;
      try {
        allStoredStocks = typeof db.auditMyListAssets === 'function'
          ? db.auditMyListAssets(indexFilter)
          : db.getMyListAssetsSyncStatus(indexFilter);
        expectedTradingDay = db.getLastExpectedTradingDay();
      } catch (err) {
        return { ok: false, error: err.message || String(err) };
      }

      if (!allStoredStocks || allStoredStocks.length === 0) {
        return { ok: true, started: false, total: 0, pending: 0 };
      }

      const pendingQueue = [];
      let alreadyUpToDateCount = 0;

      for (const asset of allStoredStocks) {
        if (asset.last_date && expectedTradingDay && asset.last_date >= expectedTradingDay) {
          alreadyUpToDateCount++;
        } else {
          pendingQueue.push(asset);
        }
      }

      const totalPending = pendingQueue.length;
      if (totalPending === 0) {
        return { ok: true, started: false, total: allStoredStocks.length, pending: 0, alreadyUpToDateCount };
      }

      syncRecentInProgress = true;

      (async () => {
        let updatedCount = 0;
        const failedTickers = [];
        let fallbackInitialized = 0;
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

        try {
          for (let i = 0; i < totalPending; i++) {
            const asset = pendingQueue[i];
            try {
              const fetchFn = typeof yahooClient.fetchLatestCandlesForSingleTicker === 'function'
                ? yahooClient.fetchLatestCandlesForSingleTicker
                : yahooClient.fetchIncrementalCandles;
              const candles = await fetchFn(asset.ticker, asset.last_date);

              if (candles && candles.length > 0) {
                if (typeof db.saveSingleAssetCandles === 'function') {
                  db.saveSingleAssetCandles(candles);
                } else {
                  db.saveBulkIncrementalCandles(candles);
                }
                updatedCount++;
                if (!asset.last_date) fallbackInitialized++;
              }
            } catch (err) {
              console.warn(`[Sync Warning] Falha ao sincronizar ${asset.ticker}:`, err.message);
              failedTickers.push({
                ticker: asset.ticker,
                index_name: asset.index_name || '',
                reason: classifySyncError(err)
              });
            }

            sendEvent('SYNC_RECENT_PROGRESS', {
              current: i + 1,
              total: totalPending,
              ticker: asset.ticker,
              percent: Math.round(((i + 1) / totalPending) * 100)
            });

            if (i < totalPending - 1) await sleep(100);
          }
        } catch (fatalError) {
          console.error('[Sync Fatal Error]', fatalError);
        } finally {
          syncRecentInProgress = false;
        }

        sendEvent('sync-all-done', {
          totalStocks: allStoredStocks.length,
          total: allStoredStocks.length,
          updatedCount,
          alreadyUpToDateCount,
          updated: updatedCount,
          skipped: alreadyUpToDateCount,
          fallbackInitialized,
          failedCount: failedTickers.length,
          failedTickers,
          status: 'done'
        });
      })();

      return {
        ok: true,
        started: true,
        total: allStoredStocks.length,
        pending: totalPending,
        alreadyUpToDateCount
      };
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

      const errors = [];
      let completed = 0;
      let updated = 0;
      const emit = payload => sendPipelineProgress(event, 'index-sync-progress', {
        operationId: operation.operationId, indexId: index, ...payload
      });

      try {
        // FASE 1: Auditoria e Triagem Local Instantânea
        const audit = db.auditIndexStocks(index);
        const pending = audit.stocks.filter(s => !s.isComplete);

        if (audit.totalStocks === 0 || pending.length === 0) {
          emit({ current: 0, total: audit.totalStocks, ticker: '', status: 'done',
            state: 'complete', totalStocks: audit.totalStocks, completeCount: audit.completeCount });
          return { ok: true, success: true, status: 'complete', operationId: operation.operationId,
            total: audit.totalStocks, updated: 0, errorCount: 0, errors: [], cancelled: false };
        }

        const total = pending.length;

        // FASE 2: Concorrência Controlada com p-limit(5) e Gravação em Lote
        const tasks = pending.map((stock) => yahooClient.networkLimit(async () => {
          if (isPipelineCancelled(operation)) return;
          const ticker = stock.ticker;
          try {
            const candles = await yahooClient.fetchFullHistoryFromIPO(ticker);
            if (isPipelineCancelled(operation)) return;

            if (!candles || candles.length === 0) {
              const error = 'empty-history';
              errors.push({ ticker, error });
            } else {
              db.saveHistoricalCandlesFromImport(ticker, candles);
              db.setFullHistoryFetched(ticker);
              updated++;
            }
          } catch (err) {
            const error = err.message || String(err);
            errors.push({ ticker, error });
            console.error(`[sync-index-first-records] ${ticker}: ${error}`);
          } finally {
            completed++;
            const pct = Math.round((completed / total) * 100);
            if (completed % 5 === 0 || completed === total) {
              emit({
                current: completed,
                total,
                ticker,
                name: stock.name || '',
                percent: pct,
                status: 'syncing',
                state: 'syncing',
                updated,
                errorCount: errors.length
              });
              if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('first-registo-progress', {
                  operationId: operation.operationId,
                  index,
                  current: completed,
                  total,
                  ticker,
                  percent: pct,
                  status: 'syncing',
                  updated,
                  errorCount: errors.length
                });
              }
            }
          }
        }));

        await Promise.all(tasks);

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
