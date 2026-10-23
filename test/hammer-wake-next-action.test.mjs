import './helpers/rate-limit-state-isolation.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deriveNextActionSnapshot, nextAction } from '../src/pr-next-action.mjs';
import { closureOwnerShadowEvidence, launchSource } from '../src/pr-next-action-consumer.mjs';
import { resolveSharedNextAction, shadowNextAction } from '../src/pr-next-action-shadow.mjs';
import { hammerWakeAuditPath, requestEligibleHammerWake } from '../src/hammer-wake.mjs';
import { evaluateMergeEligibility } from '../src/ama/merge-eligibility.mjs';

const HEAD = 'a'.repeat(40), OLD = 'b'.repeat(40);
const AT = '2026-01-01T00:00:00.000Z';
const quiet = { log() {}, warn() {} };
const subject = { repo: 'subject-03', prNumber: 3, headSha: HEAD };
const clean = { headSha: HEAD, verdict: 'approved', attestation: 'valid',
  blockingFindingState: 'known', blockingFindingCount: 0,
  nonBlockingFindingState: 'known', nonBlockingFindingCount: 0 };
const terminal = { headSha: HEAD, launchRequestId: 'attempt-1', attempt: 1,
  row: { status: 'succeeded' }, retryChain: [], outcome: 'no-merge', retryable: true };

function pair(observations = {}, observedAt = AT) {
  const snapshot = deriveNextActionSnapshot({ subjectKey: 'subject-03', head: HEAD, observedAt,
    anchors: { firstActionableAt: AT }, observations: {
      pr: { headSha: HEAD, state: 'OPEN', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' },
      checks: { conclusion: 'SUCCESS' }, reviews: clean, remediation: { roundsLeft: false },
      leases: { closer: null }, launches: { closer: null }, controls: {}, progress: {},
      policy: { strictMode: true, autonomousMergeExecutionEnabled: true }, ...observations } });
  return { snapshot, decision: nextAction(snapshot) };
}

function fixture(t) {
  const rootDir = mkdtempSync(join(tmpdir(), 'nxa-wake-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const calls = [];
  const wake = (shared, options = {}) => requestEligibleHammerWake({ rootDir, ...subject, shared,
    observedAt: AT, nowMs: Date.parse(AT), log: quiet,
    requestWatcherWakeImpl: payload => { calls.push(payload); return { requested: true }; }, ...options });
  return { rootDir, calls, wake };
}

for (const [name, observations, reason, requested] of [
  ['failed required check on exhausted head', { checks: { rollup: [
    { name: 'check-1', status: 'COMPLETED', conclusion: 'FAILURE' }], requiredContexts: ['check-1'] } }, 'ci-red-final', true],
  ['failure without a runner', { checks: { runnerless: [{}] }, remediation: { roundsLeft: true } }, 'ci-runnerless', true],
  ['failed CI with a round left', { checks: { conclusion: 'FAILURE' }, remediation: { roundsLeft: true } }, 'ci-red', false],
  ['DIRTY', { pr: { headSha: HEAD, state: 'OPEN', mergeable: 'MERGEABLE', mergeStateStatus: 'DIRTY' } }, 'conflict-rebase', true],
  ['blocking final adjudication', { reviews: { ...clean, verdict: 'request-changes', blockingFindingCount: 1 } }, 'review-findings-final', true],
  ['proven suppressed push', { reviews: { ...clean, headSha: OLD },
    remediation: { finalPush: { headSha: HEAD, suppressed: true } } }, 'suppressed-final-push', true],
  ['unrelated push', { reviews: { ...clean, headSha: OLD },
    remediation: { finalPush: { headSha: OLD, suppressed: true } } }, 'stale-verdict', false],
  ['no push clean head', {}, 'clean-exact-head', true],
  ['pending checks', { checks: { conclusion: 'PENDING' } }, 'checks-pending', false],
  ['missing required context', { checks: { rollup: [
    { name: 'check-1', status: 'COMPLETED', conclusion: 'SUCCESS' }], requiredContexts: ['check-2'] } }, 'checks-pending', false],
  ['terminal no-merge', { launches: { closer: terminal } }, 'retry-no-merge', true],
  ['unreadable retry chain', { launches: { closer: { ...terminal, retryChainUnreadable: true } } }, 'ownership-unreadable', false],
  ['live retry descendant', { launches: { closer: { ...terminal,
    retryChain: [{ id: 'attempt-2', status: 'running' }] } } }, 'live-owner', false],
  ['sticky merged receipt', { launches: { closer: terminal }, progress: {
    mergeReceipt: { merged: true, headSha: HEAD, path: 'hammer' } } }, 'merge-receipt-unconfirmed', false],
  ['confirmed merged', { pr: { headSha: HEAD, state: 'MERGED' } }, 'merged', false],
  ['retry cap', { policy: { autonomousMergeExecutionEnabled: true, hammerCap: { retryExhausted: true, headSha: HEAD } } }, 'retry-exhausted', false],
  ['deterministic refusal precedes DIRTY', { controls: { safetyRefusal: { deterministic: true } },
    pr: { headSha: HEAD, state: 'OPEN', mergeStateStatus: 'DIRTY' } }, 'safety-refusal', false],
  ['drain retains repair intent', { checks: { conclusion: 'FAILURE' }, policy: {
    autonomousMergeExecutionEnabled: true, drain: { active: true, epoch: 1 } } }, 'ci-red-final', false],
  ['capacity retains repair intent', { checks: { conclusion: 'FAILURE' }, policy: {
    autonomousMergeExecutionEnabled: true, capacity: { hammer: { inFlight: 2, cap: 2 } } } }, 'ci-red-final', false],
]) test(`shared wake: ${name}`, t => {
  const f = fixture(t), shared = pair(observations);
  assert.equal(shared.decision.reason, reason);
  const result = f.wake(shared, { eligibility: { eligible: !requested, reasons: ['synthetic-legacy-disagreement'] } });
  assert.equal(result.outcome, requested ? 'requested' : 'skipped');
  assert.equal(f.calls.length, Number(requested));
  assert.equal(result.nextAction, shared.decision);
  if (requested) {
    const audit = JSON.parse(readFileSync(result.auditPath, 'utf8'));
    assert.equal(audit.nextAction.decisionKey, shared.decision.decisionKey);
    assert.deepEqual(audit.nextAction.deadline, shared.decision.deadline);
  }
});

test('delivered wake rearms once per reconciled attempt despite unchanged head and later clocks', t => {
  const f = fixture(t);
  assert.equal(f.wake(pair()).outcome, 'requested');
  for (const id of ['attempt-1', 'attempt-2']) {
    const observations = { launches: { closer: { ...terminal, launchRequestId: id } } };
    assert.equal(f.wake(pair(observations)).outcome, 'requested');
    assert.equal(f.wake(pair(observations, '2026-01-01T01:00:00.000Z')).outcome, 'duplicate');
  }
  assert.equal(f.calls.length, 3);
});

test('concurrent duplicate sees the exclusive reservation before transport completes', t => {
  const f = fixture(t), shared = pair();
  let nested;
  assert.equal(f.wake(shared, { requestWatcherWakeImpl: () => {
    nested = f.wake(shared);
    return { requested: true };
  } }).outcome, 'requested');
  assert.equal(nested.outcome, 'duplicate');
  assert.equal(f.calls.length, 0);
});

test('completed fleet retry descendants advance identity without depending on row order or timestamps', t => {
  const f = fixture(t);
  const run = retryChain => f.wake(pair({ launches: { closer: { ...terminal, retryChain } } }));
  assert.equal(run([]).outcome, 'requested');
  const child = { launch_request_id: 'attempt-2', status: 'failed' };
  assert.equal(run([child]).outcome, 'requested');
  assert.equal(run([{ ...child, updated_at: AT }]).outcome, 'duplicate');
  const descendant = { launch_request_id: 'attempt-3', status: 'succeeded' };
  assert.equal(run([child, descendant]).outcome, 'requested');
  assert.equal(run([descendant, child]).outcome, 'duplicate');
  assert.equal(f.calls.length, 3);
});

test('transport failure retries through the existing bounded election on the same attempt', t => {
  const f = fixture(t), shared = pair({ launches: { closer: terminal } });
  const failed = f.wake(shared, { requestWatcherWakeImpl: () => { throw new Error('synthetic transport error'); } });
  assert.equal(failed.outcome, 'failed');
  assert.equal(failed.retryable, true);
  assert.equal(f.wake(shared).outcome, 'requested');
  assert.equal(f.wake(shared).outcome, 'duplicate');
  assert.equal(f.calls.length, 1);
});

test('wake uses copied evidence and cannot consume a different head generation', t => {
  const f = fixture(t), shared = pair();
  assert.equal(Object.isFrozen(shared.snapshot.observations), true);
  assert.equal(f.wake(shared, { headSha: OLD }).outcome, 'skipped');
  assert.equal(f.calls.length, 0);
});

test('shared enrichment keeps policy constraints, runnerless evidence, semantic proof and one decision across consumers', async () => {
  const pass = pair({ checks: { runnerless: [{}] }, policy: { drain: { active: true } },
    progress: { contentProof: { kind: 'context-only-rebase', semantic: true, fromHead: OLD, toHead: HEAD } } }).snapshot;
  const shared = await resolveSharedNextAction({ passSnapshot: pass,
    evidence: closureOwnerShadowEvidence({ currentHead: HEAD, lease: null, roundsLeft: false,
      checks: 'SUCCESS', reviewState: clean }, { autonomousMergeExecutionEnabled: true }) });
  assert.equal(shared.decision.reason, 'ci-runnerless');
  assert.equal(shared.decision.queue.deferredBy, 'drain');
  assert.equal(shared.snapshot.observations.progress.value.contentProof.semantic, true);
  const shadow = await shadowNextAction({ passSnapshot: pass, env: {}, sink() {}, now: () => Date.parse(AT) });
  assert.equal(shadow.decision, shared.decision);
});

test('sticky succeeded lease and receipt survive stale terminal process projection', async () => {
  for (const input of [
    { lease: { status: 'terminal', terminalOutcome: 'succeeded', headSha: HEAD } },
    { lease: null, launchRecord: { outcome: 'succeeded' } },
  ]) {
    const shared = await resolveSharedNextAction({ passSnapshot: pair({ launches: { closer: terminal } }).snapshot,
      evidence: closureOwnerShadowEvidence({ ...input, currentHead: HEAD, roundsLeft: false, checks: 'FAILURE',
        reviewState: clean }, { autonomousMergeExecutionEnabled: true }) });
    assert.equal(shared.decision.reason, 'merge-receipt-unconfirmed');
  }
});

test('a retained dispatch receipt supplies retry identity after terminal lease removal', async () => {
  const evidence = closureOwnerShadowEvidence({ currentHead: HEAD, lease: null, roundsLeft: false,
    reviewState: clean, launchRecord: { launchRequestId: 'attempt-1' } }, { rootDir: 'synthetic-root',
    autonomousMergeExecutionEnabled: true });
  assert.equal(typeof evidence.readLaunches, 'function');
  let reads = 0;
  evidence.readLaunches = async () => {
    reads++;
    return launchSource({ state: 'complete', value: { terminal: true, launchRequestId: 'attempt-1',
      launch: { status: 'succeeded' }, retryChain: [] } }, { headSha: HEAD }, {});
  };
  const shared = await resolveSharedNextAction({ passSnapshot: pair().snapshot, evidence });
  assert.equal(reads, 1);
  assert.equal(shared.decision.reason, 'retry-no-merge');
  assert.equal(shared.snapshot.observations.launches.value.closer.launchRequestId, 'attempt-1');
});

for (const state of ['unknown', 'error', 'throw']) test(`retained receipt survives ${state} descendant reads without a lease`, async t => {
  const f = fixture(t);
  const evidence = closureOwnerShadowEvidence({ currentHead: HEAD, lease: null, roundsLeft: false,
    checks: 'FAILURE', reviewState: clean, launchRecord: { launchRequestId: 'attempt-1' } }, {
    rootDir: 'synthetic-root', autonomousMergeExecutionEnabled: true });
  evidence.readLaunches = async () => {
    if (state === 'throw') throw new Error('synthetic ledger error');
    return { state, value: null, provenance: { sourceRef: 'synthetic-ledger' } };
  };
  const shared = await resolveSharedNextAction({ passSnapshot: pair().snapshot, evidence });
  assert.equal(shared.decision.reason, 'ownership-unreadable');
  assert.equal(shared.snapshot.observations.launches.provenance.ledgerReadState, state === 'throw' ? 'error' : state);
  assert.equal(f.wake(shared).outcome, 'skipped');
  assert.equal(f.calls.length, 0);
});

test('red CI and conflict wakes grant no merge permission', t => {
  const f = fixture(t);
  for (const [checks, mergeable, mergeStateStatus] of [
    [[{ name: 'check-1', status: 'COMPLETED', conclusion: 'FAILURE' }], 'MERGEABLE', 'CLEAN'],
    [[{ name: 'check-1', status: 'COMPLETED', conclusion: 'SUCCESS' }], 'CONFLICTING', 'DIRTY'],
  ]) {
    const shared = pair({ checks: { rollup: checks },
      pr: { headSha: HEAD, state: 'OPEN', mergeable, mergeStateStatus } });
    assert.equal(shared.decision.action, 'hammer');
    assert.ok(['requested', 'duplicate'].includes(f.wake(shared).outcome));
    const permission = evaluateMergeEligibility({ verdict: 'settled-success', leaseHeld: true,
      candidateHead: HEAD, validatedHead: HEAD, requiredChecks: checks, mergeable, mergeStateStatus,
      prState: 'OPEN', branchProtectionRequired: false });
    assert.equal(permission.eligible, false);
    assert.ok(permission.reasons.includes(mergeable === 'CONFLICTING' ? 'pr-not-mergeable' : 'ci-not-green'));
  }
});

test('audit path binds retry identity independently of decision reason and deadline', () => {
  assert.notEqual(hammerWakeAuditPath('synthetic-root', { ...subject, wakeAttemptKey: 'attempt-1' }),
    hammerWakeAuditPath('synthetic-root', { ...subject, wakeAttemptKey: 'attempt-2' }));
});
