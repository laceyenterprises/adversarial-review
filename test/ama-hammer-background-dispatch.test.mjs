import { seedCloserIntent, intentStarted, intentExpired, intentEarly } from './helpers/closer-intent-fixture.mjs';
import { matrixPair } from './helpers/next-action-matrix.mjs';
import { deriveNextActionSnapshot, nextAction } from '../src/pr-next-action.mjs';
import { bindClosureNextAction, readClosureNextAction, reviseClosureNextAction } from '../src/ama/closure-next-action.mjs';
import './helpers/load-aware-timeout-fixture.mjs';
import { proveCloserAuthoredStaleHead } from '../src/closer-authored-stale.mjs';
import test from 'node:test';
import { AMA_CLOSER_UNKNOWN_LAUNCH_RECLAIM_AGE_MS, acquireAmaCloserLease, isHeldAmaCloserLease, readAmaCloserLease, updateAmaCloserLease } from '../src/ama/closer-lease.mjs';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  AMA_HAMMER_BACKGROUND_REASON,
  amaHammerBackgroundProgress,
  isAmaCloserLaunching,
  DEFAULT_AMA_HAMMER_BACKGROUND_BOUND_MS,
  amaHammerBackgroundQueue,
  amaHammerBackgroundKey,
  createAmaHammerBackgroundQueue,
  resetAmaHammerBackgroundQueueForTests,
  resolveAmaHammerDispatchMode,
} from '../src/ama-hammer-background-dispatch.mjs';
import { maybeDispatchAmaClosureFor, resolveMergeAgentCoexistenceForWatcher } from '../src/ama-closure-orchestration.mjs';
import { maybeDispatchAmaCloser } from '../src/ama/dispatch-closer.mjs';
import { recoverStrandedCloserHead } from '../src/ama/closer-head-recovery.mjs';
import { hammerWakeAuditPath, readHammerWakeAudit, requestEligibleHammerWake } from '../src/hammer-wake.mjs';
import { closerAuthoredStaleAuditPath } from '../src/closer-authored-stale.mjs';
import { observeClosureRefreshLoop, CLOSURE_REFRESH_CYCLE_LIMIT } from '../src/ama/closure-refresh-loop.mjs';
import { observeClosureWait } from '../src/ama/closure-wait.mjs';

function cfgReturning(value) {
  return { get: (key, fallback) => (value === undefined ? fallback : value) };
}

test('CLOSERREFRESHLOOP-01: unchanged background refresh settlements page with the stored decline', async t => {
  const queue = createAmaHammerBackgroundQueue();
  const pages = [];
  const events = [];
  let dispatches = 0;
  const args = closureArgs({
    logger: { log() {}, warn(message) { assert.fail(message); }, info(message) { events.push(JSON.parse(message)); } },
    resolveAmaHammerDispatchModeImpl: () => 'background', amaHammerBackgroundQueueImpl: () => queue,
    observeClosureWaitImpl: options => observeClosureWait({ ...options,
      pageImpl: async (message, metadata) => pages.push({ message, metadata }) }),
    maybeDispatchAmaCloserImpl: async payload => {
      dispatches++;
      const shared = reviseClosureNextAction(payload.sharedNextAction, { progress: {
        daemonExecution: { headSha: HEAD, reason: 'synthetic-terminal-decline' },
      } });
      return { dispatched: false, reason: 'snapshot-refresh', nextActionShared: shared };
    },
  });
  t.after(() => rmSync(args.rootDir, { recursive: true, force: true }));
  for (let cycle = 1; cycle <= CLOSURE_REFRESH_CYCLE_LIMIT + 1; cycle++) {
    const queued = await maybeDispatchAmaClosureFor(args);
    assert.equal(queued.reason, AMA_HAMMER_BACKGROUND_REASON);
    await queue.drain();
    const applied = await resolveMergeAgentCoexistenceForWatcher({ ...args,
      maybeDispatchAmaClosureForImpl: input => maybeDispatchAmaClosureFor({ ...args, ...input }),
      recoverOrphanImpl: () => assert.fail('snapshot refresh retains its observer'),
    });
    const settled = applied.amaClosureResult;
    assert.equal(settled.nextAction.reason, 'snapshot-refresh');
    if (cycle < CLOSURE_REFRESH_CYCLE_LIMIT) assert.equal(settled.closureBlocker, undefined);
    else {
      assert.match(settled.closureBlocker, /snapshot-refresh-no-progress: daemon:synthetic-terminal-decline/);
      assert.equal(settled.needsOperator, true);
      assert.equal(settled.boundedWait.exhausted, true);
    }
  }
  assert.equal(dispatches, CLOSURE_REFRESH_CYCLE_LIMIT + 1);
  assert.equal(pages.length, 1);
  assert.match(pages[0].message, /synthetic-terminal-decline/);
  assert.equal(pages[0].metadata.source, 'hamclose-closure-wait');
  assert.ok(events.some(event => event.event === 'ama.closure_blocker'
    && event.reason.includes('snapshot-refresh-no-progress: daemon:synthetic-terminal-decline')));
});

test('CLOSERREFRESHLOOP-01: refresh count survives reopen, resets on facts/head/progress, retries failed paging', async t => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'closure-refresh-loop-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  let shared;
  let pageAttempts = 0;
  const identity = { rootDir, repo: 'fixture/repo', prNumber: 17 };
  const observe = result => observeClosureRefreshLoop({ ...identity, shared, result,
    observeWaitImpl: options => observeClosureWait({ ...options, pageImpl: async () => {
      pageAttempts++;
      if (pageAttempts === 1) throw new Error('synthetic delivery refusal');
    } }) });
  const reset = (head = HEAD, labels = []) => {
    const snapshot = deriveNextActionSnapshot({ subjectKey: 'fixture/repo#17', head, observations: {
      pr: { state: 'OPEN', headSha: head, mergeable: 'MERGEABLE', labels },
      checks: { conclusion: 'SUCCESS' },
      reviews: { headSha: head, verdict: 'approved', blockingFindingState: 'known', blockingFindingCount: 0,
        nonBlockingFindingState: 'known', nonBlockingFindingCount: 0 },
      leases: { closer: null }, launches: { closer: null },
      policy: { autonomousMergeExecutionEnabled: true },
      progress: { daemonExecution: { headSha: head, reason: 'synthetic-terminal-decline' } },
    } });
    shared = { snapshot, decision: nextAction(snapshot) };
    assert.equal(shared.decision.reason, 'snapshot-refresh');
  };
  const refresh = { dispatched: false, reason: 'snapshot-refresh' };
  reset();
  await observe(refresh);
  reset(); // A fresh immutable pair and SQLite connection retain the counter.
  await observe(refresh);
  reset(HEAD, ['synthetic-progress']);
  assert.equal((await observe(refresh)).closureBlocker, undefined);
  await observe(refresh);
  reset('b'.repeat(40));
  assert.equal((await observe(refresh)).closureBlocker, undefined);
  await observe({ dispatched: true });
  for (let i = 1; i < CLOSURE_REFRESH_CYCLE_LIMIT; i++) {
    assert.equal((await observe(refresh)).closureBlocker, undefined);
    await observe({ backgroundDispatch: { state: 'started' } });
  }
  await assert.rejects(observe(refresh), /synthetic delivery refusal/);
  const paged = await observe(refresh);
  assert.equal(paged.needsOperator, true);
  await observe(refresh);
  assert.equal(pageAttempts, 2);
});

test('in-flight lookup exposes revalidated decisions without changing the submitted pair', async () => {
  const queue = createAmaHammerBackgroundQueue();
  const initial = Object.freeze({ decision: Object.freeze({ generation: 0 }) });
  const refreshed = Object.freeze({ decision: Object.freeze({ generation: 1 }) });
  let update, finish;
  queue.submit({ key: 'fixture/repo#1@head', sharedNextAction: initial,
    run: (_signal, updateShared) => { update = updateShared; return new Promise(resolve => { finish = resolve; }); } });
  assert.equal(queue.get('fixture/repo#1@head').nextAction, initial.decision);
  update(refreshed);
  assert.equal(queue.get('fixture/repo#1@head').nextAction, refreshed.decision);
  assert.equal(initial.decision.generation, 0);
  finish({ dispatched: true });
  await queue.drain();
});

test('classification retry accepts a null signal with the real timer', async () => {
  const { resolveOperatorLabelGateFailuresWithRetry } = await import('../src/ama/operator-label-gates.mjs');
  let reads = 0;
  const result = await resolveOperatorLabelGateFailuresWithRetry({ signal: null }, {
    delaysMs: [1], resolveImpl: async () => ({ inconclusive: ++reads === 1, gates: [] }),
  });
  assert.equal(reads, 2);
  assert.equal(result.inconclusive, false);
});

test('proof cache sanitizes invalid capacities and retains reusable reads', async () => {
  const { createAmaProofCache } = await import('../src/ama-closure-orchestration.mjs');
  for (const maxEntries of [0, -1, 0.5, NaN, Infinity]) {
    const cache = createAmaProofCache({ maxEntries });
    const identity = { rootDir: 'fixture', repo: 'example/repo', prNumber: 42,
      reviewedHead: 'reviewed', currentHead: 'current' };
    let reads = 0;
    assert.equal(await cache.scope(identity).read('proof', async () => ++reads), 1);
    assert.equal(await cache.scope(identity).read('proof', async () => ++reads), 1);
    assert.equal(reads, 1);
  }
});

test('hammer owner route preserves timeout and classification wait reasons', async () => {
  const { routeToHammerOwner } = await import('../src/hammer-owner-route.mjs');
  for (const error of [Object.assign(new Error('timeout'), { code: 'AMA_COEXISTENCE_OPERATION_TIMEOUT' }),
    Object.assign(new Error('classification wait'), { reason: 'operator-label-classification-pending' })]) {
    const result = await routeToHammerOwner({ route: 'ci-blocked',
      rootDir: 'fixture', repoPath: 'example/repo', prNumber: 42, logger: null,
      fetchMergeAgentCandidateImpl: async () => { throw error; },
    });
    assert.equal(result.handled, true);
    assert.equal(result.outcome, 'ama-pending');
    assert.equal(result.amaClosureResult.reason, error.code || error.reason);
  }
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test('HAMCLOSEWAIT-02 in-flight launch hints require valid progress evidence', () => {
  for (const closerProgressAt of [undefined, '', 'invalid']) {
    assert.equal(isAmaCloserLaunching({ reason: 'in-flight:foreign-worker', closerProgressAt }), false);
  }
  assert.equal(isAmaCloserLaunching({ reason: 'in-flight:local-worker',
    closerProgressAt: '2026-01-01T00:00:00Z' }), true);
  assert.equal(isAmaCloserLaunching({ reason: 'ama-closer-dispatch-overrun: elapsed_ms=900001 bound_ms=900000' }), true);
});

test('HAMCLOSEWAIT-02 queue credits actual start, not submission or repeated observations', async () => {
  let clock = 1000;
  const queue = createAmaHammerBackgroundQueue({ maxConcurrent: 1, nowMs: () => clock });
  const first = deferred(), second = deferred();
  queue.submit({ key: 'example/repo#1@a', run: () => first.promise });
  const queued = queue.submit({ key: 'example/repo#2@b', timeoutMs: 240_000, run: () => second.promise });
  assert.deepEqual(amaHammerBackgroundProgress(queued, clock), {});
  assert.deepEqual(amaHammerBackgroundProgress(queue.get(queued.key), clock), {});
  assert.equal(isAmaCloserLaunching({ reason: AMA_HAMMER_BACKGROUND_REASON,
    ...amaHammerBackgroundProgress(queued, clock), backgroundDispatch: queued }), false);
  clock = 10_000;
  first.resolve({ dispatched: false });
  await new Promise(resolve => setImmediate(resolve));
  const progress = amaHammerBackgroundProgress(queue.get(queued.key), clock);
  assert.equal(progress.closerProgressAt, new Date(clock).toISOString());
  assert.equal(progress.closerLaunchBoundMs, 240_000);
  assert.equal(isAmaCloserLaunching({ reason: AMA_HAMMER_BACKGROUND_REASON, ...progress }), true);
  clock += 200_000;
  assert.deepEqual(amaHammerBackgroundProgress(queue.get(queued.key), clock), progress);
  second.resolve({ dispatched: true });
  await queue.drain();
  assert.equal(queue.get(queued.key).state, 'settled');
  const settled = queue.takeSettled(queued.key).result;
  assert.equal(settled.closerProgressAt, progress.closerProgressAt);
  assert.ok(!isAmaCloserLaunching(settled), 'successful settlement is no longer launching');
  assert.equal(queue.get(queued.key), null);
});

test('HAMCLOSEWAIT-02 canceled and future-dated background entries cannot grant launch credit', async () => {
  const queue = createAmaHammerBackgroundQueue({ nowMs: () => 1000 });
  const gate = deferred(), key = 'example/repo#1@a';
  const submitted = queue.submit({ key, run: () => gate.promise });
  assert.equal(submitted.boundMs, DEFAULT_AMA_HAMMER_BACKGROUND_BOUND_MS);
  assert.deepEqual(amaHammerBackgroundProgress(submitted, 999), {});
  queue.abort(key);
  assert.equal(queue.get(key), null);
  assert.deepEqual(amaHammerBackgroundProgress(queue.submit({ key, run: () => gate.promise }), 1000), {});
  gate.resolve({ dispatched: true });
  await queue.drain();
  assert.equal(queue.takeSettled(key), null);
});

test('dispatch mode defaults to inline when the key is unset', () => {
  assert.equal(resolveAmaHammerDispatchMode({ cfg: cfgReturning(undefined) }), 'inline');
});

test('dispatch mode resolves background when configured', () => {
  assert.equal(resolveAmaHammerDispatchMode({ cfg: cfgReturning('background') }), 'background');
  assert.equal(resolveAmaHammerDispatchMode({ cfg: cfgReturning(' Background ') }), 'background');
});

test('dispatch mode fails safe to inline on an unknown value or a config error', () => {
  assert.equal(resolveAmaHammerDispatchMode({ cfg: cfgReturning('async') }), 'inline');
  const warnings = [];
  const mode = resolveAmaHammerDispatchMode({
    cfg: { get() { throw new Error('config.yaml unreadable'); } },
    logger: { warn: (line) => warnings.push(line) },
  });
  assert.equal(mode, 'inline');
  assert.match(warnings[0], /ama_hammer_dispatch_mode unreadable; using inline/);
});

test('background key is PR@head', () => {
  assert.equal(
    amaHammerBackgroundKey({ repo: 'o/r', prNumber: 7, headSha: 'abc' }),
    'o/r#7@abc',
  );
});

test('queue runs one dispatch per PR@head: a second submit while in flight does not run again', async () => {
  const queue = createAmaHammerBackgroundQueue({ maxConcurrent: 2 });
  const gate = deferred();
  let runs = 0;
  const first = queue.submit({ key: 'o/r#1@a', run: () => { runs += 1; return gate.promise; } });
  const second = queue.submit({ key: 'o/r#1@a', run: () => { runs += 1; return gate.promise; } });
  assert.equal(first.state, 'started');
  assert.equal(second.state, 'in-flight');
  assert.equal(runs, 1);
  gate.resolve({ dispatched: true });
  await queue.drain();
  assert.deepEqual(queue.snapshot().keys, []);
  // Once settled, the same PR@head may be submitted again (the closer decides).
  assert.equal(queue.submit({ key: 'o/r#1@a', run: async () => ({}) }).state, 'started');
  await queue.drain();
});

test('queue bounds concurrency and starts waiters FIFO as runs settle', async () => {
  const queue = createAmaHammerBackgroundQueue({ maxConcurrent: 1 });
  const gateA = deferred();
  const order = [];
  assert.equal(queue.submit({ key: 'A', run: () => { order.push('A'); return gateA.promise; } }).state, 'started');
  assert.equal(queue.submit({ key: 'B', run: async () => { order.push('B'); } }).state, 'queued');
  assert.equal(queue.submit({ key: 'C', run: async () => { order.push('C'); } }).state, 'queued');
  assert.deepEqual(order, ['A']);
  assert.equal(queue.snapshot().running, 1);
  assert.equal(queue.snapshot().waiting, 2);
  gateA.resolve();
  await queue.drain();
  assert.deepEqual(order, ['A', 'B', 'C']);
});

test('queue holds a newer head until the same PR run settles without blocking another PR', async () => {
  const queue = createAmaHammerBackgroundQueue({ maxConcurrent: 2 });
  const oldHead = deferred();
  const otherPr = deferred();
  const order = [];
  assert.equal(queue.submit({ key: 'o/r#1@old', run: () => {
    order.push('old');
    return oldHead.promise;
  } }).state, 'started');
  assert.equal(queue.submit({ key: 'o/r#1@new', run: async () => { order.push('new'); } }).state, 'queued');
  assert.equal(queue.submit({ key: 'o/r#2@head', run: () => {
    order.push('other');
    return otherPr.promise;
  } }).state, 'started');
  assert.deepEqual(order, ['old', 'other']);
  oldHead.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ['old', 'other', 'new']);
  otherPr.resolve();
  await queue.drain();
});

test('background queue defaults to three launch slots', () => {
  assert.equal(createAmaHammerBackgroundQueue().snapshot().limit, 3);
});

test('process queue is independent of the first domain ceiling and retains each closer policy', async (t) => {
  resetAmaHammerBackgroundQueueForTests();
  t.after(resetAmaHammerBackgroundQueueForTests);
  const gate = deferred();
  const policies = [];
  let queue;
  try {
    for (const [index, ceiling] of [3, 32, 32, 32].entries()) {
      const result = await maybeDispatchAmaClosureFor(closureArgs({
        prNumber: 7 + index,
        resolveAmaHammerDispatchModeImpl: () => 'background',
        loadConfigImpl: () => ({
          getMergeAuthorityConfig: () => ({ enabled: true, amaCloserConcurrentLaunchCeiling: ceiling }),
        }),
        amaHammerBackgroundQueueImpl: (options) => {
          assert.deepEqual(options, { maxConcurrent: 3 });
          queue = amaHammerBackgroundQueue(options);
          return queue;
        },
        maybeDispatchAmaCloserImpl: async ({ cfg }) => {
          policies.push(cfg.amaCloserConcurrentLaunchCeiling);
          return gate.promise;
        },
      }));
      assert.equal(result.backgroundDispatch.state, 'started');
    }
    assert.deepEqual(policies, [3, 32, 32, 32]);
    assert.equal(queue.snapshot().running, 4);
  } finally {
    gate.resolve({ dispatched: false, reason: 'ama-closer-launch-in-progress' });
    await queue?.drain();
  }
});

test('a failing background dispatch is reported and does not wedge the queue', async () => {
  const queue = createAmaHammerBackgroundQueue({ maxConcurrent: 1 });
  const settled = [];
  queue.submit({
    key: 'bad',
    run: () => { throw new Error('hq dispatch exploded'); },
    onSettled: (outcome) => settled.push(outcome),
  });
  let ranAfter = false;
  queue.submit({ key: 'good', run: async () => { ranAfter = true; return { dispatched: true }; } });
  await queue.drain();
  assert.equal(settled[0].ok, false);
  assert.match(String(settled[0].error?.message), /exploded/);
  assert.equal(ranAfter, true);
});

test('a throwing settle callback cannot leave a rejected background promise', async () => {
  const queue = createAmaHammerBackgroundQueue();
  queue.submit({
    key: 'logger-failure',
    run: async () => ({ dispatched: true }),
    onSettled: () => { throw new Error('logger failed'); },
  });
  await queue.drain();
  assert.equal(queue.takeSettled('logger-failure')?.result?.dispatched, true);
  assert.deepEqual(queue.snapshot().keys, []);
});

// --- End to end through maybeDispatchAmaClosureFor --------------------------

const HEAD = 'abc123';
const SETTLED_BODY =
  '## Summary\nLooks fine.\n\n## Verdict\nComment only\n\n## Blocking Issues\n\n- None.\n\n## Non-blocking Issues\n\n- None.';

function closureArgs(overrides = {}) {
  return {
    rootDir: mkdtempSync(path.join(tmpdir(), 'ama-hammer-background-')),
    reviewStateRow: {
      repo: 'subject-07',
      pr_number: 7,
      pr_state: 'open',
      review_status: 'posted',
      last_verdict: 'Comment only',
      risk_class: 'low',
      remediation_pending: 0,
      reviewer: 'claude',
      reviewer_login: 'claude-reviewer-lacey',
      reviewer_head_sha: HEAD,
      review_body: SETTLED_BODY,
    },
    dispatchJob: {},
    candidate: {
      headSha: HEAD,
      riskClass: 'low',
      prAuthor: 'codex-worker-bot',
      prState: 'open',
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'CLEAN',
      statusCheckRollup: [{ __typename: 'CheckRun', name: 'test', conclusion: 'SUCCESS' }],
      branchProtection: { requiredContexts: ['agent-os/adversarial-gate', 'ci/test'] },
      isDraft: false,
    },
    labelNames: [],
    operatorApprovalEvent: null,
    adversarialMergeRequestedEvent: null,
    repoPath: 'subject-07',
    prNumber: 7,
    currentRevisionRef: HEAD,
    logger: { log() {}, warn() {} },
    fetchLatestHeadReviewBodiesImpl: async () => [SETTLED_BODY],
    fetchCurrentPrStateImpl: async () => ({
      state: 'OPEN', headSha: HEAD, isDraft: false, mergeable: 'MERGEABLE',
    }),
    loadConfigImpl: () => ({
      getMergeAuthorityConfig() {
        return { enabled: true };
      },
    }),
    // These fixtures exercise an already selected repair workflow.
    runDaemonCleanMergeAttemptImpl: async () => ({ disposition: 'failed-closed',
      reason: 'merge-retry-budget-exhausted', attempts: 2 }),
    mergeabilitySampleDelayMs: 0,
    ...overrides,
  };
}

test('production closure context rechecks a parent merged after candidate inspection', async t => {
  for (const field of ['baseBranch', 'baseRefName']) {
    let checked = 0;
    const args = closureArgs({
      repoPath: 'example/subject-07',
      resolveAmaHammerDispatchModeImpl: () => 'inline',
      runDaemonCleanMergeAttemptImpl: async () => ({ disposition: 'failed-closed', reason: 'merge-retry-budget-exhausted', attempts: 2 }),
      maybeDispatchAmaCloserImpl: payload => {
        assert.equal(payload.dispatchContext.baseBranch, 'feature/parent');
        return maybeDispatchAmaCloser({ ...payload,
          guardStackedBaseImpl: async options => {
            checked++;
            assert.equal(options.repo, args.repoPath);
            assert.equal(options.prNumber, args.prNumber);
            return { dispatched: false, skipMergeAgent: true, recoveryWait: true,
              needsOperator: true, reason: 'stacked-base-merged' };
          },
          execFileImpl: async () => assert.fail('a held base cannot launch a worker'),
        });
      },
    });
    t.after(() => rmSync(args.rootDir, { recursive: true, force: true }));
    args.candidate[field] = 'feature/parent';
    const result = await maybeDispatchAmaClosureFor(args);
    assert.equal(checked, 1);
    assert.equal(result.reason, 'stacked-base-merged');
    assert.equal(result.dispatched, false);
  }
});

test('inline mode (default) still awaits the closer and returns its result', async () => {
  let calls = 0;
  let configLoads = 0;
  const cachedConfig = { getMergeAuthorityConfig: () => ({ enabled: true }) };
  const result = await maybeDispatchAmaClosureFor(closureArgs({
    loadConfigImpl: () => { configLoads += 1; return cachedConfig; },
    resolveAmaHammerDispatchModeImpl: ({ cfg }) => {
      assert.equal(cfg, cachedConfig);
      return 'inline';
    },
    maybeDispatchAmaCloserImpl: async () => {
      calls += 1;
      return { dispatched: true, reason: 'dispatched', launchRequestId: 'lrq_inline' };
    },
  }));
  assert.equal(calls, 1);
  assert.equal(configLoads, 1);
  assert.equal(result.dispatched, true);
  assert.equal(result.launchRequestId, 'lrq_inline');
});

test('max-rounds stop hands the next closure tick directly to the hammer', async () => {
  let payload;
  await maybeDispatchAmaClosureFor(closureArgs({
    dispatchJob: { remediationStopCode: 'max-rounds-reached' },
    resolveReviewCycleExhaustionImpl: () => ({ reviewCycleExhausted: false }),
    maybeDispatchAmaCloserImpl: async (args) => {
      payload = args;
      return { dispatched: true, launchRequestId: 'lrq_exhausted' };
    },
  }));
  assert.equal(payload.reviewState.reviewCycleExhausted, true);
  assert.equal(payload.dispatchContext.dispatchReason, 'exhausted-final-hammer');
});

test('not-eligible refusal carries a retry-after and its gate reasons', async () => {
  const result = await maybeDispatchAmaClosureFor(closureArgs({
    maybeDispatchAmaCloserImpl: async () => ({
      dispatched: false, skipMergeAgent: true, reason: 'not-eligible', reasons: ['ci-not-green'],
    }),
  }));
  assert.equal(result.reason, 'not-eligible');
  assert.deepEqual(result.reasons, ['ci-not-green']);
  assert.equal(result.retryAfterMs, 30_000);
});

test('structural not-eligible refusal is operator-visible and terminal', async () => {
  const result = await maybeDispatchAmaClosureFor(closureArgs({
    maybeDispatchAmaCloserImpl: async () => ({
      dispatched: false, skipMergeAgent: true, reason: 'not-eligible',
      reasons: ['risk-class-not-permitted'], eligibilityRejected: true, safetyRefusal: true,
      needsOperator: true, operatorReason: 'not-eligible:risk-class-not-permitted',
    }),
  }));
  assert.equal(result.needsOperator, true);
  assert.equal(result.operatorReason, 'not-eligible:risk-class-not-permitted');
  assert.equal(result.nextAction.actor, 'closure-recovery');
});

test('background mode: a slow hammer dispatch no longer holds the caller, and PR@head is not re-dispatched while in flight', async () => {
  const queue = createAmaHammerBackgroundQueue({ maxConcurrent: 2 });
  const hqDispatch = deferred(); // stands in for a 150 s `hq dispatch`
  const seenPayloads = [];
  let calls = 0;
  const logs = [];
  const args = closureArgs({
    logger: { log: (line) => logs.push(line), warn() {} },
    resolveAmaHammerDispatchModeImpl: () => 'background',
    amaHammerBackgroundQueueImpl: () => queue,
    maybeDispatchAmaCloserImpl: async (payload) => {
      calls += 1;
      seenPayloads.push(payload);
      return hqDispatch.promise;
    },
  });

  // The caller returns while `hq dispatch` is still outstanding.
  const first = await maybeDispatchAmaClosureFor(args);
  assert.equal(first.dispatched, false);
  assert.equal(first.skipMergeAgent, true, 'coexistence must treat it as ama-pending, not fall to merge-agent');
  assert.equal(first.reason, AMA_HAMMER_BACKGROUND_REASON);
  assert.equal(first.backgroundDispatch.state, 'started');
  assert.equal(first.backgroundDispatch.key, `subject-07#7@${HEAD}`);
  assert.equal(calls, 1);
  assert.equal(
    seenPayloads[0].signal.aborted,
    false,
    'background run uses its own signal, detached from the step deadline',
  );

  // Next tick, same PR@head, dispatch still running: no second `hq dispatch`.
  const second = await maybeDispatchAmaClosureFor(args);
  assert.equal(second.backgroundDispatch.state, 'in-flight');
  assert.equal(calls, 1);

  hqDispatch.resolve({ dispatched: true, reason: 'dispatched', launchRequestId: 'lrq_bg' });
  await queue.drain();
  assert.ok(
    logs.some((line) => /AMA hammer background dispatch settled for .*#7@abc123: dispatched=true/.test(line)),
    'settle outcome is logged with the PR@head key',
  );

  // The tick after it settles applies the outcome instead of dispatching again.
  const third = await maybeDispatchAmaClosureFor(args);
  assert.equal(calls, 1, 'a settled outcome is applied, not re-dispatched');
  assert.equal(third.dispatched, true);
  assert.equal(third.launchRequestId, 'lrq_bg');
});

test('queued hammer dispatch rechecks live PR state and head before launching', async () => {
  for (const liveState of [
    { state: 'CLOSED', headSha: HEAD, isDraft: false, mergeable: 'MERGEABLE' },
    { state: 'OPEN', headSha: 'new-head', isDraft: false, mergeable: 'MERGEABLE' },
  ]) {
    const queue = createAmaHammerBackgroundQueue({ maxConcurrent: 1 });
    const blocker = deferred();
    queue.submit({ key: 'earlier-pr', run: () => blocker.promise });
    let closerCalls = 0;
    const args = closureArgs({
      resolveAmaHammerDispatchModeImpl: () => 'background',
      amaHammerBackgroundQueueImpl: () => queue,
      fetchCurrentPrStateImpl: async () => liveState,
      maybeDispatchAmaCloserImpl: async () => {
        closerCalls += 1;
        return { dispatched: true };
      },
    });
    const queued = await maybeDispatchAmaClosureFor(args);
    assert.equal(queued.backgroundDispatch.state, 'queued');
    blocker.resolve();
    await queue.drain();
    assert.equal(closerCalls, 0);
    const settled = await maybeDispatchAmaClosureFor(args);
    assert.equal(settled.dispatched, false);
    assert.equal(settled.reason, 'background-pr-state-changed');
    assert.equal(settled.retryAfterMs, 30_000);
  }
});

test('queued hammer dispatch names a draft and an unmergeable PR instead of a state change (COMMENTCLOSE-01)', async () => {
  const cases = [
    {
      live: { state: 'OPEN', headSha: HEAD, isDraft: true, mergeable: 'MERGEABLE' },
      expect: { reason: 'background-pr-draft', needsOperator: true, operatorReason: 'pr-is-draft' },
    },
    {
      live: { state: 'OPEN', headSha: HEAD, isDraft: false, mergeable: 'UNKNOWN' },
      expect: { reason: 'mergeability-unknown', retryAfterMs: 30_000 },
    },
    {
      live: { state: 'OPEN', headSha: HEAD, isDraft: false, mergeable: '' },
      launches: true, expect: { dispatched: true },
    },
  ];
  for (const { live, expect, launches } of cases) {
    const queue = createAmaHammerBackgroundQueue({ maxConcurrent: 1 });
    let closerCalls = 0;
    const args = closureArgs({
      resolveAmaHammerDispatchModeImpl: () => 'background',
      amaHammerBackgroundQueueImpl: () => queue,
      fetchCurrentPrStateImpl: async () => live,
      maybeDispatchAmaCloserImpl: async () => {
        closerCalls += 1;
        return { dispatched: true };
      },
    });
    await maybeDispatchAmaClosureFor(args);
    await queue.drain();
    assert.equal(closerCalls, launches ? 1 : 0);
    const settled = await maybeDispatchAmaClosureFor(args);
    assert.equal(settled.dispatched, Boolean(launches));
    if (!launches) assert.equal(settled.skipMergeAgent, true);
    for (const [key, value] of Object.entries(expect)) assert.equal(settled[key], value, `${expect.reason}.${key}`);
    if (expect.reason === 'background-pr-draft') assert.equal(settled.retryAfterMs, undefined);
  }
});

test('queued hammer dispatch launches the closer for a CONFLICTING PR and a CLEAN-normalized UNKNOWN (DIRTYOWN-01)', async () => {
  for (const live of [
    { state: 'OPEN', headSha: HEAD, isDraft: false, mergeable: 'CONFLICTING' },
    { state: 'OPEN', headSha: HEAD, isDraft: false, mergeable: 'UNKNOWN', mergeStateStatus: 'CLEAN' },
  ]) {
    const queue = createAmaHammerBackgroundQueue({ maxConcurrent: 1 });
    let closerCalls = 0;
    const args = closureArgs({
      resolveAmaHammerDispatchModeImpl: () => 'background',
      amaHammerBackgroundQueueImpl: () => queue,
      fetchCurrentPrStateImpl: async () => live,
      maybeDispatchAmaCloserImpl: async () => {
        closerCalls += 1;
        return { dispatched: true, launchRequestId: 'lrq_conflict' };
      },
    });
    await maybeDispatchAmaClosureFor(args);
    await queue.drain();
    assert.equal(closerCalls, live.mergeable === 'UNKNOWN' ? 0 : 1);
    if (live.mergeable === 'UNKNOWN') {
      const waiting = await maybeDispatchAmaClosureFor(args);
      assert.equal(waiting.nextAction.action, 'wait-for-CI');
      assert.equal(waiting.reason, 'mergeability-unknown');
      continue;
    }
    const settled = await maybeDispatchAmaClosureFor(args);
    assert.equal(settled.dispatched, true);
    assert.equal(settled.launchRequestId, 'lrq_conflict');
  }
});

test('queue reports a coalesced submit as queued while its entry still waits for a slot', async () => {
  const queue = createAmaHammerBackgroundQueue({ maxConcurrent: 1 });
  const gate = deferred();
  queue.submit({ key: 'A', run: () => gate.promise });
  assert.equal(queue.submit({ key: 'B', run: async () => ({}) }).state, 'queued');
  assert.equal(queue.submit({ key: 'B', run: async () => ({}) }).state, 'queued');
  assert.equal(queue.submit({ key: 'A', run: async () => ({}) }).state, 'in-flight');
  gate.resolve({});
  await queue.drain();
});

test('takeSettled hands each outcome over once and drops stale ones', async () => {
  let now = 1_000;
  const queue = createAmaHammerBackgroundQueue({ nowMs: () => now, settledTtlMs: 500 });
  queue.submit({ key: 'k', run: async () => ({ dispatched: false, reason: 'x' }) });
  await queue.drain();
  const outcome = queue.takeSettled('k');
  assert.equal(outcome.ok, true);
  assert.equal(outcome.result.reason, 'x');
  assert.equal(queue.takeSettled('k'), null, 'consumed once');

  queue.submit({ key: 'old', run: async () => ({}) });
  await queue.drain();
  now += 501;
  assert.equal(queue.takeSettled('old'), null, 'older than the TTL is dropped');
});

test('background mode: a terminal closer rejection reaches the caller on the next tick exactly as inline returns it', async () => {
  // e.g. the hammer retry cap: the closer declines without dispatching and the
  // watcher must be free to fall through to merge-agent / alerting.
  const rejection = { dispatched: false, reason: 'hammer-retry-cap-exhausted' };
  const now = () => Date.parse('2026-01-01T00:00:00Z');
  const inline = await maybeDispatchAmaClosureFor(closureArgs({
    resolveAmaHammerDispatchModeImpl: () => 'inline',
    now, maybeDispatchAmaCloserImpl: async () => ({ ...rejection }),
  }));

  const queue = createAmaHammerBackgroundQueue();
  let calls = 0;
  const args = closureArgs({
    now,
    resolveAmaHammerDispatchModeImpl: () => 'background',
    amaHammerBackgroundQueueImpl: () => queue,
    maybeDispatchAmaCloserImpl: async () => {
      calls += 1;
      return { ...rejection };
    },
  });
  const first = await maybeDispatchAmaClosureFor(args);
  assert.equal(first.reason, AMA_HAMMER_BACKGROUND_REASON);
  await queue.drain();
  const second = await maybeDispatchAmaClosureFor(args);
  assert.equal(calls, 1);
  const withoutGeneration = result => ({ ...result, nextAction: { ...result.nextAction, generation: null } });
  assert.deepEqual(withoutGeneration(second), withoutGeneration(inline), 'the same refusal retains the same recovery workflow');
  assert.equal(second.closureOwner.actor, 'closure-recovery');
  assert.notEqual(second.skipMergeAgent, true, 'the merge-agent fallback is reachable again');
});

test('background mode: a closer that throws is applied next tick as ama-dispatch-failed, like inline', async () => {
  const queue = createAmaHammerBackgroundQueue();
  const args = closureArgs({
    resolveAmaHammerDispatchModeImpl: () => 'background',
    amaHammerBackgroundQueueImpl: () => queue,
    maybeDispatchAmaCloserImpl: async () => {
      throw new Error('hq dispatch exploded');
    },
  });
  await maybeDispatchAmaClosureFor(args);
  await queue.drain();
  const second = await maybeDispatchAmaClosureFor(args);
  assert.equal(second.dispatched, false);
  assert.equal(second.reason, 'ama-dispatch-failed');
});

function scopedEvent(headSha = HEAD) {
  return { id: 'event-07', actor: 'operator-07', headSha, createdAt: '2026-01-01T00:00:00Z' };
}

function sharedResult(args, result, observations = {}) {
  const seed = matrixPair().snapshot;
  const snapshot = deriveNextActionSnapshot({ base: seed, subjectKey: `${args.repoPath}#${args.prNumber}`,
    head: HEAD, observations: {
      pr: { ...seed.observations.pr.value, headSha: HEAD, labels: args.labelNames || [] },
      reviews: { ...seed.observations.reviews.value, headSha: HEAD }, ...Object.fromEntries(Object.entries(observations).map(([name, value]) => [name,
        value === null ? { state: 'unknown', value: null } : value])),
    } });
  const shared = Object.freeze({ snapshot, decision: nextAction(snapshot) });
  return bindClosureNextAction({ ...result, nextAction: shared.decision }, shared);
}

for (const headSha of [HEAD, 'head-06']) {
  test(`scoped repair intent still checks physical closer ownership at ${headSha}`, async t => {
    const args = closureArgs();
    t.after(() => rmSync(args.rootDir, { recursive: true, force: true }));
    acquireAmaCloserLease({ rootDir: args.rootDir, repo: args.repoPath,
      prNumber: args.prNumber, headSha, watcherPid: process.pid });
    const result = await resolveMergeAgentCoexistenceForWatcher({
      ...args, labelNames: ['merge-agent-requested'], mergeAgentRequestEvent: scopedEvent(),
      maybeDispatchAmaClosureForImpl: async () => sharedResult(args, {
        amaEnabled: true, skipMergeAgent: true, primaryChangeRepair: true,
      }, { progress: { primaryChange: { ok: false, reason: 'primary-change-reverted' } } }),
      recoverAmaAutomationImpl: async () => assert.fail('a live lease retains ownership'),
    });
    assert.equal(result.outcome, 'ama-pending');
    assert.equal(result.coexistence.action, 'ama-closer-pending');
    assert.equal(result.dispatchEnv, undefined);
  });
}

for (const headSha of [HEAD, 'head-06', null]) {
  test(`unreadable dispatch evidence retains recovery with expired or absent lease at ${headSha}`, async t => {
    const args = closureArgs();
    t.after(() => rmSync(args.rootDir, { recursive: true, force: true }));
    if (headSha) {
      const identity = { repo: args.repoPath, prNumber: args.prNumber, headSha };
      const now = new Date(Date.now() - AMA_CLOSER_UNKNOWN_LAUNCH_RECLAIM_AGE_MS - 1).toISOString();
      acquireAmaCloserLease({ rootDir: args.rootDir, ...identity, watcherPid: process.pid, now });
      updateAmaCloserLease({ rootDir: args.rootDir, ...identity, status: 'dispatched', lrqId: 'attempt-07', now });
      assert.equal(isHeldAmaCloserLease(args.rootDir, identity), false);
    }
    const result = await resolveMergeAgentCoexistenceForWatcher({
      ...args, labelNames: ['merge-agent-requested'], mergeAgentRequestEvent: scopedEvent(),
      maybeDispatchAmaClosureForImpl: async () => sharedResult(args, {
        amaEnabled: true, skipMergeAgent: true, reason: 'evidence-07',
      }, { launches: { closer: { headSha: HEAD, launchRequestId: 'attempt-07', retryChainUnreadable: true } } }),
      recoveryOptions: { dispatchHammer: async () => assert.fail('unreadable ownership cannot launch'), pageImpl: async () => true },
    });
    assert.equal(result.outcome, 'ama-pending');
    assert.equal(result.amaClosureResult.nextAction.actor, 'closure-recovery');
    assert.equal(result.dispatchEnv, undefined);
  });
}

for (const intent of ['repair', 'unknown', 'safety', 'explicit-hold']) {
  test(`scoped operator request projects ${intent} intent without a reason registry`, async t => {
    const args = closureArgs();
    t.after(() => rmSync(args.rootDir, { recursive: true, force: true }));
    const observations = intent === 'repair' ? { progress: { primaryChange: { ok: false, reason: 'primary-change-reverted' } } }
      : intent === 'unknown' ? { launches: null }
      : intent === 'safety' ? { controls: { safetyRefusal: { deterministic: true, reason: 'evidence-07' } } }
      : { pr: { state: 'OPEN', headSha: HEAD, isDraft: true } };
    const run = (labelNames, event = scopedEvent()) => resolveMergeAgentCoexistenceForWatcher({
      ...args, labelNames, mergeAgentRequestEvent: event,
      maybeDispatchAmaClosureForImpl: async () => sharedResult(args, {
        amaEnabled: true, skipMergeAgent: true, primaryChangeRepair: intent === 'repair', reason: 'opaque-evidence-07',
      }, observations),
      recoverOrphanImpl: async () => null,
      recoverAmaAutomationImpl: async ({ result }) => ({ outcome: 'ama-pending', amaClosureResult: result }),
    });
    const result = await run(['merge-agent-requested']);
    assert.equal(result.outcome, intent === 'repair' ? 'dispatch-merge-agent'
      : intent === 'explicit-hold' ? 'await-operator' : 'ama-pending');
    assert.deepEqual(result.dispatchEnv, intent === 'repair' ? { AMA_OPERATOR_MERGE_AGENT_OVERRIDE: 'true' } : undefined);
    if (intent === 'repair') {
      for (const stop of ['no-merge-hold', 'do-not-merge', 'merge-agent-skip',
        'adversarial-merge-blocked', 'merge-agent-stuck', 'duplicate-family-hold']) {
        assert.notEqual((await run(['merge-agent-requested', stop])).outcome, 'dispatch-merge-agent');
      }
      assert.notEqual((await run(['merge-agent-requested'], scopedEvent('head-06'))).outcome, 'dispatch-merge-agent');
    }
  });
}

test('partial executor evidence cannot authorize a scoped fallback from reason text', async t => {
  const args = closureArgs();
  t.after(() => rmSync(args.rootDir, { recursive: true, force: true }));
  for (const reason of ['primary-change-repair-required', 'daemon-failed-closed', 'evidence-07']) {
    const result = await resolveMergeAgentCoexistenceForWatcher({
      ...args, labelNames: ['merge-agent-requested'], mergeAgentRequestEvent: scopedEvent(),
      maybeDispatchAmaClosureForImpl: async () => ({ amaEnabled: true, skipMergeAgent: true, reason }),
      recoveryOptions: { pageImpl: async () => true },
    });
    assert.equal(result.outcome, 'ama-pending');
    assert.equal(result.amaClosureResult.nextAction.actor, 'closure-recovery');
    assert.equal(result.dispatchEnv, undefined);
  }
});

test('background mode re-evaluates a cleared safety hold on the same head', async () => {
  const queue = createAmaHammerBackgroundQueue();
  let held = true;
  let calls = 0;
  const args = closureArgs({
    resolveAmaHammerDispatchModeImpl: () => 'background',
    amaHammerBackgroundQueueImpl: () => queue,
    maybeDispatchAmaCloserImpl: async () => {
      calls += 1;
      return held
        ? { dispatched: false, skipMergeAgent: true, needsOperator: true, reason: 'risk-class-not-permitted' }
        : { dispatched: true, launchRequestId: 'lrq_recovered' };
    },
  });
  await maybeDispatchAmaClosureFor(args);
  await queue.drain();
  assert.equal((await maybeDispatchAmaClosureFor(args)).reason, 'risk-class-not-permitted');
  held = false;
  await maybeDispatchAmaClosureFor(args);
  await queue.drain();
  const result = await maybeDispatchAmaClosureFor(args);
  assert.equal(calls, 2);
  assert.equal(result.dispatched, true);
});

test('a scoped label still evaluates closer safety gates on every background cycle', async () => {
  const queue = createAmaHammerBackgroundQueue();
  let calls = 0;
  let pages = 0;
  const args = closureArgs({
    labelNames: ['merge-agent-requested'], mergeAgentRequestEvent: scopedEvent(),
    resolveAmaHammerDispatchModeImpl: () => 'background',
    amaHammerBackgroundQueueImpl: () => queue,
    maybeDispatchAmaCloserImpl: async () => {
      calls += 1;
      return { dispatched: false, skipMergeAgent: true, needsOperator: true,
        reason: 'hammer-retry-cap-suppressed' };
    },
  });
  const run = () => resolveMergeAgentCoexistenceForWatcher({
    ...args,
    maybeDispatchAmaClosureForImpl: (input) => maybeDispatchAmaClosureFor({ ...args, ...input }),
    recoveryOptions: { pageImpl: async () => { pages += 1; } },
  });
  for (let cycle = 0; cycle < 3; cycle += 1) {
    assert.equal((await run()).outcome, 'ama-pending');
    await queue.drain();
    assert.equal((await run()).outcome, 'recovery-exhausted');
  }
  assert.equal(calls, 3);
  assert.equal(pages, 1, 'a safety refusal without recorded repair pages once without bypassing closer gates');
});

test('safety refusals are consumed once and expire under the normal TTL', async () => {
  let now = 0;
  const queue = createAmaHammerBackgroundQueue({ nowMs: () => now, settledTtlMs: 500 });
  const submit = () => queue.submit({ key: 'o/r#1@head', run: async () => ({
    dispatched: false, needsOperator: true, reason: 'primary-change-repair-required',
  }) });
  submit();
  await queue.drain();
  assert.ok(queue.takeSettled('o/r#1@head'));
  assert.equal(queue.takeSettled('o/r#1@head'), null);
  submit();
  await queue.drain();
  now = 501;
  assert.equal(queue.takeSettled('o/r#1@head'), null);
});

test('a changed head discards the previous head settled refusal', async () => {
  const queue = createAmaHammerBackgroundQueue();
  queue.submit({ key: 'o/r#1@old', run: async () => ({
    dispatched: false, needsOperator: true, reason: 'primary-change-repair-required',
  }) });
  await queue.drain();
  assert.equal(queue.takeSettled('o/r#1@new'), null);
  assert.equal(queue.takeSettled('o/r#1@old'), null);
});


test('stale-head cancellation signals the running task and drops its outcome', async () => {
  const queue = createAmaHammerBackgroundQueue({ maxConcurrent: 2 });
  let oldSignal;
  const gate = deferred();
  queue.submit({ key: 'o/r#1@old', run: (signal) => {
    oldSignal = signal;
    return gate.promise;
  } });
  queue.submit({ key: 'o/r#1@new', run: async () => 'new' });
  assert.equal(oldSignal.aborted, true);
  assert.equal(queue.snapshot().running, 1);
  gate.resolve('old');
  await queue.drain();
  assert.equal(queue.takeSettled('o/r#1@new').result, 'new');
  assert.equal(queue.takeSettled('o/r#1@old'), null);
});

test('abort removes a queued task without launching it', async () => {
  const queue = createAmaHammerBackgroundQueue({ maxConcurrent: 1 });
  const gate = deferred();
  queue.submit({ key: 'other', run: () => gate.promise });
  let launched = false;
  queue.submit({ key: 'queued', run: async () => { launched = true; } });
  assert.equal(queue.abort('queued'), true);
  assert.equal(queue.abort('missing'), false);
  assert.equal(queue.snapshot().waiting, 0);
  gate.resolve();
  await queue.drain();
  assert.equal(launched, false);
});

function closerResumeFixture(scenario) {
  const body = SETTLED_BODY.replace('- None.', scenario === 'blocking' ? '- Blocking defect.' : '- None.')
    .replace('## Non-blocking Issues\n\n- None.', '## Non-blocking Issues\n\n- Measurement evidence needs clarification.');
  const wakes = [];
  const payloads = [];
  const liveHeads = [];
  const args = closureArgs({
    resolveAmaHammerDispatchModeImpl: () => 'inline',
    resolveReviewCycleExhaustionImpl: () => ({ riskClass: 'low', reviewCycleExhausted: false }),
    fetchLatestHeadReviewBodiesImpl: async (_repo, _pr, head) => {
      liveHeads.push(head);
      return head === HEAD ? [body]
        : scenario === 'live-blocking' ? ['## Verdict\nRequest changes\n## Blocking Issues\n- Live defect.']
          : scenario === 'live-clean' ? [body] : [];
    },
    proveCloserAuthoredStaleHeadImpl: args => proveCloserAuthoredStaleHead({ ...args,
      comments: scenario === 'worker' ? [] : [{ author: 'the-hammer-lacey[bot]',
        body: `HAM-Base-Head: ${HEAD}\nHAM-Validated-Head: H1` }],
    }),
    resolveHeadCloserCommitSuppressionImpl: async () => ({ suppressed: scenario !== 'worker', reason: 'closer-commit-trailer' }),
    fetchHeadCloserVerifiedCommitImpl: async () => ({ sha: 'H1', parentSha: HEAD, message: 'Closed-By: hammer' }),
    resolveHamTerminalRemediationEvidenceImpl: async () => null,
    runDaemonCleanMergeAttemptImpl: async () => ({ disposition: 'not-taken', reason: 'not-eligible', reasons: [] }),
    fetchMergedProtectiveDependentsImpl: async () => [],
    fetchProtectivePredecessorStateImpl: async () => null,
    requestEligibleHammerWakeImpl: options => { wakes.push(options); },
    maybeDispatchAmaCloserImpl: async payload => { payloads.push(payload); return { dispatched: true }; },
  });
  args.reviewStateRow.review_body = body;
  args.candidate.headSha = 'H1';
  args.currentRevisionRef = 'H1';
  args.candidate.statusCheckRollup = scenario === 'unknown' ? [] : [{ __typename: 'CheckRun', name: 'test',
    status: scenario.startsWith('pending') ? 'IN_PROGRESS' : 'COMPLETED',
    conclusion: ['red', 'red-and-pending'].includes(scenario) ? 'FAILURE' : scenario.startsWith('pending') ? null : 'SUCCESS' }];
  if (scenario === 'red-and-pending') args.candidate.statusCheckRollup.push({
    __typename: 'CheckRun', name: 'other', status: 'IN_PROGRESS', conclusion: null,
  });
  args.candidate.branchProtection.requiredContexts = [];
  if (scenario === 'pending-conflict') {
    args.candidate.mergeable = 'CONFLICTING';
    args.candidate.mergeStateStatus = 'DIRTY';
  }
  args.loadConfigImpl = () => ({ getMergeAuthorityConfig: () => ({ enabled: true, branchProtection: { required: false } }) });
  return { args, wakes, payloads, liveHeads };
}

test('LEASEDEFER-01 HAM rebase resolves exact-head certification without a chain to the old review', async () => {
  const { args, payloads } = closerResumeFixture('green');
  args.fetchHeadCloserVerifiedCommitImpl = async () => ({ sha: 'H1', parentSha: 'rebased-worker', message: 'Closed-By: hammer' });
  args.resolveHeadCloserCommitSuppressionImpl = async ({ headSha }) => ({
    suppressed: headSha === 'H1', reason: headSha === 'H1' ? 'closer-commit-trailer' : 'worker' });
  let evidenceReads = 0;
  args.resolveHamTerminalRemediationEvidenceImpl = async () => { evidenceReads++; return null; };
  await maybeDispatchAmaClosureFor(args);
  assert.equal(evidenceReads, 1);
  assert.equal(payloads[0].dispatchContext.allowStaleReviewHeadHammerResume, true);
});

test('HAMNOREREVIEW-01 stale closer refusal stays with hammer recovery on its first tick', async t => {
  const { args } = closerResumeFixture('green');
  t.after(() => rmSync(args.rootDir, { recursive: true, force: true }));
  args.maybeDispatchAmaCloserImpl = async () => ({ dispatched: false, reason: 'not-eligible',
    reasons: ['stale-review-head', 'verdict-not-settled-success', 'blocking-findings-unknown'] });
  args.recoverStrandedCloserHeadImpl = options => recoverStrandedCloserHead({ ...options,
    requestBoundedReviewImpl: () => assert.fail('hammer heads never request review') });
  const result = await maybeDispatchAmaClosureFor(args);
  assert.equal(result.reason, 'not-eligible');
  assert.equal(result.ownerProofFacts.headSha, 'H1');
  assert.equal(result.ownerProofFacts.liveHeadCloserAuthored, true);
});

test('LEASEDEFER-01 stale eligibility miss cannot transfer a live hammer lease to review', async t => {
  const { args } = closerResumeFixture('green');
  t.after(() => rmSync(args.rootDir, { recursive: true, force: true }));
  acquireAmaCloserLease({ rootDir: args.rootDir, repo: args.repoPath,
    prNumber: args.prNumber, headSha: 'H1', watcherPid: process.pid });
  args.maybeDispatchAmaCloserImpl = async () => ({ dispatched: false, reason: 'not-eligible',
    reasons: ['stale-review-head', 'verdict-not-settled-success', 'blocking-findings-unknown'] });
  args.recoverStrandedCloserHeadImpl = options => recoverStrandedCloserHead({ ...options,
    requestRereviewImpl: () => assert.fail('hammer still owns H1') });
  const result = await maybeDispatchAmaClosureFor(args);
  assert.equal(result.reason, `in-flight:${process.pid}`);
  assert.equal(result.retryAfterMs, 30_000);
  assert.equal(isHeldAmaCloserLease(args.rootDir, { repo: args.repoPath,
    prNumber: args.prNumber, headSha: 'H1' }), true);
});

for (const hardReason of ['label-no-merge-hold', 'pr-not-open', 'risk-class-not-permitted',
  'branch-protection-missing-gate', 'fast-merge-state-unsupported']) {
  test(`stale closer head preserves physical safety evidence for ${hardReason}`, async t => {
    const { args } = closerResumeFixture('green');
    t.after(() => rmSync(args.rootDir, { recursive: true, force: true }));
    args.maybeDispatchAmaCloserImpl = async () => ({ dispatched: false, reason: 'not-eligible',
      reasons: ['stale-review-head', hardReason], safetyRefusal: true, needsOperator: true,
      operatorReason: `not-eligible:${hardReason}` });
    args.recoverStrandedCloserHeadImpl = options => {
      assert.equal(options.result.needsOperator, true, 'hard refusal is classified before recovery');
      return recoverStrandedCloserHead({ ...options,
        requestRereviewImpl: () => assert.fail('held head must not request review') });
    };
    const result = await maybeDispatchAmaClosureFor(args);
    assert.equal(result.reason, 'not-eligible');
    assert.equal(result.needsOperator, true);
    assert.equal(result.operatorReason, `not-eligible:${hardReason}`);
  });
}

for (const closer of [false, true]) {
  test(`duplicate-family census hold retains automatic retry on ${closer ? 'closer' : 'worker'} head`, async t => {
    const { args } = closerResumeFixture(closer ? 'green' : 'worker');
    t.after(() => rmSync(args.rootDir, { recursive: true, force: true }));
    args.maybeDispatchAmaCloserImpl = async () => ({ dispatched: false, reason: 'not-eligible',
      reasons: [...(closer ? ['stale-review-head'] : []), 'duplicate-family-unresolved'] });
    args.recoverStrandedCloserHeadImpl = options => recoverStrandedCloserHead({ ...options,
      requestRereviewImpl: () => assert.fail('census hold must not request review') });
    const result = await maybeDispatchAmaClosureFor(args);
    assert.equal(result.needsOperator, undefined);
    assert.equal(result.retryAfterMs, 30_000);
    if (closer) assert.ok(result.reasons.includes('duplicate-family-unresolved'));
    else assert.equal(result.nextAction.action, 'review');
  });
}

test('unvalidated closer without a review handoff reaches bounded watchdog recovery', async t => {
  const { args } = closerResumeFixture('green');
  t.after(() => rmSync(args.rootDir, { recursive: true, force: true }));
  args.maybeDispatchAmaCloserImpl = async () => ({ dispatched: false, reason: 'not-eligible',
    reasons: ['stale-review-head', 'verdict-not-settled-success', 'blocking-findings-unknown'] });
  let requests = 0;
  args.recoverStrandedCloserHeadImpl = options => recoverStrandedCloserHead({ ...options,
    probeOwnershipImpl: async () => ({ owned: false, uncertain: false }),
    requestRereviewImpl: async () => { requests++; return { triggered: false, reason: 'malformed-title-terminal' }; } });
  let orphanCalls = 0;
  const result = await resolveMergeAgentCoexistenceForWatcher({ ...args,
    maybeDispatchAmaClosureForImpl: () => maybeDispatchAmaClosureFor(args),
    recoverOrphanImpl: async ({ result: refusal }) => {
      orphanCalls++;
      assert.equal(refusal.reason, 'not-eligible');
      assert.ok(refusal.reasons.includes('stale-review-head'));
      return { outcome: 'ama-pending', orphanRecovery: { disposition: 'exhausted' } };
    },
    recoverAmaAutomationImpl: () => assert.fail('orphan watchdog owns refusal'),
  });
  assert.equal(requests, 0);
  assert.equal(orphanCalls, 1);
  assert.equal(result.orphanRecovery.disposition, 'exhausted');
});

test('HAMVALIDORPHAN-01 trailer without an App attestation admits validation but cannot certify a verdict', async t => {
  const { args, payloads } = closerResumeFixture('green');
  t.after(() => rmSync(args.rootDir, { recursive: true, force: true }));
  args.reviewStateRow.reviewer = 'unknown-model';
  args.proveCloserAuthoredStaleHeadImpl = input => proveCloserAuthoredStaleHead({ ...input, comments: [] });
  args.fetchHeadCloserVerifiedCommitImpl = async () => ({ sha: 'H1', parentSha: 'rebased-worker', message: 'Closed-By: hammer' });
  args.resolveHeadCloserCommitSuppressionImpl = async ({ headSha }) => ({
    suppressed: headSha === 'H1', reason: headSha === 'H1' ? 'closer-commit-trailer' : 'worker' });
  args.fetchLatestHeadReviewBodiesImpl = () => assert.fail('no authoritative reviewer to fetch');
  args.resolveHamTerminalRemediationEvidenceImpl = () => assert.fail('no authority to certify this head');
  const result = await maybeDispatchAmaClosureFor(args);
  assert.equal(payloads.length, 1);
  assert.equal(result.nextAction.action, 'hammer');
  assert.equal(payloads[0].options.hamTerminalRemediation, undefined);
});

for (const scenario of ['green', 'red', 'pending', 'pending-conflict', 'red-and-pending', 'unknown', 'worker', 'blocking', 'live-blocking', 'live-clean']) {
  test(`HAMCIWAKE-01 watcher reviewed H0 -> closer H1: ${scenario}`, async t => {
    const { args, wakes, payloads, liveHeads } = closerResumeFixture(scenario);
    t.after(() => rmSync(args.rootDir, { recursive: true, force: true }));
    const result = await maybeDispatchAmaClosureFor(args);
    assert.equal(wakes.length, 1);
    assert.equal(wakes[0].headSha, 'H1');
    assert.equal(['hammer', 'daemon-merge'].includes(wakes[0].shared.decision.action)
      && wakes[0].shared.decision.actor !== 'closure-recovery',
    ['green', 'red', 'red-and-pending', 'pending-conflict', 'blocking'].includes(scenario));
    const expectedDispatch = ['green', 'red', 'red-and-pending', 'pending-conflict', 'blocking'].includes(scenario);
    assert.equal(payloads.length, expectedDispatch ? 1 : 0);
    if (!expectedDispatch && scenario !== 'pending') {
      assert.ok(['review', 'remediate', 'wait-for-CI'].includes(result.nextAction.action));
      return;
    }
    if (scenario === 'pending') {
      assert.equal(result.reason, 'closer-head-ci-not-green');
      assert.equal(result.recoveryWait, true);
      return;
    }
    if (scenario.startsWith('live-')) assert.deepEqual(liveHeads, ['H1', 'H1'], 'live closer-head review supersedes H0');
    assert.equal(payloads[0].reviewState.headSha, HEAD);
    assert.equal(payloads[0].prMetadata.headSha, 'H1');
    assert.equal(payloads[0].dispatchContext.allowStaleReviewHeadHammerResume, !['worker', 'live-blocking', 'live-clean'].includes(scenario));
    if (scenario === 'green') {
      assert.equal(payloads[0].reviewState.verdict, 'comment-only');
      assert.equal(payloads[0].reviewState.blockingFindingCount, 0);
      assert.equal(payloads[0].reviewState.nonBlockingFindingCount, 1);
    }
    if (scenario === 'red') {
      assert.equal(payloads[0].prMetadata.statusCheckRollup[0].conclusion, 'FAILURE');
      assert.equal(payloads[0].dispatchContext.dispatchRecordHeadSha, 'H1');
    }
  });
}

test('HAMROUTE-01: ownerless stale closer with pending CI retains hammer-route wait', async t => {
  const { args, payloads } = closerResumeFixture('pending');
  t.after(() => rmSync(args.rootDir, { recursive: true, force: true }));
  const pages = [], reviews = [];
  for (const minutes of [0, 15, 31, 61]) {
    const result = await resolveMergeAgentCoexistenceForWatcher({ ...args,
      maybeDispatchAmaClosureForImpl: options => maybeDispatchAmaClosureFor({ ...args, ...options }),
      orphanOptions: {
        now: new Date(Date.UTC(2026, 9, 11, 16, minutes)).toISOString(),
        hasOwnerImpl: async () => ({ owned: false }),
        pageImpl: async page => pages.push(page),
        requestRereviewImpl: async request => { reviews.push(request); return { triggered: true }; },
      },
    });
    assert.equal(result.outcome, 'ama-pending');
  }
  assert.deepEqual(payloads, []);
  assert.equal(pages.length, 0);
  assert.equal(reviews.length, 0);
});

// STALECLOSER-03: the real wake against a stubbed watcher, so the dedupe and
// eligibility gates in hammer-wake.mjs are exercised end to end.
function closerAuthoredStaleWakes(args) {
  const watcherWakes = [];
  args.requestEligibleHammerWakeImpl = options => requestEligibleHammerWake({
    ...options,
    requestWatcherWakeImpl: wake => { watcherWakes.push(wake); return { requested: true, payload: { request_id: `w${watcherWakes.length}` } }; },
    log: { log() {}, warn() {} },
  });
  return watcherWakes;
}

test('HAMROUNDEDGE-01 closure passes its round root to the shared proof and wakes the hammer', async t => {
  const { args, payloads } = closerResumeFixture('green');
  t.after(() => rmSync(args.rootDir, { recursive: true, force: true }));
  const dir = path.join(args.rootDir, 'data', 'follow-up-jobs', 'completed');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'subject-07-pr-7-round.json'), JSON.stringify({
    repo: args.repoPath, prNumber: args.prNumber, status: 'completed', remediationPlan: { rounds: [
      { state: 'completed', startHeadSha: HEAD, resultingHeadSha: 'remediated' },
    ] },
  }));
  args.proveCloserAuthoredStaleHeadImpl = input => {
    assert.equal(input.rootDir, args.rootDir);
    return proveCloserAuthoredStaleHead({ ...input, comments: [{ author: 'hammer-worker',
      body: 'HAM-Base-Head: remediated\nHAM-Pushed-Head: H1' }] });
  };
  const wakes = closerAuthoredStaleWakes(args);
  const result = await maybeDispatchAmaClosureFor(args);
  assert.equal(result.closerAuthoredStale.decision, 'eligible');
  assert.deepEqual(result.closerAuthoredStale.closerCommits, ['H1', 'remediated']);
  assert.equal(wakes.length, 1);
  assert.equal(payloads.length, 1);
  assert.equal(payloads[0].dispatchContext.closerAuthoredStale.eligible, true);
});

test('STALECLOSER-03 closer head: mergeability UNKNOWN then CLEAN produces a wake and a closer', async t => {
  const { args, payloads } = closerResumeFixture('green');
  t.after(() => rmSync(args.rootDir, { recursive: true, force: true }));
  const watcherWakes = closerAuthoredStaleWakes(args);
  args.candidate.mergeable = 'UNKNOWN';
  args.candidate.mergeStateStatus = 'UNKNOWN';
  let samples = 0;
  const waiting = await maybeDispatchAmaClosureFor({ ...args, mergeabilitySampleDelayMs: 0,
    fetchPullRequestMergeabilityImpl: async () => { samples += 1; return { mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' }; } });
  assert.ok(samples > 0, 'UNKNOWN is re-sampled before it is classified');
  assert.equal(waiting.recoveryWait, true, 'transient UNKNOWN is a retry, not a stop');
  assert.equal(waiting.reason, 'closer-head-mergeability-unknown');
  assert.equal(waiting.closerAuthoredStale.decision, 'retry');
  assert.equal(waiting.closerAuthoredStale.carryForward, true, 'clean verdict carries forward during retry');
  assert.deepEqual(waiting.reasons, ['pr-mergeability-unknown'], 'carried validated head has no stale-head miss');
  assert.deepEqual(waiting.closerAuthoredStale.reasons, ['pr-mergeability-unknown']);
  assert.equal(payloads.length, 0);
  assert.equal(watcherWakes.length, 0);
  assert.equal(existsSync(closerAuthoredStaleAuditPath(args.rootDir, { repo: args.repoPath, prNumber: args.prNumber, headSha: 'H1' })), false);

  args.candidate.mergeable = 'MERGEABLE';
  args.candidate.mergeStateStatus = 'CLEAN';
  const resolved = await maybeDispatchAmaClosureFor(args);
  assert.equal(resolved.closerAuthoredStale.decision, 'eligible');
  assert.equal(watcherWakes.length, 1, 'mergeability resolving on the closer head wakes the watcher');
  assert.equal(watcherWakes[0].headSha, 'H1');
  assert.equal(readHammerWakeAudit(hammerWakeAuditPath(args.rootDir, { repo: args.repoPath, prNumber: args.prNumber,
    headSha: 'H1', eligibilityReason: 'shared-next-action', wakeAttemptKey: 'initial' }))?.outcome, 'requested');
  assert.equal(payloads.length, 1, 'the closer is dispatched for the eligible closer head');
  assert.equal(payloads[0].dispatchContext.closerAuthoredStale.eligible, true);
  assert.equal(payloads[0].dispatchContext.closerAuthoredStale.currentHead, 'H1');
  const audit = JSON.parse(readFileSync(closerAuthoredStaleAuditPath(args.rootDir,
    { repo: args.repoPath, prNumber: args.prNumber, headSha: 'H1' }), 'utf8'));
  assert.equal(audit.reviewedHead, HEAD);
  assert.deepEqual(audit.closerCommits, ['H1']);

  // Re-observation of the same eligible head is deduped: one wake per head.
  await maybeDispatchAmaClosureFor(args);
  assert.equal(watcherWakes.length, 1);
});

test('STALECLOSER-03 closer head: CI in progress, then green after the hammer exits, produces a wake', async t => {
  const { args, payloads } = closerResumeFixture('pending');
  t.after(() => rmSync(args.rootDir, { recursive: true, force: true }));
  const watcherWakes = closerAuthoredStaleWakes(args);
  const waiting = await maybeDispatchAmaClosureFor(args);
  assert.equal(waiting.recoveryWait, true);
  assert.equal(waiting.reason, 'closer-head-ci-not-green');
  assert.equal(waiting.closerAuthoredStale.decision, 'retry');
  assert.equal(waiting.closerAuthoredStale.carryForward, true, 'clean verdict carries forward during retry');
  assert.deepEqual(waiting.reasons, ['ci-not-green'], 'carried validated head has no stale-head miss');
  assert.equal(watcherWakes.length, 0);
  assert.equal(payloads.length, 0);

  args.candidate.statusCheckRollup = [{ __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }];
  const green = await maybeDispatchAmaClosureFor(args);
  assert.equal(green.closerAuthoredStale.decision, 'eligible');
  assert.equal(watcherWakes.length, 1, 'CI turning green on the closer head wakes the watcher');
  assert.equal(payloads.length, 1);
  assert.equal(payloads[0].dispatchContext.allowStaleReviewHeadHammerResume, true);
});

for (const [scenario, decision] of [['green', 'eligible'], ['worker', 'rereview-exact-head'], ['red', 'not-eligible'],
  ['pending', 'retry'], ['blocking', 'not-eligible']]) {
  test(`STALECLOSER-03 probe answers ${decision} for ${scenario} without side effects`, async t => {
    const { args, payloads, wakes } = closerResumeFixture(scenario);
    t.after(() => rmSync(args.rootDir, { recursive: true, force: true }));
    const result = await maybeDispatchAmaClosureFor({ ...args, probeCloserAuthoredStale: true });
    assert.equal(result.probe, true);
    assert.equal(result.dispatched, false);
    assert.equal(result.closerAuthoredStale.decision, decision);
    assert.equal(result.closerAuthoredStale.eligible, decision === 'eligible');
    assert.deepEqual(payloads, []);
    assert.deepEqual(wakes, []);
  });
}

for (const scenario of ['MERGEABLE', 'CONFLICTING', 'UNKNOWN', 'null', 'head-moved', 'closed', 'draft']) {
  test(`HAMUNKNOWN-01 background re-read: ${scenario}`, async t => {
    const queue = createAmaHammerBackgroundQueue();
    let reads = 0;
    let dispatches = 0;
    const logs = [];
    const args = closureArgs({
      logger: { log: line => logs.push(line), warn() {} },
      resolveAmaHammerDispatchModeImpl: () => 'background',
      amaHammerBackgroundQueueImpl: () => queue,
      fetchCurrentPrStateImpl: async () => {
        reads += 1;
        if (reads > 1 && scenario === 'null') return null;
        return { state: reads > 1 && scenario === 'closed' ? 'CLOSED' : 'OPEN',
          headSha: reads > 1 && scenario === 'head-moved' ? 'new-head' : HEAD,
          isDraft: reads > 1 && scenario === 'draft',
          mergeable: reads === 1 || ['head-moved', 'closed', 'draft'].includes(scenario) ? 'UNKNOWN' : scenario };
      },
      maybeDispatchAmaCloserImpl: async () => { dispatches += 1; return { dispatched: true }; },
    });
    t.after(() => rmSync(args.rootDir, { recursive: true, force: true }));
    await maybeDispatchAmaClosureFor(args);
    await queue.drain();
    const result = await maybeDispatchAmaClosureFor(args);
    assert.equal(reads, ['UNKNOWN', 'null'].includes(scenario) ? 3 : 2);
    assert.ok(logs.some(line => line.includes(`mergeability_samples=${reads}`) && /mergeability_elapsed_ms=\d+/.test(line)));
    assert.equal(dispatches, ['MERGEABLE', 'CONFLICTING'].includes(scenario) ? 1 : 0);
    if (['UNKNOWN', 'null'].includes(scenario)) {
      assert.equal(result.reason, 'mergeability-unknown');
      assert.equal(result.retryAfterMs, 30_000);
    } else if (['head-moved', 'closed'].includes(scenario)) {
      assert.equal(result.reason, 'background-pr-state-changed');
    } else if (scenario === 'draft') assert.equal(result.reason, 'background-pr-draft');
    else assert.equal(result.dispatched, true);
  });
}


test('pending exact-head orphan request skips repeated stale-tip review and certificate reads', async t => {
  const { args } = closerResumeFixture('green');
  t.after(() => rmSync(args.rootDir, { recursive: true, force: true }));
  args.reviewStateRow = { ...args.reviewStateRow, review_status: 'pending',
    rereview_requested_at: '2026-10-11T00:00:00Z',
    rereview_reason: 'system-orphan-head-review:H1', revision_ref: 'H1' };
  args.fetchHeadCloserVerifiedCommitImpl = async () => assert.fail('pending review owns this tip');
  args.resolveHamTerminalRemediationEvidenceImpl = async () => assert.fail('pending review owns this tip');
  await maybeDispatchAmaClosureFor(args);
});

test('HAMROUTE-01: head-bound proofs and commit reads survive passes and discard changed heads', async () => {
  const { createAmaProofCache } = await import('../src/ama-closure-orchestration.mjs');
  const cache = createAmaProofCache({ maxEntries: 2 });
  const identity = { rootDir: 'fixture', repo: 'example/repo', prNumber: 42,
    reviewedHead: 'reviewed', currentHead: 'current' };
  let reads = 0;
  const prove = async () => ++reads;
  assert.equal(await cache.scope(identity).read('proof', prove), 1);
  assert.equal(await cache.scope(identity).read('proof', prove), 1);
  assert.equal(await cache.scope({ ...identity, currentHead: 'changed' }).read('proof', prove), 2);
  assert.equal(await cache.scope(identity).read('proof', prove), 3);
  await cache.scope({ ...identity, prNumber: 43 }).read('proof', prove);
  await cache.scope({ ...identity, prNumber: 44 }).read('proof', prove);
  assert.equal(await cache.scope(identity).read('proof', prove), 6);
  await cache.scope({ ...identity, prNumber: 43 }).read('proof', prove);
  assert.equal(await cache.scope(identity).read('proof', prove), 6);
  await cache.scope({ ...identity, prNumber: 44 }).read('proof', prove);
  assert.equal(await cache.scope(identity).read('proof', prove), 6, 'hot evidence survives cache pressure');
  assert.equal(reads, 8);
});

test('HAMROUTE-01: a 12-second proof survives the five-second pass deadline with one copy', async t => {
  const { createAmaProofCache, runAmaProofOperation } = await import('../src/ama-closure-orchestration.mjs');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const cache = createAmaProofCache();
  const identity = { rootDir: 'fixture', repo: 'example/repo', prNumber: 42,
    reviewedHead: 'reviewed', currentHead: 'current' };
  let copies = 0;
  let proofSignal;
  const prove = async ({ signal }) => {
    copies++;
    proofSignal = signal;
    await new Promise(resolve => setTimeout(resolve, 12_000));
    return { proven: true };
  };
  const run = () => runAmaProofOperation(cache.scope(identity), 'closer-only-review-delta', prove, { timeoutMs: 5000 });
  const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
  const first = assert.rejects(run(), { code: 'AMA_COEXISTENCE_OPERATION_TIMEOUT' });
  await flush();
  t.mock.timers.tick(5000);
  await first;
  assert.equal(proofSignal.aborted, false);
  const overlapping = assert.rejects(run(), { code: 'AMA_COEXISTENCE_OPERATION_TIMEOUT' });
  await flush();
  t.mock.timers.tick(5000);
  await overlapping;
  assert.equal(copies, 1);
  t.mock.timers.tick(2000);
  await flush();
  assert.deepEqual(await run(), { proven: true });
  assert.equal(copies, 1);
  cache.scope({ ...identity, currentHead: 'changed' });
  assert.equal(proofSignal.aborted, true);
  const changed = runAmaProofOperation(cache.scope({ ...identity, currentHead: 'changed' }),
    'closer-only-review-delta', async () => { copies++; return { proven: false }; }, { timeoutMs: 5000 });
  assert.deepEqual(await changed, { proven: false });
  assert.equal(copies, 2);
});

test('HAMROUTE-01: background classification retries two failed reads and launches in one run', async () => {
  const { resolveOperatorLabelGateFailuresWithRetry } = await import('../src/ama/operator-label-gates.mjs');
  let reads = 0;
  let elapsed = 0;
  let launches = 0;
  const queue = createAmaHammerBackgroundQueue();
  const key = 'example/repo#42@current';
  queue.submit({ key, run: async () => {
    const classification = await resolveOperatorLabelGateFailuresWithRetry({
      repo: 'example/repo', headSha: 'current',
      rollup: [{ name: 'repo-guards', conclusion: 'FAILURE',
        detailsUrl: 'https://github.com/example/repo/actions/runs/1/job/2' }],
      execFileImpl: async () => {
        if (++reads <= 2) throw new Error('synthetic failed job read');
        return { stdout: JSON.stringify({ head_sha: 'current', conclusion: 'failure',
          steps: [{ name: 'Unit tests', conclusion: 'failure' }] }) };
      },
    }, { delaysMs: [20_000, 40_000], sleepImpl: async ms => { elapsed += ms; } });
    assert.equal(classification.inconclusive, false);
    assert.deepEqual(classification.gates, []);
    launches++;
    return { dispatched: true, launchRequestId: 'synthetic-launch' };
  } });
  await queue.drain();
  assert.equal(reads, 3);
  assert.equal(elapsed, 60_000);
  assert.equal(launches, 1);
  assert.equal(queue.takeSettled(key).result.dispatched, true);
});

test('HAMROUTE-01: settled classification wait submits again in the consuming pass', async t => {
  const queue = createAmaHammerBackgroundQueue();
  let runs = 0;
  const args = closureArgs({
    repoPath: 'example/repo', prNumber: 42,
    resolveAmaHammerDispatchModeImpl: () => 'background',
    amaHammerBackgroundQueueImpl: () => queue,
    maybeDispatchAmaCloserImpl: async payload => {
      assert.deepEqual(payload.operatorLabelClassificationRetryDelaysMs, [20_000, 40_000]);
      return ++runs === 1
        ? { dispatched: false, reason: 'operator-label-classification-pending' }
        : { dispatched: true, launchRequestId: 'synthetic-launch' };
    },
  });
  t.after(() => rmSync(args.rootDir, { recursive: true, force: true }));
  await maybeDispatchAmaClosureFor(args);
  await queue.drain();
  const consuming = await maybeDispatchAmaClosureFor(args);
  assert.equal(consuming.reason, AMA_HAMMER_BACKGROUND_REASON);
  await queue.drain();
  assert.equal(runs, 2);
  assert.equal(queue.takeSettled('example/repo#42@' + HEAD).result.dispatched, true);
});

for (const largeEvidenceOnly of [false, true]) {
  test(`HAMROUTE-01: ${largeEvidenceOnly ? 'large PR evidence' : 'traced slow proofs, failed job read and rate limit'} launches within two passes`, async t => {
    const { resolveOperatorLabelGateFailuresWithRetry } = await import('../src/ama/operator-label-gates.mjs');
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.UTC(2026, 0, 1) });
    const startedAt = Date.now();
    const { args } = closerResumeFixture('red');
    t.after(() => rmSync(args.rootDir, { recursive: true, force: true }));
    const queue = createAmaHammerBackgroundQueue();
    const counters = { delta: 0, suppression: 0, evidence: 0, commits: 0, reads: 0, jobs: 0, launches: 0 };
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    Object.assign(args, {
      repoPath: 'example/repo', prNumber: 42, currentRevisionRef: 'current',
      dispatchJob: { ciBlockedHammerOwner: true },
      liveReviewRetryDelaysMs: [],
      resolveAmaHammerDispatchModeImpl: () => 'background', amaHammerBackgroundQueueImpl: () => queue,
      proveCloserAuthoredStaleHeadImpl: async () => {
        counters.delta++;
        if (!largeEvidenceOnly) await sleep(12_000);
        return { proven: true, anchorHead: 'reviewed', reviewedHead: 'reviewed', currentHead: 'current',
          closerCommits: ['current'], reason: 'hammer-app-attestation-chain' };
      },
      resolveHeadCloserCommitSuppressionImpl: async () => {
        counters.suppression++;
        if (!largeEvidenceOnly) await sleep(12_000);
        return { suppressed: true, reason: 'closer-commit-trailer' };
      },
      fetchHeadCloserVerifiedCommitImpl: async () => {
        counters.commits++;
        return { sha: 'current', parentSha: 'reviewed', message: 'Closed-By: hammer' };
      },
      resolveHamTerminalRemediationEvidenceImpl: async () => {
        counters.evidence++;
        if (largeEvidenceOnly) await sleep(12_000);
        return null;
      },
      fetchLatestHeadReviewBodiesImpl: async (_repo, _pr, head) => head === 'reviewed' ? [args.reviewStateRow.review_body] : [],
      fetchCurrentPrStateImpl: async () => {
        if (++counters.reads === 1 && !largeEvidenceOnly) throw new Error('HTTP 429 rate limited');
        return { state: 'OPEN', headSha: 'current', isDraft: false, mergeable: 'MERGEABLE' };
      },
      maybeDispatchAmaCloserImpl: async payload => {
        assert.equal(payload.prMetadata.headSha, 'current');
        const classification = await resolveOperatorLabelGateFailuresWithRetry({
          repo: 'example/repo', headSha: 'current', signal: payload.signal,
          rollup: [{ name: 'repo-guards', conclusion: 'FAILURE',
            detailsUrl: 'https://github.com/example/repo/actions/runs/1/job/2' }],
          execFileImpl: async () => {
            if (++counters.jobs === 1 && !largeEvidenceOnly) throw new Error('synthetic failed job read');
            return { stdout: JSON.stringify({ head_sha: 'current', conclusion: 'failure',
              steps: [{ name: 'External tests', conclusion: 'failure' }] }) };
          },
        }, { delaysMs: payload.operatorLabelClassificationRetryDelaysMs, sleepImpl: sleep });
        assert.equal(classification.inconclusive, false);
        counters.launches++;
        return { dispatched: true, launchRequestId: 'synthetic-launch' };
      },
    });
    args.reviewStateRow = { ...args.reviewStateRow, repo: 'example/repo', pr_number: 42, reviewer_head_sha: 'reviewed' };
    args.candidate = { ...args.candidate, headSha: 'current', prAuthor: 'synthetic-builder' };
    const run = () => resolveMergeAgentCoexistenceForWatcher({ ...args,
      maybeDispatchAmaClosureForImpl: options => maybeDispatchAmaClosureFor({ ...args, ...options }),
      orphanOptions: { now: new Date().toISOString(), hasOwnerImpl: async () => ({ owned: false }),
        pageImpl: async () => assert.fail('waiting cannot exhaust recovery') },
    });
    // Metered GitHub reads also await filesystem I/O. Drain real event-loop
    // turns before advancing the mocked clock so retries schedule at that time.
    const flush = async () => { for (let i = 0; i < 100; i++) await new Promise(resolve => setImmediate(resolve)); };
    const waitFor = async predicate => {
      const deadline = performance.now() + 10_000;
      while (!predicate()) {
        assert.ok(performance.now() < deadline, 'background classification did not reach the expected stage');
        await new Promise(resolve => setImmediate(resolve));
      }
      await flush();
    };
    const first = run();
    await flush();
    t.mock.timers.tick(5000);
    await flush();
    const waiting = await first;
    assert.equal(waiting.outcome, 'ama-pending');
    assert.equal(waiting.amaClosureResult.reason, 'ama-coexistence-operation-timeout');
    assert.equal(waiting.amaClosureResult.nextAction.actor, 'closure-recovery');
    assert.equal(counters.launches, 0, 'unreadable proof is owned recovery');
    // Immutable proof work survives the observer timeout. The second eligible
    // pass consumes it once, without an alternate timeout admission policy.
    t.mock.timers.tick(7000);
    await flush();
    const second = run();
    await flush();
    assert.equal((await second).amaClosureResult.reason, AMA_HAMMER_BACKGROUND_REASON);
    if (!largeEvidenceOnly) {
      await waitFor(() => counters.reads === 1);
      t.mock.timers.tick(1000);
      await waitFor(() => counters.jobs === 1);
      t.mock.timers.tick(20_000);
    }
    await waitFor(() => counters.launches === 1);
    await queue.drain();
    assert.equal(counters.launches, 1);
    assert.ok(Date.now() - startedAt <= 33_000, 'dispatch no longer waits for the slow proof to finish');
    assert.equal(counters.delta, 1);
    assert.equal(counters.suppression, 1);
    assert.equal(counters.evidence, 1);
    assert.equal(queue.takeSettled('example/repo#42@current').result.dispatched, true);
  });
}

test('HAMROUTE-01: a proof has a three-minute background bound and failures can retry', async t => {
  const { createAmaProofCache } = await import('../src/ama-closure-orchestration.mjs');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const scope = createAmaProofCache().scope({ rootDir: 'fixture', repo: 'example/repo',
    prNumber: 42, reviewedHead: 'reviewed', currentHead: 'current' });
  let signal;
  const pending = assert.rejects(scope.read('proof', proofSignal => {
    signal = proofSignal;
    return new Promise(() => {});
  }), { code: 'AMA_COEXISTENCE_OPERATION_TIMEOUT', timeoutMs: 180_000 });
  await Promise.resolve();
  t.mock.timers.tick(180_000);
  await pending;
  assert.equal(signal.aborted, true);
  assert.equal(await scope.read('proof', async () => 'retry-success'), 'retry-success');
});


test('DRAINDEFER-01: background drain settlement re-dispatches on the first clear pass', async t => {
  const queue = createAmaHammerBackgroundQueue();
  let calls = 0;
  const args = closureArgs({
    repoPath: 'example/repo', prNumber: 42,
    resolveAmaHammerDispatchModeImpl: () => 'background',
    amaHammerBackgroundQueueImpl: () => queue,
    maybeDispatchAmaCloserImpl: async () => ++calls === 1
      ? { dispatched: false, skipMergeAgent: true, reason: 'deferred-by-drain', drainEpoch: '7' }
      : { dispatched: true, reason: 'dispatched' },
  });
  t.after(() => rmSync(args.rootDir, { recursive: true, force: true }));
  await maybeDispatchAmaClosureFor(args);
  await queue.drain();
  assert.equal(calls, 1);
  const clearPass = await maybeDispatchAmaClosureFor(args);
  assert.equal(clearPass.reason, AMA_HAMMER_BACKGROUND_REASON);
  await queue.drain();
  assert.equal(calls, 2, 'a settled drain refusal costs no additional pass');
  assert.equal(queue.takeSettled('example/repo#42@' + HEAD).result.dispatched, true);
});


test('TERMLEASE-01: settled background refusal reports its terminal launch blocker', async t => {
  const queue = createAmaHammerBackgroundQueue();
  const events = [];
  const closureBlocker = 'terminal lease from launch synthetic-live still live or unproven (superseded)';
  const args = closureArgs({
    repoPath: 'synthetic/repository', prNumber: 42,
    resolveAmaHammerDispatchModeImpl: () => 'background',
    amaHammerBackgroundQueueImpl: () => queue,
    logger: { log() {}, warn() {}, info: line => events.push(JSON.parse(line)) },
    maybeDispatchAmaCloserImpl: async () => ({ dispatched: false, skipMergeAgent: true,
      reason: 'lease-held', closureBlocker }),
  });
  t.after(() => rmSync(args.rootDir, { recursive: true, force: true }));
  const submitted = await maybeDispatchAmaClosureFor(args);
  assert.equal(submitted.reason, AMA_HAMMER_BACKGROUND_REASON);
  await queue.drain();
  assert.ok(events.some(event => event.event === 'ama.closure_blocker' && event.reason === closureBlocker));
  const result = await resolveMergeAgentCoexistenceForWatcher({ ...args,
    maybeDispatchAmaClosureForImpl: input => maybeDispatchAmaClosureFor({ ...args, ...input }),
  });
  assert.equal(result.amaClosureResult.closureBlocker, closureBlocker);
  assert.equal(events.at(-1).reason, closureBlocker);
});


for (let repeat = 0; repeat < 10; repeat++) {
test(`background settlement carries the executor generation through result copies: ${repeat}`, async t => {
  const queue = createAmaHammerBackgroundQueue();
  let executorShared;
  const args = closureArgs({
    resolveAmaHammerDispatchModeImpl: () => 'background', amaHammerBackgroundQueueImpl: () => queue,
    maybeDispatchAmaCloserImpl: async payload => {
      executorShared = reviseClosureNextAction(payload.sharedNextAction, {
        controls: { stop: { deterministic: true, fingerprint: 'stop-07' } },
      });
      const result = bindClosureNextAction({ dispatched: false, skipMergeAgent: true, reason: 'opaque-07' }, executorShared);
      const oldProjection = { ...result };
      assert.equal(readClosureNextAction(oldProjection), undefined);
      assert.notEqual(payload.sharedNextAction.decision.decisionKey, executorShared.decision.decisionKey,
        'the old result-copy path loses the stop generation on every repetition');
      return result;
    },
  });
  t.after(() => rmSync(args.rootDir, { recursive: true, force: true }));
  await maybeDispatchAmaClosureFor(args);
  await queue.drain();
  const settled = await maybeDispatchAmaClosureFor(args);
  assert.equal(settled.nextAction.decisionKey, executorShared.decision.decisionKey);
  assert.equal(settled.nextAction.actor, 'closure-recovery');
  assert.equal(executorShared.snapshot.observations.controls.value.stop.fingerprint, 'stop-07');
});
}

for (const rekeyed of [false, true]) {
  for (const scenario of ['absent', 'receipt', 'unreadable', 'ambiguous', 'live', 'unknown-process', 'early-absent', 'live-child']) {
    test(`CLOSERINTENTRECON-01 orchestration ${scenario}, rekeyed=${rekeyed}`, async t => {
      let dispatches = 0;
      const args = closureArgs({
        now: () => Date.parse(['live', 'unknown-process', 'early-absent', 'live-child'].includes(scenario) ? intentEarly : intentExpired),
        resolveAmaHammerDispatchModeImpl: () => 'inline',
        probeClosureOwnershipImpl: async () => ({ owned: true, uncertain: true }),
        observeClosureWaitImpl: async () => ({ retryAfterMs: 1000, exhausted: false }),
        fetchMergedProtectiveDependentsImpl: async () => [],
        fetchProtectivePredecessorStateImpl: async () => null,
        maybeDispatchAmaCloserImpl: async () => { dispatches++; return { dispatched: true }; },
      });
      t.after(() => rmSync(args.rootDir, { recursive: true, force: true }));
      const identity = { repo: args.repoPath, prNumber: args.prNumber,
        headSha: rekeyed ? 'b'.repeat(40) : HEAD };
      const f = seedCloserIntent(args.rootDir, identity, { scenario, rekeyedHead: rekeyed ? HEAD : null });
      args.preReceiptIntentOptions = f.options;
      args.closerLeaseLivenessOptions = { isProcessAlive: () => scenario === 'live' ? true : false };
      const result = await maybeDispatchAmaClosureFor(args);
      if (['absent', 'early-absent'].includes(scenario)) {
        assert.equal(f.record().state, 'no-dispatch');
        assert.equal(f.record().retryCount, 1);
        assert.equal(f.lease().status, 'terminal');
        assert.equal(f.lease().terminalOutcome, 'deferred');
        assert.equal(dispatches, 1, 'ordinary admission resumes in the same pass');
      } else {
        assert.equal(result.recoveryWait, true);
        assert.equal(dispatches, 0);
        assert.equal(f.lease().status, scenario === 'receipt' ? 'dispatched' : 'pending');
        assert.equal(f.record().state, scenario === 'receipt' ? 'dispatched' : 'dispatching');
        assert.equal(f.record().retryCount, 2);
        if (scenario === 'receipt') assert.equal(f.lease().lrqId, f.receipt.launch_request_id);
      }
      assert.equal(f.reads(), scenario === 'live' ? 0 : 1, 'one receipt lookup per invocation');
      assert.equal(f.record().lastAttemptedAt, intentStarted);
    });
  }
}

test('CLOSERINTENTRECON-01 orchestration carries an older live pending lease to the current head before reconciliation', async t => {
  const args = closureArgs({
    now: () => Date.parse(intentEarly),
    resolveAmaHammerDispatchModeImpl: () => 'inline',
    probeClosureOwnershipImpl: async () => ({ owned: true, uncertain: true }),
    observeClosureWaitImpl: async () => ({ retryAfterMs: 1000, exhausted: false }),
    maybeDispatchAmaCloserImpl: async () => assert.fail('a live submitter must retain ownership'),
  });
  t.after(() => rmSync(args.rootDir, { recursive: true, force: true }));
  const oldHead = 'b'.repeat(40);
  const f = seedCloserIntent(args.rootDir, { repo: args.repoPath, prNumber: args.prNumber, headSha: oldHead },
    { scenario: 'live' });
  args.preReceiptIntentOptions = f.options;
  args.closerLeaseLivenessOptions = { isProcessAlive: () => true, captureProcessImpl: f.options.captureProcessImpl };
  const result = await maybeDispatchAmaClosureFor(args);
  assert.equal(result.recoveryWait, true);
  assert.equal(result.dispatched, false);
  assert.equal(f.lease(), null, 'the old head is rekeyed before handoffLease is read');
  const current = readAmaCloserLease(args.rootDir, { repo: args.repoPath, prNumber: args.prNumber, headSha: HEAD });
  assert.equal(current.status, 'pending');
  assert.equal(current.rekeyedFromHeadSha, oldHead);
  assert.equal(f.record().state, 'dispatching');
  assert.equal(f.reads(), 0, 'no receipt query for a live submitter within its deadline');
});

for (const reason of ['hammer-validated-head', 'closer-commit-trailer']) {
  test(`HAMVALIDORPHAN-01 ownerless ${reason} wakes and dispatches without carrying a stale verdict`, async t => {
    const { args, wakes, payloads } = closerResumeFixture('worker');
    t.after(() => rmSync(args.rootDir, { recursive: true, force: true }));
    args.resolveHeadCloserCommitSuppressionImpl = async () => ({ suppressed: true, reason, headSha: 'H1' });
    args.headHasValidatedHamTerminalRemediationImpl = () => false;
    const result = await maybeDispatchAmaClosureFor(args);
    assert.equal(result.nextAction.action, 'hammer');
    assert.equal(wakes.length, 1);
    assert.equal(wakes[0].shared.decision.reason, 'hammer-owned-head');
    assert.equal(payloads.length, 1);
    assert.equal(payloads[0].dispatchContext.targetRemediationSha, 'H1');
    assert.equal(payloads[0].dispatchContext.allowStaleReviewHeadHammerResume, true);
    assert.equal(payloads[0].options.hamTerminalRemediation, undefined);
    const probe = await maybeDispatchAmaClosureFor({ ...args, probeCloserAuthoredStale: true });
    assert.equal(probe.closerAuthoredStale.decision, 'hammer-resume');
    assert.equal(probe.closerAuthoredStale.carryForward, false);
    assert.equal(wakes.length, 1, 'rescue probe does not dispatch or wake');
    assert.equal(payloads.length, 1);
  });
}
