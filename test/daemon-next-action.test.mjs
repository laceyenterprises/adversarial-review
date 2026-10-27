import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deriveNextActionSnapshot, nextAction } from '../src/pr-next-action.mjs';
import { resolveSharedNextAction } from '../src/pr-next-action-shadow.mjs';
import { observeDaemonGate, observeDaemonResult, reviseClosureNextAction } from '../src/ama/closure-next-action.mjs';
import { attemptDaemonCleanMerge } from '../src/ama/daemon-merge.mjs';
import { resolveMergeAgentCoexistenceForWatcher } from '../src/ama-closure-orchestration.mjs';
import { runDaemonCleanMergeAttempt } from '../src/daemon-clean-merge.mjs';
import { primaryChangeFixture } from './helpers/primary-change.mjs';
import { isTransientDaemonDecline } from '../src/ama/daemon-decline.mjs';
import { readDaemonBuildIdentity } from '../src/daemon-worker-identity.mjs';

const HEAD = 'a'.repeat(40), OLD = 'b'.repeat(40), OTHER = 'c'.repeat(40);
const AT = '2026-01-01T00:00:00.000Z';
const quiet = { log() {}, warn() {}, error() {} };
const green = [{ name: 'unit', status: 'COMPLETED', conclusion: 'SUCCESS' }];
const clean = { headSha: HEAD, verdict: 'approved', blockingFindingState: 'known', blockingFindingCount: 0,
  nonBlockingFindingState: 'known', nonBlockingFindingCount: 0 };
function pair(observations = {}) {
  const snapshot = deriveNextActionSnapshot({ subjectKey: 'subject-06#6', head: HEAD, observedAt: AT,
    anchors: { firstActionableAt: AT }, observations: {
      pr: { state: 'OPEN', headSha: HEAD, mergeable: 'MERGEABLE', labels: [] },
      checks: { rollup: green }, reviews: clean, remediation: { roundsLeft: false },
      leases: { closer: null }, launches: { closer: null },
      policy: { autonomousMergeExecutionEnabled: true, strictMode: true }, ...observations } });
  return Object.freeze({ snapshot, decision: nextAction(snapshot) });
}
const gate = (overrides = {}) => ({ candidateHead: HEAD, prState: 'OPEN', mergeable: 'MERGEABLE',
  mergeStateStatus: 'CLEAN', labels: [], requiredChecks: green, ...overrides });
function owned(shared) {
  assert.ok(shared.decision.actor);
  if (!['done', 'operator-hold'].includes(shared.decision.action)) {
    assert.ok(Number.isFinite(Date.parse(shared.decision.deadline.at)));
    assert.equal(shared.decision.deadline.anchoredAt, AT);
  }
}

for (const [name, live, action, actor] of [
  ['failed', gate({ requiredChecks: [{ name: 'unit', status: 'COMPLETED', conclusion: 'FAILURE' }] }), 'hammer', 'hammer'],
  ['pending', gate({ requiredChecks: [{ name: 'unit', status: 'IN_PROGRESS' }] }), 'wait-for-CI', 'ci'],
  ['missing checks', gate({ requiredChecks: [] }), 'wait-for-CI', 'ci'],
  ['missing required context', gate({ requiredCheckContexts: ['other'] }), 'wait-for-CI', 'ci'],
  ['UNKNOWN', gate({ mergeable: 'UNKNOWN' }), 'wait-for-CI', 'ci'],
  ['conflict', gate({ mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' }), 'hammer', 'hammer'],
  ['moved head', gate({ candidateHead: OTHER }), 'review', 'reviewer'],
  ['missing head', gate({ candidateHead: '' }), 'wait-for-CI', 'watcher'],
  ['read error', { readError: true }, 'wait-for-CI', 'watcher'],
]) test(`daemon live evidence selects one owner: ${name}`, async () => {
  const first = pair(), pass = first.snapshot;
  const observed = observeDaemonGate(first, live, pass);
  assert.equal(observed.decision.action, action);
  assert.equal(observed.decision.actor, actor);
  assert.ok(observed.snapshot.generation > (first.snapshot.generation || 0));
  assert.equal((await resolveSharedNextAction({ passSnapshot: pass })), observed);
  assert.equal(first.decision.action, 'daemon-merge');
  if (name === 'read error') assert.equal(observed.snapshot.observations.pr.state, 'error');
  if (name === 'missing head') assert.equal(observed.snapshot.observations.pr.state, 'unknown');
  owned(observed);
});

for (const strictMode of [true, false]) {
  for (const strictNonBlockingRemediation of [true, false]) {
    test(`daemon policy retains findings: strict=${strictMode}, domain=${strictNonBlockingRemediation}`, () => {
      const policy = { autonomousMergeExecutionEnabled: true, strictMode, strictNonBlockingRemediation };
      const nonblocking = pair({ policy, reviews: { ...clean, nonBlockingFindingCount: 1 } });
      assert.equal(nonblocking.decision.action, strictMode ? 'hammer' : 'daemon-merge');
      for (const reviews of [{ ...clean, blockingFindingCount: 1, verdict: 'request-changes' },
        { ...clean, blockingFindingState: 'unknown' }, { ...clean, nonBlockingFindingState: 'unknown' }]) {
        assert.notEqual(pair({ policy, reviews }).decision.action, 'daemon-merge');
      }
      const live = observeDaemonGate(pair({ policy }), gate({ primaryChange: primaryChangeFixture(HEAD) }));
      assert.equal(live.decision.action, 'daemon-merge');
      owned(live);
    });
  }
}

test('CLEAN mergeability never substitutes for the review verdict or current-head proof', () => {
  for (const reviews of [{ ...clean, verdict: null }, { ...clean, headSha: OLD }]) {
    assert.equal(observeDaemonGate(pair({ reviews }), gate()).decision.action, 'review');
  }
  const terminal = pair({ reviews: { ...clean, headSha: OLD, verdict: 'request-changes', blockingFindingCount: 1 },
    progress: { terminalReview: { validated: true, headSha: HEAD, reviewedHeadSha: OLD } } });
  assert.equal(terminal.decision.action, 'daemon-merge');
  assert.equal(observeDaemonGate(terminal, gate({ candidateHead: OTHER })).decision.action, 'review');
  for (const attestation of ['invalid', 'unknown']) {
    const shared = pair({ reviews: { ...clean, attestation } });
    assert.equal(shared.decision.action, attestation === 'invalid' ? 'review' : 'wait-for-CI');
    owned(shared);
  }
});

for (const result of [
  { disposition: 'not-taken', reason: 'unrecognized-synthetic-reason' },
  { disposition: 'failed-closed', reason: 'worker-identity-unresolved', reasons: ['missing-produced-head-attestation'] },
  { disposition: 'failed-closed', reason: 'worker-identity-unresolved', reasons: ['head-attestation-chain-read-failed'] },
  { disposition: 'failed-closed', reason: 'worker-identity-unresolved', reasons: ['build-completion-read-failed'] },
  { disposition: 'failed-closed', reason: 'worker-identity-unresolved', reasons: ['identity-read-transient'] },
  { disposition: 'not-taken', reason: 'not-eligible', reasons: ['branch-protection-missing-gate'] },
  { disposition: 'not-taken', reason: 'not-eligible', reasons: ['duplicate-family-unresolved'] },
  { disposition: 'not-taken', reason: 'protective-predecessor-state-unreadable' },
  { disposition: 'failed-closed', reason: 'builder-token-merge-refused' },
  { disposition: 'failed-closed', reason: 'merge-retry-budget-exhausted', attempts: 2 },
  { disposition: 'deferred', reason: 'lease-contended' },
]) test(`daemon decline retains a common owner: ${result.reason}/${result.reasons?.[0] || ''}`, () => {
  const shared = observeDaemonResult(pair(), result);
  owned(shared);
  assert.notEqual(shared.decision.action, 'operator-hold');
  if (result.reason === 'lease-contended') assert.equal(shared.decision.reason, 'snapshot-refresh');
  if (result.reason === 'merge-retry-budget-exhausted') assert.equal(shared.decision.actor, 'hammer');
  if (result.reasons?.includes('head-attestation-chain-read-failed')) assert.equal(shared.decision.reason, 'snapshot-refresh');
  if (result.reasons?.includes('build-completion-read-failed')) assert.equal(shared.decision.reason, 'snapshot-refresh');
  if (result.reasons?.includes('identity-read-transient')) assert.equal(shared.decision.reason, 'snapshot-refresh');
  if (result.reasons?.includes('missing-produced-head-attestation')) assert.equal(shared.decision.actor, 'closure-recovery');
  if (result.reason === 'unrecognized-synthetic-reason') assert.equal(shared.decision.actor, 'watcher');
  if (result.reasons?.some(reason => ['branch-protection-missing-gate', 'duplicate-family-unresolved'].includes(reason))
    || result.reason === 'protective-predecessor-state-unreadable') {
    const red = observeDaemonGate(shared, gate({ mergeable: 'CONFLICTING',
      requiredChecks: [{ name: 'unit', status: 'COMPLETED', conclusion: 'FAILURE' }] }));
    assert.equal(red.decision.actor, 'closure-recovery');
  }
});

test('identity recovery requires explicit read failures and never clears missing provenance', () => {
  for (const reasons of [undefined, [], ['worker-identity-unresolved'], ['missing-produced-head-attestation'],
    ['head-attestation-chain-read-failed', 'worker-identity-unresolved'],
    ['identity-read-transient', 'worker-observation-inconclusive'],
    ['identity-read-transient', 'unconfirmed-pr-opener-provenance']]) {
    const execution = { headSha: HEAD, reason: 'worker-identity-unresolved', reasons };
    assert.equal(isTransientDaemonDecline(execution), false);
    const refused = pair({ progress: { daemonExecution: execution } });
    assert.equal(refused.decision.reason, 'safety-refusal');
    assert.equal(observeDaemonGate(refused, gate()).decision.reason, 'safety-refusal');
    assert.equal(isTransientDaemonDecline({ reason: 'gate-not-eligible', reasons }), false);
  }
  for (const reasons of [['head-attestation-chain-read-failed'], ['build-completion-read-failed'],
    ['head-attestation-chain-read-failed', 'build-completion-read-failed'], ['identity-read-transient']]) {
    const execution = { headSha: HEAD, reason: 'worker-identity-unresolved', reasons };
    assert.equal(isTransientDaemonDecline(execution), true);
    const held = pair({ progress: { daemonExecution: execution } });
    assert.equal(held.decision.reason, 'snapshot-refresh');
    assert.equal(observeDaemonGate(held, gate()).decision.action, 'daemon-merge');
    assert.equal(isTransientDaemonDecline({ ...execution, permanent: true }), false);
  }
});

test('IDENTITYREAD503-01: exhausted opener read reaches the real decline and same-head retry decision', async t => {
  const rootDir = mkdtempSync(join(tmpdir(), 'identity-read-decline-'));
  t.after(() => rmSync(rootDir, {recursive:true,force:true}));
  let calls = 0;
  const first = pair();
  const result = await runDaemonCleanMergeAttempt({
    rootDir, repoPath:'fixture/subject-06', prNumber:6,
    cfg:{autonomousMergeExecutionEnabled:true,strictMode:true,lha:{consumeAttestations:false}},
    candidate:{headSha:HEAD,baseBranch:'main',prState:'OPEN'}, currentPrHeadSha:HEAD,
    gateSnapshot:{reviewedHeadSha:HEAD,settledReview:{verdict:'approved'}},reviewState:clean,
    sharedNextAction:first,passSnapshot:first.snapshot,env:{HQ_ROOT:rootDir},logger:quiet,
    fetchRollupImpl:async () => ({state:'OPEN',headRefOid:HEAD,checks:green,mergeable:'MERGEABLE',labels:[]}),
    readBuildCompletionSignalForPrImpl:args => readDaemonBuildIdentity(args, {sleepImpl:async()=>{}}),
    dispatchSession:{dispatchLookup:async () => {
      calls++;
      throw Object.assign(new Error('synthetic service unavailable'), {status:503});
    }},
    attemptDaemonCleanMergeImpl:() => assert.fail('unresolved identity cannot reach merge'),
  });
  assert.equal(calls, 3);
  assert.equal(result.reason, 'worker-identity-unresolved');
  assert.deepEqual(result.reasons, ['identity-read-transient']);
  assert.equal(result.leaseAcquired, false);
  assert.equal(isTransientDaemonDecline(result), true);
  const held = observeDaemonResult(first, result);
  assert.equal(held.decision.reason, 'snapshot-refresh');
  const refreshed = observeDaemonGate(held, gate());
  assert.equal(refreshed.decision.action, 'daemon-merge');
  assert.equal(refreshed.decision.head, HEAD);
});

test('wrapped progress clears a superseded decline inside its payload and retains provenance', () => {
  const held = observeDaemonResult(pair(), { reason: 'gate-read-failed' });
  const execution = held.snapshot.observations.progress.value.daemonExecution;
  for (const payload of [{ marker: 'retained' }, { marker: 'retained', daemonExecution: execution }]) {
    const progress = { state: 'complete', value: payload, provenance: { sourceRef: 'wrapped-fixture' } };
    const refreshed = reviseClosureNextAction(held, {
      checks: { state: 'complete', value: { rollup: green, requiredContexts: ['unit'] } }, progress,
    });
    assert.equal(refreshed.decision.action, 'daemon-merge');
    assert.equal(refreshed.snapshot.observations.progress.value.daemonExecution, null);
    assert.equal(refreshed.snapshot.observations.progress.value.marker, 'retained');
    assert.deepEqual(refreshed.snapshot.observations.progress.provenance, progress.provenance);
    assert.equal(held.snapshot.observations.progress.value.daemonExecution, execution);
  }
  for (const progress of [
    { state: 'complete', value: { daemonExecution: { headSha: HEAD, reason: 'synthetic-terminal' } } },
    { state: 'error', value: null }, { state: 'unknown', value: null },
  ]) {
    const refreshed = reviseClosureNextAction(held, { checks: { rollup: green, requiredContexts: ['unit'] }, progress });
    assert.deepEqual(refreshed.snapshot.observations.progress, progress);
  }
});

test('reordered gate collections do not clear an unchanged transient decline', () => {
  const labels = [{ name: 'first' }, { name: 'second' }];
  const rollup = [...green, { context: 'legacy', state: 'SUCCESS' }];
  const held = pair({ pr: { state: 'OPEN', headSha: HEAD, mergeable: 'MERGEABLE', labels },
    checks: { rollup, requiredContexts: ['unit', 'legacy'] },
    progress: { daemonExecution: { headSha: HEAD, reason: 'gate-read-failed' } } });
  const reordered = reviseClosureNextAction(held, {
    pr: { labels: [...labels].reverse(), mergeable: 'MERGEABLE', headSha: HEAD, state: 'OPEN' },
    checks: { requiredContexts: ['legacy', 'unit'], rollup: [...rollup].reverse() },
  });
  assert.equal(reordered, held);
  assert.equal(reordered.decision.reason, 'snapshot-refresh');
});

test('CLOSERREFRESHLOOP-01: a changed live gate supersedes a pending decline without changing the head', () => {
  const pending = observeDaemonGate(pair(), gate({ requiredChecks: [{ name: 'unit', status: 'IN_PROGRESS' }] }));
  const declined = observeDaemonResult(pending, { disposition: 'not-taken', reason: 'pending-required-checks' });
  assert.equal(declined.decision.actor, 'ci');
  const refreshed = observeDaemonGate(declined, gate());
  assert.equal(refreshed.decision.action, 'daemon-merge');
  assert.equal(refreshed.snapshot.observations.progress.value.daemonExecution, null);
  assert.equal(declined.snapshot.observations.progress.value.daemonExecution.reason, 'pending-required-checks');
  assert.equal(refreshed.decision.head, HEAD);
  const terminal = observeDaemonResult(pending, { reason: 'synthetic-terminal', permanent: true });
  const held = observeDaemonGate(terminal, gate());
  assert.equal(held.decision.reason, 'snapshot-refresh');
  assert.equal(held.snapshot.observations.progress.value.daemonExecution.reason, 'synthetic-terminal');
});

test('retry descendants and a live hammer remain owners despite clean daemon evidence', () => {
  for (const launches of [
    { closer: { headSha: HEAD, row: { status: 'running' } } },
    { closer: { headSha: HEAD, row: { status: 'succeeded' }, retryChain: [{ status: 'running' }] } },
    { closer: { headSha: HEAD, row: { status: 'succeeded' }, retryChainUnreadable: true } },
  ]) {
    const shared = observeDaemonGate(pair({ launches }), gate());
    assert.equal(shared.decision.action, 'hammer');
    assert.equal(shared.decision.queue.intent, launches.closer.retryChainUnreadable ? 'reconcile' : 'owned');
    owned(shared);
  }
});

// The real executor is exercised with every process/API/audit/lease adapter
// injected; there is no executable CI seam and no external alert delivery.
async function execute(initial, { live = gate(), result = { exitCode: 0 }, afterFetch,
  confirmed = false, lease = true, overrides = {} } = {}) {
  let shared = initial, reads = 0;
  const effects = [];
  const outcome = await attemptDaemonCleanMerge({
    repo: 'subject-06', prNumber: 6, base: 'main', validatedHead: HEAD,
    verdict: 'settled-success', reviewState: clean, liveGate: gate(), branchProtectionRequired: false,
    flags: { autonomousMergeExecutionEnabled: true }, prTitle: 'Synthetic repair', prBody: 'Synthetic evidence',
    hqRoot: 'unused', logger: quiet, sleep: async () => {},
    getNextAction: () => shared.decision,
    fetchLiveGateImpl: async () => {
      reads++;
      const current = reads > 1 && confirmed ? gate({ prState: 'MERGED', merged: true }) : live;
      shared = observeDaemonGate(shared, current);
      afterFetch?.(() => shared, value => { shared = value; });
      return current;
    },
    acquireLeaseImpl: () => { effects.push('acquire'); return { acquired: lease, lease: { leaseId: 'lease-06' } }; },
    releaseLeaseImpl: () => effects.push('release'),
    runMergeImpl: async target => { effects.push('merge'); assert.equal(target.head, HEAD); return result; },
    readAuditImpl: () => null, writeAuditImpl: () => effects.push('audit-intent'),
    appendAuditImpl: () => effects.push('audit-result'), writeMergeActionImpl: () => effects.push('receipt'), ...overrides,
  });
  return { outcome, shared: observeDaemonResult(shared, outcome), effects };
}

test('CLOSERREFRESHLOOP-01: recovered same-head decline reaches the leased executor with fresh checks', async () => {
  const pending = observeDaemonGate(pair(), gate({ requiredChecks: [{ name: 'unit', status: 'IN_PROGRESS' }] }));
  const declined = observeDaemonResult(pending, { reason: 'pending-required-checks' });
  const initial = observeDaemonGate(declined, gate());
  assert.equal(initial.decision.action, 'daemon-merge');
  const { shared, effects } = await execute(initial, { confirmed: true });
  assert.equal(shared.decision.action, 'done');
  assert.equal(effects.filter(effect => effect === 'acquire').length, 1);
  assert.equal(effects.filter(effect => effect === 'merge').length, 1);
  const red = await execute(initial, { live: gate({ requiredChecks: [
    { name: 'unit', status: 'COMPLETED', conclusion: 'FAILURE' },
  ] }) });
  assert.ok(!red.effects.includes('merge'));
  assert.equal(red.shared.decision.actor, 'hammer');
});

test('exit zero retains receipt reconciliation until remote exact-head confirmation', async () => {
  for (const confirmed of [false, true]) {
    const { outcome, shared, effects } = await execute(pair(), { confirmed });
    assert.equal(outcome.remoteMergedConfirmed, confirmed);
    assert.equal(shared.decision.action, confirmed ? 'done' : 'daemon-merge');
    assert.equal(shared.decision.actor, confirmed ? 'none' : 'closure-recovery');
    assert.equal(effects.filter(x => x === 'receipt').length, confirmed ? 1 : 0);
    assert.equal(effects.filter(x => x === 'merge').length, 1);
    assert.equal(effects.at(-1), confirmed ? 'receipt' : 'release');
  }
});

test('merge command success followed by a read error cannot confirm terminal state', async () => {
  let reads = 0;
  const { outcome, shared, effects } = await execute(pair(), { overrides: {
    fetchLiveGateImpl: async () => { if (++reads > 1) throw new Error('synthetic read error'); return gate(); },
  } });
  assert.equal(outcome.remoteMergedConfirmed, false);
  assert.equal(shared.decision.actor, 'closure-recovery');
  assert.ok(!effects.includes('receipt'));
});

for (const [name, live] of [
  ['head move', gate({ candidateHead: OTHER })],
  ['failed CI', gate({ requiredChecks: [{ name: 'unit', status: 'COMPLETED', conclusion: 'FAILURE' }] })],
  ['missing CI', gate({ requiredChecks: [] })],
  ['conflict', gate({ mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' })],
]) test(`in-lease ${name} invalidates the decision without merging`, async () => {
  const { outcome, shared, effects } = await execute(pair(), { live });
  assert.equal(outcome.merged, false);
  assert.ok(!effects.includes('merge'));
  assert.equal(effects.filter(effect => effect === 'release').length, 1);
  assert.notEqual(shared.decision.actor, 'daemon');
  owned(shared);
});

test('changed non-PR ownership evidence invalidates the generation under the merge lease', async () => {
  const { shared, effects } = await execute(pair(), { afterFetch: (read, update) => update(reviseClosureNextAction(read(), {
    launches: { closer: { headSha: HEAD, row: { status: 'running' } } },
  })) });
  assert.ok(!effects.includes('merge'));
  assert.equal(effects.at(-1), 'release');
  assert.equal(shared.decision.reason, 'live-owner');
});

test('operator approval cannot shadow same-head daemon retry exhaustion or earlier safety owners', () => {
  const approved = pair({
    pr: { state: 'OPEN', headSha: HEAD, mergeable: 'MERGEABLE', labels: ['operator-approved'] },
    reviews: { ...clean, operatorApprovedEvidence: { applied: true, actor: 'operator',
      observedRevisionRef: HEAD, eventId: 'approval-1', observedAt: AT } },
    policy: { autonomousMergeExecutionEnabled: true, strictMode: true,
      operatorLogins: ['operator'], operatorLabelActorEnforcement: 'enforce' },
  });
  assert.equal(approved.decision.row, 'R13-approved-head');
  const exhausted = observeDaemonResult(approved, {
    disposition: 'failed-closed', reason: 'merge-retry-budget-exhausted', attempts: 2,
  });
  assert.equal(exhausted.decision.row, 'R08-retry');
  assert.equal(exhausted.decision.action, 'hammer');
  assert.equal(exhausted.decision.actor, 'hammer');
  assert.equal(exhausted.decision.reason, 'retry-no-merge');
  assert.equal(exhausted.decision.queue.intent, 'dispatch');
  const stale = reviseClosureNextAction(approved, { progress: {
    daemonExecution: { headSha: OLD, reason: 'merge-retry-budget-exhausted' },
  } });
  assert.equal(stale.decision.row, 'R13-approved-head');
  for (const [observations, row] of [
    [{ controls: { safetyRefusal: { deterministic: true, reason: 'synthetic-refusal' } } }, 'R05-structural'],
    [{ policy: { ...approved.snapshot.observations.policy.value, hammerCap: { lifetimeExhausted: true } } }, 'R07-stop'],
    [{ launches: { closer: { headSha: HEAD, row: { status: 'running' } } } }, 'R03-live-owner'],
    [{ pr: { ...approved.snapshot.observations.pr.value, labels: ['operator-approved', 'no-merge-hold'] } }, 'R02-hold'],
  ]) {
    assert.equal(reviseClosureNextAction(exhausted, observations).decision.row, row);
  }
});

test('daemon intent cannot steal a contended shared merge lease', async () => {
  const { shared, effects } = await execute(pair(), { lease: false });
  assert.ok(!effects.includes('merge'));
  assert.ok(!effects.includes('release'));
  assert.equal(shared.decision.actor, 'watcher');
  assert.equal(shared.decision.reason, 'snapshot-refresh');
});

test('production adapter passes the same frozen decision and returns its live replacement', async t => {
  const rootDir = mkdtempSync(join(tmpdir(), 'nxa-daemon-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const first = pair(), passSnapshot = first.snapshot;
  const result = await runDaemonCleanMergeAttempt({
    rootDir, repoPath: 'fixture/subject-06', prNumber: 6, cfg: { autonomousMergeExecutionEnabled: true, strictMode: true },
    candidate: { headSha: HEAD, baseBranch: 'main', prState: 'OPEN' }, currentPrHeadSha: HEAD,
    gateSnapshot: { reviewedHeadSha: HEAD, settledReview: { verdict: 'approved' } }, reviewState: clean,
    sharedNextAction: first, passSnapshot, env: { HQ_ROOT: rootDir }, logger: quiet,
    onGateSnapshot: () => { throw new Error('synthetic diagnostic sink outage'); },
    fetchRollupImpl: async () => ({ state: 'OPEN', headRefOid: OTHER, checks: green, mergeable: 'MERGEABLE', labels: [] }),
    readBuildCompletionSignalForPrImpl: () => { throw new Error('identity read must follow exact-head refresh'); },
    attemptDaemonCleanMergeImpl: () => { throw new Error('moved head cannot reach merge'); },
  });
  assert.equal(result.reason, 'pr-head-moved');
  assert.equal(result.nextActionShared.decision.action, 'review');
  assert.equal(result.nextActionShared.decision.head, OTHER);
  assert.equal(first.decision.head, HEAD);
  assert.equal(await resolveSharedNextAction({ passSnapshot }), result.nextActionShared);
});


test('raw PR head aliases and withdrawn terminal evidence cannot carry the previous generation', () => {
  const raw = pair({ pr: { state: 'OPEN', headSha: HEAD, headRefOid: HEAD, mergeable: 'MERGEABLE' } });
  assert.equal(observeDaemonGate(raw, gate({ candidateHead: OTHER })).decision.head, OTHER);
  const terminal = pair({ reviews: { ...clean, headSha: OLD },
    progress: { terminalReview: { validated: true, headSha: HEAD, reviewedHeadSha: OLD } } });
  assert.equal(terminal.decision.actor, 'daemon');
  assert.equal(observeDaemonGate(terminal, gate({ terminalReviewValidated: false })).decision.actor, 'reviewer');
});

test('builder credential enforcement retains closure recovery without executing self-merge', async () => {
  const { outcome, shared, effects } = await execute(pair(), { overrides: {
    mergeCapabilityEnforcement: 'enforce', mergeCredentialClass: 'builder', mergeEnv: {},
  } });
  assert.equal(outcome.reason, 'builder-token-merge-refused');
  assert.equal(shared.decision.actor, 'closure-recovery');
  assert.ok(!effects.includes('merge'));
  assert.equal(effects.filter(effect => effect === 'release').length, 1);
});

test('required protection is still authoritative before acquiring the merge lease', async () => {
  const { outcome, shared, effects } = await execute(pair(), { overrides: {
    branchProtectionRequired: true, requiredGateContext: 'required-gate', branchProtectionRequiredContexts: [],
  } });
  assert.ok(outcome.reasons.includes('branch-protection-missing-gate'));
  assert.equal(shared.decision.actor, 'closure-recovery');
  assert.ok(!effects.includes('acquire'));
  assert.ok(!effects.includes('merge'));
});

test('an unproven terminal-head decline replaces certification with exact-head review ownership', () => {
  const first = pair({ reviews: { ...clean, headSha: OLD }, progress: {
    terminalReview: { validated: true, headSha: HEAD, reviewedHeadSha: OLD },
    closerAuthoredStale: { carryForward: true, currentHead: HEAD, reviewedHead: OLD },
  } });
  assert.equal(first.decision.actor, 'daemon');
  const observed = observeDaemonResult(first, { disposition: 'not-taken', reason: 'stale-head', exactHeadReview: true });
  assert.equal(observed.decision.actor, 'reviewer');
  assert.equal(observed.decision.reason, 'exact-head-review');
  assert.equal(observed.decision.head, HEAD);
  assert.equal(first.decision.actor, 'daemon');
});


test('cancelled-check and no-CI recovery evidence select the shared CI observer', () => {
  const checks = [{ name: 'unit', status: 'COMPLETED', conclusion: 'CANCELLED' }];
  const first = observeDaemonGate(pair(), gate({ requiredChecks: checks, ciRecoveryPending: true }));
  assert.equal(first.decision.action, 'wait-for-CI');
  assert.equal(first.decision.actor, 'ci');
  const declined = observeDaemonResult(pair(), { disposition: 'failed-closed', reason: 'gate-not-eligible',
    reasons: ['ci-not-green'], ciMergePathPending: true });
  assert.equal(declined.decision.actor, 'ci');
  assert.equal(observeDaemonGate(first, gate({ requiredChecks: true, ciRecoveryPending: true })).decision.actor, 'daemon');
});


for (const confirmed of [false, true]) test(`coexistence terminalization requires remote confirmation=${confirmed}`, async () => {
  const shared = observeDaemonResult(pair(), { merged: true, remoteMergedConfirmed: confirmed });
  const result = await resolveMergeAgentCoexistenceForWatcher({
    repoPath: 'fixture/subject-06', prNumber: 6, candidate: { headSha: HEAD, prState: 'OPEN' }, logger: quiet,
    maybeDispatchAmaClosureForImpl: async () => ({ amaEnabled: true, dispatched: false, skipMergeAgent: true,
      reason: 'daemon-merged', nextAction: shared.decision, daemonCleanMerge: { remoteMergedConfirmed: confirmed } }),
    recoverOrphanImpl: () => assert.fail('receipt reconciliation cannot launch ownerless recovery'),
  });
  assert.equal(result.outcome, confirmed ? 'pr-terminal' : 'ama-pending');
});
