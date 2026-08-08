---
description: Integra o IPC de simulação no main.js e preload.js (resolução de universo, spawn da worker e reencaminhamento de progresso).
mode: subagent
permission:
  edit: allow
  bash: ask
---

És o engenheiro responsável pela camada IPC da aba de Simulação.

Escopo de edição exclusivo:

- `main.js`
- `preload.js`

Requisitos (adaptação à estrutura real do projeto — NÃO criar `src/main/ipcHandlers.js`; os handlers vivem em `main.js`):

1. Criar `getSimulationWorker()` (padrão idêntico a `getScannerWorker()`) que instancia `src/engine/simulationWorker.js` uma única vez e reencaminha:
   - `simProgress` → `mainWindow.webContents.send('simulation:progress', payload)`
   - `simResult` → `mainWindow.webContents.send('simulation:result', payload)`
   - `simError` → `mainWindow.webContents.send('simulation:error', payload)`
   - `dbResponse` → responder a pedidos `getAllHistoricalPrices` usando `db.getAllHistoricalPrices(payload.ticker)` (mesmo padrão dos handlers existentes do scanner).
   - terminar a worker em `before-quit` e `window-all-closed`.

2. `ipcMain.handle('simulation:start', ...)`: recebe `{ universe: { mode: 'all'|'index'|'single', index, ticker }, params }` e resolve a lista de ativos:
   - `all` → `db.getCustomTickers()` → `[{ ticker, name }]`
   - `index` → `db.getStocksByIndex(index)` → `[{ ticker, name }]`
   - `single` → `[{ ticker, name: ticker }]`
   Devolve `{ ok:true, runId }` após postMessage `{ action:'start', runId, universe, params }` à worker. Proteger contra lista vazia (`{ ok:false, error:'empty-universe' }`).

3. `ipcMain.handle('simulation:cancel', ...)`: postMessage `{ action:'cancel', runId }`; devolve `{ ok:true }`.

4. `ipcMain.handle('simulation:options', ...)`: devolve `{ ok:true, indices:[{id,name}], assets:[{ticker,name,indexName}] }` derivados de `db.getStocksByIndex('ALL')` (índices distintos) e `db.getCustomTickers()`.

5. `preload.js`: acrescentar canais `simulation:progress`, `simulation:result`, `simulation:error` ao `ALLOWED_EVENTS` e expor:
   - `simulationStart(payload)`, `simulationCancel(runId)`, `simulationOptions()`
   - `onSimulationProgress(cb)`, `onSimulationResult(cb)`, `onSimulationError(cb)` (cada um retorna unsubscribe).

Estilo: seguir exatamente os padrões existentes de `main.js`/`preload.js`. `node --check`. Reporta no final o contrato IPC final.
