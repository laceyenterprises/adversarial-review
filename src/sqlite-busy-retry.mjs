const DEFAULT_SQLITE_BUSY_RETRY_DELAYS_MS = Object.freeze([100, 250, 500, 1000, 2000, 5000]);

function isSqliteBusyError(err) {
  const text = `${String(err?.code || '')}\n${String(err?.message || err || '')}`.toLowerCase();
  return (
    text.includes('sqlite_busy') ||
    text.includes('sqlite_locked') ||
    text.includes('database is locked') ||
    text.includes('database is busy')
  );
}

function sleepSync(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return;
  const buffer = new SharedArrayBuffer(4);
  const view = new Int32Array(buffer);
  Atomics.wait(view, 0, 0, Math.floor(ms));
}

function sleepAsync(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.floor(ms) || 0)));
}

function withSqliteBusyRetrySync(fn, {
  label = 'sqlite-write',
  delaysMs = DEFAULT_SQLITE_BUSY_RETRY_DELAYS_MS,
  sleepImpl = sleepSync,
  log = console,
} = {}) {
  let lastErr = null;
  for (let attempt = 0; attempt <= delaysMs.length; attempt += 1) {
    try {
      return fn();
    } catch (err) {
      lastErr = err;
      if (!isSqliteBusyError(err) || attempt >= delaysMs.length) throw err;
      const delayMs = Number(delaysMs[attempt]) || 0;
      log.warn?.(
        `[sqlite-busy-retry] ${label} hit SQLITE_BUSY (${attempt + 1}/${delaysMs.length + 1}); ` +
        `retrying in ${delayMs}ms: ${err?.message || err}`
      );
      sleepImpl(delayMs);
    }
  }
  throw lastErr;
}

async function withSqliteBusyRetry(fn, {
  label = 'sqlite-write',
  delaysMs = DEFAULT_SQLITE_BUSY_RETRY_DELAYS_MS,
  sleepImpl = sleepAsync,
  log = console,
} = {}) {
  let lastErr = null;
  for (let attempt = 0; attempt <= delaysMs.length; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isSqliteBusyError(err) || attempt >= delaysMs.length) throw err;
      const delayMs = Number(delaysMs[attempt]) || 0;
      log.warn?.(
        `[sqlite-busy-retry] ${label} hit SQLITE_BUSY (${attempt + 1}/${delaysMs.length + 1}); ` +
        `retrying in ${delayMs}ms: ${err?.message || err}`
      );
      await sleepImpl(delayMs);
    }
  }
  throw lastErr;
}

export {
  DEFAULT_SQLITE_BUSY_RETRY_DELAYS_MS,
  isSqliteBusyError,
  withSqliteBusyRetry,
  withSqliteBusyRetrySync,
};
