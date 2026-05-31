import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, join, resolve } from 'node:path';
import fsExt from 'fs-ext';
import { writeFileAtomic } from './atomic-write.mjs';

const {
  flockSync,
  constants: {
    LOCK_EX,
    LOCK_NB,
    LOCK_SH,
    LOCK_UN,
  },
} = fsExt;

const REVIEWER_FENCE_SCHEMA_VERSION = 1;
const DEFAULT_SIGTERM_FENCE_GRACE_SECONDS = 30;
const MAX_SIGTERM_FENCE_GRACE_SECONDS = 90;
const DEFAULT_FENCE_STALE_TTL_SECONDS = 90;
const EXIT_TIMEOUT_SAFETY_SECONDS = 15;
const REVIEWER_FENCE_DIR_NAME = 'reviewer-fences';
const SPAWN_RECORDS_FILENAME = 'spawn-records.json';
const SPAWN_RECORDS_DIRNAME = 'spawn-records';
const CLEANUP_QUEUE_DIRNAME = 'cleanup-jobs';
const AUDIT_DIRNAME = 'audit';
const QUARANTINE_DIRNAME = 'quarantine';

function resolveAdversarialReviewStateDir(rootDir, env = process.env) {
  const configured = String(env.ADVERSARIAL_REVIEW_STATE_DIR || '').trim();
  if (configured) {
    return resolve(configured);
  }
  return resolve(rootDir, 'data');
}

function resolveReviewerFenceDir(stateDir) {
  return join(stateDir, REVIEWER_FENCE_DIR_NAME);
}

function ensureReviewerFenceDir(stateDir) {
  const dirPath = resolveReviewerFenceDir(stateDir);
  mkdirSync(dirPath, { recursive: true, mode: 0o700 });
  return dirPath;
}

function resolveFencePaths(stateDir, spawnToken) {
  const fenceDir = ensureReviewerFenceDir(stateDir);
  return {
    fenceDir,
    jsonPath: join(fenceDir, `${spawnToken}.json`),
    lockPath: join(fenceDir, `${spawnToken}.lock`),
  };
}

function normalizeFenceSpawnToken(spawnToken) {
  return spawnToken == null || spawnToken === '' ? randomUUID() : String(spawnToken);
}

function resolveCleanupQueueDir(stateDir) {
  const dirPath = join(ensureReviewerFenceDir(stateDir), CLEANUP_QUEUE_DIRNAME);
  mkdirSync(dirPath, { recursive: true, mode: 0o700 });
  return dirPath;
}

function resolveFenceAuditDir(stateDir) {
  const dirPath = join(ensureReviewerFenceDir(stateDir), AUDIT_DIRNAME);
  mkdirSync(dirPath, { recursive: true, mode: 0o700 });
  return dirPath;
}

function resolveFenceQuarantineDir(stateDir) {
  const dirPath = join(ensureReviewerFenceDir(stateDir), QUARANTINE_DIRNAME);
  mkdirSync(dirPath, { recursive: true, mode: 0o700 });
  return dirPath;
}

function resolveSpawnRecordPath(stateDir) {
  return join(ensureReviewerFenceDir(stateDir), SPAWN_RECORDS_FILENAME);
}

function resolveSpawnRecordDir(stateDir) {
  const dirPath = join(ensureReviewerFenceDir(stateDir), SPAWN_RECORDS_DIRNAME);
  mkdirSync(dirPath, { recursive: true, mode: 0o700 });
  return dirPath;
}

function resolveSpawnRecordEntryPath(stateDir, spawnToken) {
  return join(resolveSpawnRecordDir(stateDir), `${spawnToken}.json`);
}

function parsePositiveIntegerEnv(rawValue, {
  envName,
  fallback,
  min = 1,
  max = Number.MAX_SAFE_INTEGER,
  logKey = 'fence_config_invalid',
} = {}) {
  const rawText = rawValue === undefined ? null : String(rawValue).trim();
  const parsed = rawValue === undefined ? fallback : Number(rawText);
  if (
    !Number.isInteger(parsed) ||
    (rawText !== null && String(parsed) !== rawText) ||
    parsed < min ||
    parsed > max
  ) {
    const err = new Error(`${envName} must be an integer in [${min}, ${max}]; got ${JSON.stringify(rawValue)}`);
    err.logKey = logKey;
    throw err;
  }
  return parsed;
}

function resolveSigtermFenceMode(env = process.env) {
  return String(env.ADVERSARIAL_REVIEW_SIGTERM_FENCE || 'on').trim().toLowerCase() === 'off'
    ? 'off'
    : 'on';
}

function resolveSigtermFenceGraceSeconds(env = process.env) {
  return parsePositiveIntegerEnv(env.ADVERSARIAL_REVIEW_SIGTERM_FENCE_GRACE_SECONDS, {
    envName: 'ADVERSARIAL_REVIEW_SIGTERM_FENCE_GRACE_SECONDS',
    fallback: DEFAULT_SIGTERM_FENCE_GRACE_SECONDS,
    min: 1,
    max: MAX_SIGTERM_FENCE_GRACE_SECONDS,
  });
}

function resolveFenceStaleTtlSeconds(env = process.env) {
  return parsePositiveIntegerEnv(env.ADVERSARIAL_REVIEW_FENCE_STALE_TTL_SECONDS, {
    envName: 'ADVERSARIAL_REVIEW_FENCE_STALE_TTL_SECONDS',
    fallback: DEFAULT_FENCE_STALE_TTL_SECONDS,
    min: 1,
    max: 24 * 60 * 60,
  });
}

function validateFenceConfig(env = process.env) {
  const graceSeconds = resolveSigtermFenceGraceSeconds(env);
  const staleTtlSeconds = resolveFenceStaleTtlSeconds(env);
  if (staleTtlSeconds < (2 * graceSeconds)) {
    const err = new Error(
      `ADVERSARIAL_REVIEW_FENCE_STALE_TTL_SECONDS=${staleTtlSeconds} must be >= 2 * ` +
      `ADVERSARIAL_REVIEW_SIGTERM_FENCE_GRACE_SECONDS=${graceSeconds}`
    );
    err.logKey = 'fence_config_invalid';
    throw err;
  }
  return { graceSeconds, staleTtlSeconds };
}

function parseExitTimeOutFromPlist(plistText) {
  const match = String(plistText || '').match(/<key>\s*ExitTimeOut\s*<\/key>\s*<integer>\s*(\d+)\s*<\/integer>/i);
  if (!match) return null;
  return Number.parseInt(match[1], 10);
}

function resolveWatcherPlistPath(env = process.env) {
  const configured = String(env.ADVERSARIAL_REVIEW_WATCHER_PLIST_PATH || '').trim();
  return configured ? resolve(configured) : null;
}

function validateWatcherExitTimeout(env = process.env, {
  readFileImpl = readFileSync,
} = {}) {
  const result = inspectWatcherExitTimeout(env, { readFileImpl });
  if (!result.ok) {
    const err = new Error(result.warning);
    err.logKey = 'plist_exit_timeout_below_grace';
    throw err;
  }
  return result;
}

function inspectWatcherExitTimeout(env = process.env, {
  readFileImpl = readFileSync,
} = {}) {
  const { graceSeconds } = validateFenceConfig(env);
  const requiredExitTimeoutSeconds = graceSeconds + EXIT_TIMEOUT_SAFETY_SECONDS;
  const plistPath = resolveWatcherPlistPath(env);
  if (!plistPath) {
    return {
      ok: false,
      plistPath: null,
      exitTimeoutSeconds: null,
      requiredExitTimeoutSeconds,
      warning: 'ADVERSARIAL_REVIEW_WATCHER_PLIST_PATH is unset; watcher will continue but cannot self-validate ExitTimeOut',
    };
  }
  let exitTimeoutSeconds = null;
  try {
    exitTimeoutSeconds = parseExitTimeOutFromPlist(readFileImpl(plistPath, 'utf8'));
  } catch (err) {
    return {
      ok: false,
      plistPath,
      exitTimeoutSeconds: null,
      requiredExitTimeoutSeconds,
      warning: `Failed to read ${plistPath} for ExitTimeOut validation: ${err?.message || err}`,
    };
  }
  if (!Number.isInteger(exitTimeoutSeconds) || exitTimeoutSeconds < requiredExitTimeoutSeconds) {
    return {
      ok: false,
      plistPath,
      exitTimeoutSeconds,
      requiredExitTimeoutSeconds,
      warning: `ExitTimeOut=${exitTimeoutSeconds ?? 'missing'} in ${plistPath} should be >= ${requiredExitTimeoutSeconds}`,
    };
  }
  return {
    ok: true,
    plistPath,
    exitTimeoutSeconds,
    requiredExitTimeoutSeconds,
  };
}

function buildFenceRecord({
  spawnToken = randomUUID(),
  repo = null,
  pr,
  identity,
  openedAt = new Date().toISOString(),
  expectedClearBy,
} = {}) {
  return {
    schemaVersion: REVIEWER_FENCE_SCHEMA_VERSION,
    spawnToken,
    repo,
    pr,
    identity,
    openedAt,
    expectedClearBy,
  };
}

function appendFenceAuditEvent(stateDir, event) {
  const ts = String(event?.ts || new Date().toISOString());
  const month = ts.slice(0, 7);
  const filePath = join(resolveFenceAuditDir(stateDir), `${month}.jsonl`);
  const line = `${JSON.stringify({
    schemaVersion: REVIEWER_FENCE_SCHEMA_VERSION,
    ts,
    ...event,
  })}\n`;
  const fd = openSync(filePath, 'a', 0o640);
  try {
    writeFileSync(fd, line, 'utf8');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function openReviewerFence({
  stateDir,
  spawnToken = randomUUID(),
  repo = null,
  pr,
  identity,
  graceSeconds = DEFAULT_SIGTERM_FENCE_GRACE_SECONDS,
  openedAt = new Date().toISOString(),
  auditEventWriter = appendFenceAuditEvent,
} = {}) {
  spawnToken = normalizeFenceSpawnToken(spawnToken);
  const { jsonPath, lockPath } = resolveFencePaths(stateDir, spawnToken);
  const expectedClearBy = new Date(Date.parse(openedAt) + (graceSeconds * 1000)).toISOString();
  const lockFd = openSync(lockPath, 'w', 0o600);
  try {
    flockSync(lockFd, LOCK_EX | LOCK_NB);
  } catch (err) {
    closeSync(lockFd);
    throw err;
  }
  const record = buildFenceRecord({
    spawnToken,
    repo,
    pr,
    identity,
    openedAt,
    expectedClearBy,
  });
  try {
    writeFileAtomic(jsonPath, `${JSON.stringify(record, null, 2)}\n`);
    auditEventWriter(stateDir, {
      event: 'fence_open',
      spawnToken,
      repo,
      pr,
      identity,
      openedAt,
      expectedClearBy,
    });
  } catch (err) {
    try {
      auditEventWriter(stateDir, {
        event: 'fence_open_rolled_back',
        spawnToken,
        repo,
        pr,
        identity,
        openedAt,
        expectedClearBy,
        error: err?.message || String(err),
      });
    } catch {}
    try {
      flockSync(lockFd, LOCK_UN);
    } catch {}
    try {
      closeSync(lockFd);
    } catch {}
    rmSync(lockPath, { force: true });
    rmSync(jsonPath, { force: true });
    throw err;
  }
  return {
    record,
    jsonPath,
    lockPath,
    lockFd,
    clear() {
      clearReviewerFence({
        stateDir,
        spawnToken,
        lockFd,
        record,
        auditEventWriter,
      });
    },
  };
}

function clearReviewerFence({
  stateDir,
  spawnToken,
  lockFd,
  record = null,
  auditEventWriter = appendFenceAuditEvent,
} = {}) {
  const { jsonPath, lockPath } = resolveFencePaths(stateDir, spawnToken);
  rmSync(jsonPath, { force: true });
  try {
    if (Number.isInteger(lockFd)) {
      flockSync(lockFd, LOCK_UN);
    }
  } catch {}
  try {
    if (Number.isInteger(lockFd)) closeSync(lockFd);
  } catch {}
  rmSync(lockPath, { force: true });
  auditEventWriter(stateDir, {
    event: 'fence_clear',
    spawnToken,
    repo: record?.repo ?? null,
    pr: record?.pr ?? null,
    identity: record?.identity ?? null,
    openedAt: record?.openedAt ?? null,
    expectedClearBy: record?.expectedClearBy ?? null,
  });
}

function readFenceRecord(jsonPath) {
  return JSON.parse(readFileSync(jsonPath, 'utf8'));
}

function listFenceJsonPaths(stateDir) {
  const fenceDir = resolveReviewerFenceDir(stateDir);
  if (!existsSync(fenceDir)) return [];
  return readdirSync(fenceDir)
    .filter((name) => name.endsWith('.json') && name !== SPAWN_RECORDS_FILENAME)
    .sort()
    .map((name) => join(fenceDir, name));
}

function listFenceLockPaths(stateDir) {
  const fenceDir = resolveReviewerFenceDir(stateDir);
  if (!existsSync(fenceDir)) return [];
  return readdirSync(fenceDir)
    .filter((name) => name.endsWith('.lock'))
    .sort()
    .map((name) => join(fenceDir, name));
}

function fenceAgeSeconds(record, now = Date.now()) {
  const openedAtMs = Date.parse(record?.openedAt || '');
  if (!Number.isFinite(openedAtMs)) return Number.POSITIVE_INFINITY;
  return (now - openedAtMs) / 1000;
}

function isFenceStale(record, staleTtlSeconds, now = Date.now()) {
  return fenceAgeSeconds(record, now) > staleTtlSeconds;
}

function probeFenceLock(lockPath) {
  let fd = null;
  try {
    fd = openSync(lockPath, 'r');
    flockSync(fd, LOCK_SH | LOCK_NB);
    flockSync(fd, LOCK_UN);
    return { status: 'free' };
  } catch (err) {
    if (err?.code === 'ENOENT') {
      return { status: 'inconclusive', reason: 'lock-missing' };
    }
    if (err?.code === 'EWOULDBLOCK' || err?.code === 'EAGAIN') {
      return { status: 'held', error: err };
    }
    return { status: 'inconclusive', reason: 'lock-error', error: err };
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {}
    }
  }
}

function moveFenceArtifactToQuarantine(stateDir, filePath, {
  prefix = 'artifact',
  now = Date.now(),
} = {}) {
  const targetPath = join(
    resolveFenceQuarantineDir(stateDir),
    `${prefix}-${now}-${randomUUID()}-${basename(filePath)}`,
  );
  renameSync(filePath, targetPath);
  return targetPath;
}

function loadSpawnRecords(stateDir) {
  const records = {};
  const dirPath = resolveSpawnRecordDir(stateDir);
  for (const entryPath of readdirSync(dirPath)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => join(dirPath, name))) {
    try {
      const parsed = JSON.parse(readFileSync(entryPath, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && typeof parsed.spawnToken === 'string') {
        records[parsed.spawnToken] = parsed;
      }
    } catch {}
  }
  const legacyFilePath = resolveSpawnRecordPath(stateDir);
  if (!existsSync(legacyFilePath)) return records;
  try {
    const parsed = JSON.parse(readFileSync(legacyFilePath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return records;
    for (const [spawnToken, record] of Object.entries(parsed)) {
      if (!(spawnToken in records) && record && typeof record === 'object' && !Array.isArray(record)) {
        records[spawnToken] = record;
      }
    }
  } catch {}
  return records;
}

function persistSpawnRecord(stateDir, record) {
  const normalized = {
    schemaVersion: REVIEWER_FENCE_SCHEMA_VERSION,
    ...record,
  };
  writeFileAtomic(
    resolveSpawnRecordEntryPath(stateDir, normalized.spawnToken),
    `${JSON.stringify(normalized, null, 2)}\n`,
  );
  return normalized;
}

function syncSpawnRecords(stateDir, records) {
  const dirPath = resolveSpawnRecordDir(stateDir);
  const keep = new Set();
  for (const record of Object.values(records)) {
    const normalized = persistSpawnRecord(stateDir, record);
    keep.add(`${normalized.spawnToken}.json`);
  }
  for (const name of readdirSync(dirPath)) {
    if (!name.endsWith('.json') || keep.has(name)) continue;
    rmSync(join(dirPath, name), { force: true });
  }
  rmSync(resolveSpawnRecordPath(stateDir), { force: true });
}

function upsertSpawnRecord(stateDir, record) {
  return persistSpawnRecord(stateDir, record);
}

function deleteSpawnRecord(stateDir, spawnToken) {
  rmSync(resolveSpawnRecordEntryPath(stateDir, spawnToken), { force: true });
}

function listCleanupJobs(stateDir) {
  const dirPath = resolveCleanupQueueDir(stateDir);
  return readdirSync(dirPath)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => join(dirPath, name));
}

function queueFenceCleanupJob(stateDir, jobInput) {
  const dirPath = resolveCleanupQueueDir(stateDir);
  const jobId = `${String(jobInput.repo || 'unknown').replaceAll('/', '__')}-pr-${jobInput.pr}-${jobInput.spawnToken || randomUUID()}-${Date.now()}`;
  const jobPath = join(dirPath, `${jobId}.json`);
  const job = {
    schemaVersion: REVIEWER_FENCE_SCHEMA_VERSION,
    jobId,
    queuedAt: new Date().toISOString(),
    ...jobInput,
  };
  writeFileAtomic(jobPath, `${JSON.stringify(job, null, 2)}\n`, { overwrite: false });
  return { job, jobPath };
}

function deleteCleanupJob(jobPath) {
  unlinkSync(jobPath);
}

function classifyFenceOrphan({
  record,
  lockProbe,
  activeSpawnTokens = new Set(),
  persistedSpawnTokens = new Set(),
  staleTtlSeconds,
  now = Date.now(),
} = {}) {
  if (lockProbe?.status === 'free') {
    return { orphan: true, reason: 'flock-free' };
  }
  if (lockProbe?.status === 'held') {
    return { orphan: false, reason: 'flock-held' };
  }
  const tokenKnown = activeSpawnTokens.has(record?.spawnToken) || persistedSpawnTokens.has(record?.spawnToken);
  if (!tokenKnown) {
    return { orphan: true, reason: 'token-unknown' };
  }
  if (isFenceStale(record, staleTtlSeconds, now)) {
    return { orphan: true, reason: 'wall-clock-stale' };
  }
  return {
    orphan: true,
    reason: lockProbe?.reason === 'lock-missing' ? 'fence_lock_missing_with_json' : 'lock-inconclusive-known-token',
  };
}

function readFenceDirAuditEvents(stateDir) {
  const dirPath = resolveFenceAuditDir(stateDir);
  if (!existsSync(dirPath)) return [];
  return readdirSync(dirPath)
    .filter((name) => name.endsWith('.jsonl'))
    .sort()
    .flatMap((name) => readFileSync(join(dirPath, name), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)));
}

export {
  DEFAULT_FENCE_STALE_TTL_SECONDS,
  DEFAULT_SIGTERM_FENCE_GRACE_SECONDS,
  EXIT_TIMEOUT_SAFETY_SECONDS,
  MAX_SIGTERM_FENCE_GRACE_SECONDS,
  REVIEWER_FENCE_SCHEMA_VERSION,
  appendFenceAuditEvent,
  classifyFenceOrphan,
  clearReviewerFence,
  deleteCleanupJob,
  deleteSpawnRecord,
  ensureReviewerFenceDir,
  fenceAgeSeconds,
  inspectWatcherExitTimeout,
  isFenceStale,
  listCleanupJobs,
  listFenceJsonPaths,
  listFenceLockPaths,
  loadSpawnRecords,
  moveFenceArtifactToQuarantine,
  openReviewerFence,
  parseExitTimeOutFromPlist,
  probeFenceLock,
  queueFenceCleanupJob,
  readFenceDirAuditEvents,
  readFenceRecord,
  resolveAdversarialReviewStateDir,
  resolveCleanupQueueDir,
  resolveFencePaths,
  resolveFenceQuarantineDir,
  resolveReviewerFenceDir,
  resolveSpawnRecordDir,
  resolveSigtermFenceGraceSeconds,
  resolveSigtermFenceMode,
  resolveSpawnRecordPath,
  syncSpawnRecords,
  resolveWatcherPlistPath,
  upsertSpawnRecord,
  validateFenceConfig,
  validateWatcherExitTimeout,
};
