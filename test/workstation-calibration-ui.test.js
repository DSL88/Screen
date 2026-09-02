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


