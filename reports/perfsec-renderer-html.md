# Relatório PerfSec — Shell HTML do Renderer (`renderer/index.html`)

- **Data:** 2026-09-10
- **Âmbito:** `renderer/index.html` (1863 linhas), cruzado com `main.js` (entrypoint de `package.json.main`) e `preload.js`.
- **Método:** análise estática, somente-leitura. Sem execução da app, sem DevTools, sem medições de runtime.
- **Modo:** auditoria de segurança + performance.

## 1. Controlos verificados (positivos)

| Controlo | Evidência |
|---|---|
| `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true` | `main.js:509-515` |
| CSP com `script-src 'self'` (sem `unsafe-eval`/`unsafe-inline`) | `renderer/index.html:5-6` |
| Zero scripts inline; zero atributos `on*`; zero `javascript:`; zero `<iframe>`/`srcdoc`/`<form>` | `renderer/index.html` (verificação regex integral) |
| Scripts e bibliotecas vendorizados localmente (`chart.umd.js` v4.5.1, `currency.js`) — sem CDN | `renderer/index.html:1854-1859`; `renderer/chart.umd.js:1-4` |
| IDs únicos (374/374) e sem duplicação | `renderer/index.html` (verificação programática) |
| Sem `<img>` (ícones SVG inline) — sem layout shift de imagens | `renderer/index.html:14-35` |
| Preload via `contextBridge`; canais de eventos em whitelist (`ALLOWED_EVENTS`) | `preload.js:3-29`, `preload.js:198-205` |

## 2. Sumário de severidade

| Severidade | Nº |
|---|---|
| Crítico | 0 |
| Alto | 1 |
| Médio | 5 |
| Baixo | 6 |
| Informativo | 2 |
| **Total** | **14** |

---

## 3. Findings de Segurança

### SEC-01 — Sink `innerHTML` sem escape em tabelas de fases (cross-file) — **Alto**

- **Evidência (confirmado):**
  - `renderer/quantRenderer.js:825-839` — `tbody.innerHTML = p1.stocks.map(...)` interpola `${s.ticker}`, `${s.sector}`, `${formattedCap}`, `${s.status}` sem `escapeHtml`; note-se que `formattedCap` pode devolver o valor cru `s.market_cap` quando não é número (`quantRenderer.js:828`).
  - `renderer/quantRenderer.js:983-989` — `${c.feature}`, `${c.vif_raw}` sem escape.
  - Contraste: `renderPhase4Sentiment` no mesmo ficheiro escapa corretamente (`quantRenderer.js:958-962`), o que mostra inconsistência.
- **Impacto:** injeção de HTML/DOM a partir de payload do motor/backend (dados de mercado e metadados de ativos). Execução de JavaScript está atualmente **bloqueada** pela CSP (`script-src 'self'`, sem handlers inline) — `index.html:6` — mas permite *UI spoofing* (tabelas/badges falsos) e é um vetor que escala para XSS se a CSP for enfraquecida (ex.: `unsafe-inline`).
- **Correção mínima:** escapar todos os campos interpolados, como já feito na fase 4:
  ```js
  const safeTicker = escapeHtml(s.ticker);
  const safeSector = escapeHtml(s.sector);
  const safeStatus = escapeHtml(s.status);
  const safeCap    = escapeHtml(String(formattedCap));
  ```

### SEC-02 — CSP entregue apenas por `<meta>`; ausente no processo principal — **Médio**

- **Evidência (confirmado):**
  - `renderer/index.html:5-6` — CSP exclusivamente via `http-equiv`.
  - `main.js:500-518` — `createWindow()`/`loadFile` sem `session.defaultSession.webRequest.onHeadersReceived` (grep por `session|webRequest|Content-Security-Policy` em `main.js` não retorna nada).
- **Impacto:** em `<meta>`, as diretivas `frame-ancestors`, `sandbox` e `report-uri` são ignoradas; a política pode ser neutralizada por injeção de conteúdo antes da meta (todas as diretivas da meta só se aplicam ao que é processado depois). Perde-se defesa em profundidade (o header não pode ser removido por conteúdo da página).
- **Correção mínima:** definir a CSP como header no processo principal:
  ```js
  const { session } = require('electron');
  session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
    cb({ responseHeaders: { ...details.responseHeaders,
      'Content-Security-Policy': ["default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"] } });
  });
  ```
  Manter a meta em sincronia (ou removê-la).

### SEC-03 — `style-src 'unsafe-inline'` com 110 atributos `style` — **Médio**

- **Evidência (confirmado):** `renderer/index.html:6` (`'unsafe-inline'`); 110 atributos `style="..."` no ficheiro, p.ex. `index.html:138`, `index.html:174`, `index.html:233-246`, `index.html:846-850`.
- **Impacto:** a CSP não consegue bloquear CSS injetado (injeção via atributo `style` fica permitida); reduz a eficácia da política contra *UI redressing* e exfiltração via CSS. `style-src 'unsafe-inline'` é incompatível com o endurecimento para nonces/hashes.
- **Correção mínima:** migrar os estilos inline para classes em `renderer/styles.css` e depois trocar para `style-src 'self' https://fonts.googleapis.com` (manter `unsafe-inline` apenas enquanto a migração não estiver completa).

### SEC-04 — Origens de terceiros autorizadas na CSP (Google Fonts) — **Médio**

- **Evidência (confirmado):** `renderer/index.html:6` (`style-src ... https://fonts.googleapis.com`, `font-src ... https://fonts.gstatic.com`), `index.html:8-10` (preconnects + folha de estilos externa).
- **Impacto:** dependência de terceiros em runtime, fuga de IP/uso para Google, e superfície de supply-chain (CSS externo alterável no servidor; SRI sobre CSS dinâmico do Google Fonts não é viável). É a única origem externa permitida pela CSP.
- **Correção mínima:** vendorizar as fontes (`renderer/fonts/*.woff2` + `@font-face` em `styles.css` com `font-display: swap`) e remove-las da CSP. Se se mantiver o CDN, fixar/versionar a URL e documentar o risco.

### SEC-05 — Diretivas CSP em falta — **Baixo**

- **Evidência (confirmado):** `renderer/index.html:6` não define `object-src`, `base-uri`, `form-action` nem `worker-src`.
- **Impacto:** `object-src` cai para `default-src 'self'` (plugins locais); `base-uri` sem restrição permite injeção de `<base href>` (redirecionar URLs relativas); `form-action` sem restrição explícita (não existem forms, mas é defesa em profundidade); `worker-src` sem regra própria.
- **Correção mínima:** adicionar `object-src 'none'; base-uri 'none'; form-action 'none'; worker-src 'none'` à política (ver SEC-02).

### SEC-06 — `devTools: true` incondicional e sem restrições de navegação — **Baixo**

- **Evidência (confirmado):** `main.js:514` (`devTools: true`); `main.js:500-518` sem `setWindowOpenHandler`/`will-navigate`/`shell.openExternal` (grep integral sem resultados).
- **Impacto:** em builds empacotadas o utilizador pode abrir DevTools, executar JS no renderer e invocar toda a superfície IPC exposta (`window.api`), manipulando o estado da app. Não há vetor de navegação atual (nenhum link/`window.open` externo em `index.html`), mas falta defesa em profundidade.
- **Correção mínima:**
  ```js
  devTools: !app.isPackaged,
  // após createWindow():
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('file://')) e.preventDefault(); });
  ```

### SEC-07 — Superfície de preload ampla e aliases duplicados — **Baixo**

- **Evidência (confirmado):** `preload.js:223-225` expõe o mesmo objeto em `window.api`, `window.electronAPI` e um segundo bridge em `window.quantAPI`; vários métodos são duplicados (`preload.js:191-197`, `preload.js:208-221`).
- **Impacto:** qualquer XSS/injeção (ver SEC-01) ganha acesso a métodos com efeitos persistentes (escrita SQLite, downloads, eliminação de ativos). O whitelist `ALLOWED_EVENTS` (`preload.js:198-205`) é positivo e deve manter-se.
- **Correção mínima:** consolidar num único objeto, remover aliases duplicados, congelar a superfície (`Object.freeze(apiBridge)`) e manter validação de payloads no main.

### SEC-08 — SRI/integrity: não aplicável (scripts locais vendorizados) — **Informativo**

- **Evidência (confirmado):** todos os scripts são locais (`index.html:1854-1859`); `chart.umd.js` é Chart.js v4.5.1 vendorizado (`renderer/chart.umd.js:1-4`); não existe folha de estilos externa além do Google Fonts.
- **Impacto:** `integrity` não acrescenta garantia para ficheiros `file://` same-origin. O risco está na proveniência dos vendors.
- **Correção mínima:** registar versão/hash no repositório/processo de atualização. Baseline SHA-256:
  - `chart.umd.js` — `ecc3cd1eeb8c34d2178e3f59fd63ec5a3d84358c11730af0b9958dc886d7652a`
  - `currency.js` — `cddb9a12f361a503bea99e867701f664f3c5e3e2272afcd69cff9f47b368b310`
  - `renderer.js` — `15aab847cca62dbe8794b1f5f71243ab96e881e571b57ca4aab9acc8a0023fc9`
  - `simulationRenderer.js` — `2389442d0d72d8f6474b3eb3cc0251c5247e3cd9066a6f97b87246e3c703866e`
  - `quantRenderer.js` — `2c406c914a93c885c2a868d092f4f8d54b2a64e5f6bba99d7345d1314d01f5a9`
  - `quantTrackerRenderer.js` — `b5edaeeb83066e5dda7ed1752245bfd56c79871fedcaddde468526cc972713e7`

---

## 4. Findings de Performance

### PERF-01 — Folha de estilos Google Fonts render-blocking — **Médio**

- **Evidência (confirmado):** `renderer/index.html:10` (`<link rel="stylesheet" href="https://fonts.googleapis.com/...">`) no `<head>`; preconnects em `index.html:8-9` mitigam parcialmente.
- **Impacto:** o primeiro paint fica bloqueado até à resposta de um domínio externo (ou até ao timeout/falha de DNS). Sem rede (cenário comum em desktop), o arranque degrada; com rede lenta a janela pode ficar em branco durante segundos. `font-display: swap` ajuda só depois do CSS chegar.
- **Correção mínima:** self-hosting dos WOFF2 + `@font-face` local (elimina também SEC-04). Alternativa: carregar o CSS de forma não bloqueante (ex.: `rel="preload" as="style"` + ativação por JS), sem recorrer a handlers inline (bloqueados pela CSP).

### PERF-02 — Seis scripts síncronos sem `defer`/`async` — **Médio**

- **Evidência (confirmado):** `renderer/index.html:1854-1859` — `chart.umd.js` (208 KB), `currency.js` (3,6 KB), `renderer.js` (263 KB), `simulationRenderer.js` (29 KB), `quantRenderer.js` (47 KB), `quantTrackerRenderer.js` (20 KB), todos sem `defer`/`async`; ~571 KB parseados/executados em sequência antes de `DOMContentLoaded`.
- **Impacto:** atrasa a interatividade inicial (TTI) no main thread; `simulationRenderer.js` e `quantTrackerRenderer.js` só são necessários após interação com abas específicas, mas são sempre carregados e executados.
- **Correção mínima:** adicionar `defer` a todos (preserva a ordem) e, numa segunda fase, carregar os módulos por aba sob demanda (init no clique da aba) para reduzir trabalho no arranque.

### PERF-03 — DOM inicial excessivo com todos os painéis/modais no HTML — **Baixo**

- **Evidência (confirmado):** `renderer/index.html` com 104 137 bytes, ~1332 elementos, 374 IDs, 6 `tab-content` (5 ocultos) e 8 modais/drawer, todos presentes no DOM inicial (`index.html:495`, `index.html:596`, `index.html:719`, `index.html:981`, `index.html:1137-1852`).
- **Impacto:** custo de parse/layout/style no arranque e memória desnecessária; apenas a aba ativa é visível.
- **Correção mínima:** renderização diferida por aba (template + injeção no primeiro acesso) mantendo os contentores, ou pelo menos evitar conteúdo interno dos painéis ocultos.

### PERF-04 — 110 atributos `style` inline — **Baixo**

- **Evidência (confirmado):** 110 ocorrências de ` style="` em `renderer/index.html` (ex.: `index.html:138`, `index.html:176`, `index.html:846`).
- **Impacto:** aumenta o tamanho do HTML, impede cache de estilos e força `'unsafe-inline'` na CSP (SEC-03).
- **Correção mínima:** mover para classes em `renderer/styles.css`.

### PERF-05 — `<canvas>` sem dimensões (layout shift) — **Baixo**

- **Evidência (confirmado):** `index.html:340` (`chart-mcginley`) e `index.html:346` (`chart-momentum`) sem `width`/`height`; `index.html:937-938` (`canvas-equity-curve`, `canvas-drawdown-curve`) apenas com `height`.
- **Impacto:** os canvas assumem 300×150 por defeito e redimensionam por CSS, provocando *layout shift* e gráficos borrados/pixelizados.
- **Correção mínima:** definir `width`/`height` (ou `aspect-ratio`/`contain-intrinsic-size` no CSS) nos quatro canvas, como já é feito em `index.html:1676`.

### PERF-06 — Boas práticas já presentes — **Informativo**

- **Evidência:** `preconnect` com `crossorigin` para `fonts.gstatic.com` (`index.html:8-9`); ícones SVG inline em vez de imagens (`index.html:14-35`); CSS/JS locais (sem CDN); `styles.css?v=7` com cache-busting (`index.html:11`).
- **Nota:** o CSS local tem 176 KB (`renderer/styles.css`) e é bloqueante, mas local — custo marginal aceitável face aos pontos acima.

---

## 5. Riscos residuais

1. **Injeção HTML via `innerHTML` (SEC-01)** — mitigada por CSP sem `unsafe-inline`/`unsafe-eval`, mas dependente da disciplina de escaping; qualquer regressão ou relaxamento da CSP escala para XSS com acesso ao bridge IPC.
2. **CSP meta-only (SEC-02)** — sem header no processo principal, a política pode ser contornada por conteúdo injetado antes da meta e não cobre `frame-ancestors`/`sandbox`.
3. **`style-src 'unsafe-inline'` + origem Google (SEC-03/SEC-04)** — canal residual de exfiltração/abuso de CSS e dependência externa.
4. **DevTools em produção (SEC-06)** — permite manipulação manual do renderer e do estado da app.
5. **Semântica de `file://`** — `'self'` abrange o esquema `file:`; em cenário de injeção, um `<script src="file:///...">` apontando para ficheiro local existente poderia ser aceite pela CSP (requer, ainda assim, capacidade de injeção e ficheiro útil local).

## 6. Limitações

- Auditoria **estática**; não foram executadas a app, DevTools, testes de performance reais (TTI/FCP) nem testes de penetração.
- `main.js` raiz (entrypoint real: `package.json.main = main.js`); existe código duplicado em `src/main/main.js` e `src/ipc/ipcHandlers.js` que **não** é o entrypoint e não foi considerado para as conclusões, embora as mesmas chaves `webPreferences` aí apareçam.
- A verificação de sinks foi feita por amostragem em `renderer/quantRenderer.js`, `renderer/quantTrackerRenderer.js` e `renderer/simulationRenderer.js`; `renderer/renderer.js` (6122 linhas, 78 `innerHTML`) não foi exaustivamente revisto.
- Não foi inspecionado o conteúdo devolvido por `fonts.googleapis.com` em runtime, nem verificado o binário do motor Python que alimenta os payloads das fases.
- As contagens de elementos/bytes são estimativas por regex, não medições do motor de rendering.
- Não foram executados `npm test`/lint; não foi avaliada a existência de testes de segurança.

## 7. Ordem de remediação sugerida

1. SEC-01 — escapar sinks de `quantRenderer.js` (Alto, esforço baixo).
2. SEC-02 + SEC-05 — CSP como header no main process com diretivas adicionais (Médio, esforço baixo).
3. PERF-01 + SEC-04 — self-hosting das fontes (Médio, esforço baixo/médio).
4. PERF-02 — `defer` e carregamento por aba (Médio, esforço baixo/médio).
5. SEC-03 + PERF-04 — migrar 110 estilos inline para CSS (Médio/Baixo, esforço médio).
6. SEC-06/SEC-07 — endurecimento do main/preload (Baixo, esforço baixo).
7. PERF-03/PERF-05 — DOM diferido e dimensões de canvas (Baixo, esforço médio/baixo).
