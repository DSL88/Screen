# Relatório de Auditoria PerfSec — Importador CSV/XLSX

- **Agente:** `perfsec-importer`
- **Data:** 2026-09-10
- **Âmbito primário:** `src/importer/historicalImporter.js`, `src/services/marketDataService.js`, `src/utils/dateUtils.js`, `src/utils/progressThrottle.js`
- **Âmbito de apoio (leitura):** `src/db/database.js` (escrita/UPSERT), `main.js` (entry; callers IPC), `preload.js`, `renderer/renderer.js`, `test/importer.test.js`, `test/historical-candles.test.js`, `test/market-data.test.js`, `test/concurrency-sync.test.js`
- **Modo:** somente leitura; nenhum ficheiro de código-fonte alterado. Único artefacto escrito: este relatório.

## 1. Sumário executivo

| Severidade | # findings |
|---|---|
| Crítico | 0 |
| Alto | 4 |
| Médio | 9 |
| Baixo | 8 |
| Informativo | 4 |
| **Total** | **25** |

**Top 3 riscos:**

1. **SEC-01** — `xlsx@0.18.5` com CVE-2023-30533 (prototype pollution) e CVE-2024-22363 (ReDoS), sem correção disponível via npm, a processar ficheiros não confiáveis no processo principal Electron.
2. **SEC-02** — path traversal/leitura arbitrária de `.csv`/`.xlsx` via `payload.filePath` fornecido pelo renderer (`import-historical-data`).
3. **PERF-01/PERF-02** — transação SQL manual mantida aberta através de `await` na connection partilhada (rollback pode reverter escritas alheias) e parsing síncrono de ficheiro inteiro em memória no main thread (OOM/UI congelada).

As verificações de injeção SQL, prototype pollution no mapeamento de cabeçalhos da aplicação e avaliação de fórmulas no SheetJS concluíram **sem vulnerabilidade explorável na app** (ver SEC-09, SEC-10, MKT-03).

---

## 2. Findings

### 2.1 Alto

#### SEC-01 — Dependência `xlsx@0.18.5` vulnerável (prototype pollution + ReDoS), sem fix npm

- **Estado:** Confirmado (dependência/CVE) + Suspeita (escalada a RCE depende de gadget)
- **Evidência:** `package.json:33`; `src/importer/historicalImporter.js:184-189` (`xlsx.readFile` + `xlsx.utils.sheet_to_json` sobre ficheiro fornecido pelo utilizador).
- **Reprodução:** `npm audit --omit=dev` → `xlsx * Severity: high` com GHSA-4r6h-8v6p-xvw6 (Prototype Pollution, CVE-2023-30533, `< 0.19.3`) e GHSA-5pgg-2g8v-p4x9 (ReDoS, CVE-2024-22363, `< 0.20.2`); `"No fix available"` no npm porque `0.18.5` é a última versão publicada no registry.
- **Impacto:** um `.xlsx` manipulado pode poluir protótipos no processo principal (privilégios Node completos; RCE condicionada a gadgets) e/ou bloquear o main thread por ReDoS. O SheetJS deixou de publicar no npm, pelo que a vulnerabilidade não é corrigível por `npm audit fix`.
- **Correção mínima:** instalar SheetJS ≥ 0.20.3 via tarball oficial (`"xlsx": "https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz"`) ou migrar para `exceljs`; em paralelo, endurecer a chamada: `xlsx.readFile(p, { cellFormula: false, bookVBA: false, sheetRows: MAX_ROWS })`.

#### SEC-02 — Path traversal / leitura arbitrária de ficheiros via IPC

- **Estado:** Confirmado
- **Evidência:** `main.js:1440-1451` — handler `import-historical-data` aceita `payload.filePath` arbitrário e chama `parseFile` sem qualquer confinamento de diretório; `preload.js:157` expõe `importHistoricalData`; `src/importer/historicalImporter.js:245-260` só valida a extensão (`.csv`/`.xlsx`), não o path. Mesmo padrão em `main.js:1356-1373` (`import:bulk` aceita `filePath` ou `fileName`).
- **Impacto:** um renderer comprometido (XSS, DevTools, dependência injetada) consegue ler qualquer ficheiro `.csv`/`.xlsx` acessível ao utilizador e persisti-lo/exibi-lo via UI (exfiltração de dados). O `dialog.showOpenDialog` de `main.js:1509` não é o único caminho de entrada.
- **Correção mínima:** no main, canonicalizar (`fs.realpathSync`) e exigir prefixo de raízes permitidas (`app.getPath('userData')`, `documents`, `downloads`, `temp`); em alternativa, remover `filePath` da API pública e obter sempre o ficheiro via `dialog.showOpenDialog` no processo principal.

#### PERF-01 — Transação SQL manual aberta através de `await` na connection partilhada

- **Estado:** Confirmado
- **Evidência:** `src/importer/historicalImporter.js:307` (`BEGIN TRANSACTION`), `313` (`for await (const line of rl)`), `365` (`stmt.run`), `372` (`COMMIT`), `374-376` (`ROLLBACK`). Contraste com o padrão da BD: `src/db/database.js:392-407` e `1476-1493` usam `this.db.transaction(...)`.
- **Impacto:** a transação permanece aberta durante todo o streaming (muitos ticks do event loop). Outros handlers IPC (scanner, sync, trades) que escrevam na mesma connection entram nesta transação; se o import falhar, o `ROLLBACK` reverte escritas alheias (perda de dados). Em sentido inverso, um `BEGIN` concorrente lança `cannot start a transaction within a transaction`.
- **Correção mínima:** não manter transação sobre `await`: acumular lotes (ex. 5 000 linhas) e gravar cada lote com `db.saveBulkHistoricalCandles(batch)`/`db.transaction` (transações curtas), ou fazer parse completo e gravar sincronamente numa única transação.

#### PERF-02 — `parseFile` carrega tudo em memória e corre no main thread

- **Estado:** Confirmado
- **Evidência:** `src/importer/historicalImporter.js:135` (`fs.readFileSync(filePath, 'utf-8')`), `136` (`content.split(...)`), `155-179` (array de objetos por linha), `266-278` (segundo array + sort). Chamado em `main.js:1389` e `main.js:1451`. Não existe `fs.statSync`/limite de tamanho em nenhum ponto.
- **Impacto:** para um CSV grande, memória ≈ 3-4× o tamanho do ficheiro (string + linhas + rows + candles) e o main process fica bloqueado (UI congelada, sem progresso nem cancelamento efetivo). Vetor de DoS local com ficheiro volumoso.
- **Correção mínima:** usar o caminho streaming já existente (`importFromCsvFile`) também no `parseFile`, ou mover o parsing para `worker_threads`; impor `MAX_FILE_BYTES` com `fs.statSync().size` antes de ler.

### 2.2 Médio

#### SEC-03 — Ficheiro temporário previsível e sem limite a partir de `fileData`

- **Estado:** Confirmado
- **Evidência:** `main.js:1369-1373` — `tmpPath = path.join(os.tmpdir(), 'bulk-import-' + Date.now() + ext)` e `fs.writeFileSync(tmpPath, Buffer.from(payload.fileData))` sem flag `wx`; `renderer/renderer.js:5107-5119` envia `Array.from(uint8Array)` sem limite.
- **Impacto:** TOCTOU/symlink no diretório temporário (escrita fora do esperado em ambientes partilhados); payload IPC sem cap → esgotamento de memória/disco; `fileName` só é filtrado por `path.extname` (`main.js:1370`).
- **Correção mínima:** `fs.mkdtempSync(path.join(os.tmpdir(), 'bulk-import-'))` + `writeFileSync(..., { flag: 'wx' })`; rejeitar `fileData.length > MAX_FILE_BYTES`; validar `fileName` com `/\.(csv|xlsx)$/i`.

#### SEC-04 — Parser CSV sem suporte a aspas/escape

- **Estado:** Confirmado
- **Evidência:** `src/importer/historicalImporter.js:141-142` (`line.split(delimiter)`), `156-157`, `320`; mesmo padrão em `parseStooqCsv` (`src/services/marketDataService.js:198`).
- **Impacto:** campos citados que contenham o delimitador (ex. `"AAA;BBB"`) ou newlines quebram o alinhamento; valores podem ser truncados, desalinhados entre colunas ou abortar o import com "Inconsistência de colunas" (`historicalImporter.js:163-171`, `335-344`).
- **Correção mínima:** parser com máquina de estados (aspas duplas, escape `""`) ou dependência `csv-parse`; validar `values.length === colCount` e rejeitar a linha em vez de desalinhar.

#### SEC-05 — Datas calendaristicamente inválidas aceites e heurística dd/mm ambígua

- **Estado:** Confirmado
- **Evidência:** `src/importer/historicalImporter.js:119` — apenas `m < 1 || m > 12 || d < 1 || d > 31`; `2024-02-31` e `2023-02-29` passam. Heurística dd/mm em `84-108` é ambígua (`03/04/2024` é sempre interpretada `mm/dd`).
- **Impacto:** datas inexistentes persistidas em `historical_prices`, corrompendo séries, `first_date`/agregações MIN/MAX e ordenação; ficheiros PT com datas até 12 são interpretadas no formato americano sem aviso.
- **Correção mínima:** validar round-trip `Date.UTC(y, m-1, d)` e confirmar `getUTCFullYear/Month/Date`; restringir o ano (ex. `1900..2100`); documentar o formato esperado ou aceitar apenas ISO.

#### SEC-06 — `excelDateToJSDate` lança `RangeError` e aborta a importação inteira

- **Estado:** Confirmado
- **Evidência:** `src/importer/historicalImporter.js:56-61` (`new Date(utc_value * 1000).toISOString()` sem validação), invocado em `69-70`/`216`; efeito em `281-283` (`parseFile` devolve erro global) e `374-376` (ROLLBACK no import).
- **Impacto:** uma única célula numérica hostil/corrompida (ex. `1e15`, serial negativo) gera `Invalid Date` e `toISOString()` lança `RangeError: Invalid time value`; todo o ficheiro falha (DoS de disponibilidade, não apenas a linha).
- **Correção mínima:** validar `Number.isFinite(serial) && serial > 0 && serial < 2958466` e devolver `null` (linha skipped) em vez de deixar lançar.

#### PERF-03 — `parseXLSX` materializa todas as linhas sem limites

- **Estado:** Confirmado
- **Evidência:** `src/importer/historicalImporter.js:184-189` (`xlsx.readFile` + `sheet_to_json(worksheet, { defval: '' })` sem `sheetRows`), `203-210` (segundo array `normalizedData`).
- **Impacto:** pico de memória muito superior ao ficheiro comprimido; vetor de zip bomb/DoS, agravado por SEC-01.
- **Correção mínima:** `sheet_to_json(ws, { defval: '', blankrows: false, sheetRows: MAX_ROWS })`; cap de tamanho do ficheiro; validar `worksheet['!ref']`/dimensões antes de converter.

#### PERF-04 — IPC do bulk transporta bytes como array JSON

- **Estado:** Confirmado
- **Evidência:** `renderer/renderer.js:5107-5119` (`Array.from(uint8Array)`) e `main.js:1369-1373` (`Buffer.from(payload.fileData)`).
- **Impacto:** cada byte passa a número JS serializado (amplificação ~3-7× em memória/CPU) e a serialização IPC é lenta; sem cap de tamanho no renderer nem no main.
- **Correção mínima:** enviar `ArrayBuffer`/TypedArray (structured clone suporta-o) ou usar `MessagePort`; impor limite de tamanho no preload/main.

#### PERF-05 — Ordenação com `new Date(...)` por comparação

- **Estado:** Confirmado
- **Evidência:** `src/importer/historicalImporter.js:278` — `candles.sort((a, b) => new Date(a.date) - new Date(b.date))`, apesar de `cleanRow` (`216`, `236`) já produzir ISO `YYYY-MM-DD`.
- **Impacto:** 2 alocações de `Date` por comparação em O(n log n); desnecessário e mensurável em séries com centenas de milhares de velas.
- **Correção mínima:** `candles.sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0)` (a BD já o faz assim em `database.js:1462`).

#### PERF-06 — `INSERT OR REPLACE` por linha no import CSV

- **Estado:** Confirmado
- **Evidência:** `src/importer/historicalImporter.js:309-311` versus o UPSERT condicional de `src/db/database.js:374-385`.
- **Impacto:** cada colisão de `(ticker, date)` executa DELETE+INSERT (churn de índices e WAL, novo `rowid`, triggers), mais lento e incoerente com o resto da BD; perde a distinção entre inserção e atualização.
- **Correção mínima:** reutilizar `_stmtUpsertPrice`/`saveBulkHistoricalCandles` em vez do statement local.

#### DAT-01 — `addDays` aceita datas inválidas e não valida `days`

- **Estado:** Confirmado
- **Evidência:** `src/utils/dateUtils.js:1-10` — valida só o formato com regex; `new Date('2024-02-31T00:00:00Z')` rola para `2024-03-02`; com `days = NaN/undefined`, `setUTCDate(NaN)` torna a data inválida e a função devolve a string `"NaN-NaN-NaN"`.
- **Impacto:** datas roladas silenciosamente e strings inválidas propagadas para queries/BD (ex. cálculos de janelas, datas de entrada).
- **Correção mínima:** validar round-trip ISO no início e `if (!Number.isInteger(days)) return null;` antes de operar.

### 2.3 Baixo

#### SEC-07 — Ticker sem validação de charset/comprimento

- **Estado:** Confirmado
- **Evidência:** `src/importer/historicalImporter.js:346` (apenas `trim().toUpperCase()`); `src/db/database.js:44-46` (`canonicalTicker` trim/upper); `main.js:1380`, `main.js:1445`.
- **Impacto:** valores como `=cmd|' /C calc'!A1`, control chars ou strings de tamanho arbitrário são persistidos em `historical_prices`/`stocks`; poluição de BD e risco futuro de formula injection caso exista exportação (não encontrei export CSV/XLSX no código).
- **Correção mínima:** aplicar `/^[A-Z0-9._-]{1,24}$/` após uppercase e fazer skip/normalizar; sanitizar com prefixo `'` em qualquer export futuro.

#### SEC-08 — Logs de erro do import

- **Estado:** Confirmado (sem segredos)
- **Evidência:** `main.js:1426`, `main.js:1494`, `main.js:1551` (`console.error(... err.message)`); `src/importer/historicalImporter.js:282`.
- **Impacto:** mensagens podem incluir paths/nomes de ficheiros e, em erros de parser, fragmentos de dados importados; sem segredos confirmados.
- **Correção mínima:** logging estruturado sem interpolar conteúdo de linha (apenas índice da linha/coluna).

#### PERF-07 — Import CSV não valida OHLC nem atualiza metadata `stocks`/`first_date`

- **Estado:** Confirmado
- **Evidência:** `src/importer/historicalImporter.js:355-365` (só verifica `isNaN`; aceita `low > high`, preços ≤ 0 e volume negativo) e `288-380` (nunca chama `upsertStock`/`getStockHistorySummary`); contraste com `normalizeCandle` (`src/services/marketDataService.js:102-125`) e `saveHistoricalCandlesFromImport` (`src/db/database.js:1495-1504`).
- **Impacto:** velas incoerentes alimentam o motor quantitativo; o estado "1º Registo" fica desatualizado para imports feitos por esta via (`main.js:1525`).
- **Correção mínima:** reutilizar `normalizeCandle`/`cleanRow` com validação OHLC e atualizar `first_date` no final.

#### PERF-08 — `createProgressReporter` importado mas não usado; imports sem progresso

- **Estado:** Confirmado
- **Evidência:** `main.js:13` (import morto; `rg` não encontra qualquer chamada em `main.js`), `src/utils/progressThrottle.js:1-26`; `import-historical-csv` só emite `import-success` no fim (`main.js:1530-1538`).
- **Impacto:** a UI usa percentagens fixas (`renderer/renderer.js:5103-5111`) e fica estagnada em ficheiros grandes. Não há IPC por linha no import (bom), mas também não há progresso real.
- **Correção mínima:** remover o import morto ou ligar o reporter ao loop de import (emitir a cada N lotes), sem enviar eventos por linha.

#### DAT-02 — `isIncrementalUpToDate` compara strings sem validar formato

- **Estado:** Confirmado
- **Evidência:** `src/utils/dateUtils.js:12-16` — apenas `typeof === 'string'`; `'zzz' >= '2024-01-01'` devolve `true`.
- **Impacto:** um valor externo/corrompido pode marcar um ativo como atualizado e saltar o sync incremental.
- **Correção mínima:** validar ambos os operandos com regex ISO + round-trip antes da comparação.

#### DAT-03 — `getLastExpectedTradingDay` usa fuso local e ignora feriados

- **Estado:** Confirmado
- **Evidência:** `src/utils/dateUtils.js:18-37` (`getDay/getHours/getFullYear` locais, sem calendário de mercado); consumido em `src/db/database.js:1153-1155` para `card-synced`.
- **Impacto:** após feriados/bridge days a noção de "atualizado" pode estar errada (marca desatualizado como sincronizado ou vice-versa).
- **Correção mínima:** aceitar calendário de feriados ou data de referência injetável; documentar a heurística como limitação de produto.

#### MKT-01 — `fetchYahooHistory` exportada aceita ticker inválido → URL `.../null`

- **Estado:** Confirmado
- **Evidência:** `src/services/marketDataService.js:268-277` — `normalizeTicker` pode devolver `null` (`51-53`), mas o valor continua a ser usado no URL; `fetchStockHistory` protege-se (`317-327`), a API exportada não.
- **Impacto:** pedidos inválidos a Yahoo e logs ruidosos; não há injeção de URL (`encodeURIComponent` na linha 277).
- **Correção mínima:** lançar/devolver `INVALID_TICKER` quando `normalized` for `null`.

#### MKT-02 — Retry ignora `Retry-After`

- **Estado:** Confirmado
- **Evidência:** `src/services/marketDataService.js:230-258` — 429 é retryable mas o header nunca é lido; backoff fixo 250 ms → 1 s → 2 s (`DEFAULT_BACKOFF_MS`/`MAX_BACKOFF_MS`, linhas 5-7).
- **Impacto:** amplificação de rate limiting junto de Yahoo/Stooq em cenários de throttle.
- **Correção mínima:** usar `error.response.headers['retry-after']` (segundos ou data) quando presente, com clamp ao máximo.

### 2.4 Informativo (verificações limpas)

#### SEC-09 — Prototype pollution via cabeçalhos de coluna: não explorável na app

- **Evidência:** `normalizeHeader` reduz a `[a-z0-9]` (`src/importer/historicalImporter.js:19-25`); `colMap` e `normalized` usam apenas chaves constantes `REQUIRED_*` (`146-153`, `174-178`, `195-210`); `__proto__` normaliza para `proto` e não consta de `COLUMN_ALIASES` (`9-17`). O risco de PP vem da lib `xlsx` (SEC-01), não do mapeamento da aplicação.

#### SEC-10 — Injeção SQL: não encontrada

- **Evidência:** todos os acessos usam prepared statements com nomes de tabela/coluna constantes: `src/importer/historicalImporter.js:309-310,365`; `src/db/database.js:374-385`. `?` placeholders também em `database.js:1097-1102`, `1128-1137`. Não há construção de SQL com input do ficheiro.

#### PERF-09 — Throttle de progresso correto

- **Evidência:** `src/utils/progressThrottle.js:5-18` emite na 1ª chamada, a cada `everyN` ou `minIntervalMs`, e sempre com `isLast`; reset coerente (`20-23`). Coberto por `test/concurrency-sync.test.js:342-385` (4 cenários). Não há re-render por linha porque o importer não emite progresso (ver PERF-08).

#### MKT-03 — Parsing Yahoo/Stooq e construção de URL sem injeção

- **Evidência:** `normalizeCandle` rejeita OHLC inconsistente/negativo e volume inválido (`src/services/marketDataService.js:102-125`); `encodeURIComponent` nos URLs (`277`, `296`); `periodToUnix` valida datas inválidas/futuras (`208-222`); `dedupeCandles` O(n) com `Set` (`135-144`); metadata via chaves internas (`260-266`). Fórmulas em XLSX não são avaliadas pelo SheetJS (não há execução de fórmula; apenas valores em cache), e referências externas não são resolvidas na leitura.

---

## 3. Cobertura de testes e lacunas

- `test/importer.test.js:17-124`: cobre CSV EN/PT, decimal, formato europeu, inconsistência de colunas e UPSERT transacional.
  **Lacunas:** nenhum teste XLSX (não existe fixture `.xlsx` no repositório); path traversal/`filePath` fora de raízes permitidas; limites de tamanho; datas semanticamente inválidas (`31/02`, `29/02` não bissexto); serial Excel extremo (`RangeError`); CSV com aspas/escape; cabeçalhos duplicados/`__proto__`; BOM; ficheiro vazio; falha a meio do stream (verificar que o ROLLBACK não afeta terceiros).
- `test/historical-candles.test.js:31-188`: cobre a camada `database.js` (batch, UPSERT idempotente, `first_date`), mas não o importer nem `marketDataService`; não testa escrita concorrente durante um import.
- `test/market-data.test.js`: usa mocks de `axios`; contém `test.todo` para datas Stooq inválidas (`70`); sem testes de retry/backoff/`Retry-After`, `periodToUnix` com datas inválidas, `fetchYahooHistory` com ticker nulo, ou `normalizeTicker` desta camada (o `normalizeTicker` coberto em `test/yahoo-client.test.js:9-12` é de `src/data/yahooClient.js`).
- `test/concurrency-sync.test.js:342-385`: throttle testado em isolamento; sem teste de integração importer↔progresso.

**Regressão recomendada (mínima):** testes de path fora de raiz permitida, cap de tamanho, XLSX com `__proto__` (dependência atualizada), data `31/02`, serial `1e15`, CSV citado, e import concorrente com escrita de outro handler a garantir que o ROLLBACK não reverte dados alheios.

---

## 4. Riscos residuais e limitações

- **Análise estática.** Não executei ficheiros maliciosos reais (zip bomb, XLSX crafted para CVE-2023-30533). A exploração é inferida do advisory + uso direto de `readFile`/`sheet_to_json`. A escalada de prototype pollution a RCE é **suspeita** e depende de gadgets disponíveis no bundle Electron.
- **Entrypoint.** O repositório tem `main.js` (115 KB, entry em `package.json:5`), `src/main/main.js` e `src/ipc/ipcHandlers.js` (ficheiros idênticos entre si, 108 KB). Referenciei sempre `main.js`; se o build empacotar outro entry, os números de linha podem divergir.
- **Modelo de ameaça do renderer.** O impacto real de SEC-02/SEC-03 depende de o renderer poder ser comprometido (XSS/DevTools); não auditei CSP, `webPreferences` nem o renderer. As APIs expostas em `preload.js:54,156,157` são a superfície relevante.
- **Formula injection** é residual: não encontrei exportação CSV/XLSX no código (`rg` em `main.js`/`renderer/renderer.js`); deve ser tida em conta se for adicionada.
- **Concorrência da transação (PERF-01).** O lock `beginPipelineOperation` (`main.js:1355-1360`, `1520-1524`) impede dois imports simultâneos, mas não impede escritas de outros handlers durante o streaming.
- **`npm audit`** confirmado no ambiente: `undici` high (fora do âmbito deste relatório) e `xlsx` high sem fix npm.

---

## 5. Anexo — comandos de verificação

```bash
npm audit --omit=dev
# → xlsx * high: GHSA-4r6h-8v6p-xvw6 (Prototype Pollution), GHSA-5pgg-2g8v-p4x9 (ReDoS); No fix available

node -e "console.log(require('./node_modules/xlsx/package.json').version)"
# → 0.18.5

rg -n "require\\('xlsx'\\)" -g '!node_modules' .
# → ./src/importer/historicalImporter.js:185 (único ponto de entrada)
```
