# Auditoria PerfSec — renderer/renderer.js

- **Papel**: auditor sénior de segurança frontend e performance (modo somente-leitura).
- **Âmbito**: `renderer/renderer.js` (6122 linhas). Confirmação de fluxo a montante com leituras pontuais de `renderer/quantRenderer.js`, `renderer/currency.js`, `renderer/index.html`, `preload.js` e `main.js`.
- **Data**: 2026-09-10
- **Modelo de ameaça**: dados Yahoo Finance, Wikipedia, CSV/XLSX importado e SQLite tratados como não confiáveis; IPC via `preload.js` como fronteira de confiança.
- **Contexto de isolamento verificado**: `main.js:511-513` → `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`.
- **CSP verificada**: `renderer/index.html:5-6` → `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' ...`. Sem `'unsafe-inline'`/`'unsafe-eval'` para scripts, o que **bloqueia handlers inline** (`onerror=`, `javascript:`) injetados. Isto reduz o impacto de XSS de execução de código para injeção de HTML/atributos (defacement, phishing, DOM clobbering), mas os sinks continuam confirmados.

## Sumário por severidade

| Severidade | Segurança | Performance | Total |
|---|---|---|---|
| Crítico | 0 | 0 | 0 |
| Alto | 1 | 1 | 2 |
| Médio | 4 | 3 | 7 |
| Baixo | 3 | 3 | 6 |
| Informativo | 2 | 2 | 4 |

Confirmados e suspeitas estão distinguidos em cada finding. Nenhum `eval`, `new Function`, `document.write`, `insertAdjacentHTML`, `outerHTML`, `postMessage`, `window.open`, `localStorage`/`sessionStorage` ou URL `javascript:` foi encontrado em `renderer.js` (grep global). Todos os sinks relevantes são `innerHTML`/templates HTML.

---

## Segurança

### S1 — Alto — XSS/HTML injection no Top Buy List (`renderTopRecommendations`)
- **Evidência** (`renderer/renderer.js:5698-5706`):
  ```js
  tr.innerHTML = `
    ...
    <td ...>${asset.ticker}</td>                       // 5702 (raw)
    <div ... title="${asset.name || asset.ticker}">    // 5703 (raw em atributo)
      ${asset.name || asset.ticker}</div>
    <td ...>${asset.sector || 'Outros'}</td>            // 5705 (raw)
  ```
- **Fluxo a montante**: `window.renderTopRecommendations` (export em `renderer.js:6111`) recebe `recList` do pipeline Python (`renderer/quantRenderer.js:311-322` → `data.top_recommendations`), que inclui `ticker`, `name`, `sector` derivados de Yahoo/DB — não confiáveis pelo briefing.
- **Fator atenuante (reachability)**: em produção, `renderer/quantRenderer.js:1037` reatribui `window.renderTopRecommendations = renderMasterRecommendationsTable`, cuja versão **escapa** os campos (`quantRenderer.js:441-445`, `safeTicker/safeName/safeSector`). A função vulnerável de `renderer.js` fica sombreada e sem chamadas internas — sink latente (basta falha/ordem diferente dos scripts para voltar a ficar ativo).
- **Impacto**: injeção de HTML/atributos no tbody do workstation; com CSP atual não executa script inline, mas permite markup arbitrário, phishing, quebra de layout e DOM clobbering. Sem CSP, é XSS direto.
- **Correção mínima**: usar `escapeHtml` em todos os campos interpolados, tal como na versão de `quantRenderer.js`, ou remover a função duplicada de `renderer.js` para eliminar código morto perigoso (a outra implementação já é a ativa).
- **Confirmação**: sink confirmado; exploração condicionada ao shadowing.

### S2 — Médio — DOM XSS por round-trip em `data-mc-tooltip` → `innerHTML`
- **Evidência**: escrita com escape
  ```js
  // renderer/renderer.js:2225 e 2233
  'Classificação: ' + (r.mcLabel || tierLabel),
  '<span class="mc-pill ..." data-mc-tooltip="' + escapeHtml(tooltipLines.join('\\n')) + '" ...>'
  ```
  leitura sem escape:
  ```js
  // renderer/renderer.js:2374
  tip.innerHTML = badge.dataset.mcTooltip.replace(/\\n/g, '<br>');
  ```
- **Porquê é falha**: o valor é escrito escapado no atributo, mas o parser HTML **descodifica** as entidades ao construir o DOM; `dataset.mcTooltip` devolve os caracteres originais (`<`, `>`, `&`), que voltam a ser interpretados como HTML no `innerHTML`. O `escapeHtml` de escrita é assim anulado.
- **Fluxo a montante**: `r.mcLabel` vem do scanner (`src/engine/scanner.js:186` / `src/engine/scanner.worker.js:344`); atualmente os valores são constantes de tier (`src/native/index.js:39-41`, `src/quant/monteCarloEngine.js`), pelo que não há payload conhecido — sink confirmado, fonte atualmente constante (defesa em profundidade).
- **Impacto**: se `mcLabel` (ou qualquer linha do tooltip) passar a conter HTML, executa no renderer; com CSP atual sem execução de handlers inline, permite pelo menos injeção de markup no tooltip.
- **Correção mínima**: no sink, não reabrir HTML — usar `tip.textContent = badge.dataset.mcTooltip` e obter as quebras de linha com CSS (`white-space: pre-line`) ou construir `<br>` com `createElement`/`textContent`.
- **Confirmação**: confirmado (padrão de escape anulado).

### S3 — Médio — `freshnessBannerMessage.innerHTML` com datas de SQLite não escapadas
- **Evidência** (`renderer/renderer.js:2808-2817`):
  ```js
  const expectedDateFormatted = freshness.expectedDate
    ? freshness.expectedDate.split('-').reverse().join('-') : '—';
  const maxDateFormatted = freshness.maxStoredDate
    ? freshness.maxStoredDate.split('-').reverse().join('-') : '—';
  freshnessBannerMessage.innerHTML =
    `${iconSvg('alert-triangle')} ... (dados até <strong>${maxDateFormatted}</strong>, ... <strong>${expectedDateFormatted}</strong>). ...`;
  ```
- **Fluxo a montante**: `freshness` vem de `window.api.checkListFreshness` (`preload.js:74`) → `main.js:1945` `db.checkListFreshness()` → SQLite (dados originalmente Yahoo/CSV).
- **Porquê é falha**: um valor que não tenha exatamente o formato `YYYY-MM-DD` (ex.: `<img src=x onerror=...>`) passa intacto pelo `split('-')/reverse()/join('-')` e é interpolado sem `escapeHtml`.
- **Impacto**: injeção de HTML/atributos no banner de freshness (execução de script bloqueada pela CSP atual; markup/phishing caso a CSP mude).
- **Correção mínima**: `escapeHtml(maxDateFormatted)`/`escapeHtml(expectedDateFormatted)` na interpolação, ou construir o banner com `textContent` nos nós `<strong>`.
- **Confirmação**: confirmado.

### S4 — Médio — Data de dividendos crua no `innerHTML` (fallback de `formatEuropeanDate`)
- **Evidência**:
  ```js
  // renderer/renderer.js:3890-3897
  tbody.innerHTML = data.dividends.map(d => `
    <tr ...>
      <td ...>${formatEuropeanDate(d.date)}</td>
      <td ...>${Number(d.amount).toFixed(4)} €/$</td>
  ```
  ```js
  // renderer/renderer.js:3847-3851
  function formatEuropeanDate(dateStr) {
    if (!dateStr) return '--';
    const parts = String(dateStr).slice(0, 10).split('-');
    return parts.length === 3 ? `${parts[2]}-${parts[1]}-${parts[0]}` : dateStr;  // devolve raw!
  }
  ```
- **Fluxo a montante**: `api.getStockDividends` (`preload.js:58`) → `main.js:1637` `db.getStockDividends()` → SQLite (ingerido de Yahoo/CSV).
- **Porquê é falha**: quando `d.date` não é `YYYY-MM-DD`, o fallback devolve a string original, injetada sem escape.
- **Impacto**: injeção de HTML no modal de dividendos (mitigada para execução pela CSP; markup/phishing).
- **Correção mínima**: `escapeHtml(formatEuropeanDate(d.date))` ou alterar o fallback para devolver `'--'`/texto sanitizado; preferir `textContent` na célula.
- **Confirmação**: confirmado.

### S5 — Médio — `r.direction` cru em classe e conteúdo de célula
- **Evidência** (`renderer/renderer.js:2202`):
  ```js
  <td class="col-dir"><span class="dir-badge dir-${r.direction}">${r.direction}</span></td>
  ```
- **Fluxo a montante**: `scan:row` (`renderer.js:2896-2899`) → engine (`src/engine/scanner.js:186` `direction: result.direction`), valor calculado `COMPRA`/`VENDA`, não proveniente diretamente de Yahoo.
- **Porquê é falha**: o valor não é validado/enumerado no renderer; um valor com `"` e atributos extra quebra o template (`class="dir-badge dir-x" onclick="...">`), quer na célula quer no `appendRow`/`renderAllRows`.
- **Impacto**: injeção de atributos/markup na tabela do scanner; com item controlado a montante, XSS em contextos sem a CSP atual.
- **Correção mínima**: validar `direction` contra `['COMPRA','VENDA']` (fallback `'—'`) e usar `escapeHtml`; melhor ainda aplicar uma classe calculada localmente.
- **Confirmação**: confirmado (defesa em profundidade).

### S6 — Baixo — `tr.direction` cru apenas na classe (backtest)
- **Evidência** (`renderer/renderer.js:3116-3125`):
  ```js
  <td><span class="dir-badge dir-${tr.direction}">${escapeHtml(tr.direction)}</span></td>
  ```
- **Análise**: o texto é escapado, mas a classe não — inconsistência que permite quebra do atributo via `"` (ex.: `direcao: 'x" onclick="...'`). Dados do backtest vêm do main (`runBacktestSimulation`), novamente calculados.
- **Correção mínima**: validar a direção contra o enum ou usar `escapeHtml` também na classe.
- **Confirmação**: confirmado (baixo alcance).

### S7 — Baixo — `openConfirmModal` injeta `cfg.message` como HTML
- **Evidência** (`renderer/renderer.js:3757`):
  ```js
  if (confirmMessage) confirmMessage.innerHTML = cfg.message;
  ```
- **Análise**: helper aceita HTML por desenho. Todas as chamadas atuais escapam os valores interpolados (`1284`, `2133`, `3399`, `3438`, `3701`, `4844`) — logo não há exploração atual; é um risco latente para futuras chamadas com dados de IPC/DB.
- **Correção mínima**: mudar o contrato para `textContent` + lista de segmentos (ou exigir `escapeHtml` obrigatório num wrapper), mantendo os `<strong>` atuais via `createElement`.
- **Confirmação**: suspeita/latente (sem caminho explorável hoje).

### S8 — Baixo — `emptyStateRowHtml` interpola `title`/`desc` crus
- **Evidência** (`renderer/renderer.js:546-553`):
  ```js
  '<div class="empty-state-title">' + title + '</div>' +
  '<div class="empty-state-desc">' + desc + '</div>' +
  ```
- **Análise**: todos os call sites atuais (`2259`, `2948`, `3360`, `3377`, `3600`, `3608`) passam literais estáticos; helper perigoso se reutilizado com texto dinâmico.
- **Correção mínima**: `escapeHtml(title)`/`escapeHtml(desc)` no helper (defensivo).
- **Confirmação**: suspeita (sem fonte dinâmica hoje).

### S9 — Informativo — `res.count` cru em `assetImportSuccess.innerHTML`
- **Evidência** (`renderer/renderer.js:5140`):
  ```js
  assetImportSuccess.innerHTML = `✓ ${res.count} velas importadas para <strong>${escapeHtml(activeTicker)}</strong>`;
  ```
- **Análise**: `activeTicker` está escapado; `res.count` vem do main (`main.js` importBulk, tipicamente numérico). Se o contrato IPC devolver string, há injeção.
- **Correção mínima**: `Number(res.count) || 0` ou `escapeHtml(res.count)`.
- **Confirmação**: suspeita.

### S10 — Informativo — `escapeHtml` não cobre `'` nem backtick
- **Evidência** (`renderer/renderer.js:522-528`):
  ```js
  function escapeHtml(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }
  ```
- **Análise**: suficiente hoje porque todos os atributos usam aspas duplas, mas frágil (qualquer futuro template com `'` quebra o invariante). Não é vulnerabilidade ativa.
- **Correção mínima**: acrescentar `.replace(/'/g, '&#39;')` e, se aplicável, `` .replace(/`/g, '&#96;') ``.
- **Confirmação**: informativo.

---

## Performance DOM

### P1 — Alto — `appendRow` O(n²) e append individual durante o scan
- **Evidência** (`renderer/renderer.js:2182-2193`, `2237`):
  ```js
  function appendRow(r) {
    const placeholders = body.querySelectorAll('tr.empty, tr.skeleton-row'); // 2183 — por cada linha
    if (placeholders.length) placeholders.forEach(el => el.remove());
    scannerRows.push(r);
    if (!currentSort.column) {
      if (passesMcFilter(r)) renderRowToDOM(r, body.children.length);          // 2190 — layout read
    }
  }
  ...
  body.appendChild(tr);                                                        // 2237 — layout write
  ```
  Invocado em cada evento `scan:row` (`2896-2899`).
- **Impacto**: com N linhas emitidas, o `querySelectorAll` percorre a tabela inteira N vezes → O(N²) em nós; a alternância leitura (`children.length`) / escrita (`appendChild`) força reflow por linha. Em watchlists grandes (centenas/milhares de tickers) provoca jank/bloqueio da UI do renderer durante o scan.
- **Correção mínima**: remover placeholders uma única vez antes do primeiro append (flag ou remover em `clearTable`), acumular linhas num `DocumentFragment` e anexar por `requestAnimationFrame`/lote (ex.: a cada 50 linhas), e usar `scannerRows.length` em vez de `body.children.length`.
- **Confirmação**: confirmado por inspeção.

### P2 — Médio — `renderWatchlist` reconstrói toda a lista em cada toggle/adição
- **Evidência** (`renderer/renderer.js:612-728`, toggle em `668-675`):
  ```js
  header.addEventListener('click', () => {
    if (collapsedGroups.has(key)) collapsedGroups.delete(key); else collapsedGroups.add(key);
    renderWatchlist();               // rebuild total + re-bind de listeners
  });
  ```
  e `725-727` reaplica `filterMyList` no fim de cada render.
- **Impacto**: colapsar/expandir um índice, adicionar/remover um ticker ou refrescar o dia esperado (`587`) reconstrói todos os grupos/itens e volta a fazer `querySelector`/`addEventListener` por item; com pesquisa ativa, faz ainda uma segunda passagem O(N).
- **Correção mínima**: no toggle, apenas alternar `itemsContainer.classList.toggle('is-hidden')`; remover itens com `item.remove()`; delegar o clique do botão `.wl-remove` no contentor `watchlistEl` (à semelhança do já feito em `171-213`), eliminando N listeners por render.
- **Confirmação**: confirmado.

### P3 — Médio — `filterMyList` sem debounce em cada tecla
- **Evidência** (`renderer/renderer.js:404-409` liga `input` diretamente; `334-337`, `355-367`):
  ```js
  myListSearchInput.addEventListener('input', (e) => { ... filterMyList(v); });
  const items = watchlistEl.querySelectorAll('.watchlist-item');
  const headers = watchlistEl.querySelectorAll('.watchlist-group-header');
  const groups  = watchlistEl.querySelectorAll('.watchlist-group-items');
  const cards   = watchlistEl.querySelectorAll('.watchlist-group-card');
  ...
  const symbol = item.querySelector('.wl-symbol'); const name = item.querySelector('.wl-name');
  ```
- **Impacto**: 4 queries globais + 2 queries por item (O(N)) a cada tecla, forçando estilo/layout; contraste com a pesquisa de tickers que usa debounce de 280 ms (`2333`).
- **Correção mínima**: debounce de ~120 ms no handler; guardar `symbolText/nameText` em `dataset` no momento do render para evitar `querySelector`/`textContent` por item; aplicar filtro com classes já existentes (`is-filtered-out`) é aceitável se o custo por tecla baixar.
- **Confirmação**: confirmado.

### P4 — Médio — `updateWatchlistBadge` pode disparar 1 IPC por ticker em loops de sync
- **Evidência** (`renderer/renderer.js:777`):
  ```js
  const detail = await window.api.getTickerDetail(ticker);   // fallback quando não há summary
  ```
  loops que a invocam sequencialmente: `5243-5248` (`p.updated`), `5435`, `5475`, `5496`, `5536-5553`.
- **Impacto**: durante `sync-all-progress`, um evento com muitos `updated` sem `summary` gera N chamadas IPC sequenciais + N substituições de DOM (`790-800`), serializando trabalho no renderer e atrasando a UI.
- **Correção mínima**: usar exclusivamente o `summary` fornecido pelo evento e ignorar/adiar ticks sem summary (ou agrupar num único `getTickersSummary(tickers[])` no main); aplicar atualizações com `requestAnimationFrame`/lote.
- **Confirmação**: confirmado (dependente de `p.updated` sem `summary`).

### P5 — Baixo — `setupModalClosingGuards` duplicado e `closeStockModal` global em cada tecla
- **Evidência**: registo de `window.addEventListener('keydown', ...)` em `renderer.js:4393`; chamadas a `setupModalClosingGuards()` em `4703` (avaliação do script), `6091` (DOMContentLoaded) e `6105` (se `readyState !== 'loading'`) → até 2 registos efetivos; além disso `4698` registra `document keydown` que chama sempre `closeStockModal()`.
- **Evidência do custo** (`4263-4296`): cada `closeStockModal()` corre dois `document.querySelectorAll` amplos (`.modal-backdrop, #modal-asset-detail, ...`) e ciclo sobre resultados, mesmo sem modal aberto.
- **Impacto**: listeners duplicados (leak ligeiro permanente), trabalho DOM desnecessário em cada `Escape` e fecho forçado de overlays não relacionados (ex.: modal manual/choice) por guardas globais.
- **Correção mínima**: idempotência explícita (`if (setupModalClosingGuards.__bound) return;`) e `closeStockModal` com early-return se nenhum dos overlays alvo estiver visível.
- **Confirmação**: confirmado.

### P6 — Baixo — Hover card: `getBoundingClientRect` em cada `mousemove`
- **Evidência** (`renderer/renderer.js:198-202` → `320-330`):
  ```js
  watchlistEl.addEventListener('mousemove', (e) => { if (...) positionHoverCard(e); });
  ...
  const rect = hoverCard.getBoundingClientRect();   // leitura
  hoverCard.style.left = x + 'px'; hoverCard.style.top = y + 'px';  // escritas
  ```
- **Impacto**: leitura de layout + escrita de estilo a cada movimento do rato sobre a lista; causa reflow por frame durante hover em listas grandes.
- **Correção mínima**: medir o card uma vez na abertura (`mouseover`) e animar apenas `transform: translate3d(x,y,0)` (composição), com `requestAnimationFrame` a coalescer eventos.
- **Confirmação**: confirmado.

### P7 — Baixo — `refreshGroupStatusBadge` dispara IPC por grupo em cada render
- **Evidência** (`renderer/renderer.js:662-666` e cache limpo em `2041`):
  ```js
  if (dbName) { void refreshGroupStatusBadge(key, dbName); }
  ...
  indexStatusCache.clear();   // reloadMyListFromDatabase
  ```
- **Impacto**: cada `renderWatchlist()` (ex.: clique de colapso) potencia N chamadas `checkIndexStatus` (uma por índice) até à cache encher; cada reload limpa a cache e repete a rajada.
- **Correção mínima**: preencher a cache no `reloadMyListFromDatabase` com os badges já devolvidos pela listagem, ou reutilizar a cache sem a limpar enquanto os dados não mudarem.
- **Confirmação**: confirmado.

### P8 — Informativo — `querySelectorAll` repetidos em caminhos quentes
- **Evidência**: `renderer/renderer.js:2314` (`document.querySelectorAll('.sortable')` por ordenação) e `2365-2378` (tooltip procura `document.querySelector('.mc-tooltip')` em cada `mouseover` global).
- **Impacto**: custo baixo, mas evitável.
- **Correção mínima**: guardar referências dos headers/tooltip em variáveis de módulo.
- **Confirmação**: confirmado.

### P9 — Informativo — Arranque duplica carregamento da My List
- **Evidência**: `initTabsNavigation()` em `150`, `3170`, `6071`, `6100`; `loadInitial()` em `3161`; o callback de aba (`84-85`) pode voltar a chamar `reloadMyListFromDatabase` antes de `tabsLoadedOnce.add('mylist')` (`2052`) ficar concluído (o `loadInitial` não é aguardado).
- **Impacto**: dois `listTickers` + dois renders completos no arranque; `initTabsNavigation` é idempotente nos listeners, mas repete queries de abas.
- **Correção mínima**: marcar `tabsLoadedOnce.add('mylist')` antes do await em `loadInitial` ou aguardar `loadInitial()` antes de `initTabsNavigation()` final.
- **Confirmação**: suspeita (depende do timing do IPC).

---

## Riscos residuais

- `escapeHtml` incompleto (`'`, backtick) — qualquer template futuro com aspas simples reabre injeção.
- Helpers que aceitam HTML cru (`openConfirmModal`, `emptyStateRowHtml`, `indexBulkProgressLabel.innerHTML`, `freshnessBannerMessage`) mantêm um padrão de risco; a segurança depende da disciplina dos call sites.
- CSP atual (`script-src 'self'`) é a principal mitigação de execução para os sinks S1–S6; qualquer alteração para `'unsafe-inline'`/`'unsafe-eval'` eleva todos a XSS executável.
- A fronteira IPC não foi integralmente auditada (main/preload); campos como `mcLabel`, `direction`, datas de freshness/dividendos são assumidos como não confiáveis.
- `window.lastPipelineResult` é referido em `renderer.js:5756-5760` mas é uma variável local de `quantRenderer.js:13` (não está em `window`); o `saveToTracker` de `renderer.js` pode não encontrar o asset e cair no fallback `{ ticker }`. Bug funcional, não de segurança.
- `saveToTracker` usa `event` global implícito (`5749`, `5783`) e `document.querySelector('button[onclick*="${ticker}"]')` com interpolação em seletor CSS — pode lançar e ser engolido pelo catch.

## Testes existentes relevantes

- `test/sync-universe-diagnostics.test.js:338-347` — valida `innerHTML` atómico + `escapeHtml(e.ticker)`/`escapeHtml(e.reason)` no modal de diagnóstico (bom precedente a replicar).
- `test/modal-backdrop-guard.test.js:16-45` — valida `closeStockModal`/`setupModalClosingGuards` (não cobre duplicação de registos nem o custo por tecla).
- `test/historical-dividends.test.js:134-138` — apenas verifica existência de `loadAndRenderDividends`/`formatEuropeanDate`; **não** valida escaping da data.
- `test/workstation-calibration-ui.test.js:64-70` — apenas garante que `renderTopRecommendations` existe e é exportada; **não** valida escaping na versão de `renderer.js`.

## Testes em falta (recomendados)

1. XSS: `renderRowToDOM` com `direction` maliciosa (`x" onclick="...`) → assert que a classe/célula não contém markup novo.
2. XSS: tooltip `data-mc-tooltip` com `<img src=x onerror=...>` no `mcLabel` → assert que `tip` não cria elemento `img` (round-trip).
3. XSS: `loadAndRenderDividends` com `date` não-ISO → assert de escape.
4. XSS: `freshnessBannerMessage` com `maxStoredDate`/`expectedDate` maliciosos → assert de escape.
5. Regressão: remover a implementação duplicada de `renderTopRecommendations` em `renderer.js` (ou adicionar assert de que todos os campos passam por `escapeHtml`).
6. Performance: benchmark de `appendRow`/`scan:row` com 500–2000 linhas, verificando ausência de O(N²) e tempo por lote.
7. Performance: teste que garanta debounce em `filterMyList` e que o toggle de grupo não reconstrói a lista (contagem de `addEventListener`/nós criados).
8. Regressão: `setupModalClosingGuards` chamado 3× só regista um listener (`keydown` count === 1).

## Limitações da auditoria

- Revisão estática (leitura integral do ficheiro + confirmações a montante); não foram executadas PoCs dinâmicas nem instrumentado o runtime Electron.
- A exploração real de S1 depende do shadowing (`quantRenderer.js:1037`); S2 depende de `mcLabel` passar a ser dinâmico.
- `main.js`, `preload.js` e a engine Python só foram inspecionados pontualmente para confirmar origem de dados; não fazem parte do âmbito profundo.
- A existência de `contextIsolation/sandbox` e da CSP reduz o impacto; a avaliação de severidade não assume que essas proteções sejam removidas.
- Não foi possível determinar o conteúdo real da SQLite/`quant_cache.db` nem validar contratos IPC com payloads hostis.
