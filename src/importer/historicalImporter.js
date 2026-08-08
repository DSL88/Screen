const fs = require('fs');
const path = require('path');
const readline = require('readline');

const REQUIRED_COLUMNS = ['date', 'open', 'high', 'low', 'close', 'volume'];

// Aliases normalizados (minúsculas, sem acentos) por coluna canónica.
// Aceita cabeçalhos em Português e Inglês.
const COLUMN_ALIASES = {
  date: ['date', 'data'],
  open: ['open', 'abertura'],
  high: ['high', 'maxima'],
  low: ['low', 'minima'],
  close: ['close', 'fechamento'],
  volume: ['volume'],
  ticker: ['ticker', 'ativo', 'simbolo', 'symbol']
};

function normalizeHeader(header) {
  return header.trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function columnAliases(canonical) {
  return COLUMN_ALIASES[canonical] || [canonical];
}

function findColumnIndex(headers, target) {
  const aliases = columnAliases(target);
  return headers.findIndex(h => aliases.includes(normalizeHeader(h)));
}

// Converte números aceitando vírgula decimal (formato europeu) e
// separadores de milhar (1.234,56 ou 1,234.56).
function toNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
  if (typeof value !== 'string') return NaN;
  let s = value.trim().replace(/\s/g, '');
  if (!s) return NaN;
  const hasDot = s.indexOf('.') !== -1;
  const hasComma = s.indexOf(',') !== -1;
  if (hasComma && hasDot) {
    // 1.234,56 → pontos de milhar + vírgula decimal
    if (s.lastIndexOf(',') > s.lastIndexOf('.')) s = s.replace(/\./g, '').replace(',', '.');
    // 1,234.56 → vírgulas de milhar + ponto decimal
    else s = s.replace(/,/g, '');
  } else if (hasComma) {
    s = s.replace(',', '.');
  }
  return parseFloat(s);
}

function excelDateToJSDate(serial) {
  const utc_days = Math.floor(serial - 25569);
  const utc_value = utc_days * 86400;
  const date_info = new Date(utc_value * 1000);
  return date_info.toISOString().slice(0, 10);
}

function padDate(y, m, d) {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function normalizeDate(dateStr) {
  if (!dateStr) return null;
  if (typeof dateStr === 'number') {
    return excelDateToJSDate(dateStr);
  }
  if (typeof dateStr !== 'string') return null;
  const s = dateStr.trim();
  if (!s) return null;

  let y, m, d;

  const isoMatch = s.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})/);
  if (isoMatch) {
    y = parseInt(isoMatch[1]);
    m = parseInt(isoMatch[2]);
    d = parseInt(isoMatch[3]);
  } else {
    const slashMatch = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (slashMatch) {
      m = parseInt(slashMatch[1]);
      d = parseInt(slashMatch[2]);
      y = parseInt(slashMatch[3]);
    } else {
      const dashMatch = s.match(/^(\d{1,2})-(\d{1,2})-(\d{4})/);
      if (dashMatch) {
        d = parseInt(dashMatch[1]);
        m = parseInt(dashMatch[2]);
        y = parseInt(dashMatch[3]);
      } else {
        const fallback = new Date(s);
        if (!isNaN(fallback.getTime())) {
          return fallback.toISOString().slice(0, 10);
        }
        return null;
      }
    }
  }

  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  return padDate(y, m, d);
}

// Detecta o delimitador de colunas (preferindo o mais frequente no cabeçalho).
// Isto permite ficheiros com vírgula decimal ("1,5") quando o separador é ";".
function detectDelimiter(headerLine) {
  const candidates = [
    [';', (headerLine.match(/;/g) || []).length],
    [',', (headerLine.match(/,/g) || []).length],
    ['\t', (headerLine.match(/\t/g) || []).length]
  ].sort((a, b) => b[1] - a[1]);
  return candidates[0][1] > 0 ? candidates[0][0] : ',';
}

function parseCSV(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split(/\r?\n/).filter(line => line.trim() !== '');
  if (lines.length < 2) {
    return { ok: false, error: 'CSV file must have a header and at least one data row' };
  }

  const delimiter = detectDelimiter(lines[0]);
  const splitLine = line => line.split(delimiter).map(v => v.trim());

  const headers = splitLine(lines[0]);
  const colCount = headers.length;
  const colMap = {};
  for (const required of REQUIRED_COLUMNS) {
    const idx = findColumnIndex(headers, required);
    if (idx === -1) {
      return { ok: false, error: `Missing required column: ${required}` };
    }
    colMap[required] = idx;
  }

  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const values = splitLine(lines[i]);
    // Guarda anti-corrupção: se uma linha tem mais campos do que o cabeçalho,
    // provavelmente o separador de colunas colide com a vírgula decimal (ex:
    // ficheiro com vírgula a separar colunas e também decimais). Falha com
    // mensagem clara em vez de persistir dados desalinhados. Tolera apenas um
    // separador terminal em vírgula (linha acaba em ",").
    if (values.length > colCount) {
      const trailingEmpty = values.length === colCount + 1 && values[colCount] === '';
      if (!trailingEmpty) {
        return {
          ok: false,
          error: `Inconsistência de colunas na linha ${i + 1}: ${values.length} campos vs ${colCount} no cabeçalho. ` +
            'Verifica o separador do ficheiro (a vírgula é o separador e também o separador decimal?).'
        };
      }
      values.length = colCount;
    }
    const row = {};
    for (const col of REQUIRED_COLUMNS) {
      row[col] = values[colMap[col]] || '';
    }
    rows.push(row);
  }

  return { ok: true, rows };
}

function parseXLSX(filePath) {
  const xlsx = require('xlsx');
  const workbook = xlsx.readFile(filePath);
  const sheetName = workbook.SheetNames[0];
  const worksheet = workbook.Sheets[sheetName];
  const data = xlsx.utils.sheet_to_json(worksheet, { defval: '' });

  if (!data.length) {
    return { ok: false, error: 'XLSX file has no data rows' };
  }

  const headers = Object.keys(data[0]);
  for (const required of REQUIRED_COLUMNS) {
    const found = headers.some(h => columnAliases(required).includes(normalizeHeader(h)));
    if (!found) {
      return { ok: false, error: `Missing required column: ${required}` };
    }
  }

  const normalizedData = data.map(row => {
    const normalized = {};
    for (const required of REQUIRED_COLUMNS) {
      const key = headers.find(h => columnAliases(required).includes(normalizeHeader(h)));
      normalized[required] = row[key];
    }
    return normalized;
  });

  return { ok: true, rows: normalizedData };
}

function cleanRow(row) {
  const normalizedDate = normalizeDate(row.date);
  if (!normalizedDate) {
    return null;
  }

  const open = toNumber(row.open);
  const high = toNumber(row.high);
  const low = toNumber(row.low);
  const close = toNumber(row.close);

  if ([open, high, low, close].some(v => isNaN(v))) {
    return null;
  }

  const volume = parseInt(String(row.volume).replace(/[.,]/g, ''), 10);
  if (isNaN(volume)) {
    return null;
  }

  return {
    date: normalizedDate,
    open,
    high,
    low,
    close,
    volume,
  };
}

function parseFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      return { ok: false, error: 'File not found' };
    }

    const ext = path.extname(filePath).toLowerCase();
    let result;

    if (ext === '.csv') {
      result = parseCSV(filePath);
    } else if (ext === '.xlsx') {
      result = parseXLSX(filePath);
    } else {
      return { ok: false, error: 'Unsupported file format. Use .csv or .xlsx' };
    }

    if (!result.ok) {
      return result;
    }

    const candles = [];
    for (const row of result.rows) {
      const cleaned = cleanRow(row);
      if (cleaned) {
        candles.push(cleaned);
      }
    }

    if (!candles.length) {
      return { ok: false, error: 'No valid data rows found' };
    }

    candles.sort((a, b) => new Date(a.date) - new Date(b.date));

    return { ok: true, candles };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

const REQUIRED_IMPORT_COLUMNS = ['ticker', 'date', 'open', 'high', 'low', 'close', 'volume'];

async function importFromCsvFile(filePath, db) {
  if (!fs.existsSync(filePath)) {
    return { ok: false, error: 'File not found' };
  }

  const colMap = {};
  let inserted = 0;
  let skipped = 0;
  let headerParsed = false;
  let firstDate = null;
  let lastDate = null;
  let stmt;
  let delimiter = ',';
  let colCount = 0;

  const stream = fs.createReadStream(filePath, { encoding: 'utf-8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  try {
    db.db.exec('BEGIN TRANSACTION');

    stmt = db.db.prepare(
      'INSERT OR REPLACE INTO historical_prices (ticker, date, open, high, low, close, volume) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );

    for await (const line of rl) {
      if (!line.trim()) continue;

      if (!headerParsed) {
        delimiter = detectDelimiter(line);
        colCount = line.split(delimiter).length;
      }
      const values = line.split(delimiter).map(v => v.trim());

      if (!headerParsed) {
        for (const col of REQUIRED_IMPORT_COLUMNS) {
          const idx = values.findIndex(v => columnAliases(col).includes(normalizeHeader(v)));
          if (idx === -1) {
            db.db.exec('ROLLBACK');
            return { ok: false, error: `Missing required column: ${col}` };
          }
          colMap[col] = idx;
        }
        headerParsed = true;
        continue;
      }

      if (values.length > colCount) {
        const trailingEmpty = values.length === colCount + 1 && values[colCount] === '';
        if (!trailingEmpty) {
          throw new Error(
            `Inconsistência de colunas: ${values.length} campos vs ${colCount} no cabeçalho. ` +
            'Verifica o separador do ficheiro (a vírgula é o separador e também o separador decimal?).'
          );
        }
        values.length = colCount;
      }

      const ticker = (values[colMap.ticker] || '').trim().toUpperCase();
      const date = normalizeDate(values[colMap.date]);
      const closeNum = toNumber(values[colMap.close]);

      if (!ticker || !date || isNaN(closeNum)) {
        skipped++;
        continue;
      }

      const open = toNumber(values[colMap.open]);
      const high = toNumber(values[colMap.high]);
      const low = toNumber(values[colMap.low]);
      const volume = parseInt(String(values[colMap.volume] || '').replace(/[.,]/g, ''), 10);

      if ([open, high, low, volume].some(v => isNaN(v))) {
        skipped++;
        continue;
      }

      stmt.run(ticker, date, open, high, low, closeNum, volume);
      inserted++;

      if (!firstDate || date < firstDate) firstDate = date;
      if (!lastDate || date > lastDate) lastDate = date;
    }

    db.db.exec('COMMIT');
    return { ok: true, inserted, skipped, firstDate, lastDate };
  } catch (err) {
    try { db.db.exec('ROLLBACK'); } catch (_) {}
    return { ok: false, error: err.message };
  } finally {
    stream.close();
  }
}

module.exports = { parseFile, importFromCsvFile };
