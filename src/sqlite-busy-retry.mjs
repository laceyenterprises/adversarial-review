import { spawnSync } from 'node:child_process';

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

function sleepSync(ms, {
  atomicsWaitImpl = globalThis.Atomics?.wait,
  sharedArrayBufferImpl = globalThis.SharedArrayBuffer,
  int32ArrayImpl = Int32Array,
  spawnSyncImpl = spawnSync,
} = {}) {
  if (!Number.isFinite(ms) || ms <= 0) return;
  const delayMs = Math.floor(ms);
  if (
    typeof atomicsWaitImpl === 'function' &&
    typeof sharedArrayBufferImpl === 'function' &&
    typeof int32ArrayImpl === 'function'
  ) {
    const buffer = new sharedArrayBufferImpl(4);
    const view = new int32ArrayImpl(buffer);
    atomicsWaitImpl(view, 0, 0, delayMs);
    return;
  }
  const result = spawnSyncImpl('sleep', [(delayMs / 1000).toString()], {
    stdio: 'ignore',
    timeout: delayMs + 1000,
  });
  if (result?.error) throw result.error;
  if (result?.signal) {
    throw new Error(`sleep exited from signal ${result.signal}`);
  }
  if (typeof result?.status === 'number' && result.status !== 0) {
    throw new Error(`sleep exited with status ${result.status}`);
  }
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
  sleepSync,
  withSqliteBusyRetry,
  withSqliteBusyRetrySync,
};
