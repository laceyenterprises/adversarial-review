import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  DELIVERY_CLAIM_STALE_MS,
  DELIVERY_RETRY_INDEX_DIR_NAME,
  DELIVERY_RETRY_INDEX_INIT_SENTINEL,
  MAX_COMMENT_DELIVERY_ATTEMPTS,
  NON_RETRYABLE_DELIVERY_REASONS,
  RETRY_BUDGET_PER_TICK,
  addToDeliveryRetryIndex,
  buildAttemptingDelivery,
  buildPendingDelivery,
  deliveryLockPath,
  deliveryRetryIndexDir,
  deliveryRetryIndexPointerPath,
  recordInitialCommentDelivery,
  releaseDeliveryClaim,
  removeFromDeliveryRetryIndex,
  retryFailedCommentDeliveries,
  seedDeliveryRetryIndexFromHistory,
  tryAcquireDeliveryClaim,
} from '../src/adapters/comms/github-pr-comments/comment-delivery.mjs';
import { postRemediationOutcomeComment } from '../src/adapters/comms/github-pr-comments/pr-comments.mjs';

async function makeFakeTerminalRecord(rootDir, dirKey, jobId, body, repo, prNumber, workerClass, postResult) {
  const dir = path.join(rootDir, 'data', 'follow-up-jobs', dirKey);
  mkdirSync(dir, { recursive: true });
  const jobPath = path.join(dir, `${jobId}.json`);
  writeFileSync(jobPath, JSON.stringify({
    jobId,
    repo,
    prNumber,
    status: dirKey === 'completed' ? 'completed' : (dirKey === 'stopped' ? 'stopped' : 'failed'),
  }, null, 2), 'utf8');
  await recordInitialCommentDelivery({
    rootDir,
    jobPath,
    body,
    repo,
    prNumber,
    workerClass,
    postResult,
    now: () => '2026-05-02T03:00:00.000Z',
    log: { error: () => {} },
  });
  return jobPath;
}

test('postRemediationOutcomeComment treats execFile timeout as gh-cli-timeout (not gh-cli-failure)', async () => {
  const result = await postRemediationOutcomeComment({
    repo: 'laceyenterprises/demo',
    prNumber: 7,
    workerClass: 'codex',
    body: 'x',
    env: { GH_CODEX_REVIEWER_TOKEN: 'pat', PATH: '/usr/bin', HOME: '/tmp' },
    execFileImpl: async () => {
      // Simulate the error shape Node.js emits when execFile's `timeout`
      // option fires (the child gets SIGTERM'd and the resulting Error
      // carries .killed=true, .signal='SIGTERM').
      const err = new Error('Command was killed with SIGTERM (Signal): gh pr comment');
      err.killed = true;
      err.signal = 'SIGTERM';
      throw err;
    },
    timeoutMs: 30_000,
    log: { error: () => {} },
  });
  assert.equal(result.posted, false);
  assert.equal(result.reason, 'gh-cli-timeout');
  assert.equal(result.timeoutMs, 30_000);
});

test('postRemediationOutcomeComment passes timeout through to execFile options', async () => {
  let capturedOptions;
  await postRemediationOutcomeComment({
    repo: 'laceyenterprises/demo',
    prNumber: 7,
    workerClass: 'codex',
    body: 'x',
    env: { GH_CODEX_REVIEWER_TOKEN: 'pat', PATH: '/usr/bin', HOME: '/tmp' },
    execFileImpl: async (_cmd, _args, options) => {
      capturedOptions = options;
      return { stdout: '', stderr: '' };
    },
    timeoutMs: 12_345,
  });
  assert.equal(capturedOptions.timeout, 12_345);
  assert.equal(capturedOptions.killSignal, 'SIGTERM');
});

test('recordInitialCommentDelivery stamps posted=true on success', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'comment-delivery-'));
  const jobPath = await makeFakeTerminalRecord(
    rootDir, 'completed', 'job-a', 'body-a',
    'laceyenterprises/demo', 7, 'codex',
    { posted: true }
  );
  const record = JSON.parse(readFileSync(jobPath, 'utf8'));
  assert.equal(record.commentDelivery.posted, true);
  assert.equal(record.commentDelivery.attempts, 1);
  assert.equal(record.commentDelivery.body, 'body-a');
  assert.equal(record.commentDelivery.repo, 'laceyenterprises/demo');
  assert.equal(record.commentDelivery.prNumber, 7);
  assert.equal(record.commentDelivery.workerClass, 'codex');
  assert.equal(record.commentDelivery.firstAttemptAt, '2026-05-02T03:00:00.000Z');
  assert.equal(record.commentDelivery.lastAttemptAt, '2026-05-02T03:00:00.000Z');
});

test('recordInitialCommentDelivery stamps posted=false with the failure reason on timeout', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'comment-delivery-'));
  const jobPath = await makeFakeTerminalRecord(
    rootDir, 'stopped', 'job-b', 'body-b',
    'laceyenterprises/demo', 8, 'claude-code',
    { posted: false, reason: 'gh-cli-timeout', timeoutMs: 30_000 }
  );
  const record = JSON.parse(readFileSync(jobPath, 'utf8'));
  assert.equal(record.commentDelivery.posted, false);
  assert.equal(record.commentDelivery.reason, 'gh-cli-timeout');
  assert.equal(record.commentDelivery.timeoutMs, 30_000);
  assert.equal(record.commentDelivery.attempts, 1);
});

test('retryFailedCommentDeliveries re-posts records with posted=false and stamps success', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'comment-delivery-'));
  const jobPath = await makeFakeTerminalRecord(
    rootDir, 'completed', 'job-c', 'body-c',
    'laceyenterprises/demo', 9, 'codex',
    { posted: false, reason: 'gh-cli-timeout', timeoutMs: 30_000 }
  );

  const calls = [];
  const summary = await retryFailedCommentDeliveries({
    rootDir,
    postCommentImpl: async (args) => {
      calls.push(args);
      return { posted: true, repo: args.repo, prNumber: args.prNumber, workerClass: args.workerClass };
    },
    now: () => '2026-05-02T03:05:00.000Z',
    log: { error: () => {} },
  });

  assert.equal(summary.scanned, 1);
  assert.equal(summary.retried, 1);
  assert.equal(summary.posted, 1);
  assert.equal(summary.failed, 0);
  assert.equal(summary.skipped, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].repo, 'laceyenterprises/demo');
  assert.equal(calls[0].prNumber, 9);
  assert.equal(calls[0].workerClass, 'codex');
  assert.equal(calls[0].body, 'body-c');

  const record = JSON.parse(readFileSync(jobPath, 'utf8'));
  assert.equal(record.commentDelivery.posted, true);
  assert.equal(record.commentDelivery.attempts, 2);
  assert.equal(record.commentDelivery.firstAttemptAt, '2026-05-02T03:00:00.000Z');
  assert.equal(record.commentDelivery.lastAttemptAt, '2026-05-02T03:05:00.000Z');
  assert.equal(record.commentDelivery.attempting, false, 'attempting flag must be cleared after retry settles');
});

test('retryFailedCommentDeliveries skips records already at posted=true (not a candidate)', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'comment-delivery-'));
  await makeFakeTerminalRecord(
    rootDir, 'completed', 'job-d', 'body-d',
    'laceyenterprises/demo', 10, 'codex',
    { posted: true }
  );
  const calls = [];
  const summary = await retryFailedCommentDeliveries({
    rootDir,
    postCommentImpl: async (args) => { calls.push(args); return { posted: true }; },
    log: { error: () => {} },
  });
  assert.equal(calls.length, 0);
  // Already-posted records are filtered out at the candidate-list step;
  // they don't show up in `scanned` because the retry pass only counts
  // records that were eligible for retry.
  assert.equal(summary.scanned, 0);
  assert.equal(summary.retried, 0);
});

test('retryFailedCommentDeliveries stops retrying after MAX_COMMENT_DELIVERY_ATTEMPTS', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'comment-delivery-'));
  const jobPath = await makeFakeTerminalRecord(
    rootDir, 'failed', 'job-e', 'body-e',
    'laceyenterprises/demo', 11, 'codex',
    { posted: false, reason: 'gh-cli-failure', error: 'HTTP 502' }
  );
  // Bump attempts to the cap by editing the record directly.
  const initial = JSON.parse(readFileSync(jobPath, 'utf8'));
  initial.commentDelivery.attempts = MAX_COMMENT_DELIVERY_ATTEMPTS;
  writeFileSync(jobPath, JSON.stringify(initial, null, 2), 'utf8');

  const calls = [];
  const summary = await retryFailedCommentDeliveries({
    rootDir,
    postCommentImpl: async (args) => { calls.push(args); return { posted: true }; },
    log: { error: () => {} },
  });
  assert.equal(calls.length, 0, 'capped record must not be retried');
  assert.equal(summary.scanned, 0, 'capped records are not candidates');
  // Record stays as it was — operator gets to inspect.
  const after = JSON.parse(readFileSync(jobPath, 'utf8'));
  assert.equal(after.commentDelivery.attempts, MAX_COMMENT_DELIVERY_ATTEMPTS);
  assert.equal(after.commentDelivery.posted, false);
});

test('retryFailedCommentDeliveries skips non-retryable reasons (no-token-mapping, missing-pr-coordinates)', async () => {
  for (const reason of NON_RETRYABLE_DELIVERY_REASONS) {
    const rootDir = mkdtempSync(path.join(tmpdir(), 'comment-delivery-'));
    await makeFakeTerminalRecord(
      rootDir, 'completed', 'job-nr', 'body-nr',
      'laceyenterprises/demo', 12, 'codex',
      { posted: false, reason }
    );
    const calls = [];
    const summary = await retryFailedCommentDeliveries({
      rootDir,
      postCommentImpl: async (args) => { calls.push(args); return { posted: true }; },
      log: { error: () => {} },
    });
    assert.equal(calls.length, 0, `reason "${reason}" must be skipped`);
    assert.equal(summary.scanned, 0);
  }
});

test('retryFailedCommentDeliveries increments attempts on a still-failing retry', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'comment-delivery-'));
  const jobPath = await makeFakeTerminalRecord(
    rootDir, 'completed', 'job-f', 'body-f',
    'laceyenterprises/demo', 13, 'codex',
    { posted: false, reason: 'gh-cli-failure', error: 'HTTP 502' }
  );
  const summary = await retryFailedCommentDeliveries({
    rootDir,
    postCommentImpl: async () => ({ posted: false, reason: 'gh-cli-failure', error: 'HTTP 502' }),
    now: () => '2026-05-02T03:10:00.000Z',
    log: { error: () => {} },
  });
  assert.equal(summary.failed, 1);
  const record = JSON.parse(readFileSync(jobPath, 'utf8'));
  assert.equal(record.commentDelivery.posted, false);
  assert.equal(record.commentDelivery.attempts, 2);
  assert.equal(record.commentDelivery.lastAttemptAt, '2026-05-02T03:10:00.000Z');
});

test('buildPendingDelivery captures the body and addressing for retry', () => {
  const delivery = buildPendingDelivery({
    body: 'comment body',
    repo: 'laceyenterprises/demo',
    prNumber: 5,
    workerClass: 'claude-code',
    postResult: { posted: false, reason: 'gh-cli-timeout', timeoutMs: 30_000 },
    attemptedAt: '2026-05-02T03:00:00.000Z',
  });
  assert.equal(delivery.posted, false);
  assert.equal(delivery.reason, 'gh-cli-timeout');
  assert.equal(delivery.body, 'comment body');
  assert.equal(delivery.repo, 'laceyenterprises/demo');
  assert.equal(delivery.prNumber, 5);
  assert.equal(delivery.workerClass, 'claude-code');
  assert.equal(delivery.attempts, 1);
});

// ── Concurrency / claim mechanism (R3 review #1, race A + B) ───────────────

test('tryAcquireDeliveryClaim grants the first caller and refuses concurrent callers', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'comment-delivery-'));
  const dir = path.join(rootDir, 'data', 'follow-up-jobs', 'completed');
  mkdirSync(dir, { recursive: true });
  const jobPath = path.join(dir, 'job-claim.json');
  writeFileSync(jobPath, '{}', 'utf8');

  const first = tryAcquireDeliveryClaim(jobPath, 'pid.1');
  assert.equal(first.acquired, true);

  const second = tryAcquireDeliveryClaim(jobPath, 'pid.2');
  assert.equal(second.acquired, false, 'a fresh claim must refuse a concurrent caller');
  assert.equal(second.claimer, 'pid.1');

  releaseDeliveryClaim(jobPath);

  const third = tryAcquireDeliveryClaim(jobPath, 'pid.3');
  assert.equal(third.acquired, true, 'after release, the claim is available again');
});

test('tryAcquireDeliveryClaim recovers a stale claim past DELIVERY_CLAIM_STALE_MS', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'comment-delivery-'));
  const dir = path.join(rootDir, 'data', 'follow-up-jobs', 'completed');
  mkdirSync(dir, { recursive: true });
  const jobPath = path.join(dir, 'job-stale.json');
  writeFileSync(jobPath, '{}', 'utf8');

  // Plant a stale lock by hand.
  const longAgo = new Date(Date.now() - DELIVERY_CLAIM_STALE_MS - 60_000).toISOString();
  writeFileSync(deliveryLockPath(jobPath), JSON.stringify({ claimer: 'pid.dead', claimedAt: longAgo }), 'utf8');

  const result = tryAcquireDeliveryClaim(jobPath, 'pid.recovery');
  assert.equal(result.acquired, true, 'stale claim must be reclaimable');
  assert.equal(result.reclaimedFromStale, true);
  assert.ok(result.previousAgeMs > DELIVERY_CLAIM_STALE_MS);
});

test('retryFailedCommentDeliveries skips records with a fresh claim held by another process', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'comment-delivery-'));
  const jobPath = await makeFakeTerminalRecord(
    rootDir, 'completed', 'job-claim-busy', 'body-claim-busy',
    'laceyenterprises/demo', 99, 'codex',
    { posted: false, reason: 'gh-cli-timeout', timeoutMs: 30_000 }
  );

  // Plant a fresh claim by another "process".
  writeFileSync(deliveryLockPath(jobPath), JSON.stringify({
    claimer: 'pid.99999.someother',
    claimedAt: new Date().toISOString(),
  }), 'utf8');

  const calls = [];
  const summary = await retryFailedCommentDeliveries({
    rootDir,
    postCommentImpl: async (args) => { calls.push(args); return { posted: true }; },
    log: { error: () => {} },
  });

  assert.equal(calls.length, 0, 'must not post when another process owns the claim');
  assert.equal(summary.skipped, 1);
  assert.equal(summary.posted, 0);
});

test('retryFailedCommentDeliveries respects RETRY_BUDGET_PER_TICK and processes only N per call', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'comment-delivery-'));
  // Plant 8 retryable records (more than the default budget of 5).
  for (let i = 0; i < 8; i += 1) {
    /* eslint-disable no-await-in-loop */
    await makeFakeTerminalRecord(
      rootDir, 'completed', `job-budget-${i}`, `body-${i}`,
      'laceyenterprises/demo', 100 + i, 'codex',
      { posted: false, reason: 'gh-cli-timeout', timeoutMs: 30_000 }
    );
    /* eslint-enable no-await-in-loop */
  }

  const calls = [];
  const summary = await retryFailedCommentDeliveries({
    rootDir,
    postCommentImpl: async (args) => { calls.push(args); return { posted: true }; },
    log: { error: () => {} },
  });

  assert.equal(summary.scanned, 8, 'all 8 records show up as candidates');
  assert.equal(summary.retried, RETRY_BUDGET_PER_TICK, 'only RETRY_BUDGET_PER_TICK records get retried per tick');
  assert.equal(calls.length, RETRY_BUDGET_PER_TICK);
  assert.equal(summary.posted, RETRY_BUDGET_PER_TICK);
});

test('retryFailedCommentDeliveries drains the oldest firstAttemptAt records first', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'comment-delivery-'));
  // Plant records with different firstAttemptAt values; we expect the
  // oldest to be retried first (FIFO drain so a backlog clears in order).
  const dir = path.join(rootDir, 'data', 'follow-up-jobs', 'completed');
  mkdirSync(dir, { recursive: true });
  const stamps = [
    ['job-newest', '2026-05-02T03:30:00.000Z'],
    ['job-oldest', '2026-05-02T01:00:00.000Z'],
    ['job-mid',    '2026-05-02T02:15:00.000Z'],
  ];
  for (const [id, ts] of stamps) {
    const jobPath = path.join(dir, `${id}.json`);
    writeFileSync(jobPath, JSON.stringify({
      jobId: id,
      repo: 'laceyenterprises/demo',
      prNumber: 200,
      status: 'completed',
      commentDelivery: {
        posted: false,
        reason: 'gh-cli-timeout',
        attempts: 1,
        firstAttemptAt: ts,
        lastAttemptAt: ts,
        body: `body-${id}`,
        repo: 'laceyenterprises/demo',
        prNumber: 200,
        workerClass: 'codex',
      },
    }, null, 2), 'utf8');
  }

  const order = [];
  await retryFailedCommentDeliveries({
    rootDir,
    budget: 3,
    postCommentImpl: async (args) => {
      order.push(args.body);
      return { posted: true };
    },
    log: { error: () => {} },
  });

  assert.deepEqual(order, ['body-job-oldest', 'body-job-mid', 'body-job-newest']);
});

// ── Durability-first (R3 review #1, durability gap fix) ────────────────────

test('recordInitialCommentDelivery stamps attempting=true BEFORE the post returns', async () => {
  // The key durability invariant: if the process dies between the
  // gh call and the final stamp, the retry pass must still see a
  // recoverable record. That requires the in-flight state to be
  // written BEFORE the network call. We verify this by inspecting
  // the record from inside a slow postCommentImpl: the file on
  // disk at that point must show attempting=true.
  const rootDir = mkdtempSync(path.join(tmpdir(), 'comment-delivery-'));
  const dir = path.join(rootDir, 'data', 'follow-up-jobs', 'completed');
  mkdirSync(dir, { recursive: true });
  const jobPath = path.join(dir, 'job-pre-stamp.json');
  writeFileSync(jobPath, JSON.stringify({ jobId: 'job-pre-stamp', status: 'completed' }, null, 2), 'utf8');

  let observedDuringPost;
  const result = await recordInitialCommentDelivery({
    jobPath,
    body: 'b',
    repo: 'laceyenterprises/demo',
    prNumber: 1,
    workerClass: 'codex',
    postCommentImpl: async () => {
      // Inside the post, the on-disk record must already show
      // attempting=true.
      observedDuringPost = JSON.parse(readFileSync(jobPath, 'utf8'));
      return { posted: true };
    },
    now: () => '2026-05-02T03:00:00.000Z',
    log: { error: () => {} },
  });

  assert.equal(observedDuringPost.commentDelivery.attempting, true, 'pre-post record must mark attempting=true');
  assert.equal(observedDuringPost.commentDelivery.posted, false);
  assert.equal(observedDuringPost.commentDelivery.body, 'b');

  // After the post settles, the final record reflects the result.
  assert.equal(result.posted, true);
  const finalRecord = JSON.parse(readFileSync(jobPath, 'utf8'));
  assert.equal(finalRecord.commentDelivery.posted, true);
  assert.equal(finalRecord.commentDelivery.attempting, false);
});

test('recordInitialCommentDelivery synthesizes a failure record when the poster throws', async () => {
  // Without this, a synchronous throw from the poster impl would
  // leave the record in attempting=true forever (until the lock
  // goes stale ~5min later) — silent data loss for the operator.
  const rootDir = mkdtempSync(path.join(tmpdir(), 'comment-delivery-'));
  const dir = path.join(rootDir, 'data', 'follow-up-jobs', 'completed');
  mkdirSync(dir, { recursive: true });
  const jobPath = path.join(dir, 'job-throw.json');
  writeFileSync(jobPath, JSON.stringify({ jobId: 'job-throw', status: 'completed' }, null, 2), 'utf8');

  await recordInitialCommentDelivery({
    jobPath,
    body: 'b',
    repo: 'laceyenterprises/demo',
    prNumber: 2,
    workerClass: 'codex',
    postCommentImpl: async () => { throw new Error('connection reset'); },
    now: () => '2026-05-02T03:00:00.000Z',
    log: { error: () => {} },
  });

  const record = JSON.parse(readFileSync(jobPath, 'utf8'));
  assert.equal(record.commentDelivery.posted, false);
  assert.equal(record.commentDelivery.attempting, false);
  assert.equal(record.commentDelivery.reason, 'gh-cli-failure');
  assert.match(record.commentDelivery.error, /connection reset/);
});

test('recordInitialCommentDelivery declines to post when another process holds the claim', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'comment-delivery-'));
  const dir = path.join(rootDir, 'data', 'follow-up-jobs', 'completed');
  mkdirSync(dir, { recursive: true });
  const jobPath = path.join(dir, 'job-already-claimed.json');
  writeFileSync(jobPath, JSON.stringify({ jobId: 'job-already-claimed', status: 'completed' }, null, 2), 'utf8');
  // Plant a fresh claim from another process.
  writeFileSync(deliveryLockPath(jobPath), JSON.stringify({
    claimer: 'pid.other',
    claimedAt: new Date().toISOString(),
  }), 'utf8');

  let postCalls = 0;
  const result = await recordInitialCommentDelivery({
    jobPath,
    body: 'b',
    repo: 'laceyenterprises/demo',
    prNumber: 3,
    workerClass: 'codex',
    postCommentImpl: async () => { postCalls += 1; return { posted: true }; },
    now: () => '2026-05-02T03:00:00.000Z',
    log: { error: () => {} },
  });

  assert.equal(postCalls, 0, 'must not post when another process owns the claim');
  assert.equal(result, null);
});

test('buildAttemptingDelivery shape carries body + addressing + attempting=true', () => {
  const delivery = buildAttemptingDelivery({
    body: 'body',
    repo: 'r',
    prNumber: 1,
    workerClass: 'codex',
    attemptedAt: '2026-05-02T03:00:00.000Z',
    attempts: 1,
    firstAttemptAt: '2026-05-02T03:00:00.000Z',
  });
  assert.equal(delivery.attempting, true);
  assert.equal(delivery.posted, false);
  assert.equal(delivery.attempts, 1);
  assert.equal(delivery.body, 'body');
  assert.equal(delivery.repo, 'r');
});

// ── True durability: commentDelivery is written BEFORE claim acquire ─────
//
// R5 review flagged the previous order (claim → pre-stamp) as a
// durability hole: a crash between claim-acquire and the pre-stamp
// write would leave a lock file with no commentDelivery field, and
// the retry scanner filters out records without commentDelivery, so
// the owed comment would be permanently lost.

test('recordInitialCommentDelivery writes commentDelivery BEFORE acquiring the claim', async () => {
  // Verify the order by intercepting the lock-file write and
  // confirming commentDelivery is already on disk by then.
  const rootDir = mkdtempSync(path.join(tmpdir(), 'comment-delivery-'));
  const dir = path.join(rootDir, 'data', 'follow-up-jobs', 'completed');
  mkdirSync(dir, { recursive: true });
  const jobPath = path.join(dir, 'job-order.json');
  writeFileSync(jobPath, JSON.stringify({ jobId: 'job-order', status: 'completed' }, null, 2), 'utf8');

  // We can't easily intercept the FS calls, but we can observe state
  // at the moment the post fires: commentDelivery must be present.
  // (Pre-stamp happens before claim → before post, so by the time the
  // poster runs, the record is already durable.)
  let observedDuringPost;
  await recordInitialCommentDelivery({
    jobPath,
    body: 'b',
    repo: 'r',
    prNumber: 1,
    workerClass: 'codex',
    postCommentImpl: async () => {
      observedDuringPost = JSON.parse(readFileSync(jobPath, 'utf8'));
      return { posted: true };
    },
    now: () => '2026-05-02T03:00:00.000Z',
    log: { error: () => {} },
  });

  // commentDelivery must be on disk by the time post fires — it was
  // written before the claim was even acquired.
  assert.equal(observedDuringPost.commentDelivery.attempting, true);
  assert.equal(observedDuringPost.commentDelivery.body, 'b');
});

test('parseCommentUrlFromStdout (gh stdout) returns the comment URL on success', async () => {
  // Indirect: postRemediationOutcomeComment captures the URL via
  // parseCommentUrlFromStdout. Verify the captured URL flows into the
  // result.posted=true path.
  const { postRemediationOutcomeComment: post } = await import('../src/adapters/comms/github-pr-comments/pr-comments.mjs');
  const result = await post({
    repo: 'laceyenterprises/demo',
    prNumber: 42,
    workerClass: 'codex',
    body: 'x',
    env: { GH_CODEX_REVIEWER_TOKEN: 'pat', PATH: '/usr/bin', HOME: '/tmp' },
    execFileImpl: async () => ({
      stdout: 'https://github.com/laceyenterprises/demo/pull/42#issuecomment-9999\n',
      stderr: '',
    }),
    log: { error: () => {} },
  });
  assert.equal(result.posted, true);
  assert.equal(result.commentUrl, 'https://github.com/laceyenterprises/demo/pull/42#issuecomment-9999');
});

test('parseCommentUrlFromStdout returns null when gh stdout has no URL', async () => {
  const { postRemediationOutcomeComment: post } = await import('../src/adapters/comms/github-pr-comments/pr-comments.mjs');
  const result = await post({
    repo: 'laceyenterprises/demo',
    prNumber: 42,
    workerClass: 'codex',
    body: 'x',
    env: { GH_CODEX_REVIEWER_TOKEN: 'pat', PATH: '/usr/bin', HOME: '/tmp' },
    execFileImpl: async () => ({ stdout: '', stderr: '' }),
    log: { error: () => {} },
  });
  assert.equal(result.posted, true);
  assert.equal(result.commentUrl, null);
});

// ── Recovery paths: missing commentDelivery + posted-sidecar dedupe ───────
//
// R5 review #1: a writeTerminalRecord failure during pre-stamp leaves
// a terminal record with no commentDelivery field, and the previous
// retry filter excluded those as "not candidates" — silent loss of
// the owed comment. Reconstruction recovers from the record itself
// plus the worker reply artifact.
//
// R5 non-blocking #1: a writeTerminalRecord failure AFTER gh succeeded
// would leave the record in attempting=true; the next retry would
// re-post → duplicate public comment. Posted-sidecar (written before
// the final stamp) lets the retry stamp from the sidecar instead of
// re-posting.

test('listRetryCandidates reconstructs commentDelivery for terminal records that have none (lost pre-stamp)', async () => {
  const { listRetryCandidates } = await import('../src/adapters/comms/github-pr-comments/comment-delivery.mjs');
  const rootDir = mkdtempSync(path.join(tmpdir(), 'comment-delivery-'));
  const dir = path.join(rootDir, 'data', 'follow-up-jobs', 'completed');
  mkdirSync(dir, { recursive: true });
  const jobPath = path.join(dir, 'job-no-delivery.json');
  // Terminal record with no commentDelivery field — simulating a
  // crash between mark* and recordInitialCommentDelivery's pre-stamp.
  writeFileSync(jobPath, JSON.stringify({
    jobId: 'job-no-delivery',
    repo: 'laceyenterprises/demo',
    prNumber: 77,
    status: 'completed',
    builderTag: 'codex',
    remediationWorker: { model: 'codex' },
    reReview: { requested: false },
  }, null, 2), 'utf8');

  const candidates = listRetryCandidates(rootDir, { maxAttempts: 5, log: { error: () => {} } });
  assert.equal(candidates.length, 1, 'a record with no commentDelivery must be picked up as a recovery candidate');
  assert.equal(candidates[0].reconstructed, true);
  assert.equal(candidates[0].delivery.repo, 'laceyenterprises/demo');
  assert.equal(candidates[0].delivery.prNumber, 77);
  assert.equal(candidates[0].delivery.workerClass, 'codex');
  assert.ok(candidates[0].delivery.body, 'reconstructed body must be non-empty');
});

test('retryFailedCommentDeliveries uses posted-sidecar to skip re-post after a previous gh-success / persist-fail', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'comment-delivery-'));
  const jobPath = await makeFakeTerminalRecord(
    rootDir, 'completed', 'job-sidecar', 'body-sidecar',
    'laceyenterprises/demo', 88, 'codex',
    { posted: false, reason: 'gh-cli-timeout' }
  );

  // Plant a posted-sidecar simulating the corner case: a previous
  // attempt's gh call succeeded, but the writeTerminalRecord that
  // would have stamped posted=true crashed mid-flight. The sidecar
  // is the durability marker for that case.
  writeFileSync(`${jobPath}.delivery.posted`, JSON.stringify({
    posted: true,
    repo: 'laceyenterprises/demo',
    prNumber: 88,
    workerClass: 'codex',
    attemptedAt: '2026-05-02T03:30:00.000Z',
    postResult: { posted: true, commentUrl: 'https://github.com/x/y/pull/88#issuecomment-1' },
  }, null, 2), 'utf8');

  let postCalls = 0;
  const summary = await retryFailedCommentDeliveries({
    rootDir,
    postCommentImpl: async () => { postCalls += 1; return { posted: true }; },
    log: { error: () => {} },
  });

  assert.equal(postCalls, 0, 'sidecar recovery must skip the gh re-post entirely');
  assert.equal(summary.posted, 1, 'the recovery still counts as posted (gh did succeed previously)');
  const record = JSON.parse(readFileSync(jobPath, 'utf8'));
  assert.equal(record.commentDelivery.posted, true);
  assert.equal(record.commentDelivery.recoveredFromSidecar, true);
  // Sidecar is cleared after successful recovery.
  assert.equal(existsSync(`${jobPath}.delivery.posted`), false);
});

test('recordInitialCommentDelivery leaves a recoverable commentDelivery record even if the claim is held by another process', async () => {
  // The R5 hole: if a crash happens between claim-acquire and the
  // commentDelivery write, the record has no commentDelivery → retry
  // scanner skips it. We simulate the equivalent by holding the claim
  // BEFORE recordInitialCommentDelivery runs. Under the new order
  // (pre-stamp → claim), the record still gets the attempting=true
  // commentDelivery written even though the post is declined.
  const rootDir = mkdtempSync(path.join(tmpdir(), 'comment-delivery-'));
  const dir = path.join(rootDir, 'data', 'follow-up-jobs', 'completed');
  mkdirSync(dir, { recursive: true });
  const jobPath = path.join(dir, 'job-recoverable.json');
  writeFileSync(jobPath, JSON.stringify({ jobId: 'job-recoverable', status: 'completed' }, null, 2), 'utf8');

  // Plant a fresh claim from another "process".
  writeFileSync(deliveryLockPath(jobPath), JSON.stringify({
    claimer: 'pid.other',
    claimedAt: new Date().toISOString(),
  }), 'utf8');

  let postCalls = 0;
  await recordInitialCommentDelivery({
    jobPath,
    body: 'b',
    repo: 'r',
    prNumber: 1,
    workerClass: 'codex',
    postCommentImpl: async () => { postCalls += 1; return { posted: true }; },
    now: () => '2026-05-02T03:00:00.000Z',
    log: { error: () => {} },
  });

  // Post was correctly declined (claim held by another process).
  assert.equal(postCalls, 0);
  // But the durable signal IS now on disk — the retry pass can pick
  // it up later (after the other process's claim goes stale, or if
  // it crashed without finishing).
  const record = JSON.parse(readFileSync(jobPath, 'utf8'));
  assert.equal(record.commentDelivery.attempting, true,
    'pre-stamp must persist even when claim is held — this is the durability invariant the retry scanner relies on');
  assert.equal(record.commentDelivery.body, 'b');
  assert.equal(record.commentDelivery.repo, 'r');
  assert.equal(record.commentDelivery.prNumber, 1);
});

test('retryFailedCommentDeliveries posts a comment for a terminal record that landed without commentDelivery (lost-pre-stamp recovery)', async () => {
  // End-to-end of the R5 blocking #1 fix: a terminal record arrives
  // with no commentDelivery (e.g., reconcile crashed between the
  // atomic move and the pre-stamp). The retry walker must reconstruct
  // delivery from the record itself, post, and stamp the record.
  const rootDir = mkdtempSync(path.join(tmpdir(), 'comment-delivery-'));
  const dir = path.join(rootDir, 'data', 'follow-up-jobs', 'failed');
  mkdirSync(dir, { recursive: true });
  const jobPath = path.join(dir, 'job-recovered.json');
  writeFileSync(jobPath, JSON.stringify({
    jobId: 'job-recovered',
    repo: 'laceyenterprises/demo',
    prNumber: 555,
    status: 'failed',
    builderTag: 'codex',
    remediationWorker: { model: 'codex' },
    failure: { code: 'artifact-missing-completion', message: 'Worker exited before final-message artifact.' },
    remediationPlan: { currentRound: 1, maxRounds: 6 },
  }, null, 2), 'utf8');

  // Add a retry-index pointer so the indexed retry path picks the
  // record up. (Under the post-PR-18 layout, listRetryCandidates
  // reads from the index, not from the full terminal history; the
  // upstream test pre-dates that and relied on the legacy scan.)
  addToDeliveryRetryIndex(rootDir, jobPath);

  const calls = [];
  const summary = await retryFailedCommentDeliveries({
    rootDir,
    postCommentImpl: async (args) => {
      calls.push(args);
      return { posted: true };
    },
    now: () => '2026-05-02T05:00:00.000Z',
    log: { error: () => {} },
  });

  assert.equal(calls.length, 1, 'reconstructed candidate must be posted');
  assert.equal(calls[0].repo, 'laceyenterprises/demo');
  assert.equal(calls[0].prNumber, 555);
  assert.equal(calls[0].workerClass, 'codex');
  assert.ok(calls[0].body, 'reconstructed body must be non-empty');
  assert.equal(summary.posted, 1);

  const record = JSON.parse(readFileSync(jobPath, 'utf8'));
  assert.equal(record.commentDelivery.posted, true);
  assert.equal(record.commentDelivery.repo, 'laceyenterprises/demo');
  assert.equal(record.commentDelivery.prNumber, 555);
  assert.equal(record.commentDelivery.workerClass, 'codex');
});

// ── Retry index (review #5 of PR #18) ──────────────────────────────────────
// The legacy implementation scanned every file under
// {completed,stopped,failed} every tick to find retry candidates — O(total
// terminal history) per tick. The retry index keeps a small set of pointer
// files for outstanding deliveries so the hot path is bounded by retry
// backlog size, not history size.

test('exports for the retry index name a stable layout', () => {
  // These constants are operator-facing (the layout shows up in the
  // queue dir; runbooks reference it). Lock the names so a refactor
  // can't silently move the directory.
  assert.equal(DELIVERY_RETRY_INDEX_DIR_NAME, 'delivery-retry-index');
  assert.equal(DELIVERY_RETRY_INDEX_INIT_SENTINEL, '.initialized');
});

test('addToDeliveryRetryIndex / removeFromDeliveryRetryIndex round-trips a pointer', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'retry-index-'));
  const dir = path.join(rootDir, 'data', 'follow-up-jobs', 'completed');
  mkdirSync(dir, { recursive: true });
  const jobPath = path.join(dir, 'job-roundtrip.json');
  writeFileSync(jobPath, '{}', 'utf8');

  addToDeliveryRetryIndex(rootDir, jobPath);
  const pointerPath = deliveryRetryIndexPointerPath(rootDir, jobPath);
  assert.equal(existsSync(pointerPath), true);
  const pointer = JSON.parse(readFileSync(pointerPath, 'utf8'));
  assert.equal(pointer.jobPath, jobPath);

  removeFromDeliveryRetryIndex(rootDir, jobPath);
  assert.equal(existsSync(pointerPath), false);
});

test('recordInitialCommentDelivery adds a retry-index pointer on initial failure', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'retry-index-'));
  const jobPath = await makeFakeTerminalRecord(
    rootDir, 'completed', 'job-fail', 'body-fail',
    'laceyenterprises/demo', 1, 'codex',
    { posted: false, reason: 'gh-cli-timeout', timeoutMs: 30_000 }
  );
  const pointerPath = deliveryRetryIndexPointerPath(rootDir, jobPath);
  assert.equal(existsSync(pointerPath), true, 'failed delivery must add a retry pointer');
});

test('recordInitialCommentDelivery does NOT add a retry-index pointer on success', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'retry-index-'));
  const jobPath = await makeFakeTerminalRecord(
    rootDir, 'completed', 'job-ok', 'body-ok',
    'laceyenterprises/demo', 2, 'codex',
    { posted: true }
  );
  const pointerPath = deliveryRetryIndexPointerPath(rootDir, jobPath);
  assert.equal(existsSync(pointerPath), false, 'successful delivery must not pollute the retry index');
});

test('recordInitialCommentDelivery does NOT add a pointer for non-retryable reasons', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'retry-index-'));
  const jobPath = await makeFakeTerminalRecord(
    rootDir, 'completed', 'job-nr', 'body-nr',
    'laceyenterprises/demo', 3, 'codex',
    { posted: false, reason: 'no-token-mapping' }
  );
  const pointerPath = deliveryRetryIndexPointerPath(rootDir, jobPath);
  assert.equal(existsSync(pointerPath), false, 'non-retryable reasons must not enter the retry index');
});

test('retryFailedCommentDeliveries removes the pointer when a retry succeeds', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'retry-index-'));
  const jobPath = await makeFakeTerminalRecord(
    rootDir, 'completed', 'job-retry-ok', 'body',
    'laceyenterprises/demo', 4, 'codex',
    { posted: false, reason: 'gh-cli-timeout', timeoutMs: 30_000 }
  );
  const pointerPath = deliveryRetryIndexPointerPath(rootDir, jobPath);
  assert.equal(existsSync(pointerPath), true, 'precondition: pointer exists before retry');

  await retryFailedCommentDeliveries({
    rootDir,
    postCommentImpl: async () => ({ posted: true }),
    log: { error: () => {} },
  });
  assert.equal(existsSync(pointerPath), false, 'successful retry must drop the retry pointer');
});

test('retryFailedCommentDeliveries keeps the pointer when a retry still fails', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'retry-index-'));
  const jobPath = await makeFakeTerminalRecord(
    rootDir, 'completed', 'job-retry-stillbad', 'body',
    'laceyenterprises/demo', 5, 'codex',
    { posted: false, reason: 'gh-cli-failure', error: 'HTTP 502' }
  );
  const pointerPath = deliveryRetryIndexPointerPath(rootDir, jobPath);
  assert.equal(existsSync(pointerPath), true);

  await retryFailedCommentDeliveries({
    rootDir,
    postCommentImpl: async () => ({ posted: false, reason: 'gh-cli-failure', error: 'HTTP 502' }),
    log: { error: () => {} },
  });
  assert.equal(existsSync(pointerPath), true, 'still-failing retry must keep the pointer');
});

test('seedDeliveryRetryIndexFromHistory backfills pre-index posted=false records once', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'retry-index-'));
  // Plant a legacy posted=false record by hand WITHOUT going through
  // recordInitialCommentDelivery (so no pointer exists yet) — this
  // simulates an upgrade where the index didn't exist when the
  // delivery first failed.
  const dir = path.join(rootDir, 'data', 'follow-up-jobs', 'completed');
  mkdirSync(dir, { recursive: true });
  const jobPath = path.join(dir, 'job-legacy.json');
  writeFileSync(jobPath, JSON.stringify({
    jobId: 'job-legacy',
    repo: 'laceyenterprises/demo',
    prNumber: 6,
    status: 'completed',
    commentDelivery: {
      posted: false,
      attempting: false,
      reason: 'gh-cli-timeout',
      attempts: 1,
      firstAttemptAt: '2026-05-02T01:00:00.000Z',
      lastAttemptAt: '2026-05-02T01:00:00.000Z',
      body: 'legacy body',
      repo: 'laceyenterprises/demo',
      prNumber: 6,
      workerClass: 'codex',
    },
  }, null, 2), 'utf8');

  const result = seedDeliveryRetryIndexFromHistory(rootDir, {
    maxAttempts: MAX_COMMENT_DELIVERY_ATTEMPTS,
    log: { error: () => {} },
  });
  assert.equal(result.seeded, 1);
  assert.equal(result.skipped, false);

  const pointerPath = deliveryRetryIndexPointerPath(rootDir, jobPath);
  assert.equal(existsSync(pointerPath), true, 'legacy record must be seeded into the retry index');

  const sentinelPath = path.join(deliveryRetryIndexDir(rootDir), DELIVERY_RETRY_INDEX_INIT_SENTINEL);
  assert.equal(existsSync(sentinelPath), true);

  // Second call must short-circuit (sentinel present).
  const secondResult = seedDeliveryRetryIndexFromHistory(rootDir, {
    maxAttempts: MAX_COMMENT_DELIVERY_ATTEMPTS,
    log: { error: () => {} },
  });
  assert.equal(secondResult.skipped, true);
  assert.equal(secondResult.seeded, 0);
});

test('retryFailedCommentDeliveries reads from the index, not the full terminal history', async () => {
  // Plant 5 successful (posted=true) records by hand — these would
  // pollute a full-history scan but must NOT show up as retry
  // candidates from the index. Only the one failed record below
  // gets a pointer.
  const rootDir = mkdtempSync(path.join(tmpdir(), 'retry-index-'));
  const dir = path.join(rootDir, 'data', 'follow-up-jobs', 'completed');
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < 5; i += 1) {
    writeFileSync(path.join(dir, `job-noise-${i}.json`), JSON.stringify({
      jobId: `job-noise-${i}`,
      status: 'completed',
      commentDelivery: { posted: true, attempts: 1, body: 'b', repo: 'r', prNumber: 1, workerClass: 'codex' },
    }, null, 2), 'utf8');
  }
  // Seed the index sentinel (without scanning) so the seed pass doesn't
  // pick up the noise records as candidates and add bogus pointers.
  // This simulates a clean post-upgrade state.
  const indexDir = deliveryRetryIndexDir(rootDir);
  mkdirSync(indexDir, { recursive: true });
  writeFileSync(path.join(indexDir, DELIVERY_RETRY_INDEX_INIT_SENTINEL), '\n', 'utf8');

  // Add one failed record via the supported API so the index pointer
  // gets written.
  const failedJobPath = await makeFakeTerminalRecord(
    rootDir, 'completed', 'job-real-fail', 'body',
    'laceyenterprises/demo', 99, 'codex',
    { posted: false, reason: 'gh-cli-timeout', timeoutMs: 30_000 }
  );
  assert.equal(
    existsSync(deliveryRetryIndexPointerPath(rootDir, failedJobPath)),
    true,
    'failed record gets indexed via the supported API'
  );

  const calls = [];
  const summary = await retryFailedCommentDeliveries({
    rootDir,
    postCommentImpl: async (args) => { calls.push(args); return { posted: true }; },
    log: { error: () => {} },
  });
  assert.equal(summary.scanned, 1, 'only the one indexed candidate is scanned, not the 6 terminal records');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body, 'body');
});

test('listRetryCandidates prunes pointers whose terminal record was deleted', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'retry-index-'));
  const indexDir = deliveryRetryIndexDir(rootDir);
  mkdirSync(indexDir, { recursive: true });
  writeFileSync(path.join(indexDir, DELIVERY_RETRY_INDEX_INIT_SENTINEL), '\n', 'utf8');

  // Plant a dangling pointer with no underlying record.
  const danglingJobPath = path.join(rootDir, 'data', 'follow-up-jobs', 'completed', 'job-gone.json');
  addToDeliveryRetryIndex(rootDir, danglingJobPath);
  const danglingPointer = deliveryRetryIndexPointerPath(rootDir, danglingJobPath);
  assert.equal(existsSync(danglingPointer), true);

  const summary = await retryFailedCommentDeliveries({
    rootDir,
    postCommentImpl: async () => { throw new Error('must not post for a missing record'); },
    log: { error: () => {} },
  });
  assert.equal(summary.scanned, 0, 'dangling pointer must not become a candidate');
  assert.equal(existsSync(danglingPointer), false, 'dangling pointer must be pruned');
});
