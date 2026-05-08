import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const CASCADE_BACKOFF_MINUTES = [1, 2, 4, 8, 15];
const CASCADE_FAILURE_CAP = 5;
const CASCADE_STATE_DIR = ['data', 'cascade-state'];

const BUG_ERROR_CODES = new Set(['ENOENT', 'EACCES', 'EPERM']);
const CASCADE_ERROR_CODES = new Set(['ETIMEDOUT']);
const REVIEWER_TIMEOUT_MESSAGE_RE = /command timed out after \d+ms/;
const LAUNCHCTL_BOOTSTRAP_ERROR_RE =
  /bootstrap failed|could not find domain|input\/output error|not privileged to set domain|gui\/\d+/;

function isReviewerSubprocessTimeout(error, { killSignal = 'SIGTERM' } = {}) {
  const actualSignal = String(error?.signal || '').toUpperCase();
  const expectedSignal = String(killSignal || 'SIGTERM').toUpperCase();
  return (
    error?.killed === true &&
    actualSignal === expectedSignal &&
    String(error?.code || '').toUpperCase() !== 'ABORT_ERR'
  );
}

function classifyReviewerFailure(stderr, exitCode, errorCode = null, details = {}) {
  const text = String(stderr || '');
  const lower = text.toLowerCase();
  const normalizedErrorCode = String(errorCode || '').toUpperCase();
  const timeoutKilled = details?.timeoutKilled === true || isReviewerSubprocessTimeout(details);
  const mentionsReviewerTimeout = REVIEWER_TIMEOUT_MESSAGE_RE.test(lower);
  const launchctlBootstrap = lower.split(/\r?\n/).some((line) => (
    /launchctlsessionerror|claude launchctl session bootstrap failed/.test(line) ||
    (/launchctl/.test(line) && LAUNCHCTL_BOOTSTRAP_ERROR_RE.test(line))
  ));
  const mentionsReal429 =
    /\b429\b|too many requests|http\s*429|rate_limit_exceeded|ratelimiterror|quota/.test(lower);
  const mentionsRateLimit = /rate.?limit/.test(lower);
  const mentionsCascade =
    /all upstream attempts failed|upstream[._ -]?failed|cascade/.test(lower) ||
    (/litellm/.test(lower) && /retry|exhaust|timeout|attempts failed|5\d\d\b/.test(lower)) ||
    /timeout.*retries|retries.*timeout/.test(lower) ||
    /(http|status|response)[\s/=:]+5\d\d\b/.test(lower);

  if (timeoutKilled || mentionsReviewerTimeout) {
    return 'reviewer-timeout';
  }

  if (launchctlBootstrap) {
    return 'launchctl-bootstrap';
  }

  if (CASCADE_ERROR_CODES.has(normalizedErrorCode) || (mentionsRateLimit && !mentionsReal429) || mentionsCascade) {
    return 'cascade';
  }

  if (exitCode === 127 || BUG_ERROR_CODES.has(normalizedErrorCode) || /typeerror|syntaxerror|cannot find/.test(lower)) {
    return 'bug';
  }

  return 'unknown';
}

function getCascadeStateDir(rootDir) {
  return join(rootDir, ...CASCADE_STATE_DIR);
}

function getCascadeStatePath(rootDir, { repo, prNumber }) {
  const normalizedPrNumber = Number(prNumber);
  if (!Number.isInteger(normalizedPrNumber) || normalizedPrNumber <= 0) {
    throw new TypeError(`Invalid PR number for cascade state: ${prNumber}`);
  }

  const normalizedRepo = String(repo || '').trim();
  if (!normalizedRepo) {
    throw new TypeError('Repo slug is required for cascade state');
  }

  return join(
    getCascadeStateDir(rootDir),
    `${encodeURIComponent(normalizedRepo)}__${normalizedPrNumber}.json`
  );
}

function readCascadeState(rootDir, { repo, prNumber }) {
  const path = getCascadeStatePath(rootDir, { repo, prNumber });
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function writeCascadeState(rootDir, { repo, prNumber }, state) {
  mkdirSync(getCascadeStateDir(rootDir), { recursive: true });
  const path = getCascadeStatePath(rootDir, { repo, prNumber });
  const tmpPath = `${path}.tmp`;
  const payload = `${JSON.stringify(state, null, 2)}\n`;
  const tmpFd = openSync(tmpPath, 'w');
  try {
    writeFileSync(tmpFd, payload, 'utf8');
    fsyncSync(tmpFd);
  } finally {
    closeSync(tmpFd);
  }
  renameSync(tmpPath, path);
  return state;
}

function clearCascadeState(rootDir, { repo, prNumber }) {
  rmSync(getCascadeStatePath(rootDir, { repo, prNumber }), { force: true });
}

function resolveCascadeBackoffMinutes(consecutiveCascadeFailures) {
  const index = Math.max(
    0,
    Math.min(CASCADE_BACKOFF_MINUTES.length - 1, Number(consecutiveCascadeFailures || 1) - 1)
  );
  return CASCADE_BACKOFF_MINUTES[index];
}

function recordCascadeFailure(rootDir, { repo, prNumber, failedAt = new Date().toISOString() }) {
  const previous = readCascadeState(rootDir, { repo, prNumber });
  const previousCount = Number(previous?.consecutiveCascadeFailures || 0);
  const consecutiveCascadeFailures = Math.min(previousCount + 1, CASCADE_FAILURE_CAP);
  const backoffMinutes = resolveCascadeBackoffMinutes(consecutiveCascadeFailures);
  const failedAtMs = Date.parse(failedAt);
  const nextRetryAfter = new Date(failedAtMs + (backoffMinutes * 60_000)).toISOString();
  return writeCascadeState(rootDir, { repo, prNumber }, {
    consecutiveCascadeFailures,
    lastFailureAt: failedAt,
    nextRetryAfter,
    backoffMinutes,
  });
}

function shouldBackoffReviewerSpawn(rootDir, { repo, prNumber, now = new Date().toISOString() }) {
  const state = readCascadeState(rootDir, { repo, prNumber });
  if (!state?.nextRetryAfter) {
    return { shouldBackoff: false, state: null };
  }

  const nowMs = Date.parse(now);
  const nextRetryMs = Date.parse(state.nextRetryAfter);
  if (!Number.isFinite(nowMs) || !Number.isFinite(nextRetryMs)) {
    return { shouldBackoff: true, state };
  }

  if (nowMs >= nextRetryMs) {
    return { shouldBackoff: false, state };
  }

  return { shouldBackoff: true, state };
}

export {
  CASCADE_FAILURE_CAP,
  classifyReviewerFailure,
  clearCascadeState,
  getCascadeStatePath,
  isReviewerSubprocessTimeout,
  readCascadeState,
  recordCascadeFailure,
  resolveCascadeBackoffMinutes,
  shouldBackoffReviewerSpawn,
};
