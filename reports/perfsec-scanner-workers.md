# Auditoria PerfSec — Scanner e Workers

**Âmbito:** `src/engine/scanner.worker.js`, `src/engine/scanner.js`, `src/scanner.js`, `src/engine/signalPool.js`, `src/engine/signalWorker.js` e respetivo spawn no main.
**Modo:** somente-leitura (nenhum ficheiro de código alterado).
**Data:** 2026-09-10 · Working tree com alterações não commitadas em `main.js`, `src/main/main.js`, `src/ipc/ipcHandlers.js`, `src/db/database.js`.

---

## 0. Qual scanner é realmente usado (mapa de chamadas)

| Componente | Usado em produção? | Evidência |
|---|---|---|
| `src/engine/scanner.worker.js` | **Sim** — `scan:start`, `scan:backtest`, `trade:update` | `main.js:124,743-760,1008-1054,1059-1095` |
| `src/scanner.js` (`scanStock`) | **Sim** — canal legado `RUN_MARKET_SCAN` | `main.js:15,763-788` |
| `src/engine/scanner.js` (classe `Scanner`) | **Não** — só testes | `test/scanner.test.js:8` (única referência no repo) |
| `src/engine/signalPool.js` + `signalWorker.js` | **Sim** — motor Workstation | `src/engine/workstationEngine.js:25,320` |
| `src/main/main.js`, `src/ipc/ipcHandlers.js` | **Não** — cópias congeladas do `main.js` | `package.json` (`"main": "main.js"`); paths relativos partidos |

Conclusão: o caminho ativo de scan é `main.js` → `scanner.worker.js` → DB no main. A classe `src/engine/scanner.js` é **código morto em produção** (apenas coberto pelos testes), e `src/scanner.js` é um **terceiro pipeline** paralelo que corre no main thread.

---

## 1. Resumo de findings

| Severidade | Nº |
|---|---|
| Crítico | 1 |
| Alto | 3 |
| Médio | 8 |
| Baixo | 7 |
| Informativo | 4 |
| **Total** | **23** |

| Categoria | Findings |
|---|---|
| Concorrência / starvation | C1, A1, A2, M2, M7, B2, B7 |
| Backpressure / mensagens | A1, M1, M3, M7 |
| SQL | M1, B3, B4, B5 |
| Memória | A1, M1, M3, M6, M7, B1, B2 |
| Validação de payloads | A3, M4, M5, B3 |

---

## 2. Crítico

### C1 — `RUN_MARKET_SCAN` bloqueia o main process com scan serial
**Confiança:** Confirmado.
**Evidência:** `main.js:763-788` (`for` com `await scanStock(...)` no handler IPC) + `src/scanner.js:20-156` (SQLite síncrono + Monte Carlo nativo 1000×35 por ativo, `src/scanner.js:103-131`); `main.js:15`.
**Impacto:** a análise de todo o universo (~centenas de ativos) corre no main thread do Electron. Cada `analyzeSeries`/`runMonteCarlo` é síncrono; o event loop fica bloqueado → UI congelada, IPC parado, timeouts de renderer. Ignora por completo o worker criado para este fim.
**Correção mínima:** substituir o loop por delegação ao `scannerWorker` (reutilizar `scan:start` com os tickers do índice) ou, no mínimo, fatiar em `setImmediate`/`await new Promise(r => setImmediate(r))` a cada N ativos; remover o caminho legado `scanStock` quando o worker cobrir o caso.

---

## 3. Alto

### A1 — Múltiplos scans concorrentes sem single-flight; progresso/rows intercalados
**Confiança:** Confirmado.
**Evidência:** `main.js:743-760` (não existe guarda de run ativo; cada invocação faz `postMessage({action:'scan'})`); `src/engine/scanner.worker.js:49-82` (cada mensagem lança `handleScan` concorrente; `pLimit(5)` é criado por run, `scanner.worker.js:174`); `renderer/renderer.js:2885-2950` (não filtra eventos por `runId`; o primeiro `done` faz `setRunning(false)` e `activeScanRunId = null`).
**Impacto:** dois cliques em "Analisar" criam N×5 tarefas concorrentes no mesmo worker e no main; progresso de um run pisa o do outro; o `done` do run A termina a UI do run B. `scan:cancel` cancela apenas um `runId`, deixando o resto do trabalho a correr.
**Correção mínima:** guarda de run único no main (`if (activeScanRunId) return {ok:false,error:'scan-in-progress'}`), limpar no `done`/`error`; no renderer, ignorar eventos cujo `payload.runId !== activeScanRunId`.

### A2 — Paralelismo de CPU do scan limitado a 1 worker thread; `pLimit(5)` só sobrepõe I/O
**Confiança:** Confirmado.
**Evidência:** `src/engine/scanner.worker.js:17,174,248` (1 worker, `CONCURRENCY = 5`); `signalPool.js:23-26` mostra o padrão correto (`os.cpus().length - 1`); nenhum uso de `os.cpus()` no scanner.
**Impacto:** `analyzeSeries` é síncrono; dentro de um worker thread as 5 tarefas do `pLimit` não executam CPU em paralelo — apenas sobrepõem os round-trips `requestDB` para o main (que são, eles próprios, servidos em série pelo main). O scan usa ~1 core para análise, num universo potencialmente grande; o `signalPool` já demonstra o desenho esperado (sharding por worker).
**Correção mínima:** fatiar a lista de tickers por `os.cpus().length - 1` e criar N workers de scan (reutilizar infraestrutura do `signalPool`), ou mover o scan para o padrão `signalWorker` (shard + agregação no main).

### A3 — Crash/exit do worker não falha operações pendentes (UI pendurada até 10 min)
**Confiança:** Confirmado.
**Evidência:** `main.js:300-310` (`error`/`exit` apenas logam e anulam `scannerWorker`, sem notificar `scan:error`/`done`); `main.js:1027-1054` (backtest resolve só por `backtestResult`, timeout 600 000 ms); `main.js:1065-1095` (trade update, timeout 120 000 ms).
**Impacto:** se o worker morrer durante um scan, o renderer nunca recebe `scan:done` e fica "running" indefinidamente; se morrer durante um backtest, o handler demora 10 minutos a resolver. Nenhum estado de erro é propagado ao utilizador.
**Correção mínima:** manter um registo de operações em curso (`Map` requestId/runId → resolve/reject) e, em `exit`/`error`, rejeitar todas com `worker-unavailable` e emitir `scan:error`/`scan:done` com `status:'failed'`.

---

## 4. Médio

### M1 — Backpressure de mensagens: `cacheOHLCV` por ticker com arrays completos + writes síncronos no main
**Confiança:** Confirmado.
**Evidência:** `scanner.worker.js:192` (envia todas as velas do ticker ao main logo após a leitura); `main.js:177-182` (`db.cacheOHLCV`); `database.js:456-469` (INSERT por vela dentro de transação, síncrono); leitura em `database.js:471-481` só é usada pelo backtest (`main.js:1015-1023`).
**Impacto:** cada scan duplica o volume de candles (DB→worker→DB) e escreve milhares de linhas em `ohlcv_cache` no main enquanto o scan decorre; better-sqlite3 é síncrono → jank da UI. O scan nem sequer lê `ohlcv_cache` (lê `historical_prices`), pelo que o custo é só de "aquecimento" do backtest.
**Correção mínima:** remover o `cacheOHLCV` do caminho de scan ou batchá-lo num único write no fim; alternativamente, escrever no worker com conexão SQLite própria (readwrite WAL) e não devolver as velas.

### M2 — Cancelamento não interrompe trabalho em curso; backtest ignora cancel no loop interno
**Confiança:** Confirmado.
**Evidência:** `scanner.worker.js:182` (check apenas no início da tarefa), `scanner.worker.js:353` (`await Promise.all` espera tudo), `scanner.worker.js:399-400` (check só por ticker no backtest), `scanner.worker.js:416-475` (loop de milhares de barras sem check); `src/engine/scanner.js:100` (mesmo padrão).
**Impacto:** após `scan:cancel`, o worker continua a analisar as tarefas em voo e todos os tickers enfileirados no `pLimit`; um backtest longo só para no fim do ticker corrente (pode ser minutos). A UI reporta cancelamento, mas CPU continua ocupada (starvation do próximo run).
**Correção mínima:** verificar `cancelRequested` dentro do loop de barras do backtest e antes de cada análise; abortar com `AbortController`/flag e resolver o `Promise.all` com `Promise.allSettled` (ou rejeitar tarefas pendentes) para libertar o `pLimit`.

### M3 — Buffer de sinais acumulado até ao fim do scan; rows e inserts adiados
**Confiança:** Confirmado.
**Evidência:** `scanner.worker.js:177` (`signalsToSend = []`), `scanner.worker.js:300-346` (push), `scanner.worker.js:363-366` (envio em bloco após `Promise.all`).
**Impacto:** memória O(nº de sinais) no worker; o renderer/DB só recebem linhas no fim (sem feedback incremental de sinais); um crash a meio perde todos os sinais já calculados.
**Correção mínima:** enviar `row` no momento da emissão (ou em lotes de ~50) e manter no main o INSERT; não acumular no worker.

### M4 — `trade:update` sem correlação de pedido: chamadas concorrentes cruzam respostas
**Confiança:** Confirmado.
**Evidência:** `main.js:1072-1075` (handler resolve no primeiro `updateResult`, sem `requestId`); `scanner.worker.js:635-647` (resposta não inclui identificador de pedido); contraste com o backtest, que filtra por `requestId` (`main.js:1035`).
**Impacto:** dois `trade:update` simultâneos (ex.: polling + clique) resolvem ambos com a primeira resposta; podem fechar trades com dados de outro ciclo ou devolver `updated` errado.
**Correção mínima:** adicionar `requestId` ao protocolo `updateTrades` (main.js:1093 e scanner.worker.js:635) e filtrar no handler.

### M5 — Validação de payloads ausente/assimétrica (params numéricos, tickers, timeframe)
**Confiança:** Confirmado (caso base) / Suspeita (erro SQL com NaN).
**Evidência:** `main.js:462-486` (`Number(...)` sem `Number.isFinite` nem ranges; `timeframe` livre); `scanner.worker.js:173` (`tickers` não validados), `scanner.worker.js:214` (`params.markov_window`) e `scanner.worker.js:387` (`params.markov_window` **fora de qualquer try**); `main.js:1027-1054` (sem `backtestResult` → espera 10 min).
**Impacto:** `params`/tickers malformados originam: `LIMIT NaN`/valores não inteiros em SQL (erro por ticker, suspeita), análise com janelas absurdas/infinitas, ou (no backtest) uma exceção que impede a resposta e pendura o IPC até ao timeout de 10 min. Não há injeção (queries parametrizadas), mas há negação de serviço local via renderer.
**Correção mínima:** validar na fronteira IPC (`resolveParams`) com `Number.isFinite`, `> 0` e clamps (ex.: `markov_window` 60–500, `horizon_days` 1–60) e `timeframe` contra allowlist; no worker, `params = params || {}` e validar `t.ticker` como string não vazia antes de qualquer acesso.

### M6 — Backtest O(n²) em cópias e duplicação de histórico em memória
**Confiança:** Confirmado.
**Evidência:** `scanner.worker.js:421` (`candles.slice(0, i + 1)` por barra), `scanner.worker.js:462-476` (`simulatedTrades` acumulado), `scanner.worker.js:403-412` (`cachedCandles` + `cacheUpdates` mantêm o mesmo histórico), `main.js:1015-1023` (pré-carrega e envia `cachedCandles` inteiro), `scanner.worker.js:525-528` (resposta com todas as trades).
**Impacto:** para 5 000 barras, ~4 800 slices crescentes (pressão de GC e cópias O(n²)); o histórico é clonado main→worker e retido em duas estruturas; a resposta de backtest pode ser enorme.
**Correção mínima:** usar uma única vista/índice (passar `candles` + `endIndex` a `analyzeSeries`, evitando `slice`), libertar `cacheUpdates`/`cachedCandles` após uso e paginar/limitar as `trades` devolvidas.

### M7 — `signalPool`: workers recriados por chamada, timeout+fallback duplica trabalho, workers órfãos
**Confiança:** Confirmado.
**Evidência:** `signalPool.js:61-72` (novo `Worker` por chamada, timeout fixo 120 s), `signalPool.js:74-82` (`Promise.all`; no `catch`, fallback serial imediato), `signalPool.js:58-59` (shard round-robin sem balanceamento por carga), `signalWorker.js:40` (resultado integral num único `postMessage`).
**Impacto:** (a) sem reutilização de pool, cada simulação paga spawn + clonagem; (b) se um worker falhar, o `catch` corre o trabalho **todo** de novo em serial enquanto os restantes workers continuam vivos — CPU 2× e workers órfãos até 120 s; (c) ativos com históricos muito diferentes desequilibram os shards; (d) cancelamento da simulação não chega aos workers.
**Correção mínima:** terminar os restantes workers no `catch`/timeout (`w.terminate()` em todos), só fazer fallback após terminar; suportar `AbortSignal`; distribuir por chunks de carga (nº de candles × datas) em vez de round-robin.

### M8 — Estatísticas finais do scan incorretas (falhas e cancelamentos)
**Confiança:** Confirmado.
**Evidência:** `scanner.worker.js:356-357` (`failedCount = list.length - processed`; `successRate = (processed - failedCount)/list.length`); `processed++` ocorre antes do trabalho (`scanner.worker.js:183`).
**Impacto:** tickers com dados insuficientes/erro não contam como falha (já foram "processados"), e cancelados contam como falhas; `successRate` é enganadora e o `done` alimenta o resumo da UI com números errados.
**Correção mínima:** incrementar `failed` explicitamente nos `catch`/returns precoces e definir `successRate = (total - failed) / total`.

---

## 5. Baixo

### B1 — Timers de `requestDB` nunca são limpos
`scanner.worker.js:40-45`: cada pedido cria um `setTimeout(30s)` que permanece na fila de timers mesmo após resolução (a callback apenas verifica e não faz nada). Durante um scan de centenas de tickers acumulam-se centenas/milhares de timers vivos. **Correção:** guardar o handle no `Map` e `clearTimeout` no `resolve`/`reject`.

### B2 — Sets de cancelamento crescem indefinidamente
`scanner.worker.js:19,76` (`cancelRequested.add` sem `delete`); `src/engine/scanner.js:25-30` (`this.cancelled`). Cada run/cancel deixa uma entrada permanente. **Correção:** `cancelRequested.delete(runId)` no fim de `handleScan`/`handleBacktest` ou usar `Map` com TTL.

### B3 — Normalização de ticker inconsistente entre caminhos
`database.js:913-920` (`getLocalHistoricalPricesLimit` usa o ticker cru, comparação sensível a maiúsculas) vs `database.js:936-944` (`getHistoricalPricesForScan` aplica `canonicalTicker`). Um ticker em minúsculas/espaços vindo do renderer devolve "sem dados" no worker mas funciona no `scanStock`. **Correção:** aplicar `canonicalTicker(ticker)` dentro de `getLocalHistoricalPricesLimit` (e `getTickerDataRange`).

### B4 — Índices e métodos SQL duplicados
`database.js:134-137`: quatro índices equivalentes em `historical_prices(ticker, date)` (`idx_hist_prices_ticker_date`, `idx_hist_ticker_date`, `idx_historical_prices_ticker_date_asc`, `idx_hist_ticker_date_desc`); `database.js:890-934`: `getLocalHistoricalPrices` e `getLocalHistoricalPricesLimit` têm corpos idênticos. Custo de escrita/espaço e risco de divergência. **Correção:** manter um índice e um método (com `limit` opcional).

### B5 — `getCachedOHLCV` depende de `datetime(fetched_at)` sem índice
`database.js:471-481`: o filtro por idade usa função sobre coluna (sem índice em `fetched_at`), impedindo otimização; usado só pelo backtest. **Correção:** filtrar por `fetched_at >= ?` com timestamp ISO calculado em JS, ou índice dedicado.

### B6 — Protocolo morto `saveHistoricalCandles`
`main.js:249-267` implementa `saveHistoricalCandles`, mas o worker nunca envia esse tipo de pedido (só `getLastStoredDate`, `getLocalHistoricalPrices`, `getLocalHistoricalPricesLimit`, `getTickerDataRange` — `scanner.worker.js:184-288`). **Correção:** remover o handler ou documentá-lo como reservado.

### B7 — `networkLimit` é por processo: limite global de rede pode ser excedido
`yahooClient.js:26` cria `pLimit(5)` no módulo; o main tem o seu, mas o `scanner.worker` que faz `fetchWithRetry` no backtest (`scanner.worker.js:406`) e no `updateTrades` (`scanner.worker.js:550`) cria uma **segunda** pool de 5 → até 10 pedidos simultâneos ao Yahoo, contornando o rate limit primário. **Correção:** não fazer fetch no worker (ler DB) ou centralizar os pedidos no main via request-response.

---

## 6. Informativo

### I1 — Duplicação massiva do main process (risco de auditoria/edição)
`src/main/main.js` e `src/ipc/ipcHandlers.js` são cópias do `main.js` com paths relativos partidos (`require('./src/scanner')`, `path.join(__dirname,'src/engine/scanner.worker.js')` → resolvem para `src/main/src/...`), e ambos estão a ser editados em paralelo (`git status` mostra os três modificados). O `main.js` root tem secções que as cópias não têm (`PythonBridge` em `main.js:16`, pipeline QUANT). Nenhuma das cópias é entrypoint (`package.json: "main": "main.js"`). **Risco:** correções aplicadas ao ficheiro errado; auditorias futuras sobre código morto.

### I2 — `src/engine/scanner.js` é código morto em produção
Única referência: `test/scanner.test.js:8`. Duplica a lógica de `scanner.worker.js` (`_pickAnalysisCandles`, `_calcDistancia`, `_classifyPosition`, `_tuneAdaptiveParams`) e diverge: mínimo 60 velas (`scanner.js:108,120`) vs 200 no worker (`scanner.worker.js:18,214`), sem `rvolMin`/`useRvolGate` em `_resolveParams` (`scanner.js:39-62`), `updateActiveTrades` lê DB (`scanner.js:458`) enquanto o worker faz fetch (`scanner.worker.js:550`). O `resolveParams` está triplicado (`main.js:462-486`, `scanner.js:39-62`, e o tuning em `main.js:409-457` vs `scanner.js:370-412`).

### I3 — `src/scanner.js` é um terceiro pipeline de scan
`src/scanner.js:20-156` reimplementa VWAP/RVOL/Markov/MC com regras próprias (`winRateMC >= 50`, SL 2.4%/TP 4.8%/35d) usadas apenas por `RUN_MARKET_SCAN`. Resultados não comparáveis com o worker (sem `useVolFilter`, sem RVOL gate configurável, sem persistência em `historical_signals`).

### I4 — Lacunas de teste
`test/scanner.test.js` testa a classe morta com stubs de `markovEngine`/`monteCarloEngine`; o teste de concorrência só verifica consultas síncronas ao mock (não mede concorrência real de CPU). `test/ipc-worker.test.js` cobre apenas scan vazio e cancel antes do dispatch. **Sem cobertura:** multi-scan concorrente, cancel mid-flight, crash/exit do worker, timeout de `requestDB`, validação de payloads (`NaN`/params nulos), backtest e `updateTrades` (incl. correlação `requestId`), `signalPool` paralelo vs serial (equivalência e falhas), órfãos no fallback. `test/workstation-worker.test.js` cobre apenas o resultado do `simulationWorker`.

---

## 7. SQL

- **Injeção:** não confirmada nos caminhos auditados — todas as queries do scan/DB wrapper são parametrizadas (`database.js:413-421,425-435,891-920,937-953,1025-1034`). Não há SQL dinâmico construído com tickers/params.
- **Índices:** `historical_prices(ticker,date)` tem cobertura redundante mas suficiente (`database.js:134-137`); `getTickerDataRange` (`database.js:1024-1037`) filtra por ticker com `GROUP BY` sobre índice; `ohlcv_cache` tem PK `(ticker,date)` (`database.js:111-121`), o filtro por `fetched_at` não é indexado (B5).
- **Sem `LIMIT`:** `getLocalHistoricalPrices` default 300 (`database.js:890`, chamado com 300 em `scanner.js:458` e com 5000 no backtest `scanner.js:575`); `getHistoricalPricesForScan` limita a 300 (`database.js:936-953`). O backtest da classe pede 5000 linhas por ativo — correto mas pesado no main (C1).
- **Normalização:** B3.

## 8. Memória

- Buffer de sinais (M3), `cachedCandles`+`cacheUpdates` (M6), `signalsToSend` e `simulatedTrades` sem limites explícitos.
- Timers de `requestDB` (B1) e Sets de cancelamento (B2) crescem monotonicamente.
- `dbRequests` é limpo corretamente em respostas/timeouts (`scanner.worker.js:52-60,40-44`).
- Não há uso de `transferList` em lado nenhum (`postMessage` sempre por structured clone): candles são copiados DB→worker e worker→main (`scanner.worker.js:33,192,408`), e `signalPool` clona candles+`fundamentalData` para cada worker (`signalPool.js:67`).

## 9. Riscos residuais e limitações

1. **Análise estática** — não houve execução/profiling; afirmações de custo são baseadas em complexidade e no caráter síncrono de `better-sqlite3`/`analyzeSeries`/MC nativo. O comportamento de `better-sqlite3` com `LIMIT NaN` (M5) é **suspeita**, não confirmada.
2. **Superfície do renderer** — assume-se renderer semi-confiável (contextIsolation/sandbox ativos, `main.js:509-515`); com renderer comprometido, a ausência de validação (M5) e a ausência de single-flight (A1) permitem DoS local.
3. **Fora de âmbito** — `markovEngine.js`, `monteCarloEngine.js`, `native/`, `simulationWorker.js` e os restantes handlers do `main.js` não foram auditados em profundidade.
4. **Working tree suja** — números de linha referem-se ao estado atual (não commitado) de `main.js`/`src/db/database.js`; os ficheiros duplicados `src/main/main.js`/`src/ipc/ipcHandlers.js` podem divergir após edições.
5. Testes não executados (papel somente-leitura); conclusões de cobertura baseadas na leitura dos ficheiros.
