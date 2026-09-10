# Relatório PerfSec — Fontes de Dados de Mercado (Yahoo Finance / Stooq)

- **Data:** 2026-09-10
- **Âmbito:** `src/data/yahooClient.js` (1277 linhas), `src/services/yahooClient.js` (1271 linhas), `src/services/marketDataService.js` (384 linhas); cruzado com `main.js` (entrypoint real — `package.json:5`), `src/engine/scanner.worker.js`, `src/services/wikipediaScraper.js`, `src/db/database.js` e `test/yahoo-client.test.js`, `test/market-data.test.js`, `test/concurrency-sync.test.js`, `test/most-recent.test.js`, `test/historical-dividends.test.js`.
- **Dependências relevantes:** `yahoo-finance2@2.13.3` (`package.json:34`), `axios@^1.19.0`, `p-limit@^3.1.0`.
- **Método:** análise estática somente-leitura; uma prova empírica do deadlock de concorrência executada em Node puro (sem Electron, sem rede real). Não foi executada a suite completa.
- **Modo:** auditoria de segurança + performance. Nenhum ficheiro de código-fonte foi alterado.

---

## 1. Resposta às questões-chave

### 1.1 Qual cliente Yahoo é usado

**`src/data/yahooClient.js` é o cliente de produção.** Evidência:

| Consumidor | Require |
|---|---|
| Entrypoint Electron | `main.js:7` — `require('./src/data/yahooClient')` |
| Worker de scan/backtest | `src/engine/scanner.worker.js:13` |
| Cópias stale (não carregadas) | `src/main/main.js:7`, `src/ipc/ipcHandlers.js:7` |

**`src/services/yahooClient.js` não é usado em runtime.** É referenciado apenas por testes:
`test/most-recent.test.js:300` (importa `fetchIncrementalCandles`) e `test/historical-dividends.test.js:106-111` (verifica que ambos os módulos exportam `fetchStockDividendsFromYahoo`). Nenhum ficheiro de `src/` ou `main.js` faz `require` do cliente em `services/`.

### 1.2 Divergências entre os dois clientes

O diff integral (`diff -u src/data/yahooClient.js src/services/yahooClient.js`) tem **apenas 2 hunks**; todo o resto é idêntico. São duplicados com deriva:

| Divergência | `src/data` (produção) | `src/services` (stale) | Risco |
|---|---|---|---|
| `normalizeTicker` (sufixos de classe) | `src/data/yahooClient.js:123-134`: `.A/.B/.C/.K` → hífen (`HEI.A`→`HEI-A`); restantes `.XX` (≤3) mantêm-se | `src/services/yahooClient.js:126-131`: qualquer 2.º segmento com ≤3 chars mantém-se (`HEI.A` fica `HEI.A`) | Símbolos de classe geram URLs diferentes; testes `test/yahoo-client.test.js:8-13` fixam o comportamento de `data` (incl. `BF.B`→`BF-B`) |
| `syncSingleTicker` fallback | `src/data/yahooClient.js:974-978`: **não** sobrescreve `first_date` (comentário explícito: lote parcial de 3mo não deve definir `first_date`) | `src/services/yahooClient.js:972`: chama `db.updateStockFirstDate(ticker, fallbackCandles[0].date)` — define `first_date` com a data de ~3 meses | Se o cliente for trocado, `first_date` passa a ser irreal; `updateStockFirstDate` existe (`src/db/database.js:1361-1369`) e ainda propaga ao variante base (`baseSymbol`) |

Consequência operacional: **as correções de `data` não chegam a `services` e vice-versa**; os testes de `fetchIncrementalCandles` correm contra `services` (`test/most-recent.test.js:300`), deixando a implementação realmente usada sem cobertura para esse fluxo.

### 1.3 Nota sobre ficheiros duplicados stale

`src/main/main.js` e `src/ipc/ipcHandlers.js` são cópias antigas do `main.js` raiz e contêm requires quebrados (`require('./src/data/yahooClient')` a partir de `src/main/`/`src/ipc/` resolve para caminhos inexistentes). Não são carregados (`package.json:5` aponta para `main.js`); são lidos como texto por `test/first-record-choice.test.js:52-59`. Risco de se editar o ficheiro errado (ver INFO-01).

---

## 2. Sumário de severidade

| Severidade | Nº |
|---|---|
| Crítico | 1 |
| Alto | 1 |
| Médio | 8 |
| Baixo | 2 |
| Informativo | 4 |
| **Total** | **16** |

---

## 3. Controlos verificados (positivos)

| Controlo | Evidência |
|---|---|
| URLs diretas para `query1.finance.yahoo.com` com `encodeURIComponent` no símbolo | `src/data/yahooClient.js:727`, `:995`, `:1054`, `:1119`, `:1183`, `:1218` |
| Host fixo `https://`; sem credenciais/tokens no código (apenas `User-Agent`) | `src/data/yahooClient.js:15`, `:1004-1010` |
| Erros definitivos (404/deslistado) não gastam retries | `src/data/yahooClient.js:50-54`, `:76`, `:346-350`; testado em `test/concurrency-sync.test.js:145-157` |
| Backoff exponencial com jitter e 429 a duplicar base | `src/data/yahooClient.js:67-85`; testado em `test/concurrency-sync.test.js:68-128` |
| Dedupe por data + ordenação ASC + remoção da última vela incompleta | `src/data/yahooClient.js:187-215` |
| Validação de atividade recente (volume>0 nos últimos 30 dias; estagnação >45 dias) | `src/data/yahooClient.js:217-248` |
| `fetchFullHistoryFromIPO` valida datas por regex e força tipos finitos | `src/data/yahooClient.js:767-794` |
| Parser do `marketDataService` rejeita datas não-semânticas e valores não finitos/OHLC incoerentes | `src/services/marketDataService.js:101-125`, `:146-168` |
| Fallback Yahoo→Stooq determinístico com erros retidos em metadata não-enumerável | `src/services/marketDataService.js:317-371` |
| Sem prototype pollution confirmada: não há merge de objetos de terceiros; leituras diretas `payload.chart.result[0]`; `JSON.parse` + acesso a campos próprios | `src/services/marketDataService.js:146-168`; `src/data/yahooClient.js:1236-1246` |
| Sem ReDoS: regexes ancoradas e simples; `tickerLists.searchWorldIndices` escapa o token antes de construir `RegExp` | `src/data/tickerLists.js:1083-1087` |
| Símbolos de pesquisa validados por charset antes de devolver à UI | `src/data/yahooClient.js:481` |
| Pool partilhada `p-limit(5)` + micro-stagger 50-120ms | `src/data/yahooClient.js:26-30` |

---

## 4. Findings de Segurança

### SEC-01 — Símbolo interpolado sem encoding no URL do `yahoo-finance2` — **Médio**

- **Estado:** confirmado (código); impacto limitado ao host fixo.
- **Evidência:**
  - `src/data/yahooClient.js:107-138` — `normalizeTicker` não restringe charset; um ticker sem ponto é devolvido como `trimmed` (`:137`) tal como veio (ex.: `foo/bar`, `X?period1=0`).
  - `src/data/yahooClient.js:296`, `:555`, `:642`, `:694`, `:897`, `:933` — o valor é passado a `yahooFinance.chart(tickerVariant, …)`.
  - `node_modules/yahoo-finance2/dist/cjs/src/modules/chart.js:216` — `url: "https://${YF_QUERY_HOST}/v8/finance/chart/" + symbol` (concatenação crua, sem `encodeURIComponent`); `moduleExec.js:40-42` só valida `typeof symbol === "string"`.
  - Contraste: as funções que usam `axios`/`fetch` direto **codificam** (`src/data/yahooClient.js:727`, `:995`, …).
- **Impacto:** path/query injection dentro de `query2.finance.yahoo.com` (parâmetros Yahoo sobreponíveis, caminhos arbitrários no mesmo host) desencadeada por ticker vindo de pesquisa, CSV/XLSX ou constituintes Wikipedia. Não há SSRF cross-host com host fixo; `YF_QUERY_HOST` é override por env (`node_modules/yahoo-finance2/dist/cjs/src/lib/options.js:29`) — se o ambiente for controlável, aí sim há SSRF. Como o ticker é a chave de gravação na SQLite, um símbolo anómalo cria séries sob chave previsível (ver CACHE-01).
- **Correção mínima:** validar o charset no início de cada fetch (`if (!/^[A-Za-z0-9.^=\-]{1,20}$/.test(ticker)) throw …`) e/ou `encodeURIComponent(normalizedTicker)` antes de `yahooFinance.chart`; nunca aceitar `/`, `?`, `#`, `@`, `%` em tickers.

### SEC-02 — Sem timeout explícito nem limite de tamanho de resposta — **Médio**

- **Estado:** confirmado para `fetch`/`axios`; suspeita para `yahoo-finance2`.
- **Evidência:**
  - `src/data/yahooClient.js:728-730` — `fetch(url, { headers })` sem `AbortController`/`signal` e `await res.json()` sem limite de bytes.
  - `src/data/yahooClient.js:1004-1010`, `:1064-1067`, `:1130-1133`, `:1222-1225` — `axios.get` define `timeout` (7-10 s) mas nenhum `maxContentLength`/`maxBodyLength`.
  - `node_modules/axios/lib/defaults/index.js:153-154` — defaults `maxContentLength: -1` e `maxBodyLength: -1` (ilimitado).
  - `yahooFinance.chart` passa por `yahoo-finance2` (`queue.timeout: 60` é espera na fila, `node_modules/yahoo-finance2/dist/cjs/src/lib/options.js:31-34`), sem timeout de pedido explícito no código da app.
- **Impacto:** um payload grande/comprometido de upstream (ou endpoint que nunca responde) retém memória e bloqueia a cadeia de retries; `fetchFirstTradeDate` pode pendurar o IPC respetivo indefinidamente.
- **Correção mínima:** `AbortSignal.timeout(10000)` no `fetch`; `maxContentLength: 5 * 1024 * 1024` nos `axios.get`; validar `res.ok`/tamanho antes de `json()`.

### SEC-03 — `fetchStockDividendsFromYahoo` rebenta com payload malformado — **Médio**

- **Estado:** confirmado.
- **Evidência:** `src/data/yahooClient.js:1236-1244` — `new Date(Number(item.date || timestampKey) * 1000)` seguido de `d.toISOString()` sem validar `Number.isNaN(d.getTime())`; `Number(item.amount)` pode ser `NaN`; loop sobre `Object.keys(rawDividends)` sem limite; `axios` sem limite de resposta (`:1222-1225`).
- **Impacto:** uma única chave com data inválida lança `RangeError: Invalid time value`, abortando **todo** o download de dividendos (o handler `main.js:1644-1661` devolve `success:false`); `amount` não numérico é persistido. É acionável por dados de terceiros (Yahoo ou MITM/proxy).
- **Correção mínima:** `const d = new Date(...); if (Number.isNaN(d.getTime())) continue; const amount = Number(item.amount); if (!Number.isFinite(amount)) continue;`.

### SEC-04 — Retries sobre erros definitivos e amplificação em cascata — **Médio**

- **Estado:** confirmado.
- **Evidência:**
  - `src/data/yahooClient.js:88-99` — `fetchWithRetrySpec` **não** consulta `isDefinitiveDataError` nem distingue 429, ao contrário de `fetchWithBackoff` (`:76-80`).
  - `src/data/yahooClient.js:840` — `syncTickersBatch` envolve `fetchOne` em `fetchWithRetrySpec`; o `fetchOne` de produção é `fetchIncrementalYahooHistory`, que já faz 3 tentativas internas (`:641-652`). Resultado: até **9 pedidos** por ticker, mesmo para 404/deslistado.
  - `src/data/yahooClient.js:272-306` — variantes de ticker (até 3) × `fetchWithBackoff` (3) = até 9 pedidos em `fetchWithRetry`.
- **Impacto:** rajadas evitáveis, pressão de 429 e latência; um 404 gasta tempo de espera útil.
- **Correção mínima:** em `fetchWithRetrySpec`, lançar já quando `isDefinitiveDataError(error)`; não aninhar retry no orquestrador (`syncTickersBatch` deve confiar no retry da função de rede, ou vice-versa).

---

## 5. Findings de Concorrência / Performance

### CRIT-01 — Deadlock de `p-limit` aninhado em `sync-incremental-batch` — **Crítico**

- **Estado:** **confirmado empiricamente.**
- **Evidência:**
  - Produção: `main.js:1842-1846` chama `syncTickersBatch(tickers, { fetchMethod: (t,lastDate) => yahooClient.fetchIncrementalYahooHistory(t, lastDate, { throwOnError: true }) })` (também em `src/main/main.js:1695-1698` e `src/ipc/ipcHandlers.js:1695-1698`).
  - `src/data/yahooClient.js:826-847` (ramo `hasFetchMethod`) embrulha cada tarefa em `networkLimit` (`:829`) e chama `fetchWithRetrySpec` (`:840`).
  - `src/data/yahooClient.js:641-649` — `fetchIncrementalYahooHistory` volta a adquirir **a mesma** instância `networkLimit` (`:26`) por dentro.
  - `p-limit` v3 não é reentrante: cada slot só é libertado quando a função da tarefa resolve; com ≥5 tickers desatualizados, os 5 slots exteriores ficam ocupados à espera de slots interiores que nunca abrem.
  - O próprio comentário do ficheiro reconhece o perigo e afirma o oposto do que o ramo faz: `src/data/yahooClient.js:803-808` ("as tasks NÃO são embrulhadas em networkLimit (p-limit não é reentrante — aninhar acquisition causaria deadlock)").
  - Prova empírica (Node puro, sem rede): `syncTickersBatch(['A','B','C','D','E'], { expectedTradingDay:'2026-09-01', getLastDate:()=>'2020-01-01', fetchMethod:(t)=>networkLimit(async()=>({t})) })` → resultado observado: **`DEADLOCK: nested networkLimit never released`** após 2 s (nunca resolve).
- **Impacto:** com ≥5 tickers realmente desatualizados, o handler IPC `sync-incremental-batch` nunca conclui; a UI fica presa à espera de `Promise.all` e o lote não grava nada. Com <5 tickers o fluxo funciona — o que explica a falha escapar a testes manuais pequenos.
- **Correção mínima:** remover o embrulho `networkLimit` das tarefas no ramo `hasFetchMethod` (`src/data/yahooClient.js:829`), deixando a aquisição de slot às funções de rede finais — exatamente o que o comentário `:803-808` e o ramo por omissão (`:887`) já fazem. Alternativa: passar `fetchMethod` sem `networkLimit` interno e manter o embrulho exterior. Adicionar teste de regressão com ≥5 tarefas e `fetchMethod` que use `networkLimit`.

### PERF-01 — Funções que contornam o pool global de rede — **Alto**

- **Estado:** confirmado.
- **Evidência:**
  - O comentário afirma que "Todas as funções de histórico passam por aqui" (`src/data/yahooClient.js:22-26`), mas:
    - `fetchLatestCandlesForSingleTicker` — `axios.get` direto, sem `networkLimit` (`src/data/yahooClient.js:1046-1109`, chamada em `:1064`).
    - `fetchIncrementalCandles` — `axios.get` direto, sem `networkLimit` (`src/data/yahooClient.js:1111-1212`, chamadas em `:1130` e `:1184`).
    - `fetchFirstTradeDate` — `fetch` direto, sem `networkLimit` (`src/data/yahooClient.js:723-743`, `:728`).
    - `searchTickers` — `yahooFinance.search` fora do pool (`src/data/yahooClient.js:449-526`, `:470`).
  - Fora do módulo: `src/services/marketDataService.js:276-279` e `:295-298` (axios próprio) e `src/services/wikipediaScraper.js:149-152` também não partilham o pool.
  - `fetchFirstTradeDate` é ainda chamado em chunks de 3 concorrentes (`main.js:2385`, `:2410-2424`) e `fetchIncrementalCandles` corre sequencialmente (`main.js:2040-2050`, `:2163-2169`).
- **Impacto:** o teto "5 pedidos" deixa de ser global; fluxos sobrepostos (ex.: `sync-incremental-batch` + `sync-start-download` + backtest no worker) podem exceder o limite e provocar 429, precisamente o controlo que o comentário diz ser primário. Cada worker thread tem a sua própria instância do módulo/pool (`src/engine/scanner.worker.js:13`), pelo que o limite também não é global entre threads.
- **Correção mínima:** envolver as quatro funções em `networkLimit(...)` (incluindo a operação `axios`/`fetch` completa) e corrigir o comentário. Aplicar o mesmo pool (módulo partilhado) a `marketDataService`/`wikipediaScraper` ou documentar explicitamente os pools separados.

### PERF-02 — `syncTickersBatch` (ramo por omissão): `getLastDate` sem `await` e fan-out sem limite — **Baixo**

- **Estado:** confirmado (impacto condicional a `getLastDate` assíncrono).
- **Evidência:** `src/data/yahooClient.js:858` — `storedLastDate = getLastDate(ticker);` sem `await`, enquanto o ramo `hasFetchMethod` usa `await getLastDate(ticker)` (`:831`). `src/data/yahooClient.js:887` — `Promise.all(tasks.map(run => run()))` lança todas as tarefas de uma vez (o teste `test/concurrency-sync.test.js:276-297` documenta um pico de 12/12 concorrentes com `fetchOne` injetado).
- **Impacto:** um `getLastDate` async devolve `Promise` → `normDay` produz `"[object Promise]"` como data, corrompendo a decisão de skip/fetch; universos grandes criam N promessas/leituras SQLite de uma vez (os pedidos de rede ficam capados pelo pool, mas a orquestração não).
- **Correção mínima:** `await getLastDate(ticker)` também no ramo por omissão; opcionalmente fatiar o fan-out (ex.: lotes de 50) mantendo a ordem dos resultados.

### PERF-03 — `searchTickers`: sleep fixo antes da 1.ª tentativa, fora do pool e `limit` sem teto — **Baixo**

- **Estado:** confirmado.
- **Evidência:** `src/data/yahooClient.js:449` (`limit` do chamador sem `Math.min`), `:463-467` (sleep 800-1500 ms **antes** de qualquer tentativa, incluindo a primeira), `:470` (fora do `networkLimit`), `:505-517` (retries próprios).
- **Impacto:** latência artificial de ~1 s por pesquisa e coexistência com pedidos de histórico fora do teto global; `quotesCount` arbitrário se `limit` vier da UI.
- **Correção mínima:** remover o sleep da primeira tentativa (só entre tentativas), `limit = Math.min(Math.max(1, limit), 25)`, e passar a chamada por `networkLimit`.

---

## 6. Findings de Parsing / Integridade

### PARS-01 — Datas validadas apenas por comprimento em `processQuote` — **Médio**

- **Estado:** confirmado (reconhecido pelo próprio teste).
- **Evidência:** `src/data/yahooClient.js:143-144` — `const date = … String(q.date).slice(0, 10); if (!date || date.length < 8) return null;`. Qualquer string com ≥8 chars passa (ex.: `"2024-13-99"`, `"not-a-date"`). Contraste com `fetchFullHistoryFromIPO`, que valida `^\d{4}-\d{2}-\d{2}$` (`:772`). GAP explícito: `test/yahoo-client.test.js:53` (`test.todo('Yahoo deve validar semanticamente strings de data…')`).
- **Impacto:** velas com datas inválidas entram na série, são ordenadas lexicograficamente e persistidas; a regra de estagnação de 45 dias (`:234-245`) pode ser enganada.
- **Correção mínima:** reutilizar `isValidIsoDate`/`parseDate` de `src/services/marketDataService.js:73-93` (ou regex + `Date` round-trip) em `processQuote`.

### PARS-02 — Fallback de `fetchIncrementalCandles` aceita `NaN`/preços inválidos — **Médio**

- **Estado:** confirmado.
- **Evidência:** `src/data/yahooClient.js:1181-1208` (último recurso `range=5d` para ativo virgem). O ciclo `:1187-1200` só verifica `quote.close?.[i] == null` (`:1188`) e constrói as velas com `Number(...)` sem `Number.isFinite` (`:1193-1197`): `close: Number(quote.close[i])` pode ser `NaN`, e `open/high/low` usam `|| quote.close[i]`, pelo que `0` cai no fallback e valores não numéricos produzem `NaN`. O caminho principal do mesmo ficheiro faz as verificações corretas (`:1146-1152`).
- **Impacto:** gravação de velas `NaN`/incoerentes em `historical_prices`/`ohlcv_cache`, contaminando Markov e indicadores.
- **Correção mínima:** no fallback, aplicar o mesmo filtro do caminho principal (`Number.isFinite(closeVal)`) ou reutilizar `marketDataService.normalizeCandle` antes de devolver.

### PARS-03 — `isDefinitiveDataError` classifica por substring (`/no data|period1/`) — **Médio (suspeita)**

- **Estado:** suspeita (não reproduzido com payloads reais).
- **Evidência:** `src/data/yahooClient.js:50-54` — `/404|not found|no data|period1/i` aplicado a `err.message`; usado para abortar retries e marcar `isInactive`/`isNotFound` (`:346-350`, `:664-668`).
- **Impacto:** uma mensagem transitória que contenha "no data" (ou um erro de validação que mencione `period1`) é tratada como definitiva → desistência silenciosa de um ticker válido. O inverso (transitório mascarado) não se aplica.
- **Correção mínima:** restringir a matching a erros estruturados (`error.code === 'Not Found'`, `status === 404`, `isInactive` explícito) e não a substrings genéricas; exigir confirmação de payload vazio (`quotes.length === 0`) para marcar deslistado.

---

## 7. Findings de Cache

### CACHE-01 — Chaves de `ohlcv_cache` inconsistentes e crescimento sem poda — **Médio**

- **Estado:** confirmado.
- **Evidência:**
  - Tabela sem TTL/poda: `src/db/database.js:111-121`; escrita `INSERT OR REPLACE` de todas as velas a cada sync (`:456-469`); leitura exige ≥200 linhas e TTL por linha de 24 h (`:471-481`).
  - Escritas com chave = ticker puro: `main.js:1811`, `:1882`, `:2293`, `:2451`.
  - Leituras com chave = `${ticker}_${timeframe}`: `main.js:1016-1021`; e o worker escreve/lê com o mesmo sufixo: `src/engine/scanner.worker.js:192`, `:402-408`.
  - Chave previsível (`ticker` ou `ticker_1d`), sem `fetched_at`/versão de origem, e os dados gravados passam apenas pelo filtro leve de `processQuotes` (`src/data/yahooClient.js:207-212`, que só valida a última vela; datas frágeis por PARS-01).
- **Impacto:** (1) as linhas escritas pelos fluxos de sync (chave `AAPL`) nunca são lidas pelo backtest (chave `AAPL_1d`) → crescimento indefinido do ficheiro `quant_cache.db` sem qualquer reutilização; (2) cache envenenável por dados parcialmente validados (basta uma resposta anómala e o TTL de 24 h mantém-na); (3) sem `DELETE`/`VACUUM` não há limite de disco.
- **Correção mínima:** unificar a chave numa função única (`cacheKey(ticker, timeframe)`) usada em ambos os lados; rejeitar velas com `normalizeCandle` antes de `cacheOHLCV`; agendar poda (`DELETE FROM ohlcv_cache WHERE fetched_at < now-7d`) e `VACUUM` periódico.

---

## 8. Findings Informativos / Dívida

### INFO-01 — Cliente duplicado stale gera cobertura cruzada errada — **Informativo**

- **Evidência:** `src/services/yahooClient.js` existe mas não é carregado por produção (ver 1.1); `test/most-recent.test.js:300` testa a cópia de `services` para `fetchIncrementalCandles`; `test/historical-dividends.test.js:105-111` consagra a existência de ambos; `src/data/yahooClient.js:974-978` vs `src/services/yahooClient.js:972` (ver 1.2).
- **Impacto:** correções aplicadas a um ficheiro não chegam ao outro; a suite dá falsa confiança no fluxo incremental.
- **Correção mínima:** apagar `src/services/yahooClient.js` e reapontar os testes para `src/data/yahooClient.js` (ou, se houver intenção de migrar, tornar `services` um re-export do `data` e cobrir o comportamento divergente com teste).

### INFO-02 — Cópias stale do main process com requires quebrados — **Informativo**

- **Evidência:** `src/main/main.js:7` e `src/ipc/ipcHandlers.js:7` fazem `require('./src/data/yahooClient')` a partir de diretórios onde esse caminho não existe; `package.json:5` (`"main": "main.js"`) aponta para a raiz; nenhum código os carrega; `test/first-record-choice.test.js:52-59` lê-os como texto.
- **Impacto:** confusão de manutenção (alterações feitas no ficheiro errado); se forem algum dia promovidos a entrypoint, a app falha no arranque.
- **Correção mínima:** remover os duplicados ou convertê-los em wrappers `module.exports = require('../../main.js')` / re-export legítimo.

### INFO-03 — Fila interna do `yahoo-finance2` + API privada + pools por thread — **Informativo**

- **Evidência:** `node_modules/yahoo-finance2/dist/cjs/src/lib/options.js:31-34` (concurrency 4, timeout 60) aninhada no `p-limit(5)` da app (`src/data/yahooClient.js:26`); mutação de API privada `_opts` em `src/data/yahooClient.js:9-13`; versão fixada em `package.json:34`; cada worker thread tem instância própria do pool (`src/engine/scanner.worker.js:13`).
- **Impacto:** dois níveis de fila (latência/throughput não lineares) e dependência de API interna não versionada; o teto de 5 não é global entre threads (reforça PERF-01).
- **Correção mínima:** documentar o duplo-queue; alinhar `YF_QUEUE_CONCURRENCY`/`queue` via opções públicas; replicar a configuração `logErrors` sem tocar em `_opts` quando a lib expuser opção pública.

### INFO-04 — Código morto / sem cache HTTP — **Informativo**

- **Evidência:** `fetchMissingRecentCandles` é exportado (`src/data/yahooClient.js:1258`) mas não tem consumidor de produção (apenas `test/most-recent.test.js:221`). Não existe cache em memória nem cache HTTP (`ETag`/`If-Modified-Since`) em nenhum dos clientes; a única cache é a SQLite (CACHE-01).
- **Impacto:** manutenção sem retorno e re-fetch completo em cada arranque/consulta.
- **Correção mínima:** remover ou documentar como API de teste; considerar cache HTTP condicional para o histórico completo (respeitando o pool).

---

## 9. Verificação de testes e lacunas

Cobertura existente (positiva):

| Teste | Foco |
|---|---|
| `test/yahoo-client.test.js` | `normalizeTicker` de `data`, retries 429/timeout, 404 sem repetição, `buildIncrementalPeriod1`, `fetchHistorySince` (mocks) |
| `test/market-data.test.js` | `parseYahooPayload`/`parseStooqCsv`, fallback Yahoo→Stooq, datas inválidas |
| `test/concurrency-sync.test.js` | `fetchWithBackoff` (backoff/jitter/429/definitivos), `syncTickersBatch` com `fetchOne` injetado, saturação `networkLimit` |
| `test/most-recent.test.js` | `fetchIncrementalCandles` (contra `src/services`), `syncSingleTicker`, `fetchMissingRecentCandles` |
| `test/historical-dividends.test.js` | Existência de `fetchStockDividendsFromYahoo` em ambos os clientes |

Lacunas concretas:

1. **Deadlock CRIT-01 sem cobertura:** o ramo `fetchMethod` (`src/data/yahooClient.js:826-847`) não é testado com `fetchMethod` que adquira `networkLimit`; `test/concurrency-sync.test.js:276-297` só documenta o ramo por omissão. Foi necessário um probe externo para o detetar (ver CRIT-01).
2. `test/yahoo-client.test.js:53` — `test.todo` de validação semântica de datas (PARS-01).
3. Sem testes para: fallback do `fetchIncrementalCandles` (PARS-02), payload malformado de dividendos (SEC-03), charset/injeção de ticker (SEC-01), timeout/limite de resposta (SEC-02), round-trip de `ohlcv_cache` entre fluxos (CACHE-01), `searchTickers` fora do pool (PERF-03).
4. `test/market-data.test.js:70` — `test.todo` de datas Stooq já está, na prática, coberto por `normalizeCandle` (`src/services/marketDataService.js:101-125`); o todo está obsoleto.
5. Cobertura cruzada errada: `fetchIncrementalCandles` é testado em `services` (`test/most-recent.test.js:300`), mas o código chamado em produção é o de `data` (`main.js:2050`).

---

## 10. Riscos residuais

1. **Injeção no URL do `yahoo-finance2` (SEC-01)** está contida pelo host fixo; se `YF_QUERY_HOST` for controlável ou a lib mudar a construção do URL, escala para SSRF.
2. **Deadlock (CRIT-01)** torna o fluxo de sync atualmente não confiável para universos ≥5 tickers; qualquer remedição de retry (SEC-04) é irrelevante enquanto o caminho não chegar à rede.
3. **Retry amplification (SEC-04)** agrava 429 assim que o pool for contornado (PERF-01) ou após corrigir CRIT-01 sem tocar nos retries.
4. **Cache (CACHE-01)** acumula indefinidamente no `quant_cache.db` (9,5 MB já observável no workspace) e pode reter dados inválidos 24 h.
5. **Sem limite de resposta (SEC-02)** expõe o processo principal a picos de memória com uma única resposta anómala.

## 11. Limitações

- Auditoria **estática** + uma prova empírica de deadlock em Node puro (2 s de espera, sem Electron e sem rede); não foram feitos pedidos reais à Yahoo/Stooq nem testes de penetração.
- Não foi executada a suite (`npm test`, que exige Electron/`ELECTRON_RUN_AS_NODE=1`) nem medições de runtime/TTI.
- Internals do `yahoo-finance2` inspecionados apenas na construção de URL (`chart.js`, `moduleExec.js`, `yahooFinanceFetch.js`) e opções/queue; o resto do parsing da lib não foi auditado.
- `src/services/wikipediaScraper.js` e `marketDataService.js` foram revistos nas partes que tocam Yahoo/Stooq (normalização, retries, parsing, cache), não exaustivamente.
- Linhas citadas correspondem à revisão de 2026-09-10; podem deslocar-se com edições concorrentes.

## 12. Ordem de remediação sugerida

1. **CRIT-01** — remover o `networkLimit` exterior no ramo `hasFetchMethod` (`src/data/yahooClient.js:829`) + teste de regressão com ≥5 tickers (Crítico, esforço baixo).
2. **PERF-01** — embrulhar `fetchLatestCandlesForSingleTicker`, `fetchIncrementalCandles`, `fetchFirstTradeDate` e `searchTickers` no pool; corrigir o comentário `:22-26` (Alto, esforço baixo/médio).
3. **SEC-01** — validar charset do ticker antes de qualquer fetch (Médio, esforço baixo).
4. **PARS-01/PARS-02/SEC-03** — reutilizar `parseDate`/`normalizeCandle` do `marketDataService` no cliente `data` (Médio, esforço baixo).
5. **SEC-02/SEC-04** — timeout/`AbortController`/`maxContentLength` e retry sem definitivos/duplicação (Médio, esforço baixo).
6. **CACHE-01** — chave única + validação + poda (Médio, esforço baixo/médio).
7. **PERF-02/PERF-03/INFO-01/INFO-02/INFO-03/INFO-04** — limpeza, awaits em falta e remoção de duplicados (Baixo/Informativo, esforço baixo).
