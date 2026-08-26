// ASR-03 — the Argus security review queue.
//
// A dedicated on-disk queue for security review work, deliberately SEPARATE
// from `data/follow-up-jobs/`. The separation is the point: a backlog of
// code-review follow-ups must never starve a security review, and a burst of
// security reviews must never starve remediation. Sharing one queue couples
// those two failure modes into one, and the operator asked for them uncoupled.
//
// What is NOT separate is the shape. This module follows the
// `follow-up-jobs.mjs` conventions exactly — `pending` / `in-progress` /
// `completed` / `failed` buckets under a single root, one JSON record per job,
// atomic write-once creation, rename-as-CAS for bucket transitions, per-file
// fail-soft reads, and a newest-N cap on record reads. Operator tooling and
// debugging habits (`ls data/*/pending | wc -l`, `cat` a job record, move a
// file back to `pending` by hand) transfer unchanged.
//
// ---------------------------------------------------------------------------
// Idempotency has two halves, and both are load-bearing.
// ---------------------------------------------------------------------------
//
//   1. SAME head must not re-enqueue. The watcher re-polls the same open PR
//      every tick; without this, one PR would accrue one security review per
//      tick forever.
//
//   2. NEW head MUST re-enqueue. This half is not an optimisation — it is the
//      safety property. A security review is bound to the exact tree it read:
//      it concluded "this lockfile adds no install scripts" about one specific
//      set of bytes. A new commit can add exactly that install script. Reusing
//      the old verdict means approving a tree nobody read, which is the failure
//      this queue exists to prevent.
//
// Both halves fall out of one decision: the job identity — and therefore the
// filename — is `(repo, prNumber, headSha)`. Same head resolves to the same
// filename, so the write-once create returns EEXIST and the enqueue is a
// no-op. A new head is a different filename, so it enqueues. The filesystem
// enforces it; no scan, no lock, no read-modify-write window.
//
// The full head SHA goes in the filename, not an abbreviation. Two heads that
// share a 12-character prefix would otherwise collapse into one job, and the
// second tree would inherit a verdict written about the first.

import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import { writeFileAtomic } from './atomic-write.mjs';

export const ARGUS_JOB_SCHEMA_VERSION = 1;
export const ARGUS_JOB_KIND = 'argus-security-review';

// Sibling of `data/follow-up-jobs/`, never a subdirectory of it: a recursive
// operator sweep over the follow-up root must not touch security work.
export const ARGUS_QUEUE_ROOT_DIR_NAME = 'argus-security-jobs';

const ARGUS_JOB_DIRS = Object.freeze({
  pending: ['data', ARGUS_QUEUE_ROOT_DIR_NAME, 'pending'],
  inProgress: ['data', ARGUS_QUEUE_ROOT_DIR_NAME, 'in-progress'],
  completed: ['data', ARGUS_QUEUE_ROOT_DIR_NAME, 'completed'],
  failed: ['data', ARGUS_QUEUE_ROOT_DIR_NAME, 'failed'],
});

// Bucket keys in lifecycle order. `pending` and `inProgress` are the active
// buckets; `completed` and `failed` are terminal.
export const ARGUS_JOB_BUCKETS = Object.freeze(Object.keys(ARGUS_JOB_DIRS));
const ACTIVE_ARGUS_JOB_BUCKETS = Object.freeze(['pending', 'inProgress']);

// Newest-N cap on how many job RECORDS a single list call will parse, matching
// the follow-up convention that a debugging read of a terminal bucket does not
// turn into an unbounded parse of months of history.
//
// Depth counting is deliberately NOT capped — see `readArgusQueueDepth`. A cap
// on a depth read would silently report a stuck queue as a healthy one, which
// is the exact observability failure the depth read exists to prevent.
const DEFAULT_ARGUS_JOB_READ_CAP = 200;

const HEAD_SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

function sanitizeRepo(repo) {
  return String(repo ?? '').replace(/\//gu, '__').replace(/[^a-zA-Z0-9_.-]/gu, '-');
}

function normalizeRepo(repo) {
  const normalized = String(repo ?? '').trim();
  if (!normalized) {
    throw new Error('argus-security-queue: repo is required');
  }
  return normalized;
}

function normalizePrNumber(prNumber) {
  const normalized = Number(prNumber);
  if (!Number.isInteger(normalized) || normalized <= 0) {
    throw new Error(`argus-security-queue: prNumber must be a positive integer (got ${JSON.stringify(prNumber)})`);
  }
  return normalized;
}

// Fail loud on anything that is not a full object name. An abbreviated SHA is
// not a weaker identity, it is a DIFFERENT identity: `abc1234` and its own
// 40-character expansion would enqueue as two jobs, and two distinct heads
// sharing a prefix would enqueue as one. Both directions are wrong, and the
// second direction silently skips a security review, so this refuses rather
// than guessing.
function normalizeHeadSha(headSha) {
  const normalized = String(headSha ?? '').trim().toLowerCase();
  if (!HEAD_SHA_PATTERN.test(normalized)) {
    throw new Error(
      'argus-security-queue: headSha must be a full 40- or 64-character hex commit SHA '
        + `(got ${JSON.stringify(headSha)})`
    );
  }
  return normalized;
}

// A security job with no reasons has lost the "why" — which trigger fired is
// what the reviewer specialises on (a bot-author review reads a lockfile diff,
// a sensitive-path review reads an auth change). An empty reason list would
// enqueue a review nobody can scope, so it is refused at the door.
function normalizeReasons(reasons) {
  if (!Array.isArray(reasons) || reasons.length === 0) {
    throw new Error('argus-security-queue: reasons must be a non-empty array of ASR-02 trigger reasons');
  }

  return reasons.map((reason, index) => {
    if (!reason || typeof reason !== 'object' || Array.isArray(reason)) {
      throw new Error(`argus-security-queue: reasons[${index}] must be an object`);
    }
    if (typeof reason.trigger !== 'string' || !reason.trigger.trim()) {
      throw new Error(`argus-security-queue: reasons[${index}].trigger must be a non-empty string`);
    }
    // Round-trip through JSON so the persisted record cannot carry anything
    // that would not survive a write/read cycle, and so the queue holds a copy
    // the caller cannot mutate afterwards. The reason payload itself is
    // recorded verbatim: this queue stores ASR-02's triggers and never
    // reinterprets them, so a trigger added later persists without a change
    // here. Severity is ASR-05's; there is none in this record.
    return JSON.parse(JSON.stringify(reason));
  });
}

function normalizeIsoTimestamp(value, { fallback } = {}) {
  const normalized = String(value ?? '').trim();
  if (!normalized) return fallback;
  const parsed = Date.parse(normalized);
  if (!Number.isFinite(parsed)) {
    throw new Error(`argus-security-queue: invalid ISO timestamp ${JSON.stringify(value)}`);
  }
  return normalized;
}

export function getArgusJobDir(rootDir, bucket) {
  const parts = ARGUS_JOB_DIRS[bucket];
  if (!parts) {
    throw new Error(`Unknown argus job directory key: ${bucket}`);
  }
  return join(rootDir, ...parts);
}

export function ensureArgusJobDirs(rootDir) {
  ARGUS_JOB_BUCKETS.forEach((bucket) => {
    mkdirSync(getArgusJobDir(rootDir, bucket), { recursive: true });
  });
}

/**
 * The durable job identity: `(repo, prNumber, headSha)` and nothing else.
 * Deterministic, so the same triple always resolves to the same filename in
 * every bucket — that is what makes both halves of the idempotency contract
 * a filesystem property rather than a scan.
 */
export function buildArgusJobId({ repo, prNumber, headSha }) {
  return `${sanitizeRepo(normalizeRepo(repo))}-pr-${normalizePrNumber(prNumber)}-${normalizeHeadSha(headSha)}`;
}

// Case-insensitive on repo (GitHub treats `Org/Repo` and `org/repo` as one)
// and on the SHA. Used to prove that a file found at an existing job's path is
// genuinely the same subject rather than a filename collision.
function argusJobIdentityKey({ repo, prNumber, headSha }) {
  return `${String(repo ?? '').trim().toLowerCase()}#${prNumber}@${String(headSha ?? '').trim().toLowerCase()}`;
}

export function writeArgusJob(jobPath, job) {
  writeFileAtomic(jobPath, `${JSON.stringify(job, null, 2)}\n`);
}

export function readArgusJob(jobPath) {
  return JSON.parse(readFileSync(jobPath, 'utf8'));
}

export function buildArgusJob({ repo, prNumber, headSha, reasons, enqueuedAt, source = null }) {
  const normalizedRepo = normalizeRepo(repo);
  const normalizedPrNumber = normalizePrNumber(prNumber);
  const normalizedHeadSha = normalizeHeadSha(headSha);
  const normalizedReasons = normalizeReasons(reasons);
  const normalizedEnqueuedAt = normalizeIsoTimestamp(enqueuedAt, { fallback: new Date().toISOString() });

  return {
    schemaVersion: ARGUS_JOB_SCHEMA_VERSION,
    kind: ARGUS_JOB_KIND,
    status: 'pending',
    jobId: buildArgusJobId({ repo: normalizedRepo, prNumber: normalizedPrNumber, headSha: normalizedHeadSha }),
    repo: normalizedRepo,
    prNumber: normalizedPrNumber,
    // The exact tree this review is bound to. A review of this job is a
    // statement about THIS SHA and carries no authority over any other.
    headSha: normalizedHeadSha,
    reasons: normalizedReasons,
    enqueuedAt: normalizedEnqueuedAt,
    source: source ? String(source) : null,
    claimedAt: null,
    completedAt: null,
    failedAt: null,
  };
}

/**
 * Locate an existing job for `(repo, prNumber, headSha)` in ANY bucket.
 *
 * Four `existsSync` calls against a deterministic filename — no directory
 * scan, so this stays O(1) as terminal history grows. Searching every bucket
 * (not just `pending`) is what makes a re-poll a no-op after the job has
 * already been claimed or finished.
 *
 * @returns {{bucket: string, jobPath: string, job: object|null}|null}
 */
export function findArgusJob(rootDir, { repo, prNumber, headSha }) {
  const jobId = buildArgusJobId({ repo, prNumber, headSha });
  const fileName = `${jobId}.json`;

  for (const bucket of ARGUS_JOB_BUCKETS) {
    const jobPath = join(getArgusJobDir(rootDir, bucket), fileName);
    if (!existsSync(jobPath)) continue;

    let job = null;
    try {
      job = readArgusJob(jobPath);
    } catch (err) {
      // A record we cannot parse still occupies the identity. Report it as
      // present with a null record rather than re-enqueueing beside it and
      // running the review twice.
      console.error(`[argus-queue] unreadable job record at ${jobPath}: ${err?.message || err}`);
    }
    return { bucket, jobPath, job };
  }

  return null;
}

function assertSameSubject({ existing, repo, prNumber, headSha }) {
  if (!existing?.job) return;

  const wanted = argusJobIdentityKey({ repo, prNumber, headSha });
  const found = argusJobIdentityKey(existing.job);
  if (wanted === found) return;

  // Two different subjects cannot share a filename for any real GitHub repo
  // (logins and repo names have no characters that `sanitizeRepo` folds
  // together). If it ever happens, treating the collision as a duplicate would
  // silently skip a security review, so refuse instead.
  throw new Error(
    `argus-security-queue: job id collision at ${existing.jobPath} — `
      + `record is ${found}, enqueue is ${wanted}`
  );
}

/**
 * Close the check-then-create window.
 *
 * Between the pre-check and the create, a concurrent consumer can claim the
 * same job out of `pending` into `in-progress` — so the pre-check finds it in
 * neither place and the create succeeds, leaving two copies of one job and two
 * security reviews of one tree. Re-checking the non-pending buckets after the
 * create catches that ordering: if the job turned up in one of them, the copy
 * just written to `pending` is removed.
 *
 * Removing it is safe because the filename is derived from the job identity
 * and is unique to it — the only record that can be at `jobPath` is the one
 * this enqueue just wrote.
 *
 * Exported for the race test, which cannot otherwise interleave the two steps.
 *
 * @returns {object|null} the duplicate result to return, or null if the create
 *   stands.
 */
export function resolveEnqueueRace({ rootDir, jobId, jobPath }) {
  for (const bucket of ARGUS_JOB_BUCKETS) {
    if (bucket === 'pending') continue;
    const otherPath = join(getArgusJobDir(rootDir, bucket), `${jobId}.json`);
    if (!existsSync(otherPath)) continue;

    rmSync(jobPath, { force: true });
    let otherJob = null;
    try {
      otherJob = readArgusJob(otherPath);
    } catch {}
    return { enqueued: false, outcome: 'duplicate', bucket, job: otherJob, jobPath: otherPath };
  }

  return null;
}

/**
 * Enqueue a security review for one PR head. Idempotent per
 * `(repo, prNumber, headSha)`; a new head always enqueues again.
 *
 * @returns {{enqueued: boolean, outcome: 'created'|'duplicate', bucket: string,
 *   job: object|null, jobPath: string}}
 *   `outcome: 'duplicate'` reports the bucket the existing job sits in, so a
 *   caller can tell "already queued" from "already reviewed".
 */
export function enqueueArgusSecurityReview({
  rootDir,
  repo,
  prNumber,
  headSha,
  reasons,
  enqueuedAt,
  source = null,
}) {
  const job = buildArgusJob({ repo, prNumber, headSha, reasons, enqueuedAt, source });
  const identity = { repo: job.repo, prNumber: job.prNumber, headSha: job.headSha };

  const existing = findArgusJob(rootDir, identity);
  if (existing) {
    assertSameSubject({ existing, ...identity });
    return { enqueued: false, outcome: 'duplicate', bucket: existing.bucket, job: existing.job, jobPath: existing.jobPath };
  }

  const pendingDir = getArgusJobDir(rootDir, 'pending');
  mkdirSync(pendingDir, { recursive: true });
  const jobPath = join(pendingDir, `${job.jobId}.json`);

  try {
    writeFileAtomic(jobPath, `${JSON.stringify(job, null, 2)}\n`, { overwrite: false });
  } catch (err) {
    if (err?.code !== 'EEXIST') throw err;
    // A concurrent poller won the create. The filename is the identity, so
    // whatever is there is this same job; report it as the duplicate it is.
    const raced = findArgusJob(rootDir, identity) || { bucket: 'pending', jobPath, job: null };
    return { enqueued: false, outcome: 'duplicate', bucket: raced.bucket, job: raced.job, jobPath: raced.jobPath };
  }

  return resolveEnqueueRace({ rootDir, jobId: job.jobId, jobPath })
    || { enqueued: true, outcome: 'created', bucket: 'pending', job, jobPath };
}

function listBucketEntries(rootDir, bucket) {
  const dir = getArgusJobDir(rootDir, bucket);
  if (!existsSync(dir)) return [];

  let names;
  try {
    names = readdirSync(dir).filter((name) => name.endsWith('.json'));
  } catch (err) {
    console.error(`[argus-queue] failed to list ${bucket} directory: ${err?.message || err}`);
    return [];
  }

  const entries = [];
  for (const name of names) {
    const jobPath = join(dir, name);
    let stat;
    try {
      stat = statSync(jobPath);
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err;
      // Raced away between readdir and stat (a concurrent claim). Skip.
      continue;
    }
    entries.push({ bucket, jobPath, mtimeMs: stat.mtimeMs });
  }
  return entries;
}

function countBucketRecords(rootDir, bucket) {
  const dir = getArgusJobDir(rootDir, bucket);
  try {
    return readdirSync(dir).filter((name) => name.endsWith('.json')).length;
  } catch (err) {
    if (err?.code !== 'ENOENT') {
      console.error(`[argus-queue] failed to count ${bucket} directory: ${err?.message || err}`);
    }
    return 0;
  }
}

/**
 * Job records from one bucket, newest-first, capped at `limit`.
 *
 * Ordering is by file mtime rather than by name: the filename is keyed on the
 * head SHA, so a lexical sort is not chronological. Per-file fail-soft — one
 * corrupt record cannot blank out the rest of the bucket.
 */
export function listArgusJobs(rootDir, { bucket = 'pending', limit = DEFAULT_ARGUS_JOB_READ_CAP } = {}) {
  const entries = listBucketEntries(rootDir, bucket)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, Math.max(0, limit));

  const jobs = [];
  for (const entry of entries) {
    try {
      jobs.push({ bucket: entry.bucket, jobPath: entry.jobPath, job: readArgusJob(entry.jobPath) });
    } catch (err) {
      console.error(`[argus-queue] skipping unreadable job record ${entry.jobPath}: ${err?.message || err}`);
    }
  }
  return jobs;
}

/**
 * Queue depth for Sentinel: how much security work is queued, being worked,
 * and finished, plus how long the oldest pending job has waited.
 *
 * Depth is counted from directory entries and is UNCAPPED and content-free —
 * no record is parsed to produce a count. Two consequences, both deliberate:
 * a corrupt job record still counts toward depth (it is still work sitting in
 * the queue), and a queue 10x past the read cap reports its real depth. A
 * capped depth read would report a stuck queue as a healthy one, which is
 * precisely the silence this read exists to break.
 *
 * `oldestPendingAgeMs` is the stuck-queue signal: a non-zero `pending` depth
 * is normal, a `pending` job that has aged for hours is not.
 */
export function readArgusQueueDepth(rootDir, { nowMs = Date.now() } = {}) {
  const depth = {};
  let total = 0;
  let active = 0;
  let oldestPendingEntry = null;

  for (const bucket of ARGUS_JOB_BUCKETS) {
    if (bucket !== 'pending') {
      const count = countBucketRecords(rootDir, bucket);
      depth[bucket] = count;
      total += count;
      if (ACTIVE_ARGUS_JOB_BUCKETS.includes(bucket)) active += count;
      continue;
    }

    const entries = listBucketEntries(rootDir, bucket);
    depth[bucket] = entries.length;
    total += entries.length;
    active += entries.length;

    for (const entry of entries) {
      if (!oldestPendingEntry || entry.mtimeMs < oldestPendingEntry.mtimeMs) {
        oldestPendingEntry = entry;
      }
    }
  }

  let oldestPending = null;
  if (oldestPendingEntry) {
    // One read, for the oldest entry only: `enqueuedAt` from the record is the
    // authoritative wait start (mtime only orders the candidates, and a repo
    // copy can rewrite it).
    let job = null;
    try {
      job = readArgusJob(oldestPendingEntry.jobPath);
    } catch {}
    const enqueuedAt = normalizeIsoTimestamp(job?.enqueuedAt, { fallback: null })
      || new Date(oldestPendingEntry.mtimeMs).toISOString();
    oldestPending = {
      jobId: job?.jobId || basename(oldestPendingEntry.jobPath, '.json'),
      repo: job?.repo || null,
      prNumber: job?.prNumber ?? null,
      headSha: job?.headSha || null,
      enqueuedAt,
      ageMs: Math.max(0, nowMs - Date.parse(enqueuedAt)),
    };
  }

  return {
    depth,
    total,
    active,
    oldestPendingAgeMs: oldestPending?.ageMs ?? null,
    oldestPending,
  };
}

/**
 * Claim the oldest pending job into `in-progress`.
 *
 * The rename IS the CAS: two consumers racing the same job means exactly one
 * rename succeeds and the loser sees ENOENT and moves on. Oldest-first so the
 * queue drains FIFO and no job can be starved by a steady arrival rate.
 *
 * @returns {{job: object, jobPath: string}|null}
 */
export function claimNextArgusJob({
  rootDir,
  claimedAt = new Date().toISOString(),
  writeJob = writeArgusJob,
} = {}) {
  const entries = listBucketEntries(rootDir, 'pending').sort((a, b) => a.mtimeMs - b.mtimeMs);
  const inProgressDir = getArgusJobDir(rootDir, 'inProgress');

  for (const entry of entries) {
    let job;
    try {
      job = readArgusJob(entry.jobPath);
    } catch (err) {
      console.error(`[argus-queue] skipping unreadable pending job ${entry.jobPath}: ${err?.message || err}`);
      continue;
    }

    mkdirSync(inProgressDir, { recursive: true });
    const inProgressPath = join(inProgressDir, basename(entry.jobPath));
    try {
      linkSync(entry.jobPath, inProgressPath);
    } catch (err) {
      if (err?.code === 'ENOENT') continue;
      if (err?.code === 'EEXIST') continue;
      throw err;
    }

    try {
      unlinkSync(entry.jobPath);
    } catch (err) {
      try {
        unlinkSync(inProgressPath);
      } catch {}
      if (err?.code === 'ENOENT') continue;
      throw err;
    }

    const claimed = { ...job, status: 'in_progress', claimedAt };
    try {
      writeJob(inProgressPath, claimed);
    } catch (err) {
      // The link/unlink pair above acquired the claim without overwriting an
      // active worker. If persisting the claimed status fails, restore the
      // original pending path so a later consumer can retry the job.
      try {
        renameSync(inProgressPath, entry.jobPath);
      } catch (rollbackErr) {
        console.error(
          `[argus-queue] failed to roll back claim ${inProgressPath} -> ${entry.jobPath}: `
            + `${rollbackErr?.message || rollbackErr}`
        );
      }
      throw err;
    }
    return { job: claimed, jobPath: inProgressPath };
  }

  return null;
}

function moveArgusJobToTerminalBucket({ rootDir, jobPath, bucket, patch }) {
  const job = readArgusJob(jobPath);
  const targetDir = getArgusJobDir(rootDir, bucket);
  mkdirSync(targetDir, { recursive: true });
  const targetPath = join(targetDir, basename(jobPath));

  // Rename first: moving the file is the ownership transfer, so a crash
  // between the two steps leaves the job in its terminal bucket with a stale
  // status rather than leaving a finished job claimable again.
  renameSync(jobPath, targetPath);
  const terminal = { ...job, ...patch };
  writeArgusJob(targetPath, terminal);
  return { job: terminal, jobPath: targetPath };
}

export function completeArgusJob({ rootDir, jobPath, completedAt = new Date().toISOString(), result = null }) {
  return moveArgusJobToTerminalBucket({
    rootDir,
    jobPath,
    bucket: 'completed',
    patch: { status: 'completed', completedAt, result: result ?? null },
  });
}

export function failArgusJob({ rootDir, jobPath, failedAt = new Date().toISOString(), error = null }) {
  return moveArgusJobToTerminalBucket({
    rootDir,
    jobPath,
    bucket: 'failed',
    patch: { status: 'failed', failedAt, error: error ? String(error) : null },
  });
}
