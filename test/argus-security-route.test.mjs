/** ASR-04 — route instead of terminating.
 *
 * `adversarial-review#909` and `#910` sat 14 hours unreviewed. Nothing failed;
 * nothing could route them. The lane resolves a reviewer from the worker-class
 * prefix in the PR title, a bot cannot produce one, so the disposition was a
 * TERMINAL `unroutable-bot-author` row: no reviewer, no retry, no escalation.
 * The PR was not rejected. It was dropped -- and `#909` was a major bump of the
 * native driver behind `reviews.db`, the database the review pipeline runs on.
 *
 * These tests pin the three properties that make that impossible to repeat.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  isArgusSecurityRouteEnabled,
  routeSecuritySurfaceToArgus,
  summarizeSecurityReasons,
} from '../src/argus-security-route.mjs';
import { listArgusJobs, readArgusQueueDepth } from '../src/argus-security-queue.mjs';

const REPO = 'laceyenterprises/adversarial-review';
const HEAD_A = 'a'.repeat(40);
const HEAD_B = 'b'.repeat(40);
const SILENT = { warn: () => {}, log: () => {}, error: () => {} };

function freshRoot() {
  return mkdtempSync(path.join(tmpdir(), 'argus-route-'));
}

function pendingJobs(rootDir) {
  return listArgusJobs(rootDir, { bucket: 'pending' });
}

// --------------------------------------------------------------------------
// The bug: a bot PR now reaches the queue.
// --------------------------------------------------------------------------

test('a bot-authored PR is enqueued rather than terminated', async () => {
  const rootDir = freshRoot();
  const result = await routeSecuritySurfaceToArgus({
    rootDir,
    repoPath: REPO,
    prNumber: 909,
    headSha: HEAD_A,
    authorRef: 'dependabot[bot]',
    fetchChangedFiles: async () => [{ filename: 'package-lock.json' }],
    logger: SILENT,
  });

  assert.equal(result.outcome, 'enqueued');
  assert.equal(result.queued, true, 'the review must actually be ON the queue');
  assert.equal(result.recordClassifiedHead, true);

  const jobs = pendingJobs(rootDir);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].job.repo, REPO);
  assert.equal(jobs[0].job.prNumber, 909);
  assert.equal(jobs[0].job.headSha, HEAD_A);
  // Both triggers survive as their own reason: ASR-05 specialises on which one
  // fired, so collapsing them into a boolean would lose the review's scope.
  assert.deepEqual(
    jobs[0].job.reasons.map((reason) => reason.trigger).sort(),
    ['bot-author', 'manifest-change'],
  );
});

test('a bare `dependabot` account is not a bot and raises no bot trigger', async () => {
  // The lookalike guard from ASR-02, re-asserted at the routing layer: routing a
  // human account as a bot would silently take its code review away.
  const rootDir = freshRoot();
  const result = await routeSecuritySurfaceToArgus({
    rootDir,
    repoPath: REPO,
    prNumber: 1,
    headSha: HEAD_A,
    authorRef: 'dependabot',
    fetchChangedFiles: async () => [{ filename: 'README.md' }],
    logger: SILENT,
  });

  assert.equal(result.outcome, 'no-trigger');
  assert.equal(result.queued, false);
  assert.equal(pendingJobs(rootDir).length, 0);
});

// --------------------------------------------------------------------------
// ADDITIVE: the manifest trigger routes on the file, not the author.
// --------------------------------------------------------------------------

test('a human PR touching a manifest is enqueued too', async () => {
  const rootDir = freshRoot();
  const result = await routeSecuritySurfaceToArgus({
    rootDir,
    repoPath: REPO,
    prNumber: 500,
    headSha: HEAD_A,
    authorRef: 'VirtualPaul',
    fetchChangedFiles: async () => [{ filename: 'src/watcher.mjs' }, { filename: 'package.json' }],
    logger: SILENT,
  });

  assert.equal(result.outcome, 'enqueued');
  assert.deepEqual(
    result.reasons.map((reason) => reason.trigger),
    ['manifest-change'],
    'no bot-author trigger for a human, and the dependency surface still routes',
  );
});

test('a human PR with no security surface is not enqueued at all', async () => {
  const rootDir = freshRoot();
  const result = await routeSecuritySurfaceToArgus({
    rootDir,
    repoPath: REPO,
    prNumber: 501,
    headSha: HEAD_A,
    authorRef: 'VirtualPaul',
    fetchChangedFiles: async () => [{ filename: 'docs/README.md' }],
    logger: SILENT,
  });

  assert.equal(result.outcome, 'no-trigger');
  assert.equal(result.queued, false);
  assert.equal(
    result.recordClassifiedHead,
    true,
    'a COMPLETE negative is memoized so the steady-state tick costs no API call',
  );
  assert.equal(readArgusQueueDepth(rootDir).total, 0);
});

// --------------------------------------------------------------------------
// HEAD-SCOPED: idempotent per head, mandatory re-enqueue on a new one.
// --------------------------------------------------------------------------

test('re-polling the same head does not duplicate the review', async () => {
  const rootDir = freshRoot();
  const call = () => routeSecuritySurfaceToArgus({
    rootDir,
    repoPath: REPO,
    prNumber: 909,
    headSha: HEAD_A,
    authorRef: 'dependabot[bot]',
    fetchChangedFiles: async () => [{ filename: 'package-lock.json' }],
    logger: SILENT,
  });

  assert.equal((await call()).outcome, 'enqueued');
  const second = await call();
  assert.equal(second.outcome, 'duplicate');
  assert.equal(second.queued, true);
  assert.equal(pendingJobs(rootDir).length, 1);
});

test('a NEW head enqueues again -- a verdict never carries across trees', async () => {
  // Not an optimisation, a safety property: a security review is a statement
  // about the exact tree it read, and reusing it on a new commit approves a tree
  // nobody looked at.
  const rootDir = freshRoot();
  const call = (headSha, lastClassifiedHeadSha) => routeSecuritySurfaceToArgus({
    rootDir,
    repoPath: REPO,
    prNumber: 909,
    headSha,
    lastClassifiedHeadSha,
    authorRef: 'dependabot[bot]',
    fetchChangedFiles: async () => [{ filename: 'package-lock.json' }],
    logger: SILENT,
  });

  await call(HEAD_A, null);
  const next = await call(HEAD_B, HEAD_A);
  assert.equal(next.outcome, 'enqueued');
  assert.equal(pendingJobs(rootDir).length, 2);
});

test('the classified-head memo skips the fetch but still reads the queue', async () => {
  const rootDir = freshRoot();
  let fetches = 0;
  const call = (lastClassifiedHeadSha) => routeSecuritySurfaceToArgus({
    rootDir,
    repoPath: REPO,
    prNumber: 909,
    headSha: HEAD_A,
    lastClassifiedHeadSha,
    authorRef: 'dependabot[bot]',
    fetchChangedFiles: async () => { fetches += 1; return [{ filename: 'package-lock.json' }]; },
    logger: SILENT,
  });

  await call(null);
  assert.equal(fetches, 1);

  const memoized = await call(HEAD_A);
  assert.equal(memoized.outcome, 'already-classified');
  assert.equal(fetches, 1, 'a steady-state tick must spend no GitHub call');
  assert.equal(
    memoized.queued,
    true,
    'queued is answered from the queue on disk, never assumed from the memo',
  );
});

test('the memo is compared case-insensitively, like the job identity', async () => {
  const rootDir = freshRoot();
  let fetches = 0;
  const result = await routeSecuritySurfaceToArgus({
    rootDir,
    repoPath: REPO,
    prNumber: 909,
    headSha: HEAD_A.toUpperCase(),
    lastClassifiedHeadSha: HEAD_A,
    authorRef: 'dependabot[bot]',
    fetchChangedFiles: async () => { fetches += 1; return []; },
    logger: SILENT,
  });

  assert.equal(result.outcome, 'already-classified');
  assert.equal(fetches, 0);
});

// --------------------------------------------------------------------------
// NEVER TERMINAL: every failure mode stays retryable.
// --------------------------------------------------------------------------

test('a missing head defers instead of guessing a job identity', async () => {
  const rootDir = freshRoot();
  const warnings = [];
  const result = await routeSecuritySurfaceToArgus({
    rootDir,
    repoPath: REPO,
    prNumber: 909,
    headSha: null,
    authorRef: 'dependabot[bot]',
    fetchChangedFiles: async () => [{ filename: 'package-lock.json' }],
    logger: { ...SILENT, warn: (msg) => warnings.push(msg) },
  });

  assert.equal(result.outcome, 'no-head');
  assert.equal(result.queued, false);
  assert.equal(result.recordClassifiedHead, false, 'nothing may be memoized for a head we never had');
  assert.equal(pendingJobs(rootDir).length, 0);
  assert.equal(warnings.length, 1, 'a PR that never grows a head must not be an invisible hole');
});

test('an abbreviated head is refused, not expanded', async () => {
  // Two heads sharing a prefix would collapse into one skipped review.
  const rootDir = freshRoot();
  const result = await routeSecuritySurfaceToArgus({
    rootDir,
    repoPath: REPO,
    prNumber: 909,
    headSha: 'abc1234',
    authorRef: 'dependabot[bot]',
    logger: SILENT,
  });

  assert.equal(result.outcome, 'no-head');
  assert.equal(pendingJobs(rootDir).length, 0);
});

test('a failed changed-file fetch still routes the bot PR and does not memoize', async () => {
  // `null` is a FETCH FAILURE, not an empty diff. The author trigger still
  // answers, the path triggers cannot, so the negative half is not evidence.
  const rootDir = freshRoot();
  const result = await routeSecuritySurfaceToArgus({
    rootDir,
    repoPath: REPO,
    prNumber: 909,
    headSha: HEAD_A,
    authorRef: 'dependabot[bot]',
    fetchChangedFiles: async () => null,
    logger: SILENT,
  });

  assert.equal(result.outcome, 'enqueued');
  assert.equal(result.classificationComplete, false);
  assert.deepEqual(result.reasons.map((reason) => reason.trigger), ['bot-author']);
  assert.equal(
    result.recordClassifiedHead,
    true,
    'the PR is on the queue; that durable record is what the memo protects',
  );
});

test('a failed fetch on a human PR is retried, never cached as a clean bill', async () => {
  const rootDir = freshRoot();
  const result = await routeSecuritySurfaceToArgus({
    rootDir,
    repoPath: REPO,
    prNumber: 500,
    headSha: HEAD_A,
    authorRef: 'VirtualPaul',
    fetchChangedFiles: async () => null,
    logger: SILENT,
  });

  assert.equal(result.outcome, 'classification-incomplete');
  assert.equal(
    result.recordClassifiedHead,
    false,
    'caching a false negative costs the review; retrying the fetch costs an API call',
  );
});

test('a fetch that throws is caught and treated as an incomplete classification', async () => {
  const rootDir = freshRoot();
  const result = await routeSecuritySurfaceToArgus({
    rootDir,
    repoPath: REPO,
    prNumber: 909,
    headSha: HEAD_A,
    authorRef: 'dependabot[bot]',
    fetchChangedFiles: async () => { throw new Error('403 rate limited'); },
    logger: SILENT,
  });

  assert.equal(result.outcome, 'enqueued', 'the bot trigger does not depend on the file list');
  assert.equal(result.classificationComplete, false);
});

test('an enqueue failure leaves the PR unqueued and unmemoized, for retry', async () => {
  const rootDir = freshRoot();
  const result = await routeSecuritySurfaceToArgus({
    rootDir,
    repoPath: REPO,
    prNumber: 909,
    headSha: HEAD_A,
    authorRef: 'dependabot[bot]',
    fetchChangedFiles: async () => [{ filename: 'package-lock.json' }],
    enqueue: () => { throw new Error('EROFS: read-only file system'); },
    logger: SILENT,
  });

  assert.equal(result.outcome, 'error');
  assert.equal(result.queued, false, 'the caller must not record a routed row for a review that is not queued');
  assert.equal(result.recordClassifiedHead, false, 'the next tick must retry');
  assert.match(result.error.message, /EROFS/);
});

test('an enqueue failure over an already-queued head still reports queued', async () => {
  // The write raced or the disk hiccuped after the job was already on the queue.
  // The PR is covered, so say so rather than re-reporting it as unrouted.
  const rootDir = freshRoot();
  await routeSecuritySurfaceToArgus({
    rootDir,
    repoPath: REPO,
    prNumber: 909,
    headSha: HEAD_A,
    authorRef: 'dependabot[bot]',
    fetchChangedFiles: async () => [{ filename: 'package-lock.json' }],
    logger: SILENT,
  });

  const result = await routeSecuritySurfaceToArgus({
    rootDir,
    repoPath: REPO,
    prNumber: 909,
    headSha: HEAD_A,
    authorRef: 'dependabot[bot]',
    fetchChangedFiles: async () => [{ filename: 'package-lock.json' }],
    enqueue: () => { throw new Error('transient'); },
    logger: SILENT,
  });

  assert.equal(result.outcome, 'error');
  assert.equal(result.queued, true);
  assert.ok(existsSync(result.jobPath));
});

// --------------------------------------------------------------------------
// The rollback lever and the note.
// --------------------------------------------------------------------------

test('the route is ON unless explicitly switched off', () => {
  assert.equal(isArgusSecurityRouteEnabled({}), true);
  assert.equal(isArgusSecurityRouteEnabled({ ADVERSARIAL_ARGUS_SECURITY_ROUTE: '' }), true);
  assert.equal(isArgusSecurityRouteEnabled({ ADVERSARIAL_ARGUS_SECURITY_ROUTE: '1' }), true);
  for (const off of ['0', 'false', 'no', 'off', 'OFF']) {
    assert.equal(
      isArgusSecurityRouteEnabled({ ADVERSARIAL_ARGUS_SECURITY_ROUTE: off }),
      false,
      `${off} must disable the route`,
    );
  }
});

test('the reason summary names every trigger and never a severity', () => {
  assert.equal(summarizeSecurityReasons([]), 'no trigger');
  assert.equal(summarizeSecurityReasons(null), 'no trigger');
  assert.equal(
    summarizeSecurityReasons([{ trigger: 'bot-author' }, { trigger: 'manifest-change' }]),
    'bot-author, manifest-change',
  );
});
