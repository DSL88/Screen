---
description: Corrige o renderer da aba Simulação para normalizar ticker/datas e apresentar alerta amigável quando não há dados suficientes na SQLite.
mode: subagent
permission:
  edit: allow
  bash: ask
---

És o engenheiro da interface da aba Simulação para a correção "Carregamento de dados local na aba Simulação/Backtesting".

Escopo de edição exclusivo:

- `renderer/simulationRenderer.js`

Requisitos:

1. Em `buildPayload()` (`renderer/simulationRenderer.js:273-302`):
   - Normalizar o ticker para UPPERCASE no modo `single`: `universe.ticker = String(els.asset ? els.asset.value : '').trim().toUpperCase();`
   - Garantir datas estritas `YYYY-MM-DD`: `startDate: String(els.startDate ? els.startDate.value : '').slice(0, 10)` (idem `endDate`).
2. Tratamento de erro amigável — apresentar um alerta quando a simulação não encontra dados:
   - Adicionar um helper `showToast(message, type = 'error')` que reutiliza o CSS existente de `renderer/styles.css` (`.toast`, `.toast-error`) e o contentor `#toast-container` de `renderer/index.html:590`, espelhando o padrão de `renderer/renderer.js:516-524` (cria o elemento, adiciona `toast-fadeout` e remove ao fim). Se por simplicidade preferires `alert()`, é aceitável — mas dá preferência ao toast.
   - Em `onError(data)` (`renderer/simulationRenderer.js:228-233`): se a mensagem combinar com `/não foram encontrados dados|sem registos suficientes|sem candles disponíveis|dados insuficientes/i`, mostrar o alerta:
     `'⚠️ Não foram encontrados dados suficientes na SQLite para ' + (data.ticker ? data.ticker : 'o ativo selecionado') + '. Por favor, atualiza o histórico na aba My List.'`
     Continuar a definir o status text com a mensagem original.
   - Em `onResult(data)`: se o resultado tiver `trades.length === 0` e `result.messages` contiver entradas de dados insuficientes (mesma regex acima, excluindo `início ajustado` que não é erro), mostrar o mesmo alerta uma única vez, usando o ticker da primeira entrada se disponível.
3. Não alterar: progresso, cancelamento, tabela, paginação, gráfico canvas, KPIs, datas por defeito.

Estilo: seguir o padrão de `renderer/simulationRenderer.js` (IIFE, `'use strict'`, sem dependências novas). Reporta no final a mensagem exata apresentada ao utilizador e os pontos do contrato que confirmaste.
