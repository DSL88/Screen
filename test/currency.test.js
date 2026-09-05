import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const currency = require(path.resolve('renderer/currency.js'));
const { getAssetCurrencySymbol: sym, formatPriceWithCurrency: fmt } = currency;

test('Moeda: Reino Unido (sufixo .L / país / índice FTSE) -> Libra (£)', () => {
  assert.equal(sym({ ticker: 'TMT.L' }), '£');
  assert.equal(sym({ ticker: 'VODA.L', country: 'Reino Unido' }), '£');
  assert.equal(sym({ country: 'United Kingdom' }), '£');
  assert.equal(sym({ ticker: 'AZN.L', index_name: 'FTSE 100' }), '£');
  assert.equal(sym({ ticker: 'BATS.L', country: 'GB' }), '£');
  assert.equal(fmt(25.3, { ticker: 'TMT.L' }), '25.30 £');
});

test('Moeda: EUA (país / índices S&P, NASDAQ, DOW) -> Dólar ($)', () => {
  assert.equal(sym({ ticker: 'NVDA', country: 'Estados Unidos' }), '$');
  assert.equal(sym({ ticker: 'AAPL', country: 'EUA' }), '$');
  assert.equal(sym({ ticker: 'MSFT', country: 'USA' }), '$');
  assert.equal(sym({ ticker: 'MMM', index_name: 'DOW JONES' }), '$');
  assert.equal(sym({ ticker: 'AMZN', index_name: 'NASDAQ 100' }), '$');
  assert.equal(fmt(180, { country: 'United States' }), '180.00 $');
});

test('Moeda: Zona Euro (Portugal/Espanha/França e sufixos Euronext) -> Euro (€)', () => {
  assert.equal(sym({ ticker: 'GALP.LS', country: 'Portugal' }), '€');
  assert.equal(sym({ ticker: 'RNE.PA', country: 'França' }), '€');
  assert.equal(sym({ ticker: 'SAP.DE', country: 'Alemanha' }), '€');
  assert.equal(sym({ ticker: 'MC.PA', index_name: 'CAC 40' }), '€');
  assert.equal(sym({ ticker: 'BKD.AS', country: 'Países Baixos' }), '€');
  assert.equal(fmt(11.85, { ticker: 'GALP.LS', country: 'Portugal' }), '11.85 €');
});

test('Moeda: países nórdicos -> kr (Noruega .OL, Suécia .ST, Dinamarca .CO)', () => {
  assert.equal(sym({ ticker: 'EQ1T.OL', country: 'Noruega' }), 'kr');
  assert.equal(sym({ ticker: 'VOLCO-B.ST', country: 'Suécia' }), 'kr');
  assert.equal(sym({ ticker: 'NOVO-B.CO', country: 'Dinamarca' }), 'kr');
  assert.equal(sym({ ticker: 'NNOR.OL', country: 'Norway' }), 'kr');
  assert.equal(fmt(150, { ticker: 'EQ1T.OL', country: 'Noruega' }), '150.00 kr');
});

test('Moeda: Suíça -> CHF e Japão -> ¥', () => {
  assert.equal(sym({ ticker: 'NOVN.SW', country: 'Suíça' }), 'CHF');
  assert.equal(sym({ ticker: 'NESN.VX', country: 'Switzerland' }), 'CHF');
  assert.equal(sym({ ticker: '7203.T', country: 'Japão' }), '¥');
  assert.equal(sym({ ticker: '6758.T', index_name: 'NIKKEI 225' }), '¥');
  assert.equal(fmt(4500, { ticker: '7203.T', country: 'Japão' }), '4500.00 ¥');
});

test('Moeda: fallback determinístico é Euro', () => {
  assert.equal(sym({}), '€');
  assert.equal(sym({ ticker: 'UNKNOWN' }), '€');
  assert.equal(sym(null), '€');
  assert.equal(fmt(100, { ticker: 'BREV' }), '100.00 €');
});

test('Moeda: delta formatado com sinal e símbolo correto', () => {
  assert.equal(currency.formatDeltaWithCurrency(10.15, { ticker: 'GALP.LS', country: 'Portugal' }), '+10.15 €');
  assert.equal(currency.formatDeltaWithCurrency(-5.07, { ticker: 'GALP.LS', country: 'Portugal' }), '-5.07 €');
  assert.equal(currency.formatDeltaWithCurrency(2.5, { ticker: 'TMT.L' }), '+2.50 £');
});

test('Moeda: formato unificado "000.00 <símbolo>" em TODAS as divisas', () => {
  const cases = ['£', '$', '€', 'kr', 'CHF', '¥', 'zł', 'C$'];
  const assets = [
    { ticker: 'TMT.L' },
    { ticker: 'NVDA', country: 'EUA' },
    { ticker: 'GALP.LS', country: 'Portugal' },
    { ticker: 'EQ1T.OL', country: 'Noruega' },
    { ticker: 'NOVN.SW', country: 'Suíça' },
    { ticker: '7203.T', country: 'Japão' },
    { ticker: 'PKN.WA', country: 'Polónia' },
    { ticker: 'SHOP.TO', country: 'Canadá' }
  ];
  assets.forEach((asset, i) => {
    const out = fmt(1234.56, asset);
    assert.equal(out, `1234.56 ${cases[i]}`);
    assert.match(out, /^[\d.,]+ \S+$/, `símbolo deve vir sempre depois do número: ${out}`);
  });
});
