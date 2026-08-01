const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const preload = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');

test('há um único handler para a operação de primeiras datas', () => {
  assert.equal((main.match(/ipcMain\.handle\(['"]UPDATE_INDEX_FIRST_DATES['"]/g) || []).length, 1);
  assert.equal((main.match(/ipcMain\.handle\(['"]fetch-first-date-index['"]/g) || []).length, 0);
  assert.equal((main.match(/ipcMain\.handle\(['"]sync-index-first-dates['"]/g) || []).length, 0);
  assert.match(preload, /ipcRenderer\.invoke\('UPDATE_INDEX_FIRST_DATES'/);
});

test('cancelamento e progresso final fazem parte do contrato IPC', () => {
  assert.match(main, /ipcMain\.handle\(['"]index:cancel['"]/);
  assert.match(preload, /cancelIndexOperation/);
  assert.match(main, /status: 'done'/);
  assert.match(main, /state: finalStatus/);
});
