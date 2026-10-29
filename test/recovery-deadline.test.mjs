import './helpers/rate-limit-state-isolation.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deriveNextActionSnapshot, nextAction } from '../src/pr-next-action.mjs';
import { resolveClosureNextAction, hasHammerDispatchIntent } from '../src/ama/closure-next-action.mjs';
import { recoverOrphan, overdueNextAction } from '../src/ama/orphan-watchdog.mjs';
import { acquireAmaCloserLease } from '../src/ama/closer-lease.mjs';
import { requestEligibleHammerWake } from '../src/hammer-wake.mjs';
import { resolveMergeAgentCoexistenceForWatcher } from '../src/ama-closure-orchestration.mjs';

const HEAD = 'a'.repeat(40);
const AT = '2026-01-01T00:00:00.000Z';
const DUE = '2026-01-01T00:05:00.000Z';
const identity = { repo: 'example/component', prNumber: 7, headSha: HEAD };
const quiet = { log() {}, info() {}, warn() {} };
const candidate = { headSha: HEAD, prState: 'OPEN', mergeable: 'MERGEABLE' };
const review = { headSha: HEAD, verdict: 'approved', blockingFindingState: 'known', blockingFindingCount: 0,
  nonBlockingFindingState: 'known', nonBlockingFindingCount: 0 };
const receipt = { mergeReceipt: { merged: true, headSha: HEAD, path: 'hammer' } };
function pair(observations = {}, observedAt = DUE) {
  const snapshot = deriveNextActionSnapshot({ subjectKey: 'example/component#7', head: HEAD, observedAt,
    anchors: { firstActionableAt: AT }, observations: {
      pr: { ...candidate, state: 'OPEN' }, reviews: review, checks: { conclusion: 'SUCCESS' },
      remediation: { roundsLeft: false }, leases: { closer: null }, launches: { closer: null },
      policy: { autonomousMergeExecutionEnabled: true }, controls: {}, progress: receipt, ...observations } });
  return { snapshot, decision: nextAction(snapshot) };
}
function fixture(t) {
  const rootDir = mkdtempSync(join(tmpdir(), 'recovery-deadline-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const pages = [], launches = [];
  const run = (shared, options = {}) => recoverOrphan({ rootDir, ...identity, candidate, logger: quiet,
    now: DUE, result: { amaEnabled: true, reason: shared.decision.reason, nextAction: shared.decision },
    dispatchHammer: async evidence => {
      const lease = acquireAmaCloserLease({ rootDir, ...identity, watcherPid: process.pid, now: DUE });
      assert.equal(lease.acquired, true);
      launches.push(evidence);
      return { dispatched: true };
    }, pageImpl: async (...args) => { pages.push(args); return { queued: true }; }, ...options });
  return { rootDir, pages, launches, run };
}

test('RECOVERYDEADLINE-01: a lapsed non-R04 receipt wakes and dispatches hammer once under its lease', async t => {
  const f = fixture(t);
  const before = pair({}, '2026-01-01T00:04:59.999Z');
  assert.equal(before.decision.actor, 'closure-recovery');
  assert.equal(overdueNextAction(before.decision, HEAD, before.snapshot.observedAt), false);
  const shared = pair();
  assert.equal(shared.decision.row, 'R06-merge-receipt');
  assert.equal(hasHammerDispatchIntent(shared, identity), true);
  assert.deepEqual(shared.decision.deadline, before.decision.deadline);
  assert.equal(overdueNextAction(shared.decision, HEAD, DUE), true);
  let wakes = 0;
  const wake = value => requestEligibleHammerWake({ rootDir: f.rootDir, ...identity, shared: value,
    log: quiet, requestWatcherWakeImpl: () => { wakes++; return { requested: true }; } });
  assert.equal(wake(before).outcome, 'skipped');
  assert.equal(wake(shared).outcome, 'requested');
  assert.equal(wake(shared).outcome, 'duplicate');
  assert.equal(wakes, 1);
  assert.equal((await f.run(shared)).outcome, 'ama-dispatched');
  await f.run(shared);
  assert.equal(f.launches.length, 1, 'the real pending lease fences the next wake');
  assert.equal(f.pages.length, 0);
});

for (const [name, observations, row, reason] of [
  ['unreadable owner', { leases: { state: 'error', value: null } }, 'R04-ownership', 'ownership-unreadable'],
  ['unreadable gate after rebase', { progress: { primaryChange: { ok: false, headSha: HEAD,
    reason: 'history-read-failed' } } }, 'R05-structural', 'primary-change-unreadable'],
  ['empty diff', { progress: { diffEmpty: true } }, 'R05-structural', 'empty-diff-close'],
  ['safety input', { controls: { safetyRefusal: { deterministic: true, reason: 'synthetic-input' } } }, 'R05-structural', 'safety-refusal'],
  ['automatic stop', { progress: {}, controls: { stop: { deterministic: true } } }, 'R07-stop', 'automated-stop'],
  ['retry exhaustion', { progress: {}, policy: { autonomousMergeExecutionEnabled: true,
    hammerCap: { retryExhausted: true, headSha: HEAD } } }, 'R07-stop', 'retry-exhausted'],
  ['final no merge', { progress: {}, launches: { closer: { headSha: HEAD, status: 'succeeded',
    retryChain: [], outcome: 'no-merge', retryable: false } } }, 'R07-stop', 'hammer-final-no-merge'],
]) test(`RECOVERYDEADLINE-01: ${name} escalates once at expiry with row, reason and evidence`, async t => {
  const f = fixture(t), shared = pair(observations);
  assert.equal(shared.decision.row, row);
  assert.equal(shared.decision.reason, reason);
  assert.equal(shared.decision.actor, 'closure-recovery');
  for (const now of [DUE, '2026-01-01T00:05:00.001Z', '2026-01-01T03:00:00.000Z']) {
    const result = await f.run(shared, { now, hasOwnerImpl: async () => ({ owned: false }),
      result: { amaEnabled: true, recoveryWait: true, reason: 'gate-read-failed', nextAction: shared.decision } });
    assert.equal(result.outcome, 'recovery-exhausted');
  }
  assert.equal(f.launches.length, 0);
  assert.equal(f.pages.length, 1);
  assert.ok(f.pages[0][0].includes(row));
  assert.ok(f.pages[0][0].includes(reason));
  assert.ok(f.pages[0][0].includes('evidence='));
  assert.deepEqual(f.pages[0][1].payload.nextAction, shared.decision);
});

for (const [name, observations] of [
  ['running retry', { launches: { closer: { headSha: HEAD, status: 'succeeded', retryChain: [{ id: 'retry', status: 'running' }] } } }],
  ['parked retry', { launches: { closer: { headSha: HEAD, status: 'succeeded', retryChain: [{ id: 'retry', status: 'waiting_input' }] } } }],
  ['unknown retry', { launches: { closer: { headSha: HEAD, status: 'succeeded', retryChainUnreadable: true } } }],
  ['unknown ledger', { launches: { state: 'error', value: null } }],
  ['retry cap preceding receipt', { policy: { autonomousMergeExecutionEnabled: true, hammerCap: { retryExhausted: true } } }],
  ['final no-merge preceding receipt', { launches: { closer: { headSha: HEAD, status: 'succeeded', retryChain: [], outcome: 'no-merge', retryable: false } } }],
  ['stop preceding receipt', { controls: { stop: { deterministic: true } } }],
]) test(`RECOVERYDEADLINE-01: ${name} never licenses a recovery launch`, t => {
  const f = fixture(t), shared = pair(observations);
  assert.equal(hasHammerDispatchIntent(shared, identity), false);
  assert.equal(requestEligibleHammerWake({ rootDir: f.rootDir, ...identity, shared, log: quiet,
    requestWatcherWakeImpl: () => assert.fail('fenced evidence cannot wake hammer') }).outcome, 'skipped');
});

test('RECOVERYDEADLINE-01: a live owner within its deadline remains untouched', async t => {
  const f = fixture(t);
  const shared = pair({ launches: { closer: { headSha: HEAD, status: 'running', deadlineAt: '2026-01-01T00:10:00Z' } } });
  assert.equal(shared.decision.row, 'R03-live-owner');
  assert.equal(shared.decision.queue.intent, 'owned');
  assert.equal(await f.run(shared, { hasOwnerImpl: async () => ({ owned: true }) }), null);
  assert.deepEqual([f.pages.length, f.launches.length], [0, 0]);
});

test('RECOVERYDEADLINE-01: unreadable newest absence proof escalates without a speculative launch', async t => {
  const f = fixture(t);
  await f.run(pair(), { hasOwnerImpl: async () => ({ uncertain: true }) });
  assert.equal(f.launches.length, 0);
  assert.equal(f.pages.length, 1);
  assert.match(f.pages[0][0], /ownership-proof-unavailable/);
});

test('RECOVERYDEADLINE-01: failed dispatch and transport refusal stay visible and page once', async t => {
  const f = fixture(t);
  let sends = 0;
  const options = { hasOwnerImpl: async () => ({ owned: false }),
    dispatchHammer: async () => ({ dispatched: false, reason: 'synthetic-needs-input' }),
    pageImpl: async (...args) => { sends++; if (sends === 1) return { queued: false, status: 'failed' };
      f.pages.push(args); return { queued: true }; } };
  for (let i = 0; i < 3; i++) await f.run(pair(), options);
  assert.equal(sends, 2);
  assert.equal(f.pages.length, 1);
  assert.match(f.pages[0][0], /dispatch-refused:synthetic-needs-input/);
});

for (const labelNames of [[], ['merge-agent-requested']]) test('RECOVERYDEADLINE-01: real closure resolution and watcher route escalate the non-R04 gate failure on its first due wake', async t => {
  const f = fixture(t), pages = f.pages;
  const shared = await resolveClosureNextAction({ input: { currentHead: HEAD, reviewState: review,
    checks: 'SUCCESS', roundsLeft: false, lease: null }, candidate, rootDir: f.rootDir,
    passSnapshot: pair({ progress: { primaryChange: { ok: false, reason: 'history-read-failed', headSha: HEAD } } }).snapshot,
    subjectKey: 'example/component#7', autonomousMergeExecutionEnabled: true, observedAt: DUE });
  assert.equal(shared.decision.row, 'R05-structural');
  for (let i = 0; i < 2; i++) {
    const result = await resolveMergeAgentCoexistenceForWatcher({ rootDir: f.rootDir,
      repoPath: identity.repo, prNumber: identity.prNumber, currentRevisionRef: HEAD, candidate, labelNames, logger: quiet,
      mergeAgentRequestEvent: { applied: true, observedRevisionRef: HEAD },
      maybeDispatchAmaClosureForImpl: async () => ({ amaEnabled: true, dispatched: false,
        recoveryWait: true, nextAction: shared.decision, reason: 'gate-read-failed' }),
      orphanOptions: { now: DUE, hasOwnerImpl: async () => ({ owned: false }),
        pageImpl: async (...args) => { pages.push(args); return { queued: true }; } } });
    assert.equal(result.outcome, 'recovery-exhausted');
  }
  assert.equal(pages.length, 1);
  assert.equal(pages[0][1].payload.nextAction.row, 'R05-structural');
});

for (const policy of [
  { drain: { active: true } }, { capacity: { hammer: { inFlight: 1, cap: 1 } } },
]) test(`RECOVERYDEADLINE-01: deferred overdue admission pages once (${JSON.stringify(policy)})`, async t => {
  const f = fixture(t), shared = pair({ policy: { autonomousMergeExecutionEnabled: true, ...policy } });
  assert.equal(shared.decision.actor, 'hammer');
  assert.ok(shared.decision.queue.deferredBy);
  await f.run(shared);
  await f.run(shared);
  assert.deepEqual([f.launches.length, f.pages.length], [0, 1]);
});

test('RECOVERYDEADLINE-01: a readable terminal launch outranks a stale dispatched lease', () => {
  const shared = pair({ leases: { closer: { status: 'dispatched', headSha: HEAD, lrqId: 'synthetic-attempt', deadlineAt: '2026-01-01T01:00:00Z' } },
    launches: { closer: { headSha: HEAD, launchRequestId: 'synthetic-attempt', status: 'succeeded', retryChain: [], outcome: 'no-merge', retryable: true } } });
  assert.equal(shared.decision.row, 'R06-merge-receipt');
  assert.equal(hasHammerDispatchIntent(shared, identity), true);
});

test('RECOVERYDEADLINE-01: expired launchless lease uses the same rule as a non-R04 receipt', () => {
  const shared = pair({ leases: { closer: { status: 'pending', headSha: HEAD, deadlineAt: AT } }, progress: {} });
  assert.equal(shared.decision.row, 'R04-ownership');
  assert.equal(shared.decision.reason, 'lease-expired');
  assert.equal(hasHammerDispatchIntent(shared, identity), true);
});

test('RECOVERYDEADLINE-01: string and object hold labels fence expired receipts and leases at selection', () => {
  for (const source of ['pr', 'controls', 'candidate']) {
    for (const label of ['do-not-merge', { name: 'do-not-merge' },
      { name: 'do-not-merge', actorKind: 'automation' }]) {
      for (const recovery of [{}, {
        leases: { closer: { status: 'pending', headSha: HEAD, deadlineAt: AT } }, progress: {},
      }]) {
        const shared = pair({ ...recovery, [source]: { ...candidate, state: 'OPEN', labels: [label] } });
        assert.equal(hasHammerDispatchIntent(shared, identity), false);
        assert.equal(shared.decision.actor, label.actorKind ? 'closure-recovery' : 'operator');
        if (label.actorKind) assert.equal(shared.decision.queue.intent, 'reconcile');
        else assert.equal(shared.decision.reason, 'hold-label');
      }
    }
  }
});

for (const [deadline, anchor] of [
  [{ anchoredAt: AT, at: DUE }, AT],
  [{ at: DUE }, DUE],
  [{ anchoredAt: null, at: DUE }, DUE],
  [{}, 'unanchored'],
]) test(`RECOVERYDEADLINE-01: wake audit anchor falls back deterministically (${JSON.stringify(deadline)})`, t => {
  const f = fixture(t), shared = pair();
  const synthetic = { ...shared, decision: { ...shared.decision,
    deadline: { class: 'recovery', ...deadline } } };
  let wakes = 0;
  const wake = () => requestEligibleHammerWake({ rootDir: f.rootDir, ...identity, shared: synthetic,
    log: quiet, requestWatcherWakeImpl: () => { wakes++; return { requested: true }; } });
  const result = wake();
  assert.equal(result.outcome, 'requested');
  const audit = JSON.parse(readFileSync(result.auditPath, 'utf8'));
  assert.equal(audit.wakeAttemptKey, `recovery:R06-merge-receipt:merge-receipt-unconfirmed:${anchor}:initial`);
  assert.equal(wake().outcome, 'duplicate');
  assert.equal(wakes, 1);
});

test('RECOVERYDEADLINE-01: earlier ordinary wakes cannot swallow expiry, and completed recovery launches rearm once', t => {
  const f = fixture(t);
  let wakes = 0;
  const wake = shared => requestEligibleHammerWake({ rootDir: f.rootDir, ...identity, shared, log: quiet,
    requestWatcherWakeImpl: () => { wakes++; return { requested: true }; } });
  assert.equal(wake(pair({ progress: {} }, AT)).outcome, 'requested');
  assert.equal(wake(pair()).outcome, 'requested');
  assert.equal(wake(pair()).outcome, 'duplicate');
  for (const launchRequestId of ['synthetic-first', 'synthetic-second']) {
    const shared = pair({ launches: { closer: { headSha: HEAD, launchRequestId,
      status: 'succeeded', retryChain: [], outcome: 'no-merge', retryable: true } } });
    assert.equal(wake(shared).outcome, 'requested');
    assert.equal(wake(shared).outcome, 'duplicate');
  }
  assert.equal(wakes, 4);
});

test('RECOVERYDEADLINE-01: an automated hold label cannot hide its recovery deadline or permit dispatch', async t => {
  const f = fixture(t);
  const shared = pair({ progress: {}, controls: { labels: [{ name: 'do-not-merge', actorKind: 'automation' }] } });
  assert.equal(shared.decision.row, 'R07-stop');
  for (let i = 0; i < 2; i++) await f.run(shared, { labels: ['do-not-merge'] });
  assert.deepEqual([f.launches.length, f.pages.length], [0, 1]);
  // A newly observed hold also fences a previously selected hammer recovery.
  await f.run(pair(), { labels: ['do-not-merge'] });
  assert.equal(f.launches.length, 0);
});
