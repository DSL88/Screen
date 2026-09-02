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
