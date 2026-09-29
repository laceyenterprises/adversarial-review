// COMMENTCLOSE-01 item 5: one follow-up job per posted review.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createFollowUpJob, getFollowUpJobDir } from '../src/follow-up-jobs.mjs';
import {
  DUPLICATE_REVIEW_FOLLOW_UP,
  REVIEW_CLAIM_STALE_MS,
  claimFollowUpForReview,
} from '../src/follow-up-review-claim.mjs';
import { queueFollowUpForRecoveredPostedReview } from '../src/reviewer-pass-reaper.mjs';
import { __test__ as reviewerInternals } from '../src/reviewer.mjs';

const { queueFollowUpForPostedReview } = reviewerInternals;

const REPO = 'laceyenterprises/agent-os';
const HEAD = '0a48d65166b3a88b51ed93452de3a0871defe2cb';
const BODY = [
  '## Summary', 'Retry the RTK download.', '',
  '## Blocking issues', '- None.', '',
  '## Non-blocking issues', '- **Transient network failures are unhandled**', '',
  '## Verdict', 'Comment only',
].join('\n');

function input(overrides = {}) {
  return {
    repo: REPO, prNumber: 7311, baseBranch: 'main', revisionRef: HEAD, reviewerModel: 'gemini',
    reviewBody: BODY, reviewPostedAt: '2026-09-28T21:34:26.162Z', critical: false, ...overrides,
  };
}

function pendingFiles(rootDir) {
  const dir = getFollowUpJobDir(rootDir, 'pending');
  return existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith('.json')) : [];
}

function tempRoot(t) {
  const rootDir = mkdtempSync(join(tmpdir(), 'review-claim-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  return rootDir;
}

test('a second request for the same review (reviewer, then reaper) creates no second job', (t) => {
  const rootDir = tempRoot(t);
  const first = createFollowUpJob({ rootDir, ...input() });
  assert.ok(first.jobPath);
  // The reaper recovers the same pass: same head, same body, its own timestamp and model label.
  const second = createFollowUpJob({ rootDir, ...input({ reviewPostedAt: '2026-09-28T21:34:17.895Z', reviewerModel: 'Gemini 3.1 Pro (High)' }) });
  assert.equal(second.jobPath, null);
  assert.deepEqual(second.duplicateOf, { jobId: first.job.jobId, status: 'pending' });
  assert.equal(pendingFiles(rootDir).length, 1);
  assert.equal(existsSync(join(rootDir, 'data', 'follow-up-jobs', 'review-claims')) &&
    readdirSync(join(rootDir, 'data', 'follow-up-jobs', 'review-claims')).length, 0, 'claims are released once the job exists');

  // Still a duplicate after the first job moved to a terminal directory.
  const stoppedDir = getFollowUpJobDir(rootDir, 'stopped');
  mkdirSync(stoppedDir, { recursive: true });
  renameSync(first.jobPath, join(stoppedDir, `${first.job.jobId}.json`));
  assert.equal(createFollowUpJob({ rootDir, ...input() }).duplicateOf.status, 'stopped');
});

test('a different review of the same head, or an unkeyed review, still gets its own job', (t) => {
  const rootDir = tempRoot(t);
  createFollowUpJob({ rootDir, ...input() });
  const other = createFollowUpJob({ rootDir, ...input({ reviewBody: BODY.replace('Comment only', 'Request changes') }) });
  assert.ok(other.jobPath);
  const unkeyedA = createFollowUpJob({ rootDir, ...input({ revisionRef: null }) });
  const unkeyedB = createFollowUpJob({ rootDir, ...input({ revisionRef: null }) });
  assert.ok(unkeyedA.jobPath && unkeyedB.jobPath);
});

test('a fresh claim held by another creator is a duplicate; an abandoned one is taken over', (t) => {
  const rootDir = tempRoot(t);
  const job = { repo: REPO, prNumber: 7311, revisionRef: HEAD, reviewBody: BODY };
  const now = Date.parse('2026-09-28T21:34:20.000Z');
  const held = claimFollowUpForReview(rootDir, job, { now });
  assert.equal(typeof held.release, 'function');
  const racing = claimFollowUpForReview(rootDir, job, { now: now + 9_000 });
  assert.deepEqual(racing.duplicateOf, { claimedAt: new Date(now).toISOString(), inFlight: true });
  const warnings = [];
  const late = claimFollowUpForReview(rootDir, job, {
    now: now + REVIEW_CLAIM_STALE_MS + 1, log: { warn: (line) => warnings.push(line) },
  });
  assert.equal(late.duplicateOf, undefined);
  assert.match(warnings[0], /Taking over an abandoned follow-up claim/);
  late.release();
  held.release();
});

test('the reaper reports a duplicate instead of queueing a second follow-up (#7311)', (t) => {
  const rootDir = tempRoot(t);
  const reviewerQueued = queueFollowUpForPostedReview({
    rootDir, repo: REPO, prNumber: 7311, baseBranch: 'main', reviewerModel: 'gemini', revisionRef: HEAD,
    reviewText: BODY, reviewPostedAt: '2026-09-28T21:34:26.162Z',
    resolveHandoffConfigImpl: () => ({ enabled: false }),
  });
  assert.equal(reviewerQueued.queued, true);
  const wakes = [];
  const reaped = queueFollowUpForRecoveredPostedReview({
    rootDir,
    row: {
      repo: REPO, pr_number: 7311, head_sha: HEAD, body_md: BODY, reviewer_model: 'Gemini 3.1 Pro (High)',
      ended_at: '2026-09-28T21:34:17.895Z', metadata_json: '{}',
    },
    reviewPostedAt: '2026-09-28T21:34:17.895Z',
    resolveHandoffConfigImpl: () => ({ enabled: true, reviewToRemediation: true }),
    signalFollowUpDaemonWakeImpl: (wake) => { wakes.push(wake); return {}; },
  });
  assert.equal(reaped.queued, false);
  assert.equal(reaped.reason, DUPLICATE_REVIEW_FOLLOW_UP);
  assert.equal(reaped.duplicateOf.jobId, reviewerQueued.jobPath.split('/').at(-1).replace(/\.json$/u, ''));
  assert.equal(wakes.length, 0);
  assert.equal(pendingFiles(rootDir).length, 1);

  // And the reverse order: the reviewer reports the duplicate as skipped.
  const second = queueFollowUpForPostedReview({
    rootDir, repo: REPO, prNumber: 7311, baseBranch: 'main', reviewerModel: 'gemini', revisionRef: HEAD,
    reviewText: BODY, resolveHandoffConfigImpl: () => ({ enabled: false }),
  });
  assert.equal(second.queued, false);
  assert.equal(second.reason, DUPLICATE_REVIEW_FOLLOW_UP);
});

test('an unreadable claim is treated as abandoned', (t) => {
  const rootDir = tempRoot(t);
  const job = { repo: REPO, prNumber: 7311, revisionRef: HEAD, reviewBody: BODY };
  const first = claimFollowUpForReview(rootDir, job);
  const claimsDir = join(rootDir, 'data', 'follow-up-jobs', 'review-claims');
  const [claimName] = readdirSync(claimsDir);
  writeFileSync(join(claimsDir, claimName), '{broken');
  const second = claimFollowUpForReview(rootDir, job, { log: { warn() {} } });
  assert.equal(second.duplicateOf, undefined);
  second.release();
  first.release();
});
