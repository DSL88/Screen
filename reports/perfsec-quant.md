# Relatório de Auditoria — Performance, Segurança e Estabilidade Numérica (módulos quantitativos)

- **Papel**: auditor sénior de algoritmos numéricos / performance / robustez (perfsec-quant, modo leitura).
- **Data**: 2026-09-10
- **Âmbito**: `src/quant/markovEngine.js`, `src/quant/monteCarloEngine.js`, `src/quant/indicators.js`, `src/quant/workstation/{entrySignal,metrics,fracdiff,graham,sentimentProxy,validation,factorPurification}.js`; chamadas relevantes em `src/engine/{backtesterEngine,workstationEngine,portfolioBacktester,scanner,signalPool,signalWorker,simulationWorker}.js` e `src/native/{addon.cpp,monte_carlo.cpp,index.js}`.
- **Método**: inspeção estática + verificação empírica controlada (micro-benchmarks e repro de defeitos numéricos). Nenhum ficheiro de código-fonte foi alterado.
- **Testes verificados**: `test/backtester-engine.test.js`, `test/markov-order2.test.js`, `test/rvol.test.js` (17/17 passam). As lacunas estão na secção 3.

## 1. Resumo executivo

| Severidade | Nº findings |
|---|---|
| Crítico | 4 |
| Alto | 6 |
| Médio | 8 |
| Baixo | 6 |
| Informativo | 5 |
| **Total** | **29** |

**Top 3 (impacto imediato):**

1. **C3 — `src/quant/workstation/validation.js:65-82` — DSR com escala mista (anualizada vs por-período)**: qualquer Sharpe realizado positivo satura o DSR em 1.0. Verificado: retornos de ruído → `dsr=1, isApproved=true`. A validação Fase 6 aprova estratégias sem edge.
2. **C1 — `src/quant/monteCarloEngine.js:218` + `src/engine/workstationEngine.js:170` + `src/native/addon.cpp:189` — `mcIterations`/`daysAhead` sem limite máximo**: `iterations: Infinity` (transportável por structured clone no IPC) ou `1e9` provoca loop não-terminante / hang do processo. Sem timeout no caminho `simulationWorker`.
3. **A1 — `src/engine/backtesterEngine.js:478` (`evaluateSignal` por barra) + `src/quant/markovEngine.js:284` + `src/quant/monteCarloEngine.js:231` — recalculo O(n²) de indicadores + Monte Carlo por barra**: ~4-8 ms/barra (motor nativo), ~30-40 s/ativo em 5000 barras; 100 ativos ≈ 1 h num único worker.

---

## 2. Findings detalhados

### 2.1 CRÍTICO

#### C1 — DoS de cálculo: `iterations` e `daysAhead` sem limite máximo
- **Evidência**: `src/quant/monteCarloEngine.js:218` (`const iterations = opts.iterations || MC_ITERATIONS;`), `:219` (`daysAhead = opts.daysAhead || opts.horizon || MC_DAYS_AHEAD`), loops `:93` e `:158`; `src/engine/workstationEngine.js:159` e `:170` (`Number(params.mcIterations) || MC_ITERATIONS` — `Infinity` sobrevive ao `||`); `src/engine/simulationWorker.js:314-328` (sem timeout de cálculo); `src/native/addon.cpp:156-167,189`.
- **Impacto**: `mcIterations: 2147483647` (JSON válido) ou `Infinity` (structured clone no IPC Electron) origina 2,1e9 × 35 passos por sinal ≈ hang de horas/dias; o worker de simulação só termina por cancelamento explícito. `daysAhead: Infinity` no loop interno é não-terminante quando `returnsByState` está vazio (`continue` salta as verificações de SL/TP — `monteCarloEngine.js:104,177`).
- **Correção mínima**: sanitizar à entrada, ex.: `const iterations = Math.min(1_000_000, Math.max(1, Math.floor(Number(opts.iterations)) || MC_ITERATIONS));` e `daysAhead = Math.min(2520, Math.max(1, Math.floor(Number(opts.daysAhead)) || MC_DAYS_AHEAD));` rejeitando `!Number.isFinite`. Idem em `workstationEngine.js:170` e no wrapper nativo.

#### C2 — DoS de cálculo: `horizonDays` sem limite no `forecast`
- **Evidência**: `src/quant/markovEngine.js:287` (`horizon = params.horizonDays ?? HORIZON`), `:361` (`forecast(M1, lastState, horizon)`), `:230` (`for (let step = 0; step < h; step++) v = matVec(M, v);`); entrada não sanitizada em `src/engine/workstationEngine.js:167` (`Number(params.horizonDays) || 5` — `Infinity` sobrevive).
- **Impacto**: `horizonDays: 1e9`/`Infinity` executa 1e9 × N² multiplicações síncronas no worker → UI congelada. Um único valor no payload IPC bloqueia a simulação.
- **Correção mínima**: `horizon = Math.min(504, Math.max(1, Math.floor(Number(params.horizonDays)) || HORIZON));` (ou rejeitar > array máximo suportado) e validar `Number.isFinite` no boundary do worker.

#### C3 — DSR mistura Sharpe anualizado com erro-padrão por-período → validação sempre aprova
- **Evidência**: `src/quant/workstation/validation.js:65` usa `sharpeRatio(arr)` que multiplica por `Math.sqrt(TRADING_DAYS)` (`:54`); `:71` calcula `srStd = Math.sqrt(denomVar / (T - 1))` (escala diária); `:78` usa `srStd` para o benchmark; `:81` `z = (srHat - srBenchmark) / (srStd + 1e-8)`.
- **Impacto**: `srHat` fica ~15.87× inflado face ao denominador. Reproduzido: retornos ruído 500 amostras → `{"dsr":1,"dsrPercent":100,"pbo":0,"isApproved":true}`; Sharpe realizado 0.39 anualizado já dá DSR=1. A Fase 6 do relatório (`workstationEngine.js:402`, `portfolioBacktester.js:405`) aprova sistematicamente qualquer estratégia com Sharpe OOS > ~0.003.
- **Correção mínima**: usar a mesma frequência em todo o DSR: calcular `srHat = mean(arr)/stdev(arr)` (sem √252) ou multiplicar `srStd` e o benchmark por `√252`. Adicionar teste que exija `dsr < 0.5` para ruído.

#### C4 — PBO estruturalmente sempre 0 → o gate `pbo < 0.30` nunca bloqueia
- **Evidência**: `src/quant/workstation/validation.js:160` (`isSharpes.push([sharpeRatio(...)])` — cada linha tem **1** estratégia), `:170` (`pbo = nCombos >= 2 && isSharpes[0].length >= 2 ? ... : 0` — condição impossível), `:179` (`isApproved: dsr > 0.95 && pbo < 0.30`).
- **Impacto**: combinado com C3, `isApproved` reduz-se a `dsr > 0.95` que é praticamente sempre verdade → falsos positivos no relatório de validação e no gate de decisão. Reproduzido com ruído: `pbo=0, isApproved=true`.
- **Correção mínima**: enquanto não existir matriz multi-estratégia, devolver `pbo: null` e remover o gate (não simular 0); ou calcular PBO sobre a distribuição OOS (ex.: fração de blocos cujo Sharpe OOS fica abaixo da mediana) documentando a semântica.

### 2.2 ALTO

#### A1 — Recalculo O(n²): indicadores completos + Monte Carlo em cada barra
- **Evidência**: `src/engine/backtesterEngine.js:478` chama `evaluateSignal(a.candles, a.ptr, cfg)` em todas as barras; `:112-121` reconstrói RSI/ADX/BB via `analyzeSeries(slice)`; `:156-169` chama o MC; `src/quant/monteCarloEngine.js:231` (`buildStateReturnsMap(candles, ...)`) reconstrói RSI/ADX/BB **outra vez**. `precomputeAssetIndicators` (`backtesterEngine.js:68`) já pré-calcula VWAP/RVOL mas não é usado nesta via. No workstation, `entrySignal.js:31` e `:72` recalculam a mesma série duas vezes por sinal (blocos de 21/35 dias mitigam, não eliminam).
- **Impacto medido (motor nativo carregado)**: `analyzeSeries` n=5000, ordem 2 ≈ 8,2 ms; MC 1000×35 sobre n=5000 ≈ 4,6 ms; `analyzeSeries` n=2500 ≈ 2 ms. Em 5000 barras por ativo ≈ 20-40 s; universo de 50-100 ativos ≈ 17-70 min num worker; com padrões de uso superiores (ordem 2 + mcIterations 5000 do workstation ≈ 5×) degrada para horas.
- **Correção mínima**: pré-calcular séries de estado/indicadores uma vez por ativo (`precomputeAssetIndicators`) e passar `{states, returnsByState, closes}` já prontos a `analyzeSeries`/`runMarkovMonteCarloSimulation`; atualizar a matriz de transição de forma incremental (remover 1 par, adicionar 1 par) em vez de reconstruir.

#### A2 — Parâmetros numéricos do utilizador sem validação (períodos, stops, janela)
- **Evidência**: `src/quant/markovEngine.js:294-301` (`rsiPeriod`, `adxPeriod`, `bbPeriod`, `slPct`, `tpPct` sem limites); `src/quant/indicators.js:221` (`if (n < period * 2)` não rejeita período ≤ 0; o ramo `:269-272` produz `NaN` em cascata com estado RMA nulo); `:177`/`:102`/`:20`/`:63`/`:394` guards parciais; `src/engine/portfolioBacktester.js:72` aceita `config.mcIterations` convertido mas sem teto.
- **Impacto**: `rsiPeriod: -5` ou `adxPeriod: 0` propaga `NaN`/sem sinais silenciosamente; `slPct ≤ 0`/`tpPct ≤ 0` inverte ou anula stops no MC (`monteCarloEngine.js:86-87`), gerando win rates espúrios; `bbMult` negativo inverte bandas. Nenhum teste cobre estes casos.
- **Correção mínima**: helper `num(v, lo, hi, def)` aplicado a todos os parâmetros em `analyzeSeries`/`runMarkovMonteCarloSimulation` e rejeição explícita (`return null`) de períodos ≤ 0 ou > nº de velas.

#### A3 — Conversão C++ indefinida (`static_cast<int>`) de parâmetros não limitados
- **Evidência**: `src/native/addon.cpp:156-160` aceita qualquer `iterations` ≥ 1 sem teto; `:162-167` idem `daysAhead`; `:189` `static_cast<int>(iterationsD)` / `static_cast<int>(daysAheadD)`.
- **Impacto**: conversão `double→int` fora da gama representável é *undefined behavior* em C++. Em x86-64 tende a `INT_MIN` (o guard `iterations <= 0` devolve zero, mascarando o erro); em ARM64 satura em `INT_MAX` → ~2,1e9 iterações → hang. `Infinity` e `1e300` chegam aqui diretamente de `monteCarloEngine.js:248`.
- **Correção mínima**: limitar antes do cast: `iterationsD = std::min(iterationsD, 1.0e7); daysAheadD = std::min(daysAheadD, 5000.0);` e usar `static_cast<int>(std::lround(...))` apenas após verificar `std::isfinite` e limites.

#### A4 — `stddev` sofre cancelamento catastrófico (`E[X²] − E[X]²`)
- **Evidência**: `src/quant/indicators.js:68-84` (soma de quadrados direta em `:71,75,81`; variância em `:75,83`).
- **Impacto**: para preços com magnitude alta (ex.: 1e8) e variância pequena, `sumSq/period - mean*mean` perde todos os dígitos significativos e o `Math.max(0, ...)` fixa o resultado em 0. Reproduzido: série base 1e8 alternando ±1 → `stddev=0` (valor correto 1). Como `bollingerBands` (`:303-319`) usa `stddev` para `pctB`, os estados de Markov passam a ser classificados com base em bandas erradas.
- **Correção mínima**: cálculo de dois passos (média e depois Σ(x−m)²) por janela — `period` é pequeno (30) e o custo O(n·period) é aceitável — ou Welford incremental com remoção; manter `Math.max(0, ·)`.

#### A5 — `sma`/`ema` concatenam strings numéricas (valores silenciosamente errados)
- **Evidência**: `src/quant/indicators.js:23` (`sum += values[i]`), `:27` (`sum += values[i] - values[i - period]`), `:43` idem em `ema`. Os volumes são mapeados sem coerção em `markovEngine.js:341` (`candles.map(c => c.volume)`).
- **Impacto**: `sma(["100","100","100"], 2)` devolve `[null, 50050, 500500]` (em vez de 100) — **não** dá `NaN`, logo não é detetado; `volumeSma`/`volumeValid` (`markovEngine.js:411-413`) e RVOL passam a decidir com valores absurdos. `prepareAsset` (`workstationEngine.js:64`) coage, mas a API pública e chamadas diretas não.
- **Correção mínima**: `const v = Number(values[i]); sum += Number.isFinite(v) ? v : 0;` em `sma`/`ema`, e coerção na origem (`volumes = candles.map(c => Number(c.volume) || 0)`).

#### A6 — Entradas `null`/não-array e valores não finitos: exceção antes dos guards e NaN em cascata
- **Evidência**: `src/quant/markovEngine.js:304` (`candles = candles.filter(...)`) executa **antes** do guard `if (!candles ...)` em `:306`; `src/quant/workstation/entrySignal.js:72` passa `candles.slice(...)` **sem filtrar** `close == null` ao Monte Carlo; `src/quant/monteCarloEngine.js:36-71` e `src/quant/indicators.js` não validam `NaN` (RSI/ADX/BB propagam `NaN`; `buildStateSeries` aceita-os).
- **Impacto**: `analyzeSeries(null)` → `TypeError` (reproduzido). Velas em formação (`close: null`) no MC fazem `states` quase toda `-1` e `returnsByState` vazio; combinado com `daysAhead`/`iterations` sem limite (C1) torna-se não-terminante.
- **Correção mínima**: no topo de `analyzeSeries`/`runMarkovMonteCarloSimulation`: `if (!Array.isArray(candles)) return ...; candles = candles.filter(c => c && Number.isFinite(Number(c.close)));` e usar a mesma fatia filtrada em todo o pipeline (inclusive MC).

### 2.3 MÉDIO

#### M1 — `winRate` não finito contorna o gate de Monte Carlo
- **Evidência**: `src/quant/workstation/entrySignal.js:77` (`if (!mc || mc.winRate < cfg.minWinRateMC) return null;`), `src/quant/monteCarloEngine.js:237,263` (`(counts.tpHits / iterations) * 100`), `src/engine/backtesterEngine.js:170`.
- **Impacto**: com `iterations` não numérico (ex.: string `"abc"` via API direta) o loop não corre e `winRate` é `NaN`; `NaN < 50` é `false` → o sinal **passa** o gate. Exposição limitada pelos sanitizadores atuais do UI, mas a API é pública e usada em `scanner.js`/testes.
- **Correção mínima**: `if (!mc || !Number.isFinite(mc.winRate) || mc.winRate < cfg.minWinRateMC) return null;` e rejeitar `iterations` não finito na engine.

#### M2 — `buildStateSeries` classifica `NaN` como estado neutro
- **Evidência**: `src/quant/markovEngine.js:97-113` — comparações com `NaN` são sempre `false`, pelo que `bb_zone`/`adx_zone` caem em `1` (estado neutro) em vez de `-1`.
- **Impacto**: velas inválidas contaminam a matriz de transição como se fossem neutras, diluindo probabilidades bull/bear sem qualquer aviso. O guard `bbp == null` não apanha `NaN`.
- **Correção mínima**: `if (!Number.isFinite(bbp) || !Number.isFinite(ax)) continue;`.

#### M3 — `graham.resolveSnapshot` usa registo futuro quando não há snapshot anterior
- **Evidência**: `src/quant/workstation/graham.js:87-99` — se nenhum `t <= year`, devolve `dated[0].h` (o mais antigo do histórico, que é **posterior** ao ano avaliado).
- **Impacto**: lookahead bias em backtests point-in-time (ex.: avaliar 2010 com histórico a começar em 2015 usa dados de 2015). O comentário `:98` afirma "sem lookahead futuro", o que não corresponde ao código.
- **Correção mínima**: devolver `null` quando não existe registo `<= y`; o caller já trata `unknown` (`graham.js:160-166`).

#### M4 — `factorPurification`: complexidade latente O(n³)/O(k⁵)
- **Evidência**: `src/quant/workstation/factorPurification.js:15-32` Gauss-Jordan O(k³); `:64-84` (VIF corre `ols` k vezes); `:88-103` (remoção iterativa → até k chamadas de `computeVIF`); `:106-121` dummies por setor único → matriz n×(n−1).
- **Impacto**: com k features e n setores únicos, `neutralizeFeatureTwoStage` é O(n³) e `selectPurifiedFeatures` pode ser O(k⁵). Hoje `purifyAndRank` fixa 4 colunas (`workstationEngine.js:100-105`), mas a API exportada aceita qualquer dimensão sem limite.
- **Correção mínima**: limite duro (ex.: k ≤ 50), agrupar setores raros numa categoria "outros" e resolver OLS por QR/ridge em vez de equações normais.

#### M5 — `buildStateReturnsMap` duplicado (markov vs Monte Carlo)
- **Evidência**: `src/quant/markovEngine.js:240-265` e `src/quant/monteCarloEngine.js:36-71` implementam a mesma lógica; `monteCarloEngine.js:37-39` só delega no primeiro quando `stateSpace !== '9'`, mantendo a duplicação exatamente para o caso padrão.
- **Impacto**: divergência futura entre caminhos 1ª ordem (default) e 3/6 estados; correções aplicadas a um lado não ao outro.
- **Correção mínima**: eliminar a implementação local de `monteCarloEngine.buildStateReturnsMap` e delegar sempre em `buildStateReturnsMapForCandles`.

#### M6 — `calculateRollingVWAP` O(n × period) vs versão O(n) já existente
- **Evidência**: `src/quant/indicators.js:325-348` (duplo loop + 4 `Number()` por elemento); já existe `precalculateRollingVWAP` O(n) em `src/engine/backtesterEngine.js:39-63`.
- **Impacto**: com `VWAP_PERIOD=20` o custo é aceitável, mas é chamado por sinal/barra dentro dos motores e é o padrão que escala mal se o período se tornar configurável.
- **Correção mínima**: converter `calculateRollingVWAP` para janela deslizante (soma e remoção do elemento que sai) e reutilizá-la.

#### M7 — Pesos FFD recalculados em cada chamada (sem memoização)
- **Evidência**: `src/quant/workstation/fracdiff.js:16-27` e `:39`; chamada por sinal em `src/quant/workstation/entrySignal.js:24`.
- **Impacto**: para `d=0.4`, `width` pode chegar a centenas (limite `maxLags=2000`); o cálculo dos pesos e a alocação de `Float64Array` repetem-se em milhares de sinais. Em `findOptimalD` (`fracdiff.js:115-131`) são 21 reconstruções de pesos, com custo O(n × width) cada.
- **Correção mínima**: cache `Map` com chave `${d}|${thres}|${maxLags}` ao nível do módulo; devolver cópia imutável (ou `Float64Array` reutilizado).

#### M8 — `sortinoRatio` divide pelo número de retornos negativos (não pelo total)
- **Evidência**: `src/quant/workstation/metrics.js:92-96` (`downside` filtrado; `ds = sqrt(mean(x²))` sobre apenas os negativos).
- **Impacto**: denominador menor → Sortino sobrestimado; comparações entre estratégias com frequências de perda diferentes ficam enviesadas.
- **Correção mínima**: `ds = sqrt(Σ_{x<0} x² / n)` (n total) mantendo o filtro para os numeradores.

### 2.4 BAIXO

#### B1 — `shouldEmit` com `edgeThreshold` indefinido contorna o gate de edge
- **Evidência**: `src/quant/markovEngine.js:535` (`if (result.edge < edgeThreshold) return false;`); comparação com `undefined` é sempre `false`.
- **Correção mínima**: `if (!Number.isFinite(edgeThreshold) || result.edge < edgeThreshold) return false;`.

#### B2 — `checkSolvency` com limiar 0 provoca divisão por zero no score
- **Evidência**: `src/quant/workstation/graham.js:121` (`clamp(cr / th.minCurrentRatio, ...)`); `grahamThresholds` é aceite do utilizador (`workstationEngine.js:174`).
- **Correção mínima**: `th.minCurrentRatio > 0 ? cr / th.minCurrentRatio : (cr > 0 ? 1 : 0)`; idem para `maxDebtEquity` em `:122`.

#### B3 — `metrics.toNum` converte silenciosamente `null`/inválidos em 0
- **Evidência**: `src/quant/workstation/metrics.js:18-21`, usado em drawdown/expectancy/CAGR (`:73-74`, `:102-107`, `:130-134`).
- **Correção mínima**: devolver `null` e filtrar antes das agregações, ou contar inválidos e expor `dataQuality`; no mínimo, `log`/mensagem quando a taxa de inválidos for alta.

#### B4 — `evaluateGraham` pesquisa na cadeia de protótipos
- **Evidência**: `src/quant/workstation/graham.js:144` (`fundamentalData[baseTicker(ticker)] || fundamentalData[ticker]`). Tickers como `"constructor"`/`"toString"` resolvem para propriedades herdadas de `Object.prototype`.
- **Impacto**: sem escrita (não há prototype pollution), mas o resultado é `unknown/approved=true` em vez de erro de dados — bypass silencioso do gate fundamental.
- **Correção mínima**: `Object.prototype.hasOwnProperty.call(fundamentalData, key)`, ou normalizar `fundamentalData` para `Map`/`Object.create(null)`.

#### B5 — `analyzeSeries` ordem 2 constrói a matriz de 1ª ordem duas vezes
- **Evidência**: `src/quant/markovEngine.js:357` (`M1 = buildTransitionMatrix(...)`) e `:437` → `buildTransitionMatrixOrder2` que volta a chamar `buildTransitionMatrix` em `:182`.
- **Correção mínima**: passar `M1` como parâmetro opcional a `buildTransitionMatrixOrder2` (fallback já calculado em `:357`).

#### B6 — `forecast` não valida o limite superior de `currentState`
- **Evidência**: `src/quant/markovEngine.js:225-229` — valida apenas `currentState < 0`; `v[currentState] = 1` com índice ≥ N cria buraco e `matVec` (`:216`) soma `undefined` → `NaN` (não exportado, exposição interna).
- **Correção mínima**: `if (currentState < 0 || currentState >= M.length) return null;`.

### 2.5 INFORMATIVO

#### I1 — Sem prototype pollution de escrita detetada
- Percorridos spreads/mesclagens de parâmetros (`graham.js:103`, `monteCarloEngine.js:251`, `workstationEngine.js:108`, `purifyAndRank`). Não existem atribuições a `__proto__`/`constructor.prototype`. Apenas leitura herdada em B4.

#### I2 — Lacunas de cobertura de testes (detalhe na secção 3)
- Nenhum teste valida limites de `mcIterations`/`horizonDays`, entradas `null`/strings, NaN em indicadores, precisão do `stddev` deslizante, ou correção do DSR/PBO. `workstation-engine.test.js:91-96` só exige `dsr ∈ [0,1]`, que passa trivialmente com `dsr=1`.

#### I3 — `findOptimalD` e `combinations` latentes
- `fracdiff.js:115-131` (`findOptimalD`) não é chamado em produção (apenas `test/workstation-engine.test.js:78`); custo O(21 × n × width). `validation.js:117-126` (`combinations`) materializa todas as combinações; `nGroups/kTestGroups` estão hoje fixos em 5/2, mas a API não valida limites.

#### I4 — Paralelismo: workers limitados; timeout assimétrico
- `signalPool.js:53` limita corretamente `workerCount` a `assets.length`; `signalPool.js:69` aplica timeout de 120 s, mas o caminho principal de simulação (`simulationWorker.js:314-328`) não tem timeout de cálculo — depende apenas de cancelamento explícito.

#### I5 — Monte Carlo sem seed usa RNG não reprodutível
- `monteCarloEngine.js:232` (`Math.random` por omissão) e `native/monte_carlo.cpp:49-53` (`std::random_device`); o fluxo `entrySignal` fixa `mcSeed` (`entrySignal.js:75`) e é determinístico, mas chamadas diretas à API não são.

---

## 3. Cobertura de testes: verificação e lacunas

**Verificado (executado com `node --test`):** `test/rvol.test.js` + `test/markov-order2.test.js` → 17/17 passam. `test/backtester-engine.test.js` usa stubs de `analyzeSeries` e `runMarkovMonteCarloSimulation` (`:13-44`), pelo que **não exercita** os motores reais.

**Lacunas concretas:**

1. `test/backtester-engine.test.js:34-41` injeta stubs nos módulos quantitativos — nenhuma verificação de precisão/limites dos motores reais passa por este ficheiro.
2. `test/markov-order2.test.js:53-92` valida apenas somas=1 e dimensões; falta comparação numérica 1ª vs 2ª ordem e casos com `NaN`/janela inválida.
3. `test/rvol.test.js` cobre divisão por zero (`:33-48`) mas não cobre volumes em string (A5) nem períodos negativos/zero.
4. `test/workstation-engine.test.js:91-96` aceita `dsr=1`; não existe nenhum teste que exija `pbo > 0` — teria detetado C4.
5. Não existem testes de: `horizonDays`/`mcIterations` gigantes ou `Infinity`, `analyzeSeries(null)`, `stddev` com valores de grande magnitude, `forecast` com estado fora de gama, `graham.resolveSnapshot` sem snapshot anterior.
6. Testes de performance (`test/performance.test.js`, `test/benchmark_mc.js`) não têm asserção de orçamento por ativo/barra que apanhe regressões O(n²).

---

## 4. Riscos residuais e limitações da auditoria

- **Natureza**: auditoria estática + repros pontuais; não foi feito fuzzing contínuo nem profiling com `perf`/`--cpu-prof`, nem teste de carga com universos reais.
- **C++ nativo**: `addon.cpp`/`monte_carlo.cpp` analisados por leitura e pela fronteira N-API; o comportamento de `static_cast<int>` fora de gama (A3) é dependente de arquitetura/compilador. Não foi construído um binário instrumentado com UBSan/ASan.
- **Fronteira IPC**: não foi auditada a validação no renderer nem no canal `ipcMain` a montante de `simulationWorker.js`; assume-se que os parâmetros chegam sem schema. Se existir validação a montante, a severidade de C1/C2/A3 desce à dimensão de defesa em profundidade (mas mantém-se: os módulos `src/quant/*` são APIs públicas e não validam).
- **Timings**: medidos numa única máquina (darwin, motor nativo carregado); a extrapolação para o fallback JS puro (mais lento) é conservadora por defeito.
- **Correção financeira**: C3/C4/M3/M8 afetam decisões e resultados de backtest; a auditoria não quantificou o impacto em PnL de carteiras reais, apenas demonstrou que a validação pode aprovar ruído.
- **Não alterado**: nenhum ficheiro em `src/` foi modificado; apenas este relatório foi criado.

---

## Anexo A — Reproduções empíricas

```text
$ node -e '... validation.validateStrategy(ruído 500 amostras, {nGroups:5,kTestGroups:2,nTrials:10})'
noise    {"valid":true,"nCombinations":10,"sharpeOOS":0.39,"dsr":1,"dsrPercent":100,"pbo":0,"pboPercent":0,"isApproved":true}
drift    {"valid":true,"nCombinations":10,"sharpeOOS":27.96,"dsr":1,"dsrPercent":100,"pbo":0,"pboPercent":0,"isApproved":true}

$ node -e 'stddev sliding vs dois passos'
stddev sliding (esperado 1) -> 0
stddev two-pass (referencia) -> 1

$ node -e 'sma com strings numéricas'
sma strings [100,100,100] p=2 -> [ null, 50050, 500500 ]

$ node -e 'analyzeSeries(null)'
analyzeSeries(null) -> TypeError: Cannot read properties of null (reading 'filter')

$ node -e 'benchmark n=5000 (motor nativo)'
analyzeSeries n=5000, order2: 8.24 ms
MC 1000x35 slice n=5000: 4.63 ms
analyzeSeries n=2500: 2 ms
```

**Comandos de verificação dos testes**
```bash
node --test test/rvol.test.js test/markov-order2.test.js   # 17/17 pass
```

## Anexo B — Inventário analisado

| Ficheiro | Linhas | Foco |
|---|---:|---|
| `src/quant/markovEngine.js` | 583 | matrizes 1ª/2ª ordem, forecast, estados, gates |
| `src/quant/monteCarloEngine.js` | 269 | loops MC 1ª/2ª ordem, buildStateReturnsMap |
| `src/quant/indicators.js` | 441 | SMA/EMA/StdDev/RMA/RSI/ADX/BB/VWAP/RVOL/McGinley |
| `src/quant/workstation/entrySignal.js` | 87 | orquestração sinal + MC |
| `src/quant/workstation/metrics.js` | 354 | KPIs, drawdown, VaR/CVaR, Sortino |
| `src/quant/workstation/fracdiff.js` | 161 | FFD, ADF, d* ótimo |
| `src/quant/workstation/graham.js` | 181 | solvência PIT, snapshots |
| `src/quant/workstation/sentimentProxy.js` | 54 | z-scores PV |
| `src/quant/workstation/validation.js` | 198 | CPCV, DSR, PBO |
| `src/quant/workstation/factorPurification.js` | 147 | OLS, VIF, neutralização |
| `src/native/addon.cpp` / `monte_carlo.cpp` / `index.js` | 234 / 234 / 182 | fronteira N-API e paridade JS/C++ |
| `src/engine/backtesterEngine.js` / `workstationEngine.js` | 866 / 476 | hot loops e propagação de parâmetros |
