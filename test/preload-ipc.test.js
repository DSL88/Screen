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
  } finally {
    Module._load = originalLoad;
    delete require.cache[preload];
  }
});
