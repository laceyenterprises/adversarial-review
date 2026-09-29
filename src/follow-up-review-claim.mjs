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
// durable evidence is the job itself: an existing job for that review makes a
// later request a duplicate. The two queuers run in different processes, so a
// short-lived exclusive claim file closes the window between that scan and the
// job write; the claim is removed once the job exists, so claims do not pile up.
// A claim abandoned by a crashed creator goes stale and is taken over.
import { createHash } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { writeFileAtomic } from './atomic-write.mjs';
import { scanPrFollowUpJobs } from './comment-only-final-round.mjs';

const SHA = /^[0-9a-f]{40}$/iu;
const FOLLOW_UP_STATUS_DIRS = ['pending', 'in-progress', 'completed', 'failed', 'stopped'];
export const REVIEW_CLAIM_STALE_MS = 10 * 60 * 1000;
export const DUPLICATE_REVIEW_FOLLOW_UP = 'duplicate-review-follow-up';

export function reviewBodyDigest(reviewBody) {
  const normalized = String(reviewBody ?? '').replace(/\r\n/gu, '\n').trim();
  return normalized ? createHash('sha256').update(normalized).digest('hex') : null;
}

function findFollowUpForReview(rootDir, { repo, prNumber, revisionRef, digest }, log) {
  for (const status of FOLLOW_UP_STATUS_DIRS) {
    const match = scanPrFollowUpJobs(rootDir, status, repo, prNumber, log).find((job) => (
      String(job.revisionRef || '').trim() === revisionRef && reviewBodyDigest(job.reviewBody) === digest
    ));
    if (match) return { jobId: match.jobId || null, status };
  }
  return null;
}

function claimPathFor(rootDir, { repo, prNumber, revisionRef, digest }) {
  const safeRepo = String(repo || '').replace(/\//gu, '__').replace(/[^a-zA-Z0-9_.-]/gu, '-');
  return join(rootDir, 'data', 'follow-up-jobs', 'review-claims',
    `${safeRepo}-pr-${Number(prNumber)}-${revisionRef}-${digest.slice(0, 16)}.json`);
}

/**
 * Claim the right to create the follow-up job for `job`'s review.
 *
 * Returns `{ duplicateOf }` when a job for the same review already exists or
 * another creator holds a fresh claim, else `{ release }` to call once the job
 * write has finished (or failed). A job that cannot be keyed (no reviewed SHA or
 * no body) is not de-duplicated.
 */
export function claimFollowUpForReview(rootDir, job, { now = Date.now(), log = console } = {}) {
  const revisionRef = String(job?.revisionRef || '').trim();
  const digest = reviewBodyDigest(job?.reviewBody);
  if (!SHA.test(revisionRef) || !digest || !job?.repo) return { release() {} };
  const review = { repo: job.repo, prNumber: job.prNumber, revisionRef, digest };
  const existing = findFollowUpForReview(rootDir, review, log);
  if (existing) return { duplicateOf: existing };

  const claimPath = claimPathFor(rootDir, review);
  const body = `${JSON.stringify({ ...review, claimedAt: new Date(now).toISOString(), pid: process.pid })}\n`;
  try {
    writeFileAtomic(claimPath, body, { overwrite: false });
  } catch (err) {
    if (err?.code !== 'EEXIST') throw err;
    let held = null;
    try {
      held = JSON.parse(readFileSync(claimPath, 'utf8'));
    } catch {
      // Unreadable claim: treat it as abandoned below.
    }
    const heldAtMs = Date.parse(held?.claimedAt || '');
    if (Number.isFinite(heldAtMs) && now - heldAtMs < REVIEW_CLAIM_STALE_MS) {
      return { duplicateOf: { claimedAt: held.claimedAt, inFlight: true } };
    }
    log.warn?.(`[follow-up-jobs] Taking over an abandoned follow-up claim for ${job.repo}#${job.prNumber}@${revisionRef.slice(0, 12)}`);
    writeFileAtomic(claimPath, body, { overwrite: true });
  }
  const release = () => rmSync(claimPath, { force: true });
  // A creator that finished between our scan and our claim removed its claim
  // after writing its job; the re-scan sees that job.
  const raced = findFollowUpForReview(rootDir, review, log);
  if (raced) {
    release();
    return { duplicateOf: raced };
  }
  return { release };
}
