# Auditoria PerfSec — Motores de Backtesting / Simulação

**Agente:** `perfsec-engine-simulation` (modo somente-leitura)
**Data:** 2026-09-10
**Alcance primário:** `src/engine/backtesterEngine.js`, `src/engine/portfolioBacktester.js`, `src/engine/simulationWorker.js`
**Alcance secundário:** `src/quant/markovEngine.js`, `src/quant/monteCarloEngine.js`, `src/quant/indicators.js`, `src/quant/workstation/metrics.js`, `src/quant/workstation/validation.js`, `src/native/index.js`
**Testes analisados:** `test/backtester-engine.test.js`, `test/portfolio-backtester.test.js`, `test/simulation-resilience.test.js`, `test/multithreaded-simulation.test.js`, `test/portfolio-worker.test.js`, `test/performance.test.js`
**Contexto de execução:** Electron + `worker_threads`; candles do SQLite; módulo nativo presente (`build/Release/quant_engine.node`, 81 KB).

Nenhum ficheiro de código-fonte foi alterado. Este relatório é o único artefacto produzido.

---

## Sumário executivo

| Severidade | Nº |
|---|---|
| Crítico | 3 |
| Alto | 6 |
| Médio | 7 |
| Baixo | 4 |
| Informativo | 2 |
| **Total** | **22** |

Os dois problemas dominantes são **algorítmicos**: `runSimulation` recomputa toda a cadeia de indicadores + Markov (e potencialmente Monte Carlo) por cada barra, e o `PortfolioBacktester` faz o mesmo por cada par (ativo, dia), com `slice` integral e dupla cadeia de indicadores. Ambos escalam quadraticamente. Segue-se um **bug de correção crítico**: o motor de carteira ignora o `side` devolvido pelo sinal e abre sempre LONG, apesar de a UI enviar `direction: BOTH` por defeito.

---

## Findings

### F-01 — [CRÍTICO] `runSimulation` recomputa indicadores/Markov por barra (O(N²))

**Evidência:**
- `src/engine/backtesterEngine.js:478` — `evaluateSignal(a.candles, a.ptr, cfg)` é chamado para **cada barra de cada ativo**, antes de qualquer gatekeeper barato.
- `src/engine/backtesterEngine.js:112` — `const slice = candles.slice(0, i + 1);` copia a série inteira por barra.
- `src/quant/markovEngine.js:338-357` — `analyzeSeries` faz `.map`×4, `rsiWilder`, `adxWilder`, `bollingerBands`, `atrWilder`, `sma`, `calculateRollingVWAP` (O(20·n)), `buildStateSeries`, `buildTransitionMatrix`.
- `src/quant/monteCarloEngine.js:231` — `runMarkovMonteCarloSimulation` volta a chamar `buildStateReturnsMap`, que repete RSI/ADX/BB sobre a slice inteira.

**Impacto:** com N=5000 e warmup=200, Σ i ≈ 12,5 M passagens de barra por ativo e ~10 arrays grandes alocados por barra (≈50 000 arrays) — centenas de milhões de operações e pressão de GC severa. Com 100 ativos × 2500 velas: ~250 000 chamadas e ~2,5 M arrays grandes. A UI fica minutos/horas no worker e a memória dispara. A metadata de progresso mascara o problema (o worker continua vivo).

**Correção mínima:** mover os gates já pré-calculados (`precomputed.vwap`/`rvolApproved`) para **antes** de `evaluateSignal` em `runSimulation` (como já se faz em `BacktesterEngine.run:757-770`) e substituir `candles.slice(0, i+1)` por uma variante incremental de `analyzeSeries(candles, i)` que aceite índice final e reaproveite os arrays de indicadores já computados. Alternativa imediata de menor risco: gate VWAP/RVOL primeiro e só então avaliar Markov/MC.

---

### F-02 — [CRÍTICO] `PortfolioBacktester` avalia O(D×A×N) com slice e cadeia duplicada

**Evidência:**
- `src/engine/portfolioBacktester.js:195-203` — para **cada dia** e **cada ativo** não detido: `e.candles.slice(0, idx + 1)` + `evaluateAssetGatekeepers(...)`.
- `src/engine/portfolioBacktester.js:199` — a slice completa é criada mesmo antes de saber se há vaga/sinal.
- `src/engine/portfolioBacktester.js:277` — `analyzeSeries` recalcula RSI/ADX/BB/VWAP/estados/matriz.
- `src/engine/portfolioBacktester.js:297` — `runMarkovMonteCarloSimulation` chama `buildStateReturnsMap` (`src/quant/monteCarloEngine.js:231`), repetindo a mesma cadeia.
- `src/engine/portfolioBacktester.js:205` — cada candidato avaliado entra depois numa ordenação O(k log k).

**Impacto:** com A=50 ativos, N=2500 dias úteis e warmup=200 → ~115 000 avaliações candidato-dia; cada uma percorre ~1350 barras em duas cadeias de indicadores (≈3×10⁹ operações elementares). Se os gates passarem com frequência, o MC soma até 115 000 × 1000 iterações × 35 dias ≈ 4×10⁹ passos (o caminho nativo C++ alivia, mas `buildStateReturnsMap` permanece JS). É o custo dominante da app.

**Correção mínima:** pré-computar, uma vez por ativo, arrays completos (RSI, ADX, %B, estados, mapa de retornos por estado) e avaliar cada dia em O(1) amortizado; o wrapper já constrói `lookup` uma vez — seguir o mesmo padrão para os indicadores. Evitar `slice` passando `(candles, idx)` e reaproveitar `stateReturns` em vez de reconstruí-lo no MC.

---

### F-03 — [CRÍTICO] Motor de carteira ignora o `side` do sinal: SHORT executado como LONG

**Evidência:**
- `src/engine/portfolioBacktester.js:296-307` — `evaluateAssetGatekeepers` devolve `side: 'LONG' | 'SHORT'`.
- `src/engine/portfolioBacktester.js:213-219` — a posição é criada com `side: 'LONG'` fixo e `slPrice = entry*(1−stopLoss)`, `tpPrice = entry*(1+takeProfit)`, independentemente de `cand.evaluation.side`.
- `src/quant/monteCarloEngine.js:151-152` e `:86-87` — o MC foi executado com orientação SHORT, mas a execução é LONG.
- Exposição na UI: `src/renderer/js/simulationRenderer.js:543` envia `direction: 'both'`; `src/renderer/simulation.html:482-485` tem **Bi-direcional selecionado por defeito**.

**Impacto:** silenciosamente errado no caminho por omissão da UI. Sinais de VENDA são abertos como compras, com SL/TP invertidos; as métricas (winRate, PnL, drawdown, calibração MC) ficam inválidas sem qualquer aviso.

**Correção mínima:** guardar `side` na posição e aplicar a lógica de saída/MTM espelhada (`tpPrice/slPrice` invertidos, `pnlPct` com sinal) — ou rejeitar `direction !== 'long'` na construção do `PortfolioBacktester` com mensagem explícita até existir suporte a SHORT.

---

### F-04 — [ALTO] `endDate` vazio desativa todas as entradas em `runSimulation`

**Evidência:** `src/engine/backtesterEngine.js:479`

```js
if (sig && a.ptr + 1 <= a.endIdx && String(a.candles[a.ptr + 1].date) <= cfg.endDate) {
```

`cfg.endDate` é `''` quando não indicado (`:206`). Em comparação lexicográfica `'2024-01-02' <= ''` é `false`, pelo que `pending.set(...)` (`:485`, `:488`) nunca corre.

**Impacto:** uma simulação de histórico completo sem `endDate` devolve `ok:true`, curva de capital e **zero trades**, sem erro nem mensagem. O teste `test/backtester-engine.test.js:271-287` corre com `endDate: ''` mas **não verifica trades**, pelo que a regressão não é detetada.

**Correção mínima:** `(!cfg.endDate || String(...).date <= cfg.endDate)` e adicionar asserção `trades.length > 0` ao teste de histórico total.

---

### F-05 — [ALTO] Custos negativos aceites criam/destroem capital silenciosamente

**Evidência:** `src/engine/backtesterEngine.js:209-210` e `:319-327`

```js
commissionPct: Number(params.commissionPct ?? params.commission) || 0,
slippagePct: Number(params.slippagePct ?? params.slippage) || 0,
...
const slip = cfg.slippagePct / 100;
const commission = cfg.commissionPct / 100;
```

`-5` é truthy e passa. Em `openPosition:325-327` um `slip` negativo melhora o preço de entrada; em `:358-365` uma comissão negativa reduz `unitCost`; em `closePosition:406-420` as fórmulas de cash e `profit` deixam de ser consistentes entre si.

**Impacto:** resultados irrealistas ou incoerentes (PnL das trades ≠ variação de cash/equity), sem qualquer erro. Não há validação em `runSimulation` nem no `PortfolioBacktester` (`src/engine/portfolioBacktester.js:68-72, :218-219`).

**Correção mínima:** validar `Number.isFinite` e `>= 0` para `commissionPct`, `slippagePct`, `stopLoss`, `takeProfit`, `riskPerTradePct`; lançar/rejeitar ou normalizar para 0 com mensagem.

---

### F-06 — [ALTO] SHORT em modo `full` sem controlo de exposição/cash

**Evidência:** `src/engine/backtesterEngine.js:354-366`

```js
if (info.side === 'LONG') {
  const maxShares = Math.floor(cash / Math.max(unitCost, 1e-9));
  shares = Math.min(shares, maxShares);
  ...
} else {
  cash += shares * entry * (1 - commission);   // sem clamp de margem
}
```

**Impacto:** o número de ações do SHORT depende apenas do risco (`riskAmount/|entry−sl|`). Com stop apertado, a posição nocional é enorme; se o preço subir muito, `cash` e a equity ficam negativos (`:416-419`), corrompendo KPIs, drawdown e a curva de capital. Não há custo de aluguer nem verificação de buying power.

**Correção mínima:** limitar o nocional do SHORT (ex.: `shares <= lastEquity * maxLeverage / entry`, com `maxLeverage` default 1) e recusar a abertura se `cash − margem < 0`.

---

### F-07 — [ALTO] `high`/`low`/`open` não são validados (NaN/Infinity passam)

**Evidência:**
- `src/engine/backtesterEngine.js:228-236` — o filtro só testa `close`; `open/high/low` são convertidos com `Number()` e aceites mesmo `NaN`.
- `src/engine/backtesterEngine.js:456-461` — `bar` com `NaN` entra em `managePosition`.
- `src/engine/portfolioBacktester.js:267-269` — mesma lacuna em `_normalizeUniverse`.

**Impacto:** um único `high`/`low` inválido contamina `pos.peak`/`trough` (`:377`, `:390`), as comparações SL/TP tornam-se `false` e a posição pode ficar presa até ao fim (em `runSimulation` não há expiração por horizonte). Nos indicadores, `NaN` propaga-se à VWAP (`precalculateRollingVWAP:47-60`: uma vez `NaN`, permanece `NaN`) e às métricas. Resultado silenciosamente errado.

**Correção mínima:** validar `open/high/low/volume` com `Number.isFinite` no filtro de entrada (ambos os motores) e rejeitar/ignorar a barra ou o ativo com mensagem em `messages`.

---

### F-08 — [ALTO] Parâmetros de risco/capital degenerados aceites

**Evidência:** `src/engine/backtesterEngine.js:196-216` e `src/engine/portfolioBacktester.js:52-80`

- `stopLoss: Number(params.stopLoss) || 0` → `0` e negativos passam; `stopType:'pct'` com `stopLoss=0` produz `slPrice === entry` → SL imediato.
- `initialCapital: Number(...) || 10000` → `-100` é aceite; `riskPerTradePct` negativo idem.
- `markovWindow: Number(params.markovWindow) || 150` → negativo passa; `buildTransitionMatrix` usa `Math.max(0, len-window)` (`markovEngine.js:131`) e devolve linhas uniformes de Laplace — Markov sem histórico, sinal arbitrário.
- `horizonDays` negativo/zero → `forecast` não propaga e o MC corre 0 passos.
- `takeProfit` negativo em `openPosition:333` coloca o TP abaixo do preço em LONG → saída imediata.
- Portefólio: `mcIterations`, `stopLoss`, `takeProfit` sem *clamp*.

**Impacto:** trades degeneradas, matrizes uniformes e métricas sem significado, sem erro reportado. Um `initialCapital` negativo rebenta `drawdownSeries` (`:532-535` só guarda `peakEq > 0`). Também o `warmup=0` é silenciosamente trocado por 200 (`:211`, `Number(0) || 200`).

**Correção mínima:** helper único `numInRange(v, min, max, def)` aplicado a todos os parâmetros numéricos; rejeitar (ou limitar) valores ≤0 para capital, risco, stop e take, janelas e horizon.
</br>

### F-09 — [ALTO] Ambiguidade same-bar: portefólio assume TP antes de SL (viés otimista)

**Evidência:**
- `src/engine/portfolioBacktester.js:144-145` — `if (candle.high >= tpPrice) ... else if (candle.low <= slPrice)` → **TP primeiro**.
- `src/engine/backtesterEngine.js:387-388` — a mesma barra testa **SL primeiro** (`if (bar.low <= effectiveStop) ... if (bar.high >= tpPrice)`), postura conservadora.

**Impacto:** quando ambos os níveis são tocados na mesma vela (frequente em dias voláteis), os dois motores dão resultados diferentes; o portefólio inflaciona winRate/PnL de forma sistemática. A entrada do portefólio é também ao `close` da vela do sinal (`:211`) enquanto `runSimulation` entra ao `open` seguinte (`:465-468`), somando otimismo.

**Correção mínima:** uniformizar a convenção pessimista (SL primeiro) no portefólio e documentar/metrificar a hipótese de execução; opcionalmente, usar o `open` da vela seguinte para entrada também no portefólio.

---

### F-10 — [MÉDIO] `stopType: 'atr'` e `riskPerTradePct` são ignorados no motor de carteira

**Evidência:**
- `src/engine/portfolioBacktester.js:359-372` — o wrapper não passa `stopType` ao `PortfolioBacktester`.
- `src/engine/portfolioBacktester.js:218-219` — SL/TP são sempre percentuais.
- `src/engine/portfolioBacktester.js:74` — `this.riskPerTradePct` é guardado mas nunca usado (a alocação usa `positionAllocationPct`, `:192/:208`).
- UI: `src/renderer/simulation.html:496` envia `stopType: 'atr'` por defeito e `riskPerTradePct` em `simulationRenderer.js:552`.

**Impacto:** a estratégia simulada não corresponde à configurada na UI; o utilizador julga estar a testar stops ATR e risco por trade quando testa percentagens fixas e alocação por slot.

**Correção mínima:** ou implementar ATR no `PortfolioBacktester` (recebendo `atr` do `analyzeSeries`), ou rejeitar/avisar na UI quando `engine==='portfolio' && stopType==='atr'`; usar `riskPerTradePct` no dimensionamento ou removê-lo do payload.

---

### F-11 — [MÉDIO] Reutilização de instância do `PortfolioBacktester` acumula estado

**Evidência:** `src/engine/portfolioBacktester.js:83-87` inicializa `cash`, `openPositions`, `closedTrades`, `dailyEquityCurve`, `messages`; `run()` (`:98-257`) nunca os reinicializa.

**Impacto:** um segundo `run()` na mesma instância soma capital já gasto, duplica trades e equity curves. O padrão atual (nova instância por run em `runPortfolioSimulation:392`) esconde o bug; qualquer reutilização/teste futuro produz resultados silenciosamente errados.

**Correção mínima:** mover a inicialização de estado para o início de `run()` (ou um método `reset()`).

---

### F-12 — [MÉDIO] `precomputeAssetIndicators` é calculado e nunca usado em `runSimulation`

**Evidência:** `src/engine/backtesterEngine.js:268` e `:277` criam `precomputed` (6 arrays `Float64Array` por ativo + VWAP + RVOL) e guardam-no em `assets`; não existe qualquer leitura de `.precomputed` no resto de `runSimulation` (só `BacktesterEngine.run:725` o usa).

**Impacto:** trabalho O(N) por ativo desperdiçado e ~48 bytes/vela retidos (ex.: 100 ativos × 5000 velas ≈ 24 MB) sem benefício. Mais grave: sugere que o caminho rápido foi planeado mas não ligado, o que alimenta o F-01.

**Correção mínima:** remover a chamada em `runSimulation` ou, preferencialmente, usá-la como gate antes de `evaluateSignal`.

---

### F-13 — [MÉDIO] `requestDB`: timers de timeout nunca são limpos

**Evidência:** `src/engine/simulationWorker.js:98-112`

```js
function requestDB(type, payload) {
  return new Promise((resolve, reject) => {
    ...
    setTimeout(() => { ... reject(new Error('DB request timeout')); }, DB_TIMEOUT_MS);
  });
}
```

e resposta em `:116-124` resolve mas não faz `clearTimeout`.

**Impacto:** cada pedido IPC retém um timer de 60 s e o respetivo closure; em universos grandes acumulam-se centenas de timers, atrasando o *idle* do worker e mantendo memória presa. O `Set cancelRequested` (`:85`, `:128-130`) também nunca é limpo para `runId` que nunca arranca.

**Correção mínima:** guardar o handle do `setTimeout` no registo de `dbRequests` e `clearTimeout` no caminho de resposta/timeout; limpar `cancelRequested` no fim de `handleStart` (já o faz no caminho normal) e num TTL para runs órfãos.

---

### F-14 — [MÉDIO] SQLite aberto/fechado por ticker no worker

**Evidência:** `src/engine/simulationWorker.js:150-153`

```js
function loadLocalCandles(dbPath, ticker, startDate, endDate) {
  const Database = require('better-sqlite3');
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try { db.pragma('journal_mode = WAL'); ... } finally { db.close(); }
}
```

É chamado dentro do ciclo de `handleStart` (`:256`) para cada ticker.

**Impacto:** O(U) aberturas/fechos de conexão e O(U) pragmas; para universos de centenas de tickers o custo de I/O domina o carregamento. O módulo `workerData` já usa uma conexão única (`:18`), pelo que o caminho message-based está assimétrico.

**Correção mínima:** abrir uma conexão `readonly` uma vez por run (ou cachear por `dbPath`) e reutilizá-la, fechando no fim de `handleStart`.

---

### F-15 — [MÉDIO] Monte Carlo não determinístico nos caminhos `runSimulation`/`BacktesterEngine`

**Evidência:**
- `src/quant/monteCarloEngine.js:232` — `const rng = typeof opts.random === 'function' ? opts.random : Math.random;`
- `src/engine/backtesterEngine.js:156-169` e `:838-852` — nunca é passado `seed`/`random`.
- `src/engine/portfolioBacktester.js:301` — o portefólio passa `seed: this.mcSeed` (default 42), mas o `runSimulation` não.

**Impacto:** duas execuções com os mesmos dados devolvem KPIs diferentes no motor principal; impossível reproduzir/auditar um relatório ou comparar variantes. O seed da UI/API não tem efeito no caminho não-portefólio.

**Correção mínima:** acrescentar `seed`/`random` às opções em `evaluateSignal` (`:161-168`) e `BacktesterEngine.evaluateSignal` (`:838-842`), propagando `cfg.mcSeed` com default fixo (ex.: 42).

---

### F-16 — [MÉDIO] `workerData`: sem cancelamento, sem fallback nativo e progresso deturpado

**Evidência:** `src/engine/simulationWorker.js:10-79`
- O ciclo `for (let i = 0; i < total; i++)` (`:37-72`) nunca consulta `cancelRequested`; mensagens `action:'cancel'` são ignoradas nesse modo.
- `:16` — `const quantEngine = require('../native');` sem `try/catch`; a ausência do módulo nativo aborta o worker inteiro (o modo message-based faz fallback em `:316-317`).
- `:67` — `tradesCount: results.length` reporta **nº de ativos**, não de trades.
- `:74` — `COMPLETE` inclui todos os resultados; para carteiras grandes o `postMessage` faz *structured clone* de muitos MB e pode bloquear o main process.

**Impacto:** sem cancelar uma simulação pesada (o utilizador não tem botão funcional nesse modo), erro total se o binário nativo faltar, e progresso enganador. O payload gigante pode causar *jank* na UI.

**Correção mínima:** verificar `cancelRequested` no ciclo e terminar com `{type:'CANCELLED'}`; envolver `require('../native')` em `try/catch`; reportar o nº real de trades; enviar resultados por *chunks* ou persistir e devolver referência.

---

### F-17 — [BAIXO] Datas com timestamp não normalizadas em `runSimulation`

**Evidência:** `src/engine/backtesterEngine.js:205-206` faz `slice(0,10)` a `startDate/endDate`, mas `:229-236` preserva `date: c.date` e `:237` ordena por `String(date)`. O `endIdx` (`:262-264`) compara `String(candles[endIdx].date) > cfg.endDate`.

**Impacto:** com datas tipo `2024-01-02T00:00:00Z`, `'2024-01-02T…' > '2024-01-02'` é `true`, pelo que a última vela do intervalo é silenciosamente excluída. O caminho do worker normaliza (`simulationWorker.js:247-250`), mas chamadas diretas à API (`test/*`, integrações) não. `allDates` e `equityCurve` também ficam com formato misto.

**Correção mínima:** normalizar `date: String(c.date).slice(0,10)` no mapeamento de `runSimulation`, como já é feito no portefólio (`portfolioBacktester.js:269`).

---

### F-18 — [BAIXO] Tickers duplicados colidem silenciosamente

**Evidência:** `src/engine/backtesterEngine.js:314` (`positions = new Map()` por ticker), `:572` (`ptrs.set(v.a.ticker, ...)`), `src/engine/portfolioBacktester.js:224` (`openByTicker.set`).

**Impacto:** duas entradas no universo com o mesmo ticker partilham a chave: a segunda posição substitui a primeira nos mapas de estado, e o benchmark duplica a exposição de um só ativo. Sem validação nem aviso.

**Correção mínima:** deduplicar o universo por ticker no pré-processamento (ou usar índice composto `ticker#i`).

---

### F-19 — [BAIXO] Clamps em falta para `maxPositions`/`positionAllocationPct`

**Evidência:** `src/engine/portfolioBacktester.js:61-66`

```js
this.positionAllocationPct = config.positionAllocationPct != null ? Number(config.positionAllocationPct) : ...;
this.maxPositions = config.maxPositions != null && Number(config.maxPositions) > 0 ? Number(config.maxPositions) : ...;
```

`positionAllocationPct = 5` (percentagem enviada como fração) ou negativo, `maxPositions = 2.7`, não são validados. A UI envia a fração correta, mas a API pública aceita qualquer valor.

**Correção mínima:** `clamp(positionAllocationPct, 0, 1)` e `Math.floor(maxPositions)` com validação `1 <= maxPositions <= 1000`.

---

### F-20 — [BAIXO] `iterations` do Monte Carlo não validado

**Evidência:** `src/quant/monteCarloEngine.js:218`, `:237`, `:263`

```js
const iterations = opts.iterations || MC_ITERATIONS;
...
const winRate = (counts.tpHits / iterations) * 100;
```

`iterations = 1000.5` executa 1001 ciclos mas divide por 1000.5; `0`/negativo cai no default; negativos explícitos não. Não há `Math.floor` nem limite superior (uma API pode pedir 10⁹ iterações).

**Correção mínima:** `const iterations = Math.max(1, Math.min(1e6, Math.floor(Number(opts.iterations) || MC_ITERATIONS)));`

---

### F-21 — [INFORMATIVO] Prototype pollution: não explorável nos caminhos atuais

**Evidência:** análise de `src/engine/simulationWorker.js:201-205` (spread de `params`), `src/engine/backtesterEngine.js:186` e `src/engine/portfolioBacktester.js:353` — todas as leituras são por campo explícito (`params.direction`, `params.stopLoss`, …). O spread usa `CreateDataProperty`, pelo que uma chave `__proto__` de um `JSON.parse` (que já cria *own property*) não aciona o setter global; não existe `Object.assign`/`merge` recursivo nos três ficheiros.

**Risco residual:** baixo. Como defesa em profundidade, validar `params` contra uma allowlist de chaves e tipos antes de qualquer `...spread`, e nunca fazer merge genérico de payloads do renderer.

---

### F-22 — [INFORMATIVO] Convenções que mascaram caudas e limites

**Evidência:**
- `src/engine/backtesterEngine.js:610-616` e `src/quant/workstation/metrics.js:197-200` — `profitFactor`/`payoffRatio` limitados a `99.9` quando o denominador é 0, em vez de `Infinity`/`null` explícito.
- `src/engine/backtesterEngine.js:722` — `BacktesterEngine.run` rejeita séries <220 velas enquanto `runSimulation` aceita qualquer tamanho >warmup; dois contratos divergentes.
- `src/engine/portfolioBacktester.js:276` — o parâmetro `quantEngine` de `evaluateAssetGatekeepers` é ignorado (o módulo nativo entra por `monteCarloEngine.js:7-9`).

**Impacto:** relatórios indicam 99.9 (aparenta muito bom) em vez de tratar o caso degenerado; inconsistência de requisitos mínimos entre motores.

**Correção mínima:** devolver `null`/`'∞'` para fator sem perdas, alinhar o mínimo de velas e remover o parâmetro morto.

---

## Performance — quantificação resumida

| Cenário | Caminho | Custo estimado |
|---|---|---|
| 1 ativo × 5000 velas (warmup 200) | `runSimulation` | Σ i ≈ 12,5 M passagens de barra; ~10 arrays/barra (~50 k array allocs); centenas de M de ops |
| 100 ativos × 2500 velas | `runSimulation` | ~250 k chamadas `evaluateSignal`; ~310 M passagens; ~2,5 M arrays grandes |
| 50 ativos × 2500 dias (warmup 200) | `PortfolioBacktester` | ~115 k avaliações candidato-dia; ≈3×10⁹ ops; MC até ≈4×10⁹ passos |
| 500 tickers, message-based | `simulationWorker` | 500 conexões SQLite abertas/fechadas + 500 pragmas WAL; 500 timers de 60 s |

O módulo nativo (`build/Release/quant_engine.node`) acelera apenas o MC de 1ª ordem; o mapa de retornos por estado, os indicadores e o MC de 2ª ordem permanecem em JS.

---

## Lacunas de testes

1. `test/simulation-resilience.test.js` testa apenas o renderer (DOM ausente); **não** testa resiliência dos motores (NaN, cancelamento, timeouts).
2. `test/backtester-engine.test.js:271` corre `endDate:''` mas não assegura `trades.length > 0` — o bug F-04 passa despercebido.
3. Não existe teste para `commissionPct/slippagePct` negativos, `stopLoss=0`, `initialCapital<0` (F-05/F-08).
4. Não existe teste para `high/low` NaN/Infinity (F-07).
5. `portfolio-backtester.test.js` usa sempre `side:'LONG'` no stub; o F-03 (side ignorado) não é coberto.
6. Sem teste de reutilização da instância `PortfolioBacktester` (F-11) nem de determinismo com `mcSeed` (F-15).
7. Sem teste de orçamento de tempo/complexidade para `runSimulation`/`PortfolioBacktester`; `test/performance.test.js` cobre só SQLite e `multithreaded-simulation.test.js` só a VWAP.
8. Sem teste do caminho `workerData` (cancelamento, fallback nativo ausente).
9. Sem teste para datas com timestamp (F-17) nem tickers duplicados (F-18).

---

## Riscos residuais

- Não foi feita instrumentação de CPU/heap; as quantificações são analíticas (contagem de passagens/alojações) e assumem séries diárias contíguas.
- O comportamento do nativo C++ não foi auditado além da interface (`src/native/index.js`); divergências nativo/JS no MC (ex.: consumo do RNG, tratamento de `seed`) podem existir.
- Não foi auditado o pipeline que produz `universe.candles` (importador/sync); assunções sobre qualidade dos dados dependem desse caminho.
- O comportamento do `better-sqlite3` com `pragma('journal_mode = WAL')` em conexões readonly (`simulationWorker.js:19`, `:154`) não foi verificado em runtime.

## Limitações da auditoria

- Apenas análise estática; nenhum teste foi executado (permissão `bash: ask` não foi usada para correr a suite).
- Ficheiros fora do alcance (`workstationEngine.js`, `signalPool.js`, renderer) foram consultados só para confirmar exposição de parâmetros.
- Não foi avaliada a correção estatística dos métodos (viés de sobrevivência, purga/embargo do CPCV) além do que impacta diretamente os motores auditados.
