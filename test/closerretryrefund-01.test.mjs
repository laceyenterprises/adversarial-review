// CLOSERRETRYREFUND-01: a closer attempt lost to the closer's own fault does
// not spend the PR's closer retry budget, `retry-exhausted` always has an
// executor (re-arm or a typed terminal state), and an exhausted budget never
// shadows a zero-finding exact-head review from the daemon. Synthetic only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { appendAmaAuditAttempt } from '../src/ama/audit.mjs';
import { escalateClosureBudget, refundInconclusiveExhaustion } from '../src/ama/closure-budget-escalation.mjs';
import { evaluateCloserInconclusiveRetryGate, readCloserInconclusiveRetries }
  from '../src/ama/closer-inconclusive-retry.mjs';
import { supersedeNotBootedCloser } from '../src/ama/closer-supersede.mjs';
import { evaluateHammerRetryCap, readHammerRetryCapLedger, recordHammerRetryDispatch }
  from '../src/ama/hammer-retry-cap.mjs';
import { hammerPhaseAttempt } from '../src/ama/hammer-phase-outcome.mjs';
import { HAMMER_RETRYABLE_READ_OUTCOMES } from '../src/ama/hammer-phase-outcome.mjs';
import { nextAction } from '../src/pr-next-action.mjs';

const REPO = 'fixture/closer-refund';
const PR = 4242;
const HEAD = 'e'.repeat(40);
const PUSHED = 'f'.repeat(40);
const REVISION_A = `git:${'1'.repeat(40)}`;
const REVISION_B = `git:${'2'.repeat(40)}`;
const R07 = { row: 'R07-stop', reason: 'retry-exhausted', head: HEAD };
const identity = { repo: REPO, prNumber: PR };
const at = minute => new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString();
const noPage = async () => assert.fail('a refundable budget must not page');

function scratch(t) {
  const root = mkdtempSync(join(tmpdir(), 'closerretryrefund-01-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { rootDir: join(root, 'service'), hqRoot: join(root, 'hq') };
}

function charge(rootDir, launches, headSha = HEAD) {
  launches.forEach((launchRequestId, index) => recordHammerRetryDispatch(rootDir, identity,
    { jobKey: HEAD, headSha, launchRequestId, now: at(index) }));
}

// The shape bin/hammer-merge.sh writes through bin/ama-audit.mjs.
function stop(hqRoot, launchRequestId, reason, { headSha = HEAD, minute = 10, outcome = 'failed-without-merge' } = {}) {
  appendAmaAuditAttempt({ hqRoot, repo: REPO, prNumber: PR, headSha, now: at(minute),
    metadata: { closureAuthority: 'ham-terminal-remediation' },
    attempt: hammerPhaseAttempt({ outcome, reason, launchRequestId, attemptPhase: 'hammer-gh-pr-merge' }) });
}

const capOf = rootDir => evaluateHammerRetryCap(readHammerRetryCapLedger(rootDir, identity), { jobKey: HEAD, headSha: HEAD });

test('predicate-verdict-unavailable is in the retryable closer-fault class', () => {
  assert.ok(HAMMER_RETRYABLE_READ_OUTCOMES.has('predicate-verdict-unavailable'));
});

test('three predicate-verdict-unavailable closers, then a revision change: the budget is refunded and one closer re-arms', async t => {
  const { rootDir, hqRoot } = scratch(t);
  const launches = ['lrq_fault_1', 'lrq_fault_2', 'lrq_fault_3'];
  charge(rootDir, launches);
  launches.forEach((launch, index) => stop(hqRoot, launch, 'predicate-verdict-unavailable', { minute: 10 + index }));
  assert.equal(capOf(rootDir).capExhausted, true, 'fixture: the budget reads exhausted before the executor runs');

  const result = await escalateClosureBudget({ result: { reason: 'closure-decision-mismatch', nextAction: R07 },
    rootDir, hqRoot, ...identity, now: Date.parse(at(20)), observeWaitImpl: noPage });
  assert.equal(result.needsOperator, false);
  assert.equal(result.reason, 'closure-budget-refunded');
  assert.equal(result.priorReason, 'closure-decision-mismatch');
  assert.equal(result.inconclusiveExhaustion.refunded, 3);
  assert.deepEqual(result.inconclusiveExhaustion.faultLaunches.map(fault => [fault.source, fault.reason]),
    launches.map(() => ['audit', 'predicate-verdict-unavailable']));
  const ledger = readHammerRetryCapLedger(rootDir, identity);
  for (const key of ['attemptCount', 'targetAttemptCount', 'lifetimeAttemptCount']) assert.equal(ledger[key], 0, key);
  assert.equal(capOf(rootDir).capExhausted, false, 'the closer budget is available again');

  // The faults are owned retries: from the third one on, the owner backs off on
  // the revision that produced them, and a new revision releases it once.
  const record = readCloserInconclusiveRetries(rootDir, identity);
  assert.equal(record.heads[HEAD].attempt, 3);
  const sameRevision = evaluateCloserInconclusiveRetryGate(record, { headSha: HEAD, now: at(20),
    reviewServiceRevision: record.heads[HEAD].reviewServiceRevision });
  assert.equal(sameRevision.wait, true, 'a persistent fault on one revision is paced, not spun');
  const stamped = { ...record, heads: { [HEAD]: { ...record.heads[HEAD], reviewServiceRevision: REVISION_A } } };
  const fixed = evaluateCloserInconclusiveRetryGate(stamped, { headSha: HEAD, now: at(20), reviewServiceRevision: REVISION_B });
  assert.equal(fixed.wait, false);
  assert.equal(fixed.revisionChanged, true);

  // With the budget refunded, the shared decision re-arms one ordinary closer.
  const decision = nextAction(snapshot({ hammerCap: { headSha: HEAD, retryExhausted: capOf(rootDir).capExhausted },
    reviews: { nonBlockingFindingCount: 1, verdict: 'comment-only' },
    launch: { status: 'failed', outcome: 'no-merge', retryable: true, attempt: 3 } }));
  assert.deepEqual([decision.action, decision.actor, decision.reason], ['hammer', 'hammer', 'retry-no-merge']);

  // Idempotent: a second pass refunds nothing twice.
  assert.equal(refundInconclusiveExhaustion({ rootDir, hqRoot, ...identity, now: Date.parse(at(21)) }).reason,
    'no-open-charge');
});

test('a closer that pushed a remediation head before its merge step failed is refunded from that head\'s audit', async t => {
  const { rootDir, hqRoot } = scratch(t);
  charge(rootDir, ['lrq_pushed_1', 'lrq_pushed_2', 'lrq_pushed_3']);
  for (const launch of ['lrq_pushed_1', 'lrq_pushed_2', 'lrq_pushed_3']) {
    stop(hqRoot, launch, 'predicate-verdict-unavailable', { headSha: PUSHED });
  }
  const result = await escalateClosureBudget({ result: { nextAction: { ...R07, head: PUSHED } },
    rootDir, hqRoot, ...identity, now: Date.parse(at(20)), observeWaitImpl: noPage });
  assert.equal(result.inconclusiveExhaustion.refunded, 3);
});

test('genuine PR-attributed closer failures still exhaust the budget and publish a typed terminal state', async t => {
  const { rootDir, hqRoot } = scratch(t);
  charge(rootDir, ['lrq_real_1', 'lrq_real_2', 'lrq_mixed']);
  stop(hqRoot, 'lrq_real_1', 'merge-refused');
  stop(hqRoot, 'lrq_real_2', 'predicate-not-eligible');
  // A world refusal anywhere in a launch makes the whole launch an adjudication.
  stop(hqRoot, 'lrq_mixed', 'predicate-verdict-unavailable', { minute: 11 });
  stop(hqRoot, 'lrq_mixed', 'findings-unresolved', { minute: 12 });
  const pages = [];
  for (let tick = 0; tick < 3; tick++) {
    const result = await escalateClosureBudget({ result: { reason: 'closure-decision-mismatch', nextAction: R07 },
      rootDir, hqRoot, ...identity, now: Date.parse(at(20 + tick)),
      observeWaitImpl: async options => { pages.push(options); return { paged: pages.length === 1 }; } });
    assert.equal(result.needsOperator, true);
    assert.equal(result.reason, 'closure-retry-exhausted', 'a named terminal state, never a repeating mismatch');
    assert.deepEqual([result.closureTerminal.state, result.closureTerminal.owner, result.closureTerminal.realAttempts],
      ['closure-retry-exhausted', 'operator', 3]);
    assert.match(result.closureTerminal.recommendedAction, /operator re-drive/);
  }
  assert.equal(readHammerRetryCapLedger(rootDir, identity).attemptCount, 3, 'real charges stay spent');
  assert.equal(capOf(rootDir).capExhausted, true);
  assert.ok(pages.every(page => page.waitClass === 'closure-retry-exhausted' && page.immediate === true));
});

test('one fault among real charges is refunded on its own, leaving the real budget accounting intact', t => {
  const { rootDir, hqRoot } = scratch(t);
  charge(rootDir, ['lrq_real', 'lrq_fault']);
  stop(hqRoot, 'lrq_real', 'merge-refused');
  stop(hqRoot, 'lrq_fault', 'predicate-verdict-unavailable');
  const result = refundInconclusiveExhaustion({ rootDir, hqRoot, ...identity, now: Date.parse(at(20)) });
  assert.deepEqual([result.reason, result.refunded, result.realAttempts], ['fault-charges-refunded', 1, 1]);
  assert.equal(readHammerRetryCapLedger(rootDir, identity).attemptCount, 1);
  assert.equal(capOf(rootDir).capExhausted, false, 'one real attempt leaves one closer');
});

test('a charge with no audit, or an unreadable audit, is real', t => {
  const { rootDir, hqRoot } = scratch(t);
  charge(rootDir, ['lrq_silent']);
  assert.equal(refundInconclusiveExhaustion({ rootDir, hqRoot, ...identity, now: Date.parse(at(20)) }).reason,
    'real-attempts-spent-budget');
  assert.equal(refundInconclusiveExhaustion({ rootDir, hqRoot, ...identity, now: Date.parse(at(20)),
    readAuditImpl: () => { throw new Error('unreadable'); } }).reason, 'real-attempts-spent-budget');
});

test('a closer the pipeline superseded before it booted is refunded and named in the owner record', async t => {
  const { rootDir } = scratch(t);
  charge(rootDir, ['lrq_superseded']);
  const statuses = ['admitted', 'admitted', 'canceled'];
  const result = await supersedeNotBootedCloser({ rootDir, repo: REPO, prNumber: PR, headSha: HEAD,
    reviewedHeadSha: HEAD, launchRequestId: 'lrq_superseded', hqPath: 'hq', retryDelaysMs: [],
    logger: { log() {}, warn() {} }, now: () => at(30),
    readLaunchImpl: async () => {
      const status = statuses.shift() || 'canceled';
      return { state: 'complete', value: { terminal: status === 'canceled', effectiveLaunch: { status } } };
    },
    cancelImpl: async () => ({ ok: true }),
    updateDispatchRecordImpl: (root, id, mutate) => mutate({ launchRequestId: 'lrq_superseded' }),
    readLeaseImpl: () => null });
  assert.equal(result.superseded, true);
  assert.equal(readHammerRetryCapLedger(rootDir, identity).attemptCount, 0);
  const record = readCloserInconclusiveRetries(rootDir, identity);
  assert.equal(record.heads[HEAD].launches[0].launchRequestId, 'lrq_superseded');
  assert.equal(record.heads[HEAD].reason, 'superseded-by-clean-exact-head-review');
});

// ── The zero-finding path is not shadowed by an exhausted closer ────────────
const OBSERVED = at(40);
const complete = value => ({ state: 'complete', value, provenance: { sourceRef: 'synthetic' } });
function snapshot({ hammerCap, reviews = {}, launch = null, execution = null } = {}) {
  const values = {
    pr: { headSha: HEAD, state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', labels: [] },
    checks: { conclusion: 'SUCCESS' },
    // The review posted before every closer attempt.
    reviews: { verdict: 'approved', headSha: HEAD, blockingFindingState: 'known', blockingFindingCount: 0,
      nonBlockingFindingState: 'known', nonBlockingFindingCount: 0, attestation: 'valid', postedAt: at(0), ...reviews },
    remediation: { roundsLeft: false, completedRounds: 1 },
    launches: { closer: launch ? { headSha: HEAD, launchRequestId: 'lrq_prior', ...launch,
      probe: { ok: true, row: { launch_request_id: 'lrq_prior', status: launch.status }, retryChain: [] } } : null },
    leases: { closer: null },
    controls: {},
    policy: { strictMode: true, autonomousMergeExecutionEnabled: true, hammerCap },
    progress: execution ? { daemonExecution: execution } : {},
  };
  return { subjectKey: `${REPO}#${PR}`, head: HEAD, passId: 'pass-1', generation: 1, observedAt: OBSERVED,
    anchors: { firstActionableAt: OBSERVED },
    observations: Object.fromEntries(Object.entries(values).map(([name, value]) => [name, complete(value)])) };
}
const pick = decision => [decision.row, decision.action, decision.actor, decision.reason];

test('a zero-finding exact-head CLEAN PR with an exhausted closer budget goes to the daemon, whenever the review posted', () => {
  for (const hammerCap of [
    { headSha: HEAD, retryExhausted: true, recordedAt: at(30) },
    { headSha: HEAD, lifetimeExhausted: true, recordedAt: at(30) },
    { headSha: HEAD, retryExhausted: true, recordedAt: null },
  ]) {
    const decision = nextAction(snapshot({ hammerCap }));
    assert.deepEqual(pick(decision), ['R15-daemon', 'daemon-merge', 'daemon', 'clean-exact-head']);
    assert.ok(decision.evidenceRefs.includes('budget-superseded-by-zero-finding-review'));
  }
});

test('an exhausted budget still holds a review with any finding, an unknown count, a stale head or red CI', () => {
  const hammerCap = { headSha: HEAD, retryExhausted: true, recordedAt: at(30) };
  for (const reviews of [{ nonBlockingFindingCount: 1, verdict: 'comment-only' }, { blockingFindingCount: 1 },
    { nonBlockingFindingState: 'unknown' }, { headSha: PUSHED }]) {
    assert.equal(nextAction(snapshot({ hammerCap, reviews })).reason, 'retry-exhausted', JSON.stringify(reviews));
  }
});

test('a daemon that refused this head for accountability is not reselected: the budget executor owns it', () => {
  const decision = nextAction(snapshot({ hammerCap: { headSha: HEAD, retryExhausted: true, recordedAt: at(30) },
    execution: { headSha: HEAD, reason: 'worker-identity-unresolved', reasons: ['worker-observation-inconclusive'] } }));
  assert.deepEqual([decision.row, decision.actor, decision.reason], ['R07-stop', 'closure-recovery', 'retry-exhausted']);
});


// ── End to end through the closure orchestration ────────────────────────────
import { maybeDispatchAmaClosureFor } from '../src/ama-closure-orchestration.mjs';
import { dispatchReadTransport } from '../src/dispatch-read-client.mjs';
import { resolveGateStatusContext } from '../src/adversarial-gate-context.mjs';

const CLEAN_BODY = ['## Summary', 'Fixture change.', '', '## Blocking issues', '- None.', '',
  '## Non-blocking issues', '- None.', '', '## Verdict', 'Comment only'].join('\n');
const FINDING_BODY = ['## Summary', 'Fixture change.', '', '## Blocking issues', '- None.', '',
  '## Non-blocking issues', '- **Ambiguous timestamp**', '  - **Problem:** unclear zone.', '',
  '## Verdict', 'Comment only'].join('\n');

function closure(t, rootDir, { body, calls }) {
  t.mock.method(dispatchReadTransport, 'lookup', async selector => ({ schema_version: 1,
    observation: selector.observation, status: 'not_found', items: [], complete: true, next_offset: null,
    scope_complete: false, mutation_authority: false, roots: [], retry_edges: [] }));
  return {
    rootDir,
    reviewStateRow: { repo: REPO, pr_number: PR, pr_state: 'open', review_status: 'posted',
      last_verdict: 'Comment only', risk_class: 'low', remediation_pending: 0, reviewer: 'codex',
      reviewer_head_sha: HEAD, review_body: body, posted_at: at(0) },
    dispatchJob: {},
    candidate: { headSha: HEAD, riskClass: 'low', prAuthor: 'fixture-worker', prState: 'open',
      mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', isDraft: false,
      statusCheckRollup: [{ __typename: 'CheckRun', name: 'repo-guards', status: 'COMPLETED', conclusion: 'SUCCESS' }],
      branchProtection: { requiredContexts: [resolveGateStatusContext(process.env)] } },
    labelNames: [], operatorApprovalEvent: null, adversarialMergeRequestedEvent: null,
    repoPath: REPO, prNumber: PR, currentRevisionRef: HEAD, logger: { log() {}, info() {}, warn() {}, error() {} },
    now: () => Date.parse(OBSERVED),
    loadConfigImpl: () => ({ getMergeAuthorityConfig: () => ({ enabled: true }) }),
    resolveAmaHammerDispatchModeImpl: () => 'inline',
    fetchLatestHeadReviewBodiesImpl: async () => [body],
    resolveHeadCloserCommitSuppressionImpl: async () => ({ suppressed: false, reason: 'not-closer-commit' }),
    fetchMergedProtectiveDependentsImpl: async () => [],
    requestEligibleHammerWakeImpl: () => ({ requested: false }),
    probeClosureOwnershipImpl: async () => ({ owned: false, uncertain: false, launchIds: [] }),
    observeClosureWaitImpl: async () => ({ paged: false }),
    maybeDispatchAmaCloserImpl: async () => { calls.hammer.push('dispatch'); return { dispatched: false, reason: 'fixture' }; },
    runDaemonCleanMergeAttemptImpl: async args => {
      calls.daemon.push(args.sharedNextAction?.decision);
      return { disposition: 'merged', reason: 'merged', remoteMergedConfirmed: true, mergedAt: OBSERVED };
    },
  };
}

test('end to end: an exhausted closer budget on a zero-finding exact-head CLEAN PR, and the daemon merges', async t => {
  const { rootDir } = scratch(t);
  // Two real closer charges after the review posted spend this head's budget.
  ['lrq_spent_1', 'lrq_spent_2'].forEach((launchRequestId, index) => recordHammerRetryDispatch(rootDir, identity,
    { jobKey: HEAD, headSha: HEAD, launchRequestId, now: at(10 + index) }));
  assert.equal(capOf(rootDir).capExhausted, true);
  const calls = { daemon: [], hammer: [] };
  const result = await maybeDispatchAmaClosureFor(closure(t, rootDir, { body: CLEAN_BODY, calls }));
  assert.equal(calls.daemon.length, 1, 'the daemon clean merge ran');
  assert.equal(calls.daemon[0].action, 'daemon-merge');
  assert.ok(calls.daemon[0].evidenceRefs.includes('budget-superseded-by-zero-finding-review'));
  assert.equal(result.reason, 'daemon-merged');
  assert.deepEqual(calls.hammer, []);
});

test('end to end: the same exhausted budget with one non-blocking finding stays with the budget executor', async t => {
  const { rootDir } = scratch(t);
  ['lrq_spent_1', 'lrq_spent_2'].forEach((launchRequestId, index) => recordHammerRetryDispatch(rootDir, identity,
    { jobKey: HEAD, headSha: HEAD, launchRequestId, now: at(10 + index) }));
  const calls = { daemon: [], hammer: [] };
  const result = await maybeDispatchAmaClosureFor(closure(t, rootDir, { body: FINDING_BODY, calls }));
  assert.deepEqual(calls.daemon, []);
  assert.equal(result.nextAction?.reason, 'retry-exhausted');
  assert.equal(result.reason, 'closure-retry-exhausted');
  assert.equal(result.closureTerminal?.owner, 'operator');
});
