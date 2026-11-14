import { loadAwareTimeoutMs } from './load-aware-timeout.mjs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { readFileSync, statSync } from 'node:fs';
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { recordApiCall } from './api-telemetry.mjs';
import { readBudgetBinding, writeBudgetBinding } from './github-budget-bindings.mjs';

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
// This request deliberately bypasses throttle admission. /rate_limit is free;
// admitting it against the bucket it verifies would recurse into the same wait.
export const rateLimitConfirmation = {
  async read(env) {
    const { readUnthrottledGitHubRateLimit } = await import('./metered-gh.mjs');
    return readUnthrottledGitHubRateLimit(env);
  },
};
const SECONDARY_HISTORY_MS = 15 * 60_000;
// Keep the default instance's clock injectable too, so stubbed transports can
// exercise reset expiry and backoff without waiting on wall time.
export const rateLimitClock = {
  now: () => Date.now(),
  sleep: ms => defaultSleep(ms),
};
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const TOOL_ROOT = dirname(MODULE_DIR);
const DEFAULT_SHARED_STATE_PATH = resolve(TOOL_ROOT, 'data', 'api-cache', 'rate-limit-state.json');

const budgetScopes = new AsyncLocalStorage();
const installationCredentials = new Map();
// Private transport bindings; never serialized or included in telemetry.
const confirmationTokens = new Map();
const missingInstallationBindings = new Map();
const BINDING_MISS_TTL_MS = 1000;

function withGitHubBudgetScope(options, fn) {
  const scope = { urgent: false, rateLimited: false, deferred: false, ...options, limitedBudgets: new Map() };
  return budgetScopes.run(scope, () => fn(scope));
}

function currentGitHubBudgetScope() { return budgetScopes.getStore(); }

// Preserve the parent's observed rate limits: priority never makes exhaustion
// or a secondary limit safe. Only the positive balance below the polling floor
// is reserved for fresh identity and merge-precondition reads.
function withCloserGitHubBudget(fn) {
  const parent = currentGitHubBudgetScope();
  const scope = { rateLimited: false, deferred: false,
    limitedBudgets: new Map(), ...parent, urgent: true };
  return budgetScopes.run(scope, async () => {
    try { return await fn(); }
    finally {
      if (parent) {
        parent.rateLimited ||= scope.rateLimited;
        parent.deferred ||= scope.deferred;
      }
    }
  });
}

// Allowlisted child environments omit store settings, but must still resolve
// the broker's bindings. Inherit only the path, never ambient credentials.
function resolveBudgetBindingStatePath(env) {
  return resolveRateLimitSharedStatePath({
    GHO_RATE_LIMIT_SHARED_STATE_PATH: env.GHO_RATE_LIMIT_SHARED_STATE_PATH
      ?? process.env.GHO_RATE_LIMIT_SHARED_STATE_PATH,
  });
}

// Bindings follow the same proven owner selection as quota observations.
function resolveBudgetBindingDirectory(env = process.env, planOptions = {}) {
  return `${planStateStoreSync(resolveBudgetBindingStatePath(env), planOptions).path}.bindings`;
}

function registerGitHubInstallationToken(token, appId, installationId, { env = process.env, expiresAtMs } = {}) {
  if (!token || !/^\d+$/.test(String(appId)) || !/^\d+$/.test(String(installationId))) return;
  const digest = createHash('sha256').update(String(token)).digest('hex').slice(0, 24);
  installationCredentials.set(digest, `installation-${appId}-${installationId}`);
  writeBudgetBinding(resolveBudgetBindingDirectory(env), digest,
    `installation-${appId}-${installationId}`, expiresAtMs);
  recordApiCall({ category: 'other', status: 'bound', extra: {
    unit: 'credential_binding', credential: `token-${digest}`,
    app: String(appId), installation: String(installationId),
  } });
  while (installationCredentials.size > 256) installationCredentials.delete(installationCredentials.keys().next().value);
}

// Tokens never enter state or logs. A digest isolates credentials without
// depending on which environment-variable alias supplied the token.
function githubCredential({ env = process.env, token = env.GH_TOKEN || env.GITHUB_TOKEN } = {}) {
  // Operator reads without an explicit token must not inherit the daemon's
  // legacy default bucket. Explicit tokens still use their verified identity.
  if (!token) return currentGitHubBudgetScope()?.anonymousCredential || 'default';
  const digest = createHash('sha256').update(String(token)).digest('hex').slice(0, 24);
  confirmationTokens.set(`token-${digest}`, token);
  while (confirmationTokens.size > 256) confirmationTokens.delete(confirmationTokens.keys().next().value);
  const registered = installationCredentials.get(digest);
  if (registered) confirmationTokens.set(registered, token);
  if (registered) return registered;
  const cacheKey = `${resolveBudgetBindingStatePath(env)}:${digest}`;
  const now = Date.now();
  if (missingInstallationBindings.get(cacheKey) > now) return `token-${digest}`;
  const binding = readBudgetBinding(resolveBudgetBindingDirectory(env), digest, now);
  if (binding) {
    missingInstallationBindings.delete(cacheKey);
    confirmationTokens.set(binding, token);
    return binding;
  }
  missingInstallationBindings.set(cacheKey, now + BINDING_MISS_TTL_MS);
  while (missingInstallationBindings.size > 256) {
    missingInstallationBindings.delete(missingInstallationBindings.keys().next().value);
  }
  return `token-${digest}`;
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

function responseHeader(headers, name) {
  if (typeof headers?.get === 'function') return headers.get(name);
  const entry = Object.entries(headers || {}).find(([key]) => key.toLowerCase() === name);
  return entry?.[1] ?? null;
}

// Only an API response envelope is evidence. Process diagnostics and PR/model
// content are deliberately absent, including Error.message and stdout/stderr.
function classifyGitHubRateLimit({ status, headers, data } = {}) {
  status = Number(status);
  if (status !== 403 && status !== 429) return null;
  if (String(responseHeader(headers, 'x-ratelimit-remaining')) === '0') return 'primary';
  const message = typeof data?.message === 'string' ? data.message : '';
  const documented = /^(?:API rate limit exceeded(?: for [^\r\n]+)?\.?|You have exceeded a secondary rate limit\.?(?: Please wait a few minutes before you try again\.)?|You have exceeded a secondary rate limit and have been temporarily blocked from content creation\. Please retry your request again later\.)$/i.test(message)
    || /^https:\/\/docs\.github\.com\/(?:[^#?]+#(?:exceeding-the-rate-limit|about-secondary-rate-limits)|[^?#]*secondary-rate-limits)\/?$/.test(String(data?.documentation_url || ''));
  return status === 429 || responseHeader(headers, 'retry-after') != null || documented ? 'secondary' : null;
}

function isGitHubRateLimitError(err) {
  return err?.budgetDeferred === true || Boolean(err?.githubRateLimitKind)
    || Boolean(classifyGitHubRateLimit({ status: err?.response?.status ?? err?.status ?? err?.statusCode,
      headers: err?.response?.headers, data: err?.response?.data }));
}

function rateLimitErrorObservation(err, options = {}) {
  const kind = err?.githubRateLimitKind || classifyGitHubRateLimit({
    status: err?.response?.status ?? err?.status ?? err?.statusCode, headers: err?.response?.headers, data: err?.response?.data,
  });
  if (!kind) return null;
  if (err?.observation) return { ...err.observation, kind, rateLimited: true };
  return extractRateLimitObservation(err?.response?.headers || {}, {
    ...options, rateLimited: true, kind, status: err?.response?.status ?? err?.status ?? err?.statusCode,
  });
}

// The effective floor for one bucket: the configured floor, capped by a
// fraction of the bucket's observed limit (never below 1, so a zero balance
// still defers). A bucket without a recorded limit keeps the configured floor.
function githubBudgetFloor(observation, configuredFloor = DEFAULT_THROTTLE_FLOOR) {
  const limit = Number(observation?.limit);
  if (!Number.isInteger(limit) || limit <= 0) return configuredFloor;
  return Math.min(configuredFloor, Math.max(1, Math.floor(limit * LIMIT_FLOOR_FRACTION)));
}

function githubBudgetBelowFloor(observation, configuredFloor = DEFAULT_THROTTLE_FLOOR, nowMs = Date.now()) {
  return Boolean(observation) && ((observation.remaining != null && observation.remaining < githubBudgetFloor(observation, configuredFloor))
    || Date.parse(observation.secondaryUntil || '') > nowMs);
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
  const secondaryUntil = normalizeTimestamp(observation.secondaryUntil);
  const normalizedRemaining = Number.parseInt(String(remaining ?? ''), 10);
  const normalizedLimit = Number.parseInt(String(observation.limit ?? ''), 10);
  const normalizedResetAt = normalizeTimestamp(resetAt);
  const normalizedObservedAt = normalizeTimestamp(observedAt);
  if ((!Number.isInteger(normalizedRemaining) || normalizedRemaining < 0) && !secondaryUntil) return null;
  if (!normalizedResetAt || !normalizedObservedAt) return null;
  return {
    resource: normalizeResource(resource),
    ...(observation.credential && observation.credential !== 'default' ? { credential: observation.credential } : {}),
    ...(observation.credentialSelector ? { credentialSelector: observation.credentialSelector } : {}),
    remaining: Number.isInteger(normalizedRemaining) ? normalizedRemaining : null,
    ...(secondaryUntil ? { secondaryUntil, secondaryAttempts: observation.secondaryAttempts || 1 } : {}),
    ...(Number.isInteger(normalizedLimit) && normalizedLimit > 0 ? { limit: normalizedLimit } : {}),
    resetAt: normalizedResetAt,
    observedAt: normalizedObservedAt,
    ...(Number.isInteger(observation.rateLimitedCalls) && observation.rateLimitedCalls > 0
      ? { rateLimitedCalls: observation.rateLimitedCalls } : {}),
    ...(observation.resetUnknown === true && normalizedRemaining === 0 ? { resetUnknown: true } : {}),
    ...(normalizeTimestamp(observation.confirmedAt) ? { confirmedAt: normalizeTimestamp(observation.confirmedAt) } : {}),
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
  const resetAtMs = Math.max(observationResetAtMs(normalized), Date.parse(normalized.secondaryUntil || '') || 0);
  if (!Number.isFinite(resetAtMs) || resetAtMs <= nowMs) {
    // Keep bounded retry history after a cooldown expires. This is not quota
    // evidence and cannot defer admission; it lets the next failed retry use
    // the next exponential step even when no primary headers were supplied.
    if (normalized.secondaryAttempts > 0
      && nowMs - Date.parse(normalized.secondaryUntil || '') < SECONDARY_HISTORY_MS) {
      return { ...normalized, remaining: null };
    }
    return null;
  }
  return normalized;
}

function mergeResourceObservations(current, incoming, nowMs = Date.now()) {
  const left = sanitizeObservation(current, nowMs);
  const right = sanitizeObservation(incoming, nowMs);
  if (!left) return right;
  if (!right) return left;
  // Fresh response headers correct a false zero. Secondary holds are a
  // separate field and survive ordinary primary-budget observations.
  const secondary = Date.parse(left.secondaryUntil || '') > nowMs ? {
    secondaryUntil: left.secondaryUntil, secondaryAttempts: left.secondaryAttempts,
  } : {};
  if (Date.parse(right.secondaryUntil || '') > Date.parse(secondary.secondaryUntil || '1970-01-01')) {
    Object.assign(secondary, { secondaryUntil: right.secondaryUntil, secondaryAttempts: right.secondaryAttempts });
  }
  if (right.remaining == null) return { ...right, ...(left.remaining != null ? {
    remaining: left.remaining, resetAt: left.resetAt, ...(left.limit ? { limit: left.limit } : {}),
  } : {}), ...secondary };
  if (left.remaining == null) return { ...right, ...secondary };
  if ((left.remaining === 0 && right.remaining > 0) || (right.remaining === 0 && left.remaining > 0)) {
    return { ...(observationObservedAtMs(right) >= observationObservedAtMs(left) ? right : left), ...secondary };
  }
  const leftResetAtMs = observationResetAtMs(left);
  const rightResetAtMs = observationResetAtMs(right);
  if (rightResetAtMs > leftResetAtMs) return { ...right, ...secondary };
  if (rightResetAtMs < leftResetAtMs) return { ...left, ...secondary };
  return {
    ...(Math.max(left.rateLimitedCalls || 0, right.rateLimitedCalls || 0) > 0
      ? { rateLimitedCalls: Math.max(left.rateLimitedCalls || 0, right.rateLimitedCalls || 0) } : {}),
    ...([left.confirmedAt, right.confirmedAt].filter(Boolean).sort().at(-1)
      ? { confirmedAt: [left.confirmedAt, right.confirmedAt].filter(Boolean).sort().at(-1) } : {}),
    resource: left.resource,
    ...(left.credential ? { credential: left.credential } : {}),
    ...(right.credentialSelector || left.credentialSelector ? { credentialSelector: right.credentialSelector || left.credentialSelector } : {}),
    remaining: Math.min(left.remaining, right.remaining),
    ...secondary,
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

function extractRateLimitObservation(headers, { observedAt = Date.now(), resource = DEFAULT_RESOURCE,
  rateLimited = false, kind, status, requestCategory = 'other', consumer = process.env.GHO_API_CONSUMER || process.env.GITHUB_REVIEWER_TOKEN_ENV || 'adversarial-review' } = {}) {
  if (!headers) return null;
  const lookup = name => responseHeader(headers, name);
  observedAt = normalizeTimestamp(observedAt);
  const retryAfter = lookup('retry-after');
  let retryAfterMs = retryAfter == null ? null : /^\d+(?:\.\d+)?$/.test(String(retryAfter).trim())
    ? Number(retryAfter) * 1000 : Math.max(0, Date.parse(retryAfter) - Date.parse(observedAt));
  if (!Number.isFinite(retryAfterMs) || retryAfterMs < 0) retryAfterMs = null;
  const remaining = lookup('x-ratelimit-remaining');
  kind ||= rateLimited ? (String(remaining) === '0' ? 'primary' : 'secondary') : null;
  const observation = normalizeObservation({
    resource: lookup('x-ratelimit-resource') || resource,
    remaining, limit: lookup('x-ratelimit-limit'),
    resetAt: lookup('x-ratelimit-reset') || (kind ? Date.parse(observedAt) + (retryAfterMs ?? 60_000) : null),
    ...(kind === 'primary' && !lookup('x-ratelimit-reset') ? { resetUnknown: true } : {}),
    ...(kind === 'secondary' ? { secondaryUntil: Date.parse(observedAt) + (retryAfterMs ?? 60_000) } : {}),
    observedAt,
  });
  if (!observation) return null;
  return { ...observation, rawRateLimitHeaders: Object.fromEntries(
    ['limit', 'remaining', 'used', 'reset', 'resource'].map(name =>
      [`x-ratelimit-${name}`, lookup(`x-ratelimit-${name}`) ?? null])), ...(kind ? { kind, rateLimited: true, retryAfterMs } : {}),
    evidence: { status, requestCategory, consumer,
      headers: Object.fromEntries(['x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-used',
        'x-ratelimit-reset', 'x-ratelimit-resource', 'retry-after'].map(name => [name, lookup(name)])) } };
}

// Bypass our own throttle for this budget-exempt probe. Bind to the exact
// credential used for admission, never a freshly minted or ambient identity.
async function confirmLiveBudget({ credential, resource, env }) {
  const token = confirmationTokens.get(credential)
    || (githubCredential({ env }) === credential ? env.GH_TOKEN || env.GITHUB_TOKEN : null);
  if (!token) throw Object.assign(new Error('confirmation credential unavailable'), { code: 'confirmation-credential-unavailable' });
  // gh owns proxy routing, enterprise transport and the required User-Agent.
  const budgets = await rateLimitConfirmation.read({ ...env, GH_TOKEN: token,
    GITHUB_TOKEN: token, GH_ENTERPRISE_TOKEN: token, GITHUB_ENTERPRISE_TOKEN: token });
  const budget = budgets?.[resource];
  return budget ? { resource, remaining: budget.remaining, limit: budget.limit, resetAt: budget.reset,
    observedAt: new Date().toISOString() } : null;
}

function createRateLimitThrottle({
  env = process.env,
  logger = console,
  nowMs: injectedNowMs,
  sleepImpl: injectedSleepImpl,
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
  storeStatImpl = statImpl,
  confirmBudgetImpl = confirmLiveBudget,
} = {}) {
  const nowMs = injectedNowMs === undefined ? () => rateLimitClock.now() : injectedNowMs;
  const sleepImpl = injectedSleepImpl === undefined ? ms => rateLimitClock.sleep(ms) : injectedSleepImpl;
  // Locks protect real file I/O and compare against filesystem mtime. The
  // default throttle's virtual budget clock must not age or exhaust them.
  // Explicit factory injections still control both clocks for lock tests.
  const lockNowMs = injectedNowMs === undefined ? () => Date.now() : injectedNowMs;
  const lockSleepImpl = injectedSleepImpl === undefined ? defaultSleep : injectedSleepImpl;
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

  async function recordRateLimit(observation, rateLimitedOnly = false, confirmedPrimary = false) {
    rateLimitedOnly ||= observation?.rateLimited === true;
    if (rateLimitedOnly && !observation?.kind) observation = { ...observation,
      kind: observation?.remaining === 0 ? 'primary' : 'secondary' };

    if (observation?.remaining != null && Number(observation.remaining) === 0) recordApiCallImpl?.({
      category: 'other', status: 'exhausted',
      extra: { unit: 'budget_exhaustion', credential: observation.credential || 'default',
        resource: observation.resource || DEFAULT_RESOURCE,
        requestCategory: observation.requestCategory || 'other',
        consumer: currentGitHubBudgetScope()?.consumer,
        rawRateLimitHeaders: observation.rawRateLimitHeaders || null },
    });
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
      if (rateLimitedOnly && observation.kind === 'secondary') {
        const previous = current[githubBudgetKey(observation.resource, observation.credential)];
        const recent = nowMs() - Date.parse(previous?.secondaryUntil || '') < SECONDARY_HISTORY_MS;
        const attempts = (recent ? previous.secondaryAttempts || 0 : 0) + 1;
        const delayMs = observation.retryAfterMs ?? Math.min(300_000, 60_000 * 2 ** Math.min(attempts - 1, 3));
        normalized = normalizeObservation({ ...previous, ...observation,
          remaining: observation.remaining ?? previous?.remaining,
          secondaryUntil: nowMs() + delayMs, secondaryAttempts: attempts,
          resetAt: observation.resetAt || (previous?.remaining != null ? previous.resetAt : null) || nowMs() + delayMs,
          observedAt: nowMs() });
      }
      if (!normalized) return null;
      const prior = current[githubBudgetKey(normalized.resource, normalized.credential)];
      if (!normalized.limit && prior?.limit) normalized.limit = prior.limit;
      const key = githubBudgetKey(normalized.resource, normalized.credential);
      const previous = current[key];
      const secondarySeries = observation.kind === 'secondary'
        && nowMs() - Date.parse(previous?.secondaryUntil || '') < SECONDARY_HISTORY_MS;
      const count = (secondarySeries || previous?.resetAt === normalized.resetAt ? previous?.rateLimitedCalls || 0 : 0)
        + (observation.rateLimited === true ? 1 : 0);
      const incoming = count > 0 ? { ...normalized, rateLimitedCalls: count } : normalized;
      if (rateLimitedOnly) recordApiCallImpl?.({ category: 'github_rate_limit', status: observation.evidence?.status,
        extra: { ...observation.evidence, credential: observation.credential, resource: observation.resource,
          kind: observation.kind, consumer: observation.evidence?.consumer || 'adversarial-review',
          remaining: incoming.remaining, secondaryUntil: incoming.secondaryUntil } });
      const merged = mergeObservationMaps(current, { [key]: incoming }, nowMs());
      // The exempt endpoint is authoritative for primary quota, including a
      // stale positive balance below the polling floor. Ordinary response
      // merging remains conservative about concurrent positive observations.
      const replacesPrimary = confirmedPrimary
        && (!previous || observationObservedAtMs(incoming) >= observationObservedAtMs(previous));
      if (replacesPrimary) merged[key] = { ...merged[key], ...incoming };
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
      if (replacesPrimary) inMemoryObservations[key] = merged[key];
      return merged[key] || null;
    }, {
      mkdirImpl,
      readFileImpl,
      writeFileImpl,
      rmImpl,
      statImpl,
      sleepImpl: lockSleepImpl,
      nowMs: lockNowMs,
    });
  }

  async function recordResponseRateLimit(observation) {
    if (observation?.rateLimited) return recordRateLimitedCall(observation.resource, observation.credential, observation);
    return recordRateLimit(observation);
  }

  async function recordRateLimitedCall(resource, credential = 'default', observation = null, confirmedPrimary = false) {
    // An outer conditional/adapter wrapper may observe the same exception.
    // It must not turn one secondary response into another backoff attempt.
    if (observation?.recorded === true && observation.credential === credential) {
      return markGitHubRateLimited(resource, credential, observation);
    }
    observation = { ...(observation || { observedAt: nowMs() }),
      kind: observation?.kind || (observation?.remaining === 0 ? 'primary' : 'secondary') };
    const recorded = await recordRateLimit({ ...observation, resource, credential, rateLimited: true }, true, confirmedPrimary);
    return recorded ? markGitHubRateLimited(resource, credential, { ...recorded,
      recorded: true, kind: observation.kind, evidence: observation.evidence, retryAfterMs: observation.retryAfterMs,
      resetAt: observation.kind === 'secondary' ? recorded.secondaryUntil : recorded.resetAt }) : null;
  }

  async function confirmedAdmission(resource, credential, key, floor, requestEnv) {
    let current = (await readSharedState())[key] || null;
    if (!githubBudgetBelowFloor(current, floor, nowMs())) return current;
    const primaryLow = current.remaining != null && current.remaining < githubBudgetFloor(current, floor);
    const until = Math.max(primaryLow ? Date.parse(current.resetAt) : 0, Date.parse(current.secondaryUntil || '') || 0);
    if (until - nowMs() <= 120_000) return { ...current, resetAt: new Date(until).toISOString() };
    const recorded = current;
    let live = null;
    let failure = null;
    let confirmedFailureUntil = 0;
    try { live = sanitizeObservation(await confirmBudgetImpl({ credential, resource, env: requestEnv }), nowMs()); }
    catch (err) {
      if (err?.code === 'confirmation-credential-unavailable') throw new GitHubBudgetDeferredError(
        { ...current, resetAt: new Date(nowMs() + 120_000).toISOString() }, { credential });
      const observation = rateLimitErrorObservation(err, { resource: 'core', observedAt: nowMs(),
        requestCategory: 'rate_limit_probe', consumer: env.GHO_API_CONSUMER || env.GITHUB_REVIEWER_TOKEN_ENV || 'adversarial-review' });
      if (observation) {
        // The HTTP probe itself consumes the header's resource (normally core),
        // even when its successful JSON would have confirmed GraphQL quota.
        const failedResource = observation.resource || resource;
        const limited = await recordRateLimitedCall(failedResource, credential, observation, observation.remaining != null);
        current = (await readSharedState())[key] || current;
        failure = { kind: observation.kind, resource: failedResource, ...observation.evidence };
        confirmedFailureUntil = observation.kind === 'secondary' ? Date.parse(limited?.secondaryUntil || '')
          : failedResource === resource ? Date.parse(limited?.resetAt || '') : 0;
      }
    }
    recordApiCallImpl?.({ category: 'github_budget_confirmation', extra: { credential, resource,
      recorded, live, ...(failure ? { failure } : {}), consumer: 'adversarial-review' } });
    if (live) {
      await recordRateLimit({ ...live, credential }, false, true);
      current = (await readSharedState())[key];
      if (!githubBudgetBelowFloor(current, floor, nowMs())) return current;
      // A successful probe confirms primary quota only, never secondary state.
      const confirmedUntil = Math.max(current.remaining < githubBudgetFloor(current, floor) ? Date.parse(current.resetAt) : 0,
        Date.parse(current.secondaryUntil || '') || 0);
      return { ...current, resetAt: new Date(confirmedUntil).toISOString() };
    }
    // Unknown live evidence cannot justify an hour-long self-imposed hold.
    // A structured quota refusal from the probe is fresh evidence: retain its
    // primary reset or explicit secondary cooldown, including long Retry-After.
    const fallbackUntil = confirmedFailureUntil > nowMs() ? confirmedFailureUntil : nowMs() + 120_000;
    return { ...current, resetAt: new Date(Math.max(fallbackUntil,
      Date.parse(current.secondaryUntil || '') || 0)).toISOString() };
  }

  async function awaitThrottleIfNeeded(resource = DEFAULT_RESOURCE, credential = 'default', { env: requestEnv = env } = {}) {
    const normalizedResource = normalizeResource(resource);
    const key = githubBudgetKey(resource, credential);
    const scope = currentGitHubBudgetScope();
    const limited = scopedGitHubRateLimit(resource, credential, nowMs());
    if (limited) {
      const error = new GitHubBudgetDeferredError(limited, { credential });
      if (scope) scope.budgetDeferral = error;
      throw error;
    }
    // An operator safety action (a no-merge hold or release) is one call an
    // operator is waiting on. The polling floor reserves throughput; it must
    // never starve or silently sleep that call (NOMERGEHOLDHANG-01). GitHub
    // itself still refuses a truly exhausted call, fast and metered.
    if (scope?.operatorSafety) return false;
    // Scoped callers must decide independently of another caller's sleep or
    // deferral. Only un-scoped callers share the in-flight wait below.
    if (scope) {
      const floor = resolveThrottleFloor(env, logger);
      const current = await confirmedAdmission(resource, credential, key, floor, requestEnv);
      // An unknown bucket admits: unknown is not low.
      if (!githubBudgetBelowFloor(current, floor, nowMs())) return false;
      // Reserve remaining capacity for an already-ready close; zero cannot
      // serve any request, urgent or otherwise.
      if (scope.urgent && current.remaining > 0 && !(Date.parse(current.secondaryUntil || '') > nowMs())) return false;
      scope.deferred = true;
      const error = new GitHubBudgetDeferredError(current, { credential, floor: githubBudgetFloor(current, floor) });
      scope.budgetDeferral = error;
      throw error;
    }
    if (activeThrottlePromises.has(key)) {
      return activeThrottlePromises.get(key);
    }
    const activePromise = (async () => {
      try {
        const configuredFloor = resolveThrottleFloor(env, logger);
        const current = await confirmedAdmission(resource, credential, key, configuredFloor, requestEnv);
        if (!githubBudgetBelowFloor(current, configuredFloor, nowMs())) return false;
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
          [key]: sanitizeObservation(current, nowMs()),
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
    readConfirmedBudget: (resource, credential) => confirmedAdmission(resource, credential, githubBudgetKey(resource, credential), resolveThrottleFloor(env, logger)),
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

function awaitThrottleIfNeeded(resource, credential, options) {
  return defaultThrottle.awaitThrottleIfNeeded(resource, credential, options);
}

function recordResponseRateLimit(observation) {
  return defaultThrottle.recordResponseRateLimit(observation);
}

function readGitHubBudgetState() { return defaultThrottle.readSharedState(); }
function readConfirmedGitHubBudget(resource, credential) { return defaultThrottle.readConfirmedBudget(resource, credential); }

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
  const credential = githubCredential({ env: { ...env,
    GHO_RATE_LIMIT_SHARED_STATE_PATH: statusSharedStatePath({ rootDir, env }) } });
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
  resolveBudgetBindingDirectory,
  registerGitHubInstallationToken,
  withCloserGitHubBudget,
  awaitThrottleIfNeeded,
  currentGitHubBudgetScope,
  GitHubBudgetDeferredError,
  isGitHubRateLimitError,
  classifyGitHubRateLimit,
  rateLimitErrorObservation,
  markGitHubRateLimited,
  githubBudgetBelowFloor,
  githubBudgetFloor,
  githubCredential,
  githubBudgetKey,
  scopedGitHubRateLimit,
  withGitHubBudgetScope,
  readGitHubBudgetState,
  readConfirmedGitHubBudget,
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
