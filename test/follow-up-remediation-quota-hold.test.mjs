// follow-up-remediation-quota-hold.test.mjs — proves the remediation worker
// (the SECOND adversarial-review worker class that spawns a native harness CLI
// directly, default path when ADV_WITH_HQ_INTEGRATION is unset) gets the same
// HRR graceful degradation as the reviewer when a hard provider usage cap is
// hit: detect the cap in the worker's stderr log, requeue the job to pending
// with retryAfter clamped to a bounded quota-hold window (held by the consume
// gate and live-revalidated there) until quota returns — instead of a misleading
// terminal "exited without artifact" failure. Bounded by the shared
// transient-retry budget.
import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createFollowUpJob,
  claimNextFollowUpJob,
  markFollowUpJobSpawned,
} from '../src/follow-up-jobs.mjs';
import { reconcileFollowUpJob } from '../src/follow-up-reconcile.mjs';

let previousHqRoot;
let previousMaxTransient;

beforeEach(() => {
  previousHqRoot = process.env.HQ_ROOT;
  previousMaxTransient = process.env.ADVERSARIAL_REMEDIATION_MAX_TRANSIENT_RETRIES;
  process.env.HQ_ROOT = mkdtempSync(path.join(tmpdir(), 'adversarial-review-hq-'));
});

afterEach(() => {
  if (previousHqRoot === undefined) delete process.env.HQ_ROOT;
  else process.env.HQ_ROOT = previousHqRoot;
  if (previousMaxTransient === undefined) delete process.env.ADVERSARIAL_REMEDIATION_MAX_TRANSIENT_RETRIES;
  else process.env.ADVERSARIAL_REMEDIATION_MAX_TRANSIENT_RETRIES = previousMaxTransient;
});

function makeJobInput(rootDir) {
  return {
    rootDir,
    repo: 'laceyenterprises/clio',
    prNumber: 7,
    reviewerModel: 'claude',
    linearTicketId: null,
    reviewBody: '## Summary\nCheck auth expiry handling.',
    reviewPostedAt: '2026-06-16T08:00:00.000Z',
    critical: true,
  };
}

// Set up a claimed+spawned direct-CLI remediation worker whose stderr log holds
// `logText`, with no output artifact and no reply — i.e. it exited early. Then
// reconcile it as a dead worker.
async function reconcileDeadWorkerWithLog(rootDir, logText) {
  createFollowUpJob(makeJobInput(rootDir));
  const claimed = claimNextFollowUpJob({ rootDir, claimedAt: '2026-06-16T10:00:00.000Z' });
  const workspaceDir = path.join(rootDir, 'data', 'follow-up-jobs', 'workspaces', claimed.job.jobId);
  const artifactDir = path.join(workspaceDir, '.adversarial-follow-up');
  mkdirSync(artifactDir, { recursive: true });
  const logPath = path.join(artifactDir, 'codex-worker.log');
  writeFileSync(logPath, logText, 'utf8');

  const spawned = markFollowUpJobSpawned({
    jobPath: claimed.jobPath,
    spawnedAt: '2026-06-16T10:01:00.000Z',
    worker: {
      processId: 8123,
      workspaceDir: path.relative(rootDir, workspaceDir),
      outputPath: path.relative(rootDir, path.join(artifactDir, 'codex-last-message.md')),
      logPath: path.relative(rootDir, logPath),
      promptPath: path.relative(rootDir, path.join(artifactDir, 'prompt.md')),
    },
  });

  return reconcileFollowUpJob({
    rootDir,
    jobPath: spawned.jobPath,
    now: () => '2026-06-16T10:05:00.000Z',
    isProcessAliveImpl: () => false,
    resolvePRLifecycleImpl: async () => null,
  });
}

test('a quota-exhausted direct-CLI remediation worker is HELD with provider reset clamped to the max unvalidated window', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  const log = `[reviewer] remediation worker starting...
{"type":"error","message":"You've hit your usage limit. Try again at Jun 17th, 2026 5:39 PM or purchase more credits."}`;
  const reconciled = await reconcileDeadWorkerWithLog(rootDir, log);

  // Held, not failed: the reconcile maps a requeue to reconciled=false.
  assert.equal(reconciled.reconciled, false);
  assert.equal(reconciled.reason, 'quota-exhausted');
  assert.match(reconciled.jobPath, /data\/follow-up-jobs\/pending\/.+\.json$/);
  assert.equal(reconciled.job.status, 'pending');

  // retryAfter is clamped from the provider-reported reset, so a stale far-future
  // reset cannot park remediation for days without live revalidation.
  const expectedReset = '2026-06-16T11:05:00.000Z';
  assert.equal(reconciled.job.remediationPlan.retryAfter, expectedReset);
  assert.equal(reconciled.job.remediationPlan.transientRetries, 1);

  const historyEntry = reconciled.job.remediationPlan.retryHistory.at(-1);
  assert.equal(historyEntry.retryMetadata.code, 'quota-exhausted');
  assert.equal(historyEntry.retryMetadata.harness, 'codex');
  assert.equal(historyEntry.retryMetadata.source, 'provider-reported');
  assert.equal(historyEntry.retryMetadata.providerResetAt, '2026-06-18T00:39:00.000Z');
});

test('a claude-harness quota cap is also held (both harnesses we know the shape for)', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  const log = 'Claude usage limit reached; resets at 2026-06-17T17:39:00Z';
  const reconciled = await reconcileDeadWorkerWithLog(rootDir, log);

  assert.equal(reconciled.reconciled, false);
  assert.equal(reconciled.reason, 'quota-exhausted');
  assert.equal(reconciled.job.status, 'pending');
  assert.equal(reconciled.job.remediationPlan.retryAfter, '2026-06-16T11:05:00.000Z');
  assert.equal(reconciled.job.remediationPlan.retryHistory.at(-1).retryMetadata.harness, 'claude');
});

test('a gemini-harness quota cap is also held (GMW-03 regression: generic resource_exhausted shape)', async () => {
  // GMW-03 makes gemini a real remediation worker class. The gemini CLI
  // surfaces a hard cap as a RESOURCE_EXHAUSTED / "Quota exceeded" shape,
  // which the shared GENERIC_QUOTA_PATTERNS already match — so a capped
  // gemini remediation worker holds-until-recovery exactly like codex/claude
  // instead of terminal-failing. Gemini gives no parseable reset, so it lands
  // on the fixed fallback window.
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  const log = `[reviewer] gemini remediation worker starting...
{"error":{"code":429,"status":"RESOURCE_EXHAUSTED","message":"Quota exceeded for quota metric 'Gemini requests'."}}`;
  const reconciled = await reconcileDeadWorkerWithLog(rootDir, log);

  assert.equal(reconciled.reconciled, false);
  assert.equal(reconciled.reason, 'quota-exhausted');
  assert.equal(reconciled.job.status, 'pending');
  const expected = new Date(Date.parse('2026-06-16T10:05:00.000Z') + 15 * 60 * 1000).toISOString();
  assert.equal(reconciled.job.remediationPlan.retryAfter, expected);
  const historyEntry = reconciled.job.remediationPlan.retryHistory.at(-1);
  assert.equal(historyEntry.retryMetadata.code, 'quota-exhausted');
  assert.equal(historyEntry.retryMetadata.source, 'fallback-window');
});

test('a quota cap with no parseable reset falls back to a fixed hold window', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  const reconciled = await reconcileDeadWorkerWithLog(rootDir, 'Error: you are out of credits');

  assert.equal(reconciled.reconciled, false);
  assert.equal(reconciled.reason, 'quota-exhausted');
  // 15-minute fallback window anchored at the reconcile (completed) time.
  const expected = new Date(Date.parse('2026-06-16T10:05:00.000Z') + 15 * 60 * 1000).toISOString();
  assert.equal(reconciled.job.remediationPlan.retryAfter, expected);
  assert.equal(reconciled.job.remediationPlan.retryHistory.at(-1).retryMetadata.source, 'fallback-window');
});

test('quota hold is bounded: when the retry budget is exhausted it becomes a distinct terminal failure', async () => {
  process.env.ADVERSARIAL_REMEDIATION_MAX_TRANSIENT_RETRIES = '0'; // immediate exhaustion
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  const log = `{"type":"error","message":"You've hit your usage limit. Try again at Jun 17th, 2026 5:39 PM"}`;
  const reconciled = await reconcileDeadWorkerWithLog(rootDir, log);

  assert.equal(reconciled.reconciled, true);
  assert.equal(reconciled.outcome, 'failed');
  assert.equal(reconciled.job.failure.code, 'quota-exhausted-budget-exhausted');
  assert.equal(reconciled.job.failure.harness, 'codex');
});

test('a non-quota empty-artifact failure is unaffected (still terminal artifact-missing)', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  const reconciled = await reconcileDeadWorkerWithLog(rootDir, 'some unrelated worker log with no cap');

  assert.equal(reconciled.reconciled, true);
  assert.equal(reconciled.outcome, 'failed');
  assert.equal(reconciled.job.failure.code, 'artifact-missing-completion');
});
