import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  DELIVERY_CLAIM_STALE_MS,
  MAX_COMMENT_DELIVERY_ATTEMPTS,
  NON_RETRYABLE_DELIVERY_REASONS,
  RETRY_BUDGET_PER_TICK,
  buildAttemptingDelivery,
  buildPendingDelivery,
  deliveryLockPath,
  recordInitialCommentDelivery,
  releaseDeliveryClaim,
  retryFailedCommentDeliveries,
  tryAcquireDeliveryClaim,
} from '../src/comment-delivery.mjs';
import { postRemediationOutcomeComment } from '../src/pr-comments.mjs';

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
