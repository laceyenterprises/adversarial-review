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
  'diff_fetch',
  'cache_hit_diff_fetch',
  'cache_miss_diff_fetch',
  'pr_view',
  'comments_list',
  'checks_list',
  'reviews_list',
  'labels_list',
  'timeline_events',
  'files_list',
  'review_post',
  'conditional_304',
  'graphql_pr_rollup',
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

function cleanupOrphanRotationTmpFiles(rootDir) {
  const logDir = resolveApiCallLogDir(rootDir);
  if (!existsSync(logDir)) return;
  for (const name of readdirSync(logDir)) {
    if (name.endsWith('.jsonl.tmp')) {
      rmSync(join(logDir, name), { force: true });
    }
  }
}

function sweepRetention(rootDir, {
  nowMs = Date.now(),
  retentionDays = resolveRetentionDays(),
} = {}) {
  const logDir = resolveApiCallLogDir(rootDir);
  if (!existsSync(logDir)) return [];
  const cutoffDayId = utcDayIdFromMs(nowMs) - Math.max(0, retentionDays - 1);
  const deleted = [];
  for (const name of readdirSync(logDir)) {
    const match = /^(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(name);
    if (!match) continue;
    const dayId = utcDayIdFromMs(Date.parse(`${match[1]}T00:00:00.000Z`));
    if (!Number.isFinite(dayId) || dayId >= cutoffDayId) continue;
    const filePath = join(logDir, name);
    rmSync(filePath, { force: true });
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

  function rotateToDay(dayId) {
    ensureLogDir();
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
      cleanupOrphanRotationTmpFiles(rootDir);
      sweepRetention(rootDir, { nowMs: nowMs(), retentionDays });
      initialized = true;
    }
    if (currentDayId !== dayId || currentFd === null) {
      rotateToDay(dayId);
      sweepRetention(rootDir, { nowMs: nowMs(), retentionDays });
    }
  }

  function appendRow(row) {
    const line = `${JSON.stringify(row)}\n`;
    appendFileSyncImpl(currentFd, line, 'utf8');
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
    close() {
      closeCurrentFd();
    },
    getState() {
      return {
        currentDayId,
        currentPath,
        currentFd,
        retentionDays,
      };
    },
  };
}

const defaultRecorder = createApiCallRecorder({
  rootDir: join(dirname(fileURLToPath(import.meta.url)), '..'),
});

function recordApiCall(args) {
  try {
    return defaultRecorder.recordApiCall(args);
  } catch (err) {
    process.stderr.write(`[api-telemetry] failed to record API call: ${err?.message || err}\n`);
    return null;
  }
}

export {
  CATEGORY_ORDER,
  buildApiCallRow,
  clampRetentionDays,
  createApiCallRecorder,
  dateStampFromTimestamp,
  formatUtcDateFromDayId,
  recordApiCall,
  resolveApiCallLogDir,
  resolveRetentionDays,
  sweepRetention,
  utcDayIdFromMs,
  writeRotationPlaceholder,
};
