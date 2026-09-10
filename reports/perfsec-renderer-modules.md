# Relatório Perf/Sec — Renderers Auxiliares (quantRenderer, simulationRenderer, quantTrackerRenderer, currency.js)

- **Data:** 2026-09-10
- **Âmbito:** `renderer/quantRenderer.js`, `renderer/simulationRenderer.js`, `renderer/quantTrackerRenderer.js`, `renderer/currency.js`
- **Contexto de carga:** `renderer/index.html:1855-1859` (`currency.js` → `renderer.js` → `simulationRenderer.js` → `quantRenderer.js` → `quantTrackerRenderer.js`); sem lazy-load dinâmico. `main.js:510-513` usa `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`.
- **Método:** revisão estática integral dos 4 módulos + pontos de interação em `renderer.js`/`index.html`. Sem alterações a código-fonte.

## Resumo por severidade

| Severidade | Nº |
|---|---|
| Crítico | 0 |
| Alto | 2 |
| Médio | 8 |
| Baixo | 7 |
| Informativo | 3 |
| **Total** | **20** |

---

## ALTO

### A-01 — Trade log sem paginação/virtualização e re-render integral por tecla — **Confirmado**
- **Evidência:** `renderer/simulationRenderer.js:479-505` (`renderTradesTable` mapeia *todas* as trades e faz `tbody.innerHTML = list.map(...).join('')`); gatilho de pesquisa `renderer/simulationRenderer.js:169-170` (`input` → render completo a cada tecla); sort `renderer/simulationRenderer.js:173-183`.
- **Impacto:** com milhares de operações (universo ALL / 20 anos), cada tecla re-parseia o HTML e recria todo o DOM — bloqueio/jank da UI Electron. Sem debounce, sem `documentFragment`, sem paginação.
- **Correção mínima:** debounce 150–250 ms na pesquisa; render paginado (`list.slice(page*100, ...)`) ou virtualização; reutilizar rows; aplicar sort/filter sobre índice memoizado.
- **Teste em falta:** em `test/simulation-unified-dashboard.test.js`, com 2.000 trades verificar nº de `<tr>` ≤ limite e debounce com fake timers.

### A-02 — Histórico do Tracker sem paginação + filtros sem throttle e sem guarda de concorrência — **Confirmado**
- **Evidência:** `renderer/quantTrackerRenderer.js:251-360` (`applyFiltersAndRenderTable` filtra tudo e faz `tbodyTracker.innerHTML = rowsHtml.join('')` na linha 359); input de pesquisa `renderer/quantTrackerRenderer.js:429-434`; recarga a cada clique de aba `renderer/quantTrackerRenderer.js:445-450`; dados completos via IPC `renderer/quantTrackerRenderer.js:73-100`.
- **Impacto:** O(n) de filtragem + full innerHTML rebuild a cada keystroke; o dataset cresce indefinidamente (uma linha por recomendação/dia). Combina com M-07 (respostas fora de ordem).
- **Correção mínima:** debounce na pesquisa; paginação/virtualização (ex.: 100 linhas); cache de filtros; guarda `loading`/geração em `loadTrackerDashboard`.
- **Teste em falta:** teste de paginação/filtragem com 5.000 recomendações e teste de corrida com respostas invertidas.

---

## MÉDIO

### M-01 — HTML injection por falta de escape nas Fases 1 e 5 — **Confirmado**
- **Evidência:** `renderer/quantRenderer.js:825-843` — `s.ticker`, `s.sector`, `formattedCap` (linha 828 mantém a string crua quando `market_cap` não é `number`), `s.quality_score`, `s.roa`, `s.debt_to_equity`, `s.earnings_yield`, `s.fcf_yield`, `s.status` interpolados sem `escapeHtml`. `renderer/quantRenderer.js:983-996` — `c.feature` (linha 988), `c.vif_raw`/`c.vif_purified` (989-990) e `c.status` (992) sem escape.
- **Impacto:** injeção de HTML/CSS com dados do worker/Yahoo/CSV em células de tabela. A execução de script inline está bloqueada pela CSP atual (`index.html:5-6`, `script-src 'self'`), mas `style-src 'unsafe-inline'` permite defacement/overlays e não há defesa em profundidade (DOM clobbering incluído). Escalaria para Alto/Crítico se a CSP fosse relaxada.
- **Correção mínima:** `escapeHtml(String(...))` em todos os campos string; formatar `market_cap` sempre via `Number(...)`; idealmente construir células com `textContent`.
- **Teste em falta:** payload `<img src=x onerror=alert(1)>` em `ticker`/`feature`/`status` e assert de que o `innerHTML` contém `&lt;img`.

### M-02 — HTML injection na matriz de patamares e nas opções de coorte (Tracker) — **Confirmado**
- **Evidência:** `renderer/quantTrackerRenderer.js:226-244` (`t.tier_label`, `t.status_calibration` e restantes campos interpolados crus); `renderer/quantTrackerRenderer.js:184-192` (`optionsHtml += '<option value="date_' + d + '">' + d + '</option>'`).
- **Impacto:** strings da BD/worker renderizadas como HTML em `<option>` e células; injeção/defacing; valor do `<option>` manipulável.
- **Correção mínima:** `escapeHtml` em `d` e nos campos de tier; validar `d` contra `^\d{4}-\d{2}-\d{2}$` antes de interpolar.
- **Teste em falta:** assert de escape em `test/ui-contract.test.js` (ou teste jsdom equivalente).

### M-03 — `innerHTML +=` com `r.from_pair` no renderDrawerMarkovMatrix — **Confirmado**
- **Evidência:** `renderer/quantRenderer.js:806-811` (concatenação de HTML dentro de `forEach`, `r.from_pair` na linha 807).
- **Impacto:** injeção HTML se `matrixBreakdown` vier do worker; reparse do contentor a cada iteração (n=9, custo menor).
- **Correção mínima:** `escapeHtml(r.from_pair)` e acumular numa única string (`join('')`) antes de atribuir a `innerHTML`.

### M-04 — Duplicação insegura de `renderTopRecommendations` em renderer.js mascarada pela ordem de carga — **Confirmado**
- **Evidência:** `renderer/renderer.js:5635-5728` interpola `asset.ticker` (5702), `asset.name` (5703), `asset.sector` (5705) e `tierLevel` (5711) sem escape; atribuição global em `renderer/renderer.js:6111`. `renderer/quantRenderer.js:321-324` chama o global; `renderer/quantRenderer.js:1037` substitui-o pela versão com escape. Ordem dos scripts: `renderer/index.html:1856-1858`.
- **Impacto:** a versão segura só é usada porque `quantRenderer.js` carrega depois; qualquer reordenação/erro de carga reativa o sink XSS em `renderer.js`.
- **Correção mínima:** remover a implementação duplicada de `renderer.js` (delegar para `window.renderMasterRecommendationsTable`) ou escapar a versão local.
- **Teste em falta:** em `test/ui-contract.test.js`, assert de que `asset.ticker/name/sector` passam por `escapeHtml` no caminho ativo.

### M-05 — `onSimulationFinished` não valida `runId` — resultado obsoleto sobrescreve o atual — **Confirmado**
- **Evidência:** `renderer/simulationRenderer.js:242-251`; contraste com `isCurrentRun` usado em `onProgress` (`215-216`) e `onError` (`263-264`).
- **Impacto:** com duas execuções (ou resposta atrasada), `activeSimulationReport` e o card resumo passam a mostrar dados de uma execução antiga.
- **Correção mínima:** `if (!isCurrentRun(data)) return;` no início de `onSimulationFinished`.

### M-06 — Reentrância de `handleRunPipeline` (duplo clique) — **Confirmado**
- **Evidência:** `renderer/quantRenderer.js:211-236` — `await fetchMyListTickers()` (225) acontece **antes** de `btnRun.disabled = true` (230); sem flag de execução em curso.
- **Impacto:** dois pipelines concorrentes (5.000 caminhos MC cada), escritas de status sobrepostas e renders duplicados.
- **Correção mínima:** flag `running`/`disabled` no primeiro statement, antes de qualquer `await`.
- **Teste em falta:** teste com dois cliques síncronos a garantir uma única chamada ao IPC.

### M-07 — `loadTrackerDashboard` sem guarda de concorrência — **Confirmado**
- **Evidência:** `renderer/quantTrackerRenderer.js:102-131`; chamado no clique da aba a cada clique (`445-450`) e no refresh (`408`); sem `runId`/sequência.
- **Impacto:** respostas IPC fora de ordem sobrescrevem os dados mais recentes (`cachedDashboardData`); pedidos duplicados.
- **Correção mínima:** flag `loading` + contador de geração; ignorar respostas de gerações antigas.
- **Teste em falta:** teste de corrida com duas promises invertidas a garantir que vence a última geração.

### M-08 — CSV formula injection no export de trades — **Confirmado**
- **Evidência:** `renderer/simulationRenderer.js:507-518` — apenas duplica aspas (`513`); campos iniciados por `=`, `+`, `-`, `@`, tab ou CR permanecem fórmulas (`t.ticker`, `t.reason`, etc.).
- **Impacto:** execução de fórmulas no Excel/LibreOffice de quem abre o CSV exportado.
- **Correção mínima:** prefixar `'` (ou tab) quando o valor casar `^[=+\-@\t\r]` antes da marcação com aspas.
- **Teste em falta:** export com `reason: '=cmd|...'` e assert do prefixo.

---

## BAIXO

### B-01 — Progresso da simulação sem throttle/rAF — **Confirmado**
- **Evidência:** `renderer/simulationRenderer.js:215-224` (`onProgress`) → `226-240` (~10 escritas DOM por evento).
- **Impacto:** layout thrash e backlog IPC em execuções com muitos tickers.
- **Correção mínima:** coalescer eventos num único `requestAnimationFrame` (guardar último estado e pintar 1×/frame).

### B-02 — `.toFixed()` sobre campos possivelmente `undefined` — **Confirmado**
- **Evidência:** `renderer/simulationRenderer.js:396` (`y.winRate`, `y.maxDrawdownPct`, `y.sharpe`); `renderer/simulationRenderer.js:407` (`row.winRateReal`, `row.winRateTheoretical`, `row.alpha`).
- **Impacto:** `TypeError` interrompe o render do modal inteiro com anos/patamares parciais.
- **Correção mínima:** `Number(x ?? 0).toFixed(n)`.

### B-03 — Chart.js não destruído no fecho/troca de aba; criação em painéis ocultos — **Confirmado**
- **Evidência:** `renderer/simulationRenderer.js:357-360` (fechar só aplica `hidden`; `destroy` só na abertura seguinte, `430-431`); `renderer/quantRenderer.js:136-142` esconde painéis e `860-929` cria charts mesmo com o painel `display:none`.
- **Impacto:** retenção de memória/listeners de resize (limitada a 2-4 instâncias); gráficos podem ficar a 0 px até um resize da janela.
- **Correção mínima:** `destroy()` no fecho do modal e `chart.resize()` ao mostrar o painel em `handleSubnavSwitch`.

### B-04 — Código morto `renderDrawerMonteCarloChart` / `drawerChartInstance` — **Confirmado**
- **Evidência:** `renderer/quantRenderer.js:12` e `687-767`; procura `#drawer-mc-chart`, que não existe em `index.html` (existe `drawer-montecarlo-canvas` em `index.html:1676`); nunca é chamada. Se ativada, cria Chart.js sobre o canvas já desenhado por `renderer.js:5962-5963`.
- **Impacto:** latente — dois renderizadores no mesmo canvas e instância nunca destruída.
- **Correção mínima:** remover a função/variável ou ligá-la ao canvas correto com `destroy` consistente.

### B-05 — `setTimeout` no tracker sem cleanup — **Confirmado**
- **Evidência:** `renderer/quantTrackerRenderer.js:388-392`.
- **Impacto:** callback pode escrever em UI já trocada; múltiplos timers se houver re-init.
- **Correção mínima:** guardar o id e limpar no início/fim de `handleUpdateTrackerPrices`.

### B-06 — Cópia duplicada do módulo de simulação — **Confirmado**
- **Evidência:** `renderer/simulationRenderer.js` e `src/renderer/js/simulationRenderer.js` idênticos (29.009 bytes); a app carrega `renderer/` (`index.html:1857`) mas o teste de ciclo de vida requer `src/` (`test/simulation-unified-dashboard.test.js:173-174`), enquanto asserts estáticos leem `renderer/` (`test/simulation-unified-dashboard.test.js:60`).
- **Impacto:** edições podem divergir; o teste de comportamento valida uma cópia diferente da embarcada.
- **Correção mínima:** fonte única (re-export/shim) ou teste que compare os dois ficheiros por hash.

### B-07 — KPIs sem fallback ("undefined%") — **Confirmado**
- **Evidência:** `renderer/quantTrackerRenderer.js:140, 144, 152, 158, 163-166`.
- **Impacto:** UI mostra `undefined%`, `undefinedx`, `undefined d` com payloads parciais.
- **Correção mínima:** normalizar com `Number(v ?? 0)` antes de interpolar.

---

## INFORMATIVO

### I-01 — Mitigações verificadas (reduzem a severidade de XSS)
- CSP `script-src 'self'` em `renderer/index.html:5-6` e `contextIsolation/nodeIntegration/sandbox` em `main.js:510-513` bloqueiam execução de scripts inline e `onerror=`.
- Não foram encontrados `eval`, `new Function`, `setTimeout(string)`, `insertAdjacentHTML`, `document.write` nem `outerHTML` nos 4 ficheiros.
- Erros da worker são apresentados por `textContent`/`alert`, não como HTML: `renderer/quantRenderer.js:297-298`, `renderer/simulationRenderer.js:265-272, 282-287`; tracker só faz `console.error` (`renderer/quantTrackerRenderer.js:96-99`).
- **Consequência:** M-01..M-04 ficam como injeção HTML/CSS; sem esta CSP seriam Críticos.

### I-02 — Tooltips/canvas e currency.js — neutros
- Tooltips Chart.js usam apenas strings fixas/números: `renderer/quantRenderer.js:746-748, 761`; `renderer/simulationRenderer.js:455-464`. Sem callbacks que injetem HTML.
- `renderer/currency.js:78-88` devolve sempre `Number.toFixed(2)` + símbolo de um conjunto fixo (`€ £ $ kr CHF ¥ zł C$`); a leitura de `country/ticker/index` (`4-74`) não devolve input do utilizador, pelo que o output é seguro para interpolar.

### I-03 — Lacunas de teste (sugestões concretas)
1. `test/simulation-unified-dashboard.test.js`: trade com `<img src=x onerror=alert(1)>` → assert que `tbody-trades-log.innerHTML` contém `&lt;img`.
2. `test/ui-contract.test.js`: asserts de `escapeHtml` nos renders de Fase 1/5 (`quantRenderer.js`) e na matriz/coortes (`quantTrackerRenderer.js`).
3. Teste de limite/paginação: 2.000 trades/recomendações → nº de `<tr>` ≤ limite; debounce com fake timers.
4. Teste de corrida: `loadTrackerDashboard` e `onSimulationFinished` com respostas fora de ordem → vence a última geração.
5. Teste de reentrância: dois cliques em `#btn-run-unified-quant` → um só IPC.
6. Teste CSV: `=cmd|...` → prefixo `'`.

---

## Riscos residuais

1. **Dependência da ordem de `<script>`:** a versão segura de `renderTopRecommendations` depende de `quantRenderer.js` carregar depois de `renderer.js` (M-04). Qualquer bundling/refactor pode reverter isso.
2. **Dados externos não validados na origem:** worker/Yahoo/CSV podem introduzir strings arbitrárias; a defesa atual é apenas a CSP e o escape “algures” — inconsistente entre fases.
3. **Crescimento do tracker:** sem retenção/paginação, o custo tende a degradar com o tempo de utilização.
4. **CSP como única barreira dos sinks M-01..M-04:** alterações futuras (ex.: `unsafe-inline` por necessidade de estilos/scripts) escalam a severidade sem qualquer alteração nos renderers.

## Limitações da auditoria

- Análise **estática**: não executei a app Electron nem fiz profiling real; as severidades de performance são estimativas dependentes do volume de dados.
- Não auditei os produtores dos dados (worker/CSV/Yahoo), pelo que o grau real de controlo de um atacante sobre as strings não foi verificado.
- `renderer/chart.umd.js` (biblioteca vendorizada) não foi auditado; versão não identificada.
- `renderer.js` foi analisado apenas nos pontos de interação (shadowing de funções globais, canvas do drawer); o resto está fora do âmbito.
- Não foram analisados `preload.js`/`main.js` além de `webPreferences`, nem as permissões efetivas expostas pelo preload (impacto potencial de um XSS não trivial de medir).
- Sem teste dinâmico de CSP (não confirmei experimentalmente o bloqueio de `onerror` neste build).
