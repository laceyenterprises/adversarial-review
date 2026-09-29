// ARGUSDRAIN-01 item 5 — the Argus lane on the pipeline health surface: queue
// depth, the oldest unanswered job's age, claim-to-verdict latency, and a
// finding when the oldest live-head job outlives its bound or nothing drains.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  claimNextArgusJob,
  completeArgusJob,
  enqueueArgusSecurityReview,
  failArgusJob,
  findArgusJob,
} from '../src/argus-security-queue.mjs';
import {
  readArgusDrainStatus,
  summarizeArgusSecurityQueue,
  writeArgusDrainStatus,
} from '../src/argus-security-health.mjs';
import { startArgusSecurityDrainForWatcherTick } from '../src/argus-security-drain.mjs';
import {
  collectReviewPipelineHealth,
  renderReviewPipelinePrometheus,
} from '../src/review-pipeline-health.mjs';

const REPO = 'laceyenterprises/agent-os';
const NOW = Date.parse('2026-09-29T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const sha = (n) => n.toString(16).padStart(40, '0');
const quiet = { log() {}, warn() {}, error() {} };

async function withRoot(fn) {
  const rootDir = mkdtempSync(join(tmpdir(), 'argus-health-'));
  try {
    return await fn(rootDir);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

function enqueue(rootDir, prNumber, enqueuedMs) {
  enqueueArgusSecurityReview({
    rootDir,
    repo: REPO,
    prNumber,
    headSha: sha(prNumber),
    enqueuedAt: new Date(enqueuedMs).toISOString(),
    reasons: [{ trigger: 'sensitive-path' }],
  });
  return findArgusJob(rootDir, { repo: REPO, prNumber, headSha: sha(prNumber) });
}

function complete(rootDir, prNumber, { verdict, latencyMs, completedMs }) {
  const found = enqueue(rootDir, prNumber, completedMs - latencyMs - 1000);
  completeArgusJob({
    rootDir,
    jobPath: found.jobPath,
    job: found.job,
    completedAt: new Date(completedMs).toISOString(),
    result: { verdict, findings: [], drain: { latencyMs } },
  });
}

function freshStatus(rootDir, overrides = {}) {
  writeArgusDrainStatus(rootDir, {
    observedAt: new Date(NOW - 60_000).toISOString(),
    enabled: true,
    running: 1,
    limit: 2,
    retirement: { firstPassDone: true, lastFinishedAt: new Date(NOW - 10 * 60_000).toISOString(), lastError: null },
    ...overrides,
  });
}

test('the summary reports depth, the oldest unanswered job, latency and the verdict mix', async () => withRoot(async (rootDir) => {
  enqueue(rootDir, 1, NOW - 3 * HOUR);
  enqueue(rootDir, 2, NOW - 30 * 60_000);
  claimNextArgusJob({ rootDir, claimedAt: new Date(NOW - 5 * 60_000).toISOString() }); // the older one
  complete(rootDir, 10, { verdict: 'approve', latencyMs: 60_000, completedMs: NOW - HOUR });
  complete(rootDir, 11, { verdict: 'block', latencyMs: 180_000, completedMs: NOW - 2 * HOUR });
  complete(rootDir, 12, { verdict: 'superseded', latencyMs: 5_000, completedMs: NOW - 3 * HOUR });
  complete(rootDir, 13, { verdict: 'approve', latencyMs: 999_000, completedMs: NOW - 30 * HOUR }); // outside 24h
  const failing = enqueue(rootDir, 20, NOW - 4 * HOUR);
  failArgusJob({ rootDir, jobPath: failing.jobPath, job: failing.job, failedAt: new Date(NOW - HOUR).toISOString(), error: 'x' });
  freshStatus(rootDir);

  const summary = summarizeArgusSecurityQueue(rootDir, { nowMs: NOW });
  assert.deepEqual(summary.depth, { pending: 1, inProgress: 1, completed: 4, failed: 1 });
  assert.equal(summary.unanswered, 2);
  assert.equal(summary.oldestUnanswered.prNumber, 1);
  assert.equal(summary.oldestUnanswered.bucket, 'inProgress');
  assert.equal(summary.oldestUnanswered.ageMs, 3 * HOUR);
  assert.equal(summary.liveness, 'verified-by-retirement');
  assert.deepEqual(
    [summary.latency.count, summary.latency.p50Ms, summary.latency.p90Ms, summary.latency.maxMs],
    [3, 60_000, 180_000, 180_000],
  );
  assert.deepEqual(summary.verdicts, { approve: 1, block: 1, needs_verification: 0, superseded: 1, other: 0, failed: 1 });
}));

test('an old live-head job raises the stale finding and shows on the metrics', async () => withRoot(async (rootDir) => {
  enqueue(rootDir, 1, NOW - 3 * HOUR);
  freshStatus(rootDir);
  const snapshot = collectReviewPipelineHealth({ rootDir, hqRoot: rootDir, env: {}, now: () => new Date(NOW) });
  const stale = snapshot.findings.find((finding) => finding.code === 'review:argus_security_job_stale');
  assert.ok(stale, 'stale finding raised');
  assert.equal(stale.tier, 'ticket');
  assert.match(stale.message, /laceyenterprises\/agent-os#1@.* since .* \(liveness verified-by-retirement\)/u);
  assert.equal(snapshot.findings.some((finding) => finding.code === 'review:argus_security_drain_not_running'), false);

  const metrics = renderReviewPipelinePrometheus(snapshot);
  assert.match(metrics, /^review_pipeline_argus_jobs\{bucket="pending"\} 1$/mu);
  assert.match(metrics, /^review_pipeline_argus_oldest_unanswered_job_age_seconds\{liveness="verified-by-retirement"\} 10800$/mu);
  assert.match(metrics, /^review_pipeline_argus_drain_running 1$/mu);
  assert.match(metrics, /^review_pipeline_sentinel_finding_active\{code="review:argus_security_job_stale",tier="ticket"\} 1$/mu);
}));

test('a young job raises nothing, and the bound is configurable', async () => withRoot(async (rootDir) => {
  enqueue(rootDir, 1, NOW - 30 * 60_000);
  freshStatus(rootDir);
  const quietSnapshot = collectReviewPipelineHealth({ rootDir, hqRoot: rootDir, env: {}, now: () => new Date(NOW) });
  assert.equal(quietSnapshot.findings.some((f) => f.code.startsWith('review:argus_')), false);

  const tight = collectReviewPipelineHealth({
    rootDir, hqRoot: rootDir, env: { ADVERSARIAL_REVIEW_PIPELINE_HEALTH_ARGUS_OLDEST_JOB_MAX_AGE_MS: String(10 * 60_000) }, now: () => new Date(NOW),
  });
  assert.ok(tight.findings.some((f) => f.code === 'review:argus_security_job_stale'));
}));

test('waiting jobs with a disabled, dead or never-started drain raise the not-running finding', async () => withRoot(async (rootDir) => {
  enqueue(rootDir, 1, NOW - 10 * 60_000);
  const find = () => collectReviewPipelineHealth({ rootDir, hqRoot: rootDir, env: {}, now: () => new Date(NOW) })
    .findings.find((finding) => finding.code === 'review:argus_security_drain_not_running');

  assert.match(find().message, /never written a status record/u);
  writeArgusDrainStatus(rootDir, { observedAt: new Date(NOW - 60_000).toISOString(), enabled: false });
  assert.match(find().message, /disabled \(ADVERSARIAL_ARGUS_DRAIN\)/u);
  freshStatus(rootDir, { observedAt: new Date(NOW - 60 * 60_000).toISOString() });
  assert.match(find().message, /status is 60 minute\(s\) old/u);
  freshStatus(rootDir);
  assert.equal(find(), undefined);
}));

test('without a fresh retirement the oldest job is still reported, marked unverified', async () => withRoot(async (rootDir) => {
  enqueue(rootDir, 1, NOW - 30 * 24 * HOUR);
  freshStatus(rootDir, { retirement: { firstPassDone: true, lastFinishedAt: new Date(NOW - 5 * HOUR).toISOString(), lastError: null } });
  const summary = summarizeArgusSecurityQueue(rootDir, { nowMs: NOW });
  assert.equal(summary.liveness, 'unverified');
  assert.equal(summary.oldestUnanswered.ageMs, 30 * 24 * HOUR);
}));

test('the watcher tick leaves a status record, including when disabled', async () => withRoot(async (rootDir) => {
  startArgusSecurityDrainForWatcherTick({
    rootDir,
    env: {},
    logger: quiet,
    nowMs: () => NOW,
    drainFactory: () => ({
      tick: () => ({ claimed: ['a'], running: 1, limit: 2, skipped: null }),
      snapshot: () => ({ peakRunning: 1, retirement: { firstPassDone: true, lastFinishedAt: new Date(NOW).toISOString(), lastSummary: { retired: 1519 } } }),
    }),
  });
  const status = readArgusDrainStatus(rootDir);
  assert.equal(status.enabled, true);
  assert.equal(status.claimedThisTick, 1);
  assert.equal(status.retirement.lastSummary.retired, 1519);

  startArgusSecurityDrainForWatcherTick({ rootDir, env: { ADVERSARIAL_ARGUS_DRAIN: 'off' }, logger: quiet, nowMs: () => NOW });
  assert.deepEqual(readArgusDrainStatus(rootDir), { observedAt: new Date(NOW).toISOString(), enabled: false });
}));
