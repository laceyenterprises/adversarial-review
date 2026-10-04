import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseReviewFindings } from '../src/kernel/review-findings.mjs';
import { normalizeFindingsCount } from '../src/reviewed-attestation.mjs';
import { classifyBlockingFindings, classifyNonBlockingFindings } from '../src/merge-agent-review-classification.mjs';
import { recoverAmaAutomation, automatedHammerReasonsCovered } from '../src/ama/automated-recovery.mjs';
import { reconcileRecoveryLaunches } from '../src/ama/recovery-launch-reconciliation.mjs';
import { resolveMergeAgentCoexistenceForWatcher } from '../src/ama-closure-orchestration.mjs';
import { __testables__ } from '../src/ama/dispatch-closer.mjs';

for (const [name, blocking, nonBlocking] of [
  ['ar-1208-2026-10-03T2323.md', 0, 11],
  ['comment-only-merge-eligible.md', 0, 0],
  ['request-changes-blocker-missing-category.md', 1, 0],
]) {
  test(`shared counts and identities: ${name}`, () => {
    const body = readFileSync(new URL(`./fixtures/review-bodies/${name}`, import.meta.url), 'utf8');
    const parsed = parseReviewFindings(body);
    assert.deepEqual(classifyBlockingFindings(body), { count: blocking, state: 'known' });
    assert.deepEqual(classifyNonBlockingFindings(body), { count: nonBlocking, state: 'known' });
    assert.equal(parsed.blocking.count, blocking);
    assert.equal(parsed.nonBlocking.count, nonBlocking);
    assert.equal(normalizeFindingsCount(body), blocking + nonBlocking);
    assert.equal(parsed.findingsCount, blocking + nonBlocking);
  });
}

test('malformed missing sections fail closed, nested fields are not findings', () => {
  assert.equal(normalizeFindingsCount('## Verdict\nComment only'), null);
  const body = '## Blocking issues\n- None.\n## Non-blocking issues\n- **A**\n  - **File:** a\n  - **Lines:** 1\n  - **Problem:** broken\n- **B**\n  - **File:** b\n  - **Lines:** 2\n  - **Problem:** broken';
  assert.equal(normalizeFindingsCount(body), 2);
  assert.equal(normalizeFindingsCount(body.replaceAll('\n', '\r\n')), 2);
});

function harness(t, result, overrides = {}) {
  const rootDir = mkdtempSync(join(tmpdir(), 'amafind-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const calls = { rereview: [], hammer: 0, page: [], events: [] };
  const args = { rootDir, repo: 'fixture/repo', prNumber: 1, headSha: 'head', result,
    reviewStateRow: { review_status: 'posted', posted_at: 'first-pass' },
    requestRereviewImpl: async (options) => { calls.rereview.push(options); return { triggered: true }; },
    dispatchHammer: async () => { calls.hammer += 1; return { dispatched: true }; },
    pageImpl: async (...args) => { calls.page.push(args); },
    logger: { error: (event) => calls.events.push(JSON.parse(event)), warn() {}, log() {} },
    ...overrides };
  return { args, calls };
}

test('stale head requeues current head via CAS, never hammer or operator', async (t) => {
  const { args, calls } = harness(t, { reason: 'not-eligible', reasons: ['stale-review-head'] });
  assert.equal((await recoverAmaAutomation(args)).recovery.action, 'rereview');
  assert.equal(calls.rereview[0].targetRevisionRef, 'head');
  assert.equal(calls.hammer, 0);
});

test('unknown findings rereview once, pending pass owns row, then hammer', async (t) => {
  const { args, calls } = harness(t, { reason: 'not-eligible', reasons: ['blocking-findings-unknown', 'verdict-not-settled-success'] });
  assert.equal((await recoverAmaAutomation(args)).recovery.action, 'rereview');
  const pending = await recoverAmaAutomation({ ...args, reviewStateRow: { review_status: 'reviewing' } });
  assert.equal(pending.recovery.attempts, 1);
  assert.equal((await recoverAmaAutomation(args)).outcome, 'ama-pending', 'old posted snapshot cannot race the requested pass');
  assert.equal((await recoverAmaAutomation({ ...args, reviewStateRow: { review_status: 'posted', posted_at: 'second-pass' } })).outcome, 'ama-dispatched');
  assert.equal(calls.rereview.length, 1);
  assert.equal(calls.hammer, 1);
});

test('strict non-blocking findings dispatch hammer without changing merge safety', async (t) => {
  const { args, calls } = harness(t, { reason: 'not-eligible', reasons: ['non-blocking-findings-present', 'verdict-not-settled-success'] });
  assert.equal((await recoverAmaAutomation(args)).outcome, 'ama-dispatched');
  assert.equal(calls.hammer, 1);
  for (const reason of ['stale-review-head', 'risk-class-not-permitted', 'label-security-hold', 'branch-protection-missing-gate', 'worker-identity-unresolved']) {
    assert.equal(automatedHammerReasonsCovered(['non-blocking-findings-present', reason]), false);
  }
  assert.equal(__testables__.isHammerRouteStructurallyBlocked(['label-do-not-merge']), true);
});

for (const ownershipReason of ['remediation-pending', 'remediation-state-unknown', 'blocking-findings-present']) {
  test(`watcher recovery cannot preempt follow-up ownership: ${ownershipReason}`, async (t) => {
    const reasons = ['verdict-not-settled-success', ownershipReason, 'ci-not-green'];
    const result = { amaEnabled: true, skipMergeAgent: true, reason: 'not-eligible', reasons };
    const { args, calls } = harness(t, result);
    assert.equal(automatedHammerReasonsCovered(reasons), false);
    const input = { rootDir: args.rootDir, repoPath: args.repo, prNumber: 1, currentRevisionRef: 'head',
      reviewStateRow: { ...args.reviewStateRow, verdict: 'Request changes' },
      candidate: { prState: 'open' }, dispatchJob: {}, logger: args.logger,
      recoveryOptions: { pageImpl: args.pageImpl, requestRereviewImpl: args.requestRereviewImpl },
      maybeDispatchAmaClosureForImpl: async (options) => {
        if (options.automatedRecovery) { calls.hammer += 1; return { dispatched: true }; }
        return result;
      } };
    for (let i = 0; i < 5; i += 1) {
      const waiting = await resolveMergeAgentCoexistenceForWatcher(input);
      assert.equal(waiting.outcome, 'ama-pending');
      assert.equal(waiting.recovery.action, 'await-remediation');
    }
    assert.equal(calls.hammer, 0);
    assert.equal(calls.rereview.length, 0);
    assert.equal(calls.page.length, 0, 'waiting for follow-up must not exhaust recovery');
    // Once the ordinary closer proves exhaustion and ownership release,
    // terminal remediation remains reachable on the next tick.
    assert.equal((await resolveMergeAgentCoexistenceForWatcher({ ...input,
      maybeDispatchAmaClosureForImpl: async () => ({ dispatched: true }),
    })).outcome, 'ama-dispatched');
  });
}

for (const reason of ['label-do-not-merge', 'risk-class-not-permitted', 'two-key-high-risk', 'security-hold', 'destructive-migration', 'primary-change-needs-operator', 'branch-protection-missing-gate', 'fast-merge-state-unsupported', 'pr-is-draft', 'current-head-ham-terminal-remediation-needs-operator']) {
  test(`safety holds retain operator adjudication: ${reason}`, async (t) => {
    const { args, calls } = harness(t, { reason: 'not-eligible', reasons: [reason] });
    assert.equal((await recoverAmaAutomation(args)).outcome, 'await-operator');
    assert.equal(calls.hammer + calls.rereview.length + calls.page.length, 0);
  });
}

test('wall-clock exhaustion persists one SEV1 event independent of tick count', async (t) => {
  let time = 0;
  const { args, calls } = harness(t, { reason: 'not-eligible', reasons: ['worker-identity-unresolved'] },
    { now: () => time, stuckDeadlineMs: 1000 });
  for (let i = 0; i < 10; i += 1) assert.equal((await recoverAmaAutomation(args)).outcome, 'ama-pending');
  time = 1000;
  for (let i = 0; i < 3; i += 1) assert.equal((await recoverAmaAutomation(args)).outcome, 'recovery-exhausted');
  assert.equal(calls.page.length, 1);
  assert.equal(calls.events.length, 1);
  assert.deepEqual(calls.events[0], { event: 'ama.automated_recovery.exhausted', severity: 'SEV1',
    reason: 'not-eligible', reasons: ['worker-identity-unresolved'], repo: 'fixture/repo', pr: 1, head: 'head', attempts: 0 });
  assert.equal((await recoverAmaAutomation({ ...args, headSha: 'new-head' })).recovery.attempts, 0);
});

test('watcher shared router retries closure with recovery flag and protects terminal PRs', async (t) => {
  const result = { amaEnabled: true, skipMergeAgent: true, reason: 'not-eligible', reasons: ['non-blocking-findings-present'] };
  const { args, calls } = harness(t, result);
  const input = { rootDir: args.rootDir, repoPath: args.repo, prNumber: 1, currentRevisionRef: 'head',
    reviewStateRow: args.reviewStateRow, candidate: { prState: 'open' }, dispatchJob: {},
    logger: args.logger, recoveryOptions: { pageImpl: args.pageImpl, requestRereviewImpl: args.requestRereviewImpl },
    maybeDispatchAmaClosureForImpl: async (options) => {
      if (options.automatedRecovery) { calls.hammer += 1; return { dispatched: true }; }
      return result;
    } };
  assert.equal((await resolveMergeAgentCoexistenceForWatcher(input)).outcome, 'ama-dispatched');
  assert.equal(calls.hammer, 1);
  for (const prState of ['merged', 'closed']) {
    assert.equal((await resolveMergeAgentCoexistenceForWatcher({ ...input, candidate: { prState } })).outcome, 'pr-terminal');
  }
  assert.equal(calls.hammer, 1);
});

test('phantom launch reclaimed, live or unreadable launches remain held', async (t) => {
  const { args } = harness(t, {});
  const dispatchPath = join(args.rootDir, 'record.json');
  const record = { repo: args.repo, prNumber: 1, headSha: 'head', launchRequestId: 'lrq', dispatchPath, state: 'dispatched' };
  writeFileSync(dispatchPath, JSON.stringify(record));
  const input = { rootDir: args.rootDir, logger: args.logger, listActiveImpl: () => [record],
    isPhantomImpl: (row) => row.pid === 0,
    readStatusImpl: async () => ({ ok: true, row: { status: 'running', pid: 0 } }) };
  assert.deepEqual(await reconcileRecoveryLaunches(input), { reclaimed: 1, active: 0, uncertain: 0 });
  assert.equal(JSON.parse(readFileSync(dispatchPath)).lastObservedStatus, 'failed');
  assert.deepEqual(await reconcileRecoveryLaunches({ ...input, readStatusImpl: async () => ({ ok: false }) }), { reclaimed: 0, active: 0, uncertain: 1 });
  assert.deepEqual(await reconcileRecoveryLaunches({ ...input, readStatusImpl: async () => ({ ok: true, row: { status: 'running', pid: 123 } }) }), { reclaimed: 0, active: 1, uncertain: 0 });
});

test('live launches spend no recovery budget; uncertain launch reads exhaust loudly', async (t) => {
  const { args, calls } = harness(t, { reason: 'ama-closer-launch-in-progress' }, {
    reclaimLaunch: async () => ({ active: 1, reclaimed: 0, uncertain: 0 }),
  });
  for (let i = 0; i < 5; i += 1) {
    const waiting = await recoverAmaAutomation(args);
    assert.equal(waiting.recovery.action, 'active-launch');
    assert.equal(waiting.recovery.attempts, 0);
  }
  let time = 0;
  const uncertain = { ...args, now: () => time, stuckDeadlineMs: 1000,
    reclaimLaunch: async () => ({ active: 0, reclaimed: 0, uncertain: 1 }) };
  for (let i = 0; i < 10; i += 1) await recoverAmaAutomation(uncertain);
  time = 1000;
  assert.equal((await recoverAmaAutomation(uncertain)).outcome, 'recovery-exhausted');
  assert.equal(calls.page.length, 1);
});

test('concurrent recovery calls cannot duplicate a re-review or dispatch a hammer before it settles', async (t) => {
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  const { args, calls } = harness(t, { reason: 'not-eligible', reasons: ['blocking-findings-unknown'] }, {
    requestRereviewImpl: async () => { await blocked; return { triggered: true }; },
  });
  const first = recoverAmaAutomation(args);
  await new Promise((resolve) => setImmediate(resolve));
  const second = await recoverAmaAutomation(args);
  assert.equal(second.recovery.action, 'recovery-in-progress');
  assert.equal(calls.hammer, 0);
  release();
  await first;
});

function watcherInput(args, result, dispatchHammer = args.dispatchHammer) {
  return { rootDir: args.rootDir, repoPath: args.repo, prNumber: args.prNumber,
    currentRevisionRef: args.headSha, reviewStateRow: args.reviewStateRow,
    candidate: { prState: 'open' }, dispatchJob: {}, logger: args.logger,
    recoveryOptions: { pageImpl: args.pageImpl, requestRereviewImpl: args.requestRereviewImpl,
      now: args.now, stuckDeadlineMs: args.stuckDeadlineMs },
    maybeDispatchAmaClosureForImpl: async (options) => options.automatedRecovery ? dispatchHammer() : result };
}

for (const reason of ['hammer-closer-in-flight', 'lease-held', 'live-run-in-flight',
  'active-remediation-job', 'ama-closer-dispatch-backgrounded', 'dispatch-status-unknown',
  'closer-lease-held-by-other-process', 'daemon-deferred', 'deferred']) {
  test(`watcher preserves budget for in-flight ownership across ticks: ${reason}`, async (t) => {
    let time = 0;
    const result = { amaEnabled: true, skipMergeAgent: true, reason };
    const { args, calls } = harness(t, result, { now: () => time });
    for (let tick = 0; tick < 8; tick += 1) {
      time += 60 * 60 * 1000;
      const waiting = await resolveMergeAgentCoexistenceForWatcher(watcherInput(args, result));
      assert.equal(waiting.outcome, 'ama-pending');
      assert.equal(waiting.recovery.attempts, 0);
    }
    assert.equal(calls.hammer + calls.rereview.length + calls.page.length, 0);
  });
}

for (const retry of [
  { reason: 'not-eligible', recoveryWait: 'comment-only-grace' },
  { reason: 'not-eligible', commentOnlyFinalRoundAwaitingCi: true },
  { reason: 'active-remediation-job' },
  { reason: 'ama-closer-dispatch-backgrounded' },
  { reason: 'daemon-failed-closed', daemonCleanMerge: { disposition: 'deferred' } },
]) {
  test(`refused recovery hammer spends no attempts: ${retry.recoveryWait || retry.reason}`, async (t) => {
    let time = 0;
    const result = { amaEnabled: true, skipMergeAgent: true,
      reason: 'not-eligible', reasons: ['non-blocking-findings-present'] };
    const { args, calls } = harness(t, result, { now: () => time });
    const input = watcherInput(args, result, async () => retry);
    for (let tick = 0; tick < 8; tick += 1) {
      time += 60 * 1000;
      const waiting = await resolveMergeAgentCoexistenceForWatcher(input);
      assert.equal(waiting.outcome, 'ama-pending');
      assert.equal(waiting.recovery.attempts, 0);
      assert.equal(waiting.recovery.blockedSince, undefined);
    }
    assert.equal(calls.page.length, 0);
    assert.equal((await resolveMergeAgentCoexistenceForWatcher(watcherInput(args, result))).outcome, 'ama-dispatched');
    assert.equal(calls.hammer, 1, 'dispatch remains reachable once ordinary admission clears');
  });
}

test('unclassified hammer refusal expires by wall clock without burning attempts', async (t) => {
  let time = 0;
  const { args, calls } = harness(t, { reason: 'not-eligible', reasons: ['non-blocking-findings-present'] },
    { now: () => time, stuckDeadlineMs: 1000, dispatchHammer: async () => ({ dispatched: false, reason: 'gate-read-failed' }) });
  for (let tick = 0; tick < 8; tick += 1) {
    const waiting = await recoverAmaAutomation(args);
    assert.equal(waiting.outcome, 'ama-pending');
    assert.equal(waiting.recovery.attempts, 0);
  }
  time = 1000;
  assert.equal((await recoverAmaAutomation(args)).outcome, 'recovery-exhausted');
  assert.equal(calls.page.length, 1);
});

test('observed ownership clears a prior stall deadline', async (t) => {
  let time = 0;
  const { args, calls } = harness(t, { reason: 'not-eligible', reasons: ['worker-identity-unresolved'] },
    { now: () => time, stuckDeadlineMs: 1000 });
  await recoverAmaAutomation(args);
  time = 900;
  await recoverAmaAutomation({ ...args, result: { reason: 'hammer-closer-in-flight' } });
  time = 1000;
  assert.equal((await recoverAmaAutomation(args)).outcome, 'ama-pending');
  assert.equal(calls.page.length, 0);
});

test('recovery cap follows the job round budget, not watcher tick count', async (t) => {
  let time = 0;
  const result = { amaEnabled: true, skipMergeAgent: true,
    reason: 'not-eligible', reasons: ['non-blocking-findings-present'] };
  const { args, calls } = harness(t, result, { now: () => time, stuckDeadlineMs: 1000 });
  const input = { ...watcherInput(args, result), dispatchJob: { remediationPlan: { maxRounds: 4 } } };
  for (let tick = 0; tick < 4; tick += 1) {
    assert.equal((await resolveMergeAgentCoexistenceForWatcher(input)).outcome, 'ama-dispatched');
  }
  assert.equal((await resolveMergeAgentCoexistenceForWatcher(input)).outcome, 'ama-pending');
  assert.equal(calls.hammer, 4);
  time = 1000;
  assert.equal((await resolveMergeAgentCoexistenceForWatcher(input)).outcome, 'recovery-exhausted');
  assert.equal(calls.page.length, 1);
});

for (const code of ['ABORT_ERR', 'AMA_COEXISTENCE_ABORTED', 'AMA_COEXISTENCE_OPERATION_TIMEOUT']) {
  test(`recovery rethrows ${code} without spending attempts`, async (t) => {
    const error = Object.assign(new Error(code), { code });
    const { args, calls } = harness(t, { reason: 'not-eligible', reasons: ['non-blocking-findings-present'] },
      { dispatchHammer: async () => { throw error; } });
    await assert.rejects(recoverAmaAutomation(args), (err) => err === error);
    const waiting = await recoverAmaAutomation({ ...args, result: { reason: 'hammer-closer-in-flight' } });
    assert.equal(waiting.recovery.attempts, 0);
    assert.equal(calls.page.length, 0);
  });
}

for (const review_status of ['pending', 'reviewing', 'pending-upstream']) {
  test(`queued rereview remains owned after the recovery deadline: ${review_status}`, async (t) => {
    let time = 0;
    const { args, calls } = harness(t, { reason: 'not-eligible', reasons: ['blocking-findings-unknown'] },
      { now: () => time, rereviewDeadlineMs: 1000 });
    await recoverAmaAutomation(args);
    time = 5000;
    const waiting = await recoverAmaAutomation({ ...args, reviewStateRow: { review_status } });
    assert.equal(waiting.outcome, 'ama-pending');
    assert.equal(waiting.recovery.attempts, 1);
    assert.equal(calls.page.length, 0);
  });
}

test('explicit configuration/operator holds do not page or dispatch', async (t) => {
  const { args, calls } = harness(t, { reason: 'dispatch-suppressed', needsOperator: true });
  for (let tick = 0; tick < 8; tick += 1) assert.equal((await recoverAmaAutomation(args)).outcome, 'await-operator');
  assert.equal(calls.hammer + calls.rereview.length + calls.page.length, 0);
});

test('action errors consume only the action cap and wait for elapsed failure before paging', async (t) => {
  let time = 0;
  let dispatches = 0;
  const { args, calls } = harness(t, { reason: 'not-eligible', reasons: ['non-blocking-findings-present'] }, {
    now: () => time, stuckDeadlineMs: 1000, maxAttempts: 2,
    dispatchHammer: async () => { dispatches += 1; throw new Error('dispatch failed'); },
  });
  assert.equal((await recoverAmaAutomation(args)).recovery.attempts, 1);
  assert.equal((await recoverAmaAutomation(args)).recovery.attempts, 2);
  for (let tick = 0; tick < 8; tick += 1) assert.equal((await recoverAmaAutomation(args)).outcome, 'ama-pending');
  assert.equal(dispatches, 2);
  assert.equal(calls.page.length, 0);
  time = 1000;
  assert.equal((await recoverAmaAutomation(args)).outcome, 'recovery-exhausted');
  assert.equal(calls.page.length, 1);
});

test('caller cancellation with a custom reason propagates without budget burn', async (t) => {
  const controller = new AbortController();
  const error = new Error('caller stopped');
  const { args } = harness(t, { reason: 'not-eligible', reasons: ['non-blocking-findings-present'] }, {
    signal: controller.signal,
    dispatchHammer: async () => { controller.abort(error); throw error; },
  });
  await assert.rejects(recoverAmaAutomation(args), (err) => err === error);
  const waiting = await recoverAmaAutomation({ ...args, signal: null, result: { reason: 'hammer-closer-in-flight' } });
  assert.equal(waiting.recovery.attempts, 0);
});
