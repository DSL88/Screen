# Relatório PerfSec — Bridge Python (Node↔Python) e Scraping Wikipedia

- **Data:** 2026-09-10
- **Âmbito:** `src/services/pythonBridge.js`, `src/services/wikipediaScraper.js`, `python_engine/run_pipeline.py`, `python_engine/tracker_db.py`, `python_engine/api_data_loader.py`; leitura adicional de `scripts/run_quant_pipeline.py`, `src/features/*.py`, `renderer/*.js` e testes.
- **Modo:** somente leitura. Nenhum ficheiro de código-fonte foi alterado; apenas este relatório foi escrito.
- **Método:** análise estática manual com verificação de fluxos de dados (IPC → payload → subprocesso Python → stdout JSON → renderer) e revisão de testes existentes. Sem execução dinâmica, fuzzing ou medições instrumentadas.

## 0. Nota de arquitetura relevante

Apesar de o âmbito nomear `python_engine/run_pipeline.py`, a bridge **não** invoca esse ficheiro diretamente. `pythonBridge.js:34` invoca `scripts/run_quant_pipeline.py`, que por sua vez importa `execute_alpha_quant_engine` de `python_engine/run_pipeline.py` (`scripts/run_quant_pipeline.py:55-58`). Toda a análise cobre ambos.

Fluxo: `renderer` → IPC (`main.js:622-737`) → `PythonBridge.runPipeline(action, payload)` → `spawn(python, [scripts/run_quant_pipeline.py, '--action', action])` → payload escrito em **stdin** → Python imprime **um JSON** em stdout → Node faz `JSON.parse` da última linha `{...}`.

## 1. Resumo executivo

| Severidade | Nº |
|---|---|
| Crítico | 0 |
| Alto | 1 |
| Médio | 8 |
| Baixo | 7 |
| Informativo | 3 |

Não foi confirmada qualquer **command injection** (não há `shell: true`; os argumentos são passados em array) nem qualquer **SQL injection** (queries parametrizadas). O risco dominante é de **performance/disponibilidade** (processo Python novo + recarga do FinBERT em cada pedido, incluindo leituras triviais de SQLite) e de **robustez** (buffers sem limite, `stdin` sem tratamento de `EPIPE`, fallback sintético silencioso). O único achado de injeção confirmado é **DOM injection/XSS a jusante** no renderer da Fase 1, mitigado por CSP estrita (`script-src 'self'`, `sandbox: true`, `contextIsolation: true` em `main.js:511-513`).

---

## 2. Findings de Segurança

### PS-01 — [Médio] `stdin` do subprocesso sem tratamento de `error` (EPIPE) pode derrubar o processo principal

- **Confiança:** Confirmado (código); exploração depende de o Python terminar antes de consumir o payload.
- **Evidência:** `src/services/pythonBridge.js:64-71`
  ```js
  try {
    const payloadStr = JSON.stringify(payload || {});
    py.stdin.write(payloadStr);
    py.stdin.end();
  } catch (err) { ... }
  ```
  Não existe `py.stdin.on('error', ...)`. Em Node, a escrita num `stdin` de filho já terminado emite `error` **assíncrono** (EPIPE) no stream; um stream sem listener `error` lança exceção não capturada no processo principal do Electron. O `try/catch` só apanha erros síncronos.
- **Gatilho realista:** Python falha durante os imports (~pandas/torch/transformers) ou validação de `--action` e sai antes de ler `stdin`, com payload grande (ex.: `asset_meta` de centenas de tickers) ainda por drenar.
- **Impacto:** crash do main process (perda de estado, janela fecha, trabalho não guardado).
- **Correção mínima:** registar `py.stdin.on('error', err => { clearTimeout(timer); rejectOnce(err); })` e usar uma flag `settled` para garantir um único `resolve/reject` (o `close` e o timeout podem disparar depois).

### PS-02 — [Médio] DOM injection (XSS a jusante) na tabela da Fase 1 do quant renderer

- **Confiança:** Confirmado o sink; exploração mitigada por CSP.
- **Evidência:** `renderer/quantRenderer.js:825-843` interpola sem escape `s.ticker`, `s.sector`, `s.status`, `s.market_cap` (se string) e restantes campos:
  ```js
  tbody.innerHTML = p1.stocks.map((s) => `... <td>${s.sector}</td> ...`).join('');
  ```
  Em contraste, a tabela mestra escapa corretamente (`renderer/quantRenderer.js:441-445` e `:958-962`). Também `renderPhase5Purification` (`renderer/quantRenderer.js:983-996`) interpola `c.feature`/`c.status` sem escape (fonte atualmente constante no Python, mas sink reutilizável).
- **Fluxo dos dados não confiáveis:**
  - `python_engine/run_pipeline.py:188` — `sector` vem de `yfinance` (`info.get('sector')`), API externa.
  - `scripts/run_quant_pipeline.py:172-176` — no endpoint `run_fundamentals`, `ticker`/`sector` vêm de `params.stocks` fornecido via IPC pelo renderer.
  - `python_engine/run_pipeline.py:535-544` — o output devolve esses campos tal como extraídos.
  - `wikipediaScraper.js:60-65` — `cleanName` remove apenas `[...]`, não sanitiza markup; o nome é guardado em BD (`main.js:2860-2874`) e, embora seja renderizado com `escapeHtml` no renderer principal (`renderer/renderer.js:699`), continua a ser dado não validado persistido.
- **Impacto:** injeção de HTML/CSS no renderer. Com `script-src 'self'` e `sandbox: true`, a execução de JavaScript inline é bloqueada (`onerror=`, `<script>`), mas permanecem: alteração visual, links de phishing, `<meta http-equiv="refresh">` para navegar/exfiltrar, submissão de formulários (`form-action` não definido).
- **Correção mínima:** aplicar `escapeHtml()` a todos os campos interpolados em `renderPhase1Fundamentals` e `renderPhase5Purification`; preferir `textContent`/`document.createElement` para `ticker`, `sector` e `status`. Opcional: validar/sanitizar `sector` no `api_data_loader` (whitelist) e `name` no scraper.

### PS-03 — [Médio] Buffers de stdout/stderr sem limite (DoS de memória)

- **Confiança:** Confirmado.
- **Evidência:** `src/services/pythonBridge.js:52-54, 73-79` — `stdoutData += chunk.toString()` / `stderrData += chunk.toString()` sem limite. O `Error` de parse inclui `stdoutData.slice(0, 500)` (linha 108), mas a string completa permanece em memória até ao fim. `stderr` de bibliotecas (torch/transformers) pode ser volumoso.
- **Impacto:** um subprocesso que emita output contínuo (bug, warning loop, dado inesperado) esgota a memória do main process.
- **Correção mínima:** cap acumulado (ex.: 8 MB stdout / 256 KB stderr); ao exceder, `py.kill('SIGKILL')` e `reject` com erro explícito. Opcional: drenar e descartar stderr após o cap.

### PS-04 — [Médio] Fallback sintético silencioso transforma erros de API em dados “válidos”

- **Confiança:** Confirmado.
- **Evidência:** `python_engine/api_data_loader.py:220-224` e `:320-323` — qualquer exceção gera `_build_synthetic_asset()` e grava no cache com `"valid": True` e `"is_synthetic": True`. `python_engine/run_pipeline.py:204-221` faz o mesmo com `"valid": True`. O `except Exception` é amplo e não loga a causa.
- **Impacto:** falhas de rede/parsing passam a preços e fundamentais fabricados servidos como reais durante o TTL (24 h cotações / 30 dias fundamentais). Risco de integridade com consequência financeira; dificulta diagnóstico. `is_yahoo_live` só existe no fallback de `run_pipeline.py`, não no caminho do cache.
- **Correção mínima:** não persistir sintéticos em cache para falhas transitórias; marcar `valid: False`/`degraded: true` e propagar o erro; logar `warning` com ticker e exceção. Se se mantiver o fallback, expor `data_source: "synthetic"` no output e no UI.

### PS-05 — [Baixo] Fallback do interpretador para `python3`/`python` via PATH

- **Confiança:** Confirmado (código); exploração local.
- **Evidência:** `src/services/pythonBridge.js:19` — `return process.platform === 'win32' ? 'python' : 'python3';` usado em `spawn` (`:42`).
- **Impacto:** se o PATH (ou o CWD, na pesquisa de executáveis do Windows) contiver um binário hostil chamado `python`, este é executado com o payload do utilizador. Também causa falhas silenciosas se o venv não existir.
- **Correção mínima:** exigir o interpretador do venv (falhar com erro claro se ausente); usar caminho absoluto validado (`fs.realpathSync`) e `windowsHide: true` no `spawn`.

### PS-06 — [Baixo] Passagem integral de `process.env` ao subprocesso

- **Confiança:** Confirmado.
- **Evidência:** `src/services/pythonBridge.js:44-49` — `env: { ...process.env, ... }`.
- **Impacto:** segredos do ambiente (tokens HF, chaves cloud, proxies) ficam acessíveis a todo o código Python e às dependências de terceiros (`yfinance`, `transformers`); qualquer compromisso de supply-chain exfiltra credenciais. `QUANT_TRACKER_DB_PATH`/`QUANT_CACHE_DB` também são lidos do ambiente (`tracker_db.py:15`, `api_data_loader.py:24`), permitindo redirecionar a BD para um caminho arbitrário se o ambiente for controlado.
- **Correção mínima:** construir um env mínimo por whitelist (`PATH`, `HOME`, `LANG`, `SYSTEMROOT`, flags HF estritamente necessárias) e nunca injetar segredos.

### PS-07 — [Informativo] Command injection: não confirmada

- **Evidência:** não existe `shell: true`, `exec` nem interpolação de strings em comandos. `spawn(pythonPath, [scriptPath, '--action', action])` (`src/services/pythonBridge.js:41-42`) passa argumentos separados; `action` é mapeado a partir de constantes em `main.js:644-658` e validado por dicionário (`scripts/run_quant_pipeline.py:591-619`, com fallback para `run_full_pipeline`). `python_engine/run_pipeline.py:903-919` aceita `--payload`/JSON posicional, mas a bridge não os usa (o payload segue por stdin, não fica visível em `ps`).
- **Risco residual:** qualquer refactor futuro que introduza `shell: true` ou concatenação de `action`/payload reintroduz o problema. Manter teste de regressão que procure `shell: true` na bridge.

### PS-08 — [Informativo] SQL injection: não confirmada

- **Evidência:** todas as queries com input usam placeholders: `tracker_db.py:158-168`, `:172-182`, `:301-306`, `:311-317`, `:556`. O único `f-string` é `ALTER TABLE tracked_recommendations ADD COLUMN {col_name} {col_type}` (`tracker_db.py:105`), alimentado por lista estática (`:90-100`) — sem input externo. `pd.read_sql_query` usa strings constantes (`:342`). O filtro `status` de `get_all_tracked_recommendations` é parametrizado apesar de não validado.
- **Risco residual:** o parâmetro `db_path` (`get_connection`, `init_tracker_db`) e as env vars `QUANT_TRACKER_DB_PATH`/`QUANT_CACHE_DB` permitem escrever/ler qualquer ficheiro `.db` local; não há caminho a partir do renderer, mas é uma superfície a vigiar.

---

## 3. Findings de Performance

### PS-09 — [Alto] Processo Python novo (e recarga do FinBERT) em cada pedido; leituras SQLite também spawnam Python

- **Confiança:** Confirmado.
- **Evidência:**
  - `src/services/pythonBridge.js:29-50` — cada chamada faz `spawn` de um interpretador novo; imports pesados (`pandas`, `numpy`, `yfinance`, `transformers`, `torch`) em `python_engine/run_pipeline.py:31-77` e `python_engine/tracker_db.py:9-11` repetem-se em cada pedido.
  - `python_engine/run_pipeline.py:269` — `FinBERTSentimentAnalyzer()` é instanciado por execução; `src/features/sentiment.py:46-58` carrega `ProsusAI/finbert` (pesos na ordem das centenas de MB, com possível download no primeiro uso) antes de qualquer batch.
  - `main.js:721-737` — `quant:get-tracker-dashboard`, `quant:get-tracked-assets` e `quant:fetch-tracker-data` invocam a bridge (e portanto um interpretador + imports completos) apenas para consultar SQLite.
- **Impacto:** latência de arranque de segundos a dezenas de segundos por ação, picos de CPU/memória e concorrência de vários spawns se o utilizador clicar repetidamente; todas as leituras do tracker ficam desnecessariamente caras. É o maior ganho de performance disponível.
- **Correção mínima:** manter um **worker Python persistente** (JSON-RPC por stdin/stdout com delimitadores) iniciado uma vez, com o modelo FinBERT carregado lazy e reutilizado; separar ações “puras de BD” (`get_*_tracker*`) para `better-sqlite3` no Node, eliminando o spawn. Solução interina: limitar concorrência a 1 pipeline (`p-limit`, já disponível em `package.json`).

### PS-10 — [Médio] `evaluate_tracked_assets` é sequencial, sem cache, com commit único no fim

- **Confiança:** Confirmado.
- **Evidência:** `python_engine/tracker_db.py:243-250` — `for row in pending: yf.Ticker(ticker_symbol).history(period="1mo")` sequencial. `:327` — `conn.commit()` só no final. `:248` — usa 1 mês de histórico, não o intervalo desde `entry_date`, tornando `MFE/MAE`, `TARGET_ATINGIDO` e `days_to_exit` incorretos para recomendações com mais de um mês (`:259-297`).
- **Impacto:** com N pendentes, N pedidos Yahoo sequenciais; excede o timeout da bridge (`pythonBridge.js:32`, mínimo 120 s) e o `SIGKILL` (`:58`) descarta todas as atualizações da ronda (sem commit). Dados de tracking errados.
- **Correção mínima:** paralelizar com `ThreadPoolExecutor` (como em `api_data_loader.py:358`), `commit` por linha ou lotes pequenos, e usar histórico desde `min(entry_date, horizon)` (ex.: `start=entry_d` no `history`).

### PS-11 — [Médio] `save_to_cache` executa DDL (`init_db`) em cada escrita sob concorrência

- **Confiança:** Confirmado.
- **Evidência:** `python_engine/api_data_loader.py:129` — cada `save_to_cache` chama `init_db`, que abre conexão, executa `PRAGMA journal_mode = WAL`, `CREATE TABLE IF NOT EXISTS` e `PRAGMA table_info` (possível `ALTER TABLE`) antes de abrir **outra** conexão (`:130`) para o `INSERT` (`:134-137`). O `fetch_all_assets_parallel` submete até 15 workers (`:356-368`).
- **Impacto:** 15 threads a serializar DDL + escrita no mesmo ficheiro SQLite (WAL), com contenção de locks e overhead por ativo; o `busy_timeout` de 5 s mascara esperas.
- **Correção mínima:** remover `init_db()` de `save_to_cache` (já é chamado uma vez em `fetch_all_assets_parallel:341` e nos pontos de entrada) ou inicializar uma única vez por processo.

### PS-12 — [Médio] Leituras sem limite/paginação carregam a tabela inteira para memória

- **Confiança:** Confirmado.
- **Evidência:** `python_engine/tracker_db.py:384` — `SELECT * FROM tracked_recommendations ORDER BY id DESC` sem `LIMIT`; `:420-443` converte todas as linhas; `:547-558` idem para `get_all_tracked_recommendations`. `get_tracker_dashboard_data` é invocado a cada refresh da aba (`renderer/quantTrackerRenderer.js:102-131`).
- **Impacto:** memória e latência de serialização crescem linearmente com o histórico; o output JSON atravessa a bridge inteiro (stdout → string Node → objeto) multiplicando a memória.
- **Correção mínima:** paginar/filtrar no SQL (coorte, `status`, `LIMIT/OFFSET`) e calcular KPIs com agregações SQL (`COUNT`, `SUM`, `AVG`) em vez de listas Python.

### PS-13 — [Médio] `select.select` sobre `stdin` não funciona no Windows

- **Confiança:** Confirmado (comportamento documentado do `select` em pipes no Windows).
- **Evidência:** `scripts/run_quant_pipeline.py:580-589` — `select.select([sys.stdin], [], [], 0.1)` fora de `try/except`. No Windows, `select` só suporta sockets; um pipe de stdin eleva `OSError`, não capturado, antes de `handler(...)`. A bridge envia o payload por stdin (`pythonBridge.js:66-67`). O `package.json` prevê builds `win`.
- **Impacto:** todas as ações do pipeline falham no Windows (exit code 1 / stdout vazio → “Failed to parse Python JSON output”).
- **Correção mínima:** ler sempre `sys.stdin.read()` quando não for TTY (sem `select`), ou usar `msvcrt`/thread com timeout condicional à plataforma; envolver em `try/except`.

### PS-14 — [Baixo] Output JSON volumoso por ativo e ausência de streaming de progresso

- **Confiança:** Confirmado.
- **Evidência:** `python_engine/run_pipeline.py:570-574` devolve, por ativo, `paths_sample` (10 trajetórias), `transition_matrix_2nd_order` (9×3), `matrix_breakdown` (9 linhas) e vários campos duplicados; `:661-713` adiciona `chart_data`. A bridge não tem eventos de progresso — apenas `close` (`pythonBridge.js:86-110`) e acumula tudo.
- **Impacto:** para universos grandes (500-1000 ativos) o stdout cresce para vários MB; o Node mantém string + objeto parseado, e a UI fica sem feedback durante minutos.
- **Correção mínima:** remover/limitar campos pesados do output de lote (paths detalhados só sob pedido do drawer) e emitir linhas de progresso (`{"progress": ...}`) que a bridge consuma e reenvie por IPC.

### PS-15 — [Baixo] `get_model_accuracy_metrics` lê `SELECT *` e agrega em pandas

- **Confiança:** Confirmado.
- **Evidência:** `python_engine/tracker_db.py:342-361` — carrega todas as linhas/colunas e filtra `status` e PnL em pandas.
- **Impacto:** trabalho O(histórico) para obter 6 números.
- **Correção mínima:** agregação em SQL (`COUNT(*) FILTER`/`CASE WHEN`) devolvendo diretamente os totais.

### PS-16 — [Baixo] Timeout cresce sem limite com o número de tickers

- **Confiança:** Confirmado.
- **Evidência:** `src/services/pythonBridge.js:31-32` — `Math.max(timeoutMs || 300000, (tickerCount * 400) + 120000)`; `tickerCount` vem do payload sem validação (`:31`).
- **Impacto:** payload com um número absurdo de tickers mantém um Python vivo durante muito tempo (custo de CPU/memória local); sem limite máximo de universos no motor.
- **Correção mínima:** impor teto (ex.: 2000 tickers) antes do spawn e validar `Array.isArray(payload.tickers)`/tamanho no handler IPC.

### PS-17 — [Baixo] Séries sintéticas não determinísticas entre execuções

- **Confiança:** Confirmado.
- **Evidência:** `python_engine/run_pipeline.py:98`, `:173`, `:206`, `:328` e `python_engine/api_data_loader.py:147` usam `hash(ticker)` para `np.random.seed`. Em Python 3, `hash()` de strings é aleatorizado por processo (`PYTHONHASHSEED`).
- **Impacto:** os dados de fallback mudam a cada execução, quebrando reprodutibilidade, snapshots e comparações de tracking; também mascara os fallbacks (PS-04).
- **Correção mínima:** derivar a seed com `hashlib.sha256(ticker.encode()).digest()` (determinística).

### PS-18 — [Baixo] `allow_partial` ignorado no cache de cotações

- **Confiança:** Confirmado (lógica).
- **Evidência:** `python_engine/api_data_loader.py:104-120` — com `allow_partial=False` e apenas cotações válidas, a linha `if quotes_valid: return data` (`:119`) devolve dados mesmo assim, contradizendo a flag; `:111-112` e `:115` tornam o fluxo confuso.
- **Impacto:** consumidores que peçam dados completos recebem metade do cache sem saber; hoje `fetch_single_asset_api` passa sempre `allow_partial=True` (`:202`), pelo que o risco é latente.
- **Correção mínima:** devolver `data` apenas se `fundamentals_valid` quando `allow_partial=False`; documentar o contrato das flags.

---

## 4. Findings menores / informativos adicionais

- **Encoding/entidades no scraper:** `wikipediaScraper.js:113-136` usa `cheerio.text()`, que descodifica entidades; `cleanName` (`:60-65`) não remove markup. Não há sink explorável hoje porque os nomes são escapados no renderer principal (`renderer/renderer.js:699`), mas a validação de `name` deveria rejeitar `<`/`>`/controlo (defesa em profundidade). Os tickers estão bem protegidos pelo regex de `normalizeTicker` (`:75`).
- **`fetchWikipedia`:** o check `response.status >= 400` (`:153-157`) é inalcançável com axios default (rejeita 4xx/5xx); inofensivo, mas indica intenção não coberta por teste. `:187` loga `countryOrIndex` — input do utilizador em log local, risco nulo.
- **Validação de tipos no motor:** `python_engine/run_pipeline.py:244-248` faz `float()`/`int()` diretos sobre payload; valores inválidos geram exceção e exit 1 com stack em stderr (não vaza para o renderer, mensagem genérica). Recomenda-se validação com defaults.
- **Duplicação de código:** existem `main.js`/`src/main/main.js` e `src/ipc/ipcHandlers.js` com conteúdo aparentemente duplicado; a auditoria incidiu no entrypoint real (`package.json` → `main.js`). Divergências futuras entre cópias podem introduzir regressões de segurança.

---

## 5. Cobertura de testes (lacunas)

| Ficheiro | Cobre | Não cobre |
|---|---|---|
| `test/wikipedia.test.js` | Parsing de tabela, remoção de notas, deduplicação, sufixos, rejeição de símbolos perigosos, fallback determinístico em timeout/HTML vazio/índice desconhecido | Retry/backoff de `fetchWikipedia`, status HTTP explícitos, entidades/markup malicioso em `name`, limites de tamanho, XSS a jusante |
| `tests/test_api_data_loader.py` | `init_db`, save/get, TTL, sanitização de `debtToEquity`, `fetch_all_assets_parallel` | Escritas concorrentes/contensão WAL, comportamento de fallback sintético em exceção, JSON inválido no cache, `allow_partial` |
| `tests/test_tracker_db.py` | Init/save, métricas de acurácia, target hit/stop loss com yfinance mockado | Expiração por horizonte, `SQL` com input hostil, commit por linha, dashboard sem paginação, histórico > 1 mês |
| (nenhum) | — | `PythonBridge`: timeout, `SIGKILL`, EPIPE em stdin, JSON parcial/linha múltipla, limite de buffers, exit codes |
| (nenhum) | — | Renderer Fase 1/5: assert de que todos os campos passam por `escapeHtml` |

**Testes mínimos a acrescentar:** (1) `test/python-bridge.test.js` com um script Python falso que (a) sai antes de ler stdin, (b) emite > limite de stdout, (c) nunca termina; (2) teste do parser que confirme que `name`/`sector` hostis aparecem escapados no HTML; (3) teste Python de concorrência em `save_to_cache`.

---

## 6. Riscos residuais

1. **Supply chain do Python** (`yfinance`, `transformers`, `torch`) corre com ambiente completo e acesso à rede; um pacote comprometido contorna todas as mitigações Node/Electron.
2. **Fallback sintético** é o comportamento predefinido em falha; a menos que seja corrigido, qualquer auditoria de dados exige verificar `is_synthetic`/`is_yahoo_live`, que não estão expostos de forma uniforme.
3. **Worker persistente** (recomendado em PS-09) introduz um novo canal IPC próprio: precisará de validação de mensagens, timeouts por pedido e isolamento de erros para não se tornar ele mesmo uma superfície.
4. **CSP e sandbox** mitigam PS-02, mas qualquer alteração futura da política (`unsafe-inline`, remoção de `sandbox`) transforma DOM injection em XSS executável.

## 7. Limitações da auditoria

- Análise estática, sem execução do pipeline nem instrumentação de tempo/memória; as estimativas de impacto são qualitativas.
- Não foram auditadas as dependências de terceiros (versões/CVEs), o conteúdo de `.venv` nem o binário nativo (`build/`).
- O comportamento de `select` no Windows foi inferido da documentação, não testado no sistema alvo.
- Nos renderers, foi feita revisão dirigida aos sinks ligados a estes dados; outros módulos do renderer (fora do âmbito) não foram exaustivamente revistos.
- Existem cópias divergentes de `main.js`/`ipcHandlers.js`; a análise seguiu o entrypoint de `package.json` (`main.js`).
