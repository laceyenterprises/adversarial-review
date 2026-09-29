// COMMENTCLOSE-01: queue one follow-up per posted review.
//
// The reviewer process queues a follow-up when it posts a review, and the
// watcher's reviewer-pass reaper queues one when it recovers a pass that posted
// but never settled. For agent-os#7311 both fired for the SAME review, 9 s apart
// (byte-identical bodies, same reviewed head). The second job was stopped as
// `stale-review-head` after the first one pushed, and a duplicate final-round job
// sat beside the real one in the ledger.
//
// A review is identified by (repo, PR, reviewed head, digest of its body). The
// durable evidence is the job itself: an existing job for that review (archived
// stopped jobs included) makes a later request a duplicate. The two queuers run
// in different processes, so a short-lived claim closes the window between that
// scan and the job write.
//
// The claim is a chain of generation files `<review>.g<N>.json`, each created
// exclusively; the holder is the highest generation. Taking over an abandoned
// holder (stale, its process gone, or unreadable) means exclusively creating the
// next generation, so concurrent recoverers of one abandoned claim have exactly
// one winner. Release is token-checked: only the current holder removes the
// chain, and a holder that was taken over removes only its own file.
//
// A claim held by a live creator is not a duplicate: no job exists yet. The
// caller waits for that creator to finish (its job appears), to release without
// a job, or to be abandoned, and only then decides. The reaper settles its pass
// before queueing, so reporting an in-flight claim as a duplicate would lose the
// follow-up for good if the holder then crashed.
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync, rmSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';

import { writeFileAtomic } from './atomic-write.mjs';
import { scanArchivedStoppedFollowUpJobs, scanPrFollowUpJobs } from './comment-only-final-round.mjs';

const SHA = /^[0-9a-f]{40}$/iu;
const FOLLOW_UP_STATUS_DIRS = ['pending', 'in-progress', 'completed', 'failed', 'stopped'];
// The claim only spans a synchronous job write, so a holder past this age is gone.
export const REVIEW_CLAIM_STALE_MS = 2 * 60 * 1000;
const REVIEW_CLAIM_POLL_MS = 100;
const REVIEW_CLAIM_MAX_WAIT_MS = 2 * REVIEW_CLAIM_STALE_MS;
export const DUPLICATE_REVIEW_FOLLOW_UP = 'duplicate-review-follow-up';
export const REVIEW_FOLLOW_UP_IN_FLIGHT = 'review-follow-up-in-flight';

export function reviewBodyDigest(reviewBody) {
  const normalized = String(reviewBody ?? '').replace(/\r\n/gu, '\n').trim();
  return normalized ? createHash('sha256').update(normalized).digest('hex') : null;
}

function findFollowUpForReview(rootDir, { repo, prNumber, revisionRef, digest }, log) {
  const sameReview = (job) => (
    String(job.revisionRef || '').trim() === revisionRef && reviewBodyDigest(job.reviewBody) === digest
  );
  for (const status of FOLLOW_UP_STATUS_DIRS) {
    const match = scanPrFollowUpJobs(rootDir, status, repo, prNumber, log).find(sameReview);
    if (match) return { jobId: match.jobId || null, status };
  }
  const archived = scanArchivedStoppedFollowUpJobs(rootDir, repo, prNumber, log).find(sameReview);
  return archived ? { jobId: archived.jobId || null, status: 'stopped-archived' } : null;
}

function claimLocation(rootDir, { repo, prNumber, revisionRef, digest }) {
  const safeRepo = String(repo || '').replace(/\//gu, '__').replace(/[^a-zA-Z0-9_.-]/gu, '-');
  return {
    dir: join(rootDir, 'data', 'follow-up-jobs', 'review-claims'),
    base: `${safeRepo}-pr-${Number(prNumber)}-${revisionRef}-${digest.slice(0, 16)}`,
  };
}

function claimGenerations({ dir, base }) {
  let names;
  try {
    names = readdirSync(dir);
  } catch (err) {
    if (err?.code === 'ENOENT') return [];
    throw err;
  }
  const prefix = `${base}.g`;
  return names.flatMap((name) => {
    if (!name.startsWith(prefix) || !name.endsWith('.json')) return [];
    const gen = name.slice(prefix.length, -'.json'.length);
    return /^\d+$/u.test(gen) ? [{ gen: Number(gen), path: join(dir, name) }] : [];
  }).sort((a, b) => a.gen - b.gen);
}

const MISSING = Symbol('missing');

function readClaim(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    return err?.code === 'ENOENT' ? MISSING : null;
  }
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

const sleepCell = new Int32Array(new SharedArrayBuffer(4));
function sleepSync(ms) {
  Atomics.wait(sleepCell, 0, 0, ms);
}

function abandonedReason(held, nowMs, { host, isProcessAlive }) {
  const heldAtMs = Date.parse(held?.claimedAt || '');
  if (!held || !Number.isFinite(heldAtMs)) return 'unreadable';
  if (nowMs - heldAtMs >= REVIEW_CLAIM_STALE_MS) return 'stale';
  if (held.host === host && Number.isInteger(held.pid) && !isProcessAlive(held.pid)) return 'holder-exited';
  return null;
}

function releaseClaim(location, gen, token) {
  const generations = claimGenerations(location);
  const own = generations.find((entry) => entry.gen === gen);
  if (!own || readClaim(own.path)?.token !== token) return;
  // Taken over while we held it: the successor owns the chain; drop only our file.
  if (generations.at(-1).gen === gen) {
    for (const entry of generations) if (entry.gen < gen) rmSync(entry.path, { force: true });
  }
  rmSync(own.path, { force: true });
}

/**
 * Claim the right to create the follow-up job for `job`'s review.
 *
 * Returns `{ duplicateOf }` only when a job for the same review exists, else
 * `{ release }` to call once the job write has finished (or failed). While
 * another live creator holds the claim, this waits (synchronously; the holder's
 * critical section is one job write) until that creator's job appears, it
 * releases, or it is abandoned. Throws `REVIEW_FOLLOW_UP_IN_FLIGHT` if that
 * never resolves within twice the stale window. A job that cannot be keyed (no
 * reviewed SHA or no body) is not de-duplicated.
 */
export function claimFollowUpForReview(rootDir, job, {
  clock = Date.now,
  sleep = sleepSync,
  isProcessAlive = processIsAlive,
  host = hostname(),
  log = console,
} = {}) {
  const revisionRef = String(job?.revisionRef || '').trim();
  const digest = reviewBodyDigest(job?.reviewBody);
  if (!SHA.test(revisionRef) || !digest || !job?.repo) return { release() {} };
  const review = { repo: job.repo, prNumber: job.prNumber, revisionRef, digest };
  const label = `${job.repo}#${job.prNumber}@${revisionRef.slice(0, 12)}`;
  const location = claimLocation(rootDir, review);
  const token = randomUUID();
  const startedAt = clock();
  let waiting = false;
  for (;;) {
    const existing = findFollowUpForReview(rootDir, review, log);
    if (existing) return { duplicateOf: existing };
    const tail = claimGenerations(location).at(-1);
    let gen = 0;
    if (tail) {
      const held = readClaim(tail.path);
      if (held === MISSING) continue;
      const abandoned = abandonedReason(held, clock(), { host, isProcessAlive });
      if (!abandoned) {
        if (clock() - startedAt >= REVIEW_CLAIM_MAX_WAIT_MS) {
          const err = new Error(`[follow-up-jobs] Follow-up for ${label} is still being created by pid ${held.pid} on ${held.host}; not queued by this caller`);
          err.code = REVIEW_FOLLOW_UP_IN_FLIGHT;
          throw err;
        }
        if (!waiting) log.warn?.(`[follow-up-jobs] Waiting for the in-flight follow-up claim for ${label} (pid ${held.pid} on ${held.host})`);
        waiting = true;
        sleep(REVIEW_CLAIM_POLL_MS);
        continue;
      }
      log.warn?.(`[follow-up-jobs] Taking over an abandoned follow-up claim for ${label} (${abandoned})`);
      gen = tail.gen + 1;
    }
    const path = join(location.dir, `${location.base}.g${gen}.json`);
    const body = { ...review, token, claimedAt: new Date(clock()).toISOString(), pid: process.pid, host };
    try {
      writeFileAtomic(path, `${JSON.stringify(body)}\n`, { overwrite: false });
    } catch (err) {
      if (err?.code === 'EEXIST') continue; // another creator won this generation
      throw err;
    }
    // A generation recreated after its chain was released is not the holder
    // while a higher generation still exists; yield and re-read.
    if (claimGenerations(location).at(-1)?.gen !== gen) {
      rmSync(path, { force: true });
      sleep(REVIEW_CLAIM_POLL_MS);
      continue;
    }
    const release = () => releaseClaim(location, gen, token);
    // A creator that finished between our scan and our claim released its claim
    // after writing its job; the re-scan sees that job.
    const raced = findFollowUpForReview(rootDir, review, log);
    if (raced) {
      release();
      return { duplicateOf: raced };
    }
    return { release };
  }
}
