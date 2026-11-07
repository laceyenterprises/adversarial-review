// CLOSERREVIVE-01: the fixer and the closer must agree on whether a remediation
// job is alive, and a suppressed comment-only final round must reach a closer.
// Synthetic fixtures only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { findActiveRemediationJob } from '../src/ama/active-remediation-job.mjs';
import { describeAmaPendingOwner } from '../src/ama/pending-owner.mjs';
import { maybeDispatchAmaClosureFor } from '../src/ama-closure-orchestration.mjs';
import { sweepStuckInProgressClaims } from '../src/follow-up-stuck-claim-sweep.mjs';
import { remediationJobOwnership, staleClaimMayBeReclaimed, hqLaunchObservation,
  REMEDIATION_HQ_LAUNCH_OBSERVATION_GRACE_MS } from '../src/remediation-job-ownership.mjs';
import { reconcileFollowUpJob } from '../src/follow-up-remediation.mjs';

const REPO = 'fixture/project';
const PR = 77;
const T0 = Date.parse('2026-11-01T10:00:00.000Z');
const iso = ms => new Date(ms).toISOString();

function hqJob(overrides = {}, worker = {}) {
  return {
    schemaVersion: 1, kind: 'adversarial-review-follow-up', jobId: 'job-hq-1', status: 'in_progress',
    repo: REPO, prNumber: PR, createdAt: iso(T0), claimedAt: iso(T0), lastHeartbeatAt: iso(T0),
    remediationWorker: { state: 'spawned', dispatchMode: 'hq', dispatchId: 'dispatch_syn',
      launchRequestId: 'lrq_syn', spawnedAt: iso(T0), ...worker },
    ...overrides,
  };
}

test('an HQ launch that is running owns the job long after any local heartbeat expired', () => {
  const job = hqJob({}, { hqLaunch: hqLaunchObservation('running', iso(T0 + 59 * 60_000)) });
  const now = T0 + 60 * 60_000;
  assert.deepEqual(remediationJobOwnership(job, { now }), { live: true, reason: 'hq-launch-active' });
  for (const status of ['requested', 'leased']) {
    const queued = hqJob({}, { hqLaunch: hqLaunchObservation(status, iso(now - 1000)) });
    assert.equal(remediationJobOwnership(queued, { now }).live, true, status);
  }
});

test('an HQ launch with no recent observation, or a terminal one, does not own the job', () => {
  const now = T0 + 60 * 60_000;
  assert.equal(remediationJobOwnership(hqJob(), { now }).reason, 'worker-liveness-expired');
  const stale = hqJob({}, { hqLaunch: hqLaunchObservation('running', iso(now - REMEDIATION_HQ_LAUNCH_OBSERVATION_GRACE_MS)) });
  assert.equal(remediationJobOwnership(stale, { now }).live, false);
  for (const status of ['succeeded', 'failed']) {
    const terminal = hqJob({}, { hqLaunch: hqLaunchObservation(status, iso(now - 1000)) });
    assert.deepEqual(remediationJobOwnership(terminal, { now }), { live: false, reason: 'hq-launch-terminal' }, status);
  }
  // A just-requested launch has not been observed yet.
  const fresh = hqJob({}, { spawnedAt: iso(now - 30_000) });
  assert.equal(remediationJobOwnership(fresh, { now }).reason, 'fresh-hq-launch');
});

test('a local heartbeat or PID never makes an HQ launch live', () => {
  const now = T0 + 60 * 60_000;
  const job = hqJob({ lastHeartbeatAt: iso(now - 1000) }, { processId: process.pid,
    holderHost: 'any' });
  assert.equal(remediationJobOwnership(job, { now, verifyIdentityImpl: () => ({ match: true }) }).live, false);
});

function seedQueue(t, job, bucket = 'in-progress') {
  const root = mkdtempSync(join(tmpdir(), 'closerrevive-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, 'data', 'follow-up-jobs', bucket);
  mkdirSync(dir, { recursive: true });
  const jobPath = join(dir, `fixture__project-pr-${PR}-${job.jobId}.json`);
  writeFileSync(jobPath, JSON.stringify(job));
  return { root, jobPath };
}

test('an HQ-dispatched job stays owned while its launch runs and stops owning once the launch is terminal', async t => {
  const hqRoot = mkdtempSync(join(tmpdir(), 'closerrevive-hq-'));
  t.after(() => rmSync(hqRoot, { recursive: true, force: true }));
  const { root, jobPath } = seedQueue(t, hqJob({}, { hqRoot }));
  const logger = { log() {}, warn() {} };
  const reads = [];
  const runningAt = T0 + 30 * 60_000;
  const execFileImpl = status => async (command, args) => {
    if (args[0] === 'dispatch' && args[1] === 'status') {
      reads.push(status);
      return { stdout: JSON.stringify({ status, health: 'healthy' }), stderr: '' };
    }
    throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
  };
  // Without any observation the closer reads the job as expired (the bug).
  assert.equal(findActiveRemediationJob(root, { repo: REPO, prNumber: PR },
    { now: iso(runningAt), logger }), null);

  const job = JSON.parse(readFileSync(jobPath, 'utf8'));
  const active = await reconcileFollowUpJob({ rootDir: root, job, jobPath, now: () => iso(runningAt),
    execFileImpl: execFileImpl('running'), resolvePRLifecycleImpl: async () => null, log: logger });
  assert.equal(active.action, 'active');
  assert.equal(active.job.remediationWorker.hqLaunch.status, 'running');
  assert.equal(JSON.parse(readFileSync(jobPath, 'utf8')).remediationWorker.hqLaunch.observedAt, iso(runningAt));

  // The closer now reads the same job as a live owner, a few minutes later too.
  for (const later of [runningAt + 60_000, runningAt + 4 * 60_000]) {
    assert.equal(findActiveRemediationJob(root, { repo: REPO, prNumber: PR },
      { now: iso(later), logger })?.jobId, 'job-hq-1');
  }

  // A terminal launch is not owned, whatever the last observation said.
  const terminal = JSON.parse(readFileSync(jobPath, 'utf8'));
  terminal.remediationWorker.hqLaunch = hqLaunchObservation('succeeded', iso(runningAt + 90_000));
  writeFileSync(jobPath, JSON.stringify(terminal));
  assert.equal(findActiveRemediationJob(root, { repo: REPO, prNumber: PR },
    { now: iso(runningAt + 120_000), logger }), null);
});

test('the stale sweep and the closer never disagree: a live owner is never reclaimed', async t => {
  const now = T0 + 60 * 60_000;
  const cases = {
    'hq running': hqJob({}, { hqLaunch: hqLaunchObservation('running', iso(now - 1000)) }),
    'hq terminal': hqJob({}, { hqLaunch: hqLaunchObservation('failed', iso(now - 1000)) }),
    'hq unobserved': hqJob(),
    'local fresh heartbeat': hqJob({ lastHeartbeatAt: iso(now - 1000) },
      { dispatchMode: undefined, dispatchId: undefined, launchRequestId: undefined, processId: 4242 }),
    'local stale heartbeat': hqJob({}, { dispatchMode: undefined, dispatchId: undefined,
      launchRequestId: undefined, processId: 4242 }),
  };
  for (const [name, job] of Object.entries(cases)) {
    const { root, jobPath } = seedQueue(t, job);
    const closerLive = findActiveRemediationJob(root, { repo: REPO, prNumber: PR },
      { now: iso(now), logger: { log() {}, warn() {} }, verifyIdentityImpl: () => ({ match: false }) }) !== null;
    const decision = staleClaimMayBeReclaimed(job, { now, verifyIdentityImpl: () => ({ match: false }) });
    const hq = job.remediationWorker.dispatchMode === 'hq';
    // For an HQ launch the sweep has no evidence of its own: one predicate answers both.
    // A local worker's progress is read by the sweep from its artifacts.
    if (hq) assert.equal(decision.reclaim, !closerLive, `${name}: one predicate answers both`);
    const summary = await sweepStuckInProgressClaims({ rootDir: root, nowMs: now, thresholdMs: 1,
      log: { log() {}, warn() {} }, isWorkerRunning: () => false, readWorkerCpuImpl: () => 0,
      sendWorkerSignalImpl: async () => ({ signalled: false, skipped: true }),
      postCommentImpl: async () => ({}), resolvePRLifecycleImpl: async () => null });
    if (hq && closerLive) {
      assert.equal(summary.reclaimed + summary.requeued + summary.terminalStopped, 0,
        `${name}: a live owner must not be reclaimed`);
      assert.equal(readdirSync(join(root, 'data', 'follow-up-jobs', 'in-progress')).length, 1);
      assert.equal(JSON.parse(readFileSync(jobPath, 'utf8')).status, 'in_progress');
    }
  }
});

test('an unknown-launch ownership is named by its actor or released', () => {
  assert.deepEqual(describeAmaPendingOwner({ launchRequestId: 'lrq_x', workerClass: 'hammer' }),
    { owned: true, label: 'lrq=lrq_x', workerClass: 'hammer' });
  assert.equal(describeAmaPendingOwner({ dispatchId: 'dispatch_x' }).label, 'lrq=dispatch_x');
  const named = describeAmaPendingOwner({ nextAction: { actor: 'remediator', action: 'remediate', reason: 'live-owner' } });
  assert.deepEqual([named.owned, named.label], [true, 'owner=remediator(remediate:live-owner)']);
  assert.equal(describeAmaPendingOwner({ reason: 'ama-closer-dispatch-backgrounded' }, { launching: true }).label,
    'owner=closer(launching)');
  assert.equal(describeAmaPendingOwner({}, { leaseWait: true }).owned, true);
  assert.equal(describeAmaPendingOwner({ reason: 'in-flight:lrq_x' }).owned, true);
  for (const result of [{}, null, { nextAction: { actor: 'none' } }]) {
    const released = describeAmaPendingOwner(result);
    assert.deepEqual([released.owned, released.label], [false, 'owner=none']);
    assert.ok(!released.label.includes('unknown'));
  }
});

// ---- A suppressed comment-only final round reaches a closer launch ----------
const REVIEWED = '1'.repeat(40);
const MOVED = '2'.repeat(40);
const BODY = ['## Summary', 'Docs only.', '', '## Blocking issues', '- None.', '',
  '## Non-blocking issues', '- **Typo**', '  - **Problem:** ambiguous.', '', '## Verdict', 'Comment only'].join('\n');

function finalRoundJob(overrides = {}, worker = {}) {
  return {
    schemaVersion: 1, kind: 'adversarial-review-follow-up', jobId: 'job-final-1', status: 'in_progress',
    repo: REPO, prNumber: PR, domainId: 'code-pr', revisionRef: REVIEWED, riskClass: 'low',
    finalRound: 'comment-only', nonBlockingOnly: true, reviewBody: BODY,
    createdAt: iso(Date.now() - 3600_000), claimedAt: iso(Date.now() - 3600_000),
    remediationPlan: { currentRound: 1, maxRounds: 2, stop: null },
    remediationWorker: { state: 'spawned', dispatchMode: 'hq', dispatchId: 'dispatch_syn',
      launchRequestId: 'lrq_syn', spawnedAt: iso(Date.now() - 3600_000), ...worker },
    ...overrides,
  };
}

function closureArgs(rootDir, overrides = {}) {
  return {
    rootDir,
    reviewStateRow: { repo: REPO, pr_number: PR, pr_state: 'open', review_status: 'posted',
      last_verdict: 'Comment only', risk_class: 'low', remediation_pending: 0, reviewer: 'gemini',
      reviewer_head_sha: REVIEWED, posted_at: '2026-09-28T22:33:55Z' },
    dispatchJob: {},
    candidate: { headSha: MOVED, riskClass: 'low', prAuthor: 'claude-code-worker', prState: 'open',
      mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', isDraft: false,
      statusCheckRollup: [{ __typename: 'CheckRun', name: 'repo-guards', status: 'COMPLETED', conclusion: 'SUCCESS' }],
      branchProtection: { requiredContexts: [] } },
    labelNames: [], operatorApprovalEvent: null, adversarialMergeRequestedEvent: null,
    repoPath: REPO, prNumber: PR, currentRevisionRef: MOVED,
    logger: { log() {}, warn() {} },
    loadConfigImpl: () => ({ getMergeAuthorityConfig: () => ({ enabled: true }) }),
    resolveAmaHammerDispatchModeImpl: () => 'inline',
    fetchLatestHeadReviewBodiesImpl: async () => [BODY],
    resolveHeadCloserCommitSuppressionImpl: async () => ({ suppressed: false, reason: 'not-closer-commit' }),
    fetchMergedProtectiveDependentsImpl: async () => [],
    runDaemonCleanMergeAttemptImpl: async () => ({ disposition: 'not-taken', reason: 'non-blocking-findings-present' }),
    requestEligibleHammerWakeImpl: () => ({ requested: false }),
    ...overrides,
  };
}

test('a suppressed comment-only final round whose job is not live launches the closer', async t => {
  const { root } = seedQueue(t, finalRoundJob());
  let launched = null;
  const result = await maybeDispatchAmaClosureFor(closureArgs(root, {
    maybeDispatchAmaCloserImpl: async args => {
      launched = args;
      return { dispatched: true, launchRequestId: 'lrq_closer' };
    } }));
  assert.ok(launched, 'the closer launches instead of waiting for an exact-head review');
  assert.equal(launched.sharedNextAction.decision.action, 'hammer');
  assert.equal(launched.sharedNextAction.decision.reason, 'suppressed-final-push');
  assert.equal(result.dispatched, true);
});

test('the same final round with a running HQ launch keeps its remediator, not a closer', async t => {
  const job = finalRoundJob({}, { hqLaunch: hqLaunchObservation('running', iso(Date.now() - 1000)) });
  const { root } = seedQueue(t, job);
  const result = await maybeDispatchAmaClosureFor(closureArgs(root, {
    maybeDispatchAmaCloserImpl: async () => assert.fail('a live remediation launch owns the head') }));
  assert.equal(result.dispatched, false);
  assert.notEqual(result.nextAction?.action, 'review');
});

test('a moved head with no final round in progress still waits for an exact-head review', async t => {
  const { root } = seedQueue(t, finalRoundJob({ finalRound: undefined }));
  const result = await maybeDispatchAmaClosureFor(closureArgs(root, {
    maybeDispatchAmaCloserImpl: async () => assert.fail('no closer launches without a review') }));
  assert.equal(result.nextAction?.action, 'review');
});
