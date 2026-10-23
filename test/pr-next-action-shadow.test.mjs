import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deriveNextActionSnapshot, nextAction } from '../src/pr-next-action.mjs';
import { noteNextActionLegacy, setNextActionShadowSinkForTesting, shadowNextAction,
  NEXT_ACTION_OVERDUE_ALERTS_ENV } from '../src/pr-next-action-shadow.mjs';
import { closureOwnerShadowEvidence, launchSource, settleNextActionShadowsForTesting,
  shadowNextActionLater } from '../src/pr-next-action-consumer.mjs';
import { observeClosureWait } from '../src/ama/closure-wait.mjs';
import { classifyClosureOwnership } from '../src/merge-agent-rescue-classifier.mjs';
import { handlePostedReviewRow } from '../src/posted-review-row.mjs';
import { maybeDispatchAmaClosureFor } from '../src/ama-closure-orchestration.mjs';

// Synthetic fixtures only: opaque subject keys, fabricated heads and evidence.
const HEAD = 'a'.repeat(40), OLD = 'b'.repeat(40);
const ANCHOR = '2026-01-01T00:00:00.000Z';
const quiet = { log() {}, warn() {}, error() {}, info() {} };
const env = { NODE_TEST_CONTEXT: 'child' };

function base({ subjectKey = 'subject-1', observations = {} } = {}) {
  return deriveNextActionSnapshot({ subjectKey, head: HEAD, observedAt: '2026-01-01T00:01:00.000Z',
    anchors: { firstActionableAt: ANCHOR }, observations: {
      pr: { headSha: HEAD, state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' },
      checks: { conclusion: 'SUCCESS' },
      reviews: { verdict: 'approved', headSha: OLD, blockingFindingState: 'known', blockingFindingCount: 0,
        nonBlockingFindingState: 'known', nonBlockingFindingCount: 0 },
      remediation: { roundsLeft: true }, leases: { closer: null }, launches: { closer: null },
      policy: { strictMode: true, autonomousMergeExecutionEnabled: true }, progress: {}, controls: {}, ...observations } });
}

test.afterEach(() => setNextActionShadowSinkForTesting(null));

test('a disagreement is logged with generation, source, deadline and evidence references', async () => {
  const records = [];
  const snapshot = base();
  const outcome = await shadowNextAction({ source: 'synthetic-consumer', snapshot, sink: r => records.push(r), env,
    legacy: { owner: 'daemon-merge', reason: 'clean-exact-head' }, now: () => Date.parse(ANCHOR) });
  assert.equal(records.length, 1);
  const [record] = records;
  assert.equal(record.kind, 'disagreement');
  assert.equal(record.source, 'synthetic-consumer');
  assert.equal(record.subjectKey, 'subject-1');
  assert.equal(record.generation, null);
  assert.deepEqual(record.fields, ['action', 'actor', 'reason']);
  assert.deepEqual([record.legacy.action, record.next.action, record.next.reason], ['daemon-merge', 'review', 'stale-verdict']);
  assert.equal(record.next.deadline.at, '2026-01-01T00:05:00.000Z');
  assert.ok(record.evidenceRefs.includes('reviews:complete:consumer-evidence'));
  assert.match(record.caseKey, /^[0-9a-f]{24}$/);
  assert.equal(outcome.disagreement, record);
});

test('agreement logs nothing; an overdue decision is reported once per decision', async () => {
  const records = [];
  const snapshot = base();
  const legacy = { owner: 'review', reason: 'exact-head-review' };
  const run = () => shadowNextAction({ source: 'synthetic', snapshot, sink: r => records.push(r), env,
    legacy: { ...legacy, owner: 'review' }, now: () => Date.parse('2026-01-01T01:00:00.000Z') });
  // review/reviewer/exact-head-review vs stale-verdict differs only by reason.
  const outcome = await run();
  assert.deepEqual(outcome.disagreement.fields, ['reason']);
  assert.equal(records.filter(r => r.kind === 'overdue').length, 1);
  assert.equal(records.find(r => r.kind === 'overdue').ageMs, 55 * 60_000);
  await run();
  assert.equal(records.filter(r => r.kind === 'overdue').length, 1, 'overdue reported once per decision');
  records.length = 0;
  await shadowNextAction({ source: 'synthetic', snapshot, sink: r => records.push(r), env,
    legacy: { action: 'review', actor: 'reviewer', reason: 'stale-verdict' }, now: () => Date.parse(ANCHOR) });
  assert.deepEqual(records, []);
});

test('the shadow is inert under the offline runner unless a sink is installed', async () => {
  assert.equal(await shadowNextAction({ source: 'synthetic', snapshot: base(), env, legacy: { owner: 'page' } }), null);
  noteNextActionLegacy({ source: 'lane', subjectKey: 'subject-1', head: HEAD, legacy: { owner: 'page' }, env });
  const records = [];
  setNextActionShadowSinkForTesting(r => records.push(r));
  await shadowNextAction({ source: 'synthetic', snapshot: base(), env, now: () => Date.parse(ANCHOR) });
  assert.deepEqual(records, [], 'the inert note was never stored');
});

test('sink and evidence failures never throw and never reject', async () => {
  const throwing = () => { throw new Error('synthetic sink failure'); };
  assert.equal(await shadowNextAction({ source: 'synthetic', snapshot: base(), sink: () => {}, env,
    legacy: () => { throw new Error('synthetic legacy failure'); } }), null);
  let outcome;
  assert.doesNotThrow(() => {
    outcome = shadowNextAction({ source: 'synthetic', snapshot: base(), sink: throwing, env,
      legacy: { owner: 'daemon-merge' }, now: () => Date.parse(ANCHOR) });
  });
  assert.equal((await outcome).sinkError.message, 'synthetic sink failure');
  const evidence = () => { throw new Error('synthetic evidence failure'); };
  assert.equal(await shadowNextAction({ source: 'synthetic', evidence, sink: throwing, env }), null);
  const rejecting = async () => { throw new Error('async sink failure'); };
  const result = await shadowNextAction({ source: 'synthetic', snapshot: base(), sink: rejecting, env,
    legacy: { owner: 'daemon-merge' }, now: () => Date.parse(ANCHOR) });
  assert.equal(result.sinkError.message, 'async sink failure');
  const hostileNow = await shadowNextAction({ source: 'synthetic', snapshot: base(), sink: () => {}, env,
    legacy: { owner: 'daemon-merge' }, now: () => { throw new Error('clock failure'); } });
  assert.equal(hostileNow, null);
});

test('one decision per pass: later consumers reuse the enriched decision and drain lane notes', async () => {
  const records = [];
  setNextActionShadowSinkForTesting(r => records.push(r));
  const pass = deriveNextActionSnapshot({ subjectKey: 'subject-9', head: HEAD, observedAt: '2026-01-01T00:01:00.000Z',
    observations: { pr: { headSha: HEAD, state: 'OPEN', mergeable: 'MERGEABLE' } } });
  noteNextActionLegacy({ source: 'no-progress-lane', subjectKey: 'subject-9', head: HEAD,
    legacy: () => ({ action: 'operator-hold', actor: 'operator', reason: 'operator-decision-required' }), env: {} });
  // A lane that claims nothing leaves no note; a throwing thunk is swallowed.
  noteNextActionLegacy({ source: 'no-progress-lane-active', subjectKey: 'subject-9', head: HEAD, legacy: () => null, env: {} });
  noteNextActionLegacy({ source: 'no-progress-lane-bad', subjectKey: 'subject-9', head: HEAD,
    legacy: () => { throw new Error('synthetic'); }, env: {} });
  const first = await shadowNextAction({ source: 'closure-orchestration', passSnapshot: pass, env,
    evidence: closureOwnerShadowEvidence({ currentHead: HEAD, lease: null, checks: 'FAILURE', roundsLeft: false,
      reviewState: { verdict: 'approved', headSha: HEAD } }, { subjectKey: 'subject-9', autonomousMergeExecutionEnabled: true }),
    legacy: { owner: 'hammer', reason: 'required-checks-red' }, now: () => Date.parse(ANCHOR) });
  assert.deepEqual([first.decision.action, first.decision.reason], ['hammer', 'ci-red-final']);
  assert.equal(first.disagreement, null);
  assert.equal(first.notes.length, 1);
  assert.equal(first.notes[0].source, 'no-progress-lane');
  const second = await shadowNextAction({ source: 'posted-review', passSnapshot: pass, env, now: () => Date.parse(ANCHOR) });
  assert.equal(second.decision, first.decision, 'the same decision object reaches every consumer of the pass');
  assert.equal(second.notes.length, 0, 'notes are compared once');
});

test('round enrichment preserves the original pass remediation owner with failed CI', async () => {
  const pass = base({ observations: { remediation: {
    job: { status: 'in_progress', headSha: HEAD }, completedRounds: 1, maxRounds: 3,
  } } });
  const run = followUpJob => shadowNextAction({ source: 'closure-orchestration', passSnapshot: pass, env,
    evidence: closureOwnerShadowEvidence({ currentHead: HEAD, lease: null, checks: 'FAILURE', roundsLeft: true,
      followUpJob }, { autonomousMergeExecutionEnabled: true }), sink: () => {}, now: () => Date.parse(ANCHOR) });
  const retained = await run(undefined);
  assert.deepEqual([retained.decision.action, retained.decision.actor, retained.decision.reason, retained.decision.queue.intent],
    ['remediate', 'remediator', 'live-owner', 'owned']);
  assert.equal(retained.decision.round, 2, 'inherited round counts are preserved too');
  const shared = await shadowNextAction({ source: 'posted-review', passSnapshot: pass, env, sink: () => {} });
  assert.equal(shared.decision, retained.decision);
  const replaced = await run({ status: 'completed', headSha: HEAD });
  assert.deepEqual([replaced.decision.reason, replaced.decision.queue.intent], ['ci-red', 'dispatch'],
    'explicit new job evidence replaces the inherited owner');
  assert.equal(pass.observations.remediation.value.job.status, 'in_progress');
});

test('launch evidence through the ledger seam: terminal exit-zero no-merge retries; unreadable reconciles', async () => {
  const lease = { status: 'dispatched', lrqId: 'lrq-1', headSha: HEAD, updatedAt: ANCHOR };
  const input = { currentHead: HEAD, lease, checks: 'SUCCESS', roundsLeft: true, mergeable: 'MERGEABLE',
    reviewState: { verdict: 'approved', headSha: HEAD, blockingFindingState: 'known', blockingFindingCount: 0,
      nonBlockingFindingState: 'known', nonBlockingFindingCount: 0 } };
  const candidate = { headSha: HEAD, prState: 'OPEN', mergeable: 'MERGEABLE' };
  const evidence = readLaunches => ({ ...closureOwnerShadowEvidence(input,
    { subjectKey: 'subject-2', candidate, autonomousMergeExecutionEnabled: true }), readLaunches });
  const run = readLaunches => shadowNextAction({ source: 'synthetic', evidence: evidence(readLaunches), sink: () => {}, env,
    now: () => Date.parse(ANCHOR) }).then(outcome => outcome.decision);
  const terminal = await run(async () => ({ state: 'complete', provenance: { sourceRef: 'launch-requests' }, value: { closer: {
    row: { status: 'succeeded' }, retryChain: [], headSha: HEAD, outcome: 'no-merge', retryable: true, attempt: 1 } } }));
  assert.deepEqual([terminal.action, terminal.actor, terminal.reason], ['hammer', 'hammer', 'retry-no-merge']);
  const failed = await run(async () => { throw new Error('synthetic ledger failure'); });
  assert.deepEqual([failed.actor, failed.reason], ['closure-recovery', 'ownership-unreadable']);
  const running = await run(async () => ({ state: 'complete', value: { closer: { row: { status: 'running' }, headSha: HEAD } } }));
  assert.deepEqual([running.actor, running.reason], ['hammer', 'live-owner']);
});

for (const exhausted of [false, true]) test(`failed terminal launch supersedes a dispatched lease (${exhausted ? 'exhausted' : 'retry available'})`, async () => {
  const lease = { status: 'dispatched', lrqId: 'lrq-failed', headSha: HEAD, updatedAt: ANCHOR };
  const launches = launchSource({ state: 'complete', value: {
    launchRequestId: 'lrq-failed', launch: { status: 'failed', attempt: 2 }, terminal: true, processSucceeded: false,
    retryChain: [], retryChainUnreadable: false,
  } }, lease, { retryExhausted: exhausted, lifetimeExhausted: false });
  assert.deepEqual([launches.value.closer.outcome, launches.value.closer.retryable], ['no-merge', !exhausted]);
  const snapshot = base({ observations: { leases: { closer: lease }, launches,
    reviews: { verdict: 'approved', headSha: HEAD, blockingFindingState: 'known', blockingFindingCount: 0,
      nonBlockingFindingState: 'known', nonBlockingFindingCount: 0 } } });
  const records = [];
  const outcome = await shadowNextAction({ source: 'closure-orchestration', snapshot, env, sink: record => records.push(record),
    legacy: { owner: 'wait', reason: 'in-flight' },
    now: () => Date.parse(ANCHOR) });
  assert.deepEqual([outcome.decision.actor, outcome.decision.reason, outcome.decision.queue.intent], exhausted
    ? ['closure-recovery', 'hammer-final-no-merge', 'reconcile'] : ['hammer', 'retry-no-merge', 'dispatch']);
  assert.equal(outcome.decision.attempt, exhausted ? 2 : 3);
  assert.equal(records.find(record => record.kind === 'disagreement').next.attempt, exhausted ? 2 : 3);
  const unreadable = deriveNextActionSnapshot({ base: snapshot, observations: {
    launches: { ...launches, value: { closer: { ...launches.value.closer, retryChainUnreadable: true } } },
  } });
  assert.equal(nextAction(unreadable).reason, 'ownership-unreadable', 'terminal evidence cannot bypass unreadable descendants');
  const merged = deriveNextActionSnapshot({ base: snapshot, observations: { pr: { state: 'MERGED', headSha: HEAD } } });
  assert.equal(nextAction(merged).reason, 'merged', 'remote PR state remains authoritative');
});

test('ledger launch attempts prefer the row, fall back to the observation and preserve zero', () => {
  for (const [value, expected] of [
    [{ launch: { attempt: 2 }, attempt: 4 }, 2],
    [{ launch: { attempt: 0 }, attempt: 4 }, 0],
    [{ launch: { attempt: null }, attempt: 4 }, 4],
    [{ attempt: 0 }, 0],
    [{ launch: {} }, null],
  ]) {
    const source = launchSource({ state: 'complete', value }, null, {});
    assert.equal(source.value.closer.attempt, expected);
  }
});

test('the NXA-01 ledger observation maps to launch evidence: exit zero on an open PR is a no-merge', () => {
  const cap = { retryExhausted: false, lifetimeExhausted: false };
  const lease = { status: 'dispatched', headSha: HEAD };
  const observation = value => ({ state: 'complete', value: { launchRequestId: 'lrq-1', retryChain: [],
    retryChainUnreadable: false, liveRetryLaunchRequestId: null, ...value } });
  const exitZero = launchSource(observation({ launch: { status: 'succeeded' }, terminal: true, processSucceeded: true }), lease, cap);
  assert.deepEqual([exitZero.value.closer.outcome, exitZero.value.closer.retryable], ['no-merge', true]);
  const capped = launchSource(observation({ launch: { status: 'succeeded' }, terminal: true, processSucceeded: true }), lease,
    { ...cap, retryExhausted: true });
  assert.equal(capped.value.closer.retryable, false);
  const deferred = launchSource(observation({ launch: { status: 'failed' }, terminal: true, processSucceeded: false }),
    { status: 'terminal', terminalOutcome: 'deferred', headSha: HEAD }, cap);
  assert.equal(deferred.value.closer.outcome, 'no-merge');
  const running = launchSource(observation({ launch: { status: 'running' }, terminal: false }), lease, cap);
  assert.equal(running.value.closer.outcome, null);
  assert.equal(nextAction(deriveNextActionSnapshot({ subjectKey: 's', head: HEAD, observedAt: ANCHOR, observations: {
    pr: { headSha: HEAD, state: 'OPEN' }, leases: { closer: lease }, launches: running } })).reason, 'live-owner');
  assert.deepEqual(launchSource({ state: 'unknown', value: null }, lease, cap).state, 'unknown');
  assert.deepEqual(launchSource({ state: 'error' }, lease, cap).state, 'error');
});

test('overdue alerts use the closure-wait path only when enabled, and a failed delivery retries once', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'nxa-shadow-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const snapshot = base({ subjectKey: 'example/synthetic#5' });
  const now = () => Date.parse('2026-01-01T02:00:00.000Z');
  let observed = 0;
  await shadowNextAction({ source: 'synthetic', snapshot, sink: () => {}, env, rootDir, repo: 'example/synthetic', prNumber: 5,
    now, observeOverdueImpl: async () => { observed++; } });
  assert.equal(observed, 0, 'alerts are off unless the rollout owner enables them');
  setNextActionShadowSinkForTesting(null);
  const pages = [];
  let fail = true;
  const pageImpl = async (text) => {
    if (fail) { fail = false; throw new Error('synthetic transport refusal'); }
    pages.push(text);
  };
  const enabled = { ...env, [NEXT_ACTION_OVERDUE_ALERTS_ENV]: '1' };
  const deliver = () => shadowNextAction({ source: 'synthetic', snapshot, sink: () => {}, env: enabled, rootDir,
    repo: 'example/synthetic', prNumber: 5, now, observeOverdueImpl: observeClosureWait, overduePageImpl: pageImpl });
  const refused = await deliver();
  assert.equal(refused.alert.error.message, 'synthetic transport refusal');
  const delivered = await deliver();
  assert.equal(delivered.alert.notify, true);
  assert.equal(pages.length, 1);
  assert.match(pages[0], /NXA-02 next action overdue: action=review actor=reviewer reason=stale-verdict head=aaaaaaaaaaaa age_minutes=115/);
  setNextActionShadowSinkForTesting(null);
  const repeat = await deliver();
  assert.equal(repeat.alert.notify, false, 'closure-wait debounces a delivered page');
  assert.equal(pages.length, 1);
});

test('rescue classifier: legacy answer is byte-identical with a failing shadow sink', async () => {
  const input = { reviewState: { verdict: 'approved', headSha: OLD }, currentHead: HEAD, roundsLeft: true,
    mergeable: 'MERGEABLE', checks: 'SUCCESS' };
  const before = JSON.stringify(classifyClosureOwnership(input));
  setNextActionShadowSinkForTesting(() => { throw new Error('synthetic sink failure'); });
  assert.equal(JSON.stringify(classifyClosureOwnership(input)), before);
  await settleNextActionShadowsForTesting();
  const records = [];
  setNextActionShadowSinkForTesting(r => records.push(r));
  assert.equal(JSON.stringify(classifyClosureOwnership(input)), before);
  await settleNextActionShadowsForTesting();
  // Rescue input has no PR state: the shadow refreshes, which disagrees.
  assert.equal(records[0]?.source, 'rescue-classifier');
  assert.equal(records[0]?.next.reason, 'pr-unknown');
});

function postedArgs(captured, prState) {
  const row = { review_status: 'posted', reviewer_head_sha: HEAD, posted_at: ANCHOR };
  return { repoPath: 'example/synthetic', prNumber: 7, currentRevisionRef: HEAD, now: () => Date.parse(ANCHOR),
    currentReviewRowReader: () => row, projectGateStatusSafe: async () => null,
    latestFollowUpJobFinder: () => null, latestPostedReviewBodyFinder: () => null,
    fetchMergeAgentCandidateImpl: async () => ({ headSha: HEAD, prState }),
    buildMergeAgentDispatchJobImpl: () => ({}),
    resolveMergeAgentCoexistenceForWatcherImpl: async ({ passSnapshot }) => {
      captured.pass = passSnapshot;
      return { outcome: 'pr-terminal', terminalReason: 'merged' };
    }, logger: quiet };
}

for (const prState of ['merged', 'open']) test(`posted-review handler (${prState} pass evidence): legacy result is byte-identical when shadow logging fails`, async () => {
  const plain = await handlePostedReviewRow(postedArgs({}, prState));
  setNextActionShadowSinkForTesting(() => { throw new Error('synthetic sink failure'); });
  const failing = await handlePostedReviewRow(postedArgs({}, prState));
  await settleNextActionShadowsForTesting();
  assert.equal(JSON.stringify(failing), JSON.stringify(plain));
  const records = [];
  setNextActionShadowSinkForTesting(r => records.push(r));
  const captured = {};
  const recorded = await handlePostedReviewRow(postedArgs(captured, prState));
  assert.equal(JSON.stringify(recorded), JSON.stringify(plain));
  await settleNextActionShadowsForTesting();
  const record = records.find(r => r.source === 'posted-review' && r.kind === 'disagreement');
  if (prState === 'merged') {
    assert.equal(record, undefined, 'a confirmed merged PR agrees with the legacy terminal outcome');
    return;
  }
  // The pass observed the PR open: the shared decision never declares it done.
  assert.deepEqual([record.legacy.action, record.legacy.reason], ['done', 'merged']);
  assert.notEqual(record.next.action, 'done');
  assert.equal(record.passId, captured.pass.passId);
  assert.equal(record.generation, captured.pass.generation);
});

for (const parked of [false, true]) test(`closure orchestration${parked ? ' (parked head)' : ''}: final legacy owner and every effect are unchanged with a failing shadow sink`, async (t) => {
  const repo = 'example/synthetic-closure', prNumber = 37, head = HEAD;
  const reviewed = parked ? HEAD : OLD;
  const body = '## Blocking issues\n- None.\n## Non-blocking issues\n- None.\n## Verdict\nComment only';
  const runOnce = async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'nxa-closure-'));
    t.after(() => rmSync(rootDir, { recursive: true, force: true }));
    const effects = [];
    const pass = deriveNextActionSnapshot({ subjectKey: `${repo}#${prNumber}`, head, observedAt: ANCHOR });
    const result = await maybeDispatchAmaClosureFor({ rootDir, repoPath: repo, prNumber, currentRevisionRef: head, logger: quiet,
      passSnapshot: pass, now: () => Date.parse(ANCHOR),
      reviewStateRow: { repo, pr_number: prNumber, pr_state: 'open', review_status: 'ci-blocked',
        failure_message: '[ci-regression-stopped] Synthetic exhausted remediation', reviewer: 'claude',
        reviewer_login: 'synthetic-reviewer', reviewer_head_sha: reviewed, last_verdict: 'Comment only',
        risk_class: 'low', review_body: body, remediation_pending: 0 },
      dispatchJob: {},
      candidate: { headSha: head, prState: 'open', isDraft: false, riskClass: 'low', prAuthor: 'synthetic-worker',
        title: 'Synthetic repair', body: '', baseBranch: 'main', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN',
        statusCheckRollup: [{ __typename: 'CheckRun', name: 'synthetic-ci', status: 'COMPLETED', conclusion: 'FAILURE' }],
        branchProtection: { requiredContexts: [] } },
      labelNames: [],
      loadConfigImpl: () => ({ getOrchestrationMode: () => 'native',
        getMergeAuthorityConfig: () => ({ enabled: true, workerClass: 'hammer', strictMode: true,
          autonomousMergeExecutionEnabled: true, branchProtection: { required: false }, eligibility: { riskClasses: ['low'] } }) }),
      resolveReviewCycleExhaustionImpl: () => ({ reviewCycleExhausted: true }),
      resolveAmaHammerDispatchModeImpl: () => 'inline',
      fetchLatestHeadReviewBodiesImpl: async (_repo, _pr, sha) => sha === reviewed ? [body] : [],
      liveReviewRetryDelaysMs: [],
      proveCloserAuthoredStaleHeadImpl: async () => ({ proven: false }),
      resolveHeadCloserCommitSuppressionImpl: async () => ({ suppressed: false }),
      fetchHeadCloserVerifiedCommitImpl: async () => null,
      fetchMergedProtectiveDependentsImpl: async () => [],
      fetchProtectivePredecessorStateImpl: async () => null,
      probeClosureOwnershipImpl: async () => ({ owned: false, uncertain: false }),
      observeClosureWaitImpl: async () => ({}),
      runDaemonCleanMergeAttemptImpl: async () => ({ disposition: 'not-taken', reason: 'not-eligible' }),
      requestEligibleHammerWakeImpl: payload => { effects.push(['wake', payload.headSha ?? null]); return { outcome: 'skipped' }; },
      maybeDispatchAmaCloserImpl: async payload => {
        effects.push(['closer', payload.dispatchContext?.dispatchReason ?? null]);
        return { dispatched: false, skipMergeAgent: true, reason: 'synthetic-probe' };
      },
    });
    return { result, effects, pass };
  };
  const plain = await runOnce();
  setNextActionShadowSinkForTesting(() => { throw new Error('synthetic sink failure'); });
  const failing = await runOnce();
  await settleNextActionShadowsForTesting();
  assert.equal(JSON.stringify(failing.result), JSON.stringify(plain.result));
  assert.deepEqual(failing.effects, plain.effects);
  const records = [];
  setNextActionShadowSinkForTesting(r => records.push(r));
  const recorded = await runOnce();
  await settleNextActionShadowsForTesting();
  assert.equal(JSON.stringify(recorded.result), JSON.stringify(plain.result));
  assert.deepEqual(recorded.effects, plain.effects);
  assert.ok(plain.result.closureOwner, JSON.stringify(plain.result));
  // The orchestration registered its enriched decision for this pass.
  const shared = await shadowNextAction({ source: 'posted-review', passSnapshot: recorded.pass, env, now: () => Date.parse(ANCHOR) });
  assert.equal(shared.decision.passId, null);
  assert.equal(shared.decision.head, HEAD);
  assert.notEqual(shared.decision.reason, 'pr-unknown', 'the enriched decision, not the bare pass, reached posted-review');
  for (const record of records) assert.equal(record.subjectKey, `${repo}#${prNumber}`);
  const disagreement = records.find(r => r.kind === 'disagreement' && r.source === 'closure-orchestration');
  assert.deepEqual([shared.decision.action, shared.decision.actor, shared.decision.reason], ['hammer', 'hammer', 'ci-red-final']);
  if (parked) {
    // Legacy pages a red, exhausted, exact-head review; the table names the final hammer.
    assert.deepEqual(plain.result.closureOwner, { owner: 'page', reason: 'review-rounds-exhausted' });
    assert.deepEqual([disagreement.legacy.action, disagreement.legacy.reason], ['operator-hold', 'review-findings-final']);
    assert.deepEqual(disagreement.fields, ['action', 'actor', 'reason']);
  } else {
    assert.deepEqual(plain.result.closureOwner, { owner: 'hammer', reason: 'ci-blocked-remediation-exhausted' });
    assert.equal(disagreement, undefined, 'agreement is not logged');
  }
});

test('the consumer seam imports nothing and copies evidence before the caller resumes', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../src/pr-next-action-consumer.mjs', import.meta.url), 'utf8');
  assert.equal(/^import /m.test(source), false, 'short-lived consumers must not load the policy module eagerly');
  const records = [];
  setNextActionShadowSinkForTesting(r => records.push(r));
  const lease = { status: 'dispatched', headSha: HEAD, updatedAt: ANCHOR };
  const pending = shadowNextActionLater({ source: 'synthetic-copy', legacy: () => ({ owner: 'daemon-merge' }), env,
    now: () => Date.parse(ANCHOR), evidence: () => ({ subjectKey: 'subject-copy', head: HEAD, observedAt: ANCHOR,
      observations: { pr: { headSha: HEAD, state: 'OPEN', mergeable: 'MERGEABLE' }, leases: { closer: lease },
        launches: { closer: null } } }) });
  lease.status = 'terminal';
  const outcome = await pending;
  assert.equal(outcome.decision.reason, 'live-owner', 'the decision used the evidence as it was at the call');
  assert.equal(records[0].source, 'synthetic-copy');
  assert.equal(await shadowNextActionLater({ source: 'x', env, legacy: () => { throw new Error('synthetic'); } }), null);
  setNextActionShadowSinkForTesting(null);
  assert.equal(await shadowNextActionLater({ source: 'x', env, evidence: () => { throw new Error('unreached'); } }), null,
    'inert under the offline runner without a sink');
});

test('nextAction is the shadow decision: no second policy', () => {
  const snapshot = base();
  assert.deepEqual(nextAction(snapshot), nextAction(snapshot));
});
