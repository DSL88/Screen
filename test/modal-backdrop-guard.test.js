const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

test('CSS: .hidden e .modal-backdrop.hidden têm display: none !important e pointer-events: none !important', () => {
  const cssPath = path.join(__dirname, '..', 'renderer', 'styles.css');
  const css = fs.readFileSync(cssPath, 'utf8');

  assert.match(css, /\.hidden\s*\{[^}]*display:\s*none\s*!important/i);
  assert.match(css, /\.hidden\s*\{[^}]*pointer-events:\s*none\s*!important/i);
  assert.match(css, /\.modal-backdrop\.hidden[^{]*\{[^}]*display:\s*none\s*!important/i);
  assert.match(css, /\.modal-backdrop\.hidden[^{]*\{[^}]*pointer-events:\s*none\s*!important/i);
});

test('renderer.js: closeStockModal oculta todos os backdrops e overlays incondicionalmente', () => {
  const rendererPath = path.join(__dirname, '..', 'renderer', 'renderer.js');
  const code = fs.readFileSync(rendererPath, 'utf8');

  // Verifica se closeStockModal querySelectorAll em todos os backdrops
  assert.match(code, /function closeStockModal\(\)/);
  assert.match(code, /\.modal-backdrop/);
  assert.match(code, /backdrop\.classList\.add\('hidden'\)/);
  assert.match(code, /backdrop\.style\.display\s*=\s*'none'/);
  assert.match(code, /backdrop\.hidden\s*=\s*true/);

  // currentModalStock deve ser resetado
  assert.match(code, /currentModalStock\s*=\s*null/);
});

test('renderer.js: saveModalDataAndClose usa bloco try ... finally para garantir o fecho', () => {
  const rendererPath = path.join(__dirname, '..', 'renderer', 'renderer.js');
  const code = fs.readFileSync(rendererPath, 'utf8');

  assert.match(code, /async function saveModalDataAndClose\(\)/);
  assert.match(code, /try\s*\{[\s\S]*\}\s*finally\s*\{[\s\S]*closeStockModal\(\);?[\s\S]*\}/);
});

test('renderer.js: setupModalClosingGuards associa Escape, clique fora e botões de fecho', () => {
  const rendererPath = path.join(__dirname, '..', 'renderer', 'renderer.js');
  const code = fs.readFileSync(rendererPath, 'utf8');

  assert.match(code, /function setupModalClosingGuards\(\)/);
  assert.match(code, /e\.key === 'Escape'/);
  assert.match(code, /e\.target === modalBackdrop/);
  assert.match(code, /setupModalClosingGuards\(\)/);
});
