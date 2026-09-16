'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const DB = require('../src/db/database');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

test('HTML: Elementos de Checkbox Master e Botão de Exportação em Lote presentes', () => {
  const html = read('renderer/index.html');

  // Botão de exportação em lote com contador
  assert.match(html, /id=["']btn-export-tracker-batch["']/);
  assert.match(html, /id=["']tracker-selected-count["']/);

  // Checkbox Master no thead
  assert.match(html, /id=["']checkbox-master-recommendations["']/);
  assert.match(html, /<th[^>]*>\s*<input type="checkbox" id="checkbox-master-recommendations"/);
});

test('Preload & Main: Exposição e registro do canal IPC export-recommendations-tracker-batch', () => {
  const preload = read('preload.js');
  assert.match(preload, /exportRecommendationsToTrackerBatch:\s*\(assets\)\s*=>\s*ipcRenderer\.invoke\(['"]export-recommendations-tracker-batch['"],\s*assets\)/);

  const main = read('main.js');
  assert.match(main, /ipcMain\.handle\(['"]export-recommendations-tracker-batch['"]/);
  assert.match(main, /db\.saveRecommendationsBatchToTracker\(assets\)/);
});

test('Database: Criação da tabela alphaquant_history_tracker e inserção atómica em lote com ON CONFLICT', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-tracker-db-'));
  try {
    const db = new DB(tmpDir);
    db.init();

    // Validar existência da tabela canónica
    const tableCheck = db.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='alphaquant_history_tracker'").get();
    assert.ok(tableCheck, 'Tabela alphaquant_history_tracker deve existir');

    const sampleAssets = [
      {
        ticker: 'AAPL',
        name: 'Apple Inc.',
        country: 'US',
        sector: 'Technology',
        direction: 'COMPRA',
        current_price: 230.50,
        target_price: 241.56,
        stop_loss: 224.97,
        win_rate_mc: 72.5,
        cvar_95: 3.2,
        graham_score: 78.0,
        alpha_score: 84.5
      },
      {
        ticker: 'MSFT',
        name: 'Microsoft Corp.',
        country: 'US',
        sector: 'Technology',
        direction: 'COMPRA',
        current_price: 450.00,
        target_price: 471.60,
        stop_loss: 439.20,
        win_rate_mc: 68.0,
        cvar_95: 2.8,
        graham_score: 82.0,
        alpha_score: 88.0
      }
    ];

    // Inserção em lote inicial
    const inserted = db.saveRecommendationsBatchToTracker(sampleAssets);
    assert.equal(inserted, 2, 'Deve ter inserido 2 registos');

    const rows = db.db.prepare('SELECT * FROM alphaquant_history_tracker ORDER BY ticker ASC').all();
    assert.equal(rows.length, 2);
    assert.equal(rows[0].ticker, 'AAPL');
    assert.equal(rows[0].company_name, 'Apple Inc.');
    assert.equal(rows[0].entry_price, 230.50);
    assert.equal(rows[0].status, 'PENDING');
    assert.equal(rows[1].ticker, 'MSFT');
    assert.equal(rows[1].alpha_score, 88.0);

    // Testar idempotência / ON CONFLICT (atualização sem duplicar)
    const updatedAssets = [
      {
        ticker: 'AAPL',
        name: 'Apple Inc. Updated',
        country: 'US',
        sector: 'Technology',
        direction: 'COMPRA',
        current_price: 235.00,
        target_price: 246.00,
        stop_loss: 229.00,
        win_rate_mc: 75.0,
        cvar_95: 3.1,
        graham_score: 80.0,
        alpha_score: 90.0
      }
    ];

    const updatedCount = db.saveRecommendationsBatchToTracker(updatedAssets);
    assert.equal(updatedCount, 1);

    const rowsAfterUpdate = db.db.prepare('SELECT * FROM alphaquant_history_tracker WHERE ticker = ?').all('AAPL');
    assert.equal(rowsAfterUpdate.length, 1, 'Não deve criar linha duplicada para o mesmo ticker e dia');
    assert.equal(rowsAfterUpdate[0].entry_price, 235.00, 'Preço de entrada deve ser atualizado pelo ON CONFLICT');
    assert.equal(rowsAfterUpdate[0].alpha_score, 90.0, 'Alpha score deve ser atualizado pelo ON CONFLICT');

    db.close();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Renderer: Lógica de seleção individual, master checkbox e handlers associados', () => {
  const rendererJs = read('renderer/renderer.js');
  const quantJs = read('renderer/quantRenderer.js');

  // Verificação de exportação e definição no renderer.js
  assert.match(rendererJs, /function setupMasterCheckboxHandlers/);
  assert.match(rendererJs, /window\.setupMasterCheckboxHandlers = setupMasterCheckboxHandlers/);
  assert.match(rendererJs, /window\.currentTopRecommendations =/);
  assert.match(rendererJs, /class="check-recommendation-item"/);
  assert.match(rendererJs, /data-ticker=/);
  assert.match(rendererJs, /updateExportButtonState/);

  // Verificação no quantRenderer.js
  assert.match(quantJs, /window\.currentTopRecommendations =/);
  assert.match(quantJs, /class="check-recommendation-item"/);
  assert.match(quantJs, /updateExportButtonState/);
});
