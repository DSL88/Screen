const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const Database = require('../src/db/database');

function createTempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'markov-mon-save-'));
  const db = new Database(dir);
  db.init();
  return { db, dir };
}

function removeTempDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (_) {}
}

function read(rel) {
  return fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf8');
}

test('Database: saveQualifiedToMonitoring persiste ativos qualificados em investment_monitoring_universe sem tocar no Tracker', () => {
  const { db, dir } = createTempDb();
  try {
    const qualifiedAssets = [
      {
        ticker: 'AAPL',
        company_name: 'Apple Inc.',
        country: 'EUA',
        sector: 'Tecnologia',
        direction: 'COMPRA',
        current_price: 150.0,
        target_price: 157.2,
        stop_loss: 146.4,
        win_rate_mc: 68.5,
        cvar_95: 3.2,
        graham_score: 82.0,
        alpha_score: 75.4
      },
      {
        ticker: 'MSFT',
        company_name: 'Microsoft Corp.',
        country: 'EUA',
        sector: 'Tecnologia',
        direction: 'COMPRA',
        price: 310.0,
        mc_win_rate: 55.0, // testando variante de nome mc_win_rate
        alpha_score: 62.0
      },
      {
        ticker: 'NVDA',
        name: 'NVIDIA Corp.',
        country: 'EUA',
        sector: 'Semicondutores',
        latest_price: 120.0,
        winRateMC: 74.0, // testando variante de nome winRateMC
        alpha_score: 88.0
      }
    ];

    const savedCount = db.saveQualifiedToMonitoring(qualifiedAssets);
    assert.equal(savedCount, 3);

    // Verificar tabela investment_monitoring_universe
    const monRows = db.getMonitoringOnlyData();
    assert.equal(monRows.length, 3);
    const tickers = monRows.map((r) => r.ticker).sort();
    assert.deepEqual(tickers, ['AAPL', 'MSFT', 'NVDA']);

    const msft = monRows.find((r) => r.ticker === 'MSFT');
    assert.equal(msft.entry_price, 310.0);
    assert.equal(msft.win_rate_mc, 55.0);

    const nvda = monRows.find((r) => r.ticker === 'NVDA');
    assert.equal(nvda.entry_price, 120.0);
    assert.equal(nvda.win_rate_mc, 74.0);

    // Verificar isolamento absoluto: Tracker deve continuar vazio
    const trackerRows = db.getTrackerOnlyData();
    assert.equal(trackerRows.length, 0, 'Tracker não deve ser afetado ao guardar na monitorização');
  } finally {
    db.close();
    removeTempDir(dir);
  }
});

test('Renderer.js: getQualifiedMonitoringList filtra por limites mínimos (Win Rate >= 50% e Preço > 0)', () => {
  const rendererJs = read('renderer/renderer.js');

  // Verifica função de qualificação
  assert.match(rendererJs, /function\s+isAssetQualified\s*\(/);
  assert.match(rendererJs, /extractAssetWinRate/);
  assert.match(rendererJs, /extractAssetPrice/);
  assert.match(rendererJs, /wr\s*>=\s*50\.0\s*&&\s*price\s*>\s*0/);

  // Verifica getQualifiedMonitoringList
  assert.match(rendererJs, /function\s+getQualifiedMonitoringList\s*\(\)/);
  assert.match(rendererJs, /window\.currentMonitoringPool/);
  assert.match(rendererJs, /window\.currentAnalysisRemaining/);
  assert.match(rendererJs, /window\.currentAllAnalyzedAssets/);
});

test('Renderer.js: Aba 3 (portfolio / Monitorização de Investimentos) atualiza ambas as tabelas e estado', () => {
  const rendererJs = read('renderer/renderer.js');

  // Callback de navegação carrega tabelas de monitorização e posições
  assert.match(rendererJs, /normTarget === ['"]portfolio['"]/);
  assert.match(rendererJs, /renderMonitoringView\(\)/);
  assert.match(rendererJs, /loadPortfolio\(\)/);

  // loadPortfolio tem fallback para getMonitoringTable quando lastActiveTrades está vazio
  assert.match(rendererJs, /api\.getMonitoringTable\(\)/);
  assert.match(rendererJs, /is_monitoring:\s*true/);

  // Linhas de monitorização no portfolio têm indicador visual não-destrutivo
  assert.match(rendererJs, /trade\s*&&\s*trade\.is_monitoring/);
});

test('Renderer.js: renderMonitoringDashboard tem colunas alinhadas com cabeçalhos de index.html', () => {
  const indexHtml = read('renderer/index.html');
  const rendererJs = read('renderer/renderer.js');

  // Cabeçalhos em index.html
  assert.match(indexHtml, /<th[^>]*>DATA<\/th>/);
  assert.match(indexHtml, /<th[^>]*>TICKER<\/th>/);
  assert.match(indexHtml, /<th[^>]*>EMPRESA<\/th>/);
  assert.match(indexHtml, /<th[^>]*>SETOR<\/th>/);
  assert.match(indexHtml, /<th[^>]*>ENTRADA<\/th>/);
  assert.match(indexHtml, /<th[^>]*>TARGET<\/th>/);
  assert.match(indexHtml, /<th[^>]*>STOP<\/th>/);
  assert.match(indexHtml, /<th[^>]*>WIN RATE MC<\/th>/);
  assert.match(indexHtml, /<th[^>]*>ESTADO<\/th>/);
  assert.match(indexHtml, /<th[^>]*>PNL \(%\)<\/th>/);

  // renderMonitoringDashboard renderiza na exata mesma ordem de 10 colunas
  assert.match(rendererJs, /company_name \|\| r\.ticker/);
  assert.match(rendererJs, /target_price/);
  assert.match(rendererJs, /stop_loss/);
  assert.match(rendererJs, /win_rate_mc/);
  assert.match(rendererJs, /status \|\| 'MONITORIZANDO'/);
});

test('Renderer.js: btn-save-qualified-monitoring marca aba portfolio stale e invoca loadPortfolio', () => {
  const rendererJs = read('renderer/renderer.js');

  assert.match(rendererJs, /btnQualifiedMonitoring\.onclick\s*=\s*async/);
  assert.match(rendererJs, /window\.markTabStale\(['"]portfolio['"]\)/);
  assert.match(rendererJs, /loadPortfolio\(\)/);
  assert.match(rendererJs, /loadMonitoringTabData\(\)/);
});
