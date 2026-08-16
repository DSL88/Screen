const assert = require('node:assert/strict');
const Module = require('node:module');
const test = require('node:test');

test('preload expõe IPC permitido, remove listeners e bloqueia canais arbitrários', () => {
  const preload = require.resolve('../preload');
  delete require.cache[preload];
  let api;
  const listeners = new Map();
  const ipcRenderer = {
    invoked: [],
    invoke(channel, payload) { this.invoked.push({ channel, payload }); return Promise.resolve({ ok: true }); },
    on(channel, handler) { listeners.set(channel, handler); },
    removeListener(channel, handler) { if (listeners.get(channel) === handler) listeners.delete(channel); }
  };
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') return { contextBridge: { exposeInMainWorld(_name, value) { api = value; } }, ipcRenderer };
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    originalLoad(preload, module, false);
    assert.ok(api);
    const callback = () => {};
    const unsubscribe = api.on('scan:progress', callback);
    assert.equal(listeners.size, 1);
    unsubscribe();
    assert.equal(listeners.size, 0);
    assert.throws(() => api.on('secret:channel', callback), /not allowed/);
    api.startScan([{ ticker: 'AAA' }], { edge_threshold: 0.2 });
    assert.equal(ipcRenderer.invoked[0].channel, 'scan:start');
    assert.deepEqual(ipcRenderer.invoked[0].payload.tickers, [{ ticker: 'AAA' }]);
    api.deleteIndexWithStocks('PSI');
    assert.equal(ipcRenderer.invoked[1].channel, 'delete-index-with-stocks');
    assert.equal(ipcRenderer.invoked[1].payload, 'PSI');
    api.firstRegisto('PSI', 'op-1');
    assert.equal(ipcRenderer.invoked[2].channel, 'first-registo-index');
    assert.equal(ipcRenderer.invoked[2].payload.index, 'PSI');
    assert.equal(ipcRenderer.invoked[2].payload.operationId, 'op-1');
    api.checkIndexStatus('PSI');
    assert.equal(ipcRenderer.invoked[3].channel, 'check-index-status');
    assert.equal(ipcRenderer.invoked[3].payload, 'PSI');
    const firstRegistoUnsub = api.onFirstRegistoProgress(callback);
    assert.equal(listeners.size, 1);
    firstRegistoUnsub();
    assert.equal(listeners.size, 0);
  } finally {
    Module._load = originalLoad;
    delete require.cache[preload];
  }
});

test('preload expõe auditIndex, syncIndexFirstRecords e onIndexSyncProgress', () => {
  const preload = require.resolve('../preload');
  delete require.cache[preload];
  let api;
  const listeners = new Map();
  const ipcRenderer = {
    invoked: [],
    invoke(channel, payload) { this.invoked.push({ channel, payload }); return Promise.resolve({ ok: true }); },
    on(channel, handler) { listeners.set(channel, handler); },
    removeListener(channel, handler) { if (listeners.get(channel) === handler) listeners.delete(channel); }
  };
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') return { contextBridge: { exposeInMainWorld(_name, value) { api = value; } }, ipcRenderer };
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    originalLoad(preload, module, false);
    assert.ok(api);

    // auditIndex → handler 'audit-index'
    api.auditIndex('PSI');
    assert.equal(ipcRenderer.invoked[0].channel, 'audit-index');
    assert.equal(ipcRenderer.invoked[0].payload, 'PSI');

    // syncIndexFirstRecords → handler 'sync-index-first-records' com { index, operationId }
    api.syncIndexFirstRecords('PSI', 'op-sync-1');
    assert.equal(ipcRenderer.invoked[1].channel, 'sync-index-first-records');
    assert.deepEqual(ipcRenderer.invoked[1].payload, { index: 'PSI', operationId: 'op-sync-1' });

    // onIndexSyncProgress subscreve/remove o canal 'index-sync-progress'
    const callback = () => {};
    const unsub = api.onIndexSyncProgress(callback);
    assert.equal(listeners.has('index-sync-progress'), true);
    unsub();
    assert.equal(listeners.has('index-sync-progress'), false);

    // O canal também é aceite pelo gate genérico on() (está em ALLOWED_EVENTS)
    const unsubOn = api.on('index-sync-progress', callback);
    assert.equal(listeners.has('index-sync-progress'), true);
    unsubOn();
    assert.equal(listeners.has('index-sync-progress'), false);
  } finally {
    Module._load = originalLoad;
    delete require.cache[preload];
  }
});

test('preload expõe getDistinctIndices que invoca o canal get-distinct-indices', () => {
  const preload = require.resolve('../preload');
  delete require.cache[preload];
  let api;
  const ipcRenderer = {
    invoked: [],
    invoke(channel, payload) { this.invoked.push({ channel, payload }); return Promise.resolve({ ok: true }); },
    on() {},
    removeListener() {}
  };
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') return { contextBridge: { exposeInMainWorld(_name, value) { api = value; } }, ipcRenderer };
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    originalLoad(preload, module, false);
    assert.ok(api);
    assert.equal(typeof api.getDistinctIndices, 'function');

    api.getDistinctIndices();
    assert.equal(ipcRenderer.invoked[0].channel, 'get-distinct-indices');
    // Sem argumentos: o main devolve { ok: true, indices } sem payload.
    assert.equal(ipcRenderer.invoked[0].payload, undefined);
  } finally {
    Module._load = originalLoad;
    delete require.cache[preload];
  }
});

test('preload expõe updateStockMetadata que invoca o canal com { ticker, data }', () => {
  const preload = require.resolve('../preload');
  delete require.cache[preload];
  let api;
  const ipcRenderer = {
    invoked: [],
    invoke(channel, payload) { this.invoked.push({ channel, payload }); return Promise.resolve({ ok: true }); },
    on() {},
    removeListener() {}
  };
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') return { contextBridge: { exposeInMainWorld(_name, value) { api = value; } }, ipcRenderer };
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    originalLoad(preload, module, false);
    assert.ok(api);
    assert.equal(typeof api.updateStockMetadata, 'function');

    api.updateStockMetadata('aaa.ls', { name: 'Nome novo', country: 'Portugal' });
    assert.equal(ipcRenderer.invoked[0].channel, 'update-stock-metadata');
    assert.deepEqual(ipcRenderer.invoked[0].payload, { ticker: 'aaa.ls', data: { name: 'Nome novo', country: 'Portugal' } });

    // Campos omitidos não são forçados: o payload transporta apenas o que o
    // chamador passou (o main faz a normalização/validação).
    api.updateStockMetadata('BBB', {});
    assert.deepEqual(ipcRenderer.invoked[1].payload, { ticker: 'BBB', data: {} });
  } finally {
    Module._load = originalLoad;
    delete require.cache[preload];
  }
});

