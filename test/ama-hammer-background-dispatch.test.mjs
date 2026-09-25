import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AMA_HAMMER_BACKGROUND_REASON,
  amaHammerBackgroundKey,
  createAmaHammerBackgroundQueue,
  resolveAmaHammerDispatchMode,
} from '../src/ama-hammer-background-dispatch.mjs';
import { maybeDispatchAmaClosureFor } from '../src/ama-closure-orchestration.mjs';

function cfgReturning(value) {
  return () => ({ get: (key, fallback) => (value === undefined ? fallback : value) });
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
  assert.equal(resolveAmaHammerDispatchMode({ loadRoleConfigImpl: cfgReturning(undefined) }), 'inline');
});

test('dispatch mode resolves background when configured', () => {
  assert.equal(resolveAmaHammerDispatchMode({ loadRoleConfigImpl: cfgReturning('background') }), 'background');
  assert.equal(resolveAmaHammerDispatchMode({ loadRoleConfigImpl: cfgReturning(' Background ') }), 'background');
});

test('dispatch mode fails safe to inline on an unknown value or a config error', () => {
  assert.equal(resolveAmaHammerDispatchMode({ loadRoleConfigImpl: cfgReturning('async') }), 'inline');
  const warnings = [];
  const mode = resolveAmaHammerDispatchMode({
    loadRoleConfigImpl: () => {
      throw new Error('config.yaml unreadable');
    },
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

// --- End to end through maybeDispatchAmaClosureFor --------------------------

const HEAD = 'abc123';
const SETTLED_BODY =
  '## Summary\nLooks fine.\n\n## Verdict\nComment only\n\n## Blocking Issues\n\n- None.\n\n## Non-blocking Issues\n\n- None.';

function closureArgs(overrides = {}) {
  return {
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
  const result = await maybeDispatchAmaClosureFor(closureArgs({
    resolveAmaHammerDispatchModeImpl: () => 'inline',
    maybeDispatchAmaCloserImpl: async () => {
      calls += 1;
      return { dispatched: true, reason: 'dispatched', launchRequestId: 'lrq_inline' };
    },
  }));
  assert.equal(calls, 1);
  assert.equal(result.dispatched, true);
  assert.equal(result.launchRequestId, 'lrq_inline');
});

test('background mode: a slow hammer dispatch no longer holds the caller, and PR@head is not re-dispatched while in flight', async () => {
  const queue = createAmaHammerBackgroundQueue({ maxConcurrent: 2 });
  const hqDispatch = deferred(); // stands in for a 150 s `hq dispatch`
  const seenSignals = [];
  let calls = 0;
  const logs = [];
  const args = closureArgs({
    logger: { log: (line) => logs.push(line), warn() {} },
    resolveAmaHammerDispatchModeImpl: () => 'background',
    amaHammerBackgroundQueueImpl: () => queue,
    maybeDispatchAmaCloserImpl: async (payload) => {
      calls += 1;
      seenSignals.push(payload.signal);
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
  assert.equal(seenSignals[0], null, 'background run is detached from the posted-review step deadline');

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
});
