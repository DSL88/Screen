const fs = require('fs');
const os = require('os');
const path = require('path');

function makeTempDir(prefix = 'markov-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function removeTempDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function makeCandle(ticker, date, close = 100, volume = 1000) {
  return { ticker, date, open: close, high: close + 1, low: close - 1, close, volume };
}

function makeRecentQuotes(count = 200, now = new Date()) {
  const quotes = [];
  for (let i = count - 1; i >= 0; i -= 1) {
    const date = new Date(now.getTime() - i * 86400000);
    const close = 100 + (count - i) / 10;
    quotes.push({ date, open: close - 1, high: close + 1, low: close - 2, close, adjclose: close, volume: 1000 });
  }
  return quotes;
}

// Network clients in production use setTimeout for backoff. Making it
// synchronous keeps retry tests fast while preserving their control flow.
async function withImmediateTimers(fn) {
  const original = global.setTimeout;
  global.setTimeout = (callback, _delay, ...args) => {
    callback(...args);
    return { unref() {} };
  };
  try {
    return await fn();
  } finally {
    global.setTimeout = original;
  }
}

module.exports = {
  makeTempDir,
  removeTempDir,
  makeCandle,
  makeRecentQuotes,
  withImmediateTimers
};
