// REMFALLBACK-01 item 3: a capped remediator provider spends no retry budget
// and is never respawned while its cap lasts. Covers the budget-neutral requeue,
// the no-respawn hold a claim takes when nothing can replace the capped class,
// and the claim gate's revalidation, which must not release that hold into a
// claim that would only re-hold it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  claimNextFollowUpJob,
  createFollowUpJob,
  readFollowUpJob,
  requeueInProgressFollowUpJobForRetry,
} from '../src/follow-up-jobs.mjs';
import { holdClaimedJobForCappedRemediator } from '../src/remediation-claimed-requeue.mjs';
import { createQuotaHoldRevalidator } from '../src/remediation-admission.mjs';
import { quotaHoldTarget } from '../src/remediation-quota-evidence.mjs';

function makeJobInput(rootDir) {
  return {
    rootDir,
    repo: 'laceyenterprises/agent-os',
    prNumber: 7325,
    reviewerModel: 'gemini',
    builderTag: 'claude-code',
    linearTicketId: null,
    reviewBody: '## Summary\nFix the hydration order.\n\n## Verdict\nRequest changes',
    reviewPostedAt: '2026-09-29T01:40:00.000Z',
    critical: true,
  };
}

function claimFresh(rootDir, claimedAt = '2026-09-29T01:42:11.343Z') {
  createFollowUpJob(makeJobInput(rootDir));
  return claimNextFollowUpJob({ rootDir, claimedAt });
}

const CAPPED_NO_FALLBACK = Object.freeze({
  workerClass: 'codex',
  fellBack: false,
  hold: true,
  holdUntil: '2026-09-29T03:45:15.389Z',
  reason: 'no-available-fallback',
  capSource: 'provider-reset-past-hold-window',
  primaryState: 'unverified',
  model: null,
  resetAt: '2026-10-04T12:52:00.000Z',
  skipped: [{ workerClass: 'claude-code', reason: 'capped:afh-soft-grounded' }],
});

test('requeueInProgressFollowUpJobForRetry can hold without spending the retry budget', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'remfallback-hold-'));
  const claimed = claimFresh(rootDir);
  const requeued = requeueInProgressFollowUpJobForRetry({
    rootDir,
    jobPath: claimed.jobPath,
    requeuedAt: '2026-09-29T01:45:15.389Z',
    retryReason: 'Provider usage cap hit (codex harness).',
    retryAfterOverride: '2026-10-04T12:52:00.000Z',
    allowDirectWorkerRetry: true,
    chargeRetryBudget: false,
    retryMetadata: { code: 'quota-exhausted', harness: 'codex', providerResetAt: '2026-10-04T12:52:00.000Z' },
  });
  assert.equal(requeued.job.status, 'pending');
  assert.equal(requeued.job.remediationPlan.transientRetries, 0);
  assert.equal(requeued.job.remediationPlan.retryHistory.at(-1).transientRetry, 0);
  // Still clamped to one unvalidated hold window.
  assert.equal(requeued.job.remediationPlan.retryAfter, '2026-09-29T02:45:15.389Z');
});

test('holdClaimedJobForCappedRemediator returns the claim to pending budget-neutral, with no respawn', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'remfallback-hold-'));
  const claimed = claimFresh(rootDir, '2026-09-29T02:45:15.389Z');
  const delayed = new Set();
  const lines = [];
  const held = holdClaimedJobForCappedRemediator({
    rootDir,
    jobPath: claimed.jobPath,
    heldAt: claimed.job.claimedAt,
    routing: CAPPED_NO_FALLBACK,
    delayedPendingPaths: delayed,
    log: { log: (line) => lines.push(line) },
  });

  assert.equal(held.consumed, false);
  assert.equal(held.reason, 'remediator-capped-hold');
  assert.match(held.jobPath, /follow-up-jobs\/pending\//);
  assert.ok(delayed.has(held.jobPath), 'not claimable again in the same drain');

  const job = readFollowUpJob(held.jobPath);
  assert.equal(job.status, 'pending');
  assert.equal(job.remediationWorker, null);
  assert.equal(job.remediationPlan.currentRound, 0, 'the claimed round is returned');
  assert.equal(job.remediationPlan.transientRetries, 0, 'no retry budget spent');
  assert.equal(job.remediationPlan.retryAfter, CAPPED_NO_FALLBACK.holdUntil);
  const entry = job.remediationPlan.retryHistory.at(-1);
  assert.equal(entry.round, 1);
  assert.equal(entry.retryMetadata.code, 'quota-exhausted');
  assert.equal(entry.retryMetadata.workerClass, 'codex');
  assert.equal(entry.retryMetadata.noRespawn, true);
  assert.equal(entry.retryMetadata.providerResetAt, '2026-10-04T12:52:00.000Z');
  assert.equal(entry.retryMetadata.source, 'remediator-fallback-resolution');
  assert.deepEqual(entry.retryMetadata.skipped, CAPPED_NO_FALLBACK.skipped);

  assert.equal(lines.length, 1);
  assert.match(lines[0], /remediator-capped-hold \(codex capped \(provider-reset-past-hold-window, resets 2026-10-04T12:52:00.000Z\); fallback: claude-code capped:afh-soft-grounded\)/);
  // Must not look like a provider-reported hold to the fleet hold counter.
  assert.doesNotMatch(lines[0], /quota-exhausted \(/);
  assert.doesNotMatch(lines[0], /\[provider-reported\]/);

  // The pending job is held: a claim before holdUntil does not pick it up.
  assert.equal(claimNextFollowUpJob({ rootDir, claimedAt: '2026-09-29T03:00:00.000Z' }), null);
});

function heldNoRespawnJob(rootDir) {
  const claimed = claimFresh(rootDir, '2026-09-29T02:45:15.389Z');
  return holdClaimedJobForCappedRemediator({
    rootDir,
    jobPath: claimed.jobPath,
    heldAt: claimed.job.claimedAt,
    routing: CAPPED_NO_FALLBACK,
    log: { log() {} },
  });
}

test('a no-respawn hold is not released by an "available" verdict from a probe older than the hold', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'remfallback-hold-'));
  heldNoRespawnJob(rootDir);
  const claimed = claimNextFollowUpJob({
    rootDir,
    claimedAt: '2026-09-29T03:00:00.000Z',
    quotaHoldRevalidator: () => ({ available: true, state: 'ok', lastGoodAt: '2026-09-29T02:00:00.000Z' }),
  });
  assert.equal(claimed, null, 'an old good probe would only re-resolve to the same hold');
});

test('a no-respawn hold is released by a good probe newer than the hold (cap cleared)', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'remfallback-hold-'));
  heldNoRespawnJob(rootDir);
  const seen = [];
  const claimed = claimNextFollowUpJob({
    rootDir,
    claimedAt: '2026-09-29T03:00:00.000Z',
    quotaHoldRevalidator: (input) => {
      seen.push(input);
      return { available: true, state: 'ok', lastGoodAt: '2026-09-29T02:55:00.000Z' };
    },
  });
  assert.equal(claimed?.job?.status, 'in_progress');
  assert.equal(seen[0].harness, 'codex');
});

test('quotaHoldTarget prefers the recorded worker class and carries the model', () => {
  const target = quotaHoldTarget({
    remediationPlan: {
      retryHistory: [{
        requeuedAt: '2026-09-29T01:45:15.389Z',
        retryMetadata: { code: 'quota-exhausted', harness: 'claude', workerClass: 'claude-code', model: 'claude-opus-5-5' },
      }],
    },
  });
  assert.deepEqual(target, {
    harness: 'claude-code',
    model: 'claude-opus-5-5',
    noRespawn: false,
    requeuedAt: '2026-09-29T01:45:15.389Z',
  });
  // Legacy entries (the live #7325 shape) still resolve to their harness label.
  assert.equal(quotaHoldTarget({
    remediationPlan: { retryHistory: [{ retryMetadata: { code: 'quota-exhausted', harness: 'codex' } }] },
  }).harness, 'codex');
});

test('the default quota-hold revalidator is model-aware: an exhausted routed model keeps the hold', async () => {
  const revalidator = createQuotaHoldRevalidator({
    execFileImpl: async () => ({
      stdout: JSON.stringify({
        providerStatuses: [{
          provider: 'openai',
          authPath: 'oauth',
          state: 'ok',
          lastGoodAt: '2026-09-29T02:50:00.000Z',
          models: [
            { model: 'gpt-6-sol', state: 'exhausted', resetAtUtc: '2026-10-04T12:52:00.000Z' },
            { model: 'gpt-6-mini', state: 'ok', lastGoodAt: '2026-09-29T02:50:00.000Z' },
          ],
        }],
      }),
    }),
    nowMs: () => 1000,
  });
  await revalidator.prefetch({ harnesses: ['codex'], nowMs: 1000 });
  const providerOnly = revalidator({ harness: 'codex', nowMs: 1000 });
  assert.equal(providerOnly.available, true, 'the provider-level verdict alone is unchanged');

  const rootDir = mkdtempSync(path.join(tmpdir(), 'remfallback-hold-'));
  const claimed = claimFresh(rootDir);
  requeueInProgressFollowUpJobForRetry({
    rootDir,
    jobPath: claimed.jobPath,
    requeuedAt: '2026-09-29T01:45:15.389Z',
    retryAfterOverride: '2026-10-04T12:52:00.000Z',
    allowDirectWorkerRetry: true,
    retryMetadata: { code: 'quota-exhausted', harness: 'codex', workerClass: 'codex', model: 'gpt-6-sol' },
  });
  await revalidator.prefetch({ rootDir, nowMs: 1000 });
  const modelHold = revalidator({ harness: 'codex', model: 'gpt-6-sol', nowMs: 1000 });
  assert.equal(modelHold.available, false);
  assert.equal(modelHold.capSource, 'model-exhausted');
});

test('the default quota-hold revalidator does not release a hold on an AFH soft-grounded provider', async () => {
  const revalidator = createQuotaHoldRevalidator({
    execFileImpl: async () => ({
      stdout: JSON.stringify({
        providerStatuses: [{
          provider: 'openai',
          authPath: 'oauth',
          state: 'ok',
          afhGrounding: { grounded: true, signals: 3, threshold: 3, reason: 'quota_exhausted_kills' },
        }],
      }),
    }),
    nowMs: () => 1000,
  });
  await revalidator.prefetch({ harnesses: ['codex'], nowMs: 1000 });
  const decision = revalidator({ harness: 'codex', nowMs: 1000 });
  assert.equal(decision.available, false);
  assert.equal(decision.capSource, 'afh-soft-grounded');
});
