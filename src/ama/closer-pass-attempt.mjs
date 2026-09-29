// CLOSERREUSE-01: the reviewer_passes attempt a closer launch's pass is recorded at.
//
// A closer pass row is keyed (repo, pr, attempt, pass_kind='closer'), and the
// attempt is the dispatch record's `retryCount`. That key does not name the
// launch, and the closer reconciles the same terminal launch on every pass
// until it re-dispatches. On agent-os#7347 (SEV2 2026-09-29) the first pass
// after the hammer died recorded attempt 1 and then deferred the re-dispatch
// behind another PR's launch. Every later pass recorded attempt 1 again,
// `beginReviewerPass` threw `refusing to reuse terminal reviewer_passes row`,
// and the throw failed the whole closer decision.
//
// So each launch is recorded once:
//   - a terminal closer row for the same launch already exists: recording is a
//     no-op. This holds at any attempt. The dispatch path writes
//     `retryCount + 1` next to the old launch id before it launches, so a
//     launch that then never happens (lease held, deferred) leaves the old
//     launch keyed one attempt higher. Recording it there would count the same
//     launch twice;
//   - a running row for the same launch exists: record at that attempt;
//   - the requested attempt is free: record there;
//   - the requested attempt belongs to another launch (an earlier review
//     series restarting at retryCount 1): record at the next free attempt.

import { ensureReviewStateSchema, openReviewStateDb } from '../review-state.mjs';

function parseMetadata(raw) {
  try {
    const parsed = JSON.parse(raw || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

// The launch a stored row was written for. The closer writes
// `metadata.launchRequestId`; the worker run id is the fallback for rows
// written without one.
function isSameLaunch(row, { launchRequestId, workerRunId }) {
  const storedLaunch = String(parseMetadata(row.metadata_json).launchRequestId || '').trim();
  if (storedLaunch && launchRequestId) return storedLaunch === String(launchRequestId).trim();
  const storedRun = String(row.worker_run_id || '').trim();
  return Boolean(storedRun) && Boolean(workerRunId) && storedRun === String(workerRunId).trim();
}

function readCloserPassRows(rootDir, { repo, prNumber }) {
  const db = openReviewStateDb(rootDir);
  try {
    ensureReviewStateSchema(db);
    return db.prepare(
      `SELECT attempt_number, status, worker_run_id, metadata_json
         FROM reviewer_passes
        WHERE repo = ? AND pr_number = ? AND pass_kind = 'closer'
        ORDER BY attempt_number`,
    ).all(String(repo || ''), Number(prNumber));
  } finally {
    // Some watcher tests share one in-memory review db; closing it would
    // invalidate their prepared statements (see reviewer-pass-tokens.mjs).
    if (db?.name !== ':memory:') db.close();
  }
}

/**
 * @param {string} rootDir
 * @param {object} args
 * @param {string} args.repo
 * @param {number} args.prNumber
 * @param {number} args.attemptNumber  The record's attempt (`retryCount`, else 1).
 * @param {string|null} args.launchRequestId
 * @param {string|null=} args.workerRunId
 * @returns {{ attemptNumber: number, alreadyRecorded: boolean,
 *   collidedWith: null | { attemptNumber: number, status: string,
 *     launchRequestId: string|null, workerRunId: string|null } }}
 */
export function resolveCloserPassAttempt(rootDir, {
  repo,
  prNumber,
  attemptNumber,
  launchRequestId = null,
  workerRunId = null,
} = {}) {
  const rows = readCloserPassRows(rootDir, { repo, prNumber });
  const own = rows.find((row) => isSameLaunch(row, { launchRequestId, workerRunId }));
  if (own) {
    return { attemptNumber: own.attempt_number, alreadyRecorded: own.status !== 'running', collidedWith: null };
  }
  const occupant = rows.find((row) => row.attempt_number === attemptNumber);
  if (!occupant) return { attemptNumber, alreadyRecorded: false, collidedWith: null };
  return {
    attemptNumber: rows[rows.length - 1].attempt_number + 1,
    alreadyRecorded: false,
    collidedWith: {
      attemptNumber: occupant.attempt_number,
      status: occupant.status,
      launchRequestId: parseMetadata(occupant.metadata_json).launchRequestId || null,
      workerRunId: occupant.worker_run_id || null,
    },
  };
}
