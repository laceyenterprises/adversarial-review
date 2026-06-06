import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_RETENTION_DAYS = 14;
const MIN_RETENTION_DAYS = 1;
const MAX_RETENTION_DAYS = 90;
const LOG_DIR_PARTS = ['data', 'api-call-log'];
const LOG_FILE_MODE = 0o640;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const CATEGORY_ORDER = Object.freeze([
  'conditional_304',
  'diff_fetch',
  'pr_view',
  'labels_list',
  'timeline_events',
  'files_list',
  'review_post',
  'other',
  'rate_limit_throttle_seconds',
]);

function resolveApiCallLogDir(rootDir) {
  return join(rootDir, ...LOG_DIR_PARTS);
}

function clampRetentionDays(value) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return DEFAULT_RETENTION_DAYS;
  if (parsed < MIN_RETENTION_DAYS) return MIN_RETENTION_DAYS;
  if (parsed > MAX_RETENTION_DAYS) return MAX_RETENTION_DAYS;
  return parsed;
}

function resolveRetentionDays(env = process.env) {
  return clampRetentionDays(env.GHO_API_CALL_LOG_RETENTION_DAYS);
}

function utcDayIdFromMs(nowMs) {
  return Math.floor(nowMs / MS_PER_DAY);
}

function formatUtcDateFromDayId(dayId) {
  return new Date(dayId * MS_PER_DAY).toISOString().slice(0, 10);
}

function dateStampFromTimestamp(timestamp) {
  const stamp = String(timestamp || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(stamp)) {
    throw new Error(`Invalid API telemetry timestamp: ${timestamp}`);
  }
  return stamp;
}

function logFilePathForDay(rootDir, dayId) {
  return join(resolveApiCallLogDir(rootDir), `${formatUtcDateFromDayId(dayId)}.jsonl`);
}

function normalizeRepo(repo) {
  return String(repo || '').trim() || null;
}

function normalizePrNumber(prNumber) {
  if (prNumber === null || prNumber === undefined || prNumber === '') return null;
  const parsed = Number(prNumber);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function normalizeStatus(status) {
  if (status === null || status === undefined || status === '') return null;
  return Number.isFinite(Number(status)) ? Math.trunc(Number(status)) : String(status);
}

function apiStatusFromError(err) {
  if (Number.isFinite(Number(err?.status))) return Math.trunc(Number(err.status));
  if (Number.isFinite(Number(err?.response?.status))) return Math.trunc(Number(err.response.status));
  if (
    Number.isFinite(Number(err?.code))
    || err?.signal !== undefined
    || err?.cmd
    || err?.command
  ) {
    return 'exec_error';
  }
  if (typeof err?.code === 'string' && err.code) return err.code;
  return 'error';
}

function normalizeDurationMs(durationMs) {
  if (durationMs === null || durationMs === undefined || durationMs === '') return null;
  const parsed = Number(durationMs);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed) : null;
}

function normalizeCategory(category) {
  const value = String(category || '').trim();
  if (!value) throw new TypeError('API telemetry category is required');
  if (!CATEGORY_ORDER.includes(value)) {
    throw new TypeError(`Unsupported API telemetry category: ${value}`);
  }
  return value;
}

function buildApiCallRow({
  timestamp = new Date().toISOString(),
  category,
  repo,
  prNumber,
  status,
  durationMs,
}) {
  return {
    timestamp,
    category: normalizeCategory(category),
    repo: normalizeRepo(repo),
    pr: normalizePrNumber(prNumber),
    status: normalizeStatus(status),
    durationMs: normalizeDurationMs(durationMs),
  };
}

function writeRotationPlaceholder(filePath) {
  const parentDir = dirname(filePath);
  mkdirSync(parentDir, { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  const fd = openSync(tmpPath, 'w', LOG_FILE_MODE);
  try {
    writeFileSync(fd, '', 'utf8');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmpPath, filePath);
}

function cleanupOrphanRotationTmpFiles(rootDir, {
  existsSyncImpl = existsSync,
  readdirSyncImpl = readdirSync,
  rmSyncImpl = rmSync,
} = {}) {
  const logDir = resolveApiCallLogDir(rootDir);
  if (!existsSyncImpl(logDir)) return;
  for (const name of readdirSyncImpl(logDir)) {
    if (name.endsWith('.jsonl.tmp')) {
      rmSyncImpl(join(logDir, name), { force: true });
    }
  }
}

function sweepRetention(rootDir, {
  nowMs = Date.now(),
  retentionDays = resolveRetentionDays(),
  existsSyncImpl = existsSync,
  readdirSyncImpl = readdirSync,
  rmSyncImpl = rmSync,
} = {}) {
  const logDir = resolveApiCallLogDir(rootDir);
  if (!existsSyncImpl(logDir)) return [];
  const cutoffDayId = utcDayIdFromMs(nowMs) - Math.max(0, retentionDays - 1);
  const deleted = [];
  for (const name of readdirSyncImpl(logDir)) {
    const match = /^(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(name);
    if (!match) continue;
    const dayId = utcDayIdFromMs(Date.parse(`${match[1]}T00:00:00.000Z`));
    if (!Number.isFinite(dayId) || dayId >= cutoffDayId) continue;
    const filePath = join(logDir, name);
    rmSyncImpl(filePath, { force: true });
    deleted.push(filePath);
  }
  return deleted;
}

function createApiCallRecorder({
  rootDir,
  env = process.env,
  nowMs = () => Date.now(),
  timestampNow = () => new Date().toISOString(),
  openFileSync = openSync,
  appendFileSyncImpl = writeFileSync,
  closeFileSync = closeSync,
  renameFileSync = renameSync,
  mkdirSyncImpl = mkdirSync,
  existsSyncImpl = existsSync,
  readdirSyncImpl = readdirSync,
  rmSyncImpl = rmSync,
  fsyncSyncImpl = fsyncSync,
} = {}) {
  if (!rootDir) throw new TypeError('rootDir is required for API telemetry');

  let currentDayId = null;
  let currentPath = null;
  let currentFd = null;
  let initialized = false;
  let pendingLines = [];
  let flushScheduled = false;
  const retentionDays = resolveRetentionDays(env);

  function ensureLogDir() {
    mkdirSyncImpl(resolveApiCallLogDir(rootDir), { recursive: true });
  }

  function openAppendFd(filePath) {
    return openFileSync(filePath, 'a', LOG_FILE_MODE);
  }

  function closeCurrentFd() {
    if (currentFd === null) return;
    closeFileSync(currentFd);
    currentFd = null;
  }

  function flushPendingRows({ rethrow = false } = {}) {
    flushScheduled = false;
    if (pendingLines.length === 0 || currentFd === null) return;
    const payload = pendingLines.join('');
    try {
      appendFileSyncImpl(currentFd, payload, 'utf8');
      pendingLines = [];
    } catch (err) {
      if (rethrow) throw err;
      process.stderr.write(`[api-telemetry] failed to flush API call rows: ${err?.message || err}\n`);
    }
  }

  function scheduleFlush() {
    if (flushScheduled) return;
    flushScheduled = true;
    setImmediate(() => flushPendingRows());
  }

  function rotateToDay(dayId) {
    ensureLogDir();
    flushPendingRows({ rethrow: true });
    const nextPath = logFilePathForDay(rootDir, dayId);
    const fileExists = existsSyncImpl(nextPath);
    if (!fileExists) {
      const tmpPath = `${nextPath}.tmp`;
      const tmpFd = openFileSync(tmpPath, 'w', LOG_FILE_MODE);
      try {
        appendFileSyncImpl(tmpFd, '', 'utf8');
        fsyncSyncImpl(tmpFd);
      } finally {
        closeFileSync(tmpFd);
      }
      renameFileSync(tmpPath, nextPath);
    }
    const nextFd = openAppendFd(nextPath);
    const priorFd = currentFd;
    currentFd = nextFd;
    currentPath = nextPath;
    currentDayId = dayId;
    if (priorFd !== null) {
      closeFileSync(priorFd);
    }
  }

  function ensureInitialized(dayId) {
    if (!initialized) {
      ensureLogDir();
      cleanupOrphanRotationTmpFiles(rootDir, { existsSyncImpl, readdirSyncImpl, rmSyncImpl });
      sweepRetention(rootDir, { nowMs: nowMs(), retentionDays, existsSyncImpl, readdirSyncImpl, rmSyncImpl });
      initialized = true;
    }
    if (currentDayId !== dayId || currentFd === null) {
      rotateToDay(dayId);
      sweepRetention(rootDir, { nowMs: nowMs(), retentionDays, existsSyncImpl, readdirSyncImpl, rmSyncImpl });
    }
  }

  function appendRow(row) {
    const line = `${JSON.stringify(row)}\n`;
    pendingLines.push(line);
    scheduleFlush();
  }

  return {
    recordApiCall({
      category,
      repo = null,
      prNumber = null,
      status = null,
      durationMs = null,
      timestamp = null,
    }) {
      const effectiveTimestamp = timestamp || timestampNow();
      const now = nowMs();
      const dayId = utcDayIdFromMs(now);
      ensureInitialized(dayId);
      appendRow(buildApiCallRow({
        timestamp: effectiveTimestamp,
        category,
        repo,
        prNumber,
        status,
        durationMs,
      }));
      return currentPath;
    },
    flush() {
      flushPendingRows({ rethrow: true });
    },
    close() {
      flushPendingRows({ rethrow: true });
      closeCurrentFd();
    },
    getState() {
      return {
        currentDayId,
        currentPath,
        currentFd,
        retentionDays,
        pendingRows: pendingLines.length,
      };
    },
  };
}

function resolveDefaultApiCallRootDir(env = process.env) {
  if (env.GHO_API_CALL_LOG_DISABLE === '1') return null;
  if (env.NODE_ENV === 'test' || env.NODE_TEST_CONTEXT) return null;
  const configured = String(env.GHO_API_CALL_LOG_ROOT_DIR || '').trim();
  if (configured) return configured;
  return join(dirname(fileURLToPath(import.meta.url)), '..');
}

let defaultRecorder = null;
let defaultRecorderRootDir = null;
let defaultRecorderBeforeExitRegistered = false;

function flushDefaultApiCallRecorder() {
  try {
    defaultRecorder?.flush?.();
  } catch (err) {
    process.stderr.write(`[api-telemetry] failed to flush default recorder: ${err?.message || err}\n`);
  }
}

function recordApiCall(args) {
  try {
    const rootDir = resolveDefaultApiCallRootDir();
    if (!rootDir) return null;
    if (!defaultRecorder || defaultRecorderRootDir !== rootDir) {
      defaultRecorder?.close?.();
      defaultRecorder = createApiCallRecorder({ rootDir });
      defaultRecorderRootDir = rootDir;
      if (!defaultRecorderBeforeExitRegistered) {
        process.once('beforeExit', flushDefaultApiCallRecorder);
        defaultRecorderBeforeExitRegistered = true;
      }
    }
    return defaultRecorder.recordApiCall(args);
  } catch (err) {
    process.stderr.write(`[api-telemetry] failed to record API call: ${err?.message || err}\n`);
    return null;
  }
}

export {
  CATEGORY_ORDER,
  apiStatusFromError,
  buildApiCallRow,
  clampRetentionDays,
  createApiCallRecorder,
  dateStampFromTimestamp,
  flushDefaultApiCallRecorder,
  formatUtcDateFromDayId,
  recordApiCall,
  resolveDefaultApiCallRootDir,
  resolveApiCallLogDir,
  resolveRetentionDays,
  sweepRetention,
  utcDayIdFromMs,
  writeRotationPlaceholder,
};
