import { loadAwareTimeoutMs } from './load-aware-timeout.mjs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { readFileSync, statSync } from 'node:fs';
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { recordApiCall } from './api-telemetry.mjs';

const DEFAULT_THROTTLE_FLOOR = 200;
// A floor may never exceed what a bucket can hold. The anonymous quota (limit
// 60) can never reach a 200 floor, so an uncapped floor deferred every
// anonymous admission until reset, then again on the next observation
// (WATCHERANONBUCKET-01). This fraction of the observed limit caps the floor.
const LIMIT_FLOOR_FRACTION = 0.1;
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

// The effective floor for one bucket: the configured floor, capped by a
// fraction of the bucket's observed limit (never below 1, so a zero balance
// still defers). A bucket without a recorded limit keeps the configured floor.
function githubBudgetFloor(observation, configuredFloor = DEFAULT_THROTTLE_FLOOR) {
  const limit = Number(observation?.limit);
  if (!Number.isInteger(limit) || limit <= 0) return configuredFloor;
  return Math.min(configuredFloor, Math.max(1, Math.floor(limit * LIMIT_FLOOR_FRACTION)));
}

function githubBudgetBelowFloor(observation, configuredFloor = DEFAULT_THROTTLE_FLOOR) {
  return Boolean(observation) && observation.remaining < githubBudgetFloor(observation, configuredFloor);
}

// The message names the bucket that deferred (`default`, `token-<digest>`,
// `adapter:<selector>`), so an operator can tell an anonymous deferral from a
// genuinely low authenticated one. Tokens never appear: only their digest key.
class GitHubBudgetDeferredError extends Error {
  constructor(observation, { credential = observation?.credential || 'default', floor = null } = {}) {
    observation = { ...observation, resetAt: normalizeTimestamp(observation.resetAt)
      || new Date(Date.now() + UNKNOWN_RATE_LIMIT_RESET_MS).toISOString() };
    const balance = Number.isInteger(observation.remaining)
      ? `; remaining=${observation.remaining}${Number.isInteger(observation.limit) ? `/${observation.limit}` : ''}` : '';
    super(`GitHub ${observation.resource} budget deferred until ${observation.resetAt} `
      + `(credential=${credential}${balance}${Number.isInteger(floor) ? `; floor=${floor}` : ''})`);
    this.name = 'GitHubBudgetDeferredError';
    this.rateLimited = true;
    this.budgetDeferred = true;
    this.credential = credential;
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
  const normalizedLimit = Number.parseInt(String(observation.limit ?? ''), 10);
  const normalizedResetAt = normalizeTimestamp(resetAt);
  const normalizedObservedAt = normalizeTimestamp(observedAt);
  if (!Number.isInteger(normalizedRemaining) || normalizedRemaining < 0) return null;
  if (!normalizedResetAt || !normalizedObservedAt) return null;
  return {
    resource: normalizeResource(resource),
    ...(observation.credential && observation.credential !== 'default' ? { credential: observation.credential } : {}),
    ...(observation.credentialSelector ? { credentialSelector: observation.credentialSelector } : {}),
    remaining: normalizedRemaining,
    ...(Number.isInteger(normalizedLimit) && normalizedLimit > 0 ? { limit: normalizedLimit } : {}),
    resetAt: normalizedResetAt,
    observedAt: normalizedObservedAt,
    ...(Number.isInteger(observation.rateLimitedCalls) && observation.rateLimitedCalls > 0
      ? { rateLimitedCalls: observation.rateLimitedCalls } : {}),
    ...(observation.resetUnknown === true && normalizedRemaining === 0 ? { resetUnknown: true } : {}),
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
  // quota observations, even when the primary quota resets later. A window
  // whose reset was only guessed (a headerless failure) is the exception: a
  // newer healthy observation of the same credential and resource replaces it,
  // so a recovered budget is not held for the guessed duration. Callers pass
  // (older, newer).
  if (left.remaining === 0 && right.remaining > 0) return left.resetUnknown === true ? right : left;
  if (right.remaining === 0 && left.remaining > 0) {
    return { ...right, ...(left.limit && !right.limit ? { limit: left.limit } : {}) };
  }
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
    ...(right.limit || left.limit ? { limit: right.limit || left.limit } : {}),
    ...(left.resetUnknown === true && right.resetUnknown === true ? { resetUnknown: true } : {}),
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

// GHSTATEOWNER-01. The store is written 0600, so it is private to the uid
// that wrote it, while the deployed directory may be group-writable to several
// owners. Each read is classified: `missing` (ENOENT) is the only state that
// means "no observations"; `unreadable` (EACCES, EPERM or any other read
// error) means the observations are unknown; `malformed` means the document
// holds no usable observation. Contents never enter the classification.
function classifyStateText(path, text, nowMs) {
  try {
    return { path, status: 'ok', buckets: normalizeObservationMap(JSON.parse(text), nowMs) };
  } catch {
    return { path, status: 'malformed', buckets: {} };
  }
}

function classifyStateReadError(path, err) {
  if (err?.code === 'ENOENT') return { path, status: 'missing', buckets: {} };
  return { path, status: 'unreadable', code: err?.code || 'EUNKNOWN', buckets: {} };
}

async function readStateEvidence(path, { nowMs = Date.now(), readFileImpl = readFile } = {}) {
  let text;
  try { text = await readFileImpl(path, 'utf8'); } catch (err) { return classifyStateReadError(path, err); }
  return classifyStateText(path, text, nowMs);
}

function readStateEvidenceSync(path, { nowMs = Date.now(), readFileSyncImpl = readFileSync } = {}) {
  let text;
  try { text = readFileSyncImpl(path, 'utf8'); } catch (err) { return classifyStateReadError(path, err); }
  return classifyStateText(path, text, nowMs);
}

function summarizeStateEvidence(evidence) {
  if (!evidence) return undefined;
  return { path: evidence.path, status: evidence.status, ...(evidence.code ? { code: evidence.code } : {}) };
}

function defaultGetuid() {
  return typeof process.getuid === 'function' ? process.getuid() : null;
}

// An owner-scoped sibling of the shared store, keyed by the caller's numeric
// uid. The uid comes from process metadata, never from a credential.
function ownerScopedStatePath(sharedStatePath, uid) {
  return `${String(sharedStatePath).replace(/\.json$/, '')}.uid-${uid}.json`;
}

// The shared store belongs to the uid that owns the file or, before the file
// exists, the uid that owns its directory. Every other caller keeps its
// observations in its own owner-scoped store and never writes the shared one:
// a rename would replace evidence it could not read with a snapshot its owner
// cannot read. Ownership that cannot be proven is treated as foreign. A
// platform without uids (or a stat without one) keeps the shared store.
function planStoreFromOwner(sharedStatePath, uid, owner) {
  const shared = { path: sharedStatePath, scope: 'shared', sharedStatePath, uid, sharedOwnerUid: owner.uid ?? null };
  if (!Number.isInteger(uid) || owner.missing) return shared;
  if (owner.error) return { ...shared, path: ownerScopedStatePath(sharedStatePath, uid), scope: 'owner' };
  if (!Number.isInteger(owner.uid) || owner.uid === uid) return shared;
  return { ...shared, path: ownerScopedStatePath(sharedStatePath, uid), scope: 'owner' };
}

async function planStateStore(sharedStatePath, { getuidImpl = defaultGetuid, storeStatImpl = stat } = {}) {
  const uid = getuidImpl();
  if (!Number.isInteger(uid)) return planStoreFromOwner(sharedStatePath, uid, { missing: true });
  for (const candidate of [sharedStatePath, dirname(sharedStatePath)]) {
    try {
      return planStoreFromOwner(sharedStatePath, uid, { uid: (await storeStatImpl(candidate))?.uid });
    } catch (err) {
      if (err?.code !== 'ENOENT') return planStoreFromOwner(sharedStatePath, uid, { error: err?.code || 'EUNKNOWN' });
    }
  }
  return planStoreFromOwner(sharedStatePath, uid, { missing: true });
}

function planStateStoreSync(sharedStatePath, { getuidImpl = defaultGetuid, storeStatSyncImpl = statSync } = {}) {
  const uid = getuidImpl();
  if (!Number.isInteger(uid)) return planStoreFromOwner(sharedStatePath, uid, { missing: true });
  for (const candidate of [sharedStatePath, dirname(sharedStatePath)]) {
    try {
      return planStoreFromOwner(sharedStatePath, uid, { uid: storeStatSyncImpl(candidate)?.uid });
    } catch (err) {
      if (err?.code !== 'ENOENT') return planStoreFromOwner(sharedStatePath, uid, { error: err?.code || 'EUNKNOWN' });
    }
  }
  return planStoreFromOwner(sharedStatePath, uid, { missing: true });
}

// Merge the caller's own store with the shared store it does not own. A
// readable foreign shared store still contributes; observation merge is
// conservative, and buckets stay keyed by credential digest.
function combineStoreEvidence(plan, own, shared, nowMs) {
  return {
    scope: plan.scope,
    uid: plan.uid ?? null,
    sharedOwnerUid: plan.sharedOwnerUid,
    path: plan.path,
    store: summarizeStateEvidence(own),
    ...(shared ? { shared: summarizeStateEvidence(shared) } : {}),
    buckets: shared ? mergeObservationMaps(shared.buckets, own.buckets, nowMs) : own.buckets,
  };
}

async function readStoreEvidence(sharedStatePath, { nowMs = Date.now(), readFileImpl = readFile, ...planOptions } = {}) {
  const plan = await planStateStore(sharedStatePath, planOptions);
  const own = await readStateEvidence(plan.path, { nowMs, readFileImpl });
  const shared = plan.scope === 'owner' ? await readStateEvidence(sharedStatePath, { nowMs, readFileImpl }) : null;
  return combineStoreEvidence(plan, own, shared, nowMs);
}

function readStoreEvidenceSync(sharedStatePath, { nowMs = Date.now(), readFileSyncImpl = readFileSync, ...planOptions } = {}) {
  const plan = planStateStoreSync(sharedStatePath, planOptions);
  const own = readStateEvidenceSync(plan.path, { nowMs, readFileSyncImpl });
  const shared = plan.scope === 'owner' ? readStateEvidenceSync(sharedStatePath, { nowMs, readFileSyncImpl }) : null;
  return combineStoreEvidence(plan, own, shared, nowMs);
}

function storeEvidenceSummary(evidence) {
  return Object.fromEntries(Object.entries(evidence).filter(([key]) => key !== 'buckets'));
}

function storeUnreadableError(evidence) {
  return Object.assign(new Error(`GitHub budget store unreadable (${evidence.code}) at ${evidence.path}; `
    + 'refusing to replace observations that could not be read (GHSTATEOWNER-01)'), {
    code: 'GITHUB_BUDGET_STORE_UNREADABLE', storeCode: evidence.code, storePath: evidence.path,
  });
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
  const timeoutMs = loadAwareTimeoutMs(LOCK_TIMEOUT_MS);
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
      if ((nowMs() - startedAt) >= timeoutMs) {
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
    limit: lookup('x-ratelimit-limit'),
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
  getuidImpl = defaultGetuid,
  storeStatImpl = stat,
} = {}) {
  let inMemoryObservations = {};
  const activeThrottlePromises = new Map();
  const reportedStoreFaults = new Set();

  function resolveSharedStatePathNow() {
    return sharedStatePath || resolveRateLimitSharedStatePath(env);
  }

  function resolveStorePlan() {
    return planStateStore(resolveSharedStatePathNow(), { getuidImpl, storeStatImpl });
  }

  // The caller's own store failing is a fault worth one warning per process.
  // A foreign shared store the caller cannot read is the designed owner
  // boundary; it is reported through readBudgetStoreEvidence, not logged.
  function reportOwnStoreFault(store) {
    if (!store || !['unreadable', 'malformed'].includes(store.status)) return;
    const fault = `${store.path}\0${store.status}\0${store.code || ''}`;
    if (reportedStoreFaults.has(fault)) return;
    reportedStoreFaults.add(fault);
    logger.warn?.(`[rate-limit-throttle] GitHub budget store ${store.status}${store.code ? ` (${store.code})` : ''} `
      + `at ${store.path}; its observations are unknown, not absent (GHSTATEOWNER-01)`);
  }

  async function readBudgetStoreEvidence() {
    // Writers publish complete snapshots by atomic rename. A budget read must
    // not create state directories merely to discover that no record exists.
    const evidence = await readStoreEvidence(resolveSharedStatePathNow(), {
      nowMs: nowMs(), readFileImpl, getuidImpl, storeStatImpl,
    });
    reportOwnStoreFault(evidence.store);
    return evidence;
  }

  async function readSharedState() {
    const { buckets } = await readBudgetStoreEvidence();
    inMemoryObservations = mergeObservationMaps(inMemoryObservations, buckets, nowMs());
    return inMemoryObservations;
  }

  async function recordRateLimit(observation, rateLimitedOnly = false) {
    rateLimitedOnly ||= observation?.rateLimited === true;
    if (rateLimitedOnly) observation = { ...observation, remaining: 0 };
    let normalized = sanitizeObservation(observation, nowMs());
    if (!rateLimitedOnly && !normalized) return null;
    // Only the caller's own store is locked and written (GHSTATEOWNER-01).
    const { path: storePath } = await resolveStorePlan();
    return withSharedStateLock(storePath, async () => {
      const read = await readStateEvidence(storePath, { nowMs: nowMs(), readFileImpl });
      // Never rename over observations that could not be read: the merged
      // snapshot would silently drop them, including active zero-balance holds.
      if (read.status === 'unreadable') {
        reportOwnStoreFault(read);
        throw storeUnreadableError(read);
      }
      const current = read.buckets;
      if (rateLimitedOnly) {
        // Resolve missing-header failures under the lock so simultaneous first
        // failures share one window and increment the same durable counter.
        const resource = normalizeResource(observation.resource);
        const previous = current[githubBudgetKey(resource, observation.credential)];
        const reused = previous?.remaining === 0 ? previous : null;
        normalized = normalized || normalizeObservation({
          ...observation, resource, credential: observation.credential, remaining: 0,
          resetAt: reused?.resetAt || nowMs() + UNKNOWN_RATE_LIMIT_RESET_MS,
          resetUnknown: reused ? reused.resetUnknown === true : true,
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
        await writeStateFile(storePath, merged, {
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
    if (limited) throw new GitHubBudgetDeferredError(limited, { credential });
    // Scoped callers must decide independently of another caller's sleep or
    // deferral. Only un-scoped callers share the in-flight wait below.
    if (scope) {
      const floor = resolveThrottleFloor(env, logger);
      const currentObservations = mergeObservationMaps(inMemoryObservations, await readSharedState(), nowMs());
      const current = currentObservations[key] || null;
      // An unknown bucket admits: unknown is not low.
      if (!githubBudgetBelowFloor(current, floor)) return false;
      // Reserve remaining capacity for an already-ready close; zero cannot
      // serve any request, urgent or otherwise.
      if (scope.urgent && current.remaining > 0) return false;
      scope.deferred = true;
      throw new GitHubBudgetDeferredError(current, { credential, floor: githubBudgetFloor(current, floor) });
    }
    if (activeThrottlePromises.has(key)) {
      return activeThrottlePromises.get(key);
    }
    const activePromise = (async () => {
      try {
        const configuredFloor = resolveThrottleFloor(env, logger);
        const currentObservations = mergeObservationMaps(inMemoryObservations, await readSharedState(), nowMs());
        const current = currentObservations[key] || null;
        if (!githubBudgetBelowFloor(current, configuredFloor)) return false;
        const floor = githubBudgetFloor(current, configuredFloor);
        const waitMs = Math.max(0, observationResetAtMs(current) - nowMs());
        // The status file sits beside the caller's own store.
        const { path: resolvedSharedStatePath } = await resolveStorePlan();
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
            credential,
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
    readBudgetStoreEvidence,
    resolveSharedStatePath: () => resolveSharedStatePathNow(),
    resolveThrottleFloor: () => resolveThrottleFloor(env, logger),
    __test__: {
      mergeObservationMaps,
      mergeObservations: mergeResourceObservations,
      normalizeObservation,
      normalizeObservationMap,
      readStateFile: async () => (await readBudgetStoreEvidence()).buckets,
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

function statusSharedStatePath({ rootDir = TOOL_ROOT, env = process.env } = {}) {
  return env.GHO_RATE_LIMIT_SHARED_STATE_PATH || resolve(rootDir, 'data', 'api-cache', 'rate-limit-state.json');
}

// Synchronous owner-aware bucket read for `meteredExecFileSync` and status.
function readGitHubBudgetBucketsSync({ env = process.env, nowMs = Date.now(), sharedStatePath, ...seams } = {}) {
  return readStoreEvidenceSync(sharedStatePath || resolveRateLimitSharedStatePath(env), { nowMs, ...seams }).buckets;
}

// Which store this runtime reads and writes, and whether each was readable.
// Status is read-only: an unreadable store is reported here instead of being
// displayed as an empty budget (GHSTATEOWNER-01).
function readGitHubBudgetStoreStatus({ rootDir = TOOL_ROOT, env = process.env, nowMs = Date.now(), ...seams } = {}) {
  return storeEvidenceSummary(readStoreEvidenceSync(statusSharedStatePath({ rootDir, env }), { nowMs, ...seams }));
}

function readGitHubBudgetStatus({ rootDir = TOOL_ROOT, env = process.env, nowMs = Date.now(), ...seams } = {}) {
  // Unknown or unreadable evidence is displayed as unknown; the store status
  // (readGitHubBudgetStoreStatus) says which.
  let { buckets } = readStoreEvidenceSync(statusSharedStatePath({ rootDir, env }), { nowMs, ...seams });
  const credential = githubCredential({ env });
  // Keep every observed credential visible, and resolve the conventional
  // resource fields against the credential used by this runtime.
  buckets = { ...buckets, ...Object.fromEntries(['core', 'graphql'].map(resource =>
    [resource, buckets[githubBudgetKey(resource, credential)]])) };
  return Object.fromEntries([...new Set(['core', 'graphql', ...Object.keys(buckets)])].map(resource => [resource, {
    remaining: buckets[resource]?.remaining ?? null,
    ...(buckets[resource]?.limit ? { limit: buckets[resource].limit } : {}),
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
  githubBudgetBelowFloor,
  githubBudgetFloor,
  githubCredential,
  githubBudgetKey,
  scopedGitHubRateLimit,
  withGitHubBudgetScope,
  readGitHubBudgetState,
  readGitHubBudgetBucketsSync,
  readGitHubBudgetStatus,
  readGitHubBudgetStoreStatus,
  ownerScopedStatePath,
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
