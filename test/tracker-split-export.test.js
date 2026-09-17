const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const Database = require('better-sqlite3');

function read(rel) {
  return fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf8');
}

// Isola o sync do tracker canónico: os testes nunca escrevem no quant_tracker.db real.
const NOSYNC_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'test-split-nosync-'));
const ORIGINAL_QUANT_TRACKER_DB_PATH = process.env.QUANT_TRACKER_DB_PATH;
process.env.QUANT_TRACKER_DB_PATH = path.join(NOSYNC_DIR, 'quant_tracker.db');

test.after(() => {
  if (ORIGINAL_QUANT_TRACKER_DB_PATH === undefined) {
    delete process.env.QUANT_TRACKER_DB_PATH;
  } else {
    process.env.QUANT_TRACKER_DB_PATH = ORIGINAL_QUANT_TRACKER_DB_PATH;
  }
  fs.rmSync(NOSYNC_DIR, { recursive: true, force: true });
});

test('HTML: Elementos do fluxo de exportação dividida presentes', () => {
  const html = read('renderer/index.html');

  // Botões desacoplados do novo fluxo (Top 20 Tracker + Restantes Qualificados)
  assert.match(html, /id=["']btn-save-top20-tracker["']/);
  assert.match(html, /id=["']btn-save-qualified-monitoring["']/);
  assert.match(html, /id=["']count-qualified-monitoring["']/);

  // IDs antigos do fluxo dividido foram removidos
  assert.doesNotMatch(html, /id=["']btn-export-split-workflow["']/);
  assert.doesNotMatch(html, /id=["']count-remaining["']/);
  assert.doesNotMatch(html, /id=["']btn-save-all-monitoring["']/);
  assert.doesNotMatch(html, /id=["']count-all-monitoring["']/);

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

    // 3. Testar saveQualifiedToMonitoring (canónica) e alias saveRemainingToMonitoring
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

    const savedRemaining = db.saveQualifiedToMonitoring(sampleRemaining);
    assert.equal(savedRemaining, 2, 'Deve ter inserido 2 registos no universo de monitorização');

    const monitoringRows = db.getMonitoringUniverse();
    assert.equal(monitoringRows.length, 2);
    assert.deepEqual(monitoringRows.map((r) => r.ticker).sort(), ['F', 'INTC']);

    // O alias legado saveRemainingToMonitoring continua a delegar na canónica.
    // NOVA SEMÂNTICA (F2): a canónica purga, dentro da transação, as linhas do
    // mesmo dia cujo ticker não consta da lista recebida. O resultado final do
    // dia corresponde exatamente à última lista gravada (AMD) e não a uma
    // contagem cumulativa das chamadas.
    const savedAlias = db.saveRemainingToMonitoring([
      {
        ticker: 'AMD',
        company_name: 'Advanced Micro Devices',
        country: 'US',
        sector: 'Technology',
        direction: 'COMPRA',
        current_price: 160.0,
        target_price: 167.68,
        stop_loss: 156.16,
        win_rate_mc: 57.0,
        cvar_95: 4.4,
        graham_score: 61.0,
        alpha_score: 63.5
      }
    ]);
    assert.equal(savedAlias, 1, 'Alias saveRemainingToMonitoring deve delegar na canónica');
    const afterAlias = db.getMonitoringUniverse();
    assert.equal(afterAlias.length, 1, 'Purge do mesmo dia substitui o snapshot anterior');
    assert.equal(afterAlias[0].ticker, 'AMD');

    // Regravar a lista canónica no mesmo dia volta a substituir o snapshot.
    assert.equal(db.saveQualifiedToMonitoring(sampleRemaining), 2);
    assert.deepEqual(
      db.getMonitoringUniverse().map((r) => r.ticker).sort(),
      ['F', 'INTC'],
      'O dia fica exatamente com a última lista gravada'
    );

    db.close();
  } finally {
    if (fs.existsSync(tmpDir)) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    }
  }
});

test('Python Engine: consolidação qualificada e wrapper split_analysis_results', () => {
  const pyCode = read('python_engine/run_pipeline.py');

  // Motor canónico de triagem
  assert.match(pyCode, /def consolidate_and_split_pipeline/);
  assert.match(pyCode, /if current_price <= 0:/);
  assert.match(pyCode, /if win_rate < 50\.0:/);
  assert.match(pyCode, /"top_20":\s*top_20/);
  assert.match(pyCode, /"monitoring_pool":\s*monitoring_pool/);
  assert.match(pyCode, /"total_qualified_count":\s*len\(qualified_sorted\)/);
  assert.match(pyCode, /"monitoring_count":\s*len\(monitoring_pool\)/);

  // Wrapper de compatibilidade com as chaves antigas
  assert.match(pyCode, /def split_analysis_results/);
  assert.match(pyCode, /"remaining_analyzed":\s*res\["monitoring_pool"\]/);
  assert.match(pyCode, /"total_analyzed":\s*res\["total_qualified_count"\]/);

  // Payload de execute_alpha_quant_engine consome as novas chaves
  assert.match(pyCode, /"monitoring_pool":\s*qualified_res\["monitoring_pool"\]/);
  assert.match(pyCode, /"monitoring_count":\s*qualified_res\["monitoring_count"\]/);
  assert.match(pyCode, /"total_qualified_count":\s*qualified_res\["total_qualified_count"\]/);
  assert.match(pyCode, /"remaining_analyzed":\s*qualified_res\["monitoring_pool"\]/);
  assert.match(pyCode, /"total_analyzed":\s*qualified_res\["total_qualified_count"\]/);
  assert.match(pyCode, /"top_recommendations":\s*qualified_res\["top_20"\]/);
});

test('Renderer: Variáveis globais currentAnalysisTop20 / currentAnalysisRemaining / currentMonitoringPool', () => {
  const rendererJs = read('renderer/renderer.js');
  const quantJs = read('renderer/quantRenderer.js');

  assert.match(rendererJs, /window\.currentAnalysisTop20/);
  assert.match(rendererJs, /window\.currentAnalysisRemaining/);
  assert.match(rendererJs, /window\.currentMonitoringPool/);
  assert.match(rendererJs, /btn-save-top20-tracker/);
  assert.match(rendererJs, /btn-save-qualified-monitoring/);
  assert.match(rendererJs, /loadMonitoringUniverseData/);

  assert.match(quantJs, /window\.currentAnalysisTop20 =/);
  assert.match(quantJs, /window\.currentAnalysisRemaining =/);
  assert.match(quantJs, /window\.currentMonitoringPool = data\.monitoring_pool/);
});
