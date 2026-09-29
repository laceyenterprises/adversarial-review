// COMMENTCLOSE-01 item 5: one follow-up job per posted review.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { archiveStoppedFollowUpJobs, createFollowUpJob, getFollowUpJobDir } from '../src/follow-up-jobs.mjs';
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

function claimFiles(rootDir) {
  const dir = join(rootDir, 'data', 'follow-up-jobs', 'review-claims');
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

function writeJob(rootDir, status, jobId, overrides = {}) {
  const dir = getFollowUpJobDir(rootDir, status);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `laceyenterprises__agent-os-pr-7311-${jobId}.json`), JSON.stringify({
    jobId, status, repo: REPO, prNumber: 7311, revisionRef: HEAD, reviewBody: BODY, ...overrides,
  }));
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

  // And after the daemon's archive sweep moves it to stopped-archived/<month>/.
  const sweep = archiveStoppedFollowUpJobs({ rootDir, nowMs: Date.now() + 2 * 24 * 60 * 60 * 1000 });
  assert.equal(sweep.archived, 1);
  assert.deepEqual(createFollowUpJob({ rootDir, ...input() }).duplicateOf,
    { jobId: first.job.jobId, status: 'stopped-archived' });
  assert.equal(pendingFiles(rootDir).length, 0);
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

test('a fresh claim held by a live creator is waited on, not reported as a duplicate', (t) => {
  const rootDir = tempRoot(t);
  const job = { repo: REPO, prNumber: 7311, revisionRef: HEAD, reviewBody: BODY };
  const held = claimFollowUpForReview(rootDir, job);
  assert.equal(typeof held.release, 'function');
  let sleeps = 0;
  const waiter = claimFollowUpForReview(rootDir, job, {
    log: { warn() {} },
    // The holder finishes its job write while the waiter polls.
    sleep: () => { sleeps += 1; writeJob(rootDir, 'pending', 'held-job'); held.release(); },
  });
  assert.equal(sleeps, 1);
  assert.deepEqual(waiter.duplicateOf, { jobId: 'held-job', status: 'pending' });
});

test('a holder that releases without writing a job lets the waiter create it', (t) => {
  const rootDir = tempRoot(t);
  const job = { repo: REPO, prNumber: 7311, revisionRef: HEAD, reviewBody: BODY };
  const held = claimFollowUpForReview(rootDir, job);
  const waiter = claimFollowUpForReview(rootDir, job, { log: { warn() {} }, sleep: () => held.release() });
  assert.equal(waiter.duplicateOf, undefined);
  assert.equal(claimFiles(rootDir).length, 1);
  waiter.release();
  assert.equal(claimFiles(rootDir).length, 0);
});

test('a claim whose creator exited, went stale, or is unreadable is taken over', (t) => {
  const rootDir = tempRoot(t);
  const job = { repo: REPO, prNumber: 7311, revisionRef: HEAD, reviewBody: BODY };
  const held = claimFollowUpForReview(rootDir, job);
  const warnings = [];
  const noSleep = () => assert.fail('an abandoned claim is not waited on');
  const exited = claimFollowUpForReview(rootDir, job, {
    isProcessAlive: () => false, sleep: noSleep, log: { warn: (line) => warnings.push(line) },
  });
  assert.equal(exited.duplicateOf, undefined);
  assert.match(warnings[0], /Taking over an abandoned follow-up claim .*\(holder-exited\)/);
  const later = Date.now() + REVIEW_CLAIM_STALE_MS + 1;
  const stale = claimFollowUpForReview(rootDir, job, {
    clock: () => later, sleep: noSleep, log: { warn: (line) => warnings.push(line) },
  });
  assert.match(warnings[1], /\(stale\)/);
  // Neither superseded holder can remove the current holder's claim.
  held.release();
  exited.release();
  assert.equal(claimFiles(rootDir).length, 1);
  assert.match(claimFiles(rootDir)[0], /\.g2\.json$/u);
  stale.release();
  assert.equal(claimFiles(rootDir).length, 0);
});

test('concurrent creators recovering one stale claim queue exactly one job', async (t) => {
  const rootDir = tempRoot(t);
  const claimsDir = join(rootDir, 'data', 'follow-up-jobs', 'review-claims');
  mkdirSync(claimsDir, { recursive: true });
  const digest = createHash('sha256').update(BODY.trim()).digest('hex');
  writeFileSync(join(claimsDir, `laceyenterprises__agent-os-pr-7311-${HEAD}-${digest.slice(0, 16)}.g0.json`), JSON.stringify({
    repo: REPO, prNumber: 7311, revisionRef: HEAD, digest, token: 'crashed', pid: 1, host: 'elsewhere',
    claimedAt: new Date(Date.now() - REVIEW_CLAIM_STALE_MS - 1_000).toISOString(),
  }));
  const startAt = Date.now() + 750;
  const script = `
    import { createFollowUpJob } from ${JSON.stringify(new URL('../src/follow-up-jobs.mjs', import.meta.url).href)};
    console.warn = () => {};
    while (Date.now() < ${startAt}) {}
    const result = createFollowUpJob({ rootDir: ${JSON.stringify(rootDir)}, ...${JSON.stringify(input())} });
    process.stdout.write(JSON.stringify({ created: Boolean(result.jobPath), duplicateOf: result.duplicateOf ?? null }));
  `;
  const results = await Promise.all(Array.from({ length: 6 }, () => new Promise((resolve, reject) => {
    execFile(process.execPath, ['--input-type=module', '-e', script], { timeout: 30_000 }, (err, stdout) => (
      err ? reject(err) : resolve(JSON.parse(stdout))
    ));
  })));
  assert.equal(results.filter((result) => result.created).length, 1);
  assert.ok(results.filter((result) => !result.created).every((result) => result.duplicateOf?.status === 'pending'));
  assert.equal(pendingFiles(rootDir).length, 1);
  assert.equal(claimFiles(rootDir).length, 0);
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
  first.release();
  second.release();
  assert.equal(claimFiles(rootDir).length, 0);
});
