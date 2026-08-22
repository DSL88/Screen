function createProgressReporter({ minIntervalMs = 100, everyN = 10, now = () => Date.now() } = {}) {
  let lastEmitAt = null;
  let completionsSinceEmit = 0;

  function report(info) {
    const isLast = !!(info && info.isLast);
    const t = now();
    completionsSinceEmit += 1;
    const shouldEmit = isLast
      || lastEmitAt === null
      || completionsSinceEmit >= everyN
      || t - lastEmitAt >= minIntervalMs;
    if (shouldEmit) {
      lastEmitAt = t;
      completionsSinceEmit = 0;
    }
    return shouldEmit;
  }

  function reset() {
    lastEmitAt = null;
    completionsSinceEmit = 0;
  }

  return { report, reset };
}

module.exports = { createProgressReporter };
