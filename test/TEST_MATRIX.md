# Matriz determinística de testes

Os testes são executados sem rede real (`node --test test/*.test.js`). Os clientes
Axios/Yahoo e o relógio de backoff são substituídos por mocks locais.

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

## Lacunas conhecidas

- O scanner atual não publica um estado explícito `success`/`partial`/`failed`; o
  contador de falhas do worker também não representa falhas por ticker. Existe um
  `todo` em `scanner.test.js` para a melhoria da auditoria.
- Ainda não há teste de browser real com Electron/DOM completo; os testes de UI
  verificam o contrato do renderer e os testes IPC exercitam o preload.
- A validação semântica de datas string no parser Stooq permanece um `todo`, pois
  a implementação atual aceita uma string não vazia como data.
- Não se testa a rede, rate limiting externo ou comportamento visual pixel a pixel.
