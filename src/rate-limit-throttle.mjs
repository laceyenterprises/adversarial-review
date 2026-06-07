import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { recordApiCall } from './api-telemetry.mjs';

const DEFAULT_THROTTLE_FLOOR = 200;
const MIN_THROTTLE_FLOOR = 50;
const MAX_THROTTLE_FLOOR = 1000;
const LOCK_RETRY_MS = 50;
const LOCK_TIMEOUT_MS = 30_000;
const DEFAULT_RESOURCE = 'core';
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const TOOL_ROOT = dirname(MODULE_DIR);
const DEFAULT_SHARED_STATE_PATH = resolve(TOOL_ROOT, 'data', 'api-cache', 'rate-limit-state.json');

function defaultSleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function resolveRateLimitSharedStatePath(env = process.env, cwd = process.cwd()) {
  void cwd;
  const configured = String(env.GHO_RATE_LIMIT_SHARED_STATE_PATH || '').trim();
  return configured || DEFAULT_SHARED_STATE_PATH;
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

function normalizeResource(value) {
  const resource = String(value || '').trim().toLowerCase();
  return resource || DEFAULT_RESOURCE;
}

function normalizeObservation(observation = null) {
  if (!observation || typeof observation !== 'object') return null;
  const {
    remaining,
    resetAt,
    observedAt = new Date().toISOString(),
    resource = DEFAULT_RESOURCE,
  } = observation;
  const normalizedRemaining = Number.parseInt(String(remaining ?? ''), 10);
  const normalizedResetAt = normalizeTimestamp(resetAt);
  const normalizedObservedAt = normalizeTimestamp(observedAt);
  if (!Number.isInteger(normalizedRemaining) || normalizedRemaining < 0) return null;
  if (!normalizedResetAt || !normalizedObservedAt) return null;
  return {
    resource: normalizeResource(resource),
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

function mergeResourceObservations(current, incoming, nowMs = Date.now()) {
  const left = sanitizeObservation(current, nowMs);
  const right = sanitizeObservation(incoming, nowMs);
  if (!left) return right;
  if (!right) return left;
  const leftResetAtMs = observationResetAtMs(left);
  const rightResetAtMs = observationResetAtMs(right);
  if (rightResetAtMs > leftResetAtMs) return right;
  if (rightResetAtMs < leftResetAtMs) return left;
  return {
    resource: left.resource,
    remaining: Math.min(left.remaining, right.remaining),
    resetAt: left.resetAt,
    observedAt: observationObservedAtMs(right) > observationObservedAtMs(left)
      ? right.observedAt
      : left.observedAt,
  };
}

function normalizeObservationMap(value, now = Date.now()) {
  const normalized = {};
  if (!value || typeof value !== 'object') return normalized;
  if ('remaining' in value || 'resetAt' in value) {
    const legacy = sanitizeObservation(value, now);
    if (legacy) normalized[legacy.resource] = legacy;
    return normalized;
  }
  const buckets = value?.buckets && typeof value.buckets === 'object' ? value.buckets : value;
  for (const [resource, observation] of Object.entries(buckets)) {
    const normalizedObservation = sanitizeObservation({ ...observation, resource }, now);
    if (normalizedObservation) normalized[normalizedObservation.resource] = normalizedObservation;
  }
  return normalized;
}

function mergeObservationMaps(current, incoming, nowMs = Date.now()) {
  const left = normalizeObservationMap(current, nowMs);
  const right = normalizeObservationMap(incoming, nowMs);
  const merged = { ...left };
  for (const [resource, observation] of Object.entries(right)) {
    merged[resource] = mergeResourceObservations(merged[resource], observation, nowMs);
  }
  return merged;
}

async function readStateFile(sharedStatePath, { nowMs = Date.now(), readFileImpl = readFile } = {}) {
  try {
    return normalizeObservationMap(JSON.parse(await readFileImpl(sharedStatePath, 'utf8')), nowMs);
  } catch {
    return {};
  }
}

async function writeStateFile(sharedStatePath, state, {
  mkdirImpl = mkdir,
  openImpl = open,
  renameImpl = rename,
} = {}) {
  await mkdirImpl(dirname(sharedStatePath), { recursive: true, mode: 0o700 });
  const tmpPath = `${sharedStatePath}.tmp`;
  const handle = await openImpl(tmpPath, 'w', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify({ version: 1, buckets: state }, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await renameImpl(tmpPath, sharedStatePath);
}

async function writeThrottleStatusFile(sharedStatePath, payload, {
  mkdirImpl = mkdir,
  writeFileImpl = writeFile,
} = {}) {
  const statusPath = `${sharedStatePath}.throttled.json`;
  await mkdirImpl(dirname(statusPath), { recursive: true, mode: 0o700 });
  await writeFileImpl(statusPath, `${JSON.stringify({ version: 1, ...payload }, null, 2)}\n`, { mode: 0o600 });
  return statusPath;
}

async function clearThrottleStatusFile(sharedStatePath, { rmImpl = rm } = {}) {
  await rmImpl(`${sharedStatePath}.throttled.json`, { force: true });
}

function isAlivePid(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

async function readLockOwner(ownerPath, { readFileImpl = readFile } = {}) {
  try {
    const payload = JSON.parse(await readFileImpl(ownerPath, 'utf8'));
    return {
      token: typeof payload?.token === 'string' ? payload.token : null,
      pid: Number.isInteger(payload?.pid) ? payload.pid : Number.parseInt(String(payload?.pid ?? ''), 10),
    };
  } catch {
    return null;
  }
}

async function withSharedStateLock(sharedStatePath, callback, {
  mkdirImpl = mkdir,
  writeFileImpl = writeFile,
  readFileImpl = readFile,
  rmImpl = rm,
  statImpl = stat,
  sleepImpl = defaultSleep,
  nowMs = () => Date.now(),
  ownerToken = `${process.pid}:${randomUUID()}`,
} = {}) {
  const lockPath = `${sharedStatePath}.lock`;
  const ownerPath = join(lockPath, 'owner.json');
  await mkdirImpl(dirname(lockPath), { recursive: true, mode: 0o700 });
  const startedAt = nowMs();
  let acquiredLock = false;

  async function shouldReclaimLock() {
    let details;
    try {
      details = await statImpl(lockPath);
    } catch (err) {
      if (err?.code === 'ENOENT') return false;
      throw err;
    }
    if ((nowMs() - details.mtimeMs) <= LOCK_TIMEOUT_MS) return false;
    const owner = await readLockOwner(ownerPath, { readFileImpl });
    if (owner?.pid && isAlivePid(owner.pid)) return false;
    return true;
  }

  while (true) {
    try {
      await mkdirImpl(lockPath, { mode: 0o700 });
      try {
        await writeFileImpl(ownerPath, `${JSON.stringify({
          token: ownerToken,
          pid: process.pid,
          acquiredAt: new Date(nowMs()).toISOString(),
        })}\n`, { flag: 'wx', mode: 0o600 });
        acquiredLock = true;
      } catch (err) {
        await rmImpl(lockPath, { recursive: true, force: true });
        throw err;
      }
      break;
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;
      if ((nowMs() - startedAt) >= LOCK_TIMEOUT_MS) {
        throw new Error(`Timed out waiting for rate-limit lock: ${lockPath}`);
      }
      if (await shouldReclaimLock()) {
        await rmImpl(lockPath, { recursive: true, force: true });
        continue;
      }
      await sleepImpl(LOCK_RETRY_MS);
    }
  }

  try {
    return await callback();
  } finally {
    if (acquiredLock) {
      await rmImpl(lockPath, { recursive: true, force: true });
    }
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
    resource: lookup('x-ratelimit-resource') || DEFAULT_RESOURCE,
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
  sharedStatePath,
  recordApiCallImpl = recordApiCall,
  readFileImpl = readFile,
  mkdirImpl = mkdir,
  openImpl = open,
  writeFileImpl = writeFile,
  renameImpl = rename,
  rmImpl = rm,
  statImpl = stat,
} = {}) {
  let inMemoryObservations = {};
  const activeThrottlePromises = new Map();

  function resolveSharedStatePathNow() {
    return sharedStatePath || resolveRateLimitSharedStatePath(env);
  }

  async function readSharedState() {
    const resolvedSharedStatePath = resolveSharedStatePathNow();
    const shared = await withSharedStateLock(resolvedSharedStatePath, () => readStateFile(resolvedSharedStatePath, {
      nowMs: nowMs(),
      readFileImpl,
    }), {
      mkdirImpl,
      readFileImpl,
      writeFileImpl,
      rmImpl,
      statImpl,
      sleepImpl,
      nowMs,
    });
    inMemoryObservations = mergeObservationMaps(inMemoryObservations, shared, nowMs());
    return inMemoryObservations;
  }

  async function recordResponseRateLimit(observation) {
    const normalized = sanitizeObservation(observation, nowMs());
    if (!normalized) return null;
    const resolvedSharedStatePath = resolveSharedStatePathNow();
    return withSharedStateLock(resolvedSharedStatePath, async () => {
      const current = await readStateFile(resolvedSharedStatePath, { nowMs: nowMs(), readFileImpl });
      const merged = mergeObservationMaps(current, { [normalized.resource]: normalized }, nowMs());
      if (
        Object.keys(merged).length > 0
        && JSON.stringify(merged) !== JSON.stringify(current)
      ) {
        await writeStateFile(resolvedSharedStatePath, merged, {
          mkdirImpl,
          openImpl,
          renameImpl,
        });
      }
      inMemoryObservations = mergeObservationMaps(inMemoryObservations, merged, nowMs());
      return merged[normalized.resource] || null;
    }, {
      mkdirImpl,
      readFileImpl,
      writeFileImpl,
      rmImpl,
      statImpl,
      sleepImpl,
      nowMs,
    });
  }

  async function awaitThrottleIfNeeded(resource = DEFAULT_RESOURCE) {
    const normalizedResource = normalizeResource(resource);
    if (activeThrottlePromises.has(normalizedResource)) {
      return activeThrottlePromises.get(normalizedResource);
    }
    const activePromise = (async () => {
      try {
        const floor = resolveThrottleFloor(env, logger);
        const currentObservations = mergeObservationMaps(inMemoryObservations, await readSharedState(), nowMs());
        const current = currentObservations[normalizedResource] || null;
        if (!current || current.remaining >= floor) return false;
        const waitMs = Math.max(0, observationResetAtMs(current) - nowMs());
        const resolvedSharedStatePath = resolveSharedStatePathNow();
        recordApiCallImpl?.({
          category: 'rate_limit_throttle_seconds',
          durationMs: waitMs,
          extra: {
            duration_seconds: waitMs / 1000,
            remaining_at_activation: current.remaining,
            reset_at: current.resetAt,
            floor,
            resource: normalizedResource,
          },
        });
        if (waitMs > 0) {
          await writeThrottleStatusFile(resolvedSharedStatePath, {
            resource: normalizedResource,
            remaining: current.remaining,
            floor,
            throttledUntil: current.resetAt,
            startedAt: new Date(nowMs()).toISOString(),
            waitMs,
          }, {
            mkdirImpl,
            writeFileImpl,
          });
        }
        try {
          await sleepImpl(waitMs);
        } finally {
          if (waitMs > 0) {
            await clearThrottleStatusFile(resolvedSharedStatePath, { rmImpl });
          }
        }
        inMemoryObservations = mergeObservationMaps(inMemoryObservations, {
          [normalizedResource]: sanitizeObservation(currentObservations[normalizedResource], nowMs()),
        }, nowMs());
        return true;
      } finally {
        activeThrottlePromises.delete(normalizedResource);
      }
    })();
    activeThrottlePromises.set(normalizedResource, activePromise);
    return activePromise;
  }

  return {
    awaitThrottleIfNeeded,
    recordResponseRateLimit,
    readSharedState,
    resolveSharedStatePath: () => resolveSharedStatePathNow(),
    resolveThrottleFloor: () => resolveThrottleFloor(env, logger),
    __test__: {
      mergeObservationMaps,
      mergeObservations: mergeResourceObservations,
      normalizeObservation,
      normalizeObservationMap,
      readStateFile: () => readStateFile(resolveSharedStatePathNow(), { nowMs: nowMs(), readFileImpl }),
      sanitizeObservation,
    },
  };
}

const defaultThrottle = createRateLimitThrottle();

function awaitThrottleIfNeeded(resource) {
  return defaultThrottle.awaitThrottleIfNeeded(resource);
}

function recordResponseRateLimit(observation) {
  return defaultThrottle.recordResponseRateLimit(observation);
}

export {
  awaitThrottleIfNeeded,
  createRateLimitThrottle,
  DEFAULT_RESOURCE,
  DEFAULT_THROTTLE_FLOOR,
  extractRateLimitObservation,
  MAX_THROTTLE_FLOOR,
  mergeObservationMaps,
  MIN_THROTTLE_FLOOR,
  normalizeObservation,
  recordResponseRateLimit,
  resolveRateLimitSharedStatePath,
  resolveThrottleFloor,
};
