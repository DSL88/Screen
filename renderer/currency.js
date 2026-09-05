(function (root) {
  'use strict';

  function detectCurrencySymbol(asset) {
    if (!asset) return '€';

    const country = String(asset.country || '').trim().toLowerCase();
    const ticker = String(asset.ticker || '').trim().toUpperCase();
    const index = String(asset.index_name || asset.index || '').trim().toUpperCase();
    const suffix = ticker.includes('.') ? ticker.slice(ticker.lastIndexOf('.') + 1) : '';

    // 1. REINO UNIDO -> Libra (£)
    if (
      ['reino unido', 'united kingdom', 'uk', 'gb', 'england', 'great britain'].some((k) => country.includes(k)) ||
      ['L', 'IL'].includes(suffix) ||
      index.includes('FTSE')
    ) {
      return '£';
    }

    // 2. ESTADOS UNIDOS -> Dólar ($)
    if (
      ['estados unidos', 'united states', 'usa', 'eua', 'us'].some((k) => country === k) ||
      ['S&P', 'SP500', 'SP 500', 'NASDAQ', 'NASDAQ 100', 'DOW', 'NYSE', 'RUSSELL', 'DOW JONES'].some((k) => index.includes(k))
    ) {
      return '$';
    }

    // 3. NORUEGA -> Coroa Norueguesa (kr)
    if (
      ['noruega', 'norway', 'norge'].some((k) => country.includes(k)) ||
      ['OL', 'SL'].includes(suffix) || ['OBX', 'OSEBX'].some((k) => index.includes(k))
    ) {
      return 'kr';
    }

    // 4. SUÍÇA -> Franco Suíço (CHF)
    if (
      ['suíça', 'suica', 'switzerland', 'schweiz'].some((k) => country.includes(k)) ||
      ['SW', 'VT', 'VX'].includes(suffix) || index.includes('SMI')
    ) {
      return 'CHF';
    }

    // 5. SUÉCIA -> Coroa Sueca (kr)
    if (
      ['suécia', 'suecia', 'sweden', 'sverige'].some((k) => country.includes(k)) ||
      ['ST', 'SD'].includes(suffix) || ['OMXS', 'OMXSTOCKHOLM', 'STOCKHOLM'].some((k) => index.includes(k))
    ) {
      return 'kr';
    }

    // 6. DINAMARCA -> Coroa Dinamarquesa (kr)
    if (
      ['dinamarca', 'denmark', 'danmark'].some((k) => country.includes(k)) ||
      ['CO', 'CK'].includes(suffix) || ['OMXC', 'OMXC25', 'C25'].some((k) => index.includes(k))
    ) {
      return 'kr';
    }

    // 7. JAPÃO -> Iene (¥)
    if (
      ['japão', 'japao', 'japan'].some((k) => country.includes(k)) ||
      /^[0-9]+(\.[0-9]+)?\.T$/.test(ticker) || ['NIKKEI', 'TOPIX'].some((k) => index.includes(k))
    ) {
      return '¥';
    }

    // 8. POLÓNIA -> Złoty; CANADÁ -> Dólar canadiano
    if (['polónia', 'polonia', 'poland'].some((k) => country.includes(k)) || suffix === 'WS') return 'zł';
    if (['canadá', 'canada'].some((k) => country.includes(k)) || ['TO', 'TSX'].includes(suffix)) return 'C$';

    // 9. ZONA EURO e restantes praças europeias (Euronext, IBEX, CAC, DAX...) -> Euro (€)
    return '€';
  }

  // Formato unificado em todas as moedas: "000.00 €" (número, espaço, símbolo).
  function formatPriceWithCurrency(price, asset) {
    const num = Number(price || 0);
    const symbol = detectCurrencySymbol(asset);
    return `${num.toFixed(2)} ${symbol}`;
  }

  function formatDeltaWithCurrency(delta, asset) {
    const value = Number(delta || 0);
    const sign = value >= 0 ? '+' : '-';
    return `${sign}${formatPriceWithCurrency(Math.abs(value), asset)}`;
  }

  const api = {
    getAssetCurrencySymbol: detectCurrencySymbol,
    formatPriceWithCurrency: formatPriceWithCurrency,
    formatDeltaWithCurrency: formatDeltaWithCurrency
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.ScreenCurrency = api;
    root.getAssetCurrencySymbol = detectCurrencySymbol;
    root.formatPriceWithCurrency = formatPriceWithCurrency;
    root.formatDeltaWithCurrency = formatDeltaWithCurrency;
  }
})(typeof window !== 'undefined' ? window : globalThis);
