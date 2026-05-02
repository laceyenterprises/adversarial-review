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

import { closeSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync, writeSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

import { getFollowUpJobDir } from './follow-up-jobs.mjs';
import { postRemediationOutcomeComment } from './pr-comments.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// Maximum number of times the retry pass will re-attempt a failed
// comment. After this, the record sits in terminal/ with posted=false
// for an operator to inspect (or clear by hand).
const MAX_COMMENT_DELIVERY_ATTEMPTS = 5;

// How many retry candidates a single tick processes. Bounds the
// per-tick wall-clock so a backlog of failed deliveries doesn't
// starve the live consume/reconcile pipeline. With a 30s gh timeout
// + 5 records per tick + 120s tick interval, the worst-case retry
// drain is 5 records per 2 minutes — slow enough not to crowd live
// work, fast enough that a transient outage clears in minutes.
const RETRY_BUDGET_PER_TICK = 5;

// How long a delivery claim is honored before another process can
// take over. Set generously above the gh subprocess timeout (30s)
// + a safety margin: a process that took the claim must either
// finish before this timer expires or be considered crashed. A
// stale claim is reclaimable; this is the recovery window.
const DELIVERY_CLAIM_STALE_MS = 5 * 60 * 1000; // 5 minutes

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
  // `attempting: false` is explicit so consumers can distinguish a
  // settled record (this shape) from an in-flight one
  // (buildAttemptingDelivery → attempting: true).
  return {
    posted: Boolean(postResult?.posted),
    attempting: false,
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

function buildAttemptingDelivery({
  body,
  repo,
  prNumber,
  workerClass,
  attemptedAt,
  attempts = 1,
  firstAttemptAt,
}) {
  // Pre-flight stamp written BEFORE the gh call. If the process
  // dies between this write and the post-call update, the retry
  // pass sees attempting=true and (assuming the lock is stale)
  // takes ownership and re-attempts. Without this pre-write the
  // owed comment would be lost on a crash window between the gh
  // call and the post-call stamp.
  return {
    posted: false,
    attempting: true,
    reason: null,
    error: null,
    timeoutMs: null,
    attempts,
    firstAttemptAt: firstAttemptAt || attemptedAt,
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

// ── Delivery claim (sidecar lock file) ────────────────────────────────────
//
// The retry path can run concurrently across overlapping daemon ticks
// (StartInterval=120 + occasional drift) and across an operator's
// manual `npm run follow-up:reconcile`. Without a claim, two processes
// can both read `posted=false`, both call `gh pr comment`, and both
// post — duplicate public PR spam.
//
// Claim mechanism: a sidecar `<jobPath>.delivery.lock` file created
// with O_EXCL (`openSync(... 'wx')`). The first to create it owns the
// lock. Stale claims (older than DELIVERY_CLAIM_STALE_MS) are
// recoverable: a process seeing a stale lock can overwrite it. There
// is a small TOCTOU window in stale recovery (two processes both see
// stale, both overwrite); that's acceptable because by definition the
// original claimer has crashed or hung past the timeout, and at most
// one duplicate post in that recovery window is much better than the
// alternative of unbounded duplicates.

function buildClaimerId() {
  return `${process.pid}.${Date.now()}.${randomBytes(4).toString('hex')}`;
}

function deliveryLockPath(jobPath) {
  return `${jobPath}.delivery.lock`;
}

function tryAcquireDeliveryClaim(jobPath, claimerId, { now = () => new Date().toISOString(), staleMs = DELIVERY_CLAIM_STALE_MS } = {}) {
  const lockPath = deliveryLockPath(jobPath);
  const claim = { claimer: claimerId, claimedAt: now() };
  // Try the exclusive create first — this is the fast path and the
  // only one with strong atomicity (OS guarantees `O_EXCL`).
  let fd;
  try {
    fd = openSync(lockPath, 'wx');
    writeSync(fd, JSON.stringify(claim));
    closeSync(fd);
    return { acquired: true, claimer: claimerId };
  } catch (err) {
    if (err?.code !== 'EEXIST') {
      // Filesystem error other than "lock exists" — surface it
      // rather than silently treating as "claim held".
      throw err;
    }
  }
  // Lock exists. Read the existing claim to decide if it's stale.
  let existing = null;
  try {
    existing = JSON.parse(readFileSync(lockPath, 'utf8'));
  } catch {
    // Unreadable lock file — treat as stale.
  }
  const ageMs = existing?.claimedAt
    ? Math.max(0, Date.now() - new Date(existing.claimedAt).getTime())
    : Number.POSITIVE_INFINITY;
  if (ageMs <= staleMs) {
    return { acquired: false, claimer: existing?.claimer || null, ageMs };
  }
  // Stale → reclaim. (Small TOCTOU window here: documented at top of
  // section. Acceptable trade.)
  writeFileSync(lockPath, JSON.stringify(claim), 'utf8');
  return { acquired: true, claimer: claimerId, reclaimedFromStale: true, previousAgeMs: ageMs };
}

function releaseDeliveryClaim(jobPath) {
  const lockPath = deliveryLockPath(jobPath);
  try {
    rmSync(lockPath, { force: true });
  } catch {
    // Best-effort. Stale lock will time out and be recovered.
  }
}

// Durability-first comment delivery for the reconcile path.
//
// Old shape (pre-r3-review): call gh first, stamp commentDelivery
// AFTER. Crash window: a process death between gh-call and stamp
// loses the owed comment forever (retry pass skips records without
// commentDelivery).
//
// New shape: stamp `attempting=true` BEFORE the gh call. If we
// crash mid-call, the next retry pass sees the in-flight record,
// sees the lock is stale, and re-posts. After the gh call returns
// (or throws), we update the record with the actual result.
//
// We also acquire a delivery claim lock here so a concurrent retry
// pass running on the same record skips while we own it. The lock
// is released after the result is stamped.
function recordInitialCommentDelivery({
  jobPath,
  body,
  repo,
  prNumber,
  workerClass,
  postCommentImpl,
  postCommentArgs = null,
  now = () => new Date().toISOString(),
  log = console,
  // Test seam: lets callers verify the in-flight stamp without a
  // full async post. Production path leaves this null and the post
  // is done internally.
  postResult: precomputedPostResult = null,
}) {
  if (!jobPath) {
    return Promise.resolve(null);
  }

  return (async () => {
    const claimerId = buildClaimerId();
    const claim = tryAcquireDeliveryClaim(jobPath, claimerId, { now });
    if (!claim.acquired) {
      // Another process owns the live claim — they'll handle the
      // delivery (or retry will pick it up if they crash). We do
      // NOT post.
      log.error?.(
        `[comment-delivery] declining to post for ${jobPath}: claim held by ${claim.claimer} (${claim.ageMs}ms ago)`
      );
      return null;
    }

    const firstAttemptAt = now();
    // Pre-stamp: write `attempting=true` BEFORE the gh call so a
    // crash mid-call leaves a recoverable record. The retry pass
    // will see attempting=true with a stale lock and re-attempt.
    try {
      const record = readTerminalRecord(jobPath);
      record.commentDelivery = buildAttemptingDelivery({
        body,
        repo,
        prNumber,
        workerClass,
        attemptedAt: firstAttemptAt,
        attempts: 1,
        firstAttemptAt,
      });
      writeTerminalRecord(jobPath, record);
    } catch (err) {
      log.error?.(`[comment-delivery] failed to pre-stamp ${jobPath}: ${err.message}`);
      releaseDeliveryClaim(jobPath);
      return null;
    }

    // Now do the post (or use the precomputed result if a caller is
    // testing the stamp behavior independently of a real post).
    let postResult = precomputedPostResult;
    if (!postResult) {
      try {
        postResult = await postCommentImpl(postCommentArgs || { repo, prNumber, workerClass, body, log });
      } catch (err) {
        // Synthesize a failure result rather than letting the throw
        // propagate — the durable record is what matters; without
        // this stamp the owed comment would be lost on a thrown
        // poster impl.
        log.error?.(`[comment-delivery] poster threw for ${jobPath}: ${err.message}`);
        postResult = { posted: false, reason: 'gh-cli-failure', error: err.message };
      }
    }

    const settledAt = now();
    const finalDelivery = {
      ...buildPendingDelivery({
        body,
        repo,
        prNumber,
        workerClass,
        postResult,
        attemptedAt: settledAt,
      }),
      firstAttemptAt,
    };

    try {
      const record = readTerminalRecord(jobPath);
      record.commentDelivery = finalDelivery;
      writeTerminalRecord(jobPath, record);
    } catch (err) {
      log.error?.(`[comment-delivery] failed to stamp final delivery on ${jobPath}: ${err.message}`);
    } finally {
      releaseDeliveryClaim(jobPath);
    }

    return finalDelivery;
  })();
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

// Build a list of retry candidates, sorted by firstAttemptAt
// ascending so the oldest still-failing comments drain first.
// Records that aren't candidates (no commentDelivery, posted=true,
// over the attempts cap, non-retryable reason) are filtered here so
// the budget cap downstream applies only to actual work.
function listRetryCandidates(rootDir, { maxAttempts, log }) {
  const paths = listTerminalJobPaths(rootDir);
  const candidates = [];
  for (const jobPath of paths) {
    let record;
    try {
      record = readTerminalRecord(jobPath);
    } catch (err) {
      log?.error?.(`[comment-delivery] cannot parse ${jobPath}: ${err.message}`);
      continue;
    }
    const delivery = record.commentDelivery;
    if (!delivery || delivery.posted) continue;
    if ((delivery.attempts || 0) >= maxAttempts) continue;
    if (NON_RETRYABLE_DELIVERY_REASONS.has(delivery.reason)) continue;
    candidates.push({ jobPath, delivery, record });
  }
  candidates.sort((a, b) => {
    const aT = Date.parse(a.delivery.firstAttemptAt || '') || 0;
    const bT = Date.parse(b.delivery.firstAttemptAt || '') || 0;
    return aT - bT;
  });
  return candidates;
}

// Scan terminal records and retry up to `budget` failed comment
// deliveries per call. Bounded so a backlog (e.g. during a GitHub
// outage) doesn't starve the live consume/reconcile pipeline.
//
// Idempotent against concurrent ticks: each retry acquires the
// delivery claim lock before posting; another process holding the
// claim will be skipped (counted as `skipped` not `failed`).
//
// Returns { scanned, candidates, retried, posted, failed, skipped }.
async function retryFailedCommentDeliveries({
  rootDir = ROOT,
  postCommentImpl = postRemediationOutcomeComment,
  now = () => new Date().toISOString(),
  log = console,
  maxAttempts = MAX_COMMENT_DELIVERY_ATTEMPTS,
  budget = RETRY_BUDGET_PER_TICK,
} = {}) {
  const candidates = listRetryCandidates(rootDir, { maxAttempts, log });
  const scanned = candidates.length;
  let retried = 0;
  let posted = 0;
  let failed = 0;
  let skipped = 0;

  for (const { jobPath, delivery } of candidates) {
    if (retried >= budget) {
      // Remaining candidates wait until the next tick. They stay in
      // the candidate list forever (subject to maxAttempts), so this
      // is purely a per-tick rate limit, not an eviction policy.
      break;
    }

    // Claim BEFORE re-reading the record + posting. Another process
    // currently delivering this record will hold the claim; skip
    // those without counting as failure.
    const claimerId = buildClaimerId();
    const claim = tryAcquireDeliveryClaim(jobPath, claimerId, { now });
    if (!claim.acquired) {
      skipped += 1;
      continue;
    }

    retried += 1;
    /* eslint-disable no-await-in-loop */
    let result;
    try {
      result = await postCommentImpl({
        repo: delivery.repo,
        prNumber: delivery.prNumber,
        workerClass: delivery.workerClass,
        body: delivery.body,
        log,
      });
    } catch (err) {
      // Poster impl threw — synthesize a failure result so we still
      // stamp the record (and the lock gets released in finally
      // below). Without this, a buggy poster would leave the record
      // in `attempting=true` until the lock goes stale.
      result = { posted: false, reason: 'gh-cli-failure', error: err.message };
    }
    /* eslint-enable no-await-in-loop */

    const attemptedAt = now();
    let record;
    try {
      record = readTerminalRecord(jobPath);
    } catch (err) {
      log.error?.(`[comment-delivery] failed to re-read ${jobPath} for update: ${err.message}`);
      releaseDeliveryClaim(jobPath);
      if (result?.posted) posted += 1; else failed += 1;
      continue;
    }
    const previous = record.commentDelivery || delivery;
    record.commentDelivery = {
      ...previous,
      attempts: (previous.attempts || 0) + 1,
      lastAttemptAt: attemptedAt,
      attempting: false,
      posted: Boolean(result?.posted),
      reason: result?.posted ? null : (result?.reason || previous.reason || 'unknown'),
      error: result?.error || null,
      timeoutMs: result?.timeoutMs ?? null,
    };
    try {
      writeTerminalRecord(jobPath, record);
    } catch (err) {
      log.error?.(`[comment-delivery] failed to update ${jobPath}: ${err.message}`);
    } finally {
      releaseDeliveryClaim(jobPath);
    }

    if (result?.posted) posted += 1;
    else failed += 1;
  }

  return { scanned, retried, posted, failed, skipped, budget };
}

export {
  MAX_COMMENT_DELIVERY_ATTEMPTS,
  RETRY_BUDGET_PER_TICK,
  DELIVERY_CLAIM_STALE_MS,
  NON_RETRYABLE_DELIVERY_REASONS,
  buildPendingDelivery,
  buildAttemptingDelivery,
  recordInitialCommentDelivery,
  retryFailedCommentDeliveries,
  tryAcquireDeliveryClaim,
  releaseDeliveryClaim,
  deliveryLockPath,
};
