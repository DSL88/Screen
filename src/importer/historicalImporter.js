const fs = require('fs');
const path = require('path');

const REQUIRED_COLUMNS = ['date', 'open', 'high', 'low', 'close', 'volume'];

function excelDateToJSDate(serial) {
  const utc_days = Math.floor(serial - 25569);
  const utc_value = utc_days * 86400;
  const date_info = new Date(utc_value * 1000);
  return date_info.toISOString().slice(0, 10);
}

function normalizeHeader(header) {
  return header.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

function findColumnIndex(headers, target) {
  return headers.findIndex(h => normalizeHeader(h) === target);
}

function isValidDate(dateStr) {
  if (!dateStr || typeof dateStr !== 'string') return false;
  const d = new Date(dateStr);
  return !isNaN(d.getTime());
}

function parseCSV(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split(/\r?\n/).filter(line => line.trim() !== '');
  if (lines.length < 2) {
    return { ok: false, error: 'CSV file must have a header and at least one data row' };
  }

  const headers = lines[0].split(/[;,\t]/).map(h => h.trim());
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
    const values = lines[i].split(/[;,\t]/).map(v => v.trim());
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
    const found = headers.some(h => normalizeHeader(h) === required);
    if (!found) {
      return { ok: false, error: `Missing required column: ${required}` };
    }
  }

  const normalizedData = data.map(row => {
    const normalized = {};
    for (const required of REQUIRED_COLUMNS) {
      const key = headers.find(h => normalizeHeader(h) === required);
      normalized[required] = row[key];
    }
    return normalized;
  });

  return { ok: true, rows: normalizedData };
}

function cleanRow(row) {
  let dateVal = row.date;
  if (typeof dateVal === 'number') {
    dateVal = excelDateToJSDate(dateVal);
  }
  if (!isValidDate(String(dateVal))) {
    return null;
  }

  const open = parseFloat(row.open);
  const high = parseFloat(row.high);
  const low = parseFloat(row.low);
  const close = parseFloat(row.close);

  if ([open, high, low, close].some(v => isNaN(v))) {
    return null;
  }

  const volumeStr = String(row.volume).replace(/,/g, '');
  const volume = parseInt(volumeStr, 10);
  if (isNaN(volume)) {
    return null;
  }

  return {
    date: String(dateVal),
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

module.exports = { parseFile };
