// ARGUSDRAIN-01 — the Argus drain claims jobs, reviews them in the background
// under a concurrency cap, and records approve / block / fail. Every test uses a
// temp root; nothing here touches the live queue.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  enqueueArgusSecurityReview,
  findArgusJob,
  readArgusQueueDepth,
} from '../src/argus-security-queue.mjs';
import {
  ARGUS_DRAIN_RETRY_BACKOFF_MS,
  applyArgusReviewOutcome,
  createArgusSecurityDrain,
  isArgusJobClaimable,
  startArgusSecurityDrainForWatcherTick,
} from '../src/argus-security-drain.mjs';
import { ARGUS_VERDICT_STATES, resolveArgusSecurityVerdict } from '../src/argus-security-verdict.mjs';

const REPO = 'laceyenterprises/adversarial-review';
const T0 = Date.parse('2026-09-29T10:00:00.000Z');
const quiet = { log() {}, warn() {}, error() {} };

function head(n) {
  return n.toString(16).padStart(40, '0');
}

async function withRoot(fn) {
  const rootDir = mkdtempSync(join(tmpdir(), 'argus-drain-'));
  try {
    return await fn(rootDir);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

function enqueue(rootDir, { prNumber = 1172, headSha = head(1), enqueuedAt = new Date(T0).toISOString() } = {}) {
  return enqueueArgusSecurityReview({
    rootDir,
    repo: REPO,
    prNumber,
    headSha,
    enqueuedAt,
    reasons: [{ trigger: 'manifest-change', ecosystems: ['npm'], matches: [{ path: 'package.json', ecosystem: 'npm' }] }],
  });
}

function result(verdict, findings = []) {
  return {
    schemaVersion: 1,
    kind: 'argus-security-result',
    source: 'argus-security-drain',
    verdict,
    summary: `${verdict} summary`,
    findings,
    reviewer: { model: 'claude' },
  };
}

function verdictFor(rootDir, { prNumber = 1172, headSha = head(1), nowMs = T0 } = {}) {
  return resolveArgusSecurityVerdict({ rootDir, repo: REPO, prNumber, headSha, nowMs });
}

test('claim then complete: an approve is recorded with its claim-to-verdict latency', async () => withRoot(async (rootDir) => {
  enqueue(rootDir);
  let now = T0;
  const drain = createArgusSecurityDrain({
    rootDir,
    nowMs: () => now,
    logger: quiet,
    runJob: async ({ job }) => {
      assert.equal(job.status, 'in_progress');
      now += 90_000;
      return { kind: 'complete', result: result('approve') };
    },
  });

  const tick = drain.tick();
  assert.equal(tick.claimed.length, 1);
  await drain.drain();

  const found = findArgusJob(rootDir, { repo: REPO, prNumber: 1172, headSha: head(1) });
  assert.equal(found.bucket, 'completed');
  assert.equal(found.job.result.verdict, 'approve');
  assert.equal(found.job.result.drain.latencyMs, 90_000);
  assert.equal(found.job.result.drain.claimedAt, new Date(T0).toISOString());
  assert.equal(verdictFor(rootDir).state, ARGUS_VERDICT_STATES.APPROVED);
}));

test('claim then complete: a high finding is recorded as blocked', async () => withRoot(async (rootDir) => {
  enqueue(rootDir);
  const drain = createArgusSecurityDrain({
    rootDir,
    nowMs: () => T0,
    logger: quiet,
    runJob: async () => ({
      kind: 'complete',
      result: result('block', [{ category: 'install_time_execution', severity: 'high', title: 'adds postinstall' }]),
    }),
  });

  drain.tick();
  await drain.drain();

  const verdict = verdictFor(rootDir);
  assert.equal(verdict.state, ARGUS_VERDICT_STATES.BLOCKED);
  assert.equal(verdict.blocks, true);
  assert.equal(verdict.blockingFindings[0].title, 'adds postinstall');
}));

test('claim then fail: retries back off, then the job fails after the attempt cap', async () => withRoot(async (rootDir) => {
  enqueue(rootDir);
  let now = T0;
  let runs = 0;
  const drain = createArgusSecurityDrain({
    rootDir,
    maxAttempts: 3,
    nowMs: () => now,
    logger: quiet,
    runJob: async () => {
      runs += 1;
      return { kind: 'retry', error: `model outage ${runs}` };
    },
  });

  drain.tick();
  await drain.drain();
  let found = findArgusJob(rootDir, { repo: REPO, prNumber: 1172, headSha: head(1) });
  assert.equal(found.bucket, 'pending');
  assert.equal(found.job.drain.attempts, 1);
  assert.equal(found.job.drain.lastError, 'model outage 1');
  assert.equal(found.job.drain.notBefore, new Date(T0 + ARGUS_DRAIN_RETRY_BACKOFF_MS[0]).toISOString());
  // Pending again, so the gate still reads it as queued, not failed.
  assert.equal(verdictFor(rootDir, { nowMs: now }).state, ARGUS_VERDICT_STATES.QUEUED);

  // Inside the backoff the job is not claimable.
  assert.deepEqual(drain.tick().claimed, []);

  now += ARGUS_DRAIN_RETRY_BACKOFF_MS[0] + 1;
  drain.tick();
  await drain.drain();
  found = findArgusJob(rootDir, { repo: REPO, prNumber: 1172, headSha: head(1) });
  assert.equal(found.job.drain.attempts, 2);

  now += ARGUS_DRAIN_RETRY_BACKOFF_MS[1] + 1;
  drain.tick();
  await drain.drain();
  found = findArgusJob(rootDir, { repo: REPO, prNumber: 1172, headSha: head(1) });
  assert.equal(found.bucket, 'failed');
  assert.match(found.job.error, /failed after 3 attempt\(s\): model outage 3/u);
  assert.equal(runs, 3);
  assert.equal(verdictFor(rootDir, { nowMs: now }).state, ARGUS_VERDICT_STATES.FAILED);
}));

test('a review that throws is a retry, never a lost job', async () => withRoot(async (rootDir) => {
  enqueue(rootDir);
  const drain = createArgusSecurityDrain({
    rootDir,
    nowMs: () => T0,
    logger: quiet,
    runJob: async () => {
      throw new Error('child crashed');
    },
  });
  drain.tick();
  await drain.drain();
  const found = findArgusJob(rootDir, { repo: REPO, prNumber: 1172, headSha: head(1) });
  assert.equal(found.bucket, 'pending');
  assert.equal(found.job.drain.attempts, 1);
  assert.equal(found.job.drain.lastError, 'child crashed');
}));

test('a defer returns the job without spending an attempt and keeps the cached review', async () => withRoot(async (rootDir) => {
  enqueue(rootDir);
  const cachedReview = { headSha: head(1), reviewedAt: new Date(T0).toISOString(), model: 'gemini' };
  applyArgusReviewOutcome({
    rootDir,
    ...(() => {
      const found = findArgusJob(rootDir, { repo: REPO, prNumber: 1172, headSha: head(1) });
      return { job: found.job, jobPath: found.jobPath };
    })(),
    outcome: { kind: 'defer', reason: 'ci-pending', retryAfterMs: 10 * 60 * 1000, cachedReview },
    nowMs: T0,
    logger: quiet,
  });
  const found = findArgusJob(rootDir, { repo: REPO, prNumber: 1172, headSha: head(1) });
  assert.equal(found.bucket, 'pending');
  assert.equal(found.job.drain.attempts, undefined);
  assert.equal(found.job.drain.deferrals, 1);
  assert.equal(found.job.drain.lastDeferReason, 'ci-pending');
  assert.deepEqual(found.job.drain.cachedReview, cachedReview);
  assert.equal(isArgusJobClaimable(found.job, { nowMs: T0 + 60_000 }), false);
  assert.equal(isArgusJobClaimable(found.job, { nowMs: T0 + 11 * 60 * 1000 }), true);
}));

test('a job returned to pending keeps its age: the depth read still sees how long it waited', async () => withRoot(async (rootDir) => {
  enqueue(rootDir, { enqueuedAt: new Date(T0 - 5 * 60 * 60 * 1000).toISOString() });
  const drain = createArgusSecurityDrain({
    rootDir,
    nowMs: () => T0,
    logger: quiet,
    runJob: async () => ({ kind: 'retry', error: 'blip' }),
  });
  drain.tick();
  await drain.drain();
  const found = findArgusJob(rootDir, { repo: REPO, prNumber: 1172, headSha: head(1) });
  assert.equal(statSync(found.jobPath).mtimeMs, T0 - 5 * 60 * 60 * 1000);
  const depth = readArgusQueueDepth(rootDir, { nowMs: T0 });
  assert.equal(depth.oldestPending.ageMs, 5 * 60 * 60 * 1000);
}));

test('the drain respects its concurrency cap across ticks', async () => withRoot(async (rootDir) => {
  for (let pr = 1; pr <= 5; pr += 1) {
    enqueue(rootDir, { prNumber: 1000 + pr, headSha: head(pr), enqueuedAt: new Date(T0 + pr).toISOString() });
  }
  const releases = [];
  let concurrent = 0;
  let peak = 0;
  const drain = createArgusSecurityDrain({
    rootDir,
    maxConcurrent: 2,
    nowMs: () => T0,
    logger: quiet,
    runJob: () => new Promise((resolve) => {
      concurrent += 1;
      peak = Math.max(peak, concurrent);
      releases.push(() => {
        concurrent -= 1;
        resolve({ kind: 'complete', result: result('approve') });
      });
    }),
  });

  assert.equal(drain.tick().claimed.length, 2);
  assert.equal(drain.tick().claimed.length, 0, 'a full drain claims nothing more');
  assert.equal(readArgusQueueDepth(rootDir).depth.inProgress, 2);

  releases.shift()();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(drain.tick().claimed.length, 1);

  while (releases.length > 0) {
    releases.shift()();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    drain.tick();
  }
  await drain.drain();
  assert.equal(peak, 2);
  assert.equal(drain.snapshot().peakRunning, 2);
  assert.equal(readArgusQueueDepth(rootDir).depth.completed, 5);
}));

test('the drain claims oldest first', async () => withRoot(async (rootDir) => {
  enqueue(rootDir, { prNumber: 2, headSha: head(2), enqueuedAt: new Date(T0 + 1000).toISOString() });
  enqueue(rootDir, { prNumber: 1, headSha: head(1), enqueuedAt: new Date(T0).toISOString() });
  // Order is by mtime; make it match the enqueue order explicitly.
  const { utimesSync } = await import('node:fs');
  utimesSync(findArgusJob(rootDir, { repo: REPO, prNumber: 2, headSha: head(2) }).jobPath, new Date(), new Date(T0 + 1000));
  utimesSync(findArgusJob(rootDir, { repo: REPO, prNumber: 1, headSha: head(1) }).jobPath, new Date(), new Date(T0));
  const seen = [];
  const drain = createArgusSecurityDrain({
    rootDir,
    maxConcurrent: 1,
    nowMs: () => T0,
    logger: quiet,
    runJob: async ({ job }) => {
      seen.push(job.prNumber);
      return { kind: 'complete', result: result('approve') };
    },
  });
  drain.tick();
  await drain.drain();
  drain.tick();
  await drain.drain();
  assert.deepEqual(seen, [1, 2]);
}));

test('a paused watcher (review drain active) starts no Argus reviews', async () => withRoot(async (rootDir) => {
  enqueue(rootDir);
  const drain = createArgusSecurityDrain({
    rootDir,
    logger: quiet,
    runJob: async () => assert.fail('must not run while paused'),
  });
  assert.deepEqual(drain.tick({ paused: true }).claimed, []);
  assert.equal(findArgusJob(rootDir, { repo: REPO, prNumber: 1172, headSha: head(1) }).bucket, 'pending');
}));

test('the watcher entry point honours the kill switch and never throws', async () => withRoot(async (rootDir) => {
  enqueue(rootDir);
  const off = startArgusSecurityDrainForWatcherTick({
    rootDir,
    env: { ADVERSARIAL_ARGUS_DRAIN: 'off' },
    logger: quiet,
    drainFactory: () => assert.fail('disabled drain must not be built'),
  });
  assert.deepEqual(off, { started: false, reason: 'disabled' });

  const broken = startArgusSecurityDrainForWatcherTick({
    rootDir,
    env: {},
    logger: quiet,
    drainFactory: () => {
      throw new Error('boom');
    },
  });
  assert.equal(broken.started, false);
  assert.equal(broken.reason, 'error');

  let ticked = null;
  const on = startArgusSecurityDrainForWatcherTick({
    rootDir,
    env: {},
    watcherDrainActive: true,
    logger: quiet,
    drainFactory: () => ({
      tick: (opts) => {
        ticked = opts;
        return { claimed: [], running: 0, limit: 2, skipped: 'paused' };
      },
    }),
  });
  assert.equal(on.started, true);
  assert.deepEqual(ticked, { paused: true });
}));
