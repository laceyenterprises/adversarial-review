// Durable PR-comment delivery state for terminal follow-up jobs.
//
// Why this exists: reconcile must move a job to a terminal directory
// (completed/stopped/failed) atomically — otherwise a crash mid-tick
// leaves the queue in a bad state. But comment posting is an
// unreliable network call (gh outage, auth flakiness, missing token,
// the recently-added timeout). If the comment fails AFTER the
// terminal move, the queue advanced but the PR is silent. Without a
// durable record of "the comment is owed but not yet delivered", we
// have no way to retry, and the docs would lie when they say
// "if there's no PR comment, reconcile didn't run".
//
// Design:
//   1. After reconcile moves a job to terminal, post the comment
//      (with a hard timeout — see src/pr-comments.mjs).
//   2. Stamp the result into the terminal job record under
//      `commentDelivery`. Includes the rendered body so the retry
//      path can re-post without recomputing it from scratch.
//   3. On every tick, `retryFailedCommentDeliveries` walks the
//      terminal directories, picks up records where
//      `commentDelivery.posted === false` and `attempts < cap`,
//      retries via the same poster, updates the record on success.
//
// Cap: 5 attempts. After that the record stays at posted=false for
// human inspection; the daemon does not silently keep hammering.

import { readFileSync, readdirSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getFollowUpJobDir } from './follow-up-jobs.mjs';
import { postRemediationOutcomeComment } from './pr-comments.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// Maximum number of times the retry pass will re-attempt a failed
// comment. After this, the record sits in terminal/ with posted=false
// for an operator to inspect (or clear by hand).
const MAX_COMMENT_DELIVERY_ATTEMPTS = 5;

// Reasons that mean "the comment was never going to be deliverable
// from this configuration" — retrying achieves nothing. The retry
// pass skips records with these reasons (but they still stay marked
// posted=false so an operator sees them).
const NON_RETRYABLE_DELIVERY_REASONS = new Set([
  'missing-pr-coordinates',
  'no-token-mapping',
]);

function buildPendingDelivery({
  body,
  repo,
  prNumber,
  workerClass,
  postResult,
  attemptedAt,
}) {
  // Always include the rendered body + addressing info so the retry
  // pass doesn't need to reconstruct the body from the job record
  // (which would require re-parsing the worker's reply artifact and
  // re-running the body builder, brittle across schema changes).
  return {
    posted: Boolean(postResult?.posted),
    reason: postResult?.posted ? null : (postResult?.reason || 'unknown'),
    error: postResult?.error || null,
    timeoutMs: postResult?.timeoutMs ?? null,
    attempts: 1,
    firstAttemptAt: attemptedAt,
    lastAttemptAt: attemptedAt,
    body,
    repo,
    prNumber,
    workerClass,
  };
}

function readTerminalRecord(jobPath) {
  const raw = readFileSync(jobPath, 'utf8');
  return JSON.parse(raw);
}

function writeTerminalRecord(jobPath, record) {
  // Atomic update: write to a sibling .tmp file then rename.
  // Truncating the original in-place would leave a half-written file
  // visible to a concurrent reader on a crash mid-write.
  const tmp = `${jobPath}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  renameSync(tmp, jobPath);
}

// Stamp the initial commentDelivery state into a freshly-written
// terminal record. Called by reconcile right after the mark*
// transition + comment post attempt. If the post succeeded, the
// retry pass will see posted=true and ignore the record. If it
// failed, the retry pass will pick it up.
function recordInitialCommentDelivery({
  jobPath,
  body,
  repo,
  prNumber,
  workerClass,
  postResult,
  now = () => new Date().toISOString(),
  log = console,
}) {
  if (!jobPath) return null;
  const attemptedAt = now();
  const delivery = buildPendingDelivery({
    body,
    repo,
    prNumber,
    workerClass,
    postResult,
    attemptedAt,
  });
  try {
    const record = readTerminalRecord(jobPath);
    record.commentDelivery = delivery;
    writeTerminalRecord(jobPath, record);
    return delivery;
  } catch (err) {
    // Logging only — the terminal record was already written by the
    // mark* call, we just couldn't stamp delivery state. Operators
    // will see the missing field if they look, and the retry pass
    // skips records without commentDelivery.
    log.error?.(`[comment-delivery] failed to stamp delivery state on ${jobPath}: ${err.message}`);
    return null;
  }
}

function listTerminalJobPaths(rootDir) {
  const dirs = ['completed', 'stopped', 'failed'];
  const out = [];
  for (const key of dirs) {
    const dir = getFollowUpJobDir(rootDir, key);
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (name.endsWith('.json')) {
        out.push(join(dir, name));
      }
    }
  }
  return out;
}

// Scan terminal records, retry any whose initial comment delivery
// failed (and that aren't past the attempts cap or marked
// non-retryable). Returns a summary { scanned, retried, posted, failed,
// skipped }.
async function retryFailedCommentDeliveries({
  rootDir = ROOT,
  postCommentImpl = postRemediationOutcomeComment,
  now = () => new Date().toISOString(),
  log = console,
  maxAttempts = MAX_COMMENT_DELIVERY_ATTEMPTS,
} = {}) {
  const paths = listTerminalJobPaths(rootDir);
  let scanned = 0;
  let retried = 0;
  let posted = 0;
  let failed = 0;
  let skipped = 0;

  for (const jobPath of paths) {
    scanned += 1;
    let record;
    try {
      record = readTerminalRecord(jobPath);
    } catch (err) {
      log.error?.(`[comment-delivery] cannot parse ${jobPath}: ${err.message}`);
      continue;
    }
    const delivery = record.commentDelivery;
    if (!delivery || delivery.posted) {
      skipped += 1;
      continue;
    }
    if ((delivery.attempts || 0) >= maxAttempts) {
      skipped += 1;
      continue;
    }
    if (NON_RETRYABLE_DELIVERY_REASONS.has(delivery.reason)) {
      skipped += 1;
      continue;
    }

    retried += 1;
    /* eslint-disable no-await-in-loop */
    const result = await postCommentImpl({
      repo: delivery.repo,
      prNumber: delivery.prNumber,
      workerClass: delivery.workerClass,
      body: delivery.body,
      log,
    });
    /* eslint-enable no-await-in-loop */

    const attemptedAt = now();
    const updatedDelivery = {
      ...delivery,
      attempts: (delivery.attempts || 0) + 1,
      lastAttemptAt: attemptedAt,
      posted: Boolean(result?.posted),
      reason: result?.posted ? null : (result?.reason || delivery.reason || 'unknown'),
      error: result?.error || null,
      timeoutMs: result?.timeoutMs ?? null,
    };
    record.commentDelivery = updatedDelivery;
    try {
      writeTerminalRecord(jobPath, record);
    } catch (err) {
      log.error?.(`[comment-delivery] failed to update ${jobPath}: ${err.message}`);
    }

    if (result?.posted) {
      posted += 1;
    } else {
      failed += 1;
    }
  }

  return { scanned, retried, posted, failed, skipped };
}

export {
  MAX_COMMENT_DELIVERY_ATTEMPTS,
  NON_RETRYABLE_DELIVERY_REASONS,
  buildPendingDelivery,
  recordInitialCommentDelivery,
  retryFailedCommentDeliveries,
};
