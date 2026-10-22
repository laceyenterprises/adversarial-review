import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNoProgressLaneGate, handlePostedReviewRow, runQueuedReviewAdoptionPhase } from '../src/posted-review-row.mjs';

const headSha = 'a'.repeat(40);
const handler = { repoPath: 'example/project', prNumber: 42, headSha };
const logger = { log() {}, warn() {}, error() {} };
const finalGate = { operatorDecisionRequired: true, reason: 'remediation-stopped' };
const pending = { outcome: 'ama-pending', hammerRouteActive: true, gateDecision: finalGate,
  amaClosureResult: { reason: 'ama-closer-dispatch-backgrounded', skipMergeAgent: true } };

function fixture() {
  const rootDir = mkdtempSync(join(tmpdir(), 'hamlane-'));
  const gate = createNoProgressLaneGate({ rootDir, hqRoot: rootDir, logger,
    readReviewRow: () => ({ review_status: 'posted', reviewer_head_sha: headSha,
      posted_at: '2026-10-16T12:00:00Z' }), deliverAlertFn: async () => {} });
  return { rootDir, gate };
}

test('HAMLANE-01 final NOT CONVERGED with retained hammer route walks every next tick', async () => {
  const { rootDir, gate } = fixture();
  try {
    for (let tick = 0; tick < 12; tick++) {
      const outcome = await gate.record(handler, { value: pending });
      assert.equal(outcome.lane, 'active');
      assert.equal(gate.evaluate(handler).run, true);
    }
  } finally { rmSync(rootDir, { recursive: true, force: true }); }
});

test('HAMLANE-01 a real operator hold replaces hammer urgency and keeps its cadence', async () => {
  const { rootDir, gate } = fixture();
  try {
    await gate.record(handler, { value: pending });
    assert.equal(gate.evaluate(handler).run, true);
    for (const operatorReason of ['hammer-stop-awaiting-input-change',
      'hammer-lifetime-dispatch-ceiling', 'pr-is-draft', 'hard-stop-label']) {
      const outcome = await gate.record(handler, { value: { outcome: 'await-operator', hammerRouteActive: true,
        gateDecision: finalGate, amaClosureResult: { needsOperator: true, operatorReason } } });
      assert.equal(outcome.lane, 'operator-blocked');
      for (let tick = 0; tick < 3; tick++) assert.equal(gate.evaluate(handler).run, false);
      assert.equal(gate.evaluate(handler).run, true);
    }
  } finally { rmSync(rootDir, { recursive: true, force: true }); }
});

// Two queues model process lifetimes; unresolved work in the first is lost on restart.
// The durable closer fixture stands in for its normal lease and launch dedup.
import * as background from '../src/ama-hammer-background-dispatch.mjs';
import { readNoProgressLane, recordNoProgressLaneRun } from '../src/watcher-no-progress-lane.mjs';
import { maybeDispatchAmaCloser, updateAmaCloserDispatchRecord } from '../src/ama/dispatch-closer.mjs';
import { acquireAmaCloserLease, updateAmaCloserLease } from '../src/ama/closer-lease.mjs';

test('pending dispatch recovery accepts numeric and string PR identities while preserving head binding', async () => {
  const { rootDir } = fixture();
  const queue = background.createAmaHammerBackgroundQueue();
  let release;
  try {
    for (const prNumber of [42, '42']) {
      const identity = { repo: handler.repoPath, prNumber, headSha };
      queue.submit({ key: background.amaHammerBackgroundKey(identity), pendingDispatch: { rootDir, ...identity },
        run: () => new Promise(resolve => { release = resolve; }) });
      for (const lookupNumber of [42, '42']) {
        assert.ok(background.readPendingAmaHammerDispatch(rootDir, { ...identity, prNumber: lookupNumber }));
        assert.equal(background.readPendingAmaHammerDispatch(rootDir,
          { ...identity, prNumber: lookupNumber, headSha: 'b'.repeat(40) }), null);
      }
      release({ dispatched: false });
      await queue.drain();
    }
  } finally {
    release?.({ dispatched: false });
    await queue.drain();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('queued abort logs an unlink failure and allows the replacement head to run', {
  skip: process.platform === 'win32' || process.getuid?.() === 0,
}, async () => {
  const { rootDir } = fixture();
  const warnings = [];
  const queue = background.createAmaHammerBackgroundQueue({ maxConcurrent: 1,
    logger: { warn: message => warnings.push(message) } });
  const identity = { repo: handler.repoPath, prNumber: 42, headSha };
  let release;
  let replacementRan = false;
  const intentDir = join(rootDir, 'data', 'ama-hammer-background');
  try {
    queue.submit({ key: 'other/repo#1@busy', run: () => new Promise(resolve => { release = resolve; }) });
    queue.submit({ key: background.amaHammerBackgroundKey(identity), pendingDispatch: { rootDir, ...identity },
      run: async () => assert.fail('cancelled queued head must not run') });
    chmodSync(intentDir, 0o500);
    assert.equal(queue.abort(background.amaHammerBackgroundKey(identity)), true);
    assert.match(warnings[0], /pending hammer dispatch cleanup failed/);
    assert.equal(queue.snapshot().waiting, 0);
    chmodSync(intentDir, 0o700);
    const replacement = { ...identity, headSha: 'b'.repeat(40) };
    queue.submit({ key: background.amaHammerBackgroundKey(replacement), pendingDispatch: { rootDir, ...replacement },
      run: async () => { replacementRan = true; } });
    release({ dispatched: false });
    await queue.drain();
    assert.equal(replacementRan, true);
    assert.equal(background.readPendingAmaHammerDispatch(rootDir, replacement), null);
  } finally {
    chmodSync(intentDir, 0o700);
    release?.({ dispatched: false });
    await queue.drain();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

function closerFixture(rootDir, onLaunch) {
  const requiredGate = 'fixture/adversarial-gate';
  return {
    reviewState: { verdict: 'request changes', headSha, riskClass: 'low', remediationPending: false,
      reviewCycleExhausted: true, blockingFindingState: 'known', blockingFindingCount: 1,
      nonBlockingFindingState: 'known', nonBlockingFindingCount: 0, prAuthor: 'fixture-builder' },
    prMetadata: { prNumber: handler.prNumber, headSha, isOpen: true, isDraft: false,
      mergeableState: 'MERGEABLE', labels: [], author: 'fixture-builder',
      statusCheckRollup: [{ __typename: 'CheckRun', name: requiredGate, conclusion: 'SUCCESS' }],
      branchProtection: { requiredContexts: [requiredGate] } },
    cfg: { enabled: true, workerClass: 'hammer', mergeMethod: 'squash',
      eligibility: { riskClasses: ['low'], highRiskRequiresTwoKey: false }, branchProtection: { required: true } },
    options: { env: { ADV_GATE_STATUS_CONTEXT: requiredGate } },
    dispatchContext: { rootDir, repo: handler.repoPath, prUrl: 'https://github.com/example/project/pull/42',
      riskClass: 'low', reviewedSha: headSha, requiredGateContext: requiredGate, reviewedBy: 'fixture-reviewer', reviewer: 'codex',
      parentSession: 'session:fixture:watcher', hqPath: join(rootDir, 'hq-fixture'), hqRoot: join(rootDir, 'hq'),
      hqOwnerUser: 'fixture-owner', currentUser: 'fixture-owner', dispatchedAt: '2026-10-16T12:01:00Z',
      livePrProbeImpl: async () => ({ state: 'OPEN', headBranchExists: true, headRefName: 'fixture/work' }) },
    readPullRequestStateImpl: () => null,
    execFileImpl: async (_cmd, args) => { if (args.includes('--worker-class')) onLaunch(); return { stdout: JSON.stringify({ dispatchId: 'lrq_fixture', launchRequestId: 'lrq_fixture' }), stderr: '' }; },
    readTemplateImpl: () => 'fixture hammer prompt', writeFileImpl: () => {},
    readLaunchRequestStatusImpl: () => ({ ok: true, row: { status: 'running' } }),
    resolveCloserDispatchHarnessImpl: async ({ workerClass }) => ({ workerClass, fellBack: false }),
    readBuildCompletionSignalForPrImpl: () => ({ ok: false, reason: 'missing-build-completion-signal' }),
    readBuildCompletionProducerEvidenceImpl: () => ({ ok: false, reason: 'missing-build-completion-producer-evidence' }),
    processKillImpl: () => { throw Object.assign(new Error('fixture process exited'), { code: 'ESRCH' }); },
    logger,
  };
}


for (const launchedBeforeRestart of [false, true]) {
  test(`HAMLANE-01 startup reconciles interrupted background dispatch once without relaunching unknown intents; already launched=${launchedBeforeRestart}`, async () => {
    const { rootDir, gate } = fixture();
    const key = background.amaHammerBackgroundKey({ repo: handler.repoPath,
      prNumber: handler.prNumber, headSha });
    const pendingDispatch = { rootDir, repo: handler.repoPath, prNumber: handler.prNumber, headSha };
    let release;
    const first = background.createAmaHammerBackgroundQueue();
    const second = background.createAmaHammerBackgroundQueue();
    let launches = launchedBeforeRestart ? 1 : 0;
    let attempts = 0;
    const identity = { repo: handler.repoPath, prNumber: handler.prNumber, headSha };
    try {
      updateAmaCloserDispatchRecord(rootDir, identity, () => ({ ...identity,
        state: launchedBeforeRestart ? 'dispatched' : 'dispatching',
        lastAttemptedAt: '2026-10-16T12:00:00Z',
        launchRequestId: launchedBeforeRestart ? 'lrq_existing' : null,
        dispatchId: launchedBeforeRestart ? 'lrq_existing' : null,
        lastObservedStatus: launchedBeforeRestart ? 'running' : null, lastError: null }));
      acquireAmaCloserLease({ rootDir, ...identity, watcherPid: 424242, now: '2026-10-16T12:00:00Z' });
      if (launchedBeforeRestart) updateAmaCloserLease({ rootDir, ...identity,
        status: 'dispatched', lrqId: 'lrq_existing', now: '2026-10-16T12:00:00Z' });
      first.submit({ key, pendingDispatch, run: () => new Promise(resolve => { release = resolve; }) });
      // Reproduce a restart before the old handler recorded its active lane.
      recordNoProgressLaneRun(rootDir, { repo: handler.repoPath, prNumber: handler.prNumber }, {
        headSha, fingerprint: 'final-review', progressClass: 'operator-decision-required', logger });
      assert.equal(gate.evaluate(handler).run, true, 'pending intent must beat the old operator backoff on the first tick');
      const dispatch = () => second.submit({ key, pendingDispatch, run: async () => {
        attempts++;
        return maybeDispatchAmaCloser(closerFixture(rootDir, () => { launches++; }));
      } });
      dispatch();
      dispatch();
      await second.drain();
      assert.equal(attempts, 1);
      const settled = second.takeSettled(key);
      assert.equal(launches, launchedBeforeRestart ? 1 : 0, JSON.stringify(settled) + (settled?.error?.message || ''));
      assert.equal(settled.ok, true);
      assert.equal(settled.result.dispatched, false);
      if (!launchedBeforeRestart) assert.equal(settled.result.reason, 'existing-dispatch-unknown');
      assert.equal(background.readPendingAmaHammerDispatch(rootDir, pendingDispatch), null);
    } finally {
      release?.({ dispatched: false });
      await first.drain();
      await second.drain();
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
}

test('HAMLANE-01 the posted-review handler exposes hammer ownership despite the final gate operator flag', async () => {
  const { rootDir, gate } = fixture();
  const row = { review_status: 'posted', pr_state: 'open', reviewer_head_sha: headSha };
  try {
    for (const { needsOperator, stopped } of [{ needsOperator: false }, { stopped: true }, { needsOperator: true }]) {
      const value = await handlePostedReviewRow({ rootDir, repoPath: handler.repoPath,
        prNumber: handler.prNumber, existing: row, currentRevisionRef: headSha, labelNames: [], logger,
        projectGateStatusSafe: async () => ({ decision: finalGate }),
        fetchMergeAgentCandidateImpl: async () => ({ merged: false, prState: 'open' }),
        buildMergeAgentDispatchJobImpl: () => ({}),
        latestFollowUpJobFinder: () => null, latestPostedReviewBodyFinder: () => null,
        reviewBodyHasScopeViolationFindingImpl: () => false, currentReviewRowReader: () => row,
        resolveMergeAgentCoexistenceForWatcherImpl: async () => ({
          outcome: needsOperator ? 'await-operator' : 'ama-pending',
          amaClosureResult: { reason: needsOperator || stopped ? 'hammer-stop-awaiting-input-change' : 'ama-closer-dispatch-backgrounded',
            needsOperator, skipMergeAgent: true } }),
      });
      assert.equal(value.hammerRouteActive === true, !needsOperator && !stopped);
      await gate.record(handler, { value });
      assert.equal(gate.evaluate(handler).run, !needsOperator && !stopped);
    }
  } finally { rmSync(rootDir, { recursive: true, force: true }); }
});

async function handleClosureResult(rootDir, amaClosureResult, outcome = 'ama-pending', {
  gateDecision = finalGate, candidate = { merged: false, prState: 'open' },
} = {}) {
  const row = { review_status: 'posted', pr_state: 'open', reviewer_head_sha: headSha };
  return handlePostedReviewRow({ rootDir, repoPath: handler.repoPath,
    prNumber: handler.prNumber, existing: row, currentRevisionRef: headSha, labelNames: [], logger,
    projectGateStatusSafe: async () => ({ decision: gateDecision }),
    fetchMergeAgentCandidateImpl: async () => candidate,
    buildMergeAgentDispatchJobImpl: () => ({}),
    latestFollowUpJobFinder: () => null, latestPostedReviewBodyFinder: () => null,
    reviewBodyHasScopeViolationFindingImpl: () => false, currentReviewRowReader: () => row,
    resolveMergeAgentCoexistenceForWatcherImpl: async () => ({ outcome, amaClosureResult }),
  });
}

for (const terminalReason of ['closed', 'merged']) {
  for (const operatorSkip of [false, true]) {
    test(`HAMLANE-01 ${terminalReason} PR retires superseded-head intent; operator skip=${operatorSkip}`, async () => {
      const { rootDir } = fixture();
      const queue = background.createAmaHammerBackgroundQueue({ maxConcurrent: 1 });
      const stale = { repo: handler.repoPath, prNumber: handler.prNumber, headSha: 'b'.repeat(40) };
      const other = { ...stale, prNumber: handler.prNumber + 1 };
      let release;
      try {
        // Hold the only slot so both persisted intents model abandoned queued work.
        queue.submit({ key: 'fixture-blocker', run: () => new Promise(resolve => { release = resolve; }) });
        for (const identity of [stale, other]) {
          queue.submit({ key: background.amaHammerBackgroundKey(identity),
            pendingDispatch: { rootDir, ...identity }, run: async () => ({}) });
        }
        assert.ok(background.readPendingAmaHammerDispatch(rootDir, stale));
        const value = await handleClosureResult(rootDir, {}, 'pr-terminal', {
          gateDecision: operatorSkip ? { reason: 'operator-skip-label' } : finalGate,
          candidate: { merged: terminalReason === 'merged', prState: terminalReason },
        });
        assert.equal(value.prTerminal, true);
        assert.equal(background.readPendingAmaHammerDispatch(rootDir, stale), null);
        assert.ok(background.readPendingAmaHammerDispatch(rootDir, other), 'other PR intent is preserved');
        // Terminal cleanup is also harmless when the intent has already gone.
        await handleClosureResult(rootDir, {}, 'pr-terminal');
      } finally {
        release?.({});
        await queue.drain();
        rmSync(rootDir, { recursive: true, force: true });
      }
    });
  }
}

test('HAMLANE-01 an old queue callback preserves a replacement intent at the same head', async () => {
  const { rootDir } = fixture();
  const oldQueue = background.createAmaHammerBackgroundQueue();
  const newQueue = background.createAmaHammerBackgroundQueue();
  const identity = { repo: handler.repoPath, prNumber: handler.prNumber, headSha };
  const key = background.amaHammerBackgroundKey(identity);
  let releaseOld, releaseNew;
  try {
    oldQueue.submit({ key, pendingDispatch: { rootDir, ...identity },
      run: () => new Promise(resolve => { releaseOld = resolve; }) });
    const oldIntent = background.readPendingAmaHammerDispatch(rootDir, identity);
    newQueue.submit({ key, pendingDispatch: { rootDir, ...identity },
      run: () => new Promise(resolve => { releaseNew = resolve; }) });
    const replacement = background.readPendingAmaHammerDispatch(rootDir, identity);
    assert.notEqual(replacement.attemptId, oldIntent.attemptId);
    releaseOld({});
    await oldQueue.drain();
    assert.deepEqual(background.readPendingAmaHammerDispatch(rootDir, identity), replacement);
    background.clearPendingAmaHammerDispatch(rootDir, identity);
    assert.equal(background.readPendingAmaHammerDispatch(rootDir, identity), null);
  } finally {
    releaseOld?.({});
    releaseNew?.({});
    await Promise.all([oldQueue.drain(), newQueue.drain()]);
    rmSync(rootDir, { recursive: true, force: true });
  }
});

for (const amaClosureResult of [
  ...['hammer-lifetime-dispatch-ceiling', 'hammer-retry-cap-exceeded', 'pr-is-draft', 'hard-stop-label']
    .map(reason => ({ reason, needsOperator: true })),
  { reason: 'background-pr-draft', needsOperator: true, operatorReason: 'pr-is-draft' },
  { reason: 'not-eligible', reasons: ['two-key-required'] },
  { reason: 'pr-is-draft' },
  { needsOperator: true },
]) {
  test(`HAMLANE-01 pending hold preserves context and retires restart intent: ${JSON.stringify(amaClosureResult)}`, async () => {
    const { rootDir, gate } = fixture();
    const queue = background.createAmaHammerBackgroundQueue();
    const identity = { repo: handler.repoPath, prNumber: handler.prNumber, headSha };
    let release;
    try {
      queue.submit({ key: background.amaHammerBackgroundKey(identity), pendingDispatch: { rootDir, ...identity },
        run: () => new Promise(resolve => { release = resolve; }) });
      await gate.record(handler, { value: pending });
      const value = await handleClosureResult(rootDir, amaClosureResult);
      const reason = amaClosureResult.operatorReason || amaClosureResult.reason || 'ama-operator-hold';
      assert.equal(value.operatorHoldReason, reason);
      assert.deepEqual(value.amaClosureResult, amaClosureResult);
      assert.notEqual(value.hammerRouteActive, true);
      const recorded = await gate.record(handler, { value });
      assert.equal(recorded.lane, 'operator-blocked');
      assert.equal(readNoProgressLane(rootDir, identity).operatorReason, reason);
      assert.equal(background.readPendingAmaHammerDispatch(rootDir, identity), null);
      for (let tick = 0; tick < 3; tick++) assert.equal(gate.evaluate(handler).run, false);
      assert.equal(gate.evaluate(handler).run, true);
    } finally {
      release?.({ dispatched: false });
      await queue.drain();
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
}

for (const outcome of ['ama-pending', 'ama-dispatched']) {
  test(`HAMLANE-01 reconciliation retires restart intent without a new submission: ${outcome}`, async () => {
    const { rootDir, gate } = fixture();
    const oldQueue = background.createAmaHammerBackgroundQueue();
    const identity = { repo: handler.repoPath, prNumber: handler.prNumber, headSha };
    let release;
    try {
      oldQueue.submit({ key: background.amaHammerBackgroundKey(identity), pendingDispatch: { rootDir, ...identity },
        run: () => new Promise(resolve => { release = resolve; }) });
      recordNoProgressLaneRun(rootDir, identity, { headSha,
        progressClass: 'operator-decision-required', fingerprint: 'old-final-gate', logger });
      assert.equal(gate.evaluate(handler).reason, 'hammer-dispatch-recovery');
      const value = await handleClosureResult(rootDir, outcome === 'ama-pending'
        ? { reason: 'ama-closer-launch-in-progress', skipMergeAgent: true, launchRequestId: 'lrq_existing' }
        : { dispatched: true, dispatchId: 'lrq_existing', workerClass: 'hammer' }, outcome);
      assert.equal(background.readPendingAmaHammerDispatch(rootDir, identity), null);
      await gate.record(handler, { value });
      assert.equal(gate.evaluate(handler).reason, 'hammer-route-active');
      // Clearing a recovered intent must remain head-bound.
      oldQueue.submit({ key: background.amaHammerBackgroundKey({ ...identity, headSha: 'b'.repeat(40) }),
        pendingDispatch: { rootDir, ...identity, headSha: 'b'.repeat(40) }, run: async () => ({ dispatched: false }) });
      await handleClosureResult(rootDir, { reason: 'ama-closer-launch-in-progress' });
      assert.ok(background.readPendingAmaHammerDispatch(rootDir, { ...identity, headSha: 'b'.repeat(40) }));
    } finally {
      release?.({ dispatched: false });
      await oldQueue.drain();
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
}

test('HAMLANE-01 intent is saved before running, head-bound, and removed even when settle logging throws', async () => {
  const { rootDir, gate } = fixture();
  const queue = background.createAmaHammerBackgroundQueue();
  const identity = { repo: handler.repoPath, prNumber: handler.prNumber, headSha };
  const key = background.amaHammerBackgroundKey(identity);
  try {
    queue.submit({ key, pendingDispatch: { rootDir, ...identity }, run: async () => {
      const intent = background.readPendingAmaHammerDispatch(rootDir, identity);
      assert.equal(intent.headSha, headSha);
      assert.ok(Number.isFinite(Date.parse(intent.startedAt)));
      recordNoProgressLaneRun(rootDir, identity, { headSha: 'b'.repeat(40),
        progressClass: 'operator-decision-required', logger });
      assert.equal(gate.evaluate({ ...handler, headSha: 'b'.repeat(40) }).run, false,
        'old-head intent cannot accelerate a new head');
      return { dispatched: true };
    }, onSettled: () => { throw new Error('fixture logger unavailable'); } });
    await queue.drain();
    assert.equal(queue.takeSettled(key).result.dispatched, true);
    assert.equal(background.readPendingAmaHammerDispatch(rootDir, identity), null);
  } finally {
    await queue.drain();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

import { maybeDispatchAmaClosureFor } from '../src/ama-closure-orchestration.mjs';

for (const mode of ['inline', 'background']) {
  test(`HAMLANE-01 ${mode} logs final posted review to confirmed hammer launch latency`, async () => {
    const { rootDir } = fixture();
    const queue = background.createAmaHammerBackgroundQueue();
    const events = [];
    const reviewBody = '## Summary\nA fixture issue remains.\n\n## Verdict\nRequest changes\n\n## Blocking Issues\n\n- Repair the fixture.\n\n## Non-blocking Issues\n\n- None.';
    const postedAt = '2026-10-16T12:00:00Z';
    let clockMs = Date.parse(postedAt) + 5 * 60_000;
    try {
      const args = { rootDir, repoPath: handler.repoPath, prNumber: handler.prNumber,
        currentRevisionRef: headSha, labelNames: [], dispatchJob: { remediationStopCode: 'max-rounds-reached' },
        reviewStateRow: { repo: handler.repoPath, pr_number: handler.prNumber, pr_state: 'open',
          review_status: 'posted', last_verdict: 'Request changes', risk_class: 'low', remediation_pending: 0,
          reviewer: 'codex', reviewer_login: 'fixture-reviewer', reviewer_head_sha: headSha,
          review_body: reviewBody, posted_at: postedAt },
        candidate: { headSha, riskClass: 'low', prAuthor: 'fixture-builder', prState: 'open',
          mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', isDraft: false,
          statusCheckRollup: [{ __typename: 'CheckRun', name: 'test', conclusion: 'SUCCESS' }],
          branchProtection: { requiredContexts: ['fixture/adversarial-gate', 'ci/test'] } },
        logger: { ...logger, log: text => { try { events.push(JSON.parse(text)); } catch {} } },
        loadConfigImpl: () => ({ getMergeAuthorityConfig: () => ({ enabled: true }) }),
        resolveAmaHammerDispatchModeImpl: () => mode, amaHammerBackgroundQueueImpl: () => queue,
        fetchCurrentPrStateImpl: async () => ({ state: 'OPEN', headSha, isDraft: false, mergeable: 'MERGEABLE' }),
        fetchLatestHeadReviewBodiesImpl: async () => [reviewBody],
        resolveReviewCycleExhaustionImpl: () => ({ reviewCycleExhausted: true }),
        maybeDispatchAmaCloserImpl: async () => {
          clockMs += 2 * 60_000;
          return { dispatched: true, launchRequestId: 'lrq_fixture' };
        }, now: () => clockMs,
      };
      await maybeDispatchAmaClosureFor(args);
      await queue.drain();
      if (mode === 'background') await maybeDispatchAmaClosureFor(args);
      const latency = events.filter(event => event.event === 'ama.final_review_to_hammer_launch');
      assert.equal(latency.length, 1, 'settled outcome consumption must not log a second launch');
      assert.equal(latency[0].latencyMs, 7 * 60_000, 'include dispatch time as well as lane/queue wait');
      assert.equal(latency[0].postedAt, postedAt);
      assert.equal(latency[0].headSha, headSha);
      assert.equal(latency[0].launchRequestId, 'lrq_fixture');
    } finally {
      await queue.drain();
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
}

test('HAMLANE-01 first adoption after restart prioritizes pending intent through the normal handler', async () => {
  const { rootDir, gate } = fixture();
  const queue = background.createAmaHammerBackgroundQueue();
  const identity = { repo: handler.repoPath, prNumber: handler.prNumber, headSha };
  let release;
  const order = [];
  const messages = [];
  const noop = async () => ({ attempted: 0, checked: 0 });
  try {
    queue.submit({ key: background.amaHammerBackgroundKey(identity),
      pendingDispatch: { rootDir, ...identity }, run: () => new Promise(resolve => { release = resolve; }) });
    recordNoProgressLaneRun(rootDir, identity, { headSha,
      progressClass: 'operator-decision-required', fingerprint: 'old-final-gate', logger });
    const phaseArgs = { rootDir, recoveryRoots: new Set(), logger: { ...logger, log: message => messages.push(message) },
      noProgressLaneGate: gate,
      postedReviewPriorityTargets: null,
      postedReviewHandlers: [
        { repoPath: handler.repoPath, prNumber: 43, headSha, run: async () => { order.push('ordinary'); } },
        { ...handler, run: async () => { order.push('recovered'); return pending; } },
      ],
      drainReviewerDispatchCandidates: async () => ({ dispatched: 0, deferred: 0 }),
      retryPendingMergeAgentLifecycleCleanupsImpl: noop, syncPRLifecycleImpl: noop,
      retryPendingCloserCancelsImpl: noop, retryPendingDagAutowalkOnMergeImpl: noop,
      retryPendingTriageSyncsImpl: noop, retryPendingMergeCloseoutsImpl: noop,
      retryPendingRetriggerAckCommentsImpl: noop, reportStalledRetriggerOutcomesImpl: noop,
      retryPendingRetriggerReviewAckCommentsImpl: noop,
      sweepRereviewWakeQueueImpl: () => ({ scanned: 0 }), rereviewWakeBacklogImpl: () => ({ pending: 0 }),
    };
    await runQueuedReviewAdoptionPhase(phaseArgs);
    assert.deepEqual(order, ['recovered', 'ordinary']);
    assert.equal(messages.filter(message => message.includes('recovering pending AMA hammer dispatch')).length, 1);
    await runQueuedReviewAdoptionPhase({ ...phaseArgs,
      runPostedReviewHandlersFairlyImpl: async ({ priorityTargets }) => assert.deepEqual(priorityTargets, []),
    });
    assert.equal(messages.filter(message => message.includes('recovering pending AMA hammer dispatch')).length, 1,
      'later adoption phases must not report ordinary in-flight work as restart recovery');
    await runQueuedReviewAdoptionPhase({ ...phaseArgs, recoveryRoots: new Set(),
      runPostedReviewHandlersFairlyImpl: async ({ priorityTargets }) => {
        assert.equal(priorityTargets.length, 1);
        assert.equal(priorityTargets[0].prNumber, handler.prNumber);
      },
    });
    assert.equal(messages.filter(message => message.includes('recovering pending AMA hammer dispatch')).length, 2,
      'a separate process lifetime can recover the same root in one test process');
  } finally {
    release?.({ dispatched: false });
    await queue.drain();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('HAMLANE-01 an explicit stop settles stale restart intent and preserves operator backoff', async () => {
  const { rootDir, gate } = fixture();
  const queue = background.createAmaHammerBackgroundQueue();
  const identity = { repo: handler.repoPath, prNumber: handler.prNumber, headSha };
  let release;
  try {
    queue.submit({ key: background.amaHammerBackgroundKey(identity), pendingDispatch: { rootDir, ...identity },
      run: () => new Promise(resolve => { release = resolve; }) });
    assert.ok(background.readPendingAmaHammerDispatch(rootDir, identity));
    await gate.record(handler, { value: { outcome: 'ama-pending', gateDecision: finalGate,
      operatorHoldReason: 'hammer-stop-awaiting-input-change' } });
    assert.equal(background.readPendingAmaHammerDispatch(rootDir, identity), null);
    for (let tick = 0; tick < 3; tick++) assert.equal(gate.evaluate(handler).run, false);
    assert.equal(gate.evaluate(handler).run, true);
  } finally {
    release?.({ dispatched: false });
    await queue.drain();
    rmSync(rootDir, { recursive: true, force: true });
  }
});
