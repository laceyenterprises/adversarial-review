import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { recordApiCall } from './api-telemetry.mjs';

const DEFAULT_THROTTLE_FLOOR = 200;
const MIN_THROTTLE_FLOOR = 50;
const MAX_THROTTLE_FLOOR = 1000;
const LOCK_RETRY_MS = 50;
const LOCK_TIMEOUT_MS = 30_000;

function defaultSleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function resolveRateLimitSharedStatePath(env = process.env, cwd = process.cwd()) {
  const configured = String(env.GHO_RATE_LIMIT_SHARED_STATE_PATH || '').trim();
  return configured || resolve(cwd, 'data', 'api-cache', 'rate-limit-state.json');
}

function resolveThrottleFloor(env = process.env, logger = console) {
  const raw = env.GHO_RATE_LIMIT_THROTTLE_FLOOR;
  if (raw === undefined || raw === null || raw === '') return DEFAULT_THROTTLE_FLOOR;
  const parsed = Number.parseInt(String(raw), 10);
  if (Number.isInteger(parsed) && parsed >= MIN_THROTTLE_FLOOR && parsed <= MAX_THROTTLE_FLOOR) {
    return parsed;
  }
  logger.warn?.(
    `[rate-limit-throttle] invalid GHO_RATE_LIMIT_THROTTLE_FLOOR=${JSON.stringify(raw)}; using default ${DEFAULT_THROTTLE_FLOOR}`
  );
  return DEFAULT_THROTTLE_FLOOR;
}

function normalizeTimestamp(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date((value < 1e12 ? value * 1000 : value)).toISOString();
  }
  const trimmed = String(value).trim();
  if (/^\d+$/.test(trimmed)) {
    const parsed = Number.parseInt(trimmed, 10);
    return new Date((parsed < 1e12 ? parsed * 1000 : parsed)).toISOString();
  }
  const ms = Date.parse(trimmed);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function normalizeObservation(observation = null) {
  if (!observation || typeof observation !== 'object') return null;
  const {
    remaining,
    resetAt,
    observedAt = new Date().toISOString(),
  } = observation;
  const normalizedRemaining = Number.parseInt(String(remaining ?? ''), 10);
  const normalizedResetAt = normalizeTimestamp(resetAt);
  const normalizedObservedAt = normalizeTimestamp(observedAt);
  if (!Number.isInteger(normalizedRemaining) || normalizedRemaining < 0) return null;
  if (!normalizedResetAt || !normalizedObservedAt) return null;
  return {
    remaining: normalizedRemaining,
    resetAt: normalizedResetAt,
    observedAt: normalizedObservedAt,
  };
}

function observationResetAtMs(observation) {
  const ms = Date.parse(observation?.resetAt || '');
  return Number.isFinite(ms) ? ms : null;
}

function observationObservedAtMs(observation) {
  const ms = Date.parse(observation?.observedAt || '');
  return Number.isFinite(ms) ? ms : null;
}

function sanitizeObservation(observation, nowMs = Date.now()) {
  const normalized = normalizeObservation(observation);
  if (!normalized) return null;
  const resetAtMs = observationResetAtMs(normalized);
  if (!Number.isFinite(resetAtMs) || resetAtMs <= nowMs) return null;
  return normalized;
}

function mergeObservations(current, incoming, nowMs = Date.now()) {
  const left = sanitizeObservation(current, nowMs);
  const right = sanitizeObservation(incoming, nowMs);
  if (!left) return right;
  if (!right) return left;
  const leftResetAtMs = observationResetAtMs(left);
  const rightResetAtMs = observationResetAtMs(right);
  if (rightResetAtMs > leftResetAtMs) return right;
  if (rightResetAtMs < leftResetAtMs) return left;
  return {
    remaining: Math.min(left.remaining, right.remaining),
    resetAt: left.resetAt,
    observedAt: observationObservedAtMs(right) > observationObservedAtMs(left)
      ? right.observedAt
      : left.observedAt,
  };
}

function readStateFile(sharedStatePath, { nowMs = Date.now(), readFileSyncImpl = readFileSync } = {}) {
  try {
    return sanitizeObservation(JSON.parse(readFileSyncImpl(sharedStatePath, 'utf8')), nowMs);
  } catch {
    return null;
  }
}

function writeStateFile(sharedStatePath, state, {
  mkdirSyncImpl = mkdirSync,
  openFileSync = openSync,
  writeFileSyncImpl = writeFileSync,
  fsyncSyncImpl = fsyncSync,
  closeFileSync = closeSync,
  renameFileSync = renameSync,
} = {}) {
  mkdirSyncImpl(dirname(sharedStatePath), { recursive: true, mode: 0o700 });
  const tmpPath = `${sharedStatePath}.tmp`;
  const fd = openFileSync(tmpPath, 'w', 0o600);
  try {
    writeFileSyncImpl(fd, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    fsyncSyncImpl(fd);
  } finally {
    closeFileSync(fd);
  }
  renameFileSync(tmpPath, sharedStatePath);
}

function withSharedStateLock(sharedStatePath, callback, {
  mkdirSyncImpl = mkdirSync,
  openFileSync = openSync,
  closeFileSync = closeSync,
  readFileSyncImpl = readFileSync,
  writeFileSyncImpl = writeFileSync,
  rmSyncImpl = rmSync,
} = {}) {
  const lockPath = `${sharedStatePath}.lock`;
  mkdirSyncImpl(dirname(lockPath), { recursive: true, mode: 0o700 });
  const startedAt = Date.now();
  let fd = null;
  try {
    while (fd === null) {
      try {
        fd = openFileSync(lockPath, 'wx', 0o600);
        writeFileSyncImpl(fd, `${new Date().toISOString()}\n`, 'utf8');
      } catch (err) {
        if (err?.code !== 'EEXIST') throw err;
        if ((Date.now() - startedAt) >= LOCK_TIMEOUT_MS) {
          throw new Error(`Timed out waiting for rate-limit lock: ${lockPath}`);
        }
        try {
          const lockAgeMs = Date.now() - Date.parse(String(readFileSyncImpl(lockPath, 'utf8')).trim() || '');
          if (Number.isFinite(lockAgeMs) && lockAgeMs > LOCK_TIMEOUT_MS) {
            rmSyncImpl(lockPath, { force: true });
          }
        } catch {}
        sleepSync(LOCK_RETRY_MS);
      }
    }
    return callback();
  } finally {
    if (fd !== null) closeFileSync(fd);
    rmSyncImpl(lockPath, { force: true });
  }
}

function extractRateLimitObservation(headers, { observedAt = new Date().toISOString() } = {}) {
  if (!headers) return null;
  const lookup = typeof headers.get === 'function'
    ? (name) => headers.get(name)
    : (name) => {
      const target = String(name).toLowerCase();
      for (const [key, value] of Object.entries(headers)) {
        if (String(key).toLowerCase() === target) return value;
      }
      return null;
    };
  return normalizeObservation({
    remaining: lookup('x-ratelimit-remaining'),
    resetAt: lookup('x-ratelimit-reset'),
    observedAt,
  });
}

function createRateLimitThrottle({
  env = process.env,
  logger = console,
  nowMs = () => Date.now(),
  sleepImpl = defaultSleep,
  sharedStatePath = resolveRateLimitSharedStatePath(env),
  recordApiCallImpl = recordApiCall,
  readFileSyncImpl = readFileSync,
  mkdirSyncImpl = mkdirSync,
  openFileSync = openSync,
  writeFileSyncImpl = writeFileSync,
  fsyncSyncImpl = fsyncSync,
  closeFileSync = closeSync,
  renameFileSync = renameSync,
  rmSyncImpl = rmSync,
} = {}) {
  let inMemoryObservation = null;
  let activeThrottlePromise = null;

  function readSharedState() {
    const shared = withSharedStateLock(sharedStatePath, () => readStateFile(sharedStatePath, {
      nowMs: nowMs(),
      readFileSyncImpl,
    }), {
      mkdirSyncImpl,
      openFileSync,
      closeFileSync,
      readFileSyncImpl,
      writeFileSyncImpl,
      rmSyncImpl,
    });
    inMemoryObservation = mergeObservations(inMemoryObservation, shared, nowMs());
    return inMemoryObservation;
  }

  async function recordResponseRateLimit(observation) {
    const normalized = sanitizeObservation(observation, nowMs());
    if (!normalized) return null;
    return withSharedStateLock(sharedStatePath, () => {
      const current = readStateFile(sharedStatePath, { nowMs: nowMs(), readFileSyncImpl });
      const merged = mergeObservations(current, normalized, nowMs());
      if (merged) {
        writeStateFile(sharedStatePath, merged, {
          mkdirSyncImpl,
          openFileSync,
          writeFileSyncImpl,
          fsyncSyncImpl,
          closeFileSync,
          renameFileSync,
        });
      }
      inMemoryObservation = mergeObservations(inMemoryObservation, merged, nowMs());
      return merged;
    }, {
      mkdirSyncImpl,
      openFileSync,
      closeFileSync,
      readFileSyncImpl,
      writeFileSyncImpl,
      rmSyncImpl,
    });
  }

  async function awaitThrottleIfNeeded() {
    if (activeThrottlePromise) return activeThrottlePromise;
    const floor = resolveThrottleFloor(env, logger);
    const current = mergeObservations(inMemoryObservation, readSharedState(), nowMs());
    if (!current || current.remaining >= floor) return false;
    const waitMs = Math.max(0, observationResetAtMs(current) - nowMs());
    recordApiCallImpl?.({
      category: 'rate_limit_throttle_seconds',
      durationMs: waitMs,
      extra: {
        duration_seconds: waitMs / 1000,
        remaining_at_activation: current.remaining,
        reset_at: current.resetAt,
        floor,
      },
    });
    activeThrottlePromise = (async () => {
      await sleepImpl(waitMs);
      activeThrottlePromise = null;
      inMemoryObservation = sanitizeObservation(inMemoryObservation, nowMs());
      return true;
    })();
    return activeThrottlePromise;
  }

  return {
    awaitThrottleIfNeeded,
    recordResponseRateLimit,
    readSharedState,
    resolveSharedStatePath: () => sharedStatePath,
    resolveThrottleFloor: () => resolveThrottleFloor(env, logger),
    __test__: {
      mergeObservations,
      normalizeObservation,
      readStateFile: () => readStateFile(sharedStatePath, { nowMs: nowMs(), readFileSyncImpl }),
      sanitizeObservation,
    },
  };
}

const defaultThrottle = createRateLimitThrottle();

function awaitThrottleIfNeeded() {
  return defaultThrottle.awaitThrottleIfNeeded();
}

function recordResponseRateLimit(observation) {
  return defaultThrottle.recordResponseRateLimit(observation);
}

export {
  awaitThrottleIfNeeded,
  createRateLimitThrottle,
  DEFAULT_THROTTLE_FLOOR,
  extractRateLimitObservation,
  MAX_THROTTLE_FLOOR,
  mergeObservations,
  MIN_THROTTLE_FLOOR,
  normalizeObservation,
  recordResponseRateLimit,
  resolveRateLimitSharedStatePath,
  resolveThrottleFloor,
};
