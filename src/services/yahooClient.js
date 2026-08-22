// Proxy exigido pelo Prompt Passo 1: src/services/yahooClient.js
// Re-exporta o cliente canonical em src/data/yahooClient.js para compatibilidade
// de imports (main.js usa src/data, spec usa src/services).
module.exports = require('../data/yahooClient');
