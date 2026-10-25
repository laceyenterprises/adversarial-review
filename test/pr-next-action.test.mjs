import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { NEXT_ACTIONS, NEXT_ACTION_ACTORS, NEXT_ACTION_DEADLINE_MS, deriveNextActionSnapshot, nextAction } from '../src/pr-next-action.mjs';
import { fromLegacyClosureOwner, fromLegacyNoProgressLane, fromLegacyPostedReviewOutcome } from '../src/pr-next-action-consumer.mjs';
import { createMergeAgentSnapshotPass } from '../src/merge-agent-candidate-snapshot.mjs';

// Synthetic fixtures only: opaque subject keys, fabricated heads and evidence.
const HEAD = 'a'.repeat(40), OLD = 'b'.repeat(40), OTHER = 'c'.repeat(40);
const ANCHOR = '2026-01-01T00:00:00.000Z';
const OBSERVED = '2026-01-01T00:01:00.000Z';
const SOURCES = ['pr', 'candidate', 'checks', 'reviews', 'remediation', 'launches', 'leases', 'controls',
  'policy', 'progress', 'history'];

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}

const complete = value => ({ state: 'complete', value, provenance: { sourceRef: 'synthetic' } });

// A clean, green, mergeable PR whose exact head has an approved review: daemon.
function snap({ pr = {}, checks = {}, reviews = {}, remediation = {}, launches = {}, leases = {}, controls = {},
  policy = {}, progress = {}, states = {}, anchors = { firstActionableAt: ANCHOR }, observedAt = OBSERVED } = {}) {
  const values = {
    pr: { headSha: HEAD, state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', labels: [], ...pr },
    checks: { conclusion: 'SUCCESS', ...checks },
    reviews: { verdict: 'approved', headSha: HEAD, blockingFindingState: 'known', blockingFindingCount: 0,
      nonBlockingFindingState: 'known', nonBlockingFindingCount: 0, ...reviews },
    remediation: { roundsLeft: true, completedRounds: 1, ...remediation },
    launches: { closer: null, ...launches },
    leases: { closer: null, ...leases },
    controls: { ...controls },
    policy: { strictMode: true, autonomousMergeExecutionEnabled: true, ...policy },
    progress: { ...progress },
  };
  const observations = {};
  for (const [name, value] of Object.entries(values)) {
    const state = states[name] || 'complete';
    if (state === 'missing') continue;
    observations[name] = state === 'complete' ? complete(value)
      : { state, value: null, provenance: { sourceRef: 'synthetic' } };
  }
  return deepFreeze({ subjectKey: 'subject-1', head: HEAD, requestedHead: HEAD, passId: 'pass-1', generation: 3,
    observedAt, anchors, observations });
}

const pick = decision => [decision.action, decision.actor, decision.reason];

const STOP = { deterministic: true, headSha: HEAD, recordedAt: ANCHOR, fingerprint: `${HEAD}:2:${ANCHOR}` };
const AFTER_STOP = '2026-01-01T00:00:30.000Z';
const stopped = {
  controls: { stop: STOP },
  reviews: { verdict: 'comment-only', nonBlockingFindingCount: 2, postedAt: AFTER_STOP },
  policy: { strictMode: false },
  remediation: { roundsLeft: false, job: { status: 'completed', headSha: HEAD } },
};

test('STOPSTALE-01: newer eligible exact-head evidence supersedes the stop only for daemon merge', () => {
  for (const retryable of [undefined, true, false]) {
    for (const hammerCap of [undefined, { lifetimeExhausted: true }, { headSha: HEAD, retryExhausted: true }]) {
      const decision = nextAction(snap({ ...stopped, policy: { ...stopped.policy, hammerCap },
        launches: { closer: { status: 'succeeded', headSha: HEAD, outcome: 'no-merge', retryable, attempt: 2 } } }));
      assert.deepEqual(pick(decision), ['daemon-merge', 'daemon', 'clean-exact-head']);
      assert.equal(decision.row, 'R15-daemon');
      assert.equal(decision.queue.intent, 'daemon');
      assert.ok(decision.evidenceRefs.includes('stop-superseded-by-exact-head-review'));
      assert.ok(decision.evidenceRefs.includes(`stop:${STOP.fingerprint}`));
    }
  }
});

for (const [name, changes] of [
  ['missing review timestamp', { reviews: { postedAt: undefined } }],
  ['older review', { reviews: { postedAt: '2025-12-31T23:59:00.000Z' } }],
  ['equal review timestamp', { reviews: { postedAt: ANCHOR } }],
  ['invalid review timestamp', { reviews: { postedAt: 'invalid' } }],
  ['missing stop timestamp', { controls: { stop: { ...STOP, recordedAt: null } } }],
  ['invalid stop timestamp', { controls: { stop: { ...STOP, recordedAt: 'invalid' } } }],
  ['blocking findings', { reviews: { blockingFindingCount: 1 } }],
  ['unknown finding classification', { reviews: { blockingFindingState: 'unknown' } }],
  ['unsettled verdict', { reviews: { verdict: 'request-changes' } }],
  ['different review head', { reviews: { headSha: OLD } }],
  ['different stop head', { controls: { stop: { ...STOP, headSha: OTHER } } }],
  ['strict findings policy', { policy: { strictMode: true } }],
  ['unreadable review', { states: { reviews: 'error' } }],
  ['invalid attestation', { reviews: { attestation: 'invalid' } }],
  ['unknown attestation', { reviews: { attestation: 'unknown' } }],
  ['red checks', { checks: { conclusion: 'FAILURE' } }],
  ['pending checks', { checks: { conclusion: 'PENDING' } }],
  ['conflicting head', { pr: { mergeable: 'CONFLICTING' } }],
  ['dirty head', { pr: { mergeStateStatus: 'DIRTY' } }],
  ['automated hold label', { pr: { labels: [{ name: 'do-not-merge', actorKind: 'bot' }] } }],
  ['daemon transport exhausted', { progress: { daemonExecution: { headSha: HEAD, reason: 'merge-retry-budget-exhausted' } } }],
]) test(`STOPSTALE-01: ${name} retains R07 and never relaunches a capped hammer`, () => {
  const options = { ...stopped, ...changes,
    reviews: { ...stopped.reviews, ...changes.reviews },
    policy: { ...stopped.policy, hammerCap: { lifetimeExhausted: true }, ...changes.policy },
    launches: { closer: { status: 'succeeded', headSha: HEAD, outcome: 'no-merge', retryable: false } } };
  const decision = nextAction(snap(options));
  assert.deepEqual(pick(decision), ['hammer', 'closure-recovery', 'automated-stop']);
  assert.equal(decision.row, 'R07-stop');
  assert.equal(decision.queue.intent, 'reconcile');
  assert.ok(!decision.evidenceRefs.includes('stop-superseded-by-exact-head-review'));
});

test('STOPSTALE-01: timestamp comparisons accept epoch milliseconds without mutating the snapshot', () => {
  const snapshot = snap({ ...stopped, controls: { stop: { ...STOP, recordedAt: Date.parse(ANCHOR) } },
    reviews: { ...stopped.reviews, postedAt: Date.parse(AFTER_STOP) } });
  const before = JSON.stringify(snapshot);
  const decision = nextAction(snapshot);
  assert.equal(decision.action, 'daemon-merge');
  assert.deepEqual(nextAction(snapshot), decision);
  assert.equal(JSON.stringify(snapshot), before);
});

test('STOPSTALE-01: newer reviews alone cannot bypass lifetime or final-no-merge hammer fences', () => {
  for (const conclusion of ['FAILURE', 'SUCCESS']) {
    const capped = nextAction(snap({ ...stopped, controls: {}, checks: { conclusion },
      policy: { ...stopped.policy, hammerCap: { lifetimeExhausted: true } } }));
    assert.equal(capped.reason, 'lifetime-exhausted');
    assert.equal(capped.queue.intent, 'reconcile');
    const final = nextAction(snap({ ...stopped, controls: {}, checks: { conclusion },
      launches: { closer: { status: 'succeeded', headSha: HEAD, outcome: 'no-merge', retryable: false } } }));
    assert.equal(final.reason, 'hammer-final-no-merge');
    assert.equal(final.queue.intent, 'reconcile');
  }
});

test('verified terminal HAM completion crosses the retry row only with matching heads and safety gates', () => {
  const options = {
    reviews: { headSha: OLD, verdict: 'request changes', blockingFindingCount: 1 },
    remediation: { roundsLeft: false },
    launches: { closer: { headSha: HEAD, status: 'succeeded', outcome: 'no-merge', retryable: true } },
    progress: { terminalReview: { validated: true, headSha: HEAD, reviewedHeadSha: OLD } },
  };
  assert.equal(nextAction(snap(options)).action, 'daemon-merge');
  for (const terminalReview of [null, { validated: false, headSha: HEAD, reviewedHeadSha: OLD },
    { validated: true, headSha: OTHER, reviewedHeadSha: OLD },
    { validated: true, headSha: HEAD, reviewedHeadSha: OTHER }]) {
    assert.equal(nextAction(snap({ ...options, progress: { terminalReview } })).reason, 'retry-no-merge');
  }
  assert.equal(nextAction(snap({ ...options, launches: { closer: { headSha: HEAD, status: 'running' } } })).reason, 'live-owner');
  assert.equal(nextAction(snap({ ...options, checks: { conclusion: 'PENDING' } })).action, 'wait-for-CI');
  assert.equal(nextAction(snap({ ...options, checks: { conclusion: 'FAILURE' } })).reason, 'ci-red-final');
  assert.equal(nextAction(snap({ ...options, policy: { hammerCap: { lifetimeExhausted: true } } })).reason, 'lifetime-exhausted');
  assert.equal(nextAction(snap({ ...options, leases: { closer: { headSha: HEAD, status: 'handed-to-review' } } })).reason, 'retry-no-merge');
});

test('the decision has exactly the shared contract fields, frozen and typed', () => {
  const decision = nextAction(snap());
  assert.ok(Object.isFrozen(decision));
  for (const key of ['action', 'actor', 'reason', 'deadline', 'head', 'evidenceRefs', 'decisionKey']) assert.ok(key in decision, key);
  assert.deepEqual(pick(decision), ['daemon-merge', 'daemon', 'clean-exact-head']);
  assert.equal(decision.head, HEAD);
  assert.equal(decision.generation, 3);
  assert.equal(decision.passId, 'pass-1');
  assert.match(decision.decisionKey, /^[0-9a-f]{32}$/);
  assert.ok(decision.evidenceRefs.includes('pr:complete:synthetic'));
  assert.ok(decision.evidenceRefs.includes('history:unknown'));
  assert.deepEqual(decision.queue, { intent: 'daemon', deferredBy: null });
});

// [name, snapshot options, [action, actor, reason], extra assertions]
const TABLE = [
  ['merged PR is done', { pr: { state: 'MERGED' } }, ['done', 'none', 'merged']],
  ['closed PR is done', { pr: { state: 'CLOSED' } }, ['done', 'none', 'closed']],
  ['operator hold label (no provenance) holds', { pr: { labels: ['no-merge-hold'] } }, ['operator-hold', 'operator', 'hold-label']],
  ['operator hold label applied by a human holds', { pr: { labels: [{ name: 'do-not-merge', actorKind: 'human' }] } },
    ['operator-hold', 'operator', 'hold-label']],
  ['hold provenance: an automation-applied hold label is an automatic stop with a recovery owner',
    { pr: { labels: [{ name: 'do-not-merge', actorKind: 'bot' }] } }, ['hammer', 'closure-recovery', 'automated-stop']],
  ['draft is explicit author intent', { pr: { isDraft: true } }, ['operator-hold', 'operator', 'draft']],
  ['disabled merge policy holds', { policy: { autonomousMergeExecutionEnabled: false } },
    ['operator-hold', 'operator', 'merge-execution-disabled']],
  ...['missing', 'unknown', 'error'].map(state => [`${state} policy cannot select new work`,
    { states: { policy: state } }, ['wait-for-CI', 'watcher', 'policy-unknown']]),
  ...[undefined, null, 'true'].map(value => [`non-boolean execution switch (${value}) cannot select new work`,
    { policy: { autonomousMergeExecutionEnabled: value } }, ['wait-for-CI', 'watcher', 'policy-unknown']]),
  ['unreadable policy preserves a live remediation owner',
    { states: { policy: 'error' }, remediation: { job: { status: 'in_progress', headSha: HEAD } } },
    ['remediate', 'remediator', 'live-owner']],
  ['unreadable policy cannot dispatch CI repair',
    { states: { policy: 'error' }, checks: { conclusion: 'FAILURE' } }, ['wait-for-CI', 'watcher', 'policy-unknown']],
  ['a running launch for this head is the live owner',
    { launches: { closer: { status: 'running', headSha: HEAD, launchRequestId: 'lrq-1' } } }, ['hammer', 'hammer', 'live-owner']],
  ['a parked launch retains ownership',
    { launches: { closer: { status: 'waiting_approval', headSha: HEAD } } }, ['hammer', 'hammer', 'live-owner']],
  ['an in-progress remediation job is the live owner', { remediation: { job: { status: 'in_progress', headSha: HEAD } } },
    ['remediate', 'remediator', 'live-owner']],
  ['a live reviewer is the owner', { reviews: { reviewerLive: true } }, ['review', 'reviewer', 'live-owner']],
  ['unreadable leases reconcile ownership without a launch', { states: { leases: 'error' } },
    ['hammer', 'closure-recovery', 'ownership-unreadable']],
  ['an in-flight lease with an unreadable launch ledger reconciles',
    { leases: { closer: { status: 'dispatched', lrqId: 'lrq-2', headSha: HEAD, updatedAt: ANCHOR } }, states: { launches: 'unknown' } },
    ['hammer', 'closure-recovery', 'ownership-unreadable']],
  ['unreadable retry descendants are unknown, never absence',
    { leases: { closer: { status: 'terminal', lrqId: 'lrq-3', headSha: HEAD } },
      launches: { closer: { status: 'failed', headSha: HEAD, retryChainUnreadable: true } } },
    ['hammer', 'closure-recovery', 'ownership-unreadable']],
  ['an in-flight lease within its window with no recorded launch is live',
    { leases: { closer: { status: 'dispatched', headSha: HEAD, updatedAt: ANCHOR } } }, ['hammer', 'hammer', 'live-owner']],
  ['an in-flight lease past its window is reconciled, not trusted',
    { leases: { closer: { status: 'dispatched', headSha: HEAD, updatedAt: '2025-12-31T00:00:00.000Z' } } },
    ['hammer', 'closure-recovery', 'lease-expired']],
  ['a foreign-head lease confers nothing',
    { leases: { closer: { status: 'dispatched', headSha: OTHER, updatedAt: ANCHOR } } }, ['daemon-merge', 'daemon', 'clean-exact-head']],
  ['existing empty-diff closure is owned by closure recovery, never done', { progress: { diffEmpty: true } },
    ['hammer', 'closure-recovery', 'empty-diff-close']],
  ['a reverted primary change goes to repair', { progress: { primaryChange: { ok: false, reason: 'primary-change-reverted' } } },
    ['hammer', 'hammer', 'primary-change-repair']],
  ['an unreadable primary change is evidence recovery', { progress: { primaryChange: { ok: false, reason: 'history-read-failed' } } },
    ['hammer', 'closure-recovery', 'primary-change-unreadable']],
  ['another structural restriction is refreshed', { progress: { primaryChange: { ok: false, reason: 'ci-cost-pending' } } },
    ['wait-for-CI', 'watcher', 'structural-restriction-pending']],
  ['hard safety stop plus conflict: the deterministic refusal precedes the conflict repair',
    { pr: { mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' }, controls: { safetyRefusal: { reason: 'synthetic-refusal', deterministic: true } } },
    ['hammer', 'closure-recovery', 'safety-refusal']],
  ['remote-open despite a merged receipt reconciles the receipt',
    { progress: { mergeReceipt: { merged: true, path: 'daemon-merge', headSha: HEAD } } },
    ['daemon-merge', 'closure-recovery', 'merge-receipt-unconfirmed']],
  ['a merged receipt and a confirmed merged PR are done',
    { pr: { state: 'MERGED' }, progress: { mergeReceipt: { merged: true, path: 'hammer', headSha: HEAD } } }, ['done', 'none', 'merged']],
  ['a deterministic automatic stop keeps a recovery owner', { controls: { stop: { fingerprint: 'fp-1', deterministic: true } } },
    ['hammer', 'closure-recovery', 'automated-stop']],
  ['an exhausted retry cap on this head keeps a recovery owner', { policy: { hammerCap: { headSha: HEAD, retryExhausted: true } } },
    ['hammer', 'closure-recovery', 'retry-exhausted']],
  ['a retry cap exhausted on another head does not stop this head', { policy: { hammerCap: { headSha: OLD, retryExhausted: true } } },
    ['daemon-merge', 'daemon', 'clean-exact-head']],
  ['an exhausted lifetime cap keeps a recovery owner', { policy: { hammerCap: { lifetimeExhausted: true } } },
    ['hammer', 'closure-recovery', 'lifetime-exhausted']],
  ['terminal exit-zero no-merge with retry remaining retries the hammer',
    { leases: { closer: { status: 'dispatched', lrqId: 'lrq-4', headSha: HEAD, updatedAt: ANCHOR } },
      launches: { closer: { status: 'succeeded', headSha: HEAD, outcome: 'no-merge', retryable: true, attempt: 1 } } },
    ['hammer', 'hammer', 'retry-no-merge'], decision => assert.equal(decision.attempt, 2)],
  ['the hammer final no-merge adjudication is terminal for this head',
    { launches: { closer: { status: 'succeeded', headSha: HEAD, outcome: 'no-merge', retryable: false } } },
    ['hammer', 'closure-recovery', 'hammer-final-no-merge']],
  ['clean red CI with a round left goes to the hammer', { checks: { conclusion: 'FAILURE' } },
    ['hammer', 'hammer', 'ci-red-clean-verdict']],
  ['posted non-blocking findings can await job creation on red CI', { checks: { conclusion: 'FAILURE' },
    reviews: { verdict: 'comment-only', nonBlockingFindingCount: 1, postedAt: ANCHOR } },
    ['remediate', 'remediator', 'ci-red']],
  ['findings without a posting receipt cannot promise job creation', { checks: { conclusion: 'FAILURE' },
    reviews: { verdict: 'request-changes', blockingFindingCount: 1 } }, ['hammer', 'hammer', 'ci-red-clean-verdict']],
  ['posted findings await creation of a current-head job', { checks: { conclusion: 'FAILURE' },
    reviews: { verdict: 'request-changes', blockingFindingCount: 1, postedAt: ANCHOR } },
    ['remediate', 'remediator', 'ci-red'], decision => assert.equal(decision.round, 2)],
  ['red CI with a pending current-head job goes to remediation', { checks: { conclusion: 'FAILURE' },
    reviews: { verdict: 'request-changes', blockingFindingCount: 1 },
    remediation: { job: { status: 'pending', headSha: HEAD } } }, ['remediate', 'remediator', 'ci-red']],
  ['red CI with a running current-head job retains its owner', { checks: { conclusion: 'FAILURE' },
    reviews: { verdict: 'request-changes', blockingFindingCount: 1 },
    remediation: { job: { status: 'in_progress', headSha: HEAD } } }, ['remediate', 'remediator', 'live-owner']],
  ...['completed', 'failed', 'stopped'].map(status => [`terminal ${status} job cannot own red CI`,
    { checks: { conclusion: 'FAILURE' }, reviews: { verdict: 'request-changes', blockingFindingCount: 1, postedAt: ANCHOR },
      remediation: { job: { status, headSha: HEAD } } }, ['hammer', 'hammer', 'ci-red-clean-verdict']]),
  ...[ANCHOR, OBSERVED, null, 'invalid'].map(createdAt => [
    `same-head terminal job created at ${createdAt} does not promise a new worker`,
    { checks: { conclusion: 'FAILURE' },
      reviews: { verdict: 'request-changes', blockingFindingCount: 1, postedAt: ANCHOR },
      remediation: { job: { status: 'failed', headSha: HEAD, createdAt } } },
    ['hammer', 'hammer', 'ci-red-clean-verdict'],
  ]),
  ...[OLD, null].map(headSha => [`live PR job (${headSha}) retains red CI across a head move or retrigger`,
    { checks: { conclusion: 'FAILURE' }, remediation: { job: { status: 'in_progress', headSha } } },
    ['remediate', 'remediator', 'live-owner']]),
  ...['failed', 'stopped', 'completed'].flatMap(status => [true, false].map(expired => [
    `new same-head review after an older ${status} job ${expired ? 'expires' : 'awaits job creation'}`,
    { checks: { conclusion: 'FAILURE' },
      reviews: { verdict: 'request-changes', blockingFindingCount: 1, postedAt: ANCHOR },
      remediation: { job: { status, headSha: HEAD, createdAt: '2025-12-31T23:59:00.000Z' } },
      ...(expired ? { observedAt: '2026-01-01T00:05:00.000Z' } : {}) },
    expired ? ['hammer', 'hammer', 'ci-red-clean-verdict'] : ['remediate', 'remediator', 'ci-red'],
  ])),
  ...['completed', 'failed', 'stopped'].map(status => [
    `${status} job at the pushed head with a prior-head review preserves only completed closeout`,
    { checks: { conclusion: 'FAILURE' }, reviews: { headSha: OLD },
      remediation: { job: { status, headSha: HEAD } } },
    status === 'completed' ? ['remediate', 'remediator', 'ci-red'] : ['hammer', 'hammer', 'ci-red-clean-verdict'],
  ]),
  ['stale findings cannot promise a job for the current red head', { checks: { conclusion: 'FAILURE' },
    reviews: { verdict: 'request-changes', headSha: OLD, blockingFindingCount: 1, postedAt: ANCHOR } },
    ['hammer', 'hammer', 'ci-red-clean-verdict']],
  ['an expired missing-job admission goes to the hammer', { checks: { conclusion: 'FAILURE' },
    reviews: { verdict: 'request-changes', blockingFindingCount: 1, postedAt: ANCHOR },
    observedAt: '2026-01-01T00:05:00.000Z' }, ['hammer', 'hammer', 'ci-red-clean-verdict']],
  ['an overdue pending job still owns red CI', { checks: { conclusion: 'FAILURE' },
    remediation: { job: { status: 'pending', headSha: HEAD } }, observedAt: '2026-01-01T01:00:00.000Z' },
    ['remediate', 'remediator', 'ci-red']],
  ['exhausted red CI goes to the final hammer', { checks: { conclusion: 'FAILURE' }, remediation: { roundsLeft: false } },
    ['hammer', 'hammer', 'ci-red-final']],
  ['a non-success terminal check state is failed CI', { checks: { conclusion: 'TIMED_OUT' }, remediation: { roundsLeft: false } },
    ['hammer', 'hammer', 'ci-red-final']],
  ['a runner-less failure goes to the hammer', { checks: { conclusion: 'SUCCESS', runnerless: [{ name: 'synthetic' }] } },
    ['hammer', 'hammer', 'ci-runnerless']],
  ['failed CI with unknown rounds refreshes', { checks: { conclusion: 'FAILURE' }, states: { remediation: 'error' } },
    ['wait-for-CI', 'watcher', 'rounds-unknown']],
  ['DIRTY repair goes to the hammer', { pr: { mergeStateStatus: 'DIRTY' } }, ['hammer', 'hammer', 'conflict-rebase']],
  ['a confirmed conflict goes to the hammer', { pr: { mergeable: 'CONFLICTING' } }, ['hammer', 'hammer', 'conflict-rebase']],
  ['pending checks go to the bounded observer', { checks: { conclusion: 'PENDING' } }, ['wait-for-CI', 'ci', 'checks-pending']],
  ['an empty rollup fails closed as pending', { checks: { conclusion: undefined, rollup: [] } }, ['wait-for-CI', 'ci', 'checks-pending']],
  ['uncomputed mergeability goes to the bounded observer', { pr: { mergeable: 'UNKNOWN' } },
    ['wait-for-CI', 'ci', 'mergeability-unknown']],
  ['suppressed pushed-head stale review: a proven final push goes to the hammer, not another review',
    { reviews: { headSha: OLD }, remediation: { roundsLeft: false, finalPush: { headSha: HEAD, suppressed: true } } },
    ['hammer', 'hammer', 'suppressed-final-push']],
  ['an unsuppressed final push is an ordinary unproven head',
    { reviews: { headSha: OLD }, remediation: { finalPush: { headSha: HEAD, suppressed: false } } }, ['review', 'reviewer', 'stale-verdict']],
  ['a stale verdict gets an exact-head review', { reviews: { headSha: OLD } }, ['review', 'reviewer', 'stale-verdict']],
  ['no verdict gets an exact-head review', { reviews: { verdict: '' } }, ['review', 'reviewer', 'exact-head-review']],
  ['foreign head: a closer carry for another head pair is not proof',
    { reviews: { headSha: OLD }, progress: { closerAuthoredStale: { carryForward: true, reviewedHead: OLD, currentHead: OTHER } } },
    ['review', 'reviewer', 'stale-verdict']],
  ['a closer carry for this exact head pair carries the clean verdict',
    { reviews: { headSha: OLD }, progress: { closerAuthoredStale: { carryForward: true, reviewedHead: OLD, currentHead: HEAD } } },
    ['daemon-merge', 'daemon', 'carried-clean-head']],
  ['a closer rereview decision requests an exact-head review',
    { reviews: { headSha: OLD }, progress: { closerAuthoredStale: { decision: 'rereview-exact-head', reviewedHead: OLD, currentHead: HEAD } } },
    ['review', 'reviewer', 'exact-head-review']],
  ['a head-bound closer rereview decision supersedes the historical review ceiling',
    { reviews: { headSha: OLD }, policy: { reviewCeilingReached: true },
      progress: { closerAuthoredStale: { decision: 'rereview-exact-head', reviewedHead: OLD, currentHead: HEAD } } },
    ['review', 'reviewer', 'exact-head-review']],
  ['a closer rereview decision for a foreign current head does not bypass the ceiling',
    { reviews: { headSha: OLD }, policy: { reviewCeilingReached: true },
      progress: { closerAuthoredStale: { decision: 'rereview-exact-head', reviewedHead: OLD, currentHead: OTHER } } },
    ['hammer', 'hammer', 'review-ceiling']],
  ['a closer rereview decision for a foreign reviewed head does not bypass the ceiling',
    { reviews: { headSha: OLD }, policy: { reviewCeilingReached: true },
      progress: { closerAuthoredStale: { decision: 'rereview-exact-head', reviewedHead: OTHER, currentHead: HEAD } } },
    ['hammer', 'hammer', 'review-ceiling']],
  ['authorized context-only rebased reversal keeps its semantic proof',
    { reviews: { headSha: OLD }, progress: { contentProof: { kind: 'context-only-rebase', semantic: true, fromHead: OLD, toHead: HEAD } } },
    ['daemon-merge', 'daemon', 'carried-clean-head']],
  ['ancestry alone is not a reversal proof',
    { reviews: { headSha: OLD }, progress: { contentProof: { kind: 'ancestry', semantic: true, fromHead: OLD, toHead: HEAD } } },
    ['review', 'reviewer', 'stale-verdict']],
  ['an inherited trailer without semantic proof is not a reversal proof',
    { reviews: { headSha: OLD }, progress: { contentProof: { kind: 'context-only-rebase', semantic: false, fromHead: OLD, toHead: HEAD } } },
    ['review', 'reviewer', 'stale-verdict']],
  ['a semantic proof for another head pair is not proof',
    { reviews: { headSha: OLD }, progress: { contentProof: { kind: 'context-only-rebase', semantic: true, fromHead: OTHER, toHead: HEAD } } },
    ['review', 'reviewer', 'stale-verdict']],
  ['an invalid attestation gets an exact-head review', { reviews: { attestation: 'invalid' } }, ['review', 'reviewer', 'attestation-invalid']],
  ['an unreadable attestation never reaches the daemon', { reviews: { attestation: 'unknown' } },
    ['wait-for-CI', 'watcher', 'attestation-unknown']],
  ['a handed-to-review lease names the review handoff',
    { reviews: { headSha: OLD }, leases: { closer: { status: 'handed-to-review', headSha: HEAD } } }, ['review', 'reviewer', 'handed-to-review']],
  ['a review ceiling sends a stale head to the hammer', { reviews: { headSha: OLD }, policy: { reviewCeilingReached: true } },
    ['hammer', 'hammer', 'review-ceiling']],
  ['findings with a round left go to remediation', { reviews: { verdict: 'request-changes', blockingFindingCount: 2 } },
    ['remediate', 'remediator', 'review-findings'], decision => assert.equal(decision.round, 2)],
  ['findings with no round left go to the final hammer',
    { reviews: { verdict: 'request-changes', blockingFindingCount: 2 }, remediation: { roundsLeft: false } },
    ['hammer', 'hammer', 'review-findings-final']],
  ['strict non-blocking findings are findings', { reviews: { verdict: 'comment-only', nonBlockingFindingCount: 1 } },
    ['remediate', 'remediator', 'review-findings']],
  ['non-strict mode lets non-blocking findings through',
    { reviews: { verdict: 'comment-only', nonBlockingFindingCount: 1 }, policy: { strictMode: false } }, ['daemon-merge', 'daemon', 'clean-exact-head']],
  ['findings after a review handoff go to the final hammer',
    { reviews: { verdict: 'request-changes', blockingFindingCount: 1 }, leases: { closer: { status: 'handed-to-review', headSha: HEAD } } },
    ['hammer', 'hammer', 'review-findings-final']],
  ['unknown finding state is not clean', { reviews: { blockingFindingState: 'unknown' } }, ['remediate', 'remediator', 'review-findings']],
  ['a raw review row at this head has an unknown verdict',
    { reviews: { verdict: undefined, headSha: undefined, reviewer_head_sha: HEAD, review_status: 'posted' } },
    ['wait-for-CI', 'watcher', 'verdict-unknown']],
  ['a raw review row at another head proves the head unreviewed',
    { reviews: { verdict: undefined, headSha: undefined, reviewer_head_sha: OLD, review_status: 'posted' } },
    ['review', 'reviewer', 'exact-head-review']],
  ['an unknown PR refreshes', { states: { pr: 'unknown' } }, ['wait-for-CI', 'watcher', 'pr-unknown']],
  ['a PR without a state refreshes', { pr: { state: undefined } }, ['wait-for-CI', 'watcher', 'pr-unknown']],
  ['unknown reviews refresh', { states: { reviews: 'error' } }, ['wait-for-CI', 'watcher', 'reviews-unknown']],
  ['unknown checks never reach the daemon', { states: { checks: 'missing' } }, ['wait-for-CI', 'watcher', 'checks-unknown']],
];

for (const [name, options, expected, extra] of TABLE) {
  test(`row: ${name}`, () => {
    const decision = nextAction(snap(options));
    assert.deepEqual(pick(decision), expected, JSON.stringify(decision));
    assert.ok(NEXT_ACTIONS.includes(decision.action));
    assert.ok(NEXT_ACTION_ACTORS.includes(decision.actor));
    extra?.(decision);
  });
}

test('every action and every actor is reachable from the table', () => {
  const decisions = TABLE.map(([, options]) => nextAction(snap(options)));
  assert.deepEqual(new Set(decisions.map(d => d.action)), new Set(NEXT_ACTIONS));
  assert.deepEqual(new Set(decisions.map(d => d.actor)), new Set(NEXT_ACTION_ACTORS));
});

test('drain without debt: drain does not touch an owned or non-dispatch decision', () => {
  for (const options of [{}, { checks: { conclusion: 'PENDING' } },
    { launches: { closer: { status: 'running', headSha: HEAD } } }, { pr: { labels: ['no-merge-hold'] } }]) {
    const decision = nextAction(snap({ ...options, policy: { ...options.policy, drain: { active: true, epoch: 7 } } }));
    assert.equal(decision.queue.deferredBy, null, JSON.stringify(decision));
    assert.ok(!decision.evidenceRefs.some(ref => ref.startsWith('drain:')));
  }
});

test('drain defers a new dispatch once and keeps the underlying action, actor and reason', () => {
  const plain = nextAction(snap({ reviews: { headSha: OLD } }));
  const drained = nextAction(snap({ reviews: { headSha: OLD }, policy: { drain: { active: true, epoch: 7 } } }));
  assert.deepEqual(pick(drained), pick(plain));
  assert.equal(drained.queue.intent, 'dispatch');
  assert.equal(drained.queue.deferredBy, 'drain');
  assert.ok(drained.evidenceRefs.includes('drain:7'));
});

test('actual class-cap deferral needs real numbers; drain wins over capacity', () => {
  const findings = { reviews: { verdict: 'request-changes', blockingFindingCount: 1 } };
  const capped = nextAction(snap({ ...findings, policy: { capacity: { remediator: { inFlight: 3, cap: 3, workerClass: 'class-a' } } } }));
  assert.deepEqual(pick(capped), ['remediate', 'remediator', 'review-findings']);
  assert.equal(capped.queue.deferredBy, 'capacity');
  assert.ok(capped.evidenceRefs.includes('capacity:class-a:3/3'));
  const otherClass = nextAction(snap({ ...findings, policy: { capacity: { hammer: { inFlight: 9, cap: 1 } } } }));
  assert.equal(otherClass.queue.deferredBy, null);
  const headroom = nextAction(snap({ ...findings, policy: { capacity: { remediator: { inFlight: 2, cap: 3 } } } }));
  assert.equal(headroom.queue.deferredBy, null);
  const unknown = nextAction(snap({ ...findings, policy: { capacity: { remediator: { inFlight: null, cap: 3 } } } }));
  assert.equal(unknown.queue.deferredBy, null, 'unknown capacity cannot erase ownership or defer');
  const both = nextAction(snap({ ...findings, policy: { drain: { active: true, epoch: 2 },
    capacity: { remediator: { inFlight: 3, cap: 3 } } } }));
  assert.equal(both.queue.deferredBy, 'drain');
});

test('deadlines are anchored at durable progress and never slide on later polls', () => {
  const first = nextAction(snap({ observedAt: '2026-01-01T00:01:00.000Z' }));
  const later = nextAction(snap({ observedAt: '2026-01-01T03:00:00.000Z' }));
  assert.deepEqual(first.deadline, later.deadline);
  assert.equal(first.decisionKey, later.decisionKey);
  assert.equal(first.deadline.anchoredAt, ANCHOR);
  assert.equal(first.deadline.anchorSource, 'durable');
  assert.equal(first.deadline.at, new Date(Date.parse(ANCHOR) + NEXT_ACTION_DEADLINE_MS.admission).toISOString());
  // Progress moves the anchor; future stamps (clock skew) are ignored.
  const progressed = nextAction(snap({ anchors: { firstActionableAt: ANCHOR, progressAt: '2026-01-01T00:00:30.000Z',
    skewed: '2027-01-01T00:00:00.000Z' } }));
  assert.equal(progressed.deadline.anchoredAt, '2026-01-01T00:00:30.000Z');
  const none = nextAction(snap({ anchors: {} }));
  assert.equal(none.deadline.anchorSource, 'observed');
});

test('deadline classes follow the proposed targets', () => {
  const at = options => nextAction(snap(options)).deadline;
  assert.equal(at({ states: { pr: 'unknown' } }).budgetMs, 60_000);
  assert.equal(at({ states: { leases: 'error' } }).budgetMs, 5 * 60_000);
  assert.equal(at({ reviews: { headSha: OLD } }).budgetMs, 5 * 60_000);
  assert.equal(at({ checks: { conclusion: 'PENDING' } }).class, 'observer');
  // Pending checks anchor at the latest check transition.
  const pending = at({ checks: { conclusion: 'PENDING', rollup: [{ startedAt: '2026-01-01T00:00:40.000Z' }] } });
  assert.equal(pending.anchoredAt, '2026-01-01T00:00:40.000Z');
  // A live owner's deadline is its own lease/heartbeat deadline.
  const live = at({ launches: { closer: { status: 'running', headSha: HEAD, deadlineAt: '2026-01-01T02:00:00.000Z' } } });
  assert.deepEqual([live.at, live.anchorSource], ['2026-01-01T02:00:00.000Z', 'owner']);
  assert.equal(at({ pr: { state: 'MERGED' } }), null);
  assert.equal(at({ pr: { labels: ['no-merge-hold'] } }), null);
});

test('frozen input, no clock, environment or filesystem/process access, deterministic output', (t) => {
  const inputs = TABLE.map(([, options]) => snap(options));
  const expected = inputs.map(input => nextAction(input));
  const restore = [];
  const trap = (object, key) => {
    const original = object[key];
    object[key] = () => { throw new Error(`nextAction touched ${key}`); };
    restore.push(() => { object[key] = original; });
  };
  for (const key of ['readFileSync', 'writeFileSync', 'existsSync', 'statSync', 'readdirSync', 'openSync', 'appendFileSync']) trap(fs, key);
  for (const key of ['execFile', 'execFileSync', 'spawn', 'spawnSync', 'exec', 'execSync']) trap(childProcess, key);
  const realNow = Date.now;
  Date.now = () => { throw new Error('nextAction read the clock'); };
  const realEnv = process.env;
  process.env = new Proxy({}, { get: (_t, key) => { if (typeof key === 'string') throw new Error(`nextAction read env ${key}`); } });
  syncBuiltinESMExports();
  t.after(() => {
    process.env = realEnv;
    Date.now = realNow;
    for (const undo of restore) undo();
    syncBuiltinESMExports();
  });
  for (const [index, input] of inputs.entries()) {
    const again = nextAction(input);
    assert.deepEqual(again, expected[index]);
    assert.equal(again.decisionKey, expected[index].decisionKey);
  }
});

test('totality: garbage, empty and partial snapshots return an owned refresh, never throw', () => {
  for (const input of [undefined, null, 0, 'x', [], {}, { observations: null }, { observations: { pr: 'x' } },
    { observations: { pr: { state: 'complete', value: null } } },
    { observations: { pr: { state: 'complete', value: [] } } },
    { observations: { pr: complete({ state: 'OPEN' }) } }]) {
    const decision = nextAction(input);
    assert.equal(decision.action, 'wait-for-CI', JSON.stringify(input));
    assert.equal(decision.actor, 'watcher');
    assert.equal(typeof decision.decisionKey, 'string');
  }
  // A readable open PR with nothing else readable: ownership is unknown, so the
  // recovery owner reconciles it instead of anything launching.
  const partial = nextAction({ observedAt: 'not-a-date', observations: { pr: complete({ state: 'OPEN', headSha: HEAD }) } });
  assert.deepEqual(pick(partial), ['hammer', 'closure-recovery', 'ownership-unreadable']);
  assert.equal(partial.queue.intent, 'reconcile');
  assert.equal(partial.deadline.anchorSource, 'none');
});

// Cross-product over every source state. Invariants: done only on a confirmed
// terminal PR; operator-hold only on explicit hold intent; no dispatch or
// daemon decision unless PR, lease and review evidence were readable.
test('cross-product of all missing/unknown/error/complete source states keeps the safety invariants', () => {
  const variants = ['complete', 'unknown', 'error', 'missing'];
  const optionSets = [{}, { reviews: { headSha: OLD } }, { checks: { conclusion: 'FAILURE' } },
    { leases: { closer: { status: 'dispatched', lrqId: 'lrq-x', headSha: HEAD, updatedAt: ANCHOR } } },
    { pr: { state: 'MERGED' } }, { pr: { labels: ['no-merge-hold'] } }];
  const checked = ['pr', 'checks', 'reviews', 'remediation', 'launches', 'leases', 'policy', 'progress'];
  let count = 0;
  for (const options of optionSets) {
    for (let mask = 0; mask < variants.length ** 4; mask++) {
      // Vary four sources fully per mask; rotate which four across masks.
      const states = {};
      for (let i = 0; i < 4; i++) {
        states[checked[(i + mask) % checked.length]] = variants[Math.floor(mask / variants.length ** i) % variants.length];
      }
      const input = snap({ ...options, states });
      const decision = nextAction(input);
      count++;
      const label = JSON.stringify({ options, states, decision: pick(decision) });
      assert.ok(NEXT_ACTIONS.includes(decision.action), label);
      assert.ok(NEXT_ACTION_ACTORS.includes(decision.actor), label);
      const prKnown = (states.pr || 'complete') === 'complete';
      if (decision.action === 'done') assert.ok(prKnown && options.pr?.state === 'MERGED', label);
      if (decision.action === 'operator-hold') assert.ok(prKnown && options.pr?.labels?.length, label);
      if (['dispatch', 'daemon'].includes(decision.queue.intent)) {
        assert.ok(prKnown && (states.leases || 'complete') === 'complete', label);
        assert.equal(states.policy || 'complete', 'complete', label);
      }
      if (decision.action === 'daemon-merge' && decision.actor === 'daemon') {
        for (const name of ['checks', 'reviews']) assert.equal(states[name] || 'complete', 'complete', label);
      }
      assert.equal(decision.deadline === null, ['done', 'operator-hold'].includes(decision.action), label);
    }
  }
  assert.ok(count >= 1500);
});

// Combined defects: an independent oracle restates the ordered policy and is
// compared against the table for every subset of defects.
test('every combination of defects selects the first applicable row in policy order', () => {
  const DEFECTS = {
    merged: { pr: { state: 'MERGED' } },
    hold: { pr: { labels: ['no-merge-hold'] } },
    live: { launches: { closer: { status: 'running', headSha: HEAD } } },
    stop: { controls: { stop: { fingerprint: 'fp', deterministic: true } } },
    red: { checks: { conclusion: 'FAILURE' } },
    dirty: { pr: { mergeStateStatus: 'DIRTY' } },
    pending: { pr: { mergeable: 'UNKNOWN' } },
    stale: { reviews: { headSha: OLD } },
    findings: { reviews: { verdict: 'request-changes', blockingFindingCount: 1 } },
  };
  const ORACLE = [['merged', 'done'], ['hold', 'operator-hold'], ['live', 'live-owner'], ['stop', 'automated-stop'],
    ['red', 'ci-red-clean-verdict'], ['dirty', 'conflict-rebase'], ['pending', 'mergeability-unknown'], ['stale', 'stale-verdict'],
    ['findings', 'review-findings']];
  const names = Object.keys(DEFECTS);
  for (let mask = 0; mask < 2 ** names.length; mask++) {
    const active = names.filter((_, i) => mask & (1 << i));
    const options = {};
    for (const name of active) {
      for (const [source, value] of Object.entries(DEFECTS[name])) options[source] = { ...options[source], ...value };
    }
    const decision = nextAction(snap(options));
    const first = ORACLE.find(([name]) => active.includes(name));
    const expected = !first ? 'clean-exact-head' : first[0] === 'merged' ? 'merged' : first[0] === 'hold' ? 'hold-label' : first[1];
    // Stale and findings share one review row: a stale head wins over its findings.
    assert.equal(decision.reason, expected, JSON.stringify({ active, decision: pick(decision) }));
  }
});

test('the collector snapshot from NXA-01 is a valid input, and missing sources stay unknown', async () => {
  const pass = createMergeAgentSnapshotPass({ now: () => Date.parse(OBSERVED), passId: 'pass-c' });
  const source = value => ({ sourceRef: 'synthetic-reader', read: () => value });
  const snapshot = await pass.collect({ subjectKey: 'subject-2', head: HEAD, anchors: { postedAt: ANCHOR }, sources: {
    pr: source({ headRefOid: HEAD, state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' }),
    checks: source({ rollup: [{ __typename: 'CheckRun', name: 'synthetic', status: 'COMPLETED', conclusion: 'SUCCESS' }] }),
    reviews: source({ review_status: 'posted', reviewer_head_sha: OLD }),
    policy: source({ autonomousMergeExecutionEnabled: true }),
  } });
  pass.close();
  const decision = nextAction(snapshot);
  // Leases were not collected: ownership is unreadable, not absent.
  assert.deepEqual(pick(decision), ['hammer', 'closure-recovery', 'ownership-unreadable']);
  assert.equal(decision.passId, 'pass-c');
  assert.ok(decision.evidenceRefs.includes('leases:unknown'));
  const enriched = deriveNextActionSnapshot({ base: snapshot, observations: { leases: { closer: null } } });
  assert.deepEqual(pick(nextAction(enriched)), ['review', 'reviewer', 'exact-head-review']);
  assert.equal(enriched.passId, 'pass-c');
  assert.equal(enriched.generation, snapshot.generation);
  assert.ok(Object.isFrozen(enriched.observations.leases));
  for (const name of SOURCES) {
    assert.ok(Object.hasOwn(enriched.observations, name), name);
    if (name !== 'leases') assert.deepEqual(enriched.observations[name], snapshot.observations[name], name);
  }
});

test('derivation copies consumer evidence: later mutation cannot change the decision', () => {
  const lease = { status: 'dispatched', headSha: HEAD, updatedAt: ANCHOR };
  const derived = deriveNextActionSnapshot({ subjectKey: 'subject-3', head: HEAD, observedAt: OBSERVED, observations: {
    pr: { headSha: HEAD, state: 'OPEN', mergeable: 'MERGEABLE' }, leases: { closer: lease }, launches: { closer: null } } });
  const before = nextAction(derived);
  lease.status = 'terminal';
  assert.deepEqual(nextAction(derived), before);
  assert.equal(before.reason, 'live-owner');
});

test('legacy closure owners adapt to owned workflows faithfully', () => {
  const cases = [
    [{ owner: 'daemon-merge', reason: 'clean-exact-head' }, ['daemon-merge', 'daemon', 'clean-exact-head']],
    [{ owner: 'hammer', reason: 'required-checks-red' }, ['hammer', 'hammer', 'ci-red-final']],
    [{ owner: 'hammer', reason: 'ci-blocked-remediation-exhausted' }, ['hammer', 'hammer', 'ci-red-final']],
    [{ owner: 'hammer', reason: 'dispatched' }, ['hammer', 'hammer', 'live-owner']],
    [{ owner: 'conflict-rebase', reason: 'conflict-rebase' }, ['hammer', 'hammer', 'conflict-rebase']],
    [{ owner: 'review', reason: 'exact-head-review' }, ['review', 'reviewer', 'exact-head-review']],
    [{ owner: 'remediation', reason: 'review-findings' }, ['remediate', 'remediator', 'review-findings']],
    [{ owner: 'follow-up-drain', reason: 'clean-review-drain' }, ['remediate', 'remediator', 'clean-review-drain']],
    [{ owner: 'close', reason: 'empty-diff' }, ['hammer', 'closure-recovery', 'empty-diff-close']],
    [{ owner: 'wait', reason: 'pending-required-checks' }, ['wait-for-CI', 'ci', 'checks-pending']],
    [{ owner: 'wait', reason: 'pending-mergeability' }, ['wait-for-CI', 'ci', 'mergeability-unknown']],
    [{ owner: 'wait', reason: 'in-flight:lrq-1' }, ['hammer', 'hammer', 'live-owner']],
    [{ owner: 'wait', reason: 'dispatch-status-waiting-approval' }, ['hammer', 'hammer', 'live-owner']],
    [{ owner: 'wait', reason: `handed-to-review:${HEAD}` }, ['review', 'reviewer', 'handed-to-review']],
    [{ owner: 'wait', reason: 'primary-change-pending' }, ['wait-for-CI', 'watcher', 'snapshot-refresh']],
    [{ owner: 'page', reason: 'hammer-retry-cap' }, ['operator-hold', 'operator', 'retry-exhausted']],
    [{ owner: 'page', reason: 'primary-change-needs-operator' }, ['operator-hold', 'operator', 'primary-change-repair']],
    [{ owner: 'page', reason: 'synthetic-new-reason' }, ['operator-hold', 'operator', 'synthetic-new-reason']],
    [{ owner: 'unheard-of' }, ['wait-for-CI', 'watcher', 'snapshot-refresh']],
    [null, ['wait-for-CI', 'watcher', 'snapshot-refresh']],
  ];
  for (const [legacy, expected] of cases) assert.deepEqual(pick(fromLegacyClosureOwner(legacy)), expected, JSON.stringify(legacy));
  assert.equal(fromLegacyClosureOwner({ owner: 'page', reason: 'hammer-retry-cap' }).legacyReason, 'hammer-retry-cap');
  assert.deepEqual(pick(fromLegacyPostedReviewOutcome({ outcome: 'pr-terminal', terminalReason: 'merged' })), ['done', 'none', 'merged']);
  assert.deepEqual(pick(fromLegacyPostedReviewOutcome({ prTerminal: true })), ['done', 'none', 'terminal-observed']);
  assert.deepEqual(pick(fromLegacyPostedReviewOutcome({ outcome: 'operator-skip-label' })), ['operator-hold', 'operator', 'hold-label']);
  assert.deepEqual(pick(fromLegacyPostedReviewOutcome({ outcome: 'await-operator' })), ['operator-hold', 'operator', 'needs-operator']);
  assert.equal(fromLegacyPostedReviewOutcome({ outcome: 'ama-pending', amaClosureResult: { closureOwner: { owner: 'wait' } } },
    { includeClosureOwner: false }), null);
  assert.deepEqual(pick(fromLegacyPostedReviewOutcome({ outcome: 'ama-dispatched' })), ['hammer', 'hammer', 'live-owner']);
  assert.deepEqual(pick(fromLegacyNoProgressLane({ lane: 'operator-blocked', reason: 'operator-blocked-due' })),
    ['operator-hold', 'operator', 'operator-decision-required']);
  assert.equal(fromLegacyNoProgressLane({ lane: 'slow' }), null);
});
