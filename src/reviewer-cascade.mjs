import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  classifyReviewerFailure,
  isReviewerSubprocessTimeout,
} from './adapters/reviewer-runtime/cli-direct/classification.mjs';

const CASCADE_BACKOFF_MINUTES = [1, 2, 4, 8, 15];
const CASCADE_FAILURE_CAP = 5;
const CASCADE_STATE_DIR = ['data', 'cascade-state'];

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

function normalizeTransientFailureClass(failureClass) {
  const value = String(failureClass || '').trim();
  if (value === 'cascade' || value === 'reviewer-timeout' || value === 'launchctl-bootstrap') {
    return value;
  }
  return 'cascade';
}

function formatTransientFailureBreakdown(breakdown = {}) {
  return Object.entries(breakdown)
    .filter(([, count]) => Number(count) > 0)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([failureClass, count]) => `${failureClass}=${Number(count)}`)
    .join(', ');
}

function recordCascadeFailure(rootDir, {
  repo,
  prNumber,
  failedAt = new Date().toISOString(),
  failureClass = 'cascade',
} = {}) {
  const previous = readCascadeState(rootDir, { repo, prNumber });
  const previousCount = Number(
    previous?.consecutiveTransientFailures ?? previous?.consecutiveCascadeFailures ?? 0
  );
  const consecutiveTransientFailures = Math.min(previousCount + 1, CASCADE_FAILURE_CAP);
  const backoffMinutes = resolveCascadeBackoffMinutes(consecutiveTransientFailures);
  const failedAtMs = Date.parse(failedAt);
  const nextRetryAfter = new Date(failedAtMs + (backoffMinutes * 60_000)).toISOString();
  const normalizedFailureClass = normalizeTransientFailureClass(failureClass);
  const transientFailureBreakdown = previous?.transientFailureBreakdown
    ? { ...previous.transientFailureBreakdown }
    : {};
  if (!previous?.transientFailureBreakdown && Number(previous?.consecutiveCascadeFailures) > 0) {
    transientFailureBreakdown.cascade = Number(previous.consecutiveCascadeFailures);
  }
  transientFailureBreakdown[normalizedFailureClass] = Number(
    transientFailureBreakdown[normalizedFailureClass] || 0
  ) + 1;
  return writeCascadeState(rootDir, { repo, prNumber }, {
    consecutiveTransientFailures,
    transientFailureBreakdown,
    lastFailureClass: normalizedFailureClass,
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
  formatTransientFailureBreakdown,
  getCascadeStatePath,
  isReviewerSubprocessTimeout,
  readCascadeState,
  recordCascadeFailure,
  resolveCascadeBackoffMinutes,
  shouldBackoffReviewerSpawn,
};
