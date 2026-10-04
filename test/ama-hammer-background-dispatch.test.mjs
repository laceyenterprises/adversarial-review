import test from 'node:test';
import { acquireAmaCloserLease, isHeldAmaCloserLease, updateAmaCloserLease } from '../src/ama/closer-lease.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  AMA_HAMMER_BACKGROUND_REASON,
  amaHammerBackgroundQueue,
  amaHammerBackgroundKey,
  createAmaHammerBackgroundQueue,
  resetAmaHammerBackgroundQueueForTests,
  resolveAmaHammerDispatchMode,
} from '../src/ama-hammer-background-dispatch.mjs';
import { maybeDispatchAmaClosureFor, resolveMergeAgentCoexistenceForWatcher } from '../src/ama-closure-orchestration.mjs';

function cfgReturning(value) {
  return { get: (key, fallback) => (value === undefined ? fallback : value) };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

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
        prNumber: 265 + index,
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
      repo: 'laceyenterprises/adversarial-review',
      pr_number: 265,
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
    repoPath: 'laceyenterprises/adversarial-review',
    prNumber: 265,
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
    ...overrides,
  };
}

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
      reasons: ['risk-class-not-permitted'],
    }),
  }));
  assert.equal(result.needsOperator, true);
  assert.equal(result.operatorReason, 'not-eligible:risk-class-not-permitted');
  assert.equal(result.retryAfterMs, undefined);
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
  assert.equal(first.backgroundDispatch.key, `laceyenterprises/adversarial-review#265@${HEAD}`);
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
    logs.some((line) => /AMA hammer background dispatch settled for .*#265@abc123: dispatched=true/.test(line)),
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
      expect: { reason: 'background-pr-mergeable-unknown', mergeable: 'UNKNOWN', retryAfterMs: 30_000 },
    },
    {
      live: { state: 'OPEN', headSha: HEAD, isDraft: false, mergeable: '' },
      expect: { reason: 'background-pr-not-mergeable', mergeable: null, retryAfterMs: 30_000 },
    },
  ];
  for (const { live, expect } of cases) {
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
    assert.equal(closerCalls, 0);
    const settled = await maybeDispatchAmaClosureFor(args);
    assert.equal(settled.dispatched, false);
    assert.equal(settled.skipMergeAgent, true);
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
    assert.equal(closerCalls, 1, `${live.mergeable}/${live.mergeStateStatus || ''} reaches the closer`);
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
  const inline = await maybeDispatchAmaClosureFor(closureArgs({
    resolveAmaHammerDispatchModeImpl: () => 'inline',
    maybeDispatchAmaCloserImpl: async () => ({ ...rejection }),
  }));

  const queue = createAmaHammerBackgroundQueue();
  let calls = 0;
  const args = closureArgs({
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
  assert.deepEqual(second, inline, 'applied outcome is byte-identical to the inline result');
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

test('#7681: scoped primary-change recovery applies a settled refusal without another run', async () => {
  const queue = createAmaHammerBackgroundQueue();
  let calls = 0;
  const args = closureArgs({
    resolveAmaHammerDispatchModeImpl: () => 'background',
    amaHammerBackgroundQueueImpl: () => queue,
    maybeDispatchAmaCloserImpl: async () => {
      calls += 1;
      return { dispatched: false, skipMergeAgent: true, needsOperator: true,
        reason: 'primary-change-repair-required' };
    },
  });
  await maybeDispatchAmaClosureFor(args);
  await queue.drain();
  const result = await resolveMergeAgentCoexistenceForWatcher({
    ...args, labelNames: ['merge-agent-requested'],
    mergeAgentRequestEvent: scopedEvent(),
    maybeDispatchAmaClosureForImpl: (input) => maybeDispatchAmaClosureFor({ ...args, ...input }),
  });
  assert.equal(result.outcome, 'dispatch-merge-agent');
  assert.deepEqual(result.dispatchEnv, { AMA_OPERATOR_MERGE_AGENT_OVERRIDE: 'true' });
  assert.equal(calls, 1, 'the applying tick does not rerun the closer');
  assert.deepEqual(queue.snapshot().settledKeys, []);
});

function scopedEvent(headSha = HEAD) {
  return { id: 'operator-event', actor: 'operator', headSha, createdAt: '2026-10-04T13:56:00Z' };
}

for (const headSha of [HEAD, 'previous-head']) {
  test(`scoped request preserves live closer ownership at ${headSha}`, async (t) => {
    const args = closureArgs();
    t.after(() => rmSync(args.rootDir, { recursive: true, force: true }));
    acquireAmaCloserLease({ rootDir: args.rootDir, repo: args.repoPath,
      prNumber: args.prNumber, headSha, watcherPid: process.pid });
    for (const skipMergeAgent of [true, false]) {
      const result = await resolveMergeAgentCoexistenceForWatcher({
        ...args, labelNames: ['merge-agent-requested'], mergeAgentRequestEvent: scopedEvent(),
        maybeDispatchAmaClosureForImpl: async () => ({
          amaEnabled: true, dispatched: false, skipMergeAgent, needsOperator: true, reason: 'primary-change-repair-required',
        }),
        recoverAmaAutomationImpl: async () => assert.fail('a live lease retains ownership'),
      });
      assert.equal(result.outcome, 'ama-pending');
      assert.equal(result.coexistence.action, 'ama-closer-pending');
      assert.equal(result.dispatchEnv, undefined);
    }
  });
}

for (const headSha of [HEAD, 'previous-head', null]) {
  test(`unknown dispatch status retains ownership with expired or absent lease at ${headSha}`, async (t) => {
    const args = closureArgs();
    t.after(() => rmSync(args.rootDir, { recursive: true, force: true }));
    if (headSha) {
      const identity = { repo: args.repoPath, prNumber: args.prNumber, headSha };
      const now = new Date(Date.now() - 31 * 60 * 1000).toISOString();
      acquireAmaCloserLease({ rootDir: args.rootDir, ...identity, watcherPid: process.pid, now });
      updateAmaCloserLease({ rootDir: args.rootDir, ...identity,
        status: 'dispatched', lrqId: 'lrq-still-unknown', now });
      assert.equal(isHeldAmaCloserLease(args.rootDir, identity), false);
    }
    const result = await resolveMergeAgentCoexistenceForWatcher({
      ...args, labelNames: ['merge-agent-requested'], mergeAgentRequestEvent: scopedEvent(),
      maybeDispatchAmaClosureForImpl: async () => ({ amaEnabled: true, dispatched: false,
        skipMergeAgent: true, reason: 'dispatch-status-unknown' }),
      recoveryOptions: {
        dispatchHammer: async () => assert.fail('unknown dispatch status must not launch another hammer'),
        pageImpl: async () => assert.fail('unknown dispatch status is an ordinary ownership wait'),
      },
    });
    assert.equal(result.outcome, 'ama-pending');
    assert.equal(result.recovery.action, 'in-progress');
    assert.equal(result.dispatchEnv, undefined);
  });
}

for (const corrupt of [false, true]) {
  for (const { reason, needsOperator, outcome } of [
    { reason: 'daemon-merged', outcome: 'pr-terminal' },
    { reason: 'security-hold', needsOperator: true, outcome: 'await-operator' },
  ]) {
    test(`${reason} keeps recovery routing with a ${corrupt ? 'corrupt' : 'live'} closer lease`, async (t) => {
      const args = closureArgs();
      t.after(() => rmSync(args.rootDir, { recursive: true, force: true }));
      const { leasePath } = acquireAmaCloserLease({ rootDir: args.rootDir, repo: args.repoPath,
        prNumber: args.prNumber, headSha: 'previous-head', watcherPid: process.pid });
      if (corrupt) writeFileSync(leasePath, '{broken');
      const result = await resolveMergeAgentCoexistenceForWatcher({
        ...args, labelNames: ['merge-agent-requested'], mergeAgentRequestEvent: scopedEvent(),
        maybeDispatchAmaClosureForImpl: async () => ({ amaEnabled: true, dispatched: false,
          skipMergeAgent: true, needsOperator, reason }),
        recoveryOptions: { pageImpl: async () => assert.fail('terminal/safety results do not page recovery') },
      });
      assert.equal(result.outcome, outcome);
      assert.equal(result.dispatchEnv, undefined);
    });
  }
}

for (const { labelNames, remediationPending } of [
  { labelNames: [], remediationPending: false },
  { labelNames: ['merge-agent-requested'], remediationPending: true },
  { labelNames: ['merge-agent-requested', 'no-merge-hold'], remediationPending: false },
]) {
  test(`eligibility recovery shares scoped predicate: labels=${labelNames} remediation=${remediationPending}`, async (t) => {
    const args = closureArgs();
    t.after(() => rmSync(args.rootDir, { recursive: true, force: true }));
    let recovered = false;
    const result = await resolveMergeAgentCoexistenceForWatcher({
      ...args, labelNames, mergeAgentRequestEvent: scopedEvent(),
      reviewStateRow: { ...args.reviewStateRow, remediation_pending: remediationPending },
      maybeDispatchAmaClosureForImpl: async () => ({ amaEnabled: true, dispatched: false,
        reason: 'not-eligible', reasons: ['ci-not-green'] }),
      recoverAmaAutomationImpl: async () => { recovered = true; return { outcome: 'ama-pending' }; },
    });
    assert.equal(recovered, true, 'a scoped event alone must not skip automated recovery');
    assert.equal(result.outcome, 'ama-pending');
  });
}

for (const hold of [
  { reason: 'risk-class-not-permitted' },
  { reason: 'security-hold' },
  { reason: 'destructive-migration' },
  { reason: 'label-no-merge-hold' },
  { reason: 'two-key' },
  { reason: 'hammer-retry-cap-suppressed', needsOperator: true },
  { reason: 'not-eligible', reasons: ['risk-class-not-permitted'], needsOperator: true },
]) {
  test(`scoped label cannot bypass ${hold.reason}`, async (t) => {
    const args = closureArgs();
    t.after(() => rmSync(args.rootDir, { recursive: true, force: true }));
    for (const skipMergeAgent of [true, false]) {
      const result = await resolveMergeAgentCoexistenceForWatcher({
        ...args, labelNames: ['merge-agent-requested'], mergeAgentRequestEvent: scopedEvent(),
        maybeDispatchAmaClosureForImpl: async () => ({ amaEnabled: true, dispatched: false,
          skipMergeAgent, ...hold }),
        recoveryOptions: { pageImpl: async () => assert.fail('safety holds do not page recovery') },
      });
      assert.equal(result.outcome, 'await-operator');
      assert.equal(result.dispatchEnv, undefined);
    }
  });
}

for (const reason of ['primary-change-needs-operator', 'primary-change-repair-required']) {
  test(`scoped request may recover ${reason} without a live lease`, async (t) => {
    const args = closureArgs();
    t.after(() => rmSync(args.rootDir, { recursive: true, force: true }));
    const aborted = [];
    const run = (labelNames, event = scopedEvent()) => resolveMergeAgentCoexistenceForWatcher({
      ...args, labelNames, mergeAgentRequestEvent: event,
      amaHammerBackgroundQueueImpl: () => ({ abort: (key) => aborted.push(key) }),
      maybeDispatchAmaClosureForImpl: async () => ({ amaEnabled: true, dispatched: false,
        skipMergeAgent: true, reason, needsOperator: reason.startsWith('primary-change') }),
      recoverAmaAutomationImpl: async ({ result }) => ({
        outcome: 'await-operator', amaClosureResult: result,
      }),
    });
    assert.equal((await run(['merge-agent-requested'])).outcome, 'dispatch-merge-agent');
    assert.deepEqual(aborted, [`${args.repoPath}#${args.prNumber}@${HEAD}`]);
    for (const stop of ['no-merge-hold', 'do-not-merge', 'merge-agent-skip',
      'adversarial-merge-blocked', 'merge-agent-stuck', 'duplicate-family-hold']) {
      assert.notEqual((await run(['merge-agent-requested', stop])).outcome, 'dispatch-merge-agent');
    }
    assert.notEqual((await run(['merge-agent-requested'], scopedEvent('old-head'))).outcome, 'dispatch-merge-agent');
    assert.equal(aborted.length, 1, 'blocked and stale requests do not abort work');
  });
}

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
    recoveryOptions: { pageImpl: async () => assert.fail('safety holds do not page recovery') },
  });
  for (let cycle = 0; cycle < 3; cycle += 1) {
    assert.equal((await run()).outcome, 'ama-pending');
    await queue.drain();
    assert.equal((await run()).outcome, 'await-operator');
  }
  assert.equal(calls, 3);
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
