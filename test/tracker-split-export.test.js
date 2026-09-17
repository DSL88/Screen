const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

function read(rel) {
  return fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf8');
}

test('HTML: Elementos do fluxo de exportação dividida presentes', () => {
  const html = read('renderer/index.html');

  // Botão de exportação dividida (Top 20 Tracker + Restantes Monitorização)
  assert.match(html, /id=["']btn-export-split-workflow["']/);
  assert.match(html, /id=["']count-remaining["']/);

  // Secção e tabela de Universo de Monitorização em #tab-portfolio
  assert.match(html, /id=["']table-monitoring-universe["']/);
  assert.match(html, /id=["']monitoring-universe-tbody["']/);
  assert.match(html, /id=["']monitoring-universe-count["']/);
  assert.match(html, /id=["']btn-refresh-monitoring-universe["']/);
});

test('Preload & Main: Exposição e registo do canal IPC export-split-analysis', () => {
  const preload = read('preload.js');
  const main = read('main.js');

  // Preload deve expor exportSplitAnalysis
  assert.match(preload, /exportSplitAnalysis:\s*\(payload\)\s*=>\s*ipcRenderer\.invoke\(['"]export-split-analysis['"],\s*payload\)/);

  // Main deve registar o handler export-split-analysis
  assert.match(main, /ipcMain\.handle\(['"]export-split-analysis['"]/);
  assert.match(main, /saveTop20ToTracker/);
  assert.match(main, /saveRemainingToMonitoring/);
});

test('Database: Criação de alphaquant_top20_tracker e investment_monitoring_universe com transações atómicas', () => {
  const DB = require('../src/db/database.js');
  const os = require('os');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-split-db-'));

  try {
    const db = new DB(tmpDir);
    db.init();

    // 1. Verificar se as tabelas foram criadas
    const top20Table = db.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='alphaquant_top20_tracker'").get();
    assert.ok(top20Table, 'Tabela alphaquant_top20_tracker deve existir');

    const monitoringTable = db.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='investment_monitoring_universe'").get();
    assert.ok(monitoringTable, 'Tabela investment_monitoring_universe deve existir');

    // 2. Testar saveTop20ToTracker
    const sampleTop20 = [
      {
        ticker: 'NVDA',
        company_name: 'NVIDIA Corp',
        country: 'US',
        sector: 'Technology',
        direction: 'COMPRA',
        current_price: 130.00,
        target_price: 136.24,
        stop_loss: 126.88,
        win_rate_mc: 72.5,
        cvar_95: 3.2,
        alpha_score: 95.0
      },
      {
        ticker: 'MSFT',
        company_name: 'Microsoft Corp',
        country: 'US',
        sector: 'Technology',
        direction: 'COMPRA',
        current_price: 420.00,
        target_price: 440.16,
        stop_loss: 409.92,
        win_rate_mc: 65.0,
        cvar_95: 2.8,
        alpha_score: 88.0
      }
    ];

    const savedTop = db.saveTop20ToTracker(sampleTop20);
    assert.equal(savedTop, 2, 'Deve ter inserido 2 registos no Top 20');

    const topRows = db.getTop20Tracker();
    assert.equal(topRows.length, 2);
    assert.equal(topRows[0].ticker, 'NVDA');

    // Teste de idempotência / ON CONFLICT no Top 20
    const updatedTop20 = [
      {
        ticker: 'NVDA',
        company_name: 'NVIDIA Corp Updated',
        direction: 'VENDA',
        current_price: 135.00,
        target_price: 128.52,
        stop_loss: 138.24,
        win_rate_mc: 70.0,
        cvar_95: 3.0,
        alpha_score: 92.0
      }
    ];
    db.saveTop20ToTracker(updatedTop20);
    const updatedRow = db.db.prepare('SELECT * FROM alphaquant_top20_tracker WHERE ticker = ?').get('NVDA');
    assert.equal(updatedRow.direction, 'VENDA');
    assert.equal(updatedRow.alpha_score, 92.0);

    // 3. Testar saveRemainingToMonitoring
    const sampleRemaining = [
      {
        ticker: 'INTC',
        company_name: 'Intel Corp',
        country: 'US',
        sector: 'Technology',
        direction: 'VENDA',
        current_price: 22.00,
        target_price: 20.94,
        stop_loss: 22.53,
        win_rate_mc: 48.0,
        cvar_95: 5.5,
        graham_score: 45.0,
        alpha_score: 52.0
      },
      {
        ticker: 'F',
        company_name: 'Ford Motor Co',
        country: 'US',
        sector: 'Consumer Cyclical',
        direction: 'COMPRA',
        current_price: 10.50,
        target_price: 11.00,
        stop_loss: 10.25,
        win_rate_mc: 52.0,
        cvar_95: 4.2,
        graham_score: 55.0,
        alpha_score: 58.0
      }
    ];

    const savedRemaining = db.saveRemainingToMonitoring(sampleRemaining);
    assert.equal(savedRemaining, 2, 'Deve ter inserido 2 registos no universo de monitorização');

    const monitoringRows = db.getMonitoringUniverse();
    assert.equal(monitoringRows.length, 2);

    db.close();
  } finally {
    if (fs.existsSync(tmpDir)) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    }
  }
});

test('Python Engine: Função split_analysis_results e separação em top_20 e remaining_analyzed', () => {
  const pyCode = read('python_engine/run_pipeline.py');
  assert.match(pyCode, /def split_analysis_results/);
  assert.match(pyCode, /"top_20":\s*top_20/);
  assert.match(pyCode, /"remaining_analyzed":\s*remaining/);
  assert.match(pyCode, /"total_analyzed":\s*len\(all_scored_sorted\)/);
});

test('Renderer: Variáveis globais currentAnalysisTop20 / currentAnalysisRemaining e botões no renderer.js e quantRenderer.js', () => {
  const rendererJs = read('renderer/renderer.js');
  const quantJs = read('renderer/quantRenderer.js');

  assert.match(rendererJs, /window\.currentAnalysisTop20/);
  assert.match(rendererJs, /window\.currentAnalysisRemaining/);
  assert.match(rendererJs, /btn-export-split-workflow/);
  assert.match(rendererJs, /exportSplitAnalysis/);
  assert.match(rendererJs, /loadMonitoringUniverseData/);

  assert.match(quantJs, /window\.currentAnalysisTop20 =/);
  assert.match(quantJs, /window\.currentAnalysisRemaining =/);
});
