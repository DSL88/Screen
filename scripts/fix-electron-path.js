#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const pathFile = path.join(__dirname, '..', 'node_modules', 'electron', 'path.txt');

try {
  if (!fs.existsSync(pathFile)) {
    process.exit(0);
  }
  const raw = fs.readFileSync(pathFile, 'utf-8');
  const trimmed = raw.replace(/\s+$/g, '');
  if (raw !== trimmed) {
    fs.writeFileSync(pathFile, trimmed);
    console.log('[fix-electron-path] Normalized trailing whitespace in path.txt');
  }
} catch (err) {
  console.warn('[fix-electron-path] Could not normalize path.txt:', err.message);
}
