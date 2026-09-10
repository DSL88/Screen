# Auditoria PerfSec — Ponte IPC (`preload.js`)

**Papel:** Auditor sénior de segurança Electron e performance (`.opencode/agents/perfsec-preload-ipc.md`)
**Modo:** somente-leitura (nenhum ficheiro de código-fonte alterado)
**Data:** 2026-09-10
**Ficheiro de partida:** `preload.js` (227 linhas)
**Cruzamento:** `main.js` (2957 linhas), `renderer/renderer.js` (6122 linhas), `renderer/simulationRenderer.js`, `renderer/quantRenderer.js`, `renderer/quantTrackerRenderer.js`, `src/db/database.js`, `test/*`

---

## 1. Sumário executivo

| Severidade | Nº | IDs |
|---|---|---|
| Crítico | 0 | — |
| Alto | 3 | H1, H2, H3 |
| Médio | 6 | M1–M6 |
| Baixo | 6 | L1–L6 |
| Informativo | 3 | I1–I3 |
| **Total** | **18** | |

**Pontos positivos confirmados:** `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true` (`main.js:511-515`); o preload **não** expõe `ipcRenderer`, `require` ou `process`; a whitelist `ALLOWED_EVENTS` bloqueia subscrição arbitrária (`preload.js:198-205`) e existe teste unitário (`test/preload-ipc.test.js:29`); CSP restritiva sem `unsafe-inline` para scripts (`renderer/index.html:5-6`).

**Estado dos ficheiros duplicados (confirmação explícita):** ver secção 3. São cópias mortas idênticas entre si, **não usadas em runtime**, referenciadas apenas por um teste que as lê como texto.

---

## 2. Metodologia

1. Leitura integral de `preload.js` e de `main.js`.
2. Inventário mecânico de canais: `ipcRenderer.invoke/on` (preload) vs `ipcMain.handle` + `webContents.send`/`sender.send` (main) vs consumidores em `renderer/*.js`.
3. Diferenças e hashes dos ficheiros duplicados; verificação de referências (`rg`, `git log -S`, `git show`).
4. Inspeção das camadas de destino no main (`src/db/database.js`) para avaliar se a falta de validação no preload é mitigada.
5. Classificação: **Confirmado** (verificado no código) vs **Suspeita** (condicionada a vetor externo).

---

## 3. Estado dos duplicados `src/main/main.js` e `src/ipc/ipcHandlers.js` (CONFIRMADO)

- **São idênticos entre si:** ambos com SHA-256 `5a1beae4b491cf05c705b017a07fe5c00026aaa1` (0 linhas de diferença), 2795 linhas cada.
- **Não são o entry point:** `package.json:5` define `"main": "main.js"`. Nenhum `require()` no repositório aponta para eles (busca global sem resultados; exceto leitura textual por teste).
- **Estão desatualizados face ao `main.js` ativo:** 166 linhas de diferença; faltam-lhes o import `PythonBridge` (`main.js:16`) e **11 handlers**: `quant:run-full-pipeline`, `quant:run-phase`, `quant:save-tracked-asset`, `quant:evaluate-tracked`, `quant:get-tracker-metrics`, `quant:get-tracked-assets`, `quant:get-tracker-dashboard`, `execute-screener`, `save-tracked-recommendation`, `update-tracker-prices`, `fetch-tracker-data`. Diferença adicional: fallback de `START_SIMULATION` (`main.js:915` vs `src/main/main.js:768`).
- **Não seriam executáveis mesmo se chamados:** `src/main/main.js:6` faz `require('./src/db/database')` → resolveria `src/main/src/db/database` (inexistente); `src/main/main.js:509` usaria `src/main/preload.js` (inexistente). Idem `src/ipc/ipcHandlers.js`.
- **Único consumidor:** `test/first-record-choice.test.js:51-56` lê os três ficheiros como texto e faz `assert.ok(contents.includes("'sync-index-data-batch'"))`. O teste valida as cópias mortas, não o código executado → falsa confiança (ver M6).

---

## 4. Findings por severidade

### ALTO

#### H1 — Canal `sync-all-recent-prices` invocado pelo preload sem handler no main (regressão confirmada)
- **Estado:** Confirmado
- **Evidência:**
  - `preload.js:72-73` — `syncAllRecentPrices` e `syncAllListStocks` invocam `'sync-all-recent-prices'`.
  - `renderer/renderer.js:2483` — botão "Sync All" (`btnDownloadAllMylist`) chama `window.api.syncAllListStocks(null)`.
  - `main.js` — **não existe** `ipcMain.handle('sync-all-recent-prices')` (inventário completo de handlers confirma ausência).
  - Histórico: `git log -S 'sync-all-recent-prices'` → o handler existia até ao commit `aa70e10` ("Separar auditoria local e download incremental em 2 fases"), que o removeu (`git show aa70e10 -- main.js`: linhas `- ipcMain.handle('sync-all-recent-prices', ...)` e `- ipcMain.handle('sync-all-list-stocks', ...)`), mas o preload/renderer não foram atualizados.
- **Impacto:** o botão "Sync All" falha sempre com `Error: No handler registered for 'sync-all-recent-prices'`; é capturado em `renderer.js:2495` e mostrado como erro. Funcionalidade quebrada de forma silenciosa para o utilizador (só aparece no clique). Contrato de resposta antigo (`totalNewCandles`, `message`) também já não existe em `sync-start-download` (`main.js:2218-2224`).
- **Correção mínima:** ou reintegrar no main um handler que delegue para a pipeline atual (auditar → `sync-start-download`) devolvendo o contrato esperado pelo renderer, ou atualizar `preload.js:72-73` + `renderer.js:2475-2503` para usarem `syncStartDownload` + `onSyncRecentProgress` (fluxo de `handleSyncAllRecent`, `renderer.js:2632-2758`) e remover `syncAllListStocks`.
- **Teste em falta:** teste de contrato que extraia os canais invocados no preload e confirme `ipcMain.handle` correspondente no `main.js`.

#### H2 — Listener leak: `cleanupProgress` nunca é chamado em `handleSyncAllRecent`
- **Estado:** Confirmado
- **Evidência:**
  - `renderer/renderer.js:2704-2709` — cria `let cleanupProgress = null;` e atribui o unsubscribe de `onSyncRecentProgress(progressHandler)`.
  - `renderer/renderer.js:2746-2757` — bloco `finally` não chama `cleanupProgress()` (a variável nunca mais é referenciada; busca global só encontra as 3 linhas acima).
  - `renderer/renderer.js:2760-2766` — cada clique em "Mais Recente"/`btn-sync-recent` volta a executar a função.
  - `preload.js:87-91` — `onSyncRecentProgress` adiciona um listener novo em `SYNC_RECENT_PROGRESS` por chamada.
  - Já existe subscrição global do mesmo canal em `renderer.js:5253`, tornando a registo local redundante.
- **Impacto (performance):** cada clique acumula um listener permanente no renderer (memória + N callbacks `progressHandler` por cada evento `SYNC_RECENT_PROGRESS`); após N cliques há N atualizações DOM redundantes por evento de progresso, com degradação progressiva. Confirmado; independente da correção de H1.
- **Correção mínima:** remover as linhas `2695-2709` e usar só a subscrição global de `renderer.js:5253`; alternativamente guardar `cleanupProgress` e chamá-lo no `finally` (`renderer.js:2746`) e no handler de `sync-all-done` (`renderer.js:5255`).
- **Teste em falta:** teste de renderer que conte listeners de `SYNC_RECENT_PROGRESS` após 2 cliques consecutivos.

#### H3 — Preload exposto a qualquer página carregada; sem `will-navigate`/`setWindowOpenHandler`/validação de sender
- **Estado:** Confirmado o mecanismo; **Suspeita** a explorabilidade (não foi encontrado no código qualquer link/`window.open`/`location` que navegue para conteúdo remoto).
- **Evidência:**
  - `preload.js:223-225` — `contextBridge.exposeInMainWorld('api'|'electronAPI'|'quantAPI')` sem condição de origem. Preloads Electron correm em qualquer página carregada na `BrowserWindow`.
  - `main.js:500-518` — `createWindow()` não instala `webContents.setWindowOpenHandler` nem `will-navigate`/`will-redirect` (busca global: `NONE`).
  - `main.js` — nenhum handler valida `event.senderFrame` / URL de origem (busca global: `NONE`).
  - Capacidades expostas incluem operações destrutivas: `ticker:clear`, `trade:clear`, `trade:clearClosed`, `deleteIndexWithStocks`, `db:purgeInactive`, `updateStockMetadata`, `setParam`.
  - Mitigações presentes: CSP `script-src 'self'` (`renderer/index.html:5`), `sandbox: true`, `contextIsolation: true`.
- **Impacto:** se a janela navegar para uma página remota/comprometida (ex.: link externo futuro, injeção via `innerHTML`), essa página recebe a bridge completa com capacidades de destruição/alteração de dados locais. A cadeia H3 → M1 (paths arbitrários) permitiria ainda leitura de ficheiros locais.
- **Correção mínima:** em `createWindow()` (`main.js:518`): `mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))` e bloquear `will-navigate` exceto para `file://` da própria app; nos handlers, validar `event.senderFrame.url` contra o URL esperado.
- **Teste em falta:** teste que verifique a presença dos handlers de navegação e que rejeite `will-navigate` externo.

### MÉDIO

#### M1 — `filePath` arbitrário aceite do renderer no import de ficheiros
- **Estado:** Confirmado
- **Evidência:**
  - `preload.js:54` — `importBulk(data)` repassa o objeto inteiro (inclui `filePath`).
  - `preload.js:157` — `importHistoricalData(data)` repassa `filePath`.
  - `main.js:1366-1374` — usa `payload.filePath` diretamente e `parseFile(filePath)`.
  - `main.js:1451` — `import-historical-data` chama `parseFile(payload.filePath)` após validar apenas presença (`main.js:1441`).
  - Contraste: `import-historical-csv` (`main.js:1504-1519`) usa `dialog.showOpenDialog` no main — o padrão seguro já existe na app.
- **Impacto:** o renderer (ou página que herde a bridge em H3) pode instruir o main a abrir/parsear qualquer ficheiro do disco; mensagens de erro do parser podem vazar fragmentos de conteúdo e ficheiros grandes/comprometidos expõem o main (CPU/memória) via `parseFile`.
- **Correção mínima:** eliminar `filePath` do contrato do preload; escolher o ficheiro com `dialog.showOpenDialog` no main (`main.js:1509`) e passar apenas bytes ou um `token` devolvido pelo diálogo.
- **Teste em falta:** teste que garanta que nenhum handler de import lê `payload.filePath` sem validação contra a lista de caminhos escolhidos no diálogo.

#### M2 — Ausência de validação/normalização no preload e de validação de origem/limites no main
- **Estado:** Confirmado
- **Evidência:**
  - `preload.js:32-76` — nenhum wrapper valida tipo/formato/tamanho antes de `invoke`. Exemplos: `startScan(tickers, params)` (`:32`), `addTicker(t)` (`:36`), `setParam(key, value)` (`:43`), `syncIndexDataBatch(params)` (`:60`), `startSimulation(params)` (`:159`).
  - `main.js:1237-1241` — `params:set` aceita qualquer `payload.key`/valor e grava em `adaptive_params`; `src/db/database.js:417-422` não filtra a chave (parameterizado — sem SQLi, mas sem allowlist). `getAdaptiveParams` (`database.js:410-415`) espalha todas as chaves carregadas para o objeto de retorno.
  - `main.js:743-747` / `main.js:1008-1013` — `tickers` sem limite de quantidade nem validação de formato.
  - `main.js:1101-1102` — `limit` de `ticker:search` sem clamp (`Number`/teto).
  - `main.js:902,917` — `START_SIMULATION` acede `params.tickers` sem guard; chamar `startSimulation()` sem argumentos (`preload.js:159`) lança `TypeError` dentro do handler.
  - `main.js:1667-1673` — `mode` de `sync-index-data-batch` não é validado (valores desconhecidos percorrem a lista sem efeito útil).
  - `main.js` — nenhum `event.senderFrame` check (ver H3).
- **Impacto:** entradas malformadas/arbitrárias chegam ao main; poluição de `adaptive_params`, desperdício de recursos em arrays sem limite e erros IPC não normalizados. Em M2 não há injeção (queries parameterizadas confirmadas em `database.js:417-421,616-627,1332-1354,1399-1409`).
- **Correção mínima:** no preload, validar tipo/enum/comprimento e impor limites (ex.: `tickers.length <= 10000`); no main, allowlist de chaves de `params:set`, clamp de `limit`, `params = params || {}` em `START_SIMULATION` e validação de `mode`.
- **Teste em falta:** testes de fronteira (array vazio/gigante, `limit` negativo/infinito, `params:set` com chave desconhecida, `START_SIMULATION` sem args).

#### M3 — Payload binário `fileData` como array JS e sem limite de tamanho
- **Estado:** Confirmado
- **Evidência:**
  - `preload.js:54` — `importBulk(data)` transporta `fileData` (array de bytes).
  - `main.js:1369-1374` — `fs.writeFileSync(tmpPath, Buffer.from(payload.fileData))` sem qualquer limite.
- **Impacto (performance):** arrays de inteiros atravessam o structured clone com overhead de memória muito superior a binário tipado (ordem de ~8× por elemento), duplicando o ficheiro no renderer, no transporte e no main; ficheiros grandes bloqueiam o main durante a escrita.
- **Correção mínima:** enviar `ArrayBuffer`/`Uint8Array` em vez de array de números e impor limite (ex.: recusar > 50 MB) antes de `Buffer.from` (`main.js:1369`).
- **Teste em falta:** teste que confirme rejeição acima do limite e que o canal transporta `ArrayBuffer`.

#### M4 — `RUN_MARKET_SCAN` corre a pipeline no main e devolve todos os resultados num único `invoke`
- **Estado:** Confirmado
- **Evidência:**
  - `main.js:763-788` — loop `for` com `await scanStock(...)` por todos os ativos no main, seguido de `results.sort` e `return { success: true, results }`.
  - `preload.js:92` — `runMarketScan(indexFilter)` → `ipcRenderer.invoke('RUN_MARKET_SCAN', ...)`.
  - Existe caminho alternativo via worker: `main.js:743-760` (`scan:start` → `getScannerWorker()`), não usado pelo preload.
  - Adicionalmente, `scan:backtest` (`main.js:1015-1023`) pré-carrega `cachedCandles` de todos os tickers de forma síncrona no main antes de os duplicar para o worker (`main.js:1043-1052`).
- **Impacto (performance):** contenção prolongada do main process (UI congelada durante o varrimento), pico de memória na serialização e resposta IPC única com potencialmente milhares de resultados.
- **Correção mínima:** encaminhar `RUN_MARKET_SCAN` para o worker (`scan:start`) ou paginar a resposta/gravar em DB e devolver apenas progresso; limitar `cachedCandles` ao necessário.
- **Teste em falta:** teste de tempo/responsividade do main durante `RUN_MARKET_SCAN` com N elevado.

#### M5 — Três listeners independentes no mesmo canal `UPDATE_INDEX_DATE_PROGRESS`
- **Estado:** Confirmado
- **Evidência:**
  - `preload.js:116-120` — `onIndexDateProgress` → `UPDATE_INDEX_DATE_PROGRESS`.
  - `preload.js:132-136` — `onIndexFirstDateProgress` → `UPDATE_INDEX_DATE_PROGRESS`.
  - `preload.js:151-155` — `onFirstDateProgress` → `UPDATE_INDEX_DATE_PROGRESS`.
  - `renderer.js:5556-5590`, `renderer.js:5535-5554`, `renderer.js:5508-5533` — os três wrappers são subscritos no arranque.
- **Impacto (performance/consistência):** cada emissão de `UPDATE_INDEX_DATE_PROGRESS` (`main.js:2663`, `2699`, `2711`) invoca 3 callbacks que escrevem nos mesmos elementos (`indexBulkProgressLabel`, `indexBulkProgressFill`, `status`, pills do card) — trabalho e mutações DOM duplicados, com o resultado final dependente da ordem de registo.
- **Correção mínima:** usar um canal distinto por operação no main (`index-date-progress`, `index-first-date-progress`) ou expor um único método no preload para este canal.
- **Teste em falta:** teste que verifique 1:1 entre canal emitido e handler de UI.

#### M6 — Cópias mortas duplicadas validadas por teste (falsa confiança)
- **Estado:** Confirmado
- **Evidência:**
  - `src/main/main.js` e `src/ipc/ipcHandlers.js`: SHA idêntico `5a1beae4...` (2795 linhas), desatualizados face a `main.js` (ver secção 3).
  - `test/first-record-choice.test.js:51-56` — assere conteúdo destas cópias mortas (e de `main.js`) como se fossem pontos de entrada válidos.
  - `package.json:5` — entry point real é `main.js`.
- **Impacto:** um teste verde pode não garantir nada sobre o código executado; alterações futuras no `main.js` (ou regressões como H1) não são detetadas, e as cópias divergem silenciosamente.
- **Correção mínima:** apagar as duas cópias e restringir o teste a `main.js:54`; ou marcar explicitamente como arquivo morto e remover as asserções.
- **Teste em falta:** não aplicável (a correção é remover a cobertura de ficheiros mortos).

### BAIXO

#### L1 — Entradas mortas na whitelist `ALLOWED_EVENTS`
- **Estado:** Confirmado
- **Evidência:** `preload.js:16` (`sync-all-progress`), `preload.js:19` (`first-date-fetch-progress`), `preload.js:20` (`index-first-date-progress`), `preload.js:21` (`index-date-progress`) — nenhuma é emitida pelo `main.js` (busca global: 0 ocorrências). Nota: `renderer.js:5252` subscreve `sync-all-progress` e o teste `test/ui-contract.test.js:22` assere essa subscrição, perpetuando a entrada morta.
- **Impacto:** superfície exposta desnecessária e contrato enganador para os consumidores.
- **Correção mínima:** remover as 4 entradas de `preload.js:3-29` e ajustar `renderer.js:5252`/teste.
- **Teste em falta:** teste que gere a whitelist a partir dos canais efetivamente emitidos pelo main.

#### L2 — `onSyncProgressUpdate` registado fora do mecanismo de unsubscribe
- **Estado:** Confirmado
- **Evidência:** `renderer.js:5056-5070` — `apiInstance.onSyncProgressUpdate((data) => {...})` sem guardar/registar o retorno; os restantes registos usam `subscribeApiEvent` (`renderer.js:305-314`) e drenam em `beforeunload` (`renderer.js:5616`).
- **Impacto:** o cleanup é descartado; hoje regista uma vez por arranque, mas é um ponto frágil se o bloco for extraído para função reexecutável.
- **Correção mínima:** substituir por `subscribeApiEvent('onSyncProgressUpdate', null, handler)`.
- **Teste em falta:** contagem de listeners após reload simulado.

#### L3 — `on` genérico não valida `callback` nem protege exceções
- **Estado:** Confirmado
- **Evidência:** `preload.js:198-205` — verifica o canal, mas chama `callback(payload)` sem `typeof callback === 'function'` nem `try/catch`.
- **Impacto:** `window.api.on('scan:progress', null)` provoca `TypeError` não tratado no renderer; erros do consumidor propagam-se no emitter do IPC.
- **Correção mínima:** em `preload.js:199`, lançar erro claro se `typeof callback !== 'function'`; envolver a invocação em `try/catch` (ou documentar que o erro é do consumidor).
- **Teste em falta:** `assert.throws` para callback não-função e teste de exceção do consumidor.

#### L4 — `devTools: true` sempre ativo
- **Estado:** Confirmado
- **Evidência:** `main.js:514` (e cópias mortas `src/main/main.js:513`).
- **Impacto:** em builds de produção expõe ferramentas que facilitam inspeção/manipulação da bridge e dos dados.
- **Correção mínima:** `devTools: !app.isPackaged`.
- **Teste em falta:** verificação em build empacotada.

#### L5 — Aliases duplicados e superfície de API inconsistente
- **Estado:** Confirmado
- **Evidência:** `preload.js:72-73` (`syncAllRecentPrices`/`syncAllListStocks` para o mesmo canal); `preload.js:106-108` e `:115` (4 nomes para `UPDATE_INDEX_FIRST_DATES`); `preload.js:209-210` (`runScreener`/`executeScreener`); `preload.js:191-193` etc. Há handlers no main sem invoke no preload: `quant:save-tracked-asset` (`main.js:667`), `quant:evaluate-tracked` (`main.js:685`), `quant:get-tracker-dashboard` (`main.js:721`) — o preload usa canais diferentes (`preload.js:190,192,196`).
- **Impacto:** manutenção difícil e risco de divergência (é exatamente o padrão que originou H1).
- **Correção mínima:** consolidar em um nome por canal e remover aliases não consumidos.
- **Teste em falta:** snapshot do contrato preload↔main.

#### L6 — `state.unsubscribers` do `simulationRenderer.js` nunca é drenado
- **Estado:** Confirmado
- **Evidência:** `renderer/simulationRenderer.js:196-207` acumula unsubscribers; `simulationRenderer.js:62` chama `bindApiEvents()` uma única vez; busca global não encontra `splice`/reutilização do array.
- **Impacto:** cleanup descartado (sem crescimento atual, por ser registo único); se `bindApiEvents` for reexecutado no futuro (ex.: remount de UI), cria listeners duplicados.
- **Correção mínima:** adicionar `window.addEventListener('beforeunload', () => state.unsubscribers.splice(0).forEach(fn => fn()))` ou integrar no mecanismo do `renderer.js`.
- **Teste em falta:** teste que conte listeners de simulação após remount.

### INFORMATIVO

#### I1 — `getStockDetails` pode transportar objeto em vez de string
- **Evidência:** `preload.js:57` — `typeof ticker === 'string' ? ticker : (ticker?.ticker || ticker)`; se for objeto sem `.ticker`, o objeto é enviado. `main.js:1601-1605` normaliza e devolve erro — sem impacto prático.
- **Correção mínima:** `String(ticker?.ticker ?? ticker ?? '')`.
- **Teste em falta:** payload com objeto sem `ticker`.

#### I2 — N+1 queries em `ticker:list`
- **Evidência:** `main.js:1200-1222` — `db.getStockByTicker(symbolUpper)` dentro do `map` para cada ticker (além do `IN (...)` em `main.js:1189-1194`). Consumido por `listTickers` (`preload.js:40`) e frequentemente revalidado pela UI após operações.
- **Impacto (performance):** O(N) queries síncronas por chamada, agravado em listas grandes.
- **Correção mínima:** uma query agregada com `LEFT JOIN` a `stocks` para trazer `country`/`index_name`/`first_date`.
- **Teste em falta:** teste de performance com 5k tickers.

#### I3 — `get-stock-dividends` não normaliza o ticker no main
- **Evidência:** `preload.js:58` envia o ticker cru; `main.js:1634-1642` extrai `payload.ticker` ou `payload` sem `toUpperCase`/`trim` (ao contrário de `download-stock-dividends`, `main.js:1646`). O DB normaliza internamente (`database.js:2290`), pelo que não há bug — apenas inconsistência.
- **Correção mínima:** normalizar no handler por simetria.
- **Teste em falta:** chamada com minúsculas/espaços.

---

## 5. Cobertura cruzada preload ↔ main ↔ renderer

**Invokes sem handler (1):** `sync-all-recent-prices` (H1).

**Handlers sem invoke no preload (3):** `quant:save-tracked-asset`, `quant:evaluate-tracked`, `quant:get-tracker-dashboard` (L5).

**Eventos na whitelist nunca emitidos (4):** `sync-all-progress`, `first-date-fetch-progress`, `index-first-date-progress`, `index-date-progress` (L1).

**Canais `send` do main consumidos genericamente via `api.on`:** `scan:progress`, `scan:row`, `scan:done`, `scan:error`, `ticker:synced`, `import-success`, `scanner-sync-status`, `sync-all-done`, `sync-all-progress`* — todos presentes em `ALLOWED_EVENTS`; `*` nunca emitido.

**Métodos preload sem utilização no renderer (43):** inclui `cancelIndexOperation`, `downloadIndexFullHistory`, `executeScreener`, `runQuantFullPipeline`, `simulationStart`, `onIndexOperationProgress`, etc. Não é defeito por si (API de módulos), mas alimenta a inconsistência de L5.

**Métodos usados sem existir no preload:** nenhum (0) — todos os `window.api.*`/`window.electronAPI.*`/`window.quantAPI.*` usados em `renderer/*.js` existem.

---

## 6. Testes em falta (priorizados)

1. **Contrato preload↔main** (previne H1): extrair canais de `ipcRenderer.invoke` do preload e asserir `ipcMain.handle` correspondente no `main.js` (o `main.js` pode ser carregado com mock de `electron` para registar os handlers, como `test/preload-ipc.test.js` faz com o preload).
2. **Leak de listeners** (H2): contar listeners de `SYNC_RECENT_PROGRESS` após 2 cliques em "Mais Recente".
3. **Hardening de navegação** (H3): asserir `setWindowOpenHandler`/`will-navigate` e rejeição de origem externa.
4. **Import** (M1/M3): rejeitar `filePath` vindo do renderer; rejeitar `fileData` acima do limite.
5. **Validação** (M2): `params:set` com chave desconhecida; `START_SIMULATION` sem args; `limit` fora de intervalo.
6. **Whitelist** (L1): derivar `ALLOWED_EVENTS` dos canais efetivamente emitidos.

---

## 7. Riscos residuais

- A explorabilidade de H3 depende de obter um vetor de navegação/injeção; hoje não foi encontrado nenhum no código analisado, e a CSP `script-src 'self'` dificulta XSS inline. Continua a ser a lacuna de hardening mais relevante.
- M1 (paths) e M3 (payload) só têm impacto prático combinados com H3 ou com código de renderer já comprometido — as mitigações `sandbox`/`contextIsolation`/CSP reduzem, mas não eliminam, esse cenário.
- A remoção dos duplicados (M6) deve atualizar `test/first-record-choice.test.js:51-56`, ou o teste falhará.

## 8. Limitações

- Análise estática; não foi executada a app, não foram medidos tempos reais nem memória (estimativas qualitativas).
- Não foram auditados exaustivamente os canais de saída para o worker (`scanner.worker.js`, `simulationWorker.js`) nem o bridge Python (`pythonBridge.js`), fora do âmbito preload/IPC.
- O `renderer/renderer.js` (6122 linhas) foi analisado por inventário e amostragem dirigida (consumidores de IPC, listeners, botões), não linha a linha; pode haver consumidores não detetados.
- O estado de trabalho tem alterações não commitadas em `main.js`/`renderer.js`/`database.js`/duplicados; o relatório reflete o working tree no momento da auditoria (`305d453` + alterações locais).
- Ficheiros gerados/binários e `node_modules` foram excluídos.
