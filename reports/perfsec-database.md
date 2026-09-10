# Relatório de Auditoria — perfsec-database

**Alvo principal:** `src/db/database.js` (2315 linhas, leitura integral)
**Papel:** auditor sénior de segurança e performance SQLite/better-sqlite3 (somente-leitura de código)
**Data:** 2026-09-10
**Runtime confirmado:** `ELECTRON_RUN_AS_NODE=1 electron` + better-sqlite3 `^12.4.0`, SQLite **3.53.2**

**Contexto confirmado de utilização**
- `package.json:4` → entrypoint real é `main.js` (2957 linhas), que instancia `new Database(app.getPath('userData'))` em `main.js:565` e chama `db.init()`.
- `src/main/main.js` e `src/ipc/ipcHandlers.js` são **cópias byte-a-byte** (2795 linhas cada) e não são referenciadas por nenhum `require` de produção (apenas `test/first-record-choice.test.js` lê o segundo como texto).
- Workers: `src/engine/scanner.worker.js` e `src/engine/simulationWorker.js` **não** abrem a BD para escrita; pedem leituras/escritas ao main via mensagens `dbRequest`/`dbResponse` (dispatcher em `main.js:177-288` e `main.js:321-388`). Exceção: `simulationWorker.js` abre ligações **readonly** próprias (`:18` no modo `workerData`, `:152` em `loadLocalCandles`).
- Writer único: apenas o main process (`better-sqlite3` síncrono). WAL ativo (`database.js:71`). `busy_timeout` efetivo 5000 ms (default do better-sqlite3, verificado por sonda; não configurado explicitamente).

**Método**
1. Leitura integral de `src/db/database.js`.
2. Varrimento sistemático de SQL dinâmico (`rg` por template literals com `${}` e concatenação com `+` em contexto SQL), preparação de statements, transações e PRAGMAs.
3. Sondas reais com `EXPLAIN QUERY PLAN` sobre o esquema criado por `DB.init()` (índices em `sqlite_master`, planos de queries quentes, bind de `NaN`/`Infinity`/`undefined`, `LIMIT` inválido, `busy_timeout`, FKs declaradas).
4. Revisão de `test/database.test.js`, `test/pipeline.sqlite.test.js`, `test/performance.test.js`, `test/concurrency-sync.test.js` e restantes testes que tocam a BD.

---

## Sumário executivo

**Não foi confirmada nenhuma injeção SQL.** Todos os valores passam por parâmetros ligados (`?`/named) ou por placeholders gerados pelo comprimento de arrays; os únicos fragmentos concatenados são constantes de SQL (`database.js:1957-1962`, `2245-2264`, `1846-1848`), e o único identificador dinâmico (`adjSelect`, `database.js:1623`) deriva de `PRAGMA table_info`, não de input.

Os riscos dominantes são de **performance** (índices redundantes na tabela mais quente, consultas não-sargáveis com full scan, N+1 em caminhos chamados pela UI) e de **robustez de writes em massa** (validação de campos inconsistente → rollback do lote inteiro).

| Severidade | Nº findings |
|---|---|
| Crítico | 0 |
| Alto | 3 |
| Médio | 10 |
| Baixo | 6 |
| Informativo | 5 |
| **Total** | **24** |

---

## ALTO

### A-01 — Quatro índices redundantes em `historical_prices` (5 B-trees mantidas por cada write)
- **Severidade:** Alto
- **Evidência:** `src/db/database.js:134-137`, `src/db/database.js:265`, `src/db/database.js:1676`.
  A PK `PRIMARY KEY (ticker, date)` já cria `sqlite_autoindex_historical_prices_1`. São ainda criados:
  `idx_hist_prices_ticker_date`, `idx_hist_ticker_date`, `idx_historical_prices_ticker_date_asc`, `idx_hist_ticker_date_desc` — todos sobre as mesmas duas colunas (ASC/DESC são irrelevantes: o SQLite percorre o índice em ambos os sentidos).
  Sonda (`SELECT name FROM sqlite_master ...` + `EXPLAIN QUERY PLAN`): existem 5 B-trees em `historical_prices` e o planner usa **apenas** `idx_hist_ticker_date_desc` (ex.: `SEARCH historical_prices USING COVERING INDEX idx_hist_ticker_date_desc (ticker=?)`).
- **Impacto:** cada UPSERT/INSERT/INSERT OR REPLACE mantém 5 índices. Nos caminhos de import/sync (`saveHistoricalCandles`, `saveHistoricalCandlesBatch`, `saveBulkHistoricalCandles`, `saveIncrementalCandles`, `saveSingleAssetCandles`) isto multiplica o custo de escrita e o crescimento de disco/WAL numa tabela com "milhares de tickers e séries diárias" (potencialmente milhões de linhas).
- **Correção mínima:** remover as 4 criações e executar migração `DROP INDEX IF EXISTS` para os 4 nomes, ficando apenas a PK. Se se quiser manter um índice explícito por legibilidade, manter só `idx_hist_ticker_date` (mesmo assim redundante com a PK).
- **Confirmação:** confirmado por introspeção do schema e `EXPLAIN QUERY PLAN`.

### A-02 — `UPPER(TRIM(ticker))` força full scan em `getStockDetailWithLatestPrice`
- **Severidade:** Alto
- **Evidência:** `src/db/database.js:1607-1614` (resumo MIN/MAX/COUNT) e `src/db/database.js:1625-1632` (última vela), ambas com `WHERE UPPER(TRIM(ticker)) = ?`.
  Sonda:
  - `SELECT ... WHERE UPPER(TRIM(ticker)) = ? ORDER BY date DESC LIMIT 1` → `SCAN historical_prices` + `USE TEMP B-TREE FOR ORDER BY`.
  - `SELECT MIN/MAX/COUNT ... WHERE UPPER(TRIM(ticker)) = ?` → `SCAN historical_prices USING COVERING INDEX ...` (varredura total do índice).
- **Impacto:** abrir o modal de um ativo custa O(nº total de velas) **duas vezes** (resumo + última vela), no main process (better-sqlite3 síncrono) — UI bloqueia. O mesmo padrão não-sargável aparece em `getStockDividends` (`:2294`, tabela pequena mas sem índice utilizável para a comparação), `getStockHistorySummary` (`:1577`, tabela `stocks`, pequena), `updateStockFirstDate` (`:1368`), `saveHistoricalCandlesFromImport` (`:1496`), `getStockDetailWithLatestPrice` (`:1603`).
- **Correção mínima:** usar igualdade canónica `WHERE ticker = ?` com `canonicalTicker(ticker)` (todos os writers canonicalizam: `canonicalTicker` em `:396`, `:718`, `:787`, `:863`), como já é feito em `getLocalHistoricalPrices` (`:891-897`). Para bases legadas, normalizar os tickers uma vez na migração (`UPDATE historical_prices SET ticker = UPPER(TRIM(ticker))`) antes de confiar no índice.
- **Confirmação:** confirmado por `EXPLAIN QUERY PLAN`.

### A-03 — `reconcileAllStocksFirstDate` passo 2: subquery correlacionada O(n_stocks × n_velas)
- **Severidade:** Alto
- **Evidência:** `src/db/database.js:1699-1716`. As condições `UPPER(TRIM(hp.ticker)) = UPPER(TRIM(stocks.ticker))` e `UPPER(TRIM(hp.ticker)) = UPPER(TRIM(?))` são não-sargáveis.
  Sonda sobre o `UPDATE` real: `SCAN stocks` + `CORRELATED SCALAR SUBQUERY ... SCAN hp USING COVERING INDEX idx_hist_ticker_date_desc` (o `EXISTS` e o `MIN` correm **por cada linha de stocks sem match exato**). O passo 1 (`:1682-1694`) usa `hp.ticker = stocks.ticker` e é sargável (`SEARCH ... (ticker=?)`).
- **Impacto:** num cenário legado (tickers importados sem canonicalização, divergência de caixa/espaços) o arranque da app passa a varrer a tabela de velas por cada stock divergente. Com 2 000 stocks e 10 M velas, cada straggler custa ~2 varreduras completas → bloqueio do arranque (chamado em `main.js:571`, antes da janela). "Raro" por desenho, mas sem limite superior.
- **Correção mínima:** substituir o passo 2 por normalização única dos tickers órfãos (`UPDATE historical_prices SET ticker = UPPER(TRIM(ticker)) WHERE ticker <> UPPER(TRIM(ticker))`) seguida do passo 1 sargável; ou, no mínimo, remover o `EXISTS` UPPER(TRIM) e limitar o passo 2 a uma execução controlada por `user_version`.
- **Confirmação:** confirmado por `EXPLAIN QUERY PLAN`; impacto depende do volume legado (não medido em BD real).

---

## MÉDIO

### M-01 — N+1 em `checkListFreshness` (uma query por ticker)
- **Severidade:** Médio
- **Evidência:** `src/db/database.js:1976-1981` — loop `for (const ticker of tickers)` com `this.db.prepare('SELECT MAX(date) ... WHERE ticker = ?')` **dentro** do loop (statement compilado por iteração).
  Sonda instrumentada com 3 custom tickers: 5 chamadas a `prepare` (1 principal + 1 de custom tickers + 3 no loop).
- **Impacto:** com milhares de ativos em My List, milhares de queries + compilações por invocação. Chamado em `RUN_MARKET_SCAN` (`main.js:617`) e em `main.js:1798` — caminho de UI.
- **Correção mínima:** uma única query agregada por chunks de até 900 tickers, como já se faz em `getMyListAssetsSyncStatus` (`:2055-2071`): `WHERE ticker IN (${placeholders}) GROUP BY ticker`.
- **Confirmação:** confirmado por leitura + contagem de `prepare`.

### M-02 — `purgeInactiveStocks`: full scan + `prepare` dentro de loops
- **Severidade:** Médio
- **Evidência:** `src/db/database.js:1787-1789` (`SELECT ticker FROM historical_prices GROUP BY ticker HAVING MAX(date) >= ?` → sonda: `SCAN historical_prices USING COVERING INDEX`; O(n_velas)); `src/db/database.js:1808-1814` — `this.db.prepare('DELETE ...')` dentro dos dois loops.
- **Impacto:** custo linear em todas as velas e recompilação de statement por ativo a remover; corrida no main thread (`main.js:1789`).
- **Correção mínima:** hoist dos dois `DELETE` para fora dos loops e usar `DELETE ... WHERE ticker IN (chunks)`; opcionalmente manter tabela temporária com os tickers a remover.
- **Confirmação:** confirmado por código + plano.

### M-03 — Validação de campos inconsistente nos writes em massa: `NaN/Infinity/undefined` → `NULL` → violação `NOT NULL` → rollback do lote
- **Severidade:** Médio
- **Evidência:** sonda de bind: `NaN`, `Infinity` e `undefined` são aceites e convertidos em `NULL`; inserir `NULL` numa coluna `REAL NOT NULL` lança `NOT NULL constraint failed`, abortando a transação.
  Caminhos que validam apenas `ticker/date/close` (ou nada) e deixam `open/high/low/volume` passarem:
  - `saveHistoricalCandles`: `src/db/database.js:717-725` (filtra só `ticker/date/close`);
  - `saveIncrementalCandles`: `src/db/database.js:2172-2180` (idem; alimenta `_insertBatchTransaction`, `:392-407`);
  - `saveSingleAssetCandles`: `src/db/database.js:2103-2115` (só `close` finito);
  - `saveHistoricalCandlesFromImport`: `src/db/database.js:1476-1491` (**sem verificação de finitude de nenhum campo**);
  - `saveStockDividends`: `src/db/database.js:2276-2282` (`Number(div.amount)` sem `Number.isFinite`).
  Contraste: `saveBulkHistoricalCandles` (`:861-878`) já faz a validação completa e documenta o problema.
- **Impacto:** um único campo inválido numa vela aborta o lote inteiro (transação), perdendo dados válidos que vinham no mesmo lote; no caso de import/CSV é um vetor de indisponibilidade e retrabalho.
- **Correção mínima:** sanitizador único (ticker canónico não vazio, data `YYYY-MM-DD`, `open/high/low/close` finitos, `volume` finito ≥ 0) aplicado em todos os writers, ignorando linhas inválidas como faz `saveBulkHistoricalCandles`.
- **Confirmação:** confirmado (bind + schema `NOT NULL`).

### M-04 — `auditAllAssetsStatus`: JOIN não-sargável + `GROUP BY` sobre full scan
- **Severidade:** Médio
- **Evidência:** `src/db/database.js:2244-2265` — `LEFT JOIN historical_prices hp ON UPPER(TRIM(s.ticker)) = UPPER(TRIM(hp.ticker))` + `GROUP BY s.ticker ORDER BY s.ticker`.
  Sonda: `SCAN s ... LEFT-JOIN` + `SCAN hp USING COVERING INDEX` (varredura total de velas, uma vez).
- **Impacto:** auditoria global bloqueante no main thread (`main.js:1863`); custo O(n_velas).
- **Correção mínima:** juntar por `hp.ticker = s.ticker` (escrita canónica) e, se necessário, normalizar registos legados primeiro (mesma migração de A-02/A-03).
- **Confirmação:** confirmado por plano.

### M-05 — `IN (...)` sem chunking em várias APIs (risco de exceder `SQLITE_MAX_VARIABLE_NUMBER`)
- **Severidade:** Médio
- **Evidência:** `src/db/database.js:1096-1102` (`checkIndexDataStatus`), `:1127-1137` (`checkIndexStatus`), `:1236-1247` (`auditIndexStocks`), `:1730-1744` (`getHistoricalSummaryBatch`) geram um `?` por ticker sem limite. Apenas `getMyListAssetsSyncStatus` faz chunking (`CHUNK = 900`, `:2055-2071`). Versão confirmada: SQLite 3.53.2, limite por defeito 32766 variáveis.
- **Impacto:** universos grandes (ex.: `getStocksByIndex('ALL')` / auditoria de todos os ativos + `getHistoricalSummaryBatch(tickerSymbols)`) podem falhar com `too many SQL variables`; em versões antigas de SQLite embutido o limite era 999.
- **Correção mínima:** helper de chunking reutilizável (ex.: 900) aplicado às quatro APIs, como já feito em `getMyListAssetsSyncStatus`.
- **Confirmação:** confirmado estruturalmente; não reproduzido com universo > limite.

### M-06 — Workers: nova ligação SQLite (e `PRAGMA journal_mode=WAL`) por ticker
- **Severidade:** Médio
- **Evidência:** `src/engine/simulationWorker.js:150-153` (`loadLocalCandles` faz `new Database(dbPath, { readonly: true, fileMustExist: true })` + `db.pragma('journal_mode = WAL')` + `db.close()` em `finally`) e chamada por ticker em `src/engine/simulationWorker.js:254-259`. No modo `workerData` (`:10-18`) mantém-se **uma** ligação durante todo o run (padrão correto).
- **Impacto:** simulações de milhares de tickers abrem/fecham milhares de ligações e reemitem o PRAGMA (o modo já é WAL; o `PRAGMA` em ligação readonly é desnecessário). Overhead de handshake de ficheiro/WAL por ativo.
- **Correção mínima:** abrir uma ligação readonly por worker/simulação e reutilizá-la (como no modo `workerData`), ou remover `loadLocalCandles` e usar sempre `requestDB`.
- **Confirmação:** confirmado por leitura.

### M-07 — Leituras/escritas síncronas da BD no main process na path do scanner (1-2 round-trips IPC por ticker)
- **Severidade:** Médio
- **Evidência:** `src/engine/scanner.worker.js:162` (`getLocalHistoricalPricesLimit`), `:211` (`getTickerDataRange`) e envio de `saveHistoricalCandles`; dispatcher no main executa queries better-sqlite3 síncronas (`main.js:228-247`, `:269-288`, `:249-267`). Operações longas adicionais no main: `deleteIndexAndStocks`, `purgeInactiveStocks`, `reconcileAllStocksFirstDate`, imports em lote.
- **Impacto:** durante scans/syncs, o event loop do main é ocupado por queries síncronas (UI/IPC com jank); transações longas (DELETE de milhões de velas) bloqueiam escritas de outros handlers e podem gerar `SQLITE_BUSY` no writer (leitores WAL não bloqueiam).
- **Correção mínima:** expor ao worker uma ligação readonly própria (já é o padrão no simulationWorker) ou agrupar pedidos (batch) e limitar/chunkar as transações destrutivas.
- **Confirmação:** confirmado por leitura; sem medição de latência real.

### M-08 — Índices de `historical_signals` desalinhados com as queries
- **Severidade:** Médio
- **Evidência:** `src/db/database.js:103-104` cria `idx_ticker_date` e `idx_status`.
  - `getOpenTrades` (`:439-441`): `WHERE status = 'aberto' OR resultado_pct IS NULL ORDER BY date ASC` → sonda: `SCAN historical_signals` + `USE TEMP B-TREE FOR ORDER BY`.
  - `getClosedTrades` (`:444-448`): `WHERE status = 'fechado' ORDER BY date DESC LIMIT ?` → sonda: `SEARCH ... idx_status` + `USE TEMP B-TREE FOR ORDER BY`.
- **Impacto:** sempre full scan/temp sort; `getClosedTrades` é usado no cálculo adaptativo (`main.js:416`, `src/engine/scanner.js:371`).
- **Correção mínima:** índice composto `(status, date)` (serve ambos os `ORDER BY`); reescrever `getOpenTrades` como `UNION` de `status='aberto'` com `status IS NULL OR resultado_pct IS NULL`.
- **Confirmação:** confirmado por planos.

### M-09 — Migração de arranque reescreve `first_date` de todos os stocks em cada `init()`
- **Severidade:** Médio
- **Evidência:** `src/db/database.js:270-289` corre **fora** do gate de `user_version` (`:292-316`). Sonda: na segunda abertura da mesma BD, o `UPDATE` reportou novamente `changes = 3` e reimprimiu o log de migração. Somam-se `reconcileAllStocksFirstDate()` em `main.js:571`, `:1584`, `:1624`, `:1771` e o passo 1 idêntico em `:1682-1694`.
- **Impacto:** cada arranque/auditoria gera writes desnecessários em N stocks (WAL/cache), mesmo quando o valor calculado é igual; com milhares de ativos é trabalho recorrente evitável.
- **Correção mínima:** adicionar condição de diferença, ex.: `... WHERE EXISTS (...) AND (stocks.first_date IS NULL OR stocks.first_date <> (SELECT MIN(hp.date) ...))`; opcionalmente mover para o bloco `user_version`.
- **Confirmação:** confirmado por reprodução.

### M-10 — Statements recompilados e N+1 pós-lote nos caminhos de import
- **Severidade:** Médio
- **Evidência:**
  - `upsertStock` faz `this.db.prepare(...)` por chamada (`:1320-1329`) — usado em loops de import (`main.js:986`, `:1235`, `:1312`, `:2698`).
  - `addOrUpdateStockRecord` idem (`:1337-1344`).
  - `saveHistoricalCandles` prepara `SELECT first_date`/`SELECT MIN(date)`/`updateStockFirstDate` por ticker dentro da transação (`:754-760`).
  - `saveHistoricalCandlesBatch` chama `getStockHistorySummary(t)` por ticker **fora** da transação (`:836-840`), e `getStockHistorySummary` faz SELECT+possível UPDATE por ativo (`:1559-1586`).
  - `saveIncrementalCandles` faz `SELECT ticker FROM stocks WHERE first_date IS NULL` (full scan sem índice em `first_date`) + `MIN`/`UPDATE` por stock virgem (`:2214-2237`).
- **Impacto:** overhead de compilação e queries N+1 amplificado por milhares de ativos num import.
- **Correção mínima:** hoist de statements para `_prepareStatements`/uso local; substituir o loop pós-lote por uma única agregação `MIN(date) ... WHERE ticker IN (chunks) GROUP BY ticker` e updates apenas para divergências.
- **Confirmação:** confirmado por leitura; sem medição quantitativa.

---

## BAIXO

### B-01 — `getHistoricalPricesForSimulation` com `startDate=null` e `endDate` definido usa a string `'null'`
- **Severidade:** Baixo (correção de dados)
- **Evidência:** `src/db/database.js:1002-1004` — o cenário B é escolhido quando `!startDate && !endDate` é falso; com `startDate=null`, `endDate` definido, `String(null).slice(0,10)` → `'null'`, gerando `date < 'null'` e `date >= 'null'`.
- **Impacto:** intervalo errado/vazio na simulação (a UI pode não produzir este caso, mas a API permite-o).
- **Correção mínima:** normalizar `cleanStart = startDate ? String(startDate).slice(0,10) : '0000-01-01'` (ou tratar ausência de start como cenário A com filtro `date <= end`).
- **Confirmação:** confirmado por leitura.

### B-02 — `LIMIT` sem clamp/validação
- **Severidade:** Baixo
- **Evidência:** `getLocalHistoricalPricesLimit` (`src/db/database.js:913-920`), `getClosedTrades` (`:444-448`), `getClosedActiveTrades` (`:636-640`) passam o argumento diretamente para `LIMIT ?`. Sonda: `LIMIT` com `NULL`/`undefined`/`NaN` lança `SQLITE_MISMATCH`; um `limit` enorme carrega o histórico completo.
  O `limit` do scanner deriva de `params.markov_window` vindo do renderer (`src/engine/scanner.worker.js:159-162`), validado a montante mas sem clamp na BD.
- **Impacto:** erro de execução ou leitura desnecessariamente grande a pedido da UI; defesa em profundidade insuficiente.
- **Correção mínima:** `const lim = Math.min(Math.max(1, Number(limit) || 300), 5000);`
- **Confirmação:** confirmado (bind/sonda).

### B-03 — `INSERT OR REPLACE` no hot path contraria o padrão UPSERT condicional
- **Severidade:** Baixo (performance)
- **Evidência:** `_insertRecentCandleStmt` (`src/db/database.js:387-390`) e `_insertBatchTransaction` (`:392-407`), usados por `saveIncrementalCandles` (`:2185-2186`); `saveSingleAssetCandles` (`:2096-2099`). O comentário em `:369-372` justifica o UPSERT condicional (`_stmtUpsertPrice`, `:374-385`) precisamente para evitar reescritas idênticas, mas estes caminhos não o usam.
- **Impacto:** `INSERT OR REPLACE` reescreve sempre (delete+insert com churn de rowid) e mantém todos os índices mesmo quando os valores não mudam.
- **Correção mínima:** reutilizar `_stmtUpsertPrice` onde a semântica de `changes` não exigir contagem de linhas inseridas.
- **Confirmação:** confirmado por leitura.

### B-04 — `getTickersMetadata` carrega `stocks` e `custom_tickers` inteiras mesmo com filtro de tickers
- **Severidade:** Baixo
- **Evidência:** `src/db/database.js:578-604` — `SELECT ... FROM stocks` e `SELECT ... FROM custom_tickers` sem `WHERE`, filtrando em JS com `want`.
- **Impacto:** custo/memória proporcionais ao universo total em vez do subconjunto pedido.
- **Correção mínima:** quando `want != null`, aplicar `WHERE ticker IN (chunks)` (tabelas pequenas; normalizar caixa em JS como já é feito).
- **Confirmação:** confirmado por leitura.

### B-05 — Código morto em `getTickersForIndex` inclui fallback que devolveria todos os ativos
- **Severidade:** Baixo
- **Evidência:** `src/db/database.js:1887-1889` retorna antes; `:1891-1933` é inalcançável (inclui `if (rows.length > 0) ... return ALL` em `:1933`, que devolveria o universo inteiro para um índice desconhecido se o `return` for removido num refactor).
- **Impacto:** risco latente de regressão funcional/segurança de dados (importar tudo por engano); confusão de manutenção.
- **Correção mínima:** apagar as linhas `1891-1933` (o comportamento seguro atual, `[]` para índice desconhecido, está coberto por `test/pipeline.sqlite.test.js:63`).
- **Confirmação:** confirmado (código após `return`).

### B-06 — Sem manutenção de estatísticas/WAL
- **Severidade:** Baixo
- **Evidência:** PRAGMAs em `src/db/database.js:71-75` (`journal_mode=WAL`, `synchronous=NORMAL`, `cache_size=-64000`, `temp_store=MEMORY`, `foreign_keys=ON`). Não existe `ANALYZE`/`PRAGMA optimize`, `VACUUM`, `journal_size_limit` nem `wal_autocheckpoint` em nenhum ficheiro de produção (verificado por `rg`).
- **Impacto:** sem `ANALYZE`, o planner pode escolher planos piores após crescimentos grandes; ficheiros `-wal` podem crescer sem limite explícito; resultados de `purge`/`deleteIndex` deixam espaço não reclamado.
- **Correção mínima:** `PRAGMA optimize` no arranque (ou a cada N aberturas) e `PRAGMA journal_size_limit = ...`; `VACUUM` manual/ocasional fora do arranque.
- **Confirmação:** confirmado por `rg`.

---

## INFORMATIVO

### I-01 — `dbPath`/`userDataPath` sem validação (hardening)
- **Evidência:** `src/db/database.js:66-70` valida apenas `truthy` e faz `path.join(this.userDataPath, 'trades.db')`; `new Database(dbPath)` sem `fileMustExist` na abertura principal. As chamadas de produção usam `app.getPath('userData')` (`main.js:565`, `:720`, `:757`), pelo que não há entrada de utilizador no caminho hoje.
- **Correção mínima:** `path.resolve` + verificação de prefixo do diretório esperado; `timeout`/`readonly` explícitos conforme o papel.

### I-02 — `foreign_keys = ON` sem nenhuma FK declarada
- **Evidência:** `src/db/database.js:75`; sonda: `pragma_foreign_key_list` vazio para todas as tabelas (10 tabelas, 0 FKs). As deleções em cascata são feitas à mão (`deleteIndexAndStocks`, `:1845-1860`).
- **Impacto:** integridade referencial é apenas responsabilidade da aplicação; PRAGMA não tem efeito prático.
- **Correção mínima:** documentar a decisão ou introduzir FKs com `ON DELETE` nas tabelas dependentes (ex.: órfãos em `historical_prices` já são possíveis via `purgeInactiveStocks`).

### I-03 — `getAllHistoricalMaxDates` sem callers
- **Evidência:** definida em `src/db/database.js:1049-1063`; `rg` não encontrou invocações em `main.js`/`src` (só a definição). Idem `getCachedOHLCV` é usado (`main.js:1020`), mas `getAllHistoricalPrices` (`:955`) só via dispatcher do simulation worker (`main.js:343-362`).
- **Correção mínima:** remover ou marcar explicitamente como API pública/teste.

### I-04 — Duplicação do entrypoint e de `database.js` consumers
- **Evidência:** `cmp` confirma `src/main/main.js == src/ipc/ipcHandlers.js` (2795 linhas cada); `package.json:4` aponta para `main.js` (2957 linhas). Nenhum `require` de produção das cópias.
- **Impacto:** risco de alterações/auditorias no ficheiro errado e divergência de comportamento (os testes leem `src/ipc/ipcHandlers.js` como texto em `test/first-record-choice.test.js:52-59`).
- **Correção mínima:** eliminar as cópias ou gerá-las num único build step e atualizar o teste.

### I-05 — Sem alargamento de validação a strings de ticker/tamanhos de lote
- **Evidência:** `saveBulkHistoricalCandles` (`:851-888`), `saveHistoricalCandlesBatch` (`:774-843`), `saveStockDividends` (`:2267-2287`) aceitam `ticker` sem limite de comprimento e arrays sem limite de tamanho; o `dbPath` também não é validado (I-01).
- **Impacto:** hardening (renderer local, CSP estrita), mas um ticker de vários MB ou um lote gigante ocupam memória/BD e degradam a UI.
- **Correção mínima:** `ticker.length <= 32` e cap de linhas por lote com erro explícito.

---

## Verificações de segurança (sem finding)

1. **Injeção SQL: não detetada.** Locais com SQL dinâmico revistos um a um:
   - placeholders gerados por comprimento de array: `:1097-1102`, `:1128-1137`, `:1237-1247`, `:1730-1744`, `:2058-2064` (chunking) — valores sempre ligados;
   - fragmentos concatenados constantes: `:1957-1962` (`JOIN stocks ... WHERE LOWER(TRIM(...)) = LOWER(TRIM(?))` + param), `:2245-2264` (`WHERE ... = ?`), `:1846-1848` (subquery estática + param);
   - `adjSelect` (`:1623`) deriva de `PRAGMA table_info`, não de input;
   - `_migrateRecalculateSLTP` (`:326-354`) interpola constantes numéricas `SL_PCT`/`TP_PCT` definidas no ficheiro;
   - os subqueries em `deleteIndexAndStocks`/`getTickersForIndex` usam `?`.
   Nenhum identificador (tabela/coluna) provém de input externo.
2. **Transações nos writes em massa: presentes e corretas** na generalidade (`_seedParams:363`, `_insertBatchTransaction:392`, `saveHistoricalCandles:733`, `saveHistoricalCandlesBatch:813`, `saveBulkHistoricalCandles:858`, `addCustomTickersBulk:519`, `saveHistoricalCandlesFromImport:1476`, `saveSingleAssetCandles:2100`, `saveIncrementalCandles:2192`, `saveStockDividends:2275`, `deleteIndexAndStocks:1837`, `deleteHistoricalPrices:1767`, `purgeInactiveStocks:1807`). `_migrate` também corre em transação (`:84-318`).
3. **PRAGMAs base adequados** para o padrão leitor-único/writer-único: WAL + `synchronous=NORMAL` + `cache_size=-64000` + `temp_store=MEMORY` (`:71-74`). `busy_timeout` efetivo de 5000 ms pelo default do better-sqlite3 (verificado), suficiente para contenção pontual entre writer e leitores readonly.
4. **`prepare` de statements quentes**: os caminhos mais chamados (`_stmtUpsertPrice`, `_insertRecentCandleStmt`, `_insertBatchTransaction`) são compilados uma vez em `_prepareStatements` (`:373-408`) — boa prática já aplicada; M-10 lista os que ficaram de fora.

---

## Lacunas de testes

| Área | Cobertura atual | Lacuna |
|---|---|---|
| Migrações | `test/database.test.js:23-73` (schema legado, idempotência), `test/pipeline.sqlite.test.js:66-86` (labels) | Não verifica o custo/reescrita do `UPDATE first_date` em cada `init` (M-09) nem o passo 2 de `reconcileAllStocksFirstDate` (A-03). |
| UPSERT/idempotência | `test/database.test.js:75-88`, `test/pipeline.sqlite.test.js:34-51` | Não cobre `NaN/undefined` em `open/high/low/volume` (M-03). |
| Planos/índices | `test/performance.test.js` (script manual, não `node:test`, `:memory:`, ignora redundância) | Não usa `EXPLAIN QUERY PLAN`; não deteta índices redundantes (A-01) nem full scans (A-02/M-04); não faz benchmark do estado real de `DB.init()`. |
| Limites | — | Sem teste de `LIMIT` inválido/enorme (B-02), de `IN` acima de `SQLITE_MAX_VARIABLE_NUMBER` (M-05) ou de lotes acima de um cap. |
| Concorrência | `test/concurrency-sync.test.js` (skip sob node puro, `:46`) | Sem teste de `SQLITE_BUSY`/contenção writer+readers, WAL checkpoints ou abertura de ligação por ticker (M-06). |
| Caminhos N+1 | — | `checkListFreshness`, `purgeInactiveStocks`, `saveHistoricalCandlesBatch` pós-lote e `getStockDetailWithLatestPrice` não têm teste de contagem de queries/planos (M-01, M-02, M-10). |
| Deleções destrutivas | `test/database.test.js:107-147` | Sem verificação de transação longa/chunking (M-02, M-07). |

---

## Riscos residuais

1. **A-01/A-02/A-03 dependem do volume real.** As estimativas são analíticas a partir de planos; não foi executado benchmark com uma BD de produção (milhões de velas).
2. **M-06/M-07** não foram testados sob carga concorrente real (scanner + sync + simulação em paralelo); o `busy_timeout` de 5000 ms mitiga, mas transações longas (purge/delete index) continuam a poder causar `SQLITE_BUSY`/jank.
3. **M-03** só se manifesta com dados de entrada inválidos; a severidade depende de quão expostos estão os importadores/CSV a `NaN` (a UI atual pode filtrar antes).
4. **`src/main/main.js` e `src/ipc/ipcHandlers.js`** duplicam o entrypoint; um fix aplicado apenas a uma cópia não afeta a app em produção (I-04).
5. A auditoria de segurança assumiu que workers são confiáveis (recebem `dbPath` e nomes de método só do main). Se algum worker passar a receber payload de rede/renderer sem validação, os dispatchers (`main.js:177-288`, `:321-388`) reencaminham-nos para a BD sem validação adicional.

## Limitações

- Sondas executadas com dados sintéticos; `EXPLAIN QUERY PLAN` descreve o plano no estado atual, que pode mudar com estatísticas reais (`ANALYZE`).
- Não foi possível correr `test/performance.test.js`/`test/concurrency-sync.test.js` como suite por indisponibilidade do addon nativo sob `node` puro (comportamento pré-existente documentado em `test/concurrency-sync.test.js:46`); todas as verificações SQLite correram sob `ELECTRON_RUN_AS_NODE=1 electron`.
- Ficheiros fora do âmbito (`src/db/*`, `main.js`, `src/engine/*`, testes) foram lidos apenas na medida necessária para confirmar o uso da BD; não foram auditados a fundo.
- Nenhum ficheiro de código-fonte foi alterado.
