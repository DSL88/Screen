import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

test('Workstation HTML: horizonte padrão 35d e card Sharpe H=35d', () => {
  const html = fs.readFileSync(path.resolve('renderer/index.html'), 'utf8');

  // 1. Input de horizonte com valor padrão 35
  assert.match(
    html,
    /<input[^>]*id=["']input-horizonte["'][^>]*value=["']35["']/,
    'input-horizonte deve possuir value="35"'
  );

  // 2. Card Sharpe OOS com badge H=35d
  assert.match(
    html,
    /H=35d/,
    'Card de Sharpe Out-of-Sample deve indicar H=35d'
  );
  assert.match(
    html,
    /Horizonte H=35 Dias Úteis/,
    'Card de Sharpe Out-of-Sample deve ter subtexto Horizonte H=35 Dias Úteis'
  );
});

test('Workstation Math: cálculo estrito de Target (+4.8%) e Stop Loss (-2.4%)', () => {
  const price = 211.42;
  const target = price * (1 + 0.048);
  const stopLoss = price * (1 - 0.024);

  // Verificação matemática exata (critério do utilizador para ELEC.PA)
  assert.equal(target.toFixed(2), '221.57', 'Target de 211.42 € deve ser 221.57 € (+4.8%)');
  assert.equal(stopLoss.toFixed(2), '206.35', 'Stop Loss de 211.42 € deve ser 206.35 € (-2.4%)');
});

test('Workstation CSS: espaçamento lateral e formato pílula dos botões', () => {
  const css = fs.readFileSync(path.resolve('renderer/styles.css'), 'utf8');

  // Contentor com padding lateral generoso
  assert.match(css, /\.workstation-container[\s\S]*?padding:\s*24px 32px 40px 32px !important;/);

  // Botões em formato pílula
  assert.match(css, /border-radius:\s*9999px !important;/);
});

test('Python Engine: horizonte padrão 35 dias e fórmulas de target/stop loss', () => {
  const pyCode = fs.readFileSync(path.resolve('python_engine/run_pipeline.py'), 'utf8');

  assert.match(pyCode, /horizon_markov = int\(params\.get\("horizonte"\) or params\.get\("horizon"\) or 35\)/);
  assert.match(pyCode, /horizon_days: int = 35/);
  assert.match(pyCode, /target_p = round\(curr_p \* \(1\.0 \+ 0\.048\), 2\)/);
  assert.match(pyCode, /stop_l = round\(curr_p \* \(1\.0 - 0\.024\), 2\)/);
});

test('Workstation HTML & JS: Tabela Mestra de Recomendações presente e renderizável', () => {
  const html = fs.readFileSync(path.resolve('renderer/index.html'), 'utf8');
  assert.match(html, /id=["']container-top-recommendations["']/);
  assert.match(html, /id=["']tbody-top-recommendations["']/);
  assert.match(html, /id=["']badge-top-count["']/);

  const rendererJs = fs.readFileSync(path.resolve('renderer/renderer.js'), 'utf8');
  assert.match(rendererJs, /function renderTopRecommendations/);
  assert.match(rendererJs, /window\.renderTopRecommendations = renderTopRecommendations/);
  assert.match(rendererJs, /window\.saveToTracker = saveToTracker/);

  const quantJs = fs.readFileSync(path.resolve('renderer/quantRenderer.js'), 'utf8');
  assert.match(quantJs, /renderTopRecommendations\(recList\)/);
});

test('Workstation CSS: desbloqueio de altura da Tabela Mestra de Recomendações', () => {
  const css = fs.readFileSync(path.resolve('renderer/styles.css'), 'utf8');
  assert.match(css, /#container-top-recommendations[\s\S]*?min-height:\s*320px !important;/);
  assert.match(css, /#container-top-recommendations \.table-responsive[\s\S]*?min-height:\s*220px !important;/);
});

test('Stochastic Drawer: elementos, estilização e renderizador Canvas presentes', () => {
  const html = fs.readFileSync(path.resolve('renderer/index.html'), 'utf8');
  assert.match(html, /id=["']stochastic-drawer["']/);
  assert.match(html, /id=["']drawer-backdrop["']/);
  assert.match(html, /id=["']drawer-ticker["']/);
  assert.match(html, /id=["']drawer-val-price["']/);
  assert.match(html, /id=["']drawer-val-tp["']/);
  assert.match(html, /id=["']drawer-val-sl["']/);
  assert.match(html, /id=["']drawer-mc-winrate["']/);
  assert.match(html, /id=["']drawer-cvar["']/);
  assert.match(html, /id=["']drawer-ev["']/);
  assert.match(html, /id=["']drawer-regime["']/);
  assert.match(html, /id=["']drawer-montecarlo-canvas["']/);
  assert.match(html, /id=["']drawer-btn-track["']/);

  const css = fs.readFileSync(path.resolve('renderer/styles.css'), 'utf8');
  assert.match(css, /\.stochastic-drawer/);
  assert.match(css, /\.stochastic-drawer\.open/);
  assert.match(css, /\.targets-grid/);
  assert.match(css, /\.chart-canvas-wrapper/);

  const js = fs.readFileSync(path.resolve('renderer/renderer.js'), 'utf8');
  assert.match(js, /function openStochasticDrawer/);
  assert.match(js, /function closeStochasticDrawer/);
  assert.match(js, /function drawMonteCarloSimulation/);
  assert.match(js, /window\.openStochasticDrawer = openStochasticDrawer/);
});

test('Drawer Lateral: botão X fecha (id, stopPropagation, Esc, backdrop) sem overlays a bloquear', () => {
  const html = fs.readFileSync(path.resolve('renderer/index.html'), 'utf8');

  // Botão X com id estável (alinhado com quantRenderer) e stopPropagation
  assert.match(html, /id=["']drawer-close-btn["'][^>]*onclick=["'][^"']*stopPropagation[^"']*closeStochasticDrawer/);

  // Backdrop clicável também para propagação
  assert.match(html, /id=["']drawer-backdrop["'][^>]*onclick=["'][^"']*stopPropagation[^"']*closeStochasticDrawer/);

  // Conteúdo do drawer é preenchido por elementos estáticos (sem innerHTML no cabeçalho que destruiria o X)
  assert.doesNotMatch(html, /stochastic-drawer[\s\S]{0,200}innerHTML/);

  const quantJs = fs.readFileSync(path.resolve('renderer/quantRenderer.js'), 'utf8');
  assert.match(quantJs, /drawerCloseBtn[\s\S]*addEventListener\('click'/);
  assert.match(quantJs, /Escape/);
  assert.match(quantJs, /function closeStochasticDrawer/);
  assert.match(quantJs, /window\.closeStochasticDrawer = closeStochasticDrawer/);

  const css = fs.readFileSync(path.resolve('renderer/styles.css'), 'utf8');
  // Drawer acima de todos os overlays/modais (9999)
  assert.match(css, /\.stochastic-drawer\s*\{[\s\S]*?z-index:\s*10001;/);
  assert.match(css, /\.drawer-backdrop\s*\{[\s\S]*?z-index:\s*10000;/);
});

test('Tabela Mestra: badge de contagem é dinâmico (sem texto rígido "5 Ativos")', () => {
  const html = fs.readFileSync(path.resolve('renderer/index.html'), 'utf8');
  assert.doesNotMatch(html, /id=["']badge-top-count["'][\s\S]{0,200}5 Ativos/);

  const quantJs = fs.readFileSync(path.resolve('renderer/quantRenderer.js'), 'utf8');
  assert.match(quantJs, /badge-top-count/);
  assert.match(quantJs, /Top \$\{sortedAssets\.length\} Melhores Ativos \(Ordenados do Maior para o Menor\)/);
});

test('Top 20: ordenação defensiva por Alpha Score decrescente e ranking #1-#20', () => {
  const quantJs = fs.readFileSync(path.resolve('renderer/quantRenderer.js'), 'utf8');
  assert.match(quantJs, /\.sort\(\(a, b\) => Number\(b\.alpha_score \|\| 0\) - Number\(a\.alpha_score \|\| 0\)\)/);
  assert.match(quantJs, /\.slice\(0, 20\)/);
  assert.match(quantJs, /#\$\{rank\}/);

  const rendererJs = fs.readFileSync(path.resolve('renderer/renderer.js'), 'utf8');
  assert.match(rendererJs, /\.sort\(\(a, b\) => Number\(b\.alpha_score \|\| 0\) - Number\(a\.alpha_score \|\| 0\)\)/);
  assert.match(rendererJs, /#\$\{rank\}/);

  const html = fs.readFileSync(path.resolve('renderer/index.html'), 'utf8');
  assert.match(html, /<th style="padding: 8px 10px; text-align: center;">#<\/th>/);
});

test('Moeda dinâmica: helper carregado no index.js e aplicado na tabela e no drawer', () => {
  const html = fs.readFileSync(path.resolve('renderer/index.html'), 'utf8');
  assert.match(html, /<script src=["']currency\.js["']/);

  const quantJs = fs.readFileSync(path.resolve('renderer/quantRenderer.js'), 'utf8');
  assert.match(quantJs, /formatPriceWithCurrency\(value, asset\)/);

  const rendererJs = fs.readFileSync(path.resolve('renderer/renderer.js'), 'utf8');
  assert.match(rendererJs, /formatPriceWithCurrency\(value, asset\)/);
});

test('Drawer: cabeçalho exibe Nome da Empresa, Ticker, País e Índice', () => {
  const html = fs.readFileSync(path.resolve('renderer/index.html'), 'utf8');
  assert.match(html, /id=["']drawer-company-name["']/);
  assert.match(html, /id=["']drawer-ticker["']/);
  assert.match(html, /id=["']drawer-country-badge["']/);
  assert.match(html, /id=["']drawer-index-badge["']/);

  const quantJs = fs.readFileSync(path.resolve('renderer/quantRenderer.js'), 'utf8');
  assert.match(quantJs, /drawer-company-name/);
  assert.match(quantJs, /drawer-country-badge/);
  assert.match(quantJs, /drawer-index-badge/);

  const rendererJs = fs.readFileSync(path.resolve('renderer/renderer.js'), 'utf8');
  assert.match(rendererJs, /drawer-company-name/);
  assert.match(rendererJs, /drawer-country-badge/);
  assert.match(rendererJs, /drawer-index-badge/);
});

test('Metadados: DB expõe getTickersMetadata e main.js anexa asset_meta ao payload', () => {
  const dbJs = fs.readFileSync(path.resolve('src/db/database.js'), 'utf8');
  assert.match(dbJs, /getTickersMetadata\(/);
  assert.match(dbJs, /SELECT ticker, name, country, index_name FROM stocks/);
  assert.match(dbJs, /SELECT ticker, name, country, index_name FROM custom_tickers/);

  const mainJs = fs.readFileSync(path.resolve('main.js'), 'utf8');
  assert.match(mainJs, /getTickersMetadata\(tickers\)/);
  assert.match(mainJs, /p\.asset_meta\s*=/);
});

test('Motor Python: top_n padrão 20 com corte Top 15-20 e metadados na recomendação', () => {
  const py = fs.readFileSync(path.resolve('python_engine/run_pipeline.py'), 'utf8');
  assert.match(py, /top_n: Optional\[int\] = 20/);
  assert.match(py, /limit = max\(15, min\(int\(top_n\), 20\)\)/);
  assert.match(py, /"name": \(asset\.get\('name'\)/);
  assert.match(py, /"country": \(asset\.get\('country'\)/);
  assert.match(py, /"index_name": \(asset\.get\('index_name'\)/);
  assert.match(py, /params\.get\("asset_meta"\)/);
});


