import { AsyncLocalStorage } from 'node:async_hooks';
import { readFileSync } from 'node:fs';
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { recordApiCall } from './api-telemetry.mjs';

const DEFAULT_THROTTLE_FLOOR = 200;
const MIN_THROTTLE_FLOOR = 50;
const MAX_THROTTLE_FLOOR = 1000;
const LOCK_RETRY_MS = 50;
const LOCK_TIMEOUT_MS = 30_000;
const DEFAULT_RESOURCE = 'core';
const UNKNOWN_RATE_LIMIT_RESET_MS = 60_000;
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const TOOL_ROOT = dirname(MODULE_DIR);
const DEFAULT_SHARED_STATE_PATH = resolve(TOOL_ROOT, 'data', 'api-cache', 'rate-limit-state.json');

const budgetScopes = new AsyncLocalStorage();

function withGitHubBudgetScope(options, fn) {
  const scope = { urgent: false, rateLimited: false, deferred: false, ...options, limitedBudgets: new Map() };
  return budgetScopes.run(scope, () => fn(scope));
}

function currentGitHubBudgetScope() { return budgetScopes.getStore(); }

// Tokens never enter state or logs. A digest isolates credentials without
// depending on which environment-variable alias supplied the token.
function githubCredential({ env = process.env, token = env.GH_TOKEN || env.GITHUB_TOKEN } = {}) {
  if (!token) return 'default';
  return `token-${createHash('sha256').update(String(token)).digest('hex').slice(0, 24)}`;
}

function githubBudgetKey(resource, credential = 'default') {
  return credential === 'default' ? normalizeResource(resource) : `${credential}/${normalizeResource(resource)}`;
}

function markGitHubRateLimited(resource = DEFAULT_RESOURCE, credential = 'default', observation = {}) {
  const scope = currentGitHubBudgetScope();
  const limited = { ...observation, resource: normalizeResource(resource), credential,
    resetAt: normalizeTimestamp(observation.resetAt) || new Date(Date.now() + UNKNOWN_RATE_LIMIT_RESET_MS).toISOString() };
  if (scope) {
    scope.rateLimited = true; // Accounting summary only; never an admission gate.
    scope.limitedBudgets.set(githubBudgetKey(resource, credential), limited);
  }
  return limited;
}

function scopedGitHubRateLimit(resource, credential = 'default', nowMs = Date.now()) {
  const limited = currentGitHubBudgetScope()?.limitedBudgets.get(githubBudgetKey(resource, credential));
  return limited && Date.parse(limited.resetAt) > nowMs ? limited : null;
}

function isGitHubRateLimitError(err) {
  return err?.rateLimited === true || err?.status === 429
    || /rate limit|too many requests|HTTP\s+429/i.test(
      [err?.message, err?.stderr, err?.stdout, err?.response?.data?.message].join('\n'));
}

class GitHubBudgetDeferredError extends Error {
  constructor(observation) {
    observation = { ...observation, resetAt: normalizeTimestamp(observation.resetAt)
      || new Date(Date.now() + UNKNOWN_RATE_LIMIT_RESET_MS).toISOString() };
    super(`GitHub ${observation.resource} budget deferred until ${observation.resetAt}`);
    this.name = 'GitHubBudgetDeferredError';
    this.rateLimited = true;
    this.budgetDeferred = true;
    this.observation = observation;
  }
}

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
    ...(observation.credential && observation.credential !== 'default' ? { credential: observation.credential } : {}),
    ...(observation.credentialSelector ? { credentialSelector: observation.credentialSelector } : {}),
    remaining: normalizedRemaining,
    resetAt: normalizedResetAt,
    observedAt: normalizedObservedAt,
    ...(Number.isInteger(observation.rateLimitedCalls) && observation.rateLimitedCalls > 0
      ? { rateLimitedCalls: observation.rateLimitedCalls } : {}),
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
  // An active exhaustion/secondary-limit window must survive healthy primary
  // quota observations, even when the primary quota resets later.
  if (left.remaining === 0 && right.remaining > 0) return left;
  if (right.remaining === 0 && left.remaining > 0) return right;
  const leftResetAtMs = observationResetAtMs(left);
  const rightResetAtMs = observationResetAtMs(right);
  if (rightResetAtMs > leftResetAtMs) return right;
  if (rightResetAtMs < leftResetAtMs) return left;
  return {
    ...(Math.max(left.rateLimitedCalls || 0, right.rateLimitedCalls || 0) > 0
      ? { rateLimitedCalls: Math.max(left.rateLimitedCalls || 0, right.rateLimitedCalls || 0) } : {}),
    resource: left.resource,
    ...(left.credential ? { credential: left.credential } : {}),
    ...(right.credentialSelector || left.credentialSelector ? { credentialSelector: right.credentialSelector || left.credentialSelector } : {}),
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
    if (legacy) normalized[githubBudgetKey(legacy.resource, legacy.credential)] = legacy;
    return normalized;
  }
  const buckets = value?.buckets && typeof value.buckets === 'object' ? value.buckets : value;
  for (const [key, observation] of Object.entries(buckets)) {
    const normalizedObservation = sanitizeObservation({ resource: key, ...observation }, now);
    if (normalizedObservation) normalized[githubBudgetKey(normalizedObservation.resource, normalizedObservation.credential)] = normalizedObservation;
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
    await handle.writeFile(`${JSON.stringify({ version: 2, buckets: state }, null, 2)}\n`, 'utf8');
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

function extractRateLimitObservation(headers, { observedAt = new Date().toISOString(), resource = DEFAULT_RESOURCE, rateLimited = false } = {}) {
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
  const retryAfter = lookup('retry-after');
  const retryReset = retryAfter == null ? null : /^\d+(?:\.\d+)?$/.test(String(retryAfter).trim())
    ? Date.parse(observedAt) + Number(retryAfter) * 1000 : normalizeTimestamp(retryAfter);
  return normalizeObservation({
    resource: lookup('x-ratelimit-resource') || resource,
    remaining: rateLimited ? 0 : lookup('x-ratelimit-remaining'),
    resetAt: (rateLimited && retryReset) || lookup('x-ratelimit-reset') || retryReset,
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
    // Writers publish complete snapshots by atomic rename. A budget read must
    // not create state directories merely to discover that no record exists.
    const shared = await readStateFile(resolvedSharedStatePath, {
      nowMs: nowMs(),
      readFileImpl,
    });
    inMemoryObservations = mergeObservationMaps(inMemoryObservations, shared, nowMs());
    return inMemoryObservations;
  }

  async function recordRateLimit(observation, rateLimitedOnly = false) {
    rateLimitedOnly ||= observation?.rateLimited === true;
    if (rateLimitedOnly) observation = { ...observation, remaining: 0 };
    let normalized = sanitizeObservation(observation, nowMs());
    if (!rateLimitedOnly && !normalized) return null;
    const resolvedSharedStatePath = resolveSharedStatePathNow();
    return withSharedStateLock(resolvedSharedStatePath, async () => {
      const current = await readStateFile(resolvedSharedStatePath, { nowMs: nowMs(), readFileImpl });
      if (rateLimitedOnly) {
        // Resolve missing-header failures under the lock so simultaneous first
        // failures share one window and increment the same durable counter.
        const resource = normalizeResource(observation.resource);
        const previous = current[githubBudgetKey(resource, observation.credential)];
        normalized = normalized || normalizeObservation({
          ...observation, resource, credential: observation.credential, remaining: 0,
          resetAt: (previous?.remaining === 0 ? previous.resetAt : null) || nowMs() + UNKNOWN_RATE_LIMIT_RESET_MS,
          observedAt: nowMs(),
        });
      }
      const key = githubBudgetKey(normalized.resource, normalized.credential);
      const previous = current[key];
      const count = (previous?.resetAt === normalized.resetAt ? previous.rateLimitedCalls || 0 : 0)
        + (observation.rateLimited === true ? 1 : 0);
      const incoming = count > 0 ? { ...normalized, rateLimitedCalls: count } : normalized;
      const merged = mergeObservationMaps(current, { [key]: incoming }, nowMs());
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
      return merged[key] || null;
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

  async function recordResponseRateLimit(observation) {
    if (observation?.rateLimited) markGitHubRateLimited(observation.resource, observation.credential, observation);
    return recordRateLimit(observation);
  }

  async function recordRateLimitedCall(resource, credential = 'default', observation = null) {
    const recorded = await recordRateLimit({ ...observation, resource, credential, rateLimited: true }, true);
    return markGitHubRateLimited(resource, credential, recorded);
  }

  async function awaitThrottleIfNeeded(resource = DEFAULT_RESOURCE, credential = 'default') {
    const normalizedResource = normalizeResource(resource);
    const key = githubBudgetKey(resource, credential);
    const scope = currentGitHubBudgetScope();
    const limited = scopedGitHubRateLimit(resource, credential, nowMs());
    if (limited) throw new GitHubBudgetDeferredError(limited);
    // Scoped callers must decide independently of another caller's sleep or
    // deferral. Only un-scoped callers share the in-flight wait below.
    if (scope) {
      const floor = resolveThrottleFloor(env, logger);
      const currentObservations = mergeObservationMaps(inMemoryObservations, await readSharedState(), nowMs());
      const current = currentObservations[key] || null;
      if (!current || current.remaining >= floor) return false;
      // Reserve remaining capacity for an already-ready close; zero cannot
      // serve any request, urgent or otherwise.
      if (scope.urgent && current.remaining > 0) return false;
      scope.deferred = true;
      throw new GitHubBudgetDeferredError(current);
    }
    if (activeThrottlePromises.has(key)) {
      return activeThrottlePromises.get(key);
    }
    const activePromise = (async () => {
      try {
        const floor = resolveThrottleFloor(env, logger);
        const currentObservations = mergeObservationMaps(inMemoryObservations, await readSharedState(), nowMs());
        const current = currentObservations[key] || null;
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
            credential,
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
          [key]: sanitizeObservation(currentObservations[key], nowMs()),
        }, nowMs());
        return true;
      } finally {
        activeThrottlePromises.delete(key);
      }
    })();
    activeThrottlePromises.set(key, activePromise);
    return activePromise;
  }

  return {
    awaitThrottleIfNeeded,
    recordResponseRateLimit,
    recordRateLimitedCall,
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

function awaitThrottleIfNeeded(resource, credential) {
  return defaultThrottle.awaitThrottleIfNeeded(resource, credential);
}

function recordResponseRateLimit(observation) {
  return defaultThrottle.recordResponseRateLimit(observation);
}

function readGitHubBudgetState() { return defaultThrottle.readSharedState(); }

function recordRateLimitedCall(resource, credential, observation) { return defaultThrottle.recordRateLimitedCall(resource, credential, observation); }

function readGitHubBudgetStatus({ rootDir = TOOL_ROOT, env = process.env, nowMs = Date.now() } = {}) {
  const sharedStatePath = env.GHO_RATE_LIMIT_SHARED_STATE_PATH || resolve(rootDir, 'data', 'api-cache', 'rate-limit-state.json');
  let buckets = {};
  try { buckets = normalizeObservationMap(JSON.parse(readFileSync(sharedStatePath, 'utf8')), nowMs); }
  catch { /* Status is read-only and unknown evidence is displayed as unknown. */ }
  const credential = githubCredential({ env });
  // Keep every observed credential visible, and resolve the conventional
  // resource fields against the credential used by this runtime.
  buckets = { ...buckets, ...Object.fromEntries(['core', 'graphql'].map(resource =>
    [resource, buckets[githubBudgetKey(resource, credential)]])) };
  return Object.fromEntries([...new Set(['core', 'graphql', ...Object.keys(buckets)])].map(resource => [resource, {
    remaining: buckets[resource]?.remaining ?? null,
    resetAt: buckets[resource]?.resetAt ?? null,
    rateLimitedCalls: buckets[resource]?.rateLimitedCalls || 0,
    ...(buckets[resource]?.credential ? { credential: buckets[resource].credential } : {}),
    ...(buckets[resource]?.credentialSelector ? { credentialSelector: buckets[resource].credentialSelector } : {}),
  }]));
}

export {
  awaitThrottleIfNeeded,
  currentGitHubBudgetScope,
  GitHubBudgetDeferredError,
  isGitHubRateLimitError,
  markGitHubRateLimited,
  githubCredential,
  githubBudgetKey,
  scopedGitHubRateLimit,
  withGitHubBudgetScope,
  readGitHubBudgetState,
  readGitHubBudgetStatus,
  recordRateLimitedCall,
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
