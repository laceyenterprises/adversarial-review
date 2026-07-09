import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, watch, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { createHandoffRateLimiter, normalizeHandoffMaxPerPrHead } from './handoff-rate-cap.mjs';
import { loadConfigCached } from './config-loader.mjs';

const WATCHER_WAKE_FILE = 'watcher-wake.json';
const DEFAULT_WAKE_POLL_MS = 1000;

function watcherWakePath(rootDir) {
  return join(rootDir, 'data', WATCHER_WAKE_FILE);
}

function readWakeSnapshot(filePath) {
  try {
    const raw = readFileSync(filePath, 'utf8');
    try {
      const payload = JSON.parse(raw);
      const requestId = String(payload?.request_id || '').trim();
      if (requestId) return { key: `request_id:${requestId}`, payload };
      return {
        key: `content:${createHash('sha256').update(raw).digest('hex')}`,
        payload,
      };
    } catch {
      return {
        key: `content:${createHash('sha256').update(raw).digest('hex')}`,
        payload: null,
      };
    }
  } catch {
    return null;
  }
}

function requestWatcherWake({
  rootDir,
  reason = 'unspecified',
  repo = null,
  prNumber = null,
  headSha = null,
  requestedAt = new Date().toISOString(),
  requestId = randomUUID(),
} = {}) {
  if (!rootDir) {
    throw new Error('requestWatcherWake requires rootDir');
  }
  const filePath = watcherWakePath(rootDir);
  mkdirSync(dirname(filePath), { recursive: true });
  const payload = {
    schema_version: 1,
    request_id: requestId,
    requested_at: requestedAt,
    reason,
    repo,
    pr_number: prNumber,
    ...(headSha ? { head_sha: headSha } : {}),
  };
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  renameSync(tmpPath, filePath);
  return { requested: true, filePath, payload };
}

function createWatcherWakeSource({
  rootDir,
  logger = console,
  pollMs = DEFAULT_WAKE_POLL_MS,
  rateLimiter = createHandoffRateLimiter({ rootDir, logger }),
  loadConfigImpl = loadConfigCached,
  env = process.env,
} = {}) {
  if (!rootDir) {
    throw new Error('createWatcherWakeSource requires rootDir');
  }
  const filePath = watcherWakePath(rootDir);
  const dirPath = dirname(filePath);
  mkdirSync(dirPath, { recursive: true });

  let lastSeen = readWakeSnapshot(filePath)?.key || null;
  let closed = false;
  const waiters = new Set();

  function consumeIfChanged() {
    const nextSeen = readWakeSnapshot(filePath);
    if (!nextSeen || nextSeen.key === lastSeen) return null;
    lastSeen = nextSeen.key;
    try {
      const cfg = loadConfigImpl({ env }).getHandoffConfig();
      rateLimiter?.setMaxPerPrHead?.(normalizeHandoffMaxPerPrHead(cfg.maxPerPrHead));
    } catch (err) {
      logger?.warn?.(`[watcher] handoff rate-cap config load failed; using current cap: ${err?.message || err}`);
    }
    const payload = nextSeen.payload || { reason: 'unreadable-wake-file' };
    const cap = rateLimiter?.inspect?.(payload);
    if (cap?.accepted === false) {
      return null;
    }
    return payload;
  }

  function notifyIfChanged() {
    if (closed || waiters.size === 0) return;
    const payload = consumeIfChanged();
    if (!payload) return;
    for (const waiter of [...waiters]) {
      waiter({ woken: true, reason: 'wake-file', payload });
    }
  }

  let watcher = null;
  try {
    watcher = watch(dirPath, { persistent: false }, (_eventType, filename) => {
      if (filename && String(filename) !== WATCHER_WAKE_FILE) return;
      notifyIfChanged();
    });
    watcher.on('error', (err) => {
      logger?.warn?.(`[watcher] wake-file watch failed; falling back to polling: ${err?.message || err}`);
    });
  } catch (err) {
    logger?.warn?.(`[watcher] wake-file watch unavailable; falling back to polling: ${err?.message || err}`);
  }

  function wait(timeoutMs) {
    if (closed || timeoutMs <= 0) {
      return Promise.resolve({ woken: false, reason: closed ? 'closed' : 'timeout' });
    }
    const immediatePayload = consumeIfChanged();
    if (immediatePayload) {
      return Promise.resolve({ woken: true, reason: 'wake-file', payload: immediatePayload });
    }

    return new Promise((resolve) => {
      let settled = false;
      let timeout = null;
      let interval = null;

      function finish(result) {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        if (interval) clearInterval(interval);
        waiters.delete(finish);
        resolve(result);
      }

      waiters.add(finish);
      timeout = setTimeout(() => finish({ woken: false, reason: 'timeout' }), timeoutMs);
      interval = setInterval(notifyIfChanged, Math.max(100, pollMs));
    });
  }

  function close() {
    closed = true;
    try {
      watcher?.close?.();
    } catch {
      // Best-effort cleanup only.
    }
    for (const waiter of [...waiters]) {
      waiter({ woken: false, reason: 'closed' });
    }
    waiters.clear();
  }

  return { filePath, wait, close };
}

export {
  DEFAULT_WAKE_POLL_MS,
  createWatcherWakeSource,
  requestWatcherWake,
  watcherWakePath,
};
