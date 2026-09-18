'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const DB = require('../src/db/database');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

function createTempDb() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quant-dup-test-'));
  const db = new DB(tmpDir);
  db.init();
  return { db, tmpDir };
}

test('DB: isAssetAlreadyTracked detecta ativos pendentes com case/whitespace insensitivity', () => {
  const { db, tmpDir } = createTempDb();
  try {
    assert.deepEqual(db.isAssetAlreadyTracked('AAPL'), { exists: false });

    // Inserir ativo pendente
    db.db.prepare(`
      INSERT INTO alphaquant_top20_tracker (
        ticker, company_name, country, sector, direction,
        entry_price, target_price, stop_loss, current_price,
        recommendation_date, status
      ) VALUES (
        'AAPL', 'Apple Inc', 'US', 'Tech', 'COMPRA',
        150.0, 157.2, 146.4, 150.0,
        '2026-09-01', 'PENDENTE'
      )
    `).run();

    const checkExact = db.isAssetAlreadyTracked('AAPL');
    assert.equal(checkExact.exists, true);
    assert.equal(checkExact.data.ticker, 'AAPL');
    assert.equal(checkExact.data.status, 'PENDENTE');

    const checkTrimLower = db.isAssetAlreadyTracked('  aapl  ');
    assert.equal(checkTrimLower.exists, true);

    const checkUntracked = db.isAssetAlreadyTracked('MSFT');
    assert.equal(checkUntracked.exists, false);
  } finally {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('DB: addTrackedInvestmentSafe insere novo ativo e bloqueia duplicados', () => {
  const { db, tmpDir } = createTempDb();
  try {
    const asset = {
      ticker: 'NVDA',
      company_name: 'Nvidia Corp',
      country: 'US',
      sector: 'Semiconductors',
      direction: 'COMPRA',
      price: 120.0,
      winRateMC: 68.5,
      cvar_95: -5.2,
      alpha_score: 85.0
    };

    // 1. Primeira inserção deve suceder
    const firstRes = db.addTrackedInvestmentSafe(asset);
    assert.equal(firstRes.success, true);
    assert.equal(firstRes.alreadyExists, false);
    assert.equal(firstRes.ticker, 'NVDA');

    const row = db.db.prepare('SELECT * FROM alphaquant_top20_tracker WHERE ticker = ?').get('NVDA');
    assert.ok(row);
    assert.equal(row.status, 'PENDENTE');
    assert.equal(row.entry_price, 120.0);
    assert.equal(row.target_price, 120.0 * 1.048);
    assert.equal(row.stop_loss, 120.0 * (1 - 0.024));

    // 2. Segunda tentativa deve ser bloqueada
    const secondRes = db.addTrackedInvestmentSafe({ ticker: 'nvda  ' });
    assert.equal(secondRes.success, false);
    assert.equal(secondRes.alreadyExists, true);
    assert.match(secondRes.message, /já está adicionado ao Tracker/);
  } finally {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('DB: getDuplicateTrackedAssets deteta duplicados agrupados', () => {
  const { db, tmpDir } = createTempDb();
  try {
    // Inserir 2 registos para MSFT com datas diferentes e 1 para GOOG
    db.db.prepare(`
      INSERT INTO alphaquant_top20_tracker (ticker, direction, entry_price, target_price, stop_loss, recommendation_date)
      VALUES ('MSFT', 'COMPRA', 300, 314, 292, '2026-08-01')
    `).run();
    db.db.prepare(`
      INSERT INTO alphaquant_top20_tracker (ticker, direction, entry_price, target_price, stop_loss, recommendation_date)
      VALUES ('MSFT', 'COMPRA', 310, 324, 302, '2026-08-02')
    `).run();
    db.db.prepare(`
      INSERT INTO alphaquant_top20_tracker (ticker, direction, entry_price, target_price, stop_loss, recommendation_date)
      VALUES ('GOOG', 'COMPRA', 180, 188, 175, '2026-08-01')
    `).run();

    const dups = db.getDuplicateTrackedAssets();
    assert.equal(dups.length, 2);
    assert.ok(dups.every(d => d.ticker === 'MSFT'));
  } finally {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('DB: deleteDuplicateTrackedAssets purga duplicados mantendo o registo mais recente (MAX(id))', () => {
  const { db, tmpDir } = createTempDb();
  try {
    const id1 = db.db.prepare(`
      INSERT INTO alphaquant_top20_tracker (ticker, direction, entry_price, target_price, stop_loss, recommendation_date)
      VALUES ('TSLA', 'COMPRA', 200, 210, 195, '2026-08-01')
    `).run().lastInsertRowid;

    const id2 = db.db.prepare(`
      INSERT INTO alphaquant_top20_tracker (ticker, direction, entry_price, target_price, stop_loss, recommendation_date)
      VALUES ('TSLA', 'COMPRA', 210, 220, 205, '2026-08-02')
    `).run().lastInsertRowid;

    const id3 = db.db.prepare(`
      INSERT INTO alphaquant_top20_tracker (ticker, direction, entry_price, target_price, stop_loss, recommendation_date)
      VALUES ('TSLA', 'COMPRA', 220, 230, 214, '2026-08-03')
    `).run().lastInsertRowid;

    const idOther = db.db.prepare(`
      INSERT INTO alphaquant_top20_tracker (ticker, direction, entry_price, target_price, stop_loss, recommendation_date)
      VALUES ('AMZN', 'COMPRA', 180, 188, 175, '2026-08-01')
    `).run().lastInsertRowid;

    const purgeRes = db.deleteDuplicateTrackedAssets();
    assert.equal(purgeRes.success, true);
    assert.equal(purgeRes.deletedCount, 2); // id1 e id2 foram apagados

    const remainingTsla = db.db.prepare('SELECT id, ticker FROM alphaquant_top20_tracker WHERE ticker = ?').all('TSLA');
    assert.equal(remainingTsla.length, 1);
    assert.equal(remainingTsla[0].id, id3); // manteve o MAX(id)

    const remainingAmzn = db.db.prepare('SELECT id, ticker FROM alphaquant_top20_tracker WHERE ticker = ?').all('AMZN');
    assert.equal(remainingAmzn.length, 1);
    assert.equal(remainingAmzn[0].id, idOther);
  } finally {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('DB: deleteTrackedAssetsByIds elimina registos selecionados por IDs', () => {
  const { db, tmpDir } = createTempDb();
  try {
    const id1 = db.db.prepare(`
      INSERT INTO alphaquant_top20_tracker (ticker, direction, entry_price, target_price, stop_loss, recommendation_date)
      VALUES ('META', 'COMPRA', 500, 524, 488, '2026-08-01')
    `).run().lastInsertRowid;
    const id2 = db.db.prepare(`
      INSERT INTO alphaquant_top20_tracker (ticker, direction, entry_price, target_price, stop_loss, recommendation_date)
      VALUES ('META', 'COMPRA', 510, 534, 498, '2026-08-02')
    `).run().lastInsertRowid;

    const delRes = db.deleteTrackedAssetsByIds([id1]);
    assert.equal(delRes.success, true);
    assert.equal(delRes.deletedCount, 1);

    const remaining = db.db.prepare('SELECT id FROM alphaquant_top20_tracker WHERE ticker = ?').all('META');
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].id, id2);
  } finally {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('DB: clearAllTrackerData elimina todo o histórico da tabela do Tracker', () => {
  const { db, tmpDir } = createTempDb();
  try {
    db.db.prepare(`
      INSERT INTO alphaquant_top20_tracker (ticker, direction, entry_price, target_price, stop_loss, recommendation_date)
      VALUES ('META', 'COMPRA', 500, 524, 488, '2026-08-01')
    `).run();
    db.db.prepare(`
      INSERT INTO alphaquant_top20_tracker (ticker, direction, entry_price, target_price, stop_loss, recommendation_date)
      VALUES ('AAPL', 'COMPRA', 150, 157, 146, '2026-08-01')
    `).run();

    const clearRes = db.clearAllTrackerData();
    assert.equal(clearRes.success, true);
    assert.equal(clearRes.deletedCount, 2);

    const total = db.db.prepare('SELECT COUNT(*) as count FROM alphaquant_top20_tracker').get();
    assert.equal(total.count, 0);
  } finally {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('HTML: Controles de gestão de duplicados e checkboxes presentes no Tracker (Aba 6)', () => {
  const html = read('renderer/index.html');
  assert.match(html, /id=["']chk-filter-duplicates["']/);
  assert.match(html, /id=["']btn-delete-duplicates["']/);
  assert.match(html, /id=["']btn-delete-selected["']/);
  assert.match(html, /id=["']btn-clear-all-tracker["']/);
  assert.match(html, /id=["']count-duplicates-badge["']/);
  assert.match(html, /id=["']count-selected-badge["']/);
  assert.match(html, /id=["']btn-count-selected["']/);
  assert.match(html, /id=["']chk-select-all-tracker["']/);
});

test('Preload & Main: Registro e exposição das rotas IPC para verificação e purga de duplicados', () => {
  const preload = read('preload.js');
  assert.match(preload, /checkAssetTracked:\s*\(ticker\)\s*=>\s*ipcRenderer\.invoke\(['"]check-asset-tracked['"],\s*ticker\)/);
  assert.match(preload, /addTrackedInvestmentSafe:\s*\(asset\)\s*=>\s*ipcRenderer\.invoke\(['"]add-tracked-investment-safe['"],\s*asset\)/);
  assert.match(preload, /getDuplicateTrackedAssets:\s*\(\)\s*=>\s*ipcRenderer\.invoke\(['"]get-duplicate-tracked-assets['"]\)/);
  assert.match(preload, /deleteDuplicateTrackedAssets:\s*\(\)\s*=>\s*ipcRenderer\.invoke\(['"]delete-duplicate-tracked-assets['"]\)/);
  assert.match(preload, /deleteTrackedAssetsByIds:\s*\(ids\)\s*=>\s*ipcRenderer\.invoke\(['"]delete-tracked-assets-by-ids['"],\s*ids\)/);
  assert.match(preload, /clearAllTrackerData:\s*\(\)\s*=>\s*ipcRenderer\.invoke\(['"]clear-all-tracker-data['"]\)/);

  const main = read('main.js');
  assert.match(main, /ipcMain\.handle\(['"]check-asset-tracked['"]/);
  assert.match(main, /ipcMain\.handle\(['"]add-tracked-investment-safe['"]/);
  assert.match(main, /ipcMain\.handle\(['"]get-duplicate-tracked-assets['"]/);
  assert.match(main, /ipcMain\.handle\(['"]delete-duplicate-tracked-assets['"]/);
  assert.match(main, /ipcMain\.handle\(['"]delete-tracked-assets-by-ids['"]/);
  assert.match(main, /ipcMain\.handle\(['"]clear-all-tracker-data['"]/);
});

test('Renderer: quantTrackerRenderer.js e renderer.js implementam a lógica de duplicados e setupInvestButton', () => {
  const quantRenderer = read('renderer/quantTrackerRenderer.js');
  assert.match(quantRenderer, /chk-filter-duplicates/);
  assert.match(quantRenderer, /btn-delete-duplicates/);
  assert.match(quantRenderer, /btn-delete-selected/);
  assert.match(quantRenderer, /btn-clear-all-tracker/);
  assert.match(quantRenderer, /count-duplicates-badge/);
  assert.match(quantRenderer, /count-selected-badge/);
  assert.match(quantRenderer, /row-duplicate/);
  assert.match(quantRenderer, /chk-tracker-row/);
  assert.match(quantRenderer, /updateDuplicateCountBadge/);
  assert.match(quantRenderer, /deleteTrackedAssetsByIds/);
  assert.match(quantRenderer, /clearAllTrackerData/);

  const mainRenderer = read('renderer/renderer.js');
  assert.match(mainRenderer, /setupInvestButton/);
  assert.match(mainRenderer, /checkAssetTracked/);
  assert.match(mainRenderer, /addTrackedInvestmentSafe/);
  assert.match(mainRenderer, /Já em Acompanhamento/);
  assert.match(mainRenderer, /alreadyTrackedTickers/);
  assert.match(mainRenderer, /btn-save-top20-tracker/);
});
