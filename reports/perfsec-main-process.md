# Auditoria Performance & Segurança — Processo Principal (main.js)

- **Agente**: `perfsec-main-process` (.opencode/agents/perfsec-main-process.md)
- **Alvo**: `main.js` (raiz, entrypoint Electron; 2957 linhas, working tree com alterações não commitadas)
- **Âmbito**: IPC, fs, workers, rede, `webPreferences`, arranque e bridge Python, seguindo `preload.js`, `src/db/database.js`, `src/data/yahooClient.js`, `src/data/tickerLists.js`, `src/data/countryIndexMap.js`, `src/services/wikipediaScraper.js`, `src/services/marketDataService.js`, `src/services/pythonBridge.js`, `src/importer/historicalImporter.js`, `src/scanner.js`, `src/utils/*`, `src/engine/scanner.worker.js`, `src/engine/simulationWorker.js` e testes em `test/`.
- **Método**: leitura integral + verificação de imports/chamadas + repro mínimo do comportamento do `p-limit` v3 + `npm audit`. Nenhum ficheiro de código foi alterado (apenas este relatório).

## Resumo

| Severidade | Nº |
|---|---|
| Crítico | 1 |
| Alto | 5 |
| Médio | 10 |
| Baixo | 8 |
| Informativo / refutado | 6 |
| **Total** | **30** |

---

## Findings

### PS-MAIN-01 — Crítico — Deadlock por reentrância do `p-limit` em syncs de rede

- **Evidência (confirmado)**:
  - `src/data/yahooClient.js:26` — `const networkLimit = pLimit(5)` (não reentrante).
  - `src/data/yahooClient.js:828-848` — com `options.fetchMethod`, cada task é envolvida em `networkLimit(async () => { … fetchWithRetrySpec(() => fetchOne(ticker, lastDate)) … })` (linha 829 e 840).
  - `src/data/yahooClient.js:625-652` — `fetchIncrementalYahooHistory` adquire o **mesmo** limiter internamente (`networkLimit(() => fetchWithBackoff(...))`, linha 641).
  - `main.js:1842-1846` — `sync-incremental-batch` passa `fetchMethod: (t, lastDate) => yahooClient.fetchIncrementalYahooHistory(...)`.
  - `main.js:2566-2570` — `sync-index-first-records` envolve cada task em `yahooClient.networkLimit(...)` e chama `fetchFullHistoryFromIPO`, que por sua vez adquire o limiter em `src/data/yahooClient.js:554`.
- **Repro**: com `p-limit@3.1.0`, 5 tarefas externas a ocupar os 5 slots e cada uma a aguardar uma tarefa interna do mesmo limiter nunca terminam (verificado em execução local; timeout de 2s sem conclusão). Com ≥5 tickers pendentes, ambas as rotas ficam penduradas; os handlers não têm timeout/abort.
- **Impacto**: `sync-incremental-batch` e `sync-index-first-records` nunca resolvem; a UI de sincronização congela, sem erro nem possibilidade de cancelamento efetivo.
- **Correção mínima**: remover o wrapper exterior em `yahooClient.js:829` e `main.js:2566` (as funções de rede já adquirem o teto), ou usar um segundo limiter dedicado; adicionar timeout no handler e teste de regressão com `fetchMethod` real (os testes atuais só injectam `fetchOne`, ver `test/concurrency-sync.test.js:276-297`).
- **Suspeita vs confirmado**: comportamento do `p-limit` confirmado; o hang end-to-end em produção é a consequência direta do fluxo verificado.

### PS-MAIN-02 — Alto — Path traversal / leitura arbitrária de ficheiros na importação

- **Evidência (confirmado)**:
  - `main.js:1440-1451` — `import-historical-data` aceita `payload.filePath` do renderer e chama `parseFile(payload.filePath)` sem qualquer validação de diretório.
  - `main.js:1355-1374` — `import:bulk` idem: `payload.filePath` direto para `parseFile` (linha 1389); `payload.fileData` gravado em temp.
  - `src/importer/historicalImporter.js:245-259` — `parseFile` faz `fs.existsSync`/leitura de qualquer path; `:135` `fs.readFileSync` integral.
  - `preload.js:54,157` — exposição de `importBulk`/`importHistoricalData` ao renderer.
- **Impacto**: qualquer conteúdo do renderer (XSS ou navegação para conteúdo remoto — ver PS-MAIN-03) consegue ler ficheiros locais acessíveis ao processo (`/etc/passwd`, chaves, CSV/XLSX de terceiros) e inferir/exfiltrar o conteúdo através de erros/sucesso, ignorando a sandbox da UI.
- **Correção mínima**: no main, forçar `dialog.showOpenDialog` (como em `main.js:1504-1556`) ou validar `path.resolve(filePath)` contra allowlist (userData/temp/downloads) + extensão, rejeitando paths absolutos vindos do renderer.

### PS-MAIN-03 — Alto — Sem bloqueio de navegação/janelas com bridge preload amplo

- **Evidência (confirmado)**:
  - `main.js:500-518` — `createWindow()` não regista `will-navigate` nem `setWindowOpenHandler`; `rg` confirma 0 ocorrências destes no ficheiro.
  - `preload.js:223-225` — exposição de `api`, `electronAPI`, `quantAPI`; `preload.js:31-206` — dezenas de `invoke` privilegiados (fs, DB, rede, Python).
- **Impacto**: uma navegação da BrowserWindow para URL remoto (link, `location`, XSS) carrega conteúdo remoto com o preload injetado; a página remota pode chamar todo o bridge (PS-MAIN-02 para ler ficheiros; `ticker:list`/`trade:list`/`sync-audit` para exfiltrar dados; `ticker:clear`/`trade:clear`/`delete-index-with-stocks` para destruir dados). O CSP do `renderer/index.html` mitiga XSS, mas não a navegação iniciada pelo utilizador/links.
- **Correção mínima**: `mainWindow.webContents.on('will-navigate', (e) => e.preventDefault())` e `mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))`; abrir links externos apenas via `shell.openExternal` após validação `https:`.

### PS-MAIN-04 — Alto — `RUN_MARKET_SCAN` executa o scan pesado no main process

- **Evidência (confirmado)**:
  - `main.js:763-788` — loop `for` que faz `await scanStock(stock.ticker, db, quantEngine)` por ativo (linha 778) e devolve todos os resultados.
  - `src/scanner.js:20-156` — corpo quase 100% síncrono: `better-sqlite3` (`getHistoricalPricesForScan`), VWAP/RVOL, Markov e Monte Carlo 1000×35d no motor nativo; sem pontos de `await` significativos.
- **Impacto**: cada ativo bloqueia o event loop principal (dezenas de ms a segundos com o motor nativo); em índices grandes (S&P 500) a UI congela e todos os outros IPC ficam atrasados — exatamente o trabalho que `src/engine/scanner.worker.js` foi criado para evitar (`scan:start` já o usa).
- **Correção mínima**: encaminhar `RUN_MARKET_SCAN` para `scanner.worker.js` (ou worker dedicado), mantendo no main apenas `getStocksByIndex`/freshness; enviar progresso por mensagem.

### PS-MAIN-05 — Alto — `xlsx@0.18.5` vulnerável processado a partir de input não confiável

- **Evidência (confirmado)**:
  - `package.json:33` — `"xlsx": "^0.18.5"`; `node_modules/xlsx/package.json` = 0.18.5.
  - `src/importer/historicalImporter.js:184-189` — `xlsx.readFile(filePath)` sobre ficheiro arbitrário (ver PS-MAIN-02) / `fileData` do renderer.
  - `npm audit --omit=dev` reporta **high**: Prototype Pollution (CVE-2023-30533) e ReDoS (CVE-2024-22363).
- **Impacto**: um XLSX malicioso importado pode poluir protótipos no main process (combinado com qualquer gadget de execução) e/ou causar DoS por ReDoS; atacável por conteúdo remoto no encadeamento com PS-MAIN-03.
- **Correção mínima**: migrar para SheetJS ≥0.20.x (distribuição oficial fora do npm) ou isolar o parse XLSX num processo/worker separado com timeout e limites de tamanho.

### PS-MAIN-06 — Alto — `db:purgeInactive` com `daysCutoff` não validado (perda de dados)

- **Evidência (confirmado)**:
  - `main.js:1933-1941` — `const days = payload && payload.daysCutoff ? Number(payload.daysCutoff) : 60;` sem limites.
  - `src/db/database.js:1783-1789` — `cutoffDate = new Date(Date.now() - daysCutoff * 86400000).toISOString().slice(0,10)`; `daysCutoff` negativo coloca o cutoff no futuro.
  - `src/db/database.js:1792-1817` — todos os tickers sem cotação `>= cutoff` são removidos de `stocks` e `market_shortcuts`.
- **Impacto**: um valor negativo elimina **todos** os metadados de ativos (histórico fica órfão); NaN lança `RangeError` no `toISOString` (apanhado e devolvido como erro, sem dano). Chamável via `preload.js:69`.
- **Correção mínima**: `const days = Number(payload?.daysCutoff); if (!Number.isFinite(days) || days < 1 || days > 3650) return { ok:false, error:'invalid-cutoff' };` antes de chamar o DB.

### PS-MAIN-07 — Médio — `import:bulk` sem limite de tamanho e leitura integral em memória

- **Evidência (confirmado)**: `main.js:1369-1373` (`Buffer.from(payload.fileData)` + `fs.writeFileSync` sem cap); `src/importer/historicalImporter.js:135` (`fs.readFileSync` do CSV inteiro), `:186` (`xlsx.readFile`).
- **Impacto**: renderer pode enviar centenas de MB → OOM/GC pressure e freeze do main (DoS).
- **Correção mínima**: validar `payload.fileData.length`/`fs.statSync(filePath).size` (ex. ≤50 MB) antes de processar; usar streaming no CSV (`importFromCsvFile` já usa stream em `:303-313`, reutilizável).

### PS-MAIN-08 — Médio — `ticker:addBulk` sem limite de cardinalidade

- **Evidência (confirmado)**: `main.js:1162-1172` repassa `payload.tickers` sem cap a `db.addCustomTickersBulk` (`src/db/database.js:499-549`), tudo dentro de uma transação síncrona.
- **Impacto (magnitude suspeita)**: milhares de items inserem de forma síncrona no main (bloqueio) e inflam o DB.
- **Correção mínima**: rejeitar listas acima de um cap (ex. 5000) e normalizar/deduplicar antes da transação.

### PS-MAIN-09 — Médio — Arranque bloqueante: migração + reconciliação antes de criar a janela

- **Evidência (confirmado)**: `main.js:563-572` (`await db.init()` e `db.reconcileAllStocksFirstDate()` antes de `createWindow()` em `main.js:2930`); `src/db/database.js:270-286` (UPDATE correlacionado executado em todos os arranques, sem version guard) e `:1667-1725` (dois UPDATEs full-scan).
- **Impacto (magnitude suspeita)**: cold start proporcional ao nº de velas; em bases com milhões de linhas atrasa a janela sem feedback.
- **Correção mínima**: criar a janela primeiro e correr reconciliação idempotente de forma assíncrona/agendada; guardar a autocorreção de `first_date` atrás de `PRAGMA user_version`.

### PS-MAIN-10 — Médio — N+1 queries em `checkListFreshness` e `ticker:list`

- **Evidência (confirmado)**:
  - `src/db/database.js:1976-1981` — um `SELECT MAX(date) … WHERE ticker = ?` **por ticker** dentro de `checkListFreshness`; chamada em `main.js:764` (`RUN_MARKET_SCAN`) e `main.js:1943-1950` (`check-list-freshness`).
  - `main.js:1200-1223` — `db.getStockByTicker(symbolUpper)` por ticker dentro de `ticker:list` (linha 1202).
- **Impacto**: latência O(n) de queries síncronas no event loop principal; UI lenta com listas grandes.
- **Correção mínima**: uma única agregação `IN (…) GROUP BY ticker` (o padrão já existe em `getHistoricalSummaryBatch`, `database.js:1727-1764`) e um `SELECT … WHERE ticker IN (…)` para metadados.

### PS-MAIN-11 — Médio — `START_SIMULATION`: pools de workers sem lock/cap, erros mascarados

- **Evidência (confirmado)**:
  - `main.js:902-1003` — handler sem mutex; `numCores = Math.max(1, os.cpus().length - 1)` (`:927`) e `new Worker(workerScript, …)` por chunk (`:949`).
  - `hasError` é inicializado (`:938`) e **nunca** alterado; os caminhos de `ERROR`/`error` resolvem `{ success: true, results: allResults }` (`:979-994`).
  - Workers não são terminados explicitamente; não há validação de `params` (ver PS-MAIN-20).
- **Impacto**: invocações concorrentes multiplicam workers (N cores cada) → oversubscription, pressão de memória e contenção no SQLite; falhas parciais são reportadas como sucesso.
- **Correção mínima**: mutex/rejeição de execuções concorrentes, `hasError = true` + rejeitar (ou `success:false`) em falha, `worker.terminate()` no fim.

### PS-MAIN-12 — Médio — `scan:backtest`: clone de `cachedCandles` e timeouts longos sem abort

- **Evidência (confirmado)**: `main.js:1016-1023` (carrega cache de todos os tickers no main), `:1043-1052` (`postMessage` com `cachedCandles`, lista sem cap), `:1029-1032` (timeout 10 min), `:1067-1070` (`trade:update`, 2 min). Se o worker morrer, o handler espera o timeout total (`:300-308` apenas anula a referência).
- **Impacto**: serialização/structured-clone grande bloqueia o main; hangs longos sem feedback em crash. O worker já suporta `getCachedOHLCV` via DB request? (ver `src/engine/scanner.worker.js`, que usa `dbResponse`), pelo que o pré-carregamento é redundante.
- **Correção mínima**: enviar apenas `cacheKeys`/timeframe e deixar o worker pedir velas via `dbResponse`; adicionar cap de tickers e rejeitar a Promise no evento `error`/`exit`.

### PS-MAIN-13 — Médio — `params:set`/`scan:start` sem validação de tipos e intervalos

- **Evidência (confirmado)**: `main.js:1237-1241` (key/value arbitrários gravados em `adaptive_params`); `main.js:462-486` (`Number(...)` sem `Number.isFinite`/clamp para `edge_threshold`, `markov_window`, `horizon_days`); `main.js:746-747` (`payload?.tickers` sem validação de elementos).
- **Impacto**: `NaN`/valores extremos propagam-se ao DB/worker (custos anómalos, erros de binding) e chaves arbitrárias poluem `adaptive_params`.
- **Correção mínima**: whitelist de chaves; clamp (`markov_window` 20–1000, `edge_threshold` 0–1, `horizon_days` 1–60) e rejeição de não-finitos.

### PS-MAIN-14 — Médio — `ticker:search` sem throttling nem cap de `limit`

- **Evidência (confirmado)**: `main.js:1100-1110` — `query`/`limit` do renderer sem validação; `src/data/yahooClient.js:449-526` — até 3 tentativas com sleeps de ~0,8–5 s e `quotesCount: limit` sem teto.
- **Impacto**: spam do renderer esgota o rate limit da Yahoo (429), afetando syncs e dividendos; `limit` enorme amplifica o pedido.
- **Correção mínima**: `limit = Math.min(Math.max(1, Number(limit) || 8), 20)`, comprimento mínimo/máximo de `query` e debounce/limite de taxa por sessão.

### PS-MAIN-15 — Médio — Detalhes internos (stderr/paths) devolvidos ao renderer

- **Evidência (confirmado)**: `src/services/pythonBridge.js:91` (`Stderr: ${stderrData.trim()}`), `:108` (`Raw stdout`), `:38` (`scriptPath` no erro); handlers `quant:*` devolvem `err.message` em bruto (`main.js:628,635,660,671-737`).
- **Impacto**: paths absolutos e stderr de Python expostos à UI e, através de PS-MAIN-03, a conteúdo remoto.
- **Correção mínima**: mapear para mensagens genéricas (`pipeline-failed`) e registar o detalhe apenas com `console.error` no main.

### PS-MAIN-16 — Médio — `process-asset-sync` acumula todas as velas e grava numa única transação

- **Evidência (confirmado)**: `main.js:2037` (`allCandlesToSave`), `:2040-2081` (push de todos os lotes, `FULL_HISTORY` incluído) e `:2084-2089` (`db.saveHistoricalCandlesBatch` no fim).
- **Impacto (magnitude suspeita)**: picos de memória e bloqueio do main numa transação longa ao descarregar histórico completo de centenas de ativos.
- **Correção mínima**: gravar por chunks (ex. a cada 50 ativos) com `await setImmediate()` para devolver o event loop e reportar progresso.

### PS-MAIN-17 — Baixo — Estado global de throttle e envio sem `isDestroyed`

- **Evidência (confirmado)**: `main.js:92-106` (`processedCount`/`lastEmitTime` module-level), reset em `:1836-1837`, uso em `:1853`; `sender.send` sem verificar destruição (`:98`).
- **Impacto**: progresso trocado entre execuções concorrentes de `sync-incremental-batch`; exceção se o renderer fechar durante o sync.
- **Correção mínima**: usar `createProgressReporter` por execução (já importado e não usado, `main.js:13`) e `if (sender && !sender.isDestroyed())`.

### PS-MAIN-18 — Baixo — Crash do worker deixa Promises pendentes; listeners acumulam

- **Evidência (confirmado)**: `main.js:300-308` (scanner) e `:391-401` (simulação) anulam a referência sem rejeitar; `:1027-1053` e `:1065-1094` resolvem apenas por mensagem/timeout e adicionam `worker.on('message', handler)` por chamada.
- **Impacto**: após crash, espera até 10 min (backtest) / 2 min (trades); >10 chamadas concorrentes → `MaxListenersExceededWarning`.
- **Correção mínima**: guardar o handler e rejeitar no `error`/`exit`; `worker.setMaxListeners(0)` ou serializar chamadas numa fila.

### PS-MAIN-19 — Baixo — Limpeza de `sync-all-recent-prices` exposta sem handler registado

- **Evidência (confirmado)**: `preload.js:72-73` invoca `sync-all-recent-prices`; `rg` em `main.js` não encontra `ipcMain.handle('sync-all-recent-prices')`. O handler existente equivalente é `sync-start-download` (`main.js:2106`).
- **Impacto**: `Error: No handler registered for 'sync-all-recent-prices'` se a UI usar os aliases.
- **Correção mínima**: apontar os aliases para `sync-start-download` ou registar o canal.

### PS-MAIN-20 — Baixo — `START_SIMULATION` sem default de `params`

- **Evidência (confirmado)**: `main.js:902-921` — `params.tickers` é acedido sem `params = params || {}`.
- **Impacto**: `TypeError` e rejeição do IPC se invocado sem payload.
- **Correção mínima**: `async (event, params = {}) =>`.

### PS-MAIN-21 — Baixo — `import:bulk` grava metadados antes de validar o ficheiro

- **Evidência (confirmado)**: `main.js:1382-1387` (`db.upsertStock`) executa antes de `parseFile` (`:1389`).
- **Impacto**: ativo/índice registado mesmo com ficheiro inválido; estado inconsistente na My List.
- **Correção mínima**: mover `upsertStock` para depois do `parseResult.ok`.

### PS-MAIN-22 — Baixo — `devTools` ativo em produção

- **Evidência (confirmado)**: `main.js:514` — `devTools: true` incondicional.
- **Impacto**: utilizador local pode inspecionar e executar código no renderer (ameaça local, não remota).
- **Correção mínima**: `devTools: !app.isPackaged`.

### PS-MAIN-23 — Baixo — `pythonBridge` sem limite de buffer e sem cleanup no quit

- **Evidência (confirmado)**: `src/services/pythonBridge.js:52-79` acumula `stdoutData`/`stderrData` sem limite; `main.js:2949-2957` (`before-quit`) termina workers e fecha DB mas não os processos Python filhos.
- **Impacto**: um Python verboso pode consumir memória; processos órfãos ao fechar a app.
- **Correção mínima**: cap de bytes (ex. 1 MB) com kill do processo, e registo dos filhos ativos para `kill('SIGKILL')` no `before-quit`.

### PS-MAIN-24 — Baixo — `prepare()` por chamada em hot path do DB

- **Evidência (confirmado)**: `src/db/database.js:424-436` (`insertSignal` compila o statement a cada INSERT) e `:456-469` (`cacheOHLCV` idem); chamados por cada linha/mensagem do worker em `main.js:151,180`.
- **Impacto**: overhead de compilação por vela/sinal durante scans e syncs.
- **Correção mínima**: hoist para `_prepareStatements()` (padrão já usado em `_stmtUpsertPrice`).

### Informativo / hipóteses refutadas

- **I-25 — SQL injection: refutado.** Todo o input externo usa placeholders (ex.: `main.js:1189-1194`, `:1272-1273`, `:1586-1588`, `:844-846`; `database.js:1084-1088`). Os placeholders `IN (…)` são gerados internamente (`tickerSymbols.map(() => '?')`), não interpolando dados.
- **I-26 — Command injection: refutado.** `src/services/pythonBridge.js:41-42` usa `spawn(pythonPath, args)` sem `shell`; `action` vem de um mapa fixo (`main.js:644-658`, default `run_full_pipeline`). O script Python não usa `subprocess`/`os.system` (`scripts/run_quant_pipeline.py`).
- **I-27 — Path traversal no temp `bulk-import`: refutado.** `main.js:1370-1372` — `path.extname(payload.fileName)` nunca contém separadores de path e o prefixo é fixo sob `os.tmpdir()`.
- **I-28 — Duplicação estrutural.** `src/main/main.js` (2795 linhas) e `src/ipc/ipcHandlers.js` (2795 linhas) parecem cópias paralelas do root `main.js` (que está modificado vs. HEAD, `git status`); risco de correções aplicadas no ficheiro errado. Não auditados nesta análise.
- **I-29 — `createProgressReporter` importado e não usado** (`main.js:13`), apesar de `src/utils/progressThrottle.js` implementar throttle testado.
- **I-30 — `webPreferences` base correta.** `contextIsolation:true`, `nodeIntegration:false`, `sandbox:true`, sem `webSecurity:false`, com preload mínimo e CSP em `renderer/index.html:5` (a postura base está boa; o problema é a ausência de guardas de navegação — PS-MAIN-03).

---

## Testes: cobertura existente e lacunas

Já coberto:
- `test/concurrency-sync.test.js` — limiter e orquestrador (mas só com `fetchOne` injectado; documenta explicitamente que as tasks não são envolvidas em `networkLimit`, `:276-297`); `test/sequential-sync.test.js`, `test/ipc-worker.test.js`, `test/preload-ipc.test.js` (canais permitidos/remoção), `test/importer.test.js`, `test/performance.test.js`.

Lacunas (testes que faltam):
1. Regressão de PS-MAIN-01: `syncTickersBatch` com `fetchMethod` que adquire `networkLimit` internamente (e equivalente em `sync-index-first-records`), com timeout de teste.
2. Validação de path em `import-historical-data`/`import:bulk` (path fora da allowlist deve falhar) — PS-MAIN-02.
3. Contrato de segurança da janela: `will-navigate`/`setWindowOpenHandler` bloqueados — PS-MAIN-03.
4. `RUN_MARKET_SCAN` não deve correr scan pesado no main (asserção de delegação a worker) — PS-MAIN-04.
5. `db:purgeInactive` com `daysCutoff` negativo/NaN/fora de limites — PS-MAIN-06.
6. Caps de tamanho/cardinalidade em `import:bulk`, `ticker:addBulk`, `scan:backtest` — PS-MAIN-07/08/12.
7. `START_SIMULATION`: limite de workers por invocação e propagação de erro (`success:false`) — PS-MAIN-11.
8. Validação/clamp de `params:set` e `ticker:search` — PS-MAIN-13/14.

---

## Riscos residuais

- **`undici` (transitivo, `npm audit` high)**: presente via `cheerio@1.2.0` (runtime) e `@electron/get`/`node-gyp` (build). O projeto usa `cheerio.load` sobre HTML já obtido por axios, não os caminhos de URL fetch, pelo que a exposição prática é baixa/indeterminada; a nulidade não foi verificada dinamicamente.
- **Cadeia PS-MAIN-02 + PS-MAIN-03**: enquanto ambas existirem, conteúdo remoto pode ler ficheiros locais e exfiltrar dados via erros/mensagens; a mitigação isolada de qualquer uma reduz drasticamente a exposição.
- **Duplicação `src/main/main.js` + `src/ipc/ipcHandlers.js`**: correções futuras podem não chegar ao entrypoint real ou vice-versa (não auditados).
- **Working tree sujo**: `main.js`, `renderer/renderer.js`, `src/db/database.js`, `src/ipc/ipcHandlers.js`, `src/main/main.js` têm alterações não commitadas; os números de linha referem-se ao estado atual.

## Limitações da auditoria

- Análise estática e revisão de código; não foi executada a app nem a suite de testes (a prova do deadlock é um repro mínimo do `p-limit`, não end-to-end).
- O renderer (`renderer/*`) e os duplicados `src/main/main.js`/`src/ipc/ipcHandlers.js` não foram auditados em profundidade; assume-se que o renderer é não confiável apenas após navegação/XSS.
- Impactos de performance estão classificados como confirmados quando decorrem de semântica de bloqueio (better-sqlite3 síncrono, CPU no main) e como suspeitos quanto à magnitude (sem profiling/heap).
- CVEs obtidos por `npm audit` no snapshot do registry; sem auditoria de licenças ou varredura SAST.
- Não foram testados fluxos com dados reais (base de dados de produção) nem limites de recursos do SO.

## Confirmação

Nenhum ficheiro de código-fonte foi alterado. Esta auditoria produziu apenas `reports/perfsec-main-process.md`.
