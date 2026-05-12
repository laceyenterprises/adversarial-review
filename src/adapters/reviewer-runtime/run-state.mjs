import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomic } from '../../atomic-write.mjs';

const RUN_STATE_DIR = ['data', 'reviewer-runs'];
const ACTIVE_RUN_STATES = new Set(['spawned', 'heartbeating']);
const RECOVERABLE_RUN_STATES = new Set(['spawned', 'heartbeating', 'cancelled']);
const TERMINAL_RUN_STATES = new Set(['completed', 'failed', 'cancelled']);

function reviewerRunStateDir(rootDir) {
  return join(rootDir, ...RUN_STATE_DIR);
}

function reviewerRunStatePath(rootDir, sessionUuid) {
  const normalized = String(sessionUuid || '').trim();
  if (!normalized) {
    throw new TypeError('sessionUuid is required for reviewer run state');
  }
  if (normalized.includes('/') || normalized.includes('\\')) {
    throw new TypeError(`Invalid reviewer sessionUuid for file path: ${sessionUuid}`);
  }
  return join(reviewerRunStateDir(rootDir), `${normalized}.json`);
}

function reviewerRunSideChannelPaths(rootDir, sessionUuid) {
  const normalized = String(sessionUuid || '').trim();
  if (!normalized) {
    throw new TypeError('sessionUuid is required for reviewer run side-channel paths');
  }
  if (normalized.includes('/') || normalized.includes('\\')) {
    throw new TypeError(`Invalid reviewer sessionUuid for file path: ${sessionUuid}`);
  }
  const dir = reviewerRunStateDir(rootDir);
  return {
    stdoutPath: join(dir, `${normalized}.stdout`),
    stderrPath: join(dir, `${normalized}.stderr`),
  };
}

function normalizeReviewerRunRecord(record = {}) {
  const now = new Date().toISOString();
  return {
    sessionUuid: String(record.sessionUuid || ''),
    domain: record.domain ? String(record.domain) : 'code-pr',
    runtime: record.runtime ? String(record.runtime) : 'cli-direct',
    state: record.state ? String(record.state) : 'spawned',
    pgid: Number.isInteger(record.pgid) ? record.pgid : null,
    spawnedAt: record.spawnedAt ? String(record.spawnedAt) : now,
    lastHeartbeatAt: record.lastHeartbeatAt ? String(record.lastHeartbeatAt) : null,
    reattachToken: record.reattachToken ? String(record.reattachToken) : null,
    subjectContext: record.subjectContext || null,
  };
}

function writeReviewerRunRecord(rootDir, record, { overwrite = true } = {}) {
  const normalized = normalizeReviewerRunRecord(record);
  writeFileAtomic(
    reviewerRunStatePath(rootDir, normalized.sessionUuid),
    `${JSON.stringify(normalized, null, 2)}\n`,
    { overwrite },
  );
  return normalized;
}

function claimReviewerRunRecord(rootDir, record) {
  try {
    return {
      claimed: true,
      record: writeReviewerRunRecord(rootDir, record, { overwrite: false }),
    };
  } catch (err) {
    if (err?.code !== 'EEXIST') throw err;
    const existing = readReviewerRunRecord(rootDir, record.sessionUuid);
    return { claimed: false, record: existing };
  }
}

function updateReviewerRunRecord(rootDir, record, patch = {}) {
  return writeReviewerRunRecord(rootDir, {
    ...record,
    ...patch,
  });
}

function readReviewerRunRecord(rootDir, sessionUuid) {
  try {
    return normalizeReviewerRunRecord(
      JSON.parse(readFileSync(reviewerRunStatePath(rootDir, sessionUuid), 'utf8')),
    );
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
}

function readActiveReviewerRunRecords(rootDir) {
  const dir = reviewerRunStateDir(rootDir);
  if (!existsSync(dir)) return [];
  const records = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    try {
      const parsed = normalizeReviewerRunRecord(JSON.parse(readFileSync(join(dir, name), 'utf8')));
      if (ACTIVE_RUN_STATES.has(parsed.state)) {
        records.push(parsed);
      }
    } catch {
      // Corrupt run-state records should not prevent the kernel from
      // recovering every other in-flight reviewer on startup.
    }
  }
  return records;
}

function readRecoverableReviewerRunRecords(rootDir) {
  const dir = reviewerRunStateDir(rootDir);
  if (!existsSync(dir)) return [];
  const records = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    try {
      const parsed = normalizeReviewerRunRecord(JSON.parse(readFileSync(join(dir, name), 'utf8')));
      if (RECOVERABLE_RUN_STATES.has(parsed.state)) {
        records.push(parsed);
      }
    } catch {
      // Corrupt run-state records should not prevent the kernel from
      // recovering every other in-flight reviewer on startup.
    }
  }
  return records;
}

function removeReviewerRunRecord(rootDir, sessionUuid) {
  const { stdoutPath, stderrPath } = reviewerRunSideChannelPaths(rootDir, sessionUuid);
  rmSync(reviewerRunStatePath(rootDir, sessionUuid), { force: true });
  rmSync(stdoutPath, { force: true });
  rmSync(stderrPath, { force: true });
}

function pruneReviewerRunRecords(rootDir, {
  now = new Date(),
  ttlMs = 24 * 60 * 60 * 1000,
} = {}) {
  const dir = reviewerRunStateDir(rootDir);
  if (!existsSync(dir)) return 0;
  const cutoff = now.getTime() - ttlMs;
  if (!Number.isFinite(cutoff)) return 0;
  let pruned = 0;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    try {
      const record = normalizeReviewerRunRecord(JSON.parse(readFileSync(join(dir, name), 'utf8')));
      if (ACTIVE_RUN_STATES.has(record.state)) continue;
      const ageAnchor = Date.parse(record.lastHeartbeatAt || record.spawnedAt || '');
      if (!Number.isFinite(ageAnchor) || ageAnchor > cutoff) continue;
      removeReviewerRunRecord(rootDir, record.sessionUuid);
      pruned += 1;
    } catch {
      // Corrupt records are ignored here; startup recovery should stay
      // best-effort and avoid deleting files it could not parse.
    }
  }
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.stdout') && !name.endsWith('.stderr')) continue;
    const sessionUuid = name.replace(/\.(stdout|stderr)$/, '');
    if (!sessionUuid || existsSync(join(dir, `${sessionUuid}.json`))) continue;
    rmSync(join(dir, name), { force: true });
    pruned += 1;
  }
  return pruned;
}

export {
  ACTIVE_RUN_STATES,
  RECOVERABLE_RUN_STATES,
  claimReviewerRunRecord,
  pruneReviewerRunRecords,
  readActiveReviewerRunRecords,
  readRecoverableReviewerRunRecords,
  readReviewerRunRecord,
  removeReviewerRunRecord,
  reviewerRunSideChannelPaths,
  reviewerRunStatePath,
  TERMINAL_RUN_STATES,
  updateReviewerRunRecord,
  writeReviewerRunRecord,
};
