import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  MAX_COMMENT_DELIVERY_ATTEMPTS,
  NON_RETRYABLE_DELIVERY_REASONS,
  buildPendingDelivery,
  recordInitialCommentDelivery,
  retryFailedCommentDeliveries,
} from '../src/comment-delivery.mjs';
import { postRemediationOutcomeComment } from '../src/pr-comments.mjs';

function makeFakeTerminalRecord(rootDir, dirKey, jobId, body, repo, prNumber, workerClass, postResult) {
  const dir = path.join(rootDir, 'data', 'follow-up-jobs', dirKey);
  mkdirSync(dir, { recursive: true });
  const jobPath = path.join(dir, `${jobId}.json`);
  writeFileSync(jobPath, JSON.stringify({
    jobId,
    repo,
    prNumber,
    status: dirKey === 'completed' ? 'completed' : (dirKey === 'stopped' ? 'stopped' : 'failed'),
  }, null, 2), 'utf8');
  recordInitialCommentDelivery({
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

test('recordInitialCommentDelivery stamps posted=true on success', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'comment-delivery-'));
  const jobPath = makeFakeTerminalRecord(
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

test('recordInitialCommentDelivery stamps posted=false with the failure reason on timeout', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'comment-delivery-'));
  const jobPath = makeFakeTerminalRecord(
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
  const jobPath = makeFakeTerminalRecord(
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

  assert.deepEqual(summary, { scanned: 1, retried: 1, posted: 1, failed: 0, skipped: 0 });
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
});

test('retryFailedCommentDeliveries skips records already at posted=true', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'comment-delivery-'));
  makeFakeTerminalRecord(
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
  assert.equal(summary.skipped, 1);
});

test('retryFailedCommentDeliveries stops retrying after MAX_COMMENT_DELIVERY_ATTEMPTS', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'comment-delivery-'));
  const jobPath = makeFakeTerminalRecord(
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
  assert.equal(summary.skipped, 1);
  // Record stays as it was — operator gets to inspect.
  const after = JSON.parse(readFileSync(jobPath, 'utf8'));
  assert.equal(after.commentDelivery.attempts, MAX_COMMENT_DELIVERY_ATTEMPTS);
  assert.equal(after.commentDelivery.posted, false);
});

test('retryFailedCommentDeliveries skips non-retryable reasons (no-token-mapping, missing-pr-coordinates)', async () => {
  for (const reason of NON_RETRYABLE_DELIVERY_REASONS) {
    const rootDir = mkdtempSync(path.join(tmpdir(), 'comment-delivery-'));
    makeFakeTerminalRecord(
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
    assert.equal(summary.skipped, 1);
  }
});

test('retryFailedCommentDeliveries increments attempts on a still-failing retry', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'comment-delivery-'));
  const jobPath = makeFakeTerminalRecord(
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
