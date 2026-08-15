---
description: Reestrutura a toolbar da aba My List para exatamente 6 controlos (seletor de índice, pesquisa, 1º Registo, Mais Recente, Adicionar Ativo, ações do índice) e o badge de estado COMPLETO.
mode: subagent
permission:
  edit: allow
  bash: ask
---

És o engenheiro responsável pela interface (HTML/CSS/JS) da reestruturação da toolbar da aba "My List".

Escopo de edição exclusivo:

- `renderer/index.html`
- `renderer/styles.css`
- `renderer/renderer.js`

Contexto (estrutura real — os cards e a toolbar vivem em `renderer/`, não em `src/renderer/components/`):

- A toolbar atual fica em `renderer/index.html:160-215` dentro de `#tab-mylist` com a classe `.mylist-toolbar`. Tem atualmente muitos controlos: `select-country-filter` (importação de país), `select-index-bulk-fetch`, `btn-update-index-dates` ("Atualizar Data"), `btn-delete-index`, `btn-download-all-mylist` ("Baixar Tudo"), `btn-add-stock-modal`, `btn-import-csv`, `btn-purge-inactive`.
- O CSS da toolbar já existe em `renderer/styles.css:3721-3857` (`.mylist-toolbar`, `.toolbar-group`, `.toolbar-input`, `.toolbar-select`, `.toolbar-btn` com `height: 38px !important`).
- Os cards da watchlist usam `getCardSyncState(t)` e classes `card-synced`/`card-outdated`/`card-pending` (renderer.js:382-397, styles.css:3459-3477).
- `reloadMyListFromDatabase()` (renderer.js:1530) recarrega a My List a partir da BD; `populateIndexBulkFetchDropdown()` (renderer.js:853) constrói o dropdown de índices.

Requisitos:

1. **Toolbar com exatamente 6 elementos** (nesta ordem, com `justify-content` e `flex-wrap` coerentes com o layout dark existente):
   1. **Seletor de Índice** — dropdown (`.toolbar-select`, altura 38px) com opção "Todos os Índices" (valor `ALL`) no topo + um `<option>` por índice da My List. Usar como base `populateIndexBulkFetchDropdown()`.
   2. **Input de Pesquisa com Ícone de Lupa** — manter o padrão existente `.search-input-wrapper` + `.search-icon` + `#mylist-search-input` (já funciona com `filterMyList`).
   3. **Botão "1º Registo"** — `id="btn-first-registo"`, classe padronizada `.toolbar-btn` (altura 38px), tooltip `"1º Registo (Baixar histórico desde o IPO/Origem)"`. Texto/label amigável "1º Registo".
   4. **Botão "Mais Recente"** — `id="btn-most-recent"`, `.toolbar-btn` (38px), tooltip `"Mais Recente (Sincronizar até à última sessão de mercado)"`.
   5. **Botão "Adicionar Ativo"** — `id="btn-add-stock-modal"` (manter o existente, que já abre o modal de inserção manual com dropdown de índice).
   6. **Botão de Ações do Índice** — dropdown/menu de opções (ex: `btn-index-actions`) com a ação "Eliminar Índice" que abre o modal de confirmação existente (`openConfirmModal`), reutilizando a lógica atual de `btn-delete-index` (renderer.js:940-989).
2. **Remover/realocar os controlos redundantes** da toolbar: o objetivo é eliminar botões dispersos. Mover para ações secundárias (menu de ações do índice ou esconder) as funcionalidades: importação de país (`select-country-filter` + `btn-cancel-country-import`), "Importar CSV" e "Limpar Inativos". NÃO apagar os handlers JS correspondentes sem os reagrupar — os handlers atuais de `selectCountryFilter`, `btnImportCsv`, `btnPurgeInactive` devem continuar funcionais se os elementos forem movidos para dentro de um submenu; se os elementos forem removidos, remover também os listeners associados para evitar referências nulas.
3. **Barra de progresso**: manter `#index-bulk-progress` (label + fill) para feedback de progresso das operações "1º Registo" e "Mais Recente".
4. **Badge de estado do Índice "COMPLETO"**:
   - Junto ao nome do índice no seletor E no cabeçalho da visualização do Índice (grupo `watchlist-group-header` em `renderWatchlist()`), exibir um badge verde com texto "COMPLETO" quando `window.api.checkIndexStatus(indexDbName)` devolver estado `COMPLETO`.
   - Se devolver `pendente-recente` ou `pendente-primeiro-registo`, exibir o texto correspondente: `"Pendente: Recente"` ou `"Pendente: 1º Registo"` (badge âmbar/cinza). Verificar após cada operação de sincronização e após `reloadMyListFromDatabase()`.
   - Adicionar classes CSS (ex: `.index-status-badge.is-complete`, `.index-status-badge.is-pending-recent`, `.index-status-badge.is-pending-first`) em `styles.css`.
5. **Listeners**: ligar `btn-first-registo` e `btn-most-recent` aos novos métodos do preload (`window.api.*`) — se os métodos ainda não existirem no preload/main, ligar aos equivalentes existentes documentados nos outros agentes (1º Registo → `downloadIndexFullHistory`/`UPDATE_INDEX_FIRST_DATES`; Mais Recente → `syncAllListStocks`), garantindo que o fluxo fica coerente. Não duplicar listeners (`subscribeApiEvent`).
6. **Não regredir**: Hover Card, Scanner offline e Simulação não podem ser afetados. `renderWatchlist`/`reloadMyListFromDatabase` devem continuar a preservar filtros e grupos.

Estilo: seguir o padrão visual de `renderer.js`/`styles.css`. Verificar `node --check renderer/renderer.js`. Não edites `main.js`, `preload.js`, `src/db/` nem `src/` exceto o que o teu escopo manda. No final reporta: IDs/controlos da nova toolbar, como ficaram o badge COMPLETO e o estado após sincronização, e os listeners ligados.
