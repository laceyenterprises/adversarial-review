// DAEMONSUPERSEDE-01: an owner that has done nothing yet does not outrank a
// completed clean verdict. A zero-finding exact-head review on a green,
// mergeable head supersedes a closer launch that has not booted (still
// `requested`/`admitted`): the launch is cancelled through `hq dispatch cancel`
// with a typed reason and the daemon merges. A booted closer is never
// superseded. Synthetic fixtures only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CLOSER_SUPERSEDE_REASON, closerSupersedeOf, nextAction } from '../src/pr-next-action.mjs';
import { closureOwnerShadowEvidence, launchSource } from '../src/pr-next-action-consumer.mjs';
import { closerBootState, supersedeNotBootedCloser } from '../src/ama/closer-supersede.mjs';
import { mergeLeaseAdmissionReason } from '../src/ama/merge-lease-admission.mjs';
import { maybeDispatchAmaClosureFor } from '../src/ama-closure-orchestration.mjs';
import { acquireAmaCloserLease, readAmaCloserLease, updateAmaCloserLease } from '../src/ama/closer-lease.mjs';
import { readAmaCloserDispatchRecord, updateAmaCloserDispatchRecord } from '../src/ama/dispatch-closer.mjs';
import { dispatchReadTransport } from '../src/dispatch-read-client.mjs';
import { resolveGateStatusContext } from '../src/adversarial-gate-context.mjs';

const HEAD = 'a'.repeat(40);
const OLD = 'b'.repeat(40);
const LRQ = 'lrq_fixture_closer';
const OBSERVED = '2026-01-01T00:01:00.000Z';
const QUIET = { log() {}, info() {}, warn() {}, error() {} };

const complete = value => ({ state: 'complete', value, provenance: { sourceRef: 'synthetic' } });

function snap({ pr = {}, checks = {}, reviews = {}, launch = { status: 'admitted' }, closer = {}, lease = {}, policy = {},
  progress = {}, retryChain = [] } = {}) {
  const values = {
    pr: { headSha: HEAD, state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', labels: [], ...pr },
    checks: { conclusion: 'SUCCESS', ...checks },
    reviews: { verdict: 'comment-only', headSha: HEAD, blockingFindingState: 'known', blockingFindingCount: 0,
      nonBlockingFindingState: 'known', nonBlockingFindingCount: 0, attestation: 'valid', ...reviews },
    remediation: { roundsLeft: false, completedRounds: 1 },
    launches: { closer: launch ? { headSha: HEAD, launchRequestId: LRQ, ...closer,
      probe: { ok: true, row: { launch_request_id: LRQ, ...launch }, retryChain } } : null },
    leases: { closer: { headSha: HEAD, status: 'dispatched', lrqId: LRQ, updatedAt: OBSERVED, ...lease } },
    controls: {},
    policy: { strictMode: true, autonomousMergeExecutionEnabled: true, ...policy },
    progress: { ...progress },
  };
  return { subjectKey: 'subject-1', head: HEAD, passId: 'pass-1', generation: 1, observedAt: OBSERVED,
    anchors: { firstActionableAt: OBSERVED },
    observations: Object.fromEntries(Object.entries(values).map(([name, value]) => [name, complete(value)])) };
}

const pick = decision => [decision.row, decision.action, decision.actor, decision.reason];

test('a clean exact-head review supersedes a requested or admitted closer: the daemon owns the merge', () => {
  for (const status of ['requested', 'admitted']) {
    const decision = nextAction(snap({ launch: { status } }));
    assert.deepEqual(pick(decision), ['R15-daemon', 'daemon-merge', 'daemon', 'clean-exact-head'], status);
    assert.equal(decision.queue.intent, 'daemon');
    assert.ok(decision.evidenceRefs.includes(`supersede-not-booted-closer:${LRQ}`));
    assert.deepEqual(closerSupersedeOf(decision), { launchRequestId: LRQ, pending: true });
  }
});

test('a booted or parked closer is never superseded and keeps the merge', () => {
  for (const status of ['leased', 'starting', 'running', 'suspended', 'blocked_needs_decision']) {
    const decision = nextAction(snap({ launch: { status } }));
    assert.deepEqual(pick(decision), ['R03-live-owner', 'hammer', 'hammer', 'live-owner'], status);
    assert.equal(decision.queue.intent, 'owned');
    assert.equal(closerSupersedeOf(decision), null);
  }
  // A live retry descendant supplies the boot state of the chain.
  const retried = nextAction(snap({ launch: { status: 'failed' },
    retryChain: [{ launch_request_id: 'lrq_fixture_retry', status: 'running' }] }));
  assert.equal(retried.row, 'R03-live-owner');
  assert.equal(closerSupersedeOf(retried), null);
});

test('a deferred closer resuming through requested or admitted retains custody for its own launch', () => {
  for (const status of ['requested', 'admitted']) {
    const lease = { status: 'terminal', terminalOutcome: 'deferred' };
    const resumed = nextAction(snap({ launch: { status }, lease }));
    assert.equal(resumed.row, 'R03-live-owner', status);
    assert.equal(closerSupersedeOf(resumed), null);
    const unrelated = nextAction(snap({ launch: { status }, lease: { ...lease, lrqId: 'lrq_predecessor' } }));
    assert.equal(unrelated.row, 'R15-daemon', 'an unrelated lease does not invent boot history');
    const snapshot = snap({ lease });
    snapshot.observations.launches = launchSource(complete({
      launchRequestId: LRQ, liveRetryLaunchRequestId: 'lrq_resumed_retry',
      launch: { status: 'failed' }, retryChain: [{ launch_request_id: 'lrq_resumed_retry', status }],
    }), { headSha: HEAD }, {});
    assert.equal(nextAction(snapshot).row, 'R03-live-owner', 'retry projection retains root custody');
  }
});

test('any finding, a head mismatch or an unready gate leaves the not-booted closer in charge', () => {
  for (const [name, overrides] of [
    ['one non-blocking finding', { reviews: { nonBlockingFindingCount: 1 } }],
    ['demoted finding outside strict mode', { reviews: { nonBlockingFindingCount: 1 }, policy: { strictMode: false } }],
    ['one blocking finding', { reviews: { verdict: 'request-changes', blockingFindingCount: 1 } }],
    ['unknown finding state', { reviews: { nonBlockingFindingState: 'unknown' } }],
    ['review of an older head', { reviews: { headSha: OLD } }],
    ['pending checks', { checks: { conclusion: 'PENDING' } }],
    ['red checks', { checks: { conclusion: 'FAILURE' } }],
    ['conflicting PR', { pr: { mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' } }],
    ['unknown attestation', { reviews: { attestation: 'unknown' } }],
  ]) {
    const decision = nextAction(snap(overrides));
    assert.deepEqual(pick(decision), ['R03-live-owner', 'hammer', 'hammer', 'live-owner'], name);
    assert.equal(closerSupersedeOf(decision), null, name);
  }
  const held = nextAction(snap({ pr: { labels: ['do-not-merge'] } }));
  assert.equal(held.row, 'R02-hold');
  assert.equal(closerSupersedeOf(held), null);
});

test('after the supersede cancel, the recorded marker keeps the daemon from re-dispatching a fresh hammer', () => {
  const cancelled = { launch: { status: 'canceled', terminal_at: '2026-01-01T00:00:59.000Z' },
    closer: { outcome: 'no-merge', retryable: true }, reviews: { postedAt: '2026-01-01T00:00:30.000Z' } };
  const withoutMarker = nextAction(snap(cancelled));
  assert.equal(withoutMarker.actor, 'hammer', 'an ordinary cancelled launch stays a hammer retry');
  const marked = nextAction(snap({ ...cancelled,
    progress: { closerSuperseded: { launchRequestId: LRQ, headSha: HEAD } } }));
  assert.deepEqual(pick(marked), ['R15-daemon', 'daemon-merge', 'daemon', 'clean-exact-head']);
  assert.deepEqual(closerSupersedeOf(marked), { launchRequestId: LRQ, pending: false });
  for (const progress of [{ closerSuperseded: { launchRequestId: LRQ, headSha: OLD } },
    { closerSuperseded: { launchRequestId: 'lrq_other', headSha: HEAD } }]) {
    assert.equal(nextAction(snap({ ...cancelled, progress })).actor, 'hammer');
  }
  // The marker is projected from the closer dispatch record for this head only.
  const evidence = record => closureOwnerShadowEvidence({ currentHead: HEAD, launchRecord: record });
  const marker = { launchRequestId: LRQ, headSha: HEAD, reason: CLOSER_SUPERSEDE_REASON };
  assert.deepEqual(evidence({ supersededByReview: marker }).observations.progress.closerSuperseded,
    { launchRequestId: LRQ, headSha: HEAD });
  assert.equal(evidence({ supersededByReview: { ...marker, headSha: OLD } }).observations.progress.closerSuperseded,
    undefined);
});

test('a booted closer that loses the race finds the merged PR at lease admission and closes out', () => {
  assert.equal(mergeLeaseAdmissionReason({ state: 'MERGED', headRefOid: HEAD }, HEAD), 'pr-merged');
  assert.equal(mergeLeaseAdmissionReason({ state: 'CLOSED', headRefOid: HEAD }, HEAD), 'pr-not-open');
});

function launchObservation(status) {
  const terminal = ['canceled', 'failed', 'succeeded'].includes(status);
  return { state: 'complete', value: { launchRequestId: LRQ, launch: { status }, effectiveLaunch: { status },
    retryChain: [], retryChainUnreadable: false, worker: null, terminal, inFlight: !terminal } };
}

test('closerBootState reads only complete, readable evidence', () => {
  assert.equal(closerBootState(launchObservation('admitted')), 'not-booted');
  assert.equal(closerBootState(launchObservation('requested')), 'not-booted');
  assert.equal(closerBootState(launchObservation('leased')), 'booted');
  assert.equal(closerBootState(launchObservation('canceled')), 'ended');
  assert.equal(closerBootState({ state: 'unknown', value: null }), 'unknown');
  const unreadable = launchObservation('admitted');
  unreadable.value.retryChainUnreadable = true;
  assert.equal(closerBootState(unreadable), 'unknown');
});

function executorArgs(statuses, calls) {
  let index = 0;
  return {
    rootDir: '/nonexistent-fixture-root', repo: 'fixture/project', prNumber: 7, headSha: HEAD,
    reviewedHeadSha: HEAD, launchRequestId: LRQ, hqRoot: '/nonexistent-fixture-hq', hqPath: 'hq',
    readLaunchImpl: async () => launchObservation(statuses[Math.min(index++, statuses.length - 1)]),
    execFileImpl: async (bin, argv) => { calls.cancel.push(argv); return { stdout: '{"ok":true}' }; },
    updateDispatchRecordImpl: (rootDir, identity, mutate) => {
      const record = mutate({ state: 'dispatched', launchRequestId: LRQ });
      calls.record.push(record);
      return record;
    },
    readLeaseImpl: () => ({ headSha: HEAD, status: 'dispatched', lrqId: LRQ }),
    updateLeaseImpl: lease => { calls.lease.push(lease); },
    retryDelaysMs: [], logger: QUIET, now: () => OBSERVED,
  };
}

test('the executor cancels a not-booted closer with the typed reason and confirms it ended', async () => {
  const calls = { cancel: [], record: [], lease: [] };
  const result = await supersedeNotBootedCloser(executorArgs(['admitted', 'admitted', 'canceled'], calls));
  assert.equal(result.superseded, true);
  assert.deepEqual(calls.cancel, [['dispatch', 'cancel', LRQ, '--reason', 'superseded-by-clean-exact-head-review']]);
  assert.equal(calls.record[0].supersededByReview.launchRequestId, LRQ);
  assert.equal(calls.record[0].supersededByReview.headSha, HEAD);
  assert.equal(calls.record[0].supersededByReview.observedStatus, null, 'intent precedes cancellation');
  assert.equal(calls.record[1].supersededByReview.observedStatus, 'canceled');
  assert.equal(calls.lease[0].terminalOutcome, 'superseded');
});

test('the executor never cancels a closer that booted, and refuses an unconfirmed cancel', async () => {
  const booted = { cancel: [], record: [], lease: [] };
  assert.equal((await supersedeNotBootedCloser(executorArgs(['running'], booted))).reason, 'closer-booted');
  assert.deepEqual(booted.cancel, []);
  const raced = { cancel: [], record: [], lease: [] };
  const result = await supersedeNotBootedCloser(executorArgs(['admitted', 'admitted', 'starting'], raced));
  assert.equal(result.superseded, false);
  assert.equal(result.reason, 'closer-cancel-unconfirmed');
  assert.equal(raced.record.length, 1, 'only the intent is written before a boot race');
  assert.equal(raced.record[0].supersededByReview.observedStatus, null);
  assert.deepEqual(raced.lease, []);
  const beforeCancel = { cancel: [], record: [], lease: [] };
  const bootRace = await supersedeNotBootedCloser(executorArgs(['admitted', 'starting'], beforeCancel));
  assert.equal(bootRace.reason, 'closer-booted');
  assert.deepEqual(beforeCancel.cancel, [], 'recheck boot state after persisting the intent');
  assert.deepEqual(beforeCancel.lease, []);
  assert.equal(nextAction(snap({ launch: { status: 'starting' },
    progress: { closerSuperseded: raced.record[0].supersededByReview } })).row, 'R03-live-owner',
  'an intent never sets aside a booted closer');
  const mismatch = { cancel: [], record: [], lease: [] };
  assert.equal((await supersedeNotBootedCloser({ ...executorArgs(['admitted'], mismatch), reviewedHeadSha: OLD })).reason,
    'supersede-identity-mismatch');
  assert.deepEqual(mismatch.cancel, []);
});

test('mixed-case review SHAs are consistently refused by policy and executor', async () => {
  const decision = nextAction(snap({ reviews: { headSha: HEAD.toUpperCase() } }));
  assert.equal(decision.row, 'R03-live-owner');
  assert.equal(closerSupersedeOf(decision), null);
  const calls = { cancel: [], record: [], lease: [] };
  const result = await supersedeNotBootedCloser({
    ...executorArgs(['admitted'], calls), reviewedHeadSha: HEAD.toUpperCase(),
  });
  assert.equal(result.reason, 'supersede-identity-mismatch');
  assert.deepEqual(calls, { cancel: [], record: [], lease: [] });
});

test('marker persistence failure or a missing/replaced record refuses cancellation and lease settlement', async () => {
  for (const mode of ['write-error', 'missing-record', 'replaced-record']) {
    const calls = { cancel: [], record: [], lease: [] };
    const result = await supersedeNotBootedCloser({
      ...executorArgs(['admitted'], calls),
      updateDispatchRecordImpl: (rootDir, identity, mutate) => {
        if (mode === 'write-error') throw new Error('synthetic I/O failure');
        const record = mode === 'missing-record' ? null : { launchRequestId: 'lrq_successor' };
        return mutate(record) || record;
      },
    });
    assert.equal(result.superseded, false, mode);
    assert.equal(result.reason, mode === 'write-error' ? 'supersede-marker-write-failed' : 'supersede-record-mismatch');
    assert.deepEqual(calls, { cancel: [], record: [], lease: [] }, mode);
  }
});

// ── End to end through the closure orchestration ────────────────────────────
const REPO = 'fixture/project';
const PR = 4343;
const CLEAN_BODY = ['## Summary', 'Docs only.', '', '## Blocking issues', '- None.', '',
  '## Non-blocking issues', '- None.', '', '## Verdict', 'Comment only'].join('\n');
const FINDING_BODY = ['## Summary', 'Docs only.', '', '## Blocking issues', '- None.', '',
  '## Non-blocking issues', '- **Ambiguous timestamp**', '  - **Problem:** unclear zone.', '',
  '## Verdict', 'Comment only'].join('\n');

function scratch(t) {
  const rootDir = mkdtempSync(join(tmpdir(), 'daemonsupersede-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  return rootDir;
}

function seedCloser(rootDir) {
  const identity = { rootDir, repo: REPO, prNumber: PR, headSha: HEAD };
  assert.equal(acquireAmaCloserLease({ ...identity, watcherPid: process.pid, now: OBSERVED }).acquired, true);
  updateAmaCloserLease({ ...identity, status: 'dispatched', lrqId: LRQ, now: OBSERVED });
  updateAmaCloserDispatchRecord(rootDir, { repo: REPO, prNumber: PR, headSha: HEAD }, () => ({
    repo: REPO, prNumber: PR, headSha: HEAD, state: 'dispatched', launchRequestId: LRQ, dispatchedAt: OBSERVED }));
  return identity;
}

function mockLedger(t, state) {
  t.mock.method(dispatchReadTransport, 'lookup', async selector => {
    if (selector.observation === 'workers') {
      return { schema_version: 1, observation: 'workers', status: 'not_found', items: [], complete: true,
        next_offset: null, scope_complete: false, mutation_authority: false };
    }
    return { schema_version: 1, status: 'found', complete: true, roots: [LRQ],
      items: [{ launch_request_id: LRQ, ticket_id: `AMA-PR-${PR}`, repo: REPO, status: state.status,
        requested_at: OBSERVED }], retry_edges: [] };
  });
}

function closureArgs(rootDir, { body = CLEAN_BODY, calls, state, headSha = HEAD } = {}) {
  return {
    rootDir,
    reviewStateRow: { repo: REPO, pr_number: PR, pr_state: 'open', review_status: 'posted',
      last_verdict: 'Comment only', risk_class: 'low', remediation_pending: 0, reviewer: 'codex',
      reviewer_head_sha: HEAD, review_body: body, posted_at: OBSERVED },
    dispatchJob: {},
    candidate: { headSha, riskClass: 'low', prAuthor: 'claude-code-worker', prState: 'open',
      mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', isDraft: false,
      statusCheckRollup: [{ __typename: 'CheckRun', name: 'repo-guards', status: 'COMPLETED', conclusion: 'SUCCESS' }],
      branchProtection: { requiredContexts: [resolveGateStatusContext(process.env)] } },
    labelNames: [], operatorApprovalEvent: null, adversarialMergeRequestedEvent: null,
    repoPath: REPO, prNumber: PR, currentRevisionRef: headSha, logger: QUIET,
    loadConfigImpl: () => ({ getMergeAuthorityConfig: () => ({ enabled: true }) }),
    resolveAmaHammerDispatchModeImpl: () => 'inline',
    fetchLatestHeadReviewBodiesImpl: async () => [body],
    resolveHeadCloserCommitSuppressionImpl: async () => ({ suppressed: false, reason: 'not-closer-commit' }),
    fetchMergedProtectiveDependentsImpl: async () => [],
    requestEligibleHammerWakeImpl: () => ({ requested: false }),
    probeClosureOwnershipImpl: async () => ({ owned: true, uncertain: false, launchIds: [LRQ] }),
    maybeDispatchAmaCloserImpl: async () => { calls.hammer.push('dispatch'); return { dispatched: false, reason: 'fixture' }; },
    supersedeNotBootedCloserImpl: args => supersedeNotBootedCloser({ ...args, hqPath: 'hq', retryDelaysMs: [],
      execFileImpl: async (bin, argv) => { calls.cancel.push(argv); state.status = 'canceled'; return { stdout: '{"ok":true}' }; } }),
    runDaemonCleanMergeAttemptImpl: async args => {
      calls.daemon.push(args.sharedNextAction?.decision);
      return { disposition: 'merged', reason: 'merged', remoteMergedConfirmed: true, mergedAt: OBSERVED };
    },
  };
}

test('end to end: an admitted hammer is cancelled with the typed reason and the daemon merges', async t => {
  const rootDir = scratch(t);
  const identity = seedCloser(rootDir);
  const state = { status: 'admitted' };
  mockLedger(t, state);
  const calls = { cancel: [], daemon: [], hammer: [] };
  const result = await maybeDispatchAmaClosureFor(closureArgs(rootDir, { calls, state }));
  assert.deepEqual(calls.cancel, [['dispatch', 'cancel', LRQ, '--reason', 'superseded-by-clean-exact-head-review']]);
  assert.equal(calls.daemon.length, 1, 'the daemon clean merge ran');
  assert.equal(calls.daemon[0].action, 'daemon-merge');
  assert.equal(result.reason, 'daemon-merged');
  assert.deepEqual(calls.hammer, []);
  assert.equal(readAmaCloserLease(rootDir, identity).status, 'terminal');
  assert.equal(readAmaCloserDispatchRecord(rootDir, identity).supersededByReview.launchRequestId, LRQ);
});

test('end to end: a running hammer is not superseded and the daemon does not merge', async t => {
  const rootDir = scratch(t);
  seedCloser(rootDir);
  const state = { status: 'running' };
  mockLedger(t, state);
  const calls = { cancel: [], daemon: [], hammer: [] };
  const result = await maybeDispatchAmaClosureFor(closureArgs(rootDir, { calls, state }));
  assert.equal(result.reason, `in-flight:${LRQ}`);
  assert.deepEqual(calls.cancel, []);
  assert.deepEqual(calls.daemon, []);
});

test('a failed post-cancel status write and deferred merge retain daemon ownership on the next pass', async t => {
  const rootDir = scratch(t);
  const identity = seedCloser(rootDir);
  const state = { status: 'admitted' };
  mockLedger(t, state);
  const calls = { cancel: [], daemon: [], hammer: [] };
  const args = closureArgs(rootDir, { calls, state });
  args.supersedeNotBootedCloserImpl = options => supersedeNotBootedCloser({
    ...options, hqPath: 'hq', retryDelaysMs: [],
    execFileImpl: async (bin, argv) => {
      assert.equal(readAmaCloserDispatchRecord(rootDir, identity).supersededByReview.launchRequestId, LRQ,
        'the intent is durable before HQ cancellation');
      calls.cancel.push(argv);
      state.status = 'canceled';
      return { stdout: '{"ok":true}' };
    },
    updateDispatchRecordImpl: (root, recordIdentity, mutate) => {
      if (state.status === 'canceled') throw new Error('synthetic I/O failure');
      return updateAmaCloserDispatchRecord(root, recordIdentity, mutate);
    },
  });
  args.runDaemonCleanMergeAttemptImpl = async options => {
    calls.daemon.push(options.sharedNextAction?.decision);
    return { disposition: 'deferred', reason: 'fixture-lease-busy' };
  };
  await maybeDispatchAmaClosureFor(args);
  assert.equal(calls.daemon.length, 1);
  assert.equal(readAmaCloserDispatchRecord(rootDir, identity).supersededByReview.observedStatus, null);
  const second = await maybeDispatchAmaClosureFor(closureArgs(rootDir, { calls, state }));
  assert.equal(second.reason, 'daemon-merged');
  assert.equal(calls.daemon.length, 2);
  assert.equal(calls.cancel.length, 1, 'a restart needs no repeat cancellation');
  assert.deepEqual(calls.hammer, []);
});

test('end to end: a review with a finding, or a moved head, never supersedes the admitted hammer', async t => {
  for (const [name, options] of [['finding', { body: FINDING_BODY }], ['head mismatch', { headSha: OLD }]]) {
    const rootDir = scratch(t);
    seedCloser(rootDir);
    const state = { status: 'admitted' };
    t.mock.restoreAll();
    mockLedger(t, state);
    const calls = { cancel: [], daemon: [], hammer: [] };
    await maybeDispatchAmaClosureFor(closureArgs(rootDir, { calls, state, ...options }));
    assert.deepEqual(calls.cancel, [], name);
    assert.equal(calls.daemon.filter(decision => closerSupersedeOf(decision)).length, 0, name);
    assert.equal(state.status, 'admitted', name);
  }
});
