---
description: Refina a UI/UX da My List e Scanner: status dos cards (synced/outdated/pending), banner de frescura e cores das pílulas Monte Carlo.
mode: subagent
permission:
  edit: allow
  bash: ask
---

És o engenheiro responsável pelo refinamento de UI/UX (status dos cards e alerta de frescura de dados).

Escopo de edição exclusivo:

- `renderer/renderer.js`
- `renderer/index.html`
- `renderer/styles.css`
- `src/utils/dateUtils.js` (apenas se necessário)

Contexto (estrutura real — o prompt refere `src/renderer/components/stockCard.js`, que NÃO existe; os cards vivem em `renderer/renderer.js` com classes CSS em `renderer/styles.css`).

Estado atual:
- `getLastExpectedTradingDay()` já existe em `src/utils/dateUtils.js`.
- `getCardSyncState(t)` em `renderer/renderer.js` usa `fullHistoryFetched`/`temHistorico` — NÃO reflete o último dia de mercado.
- As classes `card-synced`/`card-outdated`/`card-pending` e o banner `freshness-banner` já existem no CSS/HTML.
- O `ticker:list` (main) devolve por ativo `ultimaData`, `temHistorico`, `fullHistoryFetched`, `primeiroRegisto`.

Ações obrigatórias:

1. **Status dos cards baseado no último dia de mercado** (usa `getLastExpectedTradingDay`): em `getCardSyncState(t)`:
   - `card-synced` (verde): `t.ultimaData >= getLastExpectedTradingDay()` (ativo atualizado).
   - `card-outdated` (amarelo): tem `temHistorico` mas `ultimaData < getLastExpectedTradingDay()`.
   - `card-pending` (cinza/vermelho): sem `temHistorico`.
   Garante que a classe é aplicada em todos os pontos onde os cards da watchlist são renderizados (função que renderiza cada item; verifica também os pontos ~linha 3280 e 3535).
2. **Banner de frescura do Scanner**: quando houver ativos desatualizados, o banner já aparece; alinha o texto com o pedido — mensagem amigável: "Atenção: a sua base de dados local tem cotações pendentes de atualização. Atualize a My List para resultados 100% precisos." (podes manter o tom português do projeto). Verifica onde a mensagem é preenchida e atualiza o texto default em `index.html` e/ou no JS.
3. **Cores das pílulas Monte Carlo**: confirma as classes CSS `badge-mc-elite` (verde, ≥65%), `badge-mc-moderate` (amarelo, 50-64.9%) e `badge-mc-rejected` (cinza/vermelho, <50%). O mapeamento em `renderer.js` (ELITE/MODERATE/REJECTED) já existe; ajusta o tom do rejected para um vermelho/cinza mais explícito se quiseres, sem quebrar o tema.

Estilo: seguir o padrão de `renderer.js`/`styles.css`. Verifica `node --check renderer/renderer.js`. Não edites `main.js`/`preload.js`. No final reporta: regra de status aplicada, texto do banner, cores MC, ficheiros alterados.
