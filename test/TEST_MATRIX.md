# Matriz determinística de testes

Os testes são executados sem rede real (`ELECTRON_RUN_AS_NODE=1 electron --test test/*.test.js`
via `npm test`). Os clientes Axios/Yahoo e o relógio de backoff são substituídos por mocks
locais.

| Área | Cobertura | Ficheiro |
| --- | --- | --- |
| SQLite | migração de schema legado, colunas, metadata, UPSERT, idempotência, bulk e pipeline | `database.test.js`, `pipeline.sqlite.test.js` |
| Importação | CSV, headers, datas, linhas inválidas, transação e deduplicação | `importer.test.js` |
| Wikipedia | tabelas, notas, símbolos, sufixos, deduplicação e fallback | `wikipedia.test.js` |
| Yahoo/Stooq | sucesso, vazio, 404, 429, timeout, datas inválidas, fallback e `fetchHistorySince` (bloco desde a data inicial) | `market-data.test.js`, `yahoo-client.test.js` |
| Scanner | persistência mista, falha parcial, limite de concorrência e cancelamento | `scanner.test.js` |
| IPC/worker | progresso, done, cancelamento, estados finais do contrato e unsubscribe do preload | `ipc-worker.test.js`, `pipeline.ipc.test.js`, `preload-ipc.test.js` |
| UI | re-render da My List, país repetido, proteção de reentrada e listeners | `ui-contract.test.js` |
| Estado do índice | `checkIndexStatus`: COMPLETO, pendente-1º-registo, pendente-recente, ALL e mistos | `index-status.test.js` |
| Sync My List | `getLastStoredDate`, incremental up-to-date, batch UPSERT e fluxo 1º Registo idempotente | `most-recent.test.js` |
| Metadados do ativo | `updateStockMetadata`: parcial/total, COALESCE, normalização do índice, ticker exato, inválidos e IPC/preload/UI | `stock-metadata.test.js`, `pipeline.ipc.test.js`, `preload-ipc.test.js`, `ui-contract.test.js` |
| Índices distintos | `getAllDistinctIndices`: vazio, ordenação ASC, sem duplicados, normalização canónica, filtro whitespace, custom via metadata e IPC/preload | `distinct-indices.test.js`, `pipeline.ipc.test.js`, `preload-ipc.test.js` |
| Modal do ativo (view/edit) | IDs novos/removidos, listener único por botão/select, view-mode ao abrir, cancelamento sem sucesso falso | `ui-contract.test.js` |
| Toolbar da Tabela Mestra | novos IDs (`btn-save-top20-tracker`, `btn-save-qualified-monitoring`, `count-qualified-monitoring`), ausência dos IDs legados, canais `save-top20-tracker`/`save-qualified-monitoring`, isolamento e UPSERT em `investment_monitoring_universe`, aliases `saveAllToMonitoring`/`saveRemainingToMonitoring`, fallbacks de campos, Top 20 e reposição do contador | `toolbar-persistence-routes.test.js`, `tracker-batch-export.test.js`, `tracker-split-export.test.js` |
| Triagem qualificada (destinos) | `consolidate_and_split_pipeline` (filtro `current_price > 0` e `win_rate >= 50.0`, target ±4.8%/stop ∓2.4%, `alpha_score`), chaves `top_20`/`monitoring_pool`/`total_qualified_count`/`monitoring_count`, wrapper `split_analysis_results`, runtime Python determinístico (25 qualificados + 5 rejeitados), isolamento/UPSERT/vazios/aliases no DB, rotas IPC/preload novas e ausência das antigas, IDs e global `window.currentMonitoringPool` na UI, cenário misto com rejeitados descartados | `qualified-triage-routes.test.js`, `tracker-split-export.test.js`, `toolbar-persistence-routes.test.js` |
| Regressão F3 (Quant Renderer) | `renderFullWorkstationReport` sem a variável indefinida `recs`; fallback `top_20 -> data.top_recommendations -> []` e `recList -> assets`; extração da função e execução pura com `top_20: []`, `top_recommendations` e payload mínimo, sem `ReferenceError` | `audit-fixes-regression.test.js` |
| Regressão F2 (purge da monitorização) | `saveQualifiedToMonitoring` e aliases purgam dentro da transação as linhas do próprio dia fora da lista recebida; lista efetiva vazia (vazia/null/sem ticker) devolve 0 sem apagar; dias anteriores intactos; UPSERT preserva `id`/`created_at`/`status`; erro no UPSERT faz rollback da purga; cenário misto válidos+inválidos; guarda `QUANT_TRACKER_DB_PATH` | `audit-fixes-regression.test.js`, `tracker-split-export.test.js`, `toolbar-persistence-routes.test.js` |
| Regressão F4 (triagem finita) | `_finite_float` aplicado em `consolidate_and_split_pipeline`: `NaN`/`inf`/`"62.5%"` em `current_price`/`mc_win_rate` ficam de fora; `cvar_95` não finito usa default 5.0 com alpha finito; lote só inválido devolve `top_20=[]`/`monitoring_pool=[]`/total 0; `json.dumps(result, allow_nan=False)` sem erro | `audit-fixes-regression.test.js` |
| Regressão 2d (payload finito, corrigido) | `build_pipeline_output` protegido por `_finite_float`: `current_price` não finito/`"62.5%"` -> default 0 -> excluído sem lançar; `mc_win_rate` não finito -> 50.0; `cvar_95` -> 5.0; `expected_return` -> 0.0; `quality_score` -> 50.0; payload sem NaN/inf e `json.dumps(..., allow_nan=False)` sem erro; ativo válido inalterado (win 62.5, alpha 64.8, target 104.8, stop 97.6); `sanitize_non_finite` recursivo (dict/list/aninhado -> None, finitos intactos) aplicado aos `json.dumps` de `run_pipeline.py` e `scripts/run_quant_pipeline.py` | `audit-fixes-regression.test.js` |

## Lacunas conhecidas

- O scanner atual não publica um estado explícito `success`/`partial`/`failed`; o
  contador de falhas do worker também não representa falhas por ticker. Existe um
  `todo` em `scanner.test.js` para a melhoria da auditoria.
- Ainda não há teste de browser real com Electron/DOM completo; os testes de UI
  verificam o contrato do renderer e os testes IPC exercitam o preload.
- A validação semântica de datas string no parser Stooq permanece um `todo`, pois
  a implementação atual aceita uma string não vazia como data.
- O runtime Python da triagem é executado com `.venv/bin/python` apenas quando o
  binário existe e as dependências importam; caso contrário o teste é `skip` e a
  cobertura fica garantida pelas asserções estáticas.
- Não se testa a rede, rate limiting externo ou comportamento visual pixel a pixel.
- **Campos de `build_pipeline_output` fora do âmbito da correção 2d (em aberto,
  sem correção neste âmbito):** `alpha_score`/`purified_alpha_score` continuam a
  usar `float()` cru — NaN/inf chegam ao payload (só são convertidos em `None`
  pelo `sanitize_non_finite` no `json.dumps` do `__main__`) e `"64.8%"` lança
  `ValueError`; `name`/`company_name` não-string lança `AttributeError` no
  `.strip()`.
