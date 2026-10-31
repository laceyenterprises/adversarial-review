import { recordHammerRetryDispatch, markHammerRetryCapExhausted, readHammerRetryCapLedger,
  updateHammerRetryCapLedger } from '../src/ama/hammer-retry-cap.mjs';
import './helpers/rate-limit-state-isolation.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { syncBuiltinESMExports } from 'node:module';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deriveNextActionSnapshot, NEXT_ACTION_DEADLINE_MS, nextAction } from '../src/pr-next-action.mjs';
import { resolveSharedNextAction } from '../src/pr-next-action-shadow.mjs';
import classifyRescue from '../src/merge-agent-rescue-classifier.mjs';
import { routeToHammerOwner } from '../src/hammer-owner-route.mjs';
import { dispatchReadTransport } from '../src/dispatch-read-client.mjs';
import { launchSource } from '../src/pr-next-action-consumer.mjs';
import { closureOwnerFromDecision, hasHammerDispatchIntent, observeClosureResult, observeClosureOwnership,
  resolveClosureNextAction, revalidateClosurePr, reviseClosureNextAction, readClosureNextAction, observeDaemonGate } from '../src/ama/closure-next-action.mjs';
import { migrationRenumberFixture } from './helpers/migration-renumber.mjs';
import { proveMigrationRenumbers } from '../src/ama/migration-renumber.mjs';
import { maybeDispatchAmaClosureFor, resolveMergeAgentCoexistenceForWatcher } from '../src/ama-closure-orchestration.mjs';
import { reviewCeilingOwner } from '../src/review-ceiling-owner.mjs';
import { observeClosureWait, CLOSURE_WAIT_BOUND_MS, CLOSURE_WAIT_RETRY_MS } from '../src/ama/closure-wait.mjs';
import { followUpJobFilePrefix } from '../src/follow-up-job-names.mjs';
import { getFollowUpJobDir } from '../src/follow-up-jobs.mjs';
import { writeAmaAuditEntry } from '../src/ama/audit.mjs';
import { evaluateHammerStopHold } from '../src/ama/hammer-stop-hold.mjs';
import { maybeDispatchAmaCloser } from '../src/ama/dispatch-closer.mjs';
import { recordNoProgressLaneRun, readNoProgressLane, evaluateNoProgressLane } from '../src/watcher-no-progress-lane.mjs';

const HEAD = 'a'.repeat(40), OLD = 'b'.repeat(40), OTHER = 'c'.repeat(40);
const AT = '2026-01-01T00:00:00.000Z';
const quiet = { log() {}, warn() {}, error() {} };
const identity = { repo: 'subject-05', prNumber: 5, headSha: HEAD };
const clean = { verdict: 'approved', headSha: HEAD, blockingFindingState: 'known', blockingFindingCount: 0,
  nonBlockingFindingState: 'known', nonBlockingFindingCount: 0 };
function base(observations = {}) {
  return deriveNextActionSnapshot({ subjectKey: 'subject-05#5', head: HEAD, observedAt: AT,
    anchors: { firstActionableAt: AT }, observations: {
      pr: { headSha: HEAD, state: 'OPEN', mergeable: 'MERGEABLE', labels: [] },
      reviews: clean, checks: { conclusion: 'SUCCESS' }, remediation: { roundsLeft: false },
      leases: { closer: null }, launches: { closer: null },
      policy: { autonomousMergeExecutionEnabled: true, strictMode: true }, ...observations } });
}
const pair = snapshot => Object.freeze({ snapshot, decision: nextAction(snapshot) });
const tuple = decision => [decision.action, decision.actor, decision.reason];

test('RECOVERYSTALL-01: closure-wait migrates a paged receipt, serializes reminders and refunds failed delivery', async t => {
  const rootDir = root(t), dir = join(rootDir, 'data', 'ama-closure-waits');
  mkdirSync(dir, { recursive: true });
  const key = createHash('sha256').update(`${identity.repo}#${identity.prNumber}`).digest('hex');
  const db = new Database(join(dir, `${key}.db`));
  db.exec('CREATE TABLE waits_by_class (head TEXT, class TEXT, started INTEGER NOT NULL, reason TEXT, paged INTEGER DEFAULT 0, PRIMARY KEY(head,class))');
  db.prepare('INSERT INTO waits_by_class VALUES (?,?,?,?,1)').run(HEAD, 'closure-recovery-deadline', 0, 'synthetic');
  db.close();
  let now = 1000, fail = false, pages = 0;
  const observe = () => observeClosureWait({ rootDir, ...identity, now, immediate: true,
    waitClass: 'closure-recovery-deadline', reason: 'synthetic unreadable custody', repeatAfterMs: 6000,
    pageImpl: async () => { if (fail) throw Error('synthetic refused page'); pages++; } });
  await Promise.all([observe(), observe()]);
  assert.equal(pages, 1);
  now += 5999;
  assert.equal((await observe()).notify, false);
  now++;
  fail = true;
  await assert.rejects(observe(), /synthetic refused page/);
  fail = false;
  assert.equal((await observe()).notify, true);
  assert.equal((await observe()).notify, false);
  assert.equal(pages, 2);
});

test('a proven renumber replaces primary-change repair with an auditable passing observation', async () => {
  const f = migrationRenumberFixture();
  f.evidence.headSha = HEAD;
  f.evidence.ciCost.headSha = HEAD;
  f.evidence.migrationRenumberProofs = await proveMigrationRenumbers(f.args, f.evidence);
  const selected = pair(base({ progress: { primaryChange: { ok: false,
    reason: 'primary-change-reverted', headSha: HEAD } } }));
  const fresh = observeDaemonGate(selected, { candidateHead: HEAD, prState: 'OPEN', mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN', requiredChecks: true, labels: [], primaryChange: f.evidence });
  const primary = fresh.snapshot.observations.progress.value.primaryChange;
  assert.equal(primary.ok, true);
  assert.deepEqual(primary.derivedChanges, f.evidence.migrationRenumberProofs);
  assert.equal(fresh.decision.action, 'daemon-merge');
});
function root(t) {
  const value = mkdtempSync(join(tmpdir(), 'nxa-closer-'));
  t.after(() => rmSync(value, { recursive: true, force: true }));
  return value;
}

for (const [name, timestamps] of [
  ['camelCase', { recordedAt: AT }],
  ['snake_case', { recorded_at: AT }],
  ['null camelCase fallback', { recordedAt: null, recorded_at: AT }],
  ['camelCase precedence', { recordedAt: AT, recorded_at: '2026-01-01T00:01:00.000Z' }],
]) test(`STOPSTALE-01: closure projects the ${name} stop time and routes newer exact-head evidence to daemon`, async () => {
  const later = '2026-01-01T00:00:30.000Z';
  const hammerStop = { headSha: HEAD, ...timestamps, stopKey: `${HEAD}:2:${AT}`, predicate: 'synthetic-unattested-head' };
  const input = { currentHead: HEAD, reviewState: { ...clean, verdict: 'comment-only',
    nonBlockingFindingCount: 2, postedAt: later }, strictMode: false, hammerStop,
    lease: null, roundsLeft: false, checks: 'SUCCESS', lifetimeExhausted: true, retryExhausted: true };
  const shared = await resolveClosureNextAction({ input,
    passSnapshot: base({ launches: { closer: { headSha: HEAD, status: 'succeeded', outcome: 'no-merge', retryable: false } } }),
    candidate: { headSha: HEAD, prState: 'OPEN', mergeable: 'MERGEABLE' },
    autonomousMergeExecutionEnabled: true, observedAt: later });
  assert.equal(shared.snapshot.observations.controls.value.stop.recordedAt, AT);
  assert.deepEqual(tuple(shared.decision), ['daemon-merge', 'daemon', 'clean-exact-head']);
  assert.equal(closureOwnerFromDecision(shared.decision).owner, 'daemon-merge');
  assert.equal(hasHammerDispatchIntent(shared, identity), false);
  assert.ok(shared.decision.evidenceRefs.includes('stop-superseded-by-exact-head-review'));

  const observed = observeClosureResult(shared, { hammerStop });
  assert.equal(observed.snapshot.observations.controls.value.stop.fingerprint, hammerStop.stopKey);
  assert.equal(observed.snapshot.observations.controls.value.stop.recordedAt, AT);
  assert.equal(observed.decision.action, 'daemon-merge');
  const red = reviseClosureNextAction(observed, { checks: { conclusion: 'FAILURE' } });
  assert.equal(red.decision.reason, 'automated-stop');
  assert.equal(hasHammerDispatchIntent(red, identity), false);
  const blocked = reviseClosureNextAction(observed, { reviews: { ...input.reviewState, blockingFindingCount: 1 } });
  assert.equal(blocked.decision.reason, 'automated-stop');
  assert.equal(hasHammerDispatchIntent(blocked, identity), false);
});

test('hammer intent fails closed when a matching decision has no queue', () => {
  const selected = pair(base({ checks: { conclusion: 'FAILURE' } }));
  for (const queue of [undefined, null]) {
    assert.equal(hasHammerDispatchIntent({ ...selected, decision: { ...selected.decision, queue } }, identity), false);
  }
});

for (const progress of [
  { contentProof: { kind: 'context-only-rebase', semantic: true, fromHead: OLD, toHead: HEAD } },
  { closerAuthoredStale: { carryForward: true, reviewedHead: OLD, currentHead: HEAD } },
]) test(`clean ${Object.keys(progress)[0]} survives the review ceiling with exact-head proof`, () => {
  const observations = { reviews: { ...clean, headSha: OLD }, progress,
    policy: { autonomousMergeExecutionEnabled: true, strictMode: true, reviewCeilingReached: true } };
  assert.deepEqual(tuple(pair(base(observations)).decision), ['daemon-merge', 'daemon', 'carried-clean-head']);
  const invalid = Object.fromEntries(Object.entries(progress).map(([key, proof]) =>
    [key, { ...proof, toHead: OTHER, currentHead: OTHER }]));
  assert.deepEqual(tuple(pair(base({ ...observations, progress: invalid })).decision), ['hammer', 'hammer', 'review-ceiling']);
  assert.equal(pair(base({ ...observations, reviews: { ...observations.reviews, blockingFindingCount: 1,
    verdict: 'request-changes' } })).decision.action, 'hammer');
});

test('stop evaluation returns the same recovery generation that its page reports', async t => {
  const shared = pair(base({ checks: { conclusion: 'FAILURE' } }));
  const pages = [];
  const result = await evaluateHammerStopHold({ rootDir: root(t), hqRoot: 'unused', ...identity,
    sharedNextAction: shared, prMetadata: { headSha: HEAD }, now: AT,
    readAuditImpl: () => ({ attempts: [{ head: HEAD, path: 'hammer', outcome: 'failed-without-merge',
      reason: 'verdict-not-eligible', startedAt: AT }] }),
    deliverAlertImpl: async (_text, options) => pages.push(options), logger: quiet });
  assert.equal(result.action, 'hold');
  assert.equal(result.nextActionShared.decision.actor, 'closure-recovery');
  assert.equal(result.nextActionShared.decision, pages[0].payload.nextAction);
  assert.ok(result.nextActionShared.snapshot.generation > shared.snapshot.generation);
  assert.equal(shared.decision.actor, 'hammer');
});

test('closure invalidates an earlier wake decision when round evidence changes', async () => {
  const passSnapshot = base({ reviews: { ...clean, headSha: OLD } });
  const options = { passSnapshot, subjectKey: 'subject-05#5', observedAt: AT,
    candidate: { headSha: HEAD, prState: 'OPEN', mergeable: 'MERGEABLE' },
    autonomousMergeExecutionEnabled: true,
    input: { currentHead: HEAD, reviewState: { ...clean, headSha: OLD }, lease: null,
      roundsLeft: true, checks: 'SUCCESS' } };
  const first = await resolveClosureNextAction(options);
  assert.equal(first.decision.action, 'review');
  const next = await resolveClosureNextAction({ ...options,
    input: { ...options.input, roundsLeft: false, reviewCeilingReached: true } });
  assert.equal(next.decision.action, 'hammer');
  assert.ok(next.snapshot.generation > (first.snapshot.generation || 0));
  assert.equal(first.decision.action, 'review');
  assert.equal(await resolveSharedNextAction({ passSnapshot }), next);
});

for (const attested of [false, true]) {
  for (const reviewCeilingReached of [false, true]) {
    test(`CEILINGOWNER-01: explicit head-bound review agrees with admission, attested=${attested}, ceiling=${reviewCeilingReached}`, async () => {
      const reviewAdmissionRow = { review_status: 'posted', reviewer_head_sha: OLD,
        ...(reviewCeilingReached ? { rereview_reason: 'system-review-ceiling-closure' } : {}) };
      const shared = await resolveClosureNextAction({
        input: { reviewState: { ...clean, headSha: OLD }, currentHead: HEAD, attested,
          closerAuthoredStale: { decision: 'rereview-exact-head', reviewedHead: OLD, currentHead: HEAD },
          reviewAdmissionRow, lease: null, roundsLeft: false, checks: 'SUCCESS' },
        candidate: { headSha: HEAD, prState: 'OPEN', mergeable: 'MERGEABLE' },
        autonomousMergeExecutionEnabled: true, observedAt: AT,
      });
      const owner = reviewCeilingOwner({ row: reviewAdmissionRow, headSha: HEAD });
      assert.equal(shared.decision.actor, owner);
      assert.deepEqual(tuple(shared.decision), reviewCeilingReached
        ? ['hammer', 'hammer', 'review-ceiling'] : ['review', 'reviewer', 'exact-head-review']);
    });
  }
}

test('CEILINGOWNER-01: injected refused-review ownership records once and escalates through the bounded closure wait', async t => {
  const rootDir = root(t), records = [], pages = [];
  // Existing ordinary and explicitly named closure waits must not consume the
  // admission diagnostic's first observation, clock or page receipt.
  const priorStartedAt = Date.parse(AT) - 1_000;
  for (const waitClass of [null, 'closure']) {
    await observeClosureWait({ rootDir, ...identity, now: priorStartedAt, waitClass,
      reason: 'existing closure wait', pageImpl: async () => assert.fail('prior wait must not page') });
  }
  const reviewStateRow = { review_status: 'posted', reviewer_head_sha: OLD,
    rereview_reason: 'system-review-ceiling-closure' };
  // Simulate a stale producer still running the old below-ceiling policy.
  const shared = pair(base({ reviews: { ...clean, headSha: OLD }, progress: {
    closerAuthoredStale: { decision: 'rereview-exact-head', reviewedHead: OLD, currentHead: HEAD },
  } }));
  assert.equal(shared.decision.action, 'review');
  for (const elapsed of [0, 1_000, CLOSURE_WAIT_BOUND_MS, CLOSURE_WAIT_BOUND_MS + 1]) {
    const now = Date.parse(AT) + elapsed;
    const result = await resolveMergeAgentCoexistenceForWatcher({ rootDir,
      repoPath: identity.repo, prNumber: identity.prNumber, currentRevisionRef: HEAD,
      candidate: { headSha: HEAD, prState: 'open' }, labelNames: [], reviewStateRow,
      logger: { ...quiet, warn: line => records.push(JSON.parse(line)) },
      maybeDispatchAmaClosureForImpl: async () => ({ amaEnabled: true, dispatched: false,
        nextAction: shared.decision, reason: 'handed-to-review' }),
      recoverOrphanImpl: async () => assert.fail('a refused actor must not enter review request/backoff'),
      orphanOptions: { now, observeClosureWaitImpl: options => observeClosureWait({ ...options,
        pageImpl: async message => pages.push(message) }) },
    });
    assert.equal(result.amaClosureResult.reason, 'next-action-contract-violation');
    assert.equal(result.amaClosureResult.boundedWait.startedAt, Date.parse(AT));
    assert.equal(result.amaClosureResult.retryAfterMs, CLOSURE_WAIT_RETRY_MS);
    assert.equal(result.outcome, elapsed >= CLOSURE_WAIT_BOUND_MS ? 'await-operator' : 'ama-pending');
    assert.equal(Boolean(result.amaClosureResult.needsOperator), elapsed >= CLOSURE_WAIT_BOUND_MS);
    assert.equal(result.urgent, elapsed < CLOSURE_WAIT_BOUND_MS);
  }
  assert.equal(records.length, 1, 'durable first observation dedupes the contract record across ticks');
  assert.equal(records[0].event, 'ama.next_action.contract_violation');
  assert.equal(records[0].actor, 'reviewer');
  assert.equal(pages.length, 1, 'the existing closure-wait page receipt dedupes exhaustion');
  assert.match(pages[0], /next-action-contract-violation/);
  const key = createHash('sha256').update(`${identity.repo}#${identity.prNumber}`).digest('hex');
  const db = new Database(join(rootDir, 'data', 'ama-closure-waits', `${key}.db`), { readonly: true });
  try {
    const rows = db.prepare('SELECT class, started, reason, paged FROM waits_by_class WHERE head=? ORDER BY class').all(HEAD);
    assert.deepEqual(rows, [
      { class: 'actor-admission', started: Date.parse(AT),
        reason: `next-action-contract-violation: actor=reviewer head=${HEAD} admission=review-ceiling`, paged: 1 },
      { class: 'bounded-wait', started: priorStartedAt, reason: 'existing closure wait', paged: 0 },
      { class: 'closure', started: priorStartedAt, reason: 'existing closure wait', paged: 0 },
    ]);
  } finally { db.close(); }
});

for (const reason of ['retrigger-review: synthetic request', `system-orphan-head-review:${HEAD}`]) {
  test(`CEILINGOWNER-01: existing explicit review exception is shared for ${reason.split(':')[0]}`, async () => {
    const row = { rereview_reason: reason, rereview_requested_at: AT, revision_ref: HEAD };
    assert.equal(reviewCeilingOwner({ row, headSha: HEAD, ceilingReached: true }), 'reviewer');
    assert.equal(reviewCeilingOwner({ row: { ...row, rereview_requested_at: null },
      headSha: HEAD, ceilingReached: true }), 'hammer');
    if (reason.startsWith('system-orphan-head-review:')) {
      assert.equal(reviewCeilingOwner({ row, headSha: OTHER, ceilingReached: true }), 'hammer');
    }
    const shared = await resolveClosureNextAction({ input: {
      reviewState: { ...clean, headSha: OLD }, currentHead: HEAD, reviewAdmissionRow: row,
      reviewCeilingReached: true, lease: null, roundsLeft: false, checks: 'SUCCESS',
      closerAuthoredStale: { decision: 'rereview-exact-head', reviewedHead: OLD, currentHead: HEAD },
    }, candidate: { headSha: HEAD, prState: 'OPEN', mergeable: 'MERGEABLE' },
    autonomousMergeExecutionEnabled: true, observedAt: AT });
    assert.deepEqual(tuple(shared.decision), ['review', 'reviewer', 'exact-head-review']);
  });
}

test('existing operator approval keeps exact-head and actor policy before daemon admission', () => {
  const approval = { applied: true, actor: 'operator-05', eventId: 'event-05',
    observedAt: AT, observedRevisionRef: HEAD };
  const observations = { pr: { state: 'OPEN', headSha: HEAD, mergeable: 'MERGEABLE', labels: ['operator-approved'] },
    reviews: { ...clean, verdict: null, operatorApprovedEvidence: approval },
    policy: { autonomousMergeExecutionEnabled: true, operatorLogins: ['operator-05'] } };
  assert.equal(pair(base(observations)).decision.action, 'daemon-merge');
  for (const evidence of [{ ...approval, observedRevisionRef: OLD }, { ...approval, actor: 'unlisted-05' }]) {
    assert.equal(pair(base({ ...observations, reviews: { ...observations.reviews,
      operatorApprovedEvidence: evidence } })).decision.action, 'review');
  }
  assert.equal(pair(base({ ...observations, reviews: { ...observations.reviews,
    attestation: 'invalid' } })).decision.action, 'review');
  assert.equal(pair(base({ ...observations, controls: { safetyRefusal: { deterministic: true } } })).decision.actor,
    'closure-recovery');
});

test('watchdog ownership observations retain the discovered owner without a launch', () => {
  const first = pair(base({ reviews: { ...clean, headSha: OLD } }));
  const live = observeClosureOwnership(first, { owned: true, actor: 'hammer', launchRequestId: 'launch-05',
    launchProbe: { ok: true, row: { status: 'running' } } });
  assert.equal(live.decision.actor, 'hammer');
  assert.equal(live.decision.queue.intent, 'owned');
  assert.equal(hasHammerDispatchIntent(live, identity), false);
  for (const owner of [{ owned: true }, { uncertain: true }]) {
    const next = observeClosureOwnership(first, owner);
    assert.equal(next.decision.actor, 'closure-recovery');
    assert.equal(next.decision.queue.intent, 'reconcile');
  }
  assert.equal(first.decision.action, 'review');
});

for (const [name, observation, expected] of [
  ['terminal success without merge', { state: 'complete', value: { terminal: true, launch: { status: 'succeeded' } } }, 'retry-no-merge'],
  ['pending retry', { state: 'complete', value: { launch: { status: 'succeeded' }, retryChain: [{ status: 'requested' }] } }, 'live-owner'],
  ['live retry', { state: 'complete', value: { launch: { status: 'succeeded' }, retryChain: [{ status: 'running' }] } }, 'live-owner'],
  ['terminal retry', { state: 'complete', value: { terminal: true, launch: { status: 'failed' }, retryChain: [{ status: 'failed' }] } }, 'retry-no-merge'],
  ['unreadable retries', { state: 'complete', value: { terminal: true, launch: { status: 'succeeded' }, retryChainUnreadable: true } }, 'ownership-unreadable'],
  ['unreadable launch', { state: 'error', value: null }, 'ownership-unreadable'],
]) test(`closer consumer: ${name}`, async () => {
  const lease = { status: 'dispatched', lrqId: 'launch-05', headSha: HEAD, acquiredAt: AT };
  const shared = await resolveClosureNextAction({
    input: { reviewState: clean, currentHead: HEAD, lease, roundsLeft: false, checks: 'SUCCESS' },
    passSnapshot: base(), subjectKey: 'subject-05#5', observedAt: AT,
    candidate: { headSha: HEAD, prState: 'OPEN', mergeable: 'MERGEABLE' },
    autonomousMergeExecutionEnabled: true,
    readLaunches: async () => launchSource(observation, lease, {}),
  });
  assert.equal(shared.decision.reason, expected);
  assert.equal(shared.decision.actor, expected === 'ownership-unreadable' ? 'closure-recovery' : 'hammer');
  assert.equal(closureOwnerFromDecision(shared.decision).actor, shared.decision.actor);
  assert.notEqual(shared.decision.action, 'done');
});

test('sticky succeeded receipt reconciles remote state; only confirmed termination is done', () => {
  const shared = pair(base({ progress: { mergeReceipt: { merged: true, path: 'hammer', headSha: HEAD } } }));
  assert.deepEqual(tuple(shared.decision), ['hammer', 'closure-recovery', 'merge-receipt-unconfirmed']);
  for (const state of ['MERGED', 'CLOSED']) {
    const observed = reviseClosureNextAction(shared, { pr: { headSha: HEAD, state } });
    assert.equal(observed.decision.action, 'done');
  }
  assert.equal(pair(base({ progress: { diffEmpty: true } })).decision.actor, 'closure-recovery');
});

test('drain and configured capacity retain semantic intent and its deadline', () => {
  const selected = pair(base({ checks: { conclusion: 'FAILURE' } }));
  const draining = observeClosureResult(selected, { reason: 'deferred-by-drain', drainEpoch: 'epoch-05' });
  const saturated = observeClosureResult(selected, { capacity: { workerClass: 'hammer', inFlight: 7, cap: 7 } });
  for (const [shared, by] of [[draining, 'drain'], [saturated, 'capacity']]) {
    assert.deepEqual(tuple(shared.decision), tuple(selected.decision));
    assert.equal(shared.decision.queue.intent, 'dispatch');
    assert.equal(shared.decision.queue.deferredBy, by);
    assert.deepEqual(shared.decision.deadline, selected.decision.deadline);
    assert.equal(shared.decision.decisionKey, selected.decision.decisionKey);
  }
  const clear = reviseClosureNextAction(draining, { policy: selected.snapshot.observations.policy.value });
  assert.equal(clear.decision.queue.deferredBy, null);
  assert.equal(hasHammerDispatchIntent(clear, identity), true);
  assert.equal(hasHammerDispatchIntent(clear, { ...identity, headSha: OTHER }), false);
  assert.equal(hasHammerDispatchIntent(clear, { ...identity, repo: 'subject-06' }), false);
  assert.equal(hasHammerDispatchIntent(clear, { ...identity, prNumber: 6 }), false);
});

test('changed evidence publishes a new generation for subsequent pass consumers', async () => {
  const pass = base();
  const initial = await resolveClosureNextAction({ input: { reviewState: clean, currentHead: HEAD,
    lease: null, roundsLeft: false, checks: 'SUCCESS' }, passSnapshot: pass,
    candidate: { headSha: HEAD, prState: 'OPEN', mergeable: 'MERGEABLE' },
    autonomousMergeExecutionEnabled: true });
  const changed = reviseClosureNextAction(initial, { checks: { conclusion: 'FAILURE' } }, pass);
  assert.equal((await resolveSharedNextAction({ passSnapshot: pass })).decision, changed.decision);
  assert.equal(changed.decision.generation, initial.decision.generation + 1);
  assert.equal(initial.decision.action, 'daemon-merge');
  assert.equal(changed.decision.action, 'hammer');
  assert.ok(Object.isFrozen(changed.snapshot));
  assert.equal(changed.decision.deadline.anchoredAt, AT);
});

test('deterministic safety stop precedes conflicting/red repair and retains recovery', () => {
  const selected = pair(base({ pr: { headSha: HEAD, state: 'OPEN', mergeable: 'CONFLICTING' },
    checks: { conclusion: 'FAILURE' } }));
  const stopped = observeClosureResult(selected, { hammerStop: {
    predicate: 'safety-evidence', refusal: { reasons: ['safety-evidence'] } } });
  assert.deepEqual(tuple(stopped.decision), ['hammer', 'closure-recovery', 'safety-refusal']);
  assert.equal(stopped.decision.queue.intent, 'reconcile');
  assert.equal(hasHammerDispatchIntent(stopped, identity), false);
  const capped = pair(base({ policy: { autonomousMergeExecutionEnabled: true,
    hammerCap: { headSha: HEAD, retryExhausted: true } } }));
  assert.equal(closureOwnerFromDecision(capped.decision).actor, 'closure-recovery');
  assert.notEqual(closureOwnerFromDecision(capped.decision).owner, 'operator-hold');
});

test('invalid attestation and source-changing reversal require exact-head review', () => {
  assert.equal(pair(base({ reviews: { ...clean, attestation: 'invalid' } })).decision.action, 'review');
  const reviewed = base({ reviews: { ...clean, headSha: OLD }, progress: { contentProof: {
    kind: 'context-only-rebase', semantic: true, fromHead: OLD, toHead: HEAD } } });
  assert.equal(pair(reviewed).decision.action, 'daemon-merge');
  const changed = reviseClosureNextAction(pair(reviewed), { progress: { contentProof: {
    kind: 'context-only-rebase', semantic: false, fromHead: OLD, toHead: HEAD } } });
  assert.equal(changed.decision.action, 'review');
});

test('overdue recovery never becomes an operator lane or blocks a later eligible pass', t => {
  const rootDir = root(t);
  const shared = observeClosureResult(pair(base({ checks: { conclusion: 'FAILURE' } })), {
    hammerStop: { predicate: 'synthetic-stop' } });
  for (let i = 0; i < 8; i++) {
    const lane = recordNoProgressLaneRun(rootDir, identity, { headSha: HEAD, fingerprint: 'unchanged',
      progressClass: 'operator-decision-required', nextAction: shared.decision,
      now: '2026-01-01T02:00:00.000Z', logger: quiet });
    assert.equal(lane.lane, 'active');
  }
  assert.equal(readNoProgressLane(rootDir, identity).nextAction.actor, 'closure-recovery');
  assert.equal(evaluateNoProgressLane(readNoProgressLane(rootDir, identity), { headSha: HEAD }).due, true);
});

function closureFixture(t, overrides = {}) {
  const body = '## Blocking issues\n- None.\n\n## Non-blocking issues\n- Synthetic finding\n\n## Verdict\nComment only';
  const effects = [], waits = [];
  const args = { rootDir: root(t), repoPath: identity.repo, prNumber: 5, currentRevisionRef: HEAD,
    reviewStateRow: { repo: identity.repo, pr_number: 5, pr_state: 'open', review_status: 'posted',
      reviewer: 'codex', reviewer_head_sha: HEAD, review_body: body, posted_at: AT },
    dispatchJob: { remediationStopCode: 'max-rounds-reached' }, labelNames: [],
    candidate: { headSha: HEAD, prState: 'OPEN', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN',
      statusCheckRollup: [{ __typename: 'CheckRun', name: 'unit', status: 'COMPLETED', conclusion: 'SUCCESS' }] },
    now: () => Date.parse('2026-01-01T02:00:00.000Z'), logger: quiet,
    loadConfigImpl: () => ({ getMergeAuthorityConfig: () => ({ enabled: true }) }),
    fetchLatestHeadReviewBodiesImpl: async () => [body],
    fetchMergedProtectiveDependentsImpl: async () => [],
    requestEligibleHammerWakeImpl: args => { effects.push(['wake', args.shared]); return { requested: false }; },
    observeClosureWaitImpl: async args => { waits.push(args); return { exhausted: true, retryAfterMs: 30_000 }; },
    runDaemonCleanMergeAttemptImpl: async () => { effects.push(['daemon']); return { disposition: 'not-taken' }; },
    maybeDispatchAmaCloserImpl: async args => { effects.push(['closer', args.sharedNextAction]);
      return { dispatched: true, reason: 'dispatched', launchRequestId: 'launch-05' }; }, ...overrides };
  return { args, effects, waits };
}

for (const advisory of ['None.', '**Repair diagnostic** — name the failed input.']) {
  test(`LIVEPACKREMEDIATE-01: label-only closure parks before remediation with advisory: ${advisory}`, async t => {
    const body = `## Blocking issues\n- **[live_pack_cross_edit] Live pack** — operator waiver needed.\n## Non-blocking issues\n- ${advisory}\n## Verdict\nRequest changes`;
    const pages = [];
    const f = closureFixture(t, { dispatchJob: {}, fetchLatestHeadReviewBodiesImpl: async () => [body],
      deliverAlertImpl: async (...args) => pages.push(args) });
    f.args.reviewStateRow.review_body = body;
    for (let poll = 0; poll < 2; poll++) {
      const result = await maybeDispatchAmaClosureFor(f.args);
      assert.equal(result.reason, 'operator-label-required:live-pack-edit-approved');
      assert.equal(result.needsOperator, true);
      assert.equal(result.nextAction.action, 'operator-hold');
      assert.equal(result.nextAction.actor, 'operator');
    }
    assert.equal(pages.length, 1);
    assert.deepEqual(f.waits, [], 'there is no missing remediation job to wait for');
    assert.deepEqual(f.effects, [], 'a waiver cannot be repaired by a daemon or hammer');
  });
}

test('LIVEPACKREMEDIATE-01: operator hold returned before shared owner initialization does not dereference the sink', async t => {
  const hold = { dispatched: false, needsOperator: true, skipMergeAgent: true,
    reason: 'operator-label-required:live-pack-edit-approved',
    operatorLabelGates: [{ check: 'live-pack-cross-edit', label: 'live-pack-edit-approved',
      reason: 'operator-label-required:live-pack-edit-approved' }] };
  const f = closureFixture(t);
  f.args.candidate.stackedBaseHold = hold;
  const result = await maybeDispatchAmaClosureFor(f.args);
  assert.equal(result.needsOperator, true);
  assert.equal(result.reason, hold.reason);
  assert.deepEqual(f.effects, []);
  assert.deepEqual(f.waits, []);
});

for (const prState of ['open', 'OPEN']) test(`COMPANIONFLOAT-01 orchestration normalizes ${prState} and fences clean daemon and hammer routes before cap/owner selection`, async t => {
  const f = closureFixture(t);
  f.args.candidate.prState = prState;
  const hammerStop = { predicate: 'companion-submodule-pr-unmerged', headSha: HEAD,
    owner: 'closure-recovery', companionWait: { repo: 'example/component', prNumber: 7, submodulePath: 'tools/component' } };
  f.args.readHammerStopForHeadImpl = () => hammerStop;
  let probes = 0;
  f.args.evaluateHammerStopHoldImpl = async args => {
    probes++;
    assert.equal(args.headSha, HEAD);
    assert.equal(args.prMetadata.isOpen, true);
    return { action: 'hold', hammerStop };
  };
  const result = await maybeDispatchAmaClosureFor(f.args);
  assert.equal(probes, 1);
  assert.equal(result.reason, 'hammer-stop-awaiting-companion');
  assert.equal(result.hammerStop.owner, 'closure-recovery');
  assert.equal(result.dispatched, false);
  assert.deepEqual(f.effects, []);
  assert.deepEqual(f.waits, [], 'the companion deadline owns escalation rather than the shorter final-round timer');
});

test('COMPANIONFLOAT-01 orchestration forwards the injected companion escalation deliverer', async t => {
  const f = closureFixture(t);
  const alerts = [];
  f.args.deliverAlertImpl = async (...args) => alerts.push(args);
  f.args.readHammerStopForHeadImpl = () => ({ predicate: 'companion-float-pending' });
  f.args.evaluateHammerStopHoldImpl = async args => {
    assert.equal(args.deliverAlertImpl, f.args.deliverAlertImpl);
    await args.deliverAlertImpl('companion timeout', { event: 'ama_closer.hammer_stop_hold' });
    return { action: 'hold' };
  };
  assert.equal((await maybeDispatchAmaClosureFor(f.args)).reason, 'hammer-stop-awaiting-companion');
  assert.deepEqual(alerts, [['companion timeout', { event: 'ama_closer.hammer_stop_hold' }]]);
  assert.deepEqual(f.effects, []);
});

test('orchestration routes one shared hammer decision despite overdue reports', async t => {
  const f = closureFixture(t);
  const result = await maybeDispatchAmaClosureFor(f.args);
  assert.equal(result.dispatched, true);
  assert.equal(result.nextAction.action, 'hammer');
  assert.equal(result.closureOwner.actor, 'hammer');
  assert.deepEqual(f.effects.map(([kind]) => kind), ['wake', 'closer']);
  assert.equal(f.effects[0][1].decision, f.effects[1][1].decision);
  assert.equal(result.nextAction, f.effects[1][1].decision);
  assert.equal(readClosureNextAction(result).decision, result.nextAction);
  assert.equal(readClosureNextAction(result).snapshot.head, HEAD);
  assert.equal(hasHammerDispatchIntent(readClosureNextAction(result), identity), true);
  assert.equal(Object.hasOwn(result, 'nextActionShared'), false);
  assert.ok(f.waits.length > 0);
});

test('failed alert delivery cannot block the selected hammer admission', async t => {
  const f = closureFixture(t, { observeClosureWaitImpl: async () => { throw new Error('synthetic outage'); } });
  const result = await maybeDispatchAmaClosureFor(f.args);
  assert.equal(result.dispatched, true);
  assert.equal(result.nextAction.actor, 'hammer');
});

test('real closer refusal remains enforced while stop ownership projects recovery', async t => {
  const f = closureFixture(t, { maybeDispatchAmaCloserImpl: async () => ({ dispatched: false,
    skipMergeAgent: true, recoveryWait: true, reason: 'hammer-stop-awaiting-input-change',
    hammerStop: { predicate: 'synthetic-safety', refusal: { reasons: ['synthetic-safety'] } } }) });
  const result = await maybeDispatchAmaClosureFor(f.args);
  assert.equal(result.dispatched, false);
  assert.equal(result.reason, 'hammer-stop-awaiting-input-change');
  assert.equal(result.nextAction.actor, 'closure-recovery');
  assert.equal(result.closureOwner.actor, 'closure-recovery');
});

test('missing progress timestamps retain the first actionable anchor across polls', async t => {
  const rootDir = root(t);
  const args = { rootDir, subjectKey: 'subject-05#5', input: { reviewState: clean,
    currentHead: HEAD, lease: null, checks: 'SUCCESS', roundsLeft: false },
    autonomousMergeExecutionEnabled: true,
    candidate: { headSha: HEAD, prState: 'OPEN', mergeable: 'MERGEABLE' } };
  const first = await resolveClosureNextAction({ ...args, observedAt: AT });
  const later = await resolveClosureNextAction({ ...args, observedAt: '2026-01-01T01:00:00.000Z' });
  assert.equal(first.decision.deadline.anchorSource, 'durable');
  assert.equal(later.decision.deadline.anchoredAt, AT);
  assert.equal(first.decision.decisionKey, later.decision.decisionKey);
});

test('drain observations preserve existing no-progress debt and the first clear pass stays due', t => {
  const rootDir = root(t);
  const selected = pair(base({ checks: { conclusion: 'FAILURE' } }));
  for (let i = 0; i < 4; i++) recordNoProgressLaneRun(rootDir, identity, { headSha: HEAD,
    fingerprint: 'unchanged', decisionFingerprint: 'initial', now: AT, logger: quiet });
  const before = readNoProgressLane(rootDir, identity);
  const draining = observeClosureResult(selected, { reason: 'deferred-by-drain', drainEpoch: 'epoch-05' });
  for (let i = 0; i < 3; i++) recordNoProgressLaneRun(rootDir, identity, { headSha: HEAD,
    fingerprint: 'unchanged', decisionFingerprint: 'draining', nextAction: draining.decision,
    now: '2026-01-01T01:00:00.000Z', logger: quiet });
  const held = readNoProgressLane(rootDir, identity);
  assert.equal(held.noProgressTicks, before.noProgressTicks);
  assert.equal(held.firstNoProgressAt, before.firstNoProgressAt);
  assert.equal(held.decisionResets, before.decisionResets);
  assert.equal(evaluateNoProgressLane(held, { headSha: HEAD }).due, true);
  assert.equal(hasHammerDispatchIntent(selected, identity), true);
});


test('unchanged preflight reuses the pair; a moved head invalidates the generation', () => {
  const shared = pair(base());
  assert.equal(revalidateClosurePr(shared, { state: 'OPEN', headSha: HEAD, mergeable: 'MERGEABLE' }), shared);
  const moved = revalidateClosurePr(shared, { state: 'OPEN', headSha: OTHER, mergeable: 'MERGEABLE' });
  assert.equal(moved.snapshot.head, OTHER);
  assert.equal(moved.decision.action, 'review');
  assert.equal(hasHammerDispatchIntent(shared, { ...identity, headSha: OTHER }), false);
});

function cleanClosureFixture(t) {
  const body = '## Blocking issues\n- None.\n## Non-blocking issues\n- None.\n## Verdict\nApproved';
  const f = closureFixture(t, { dispatchJob: {}, fetchLatestHeadReviewBodiesImpl: async () => [body] });
  f.args.reviewStateRow.review_body = body;
  f.args.passSnapshot = base();
  return f;
}

test('existing no-CI proof updates the shared generation before a daemon merge', async t => {
  const f = cleanClosureFixture(t);
  f.args.candidate.statusCheckRollup = [];
  f.args.runDaemonCleanMergeAttemptImpl = async ({ onGateSnapshot }) => {
    onGateSnapshot({ candidateHead: HEAD, prState: 'OPEN', mergeable: 'MERGEABLE',
      requiredChecks: true });
    const current = await resolveSharedNextAction({ passSnapshot: f.args.passSnapshot });
    assert.equal(current.decision.action, 'daemon-merge');
    f.effects.push(['daemon-merge']);
    return { disposition: 'merged', reason: 'daemon-merged', merged: true, remoteMergedConfirmed: true };
  };
  const result = await maybeDispatchAmaClosureFor(f.args);
  assert.equal(result.nextAction.action, 'done');
  assert.ok(f.effects.some(([kind]) => kind === 'daemon-merge'));
  assert.ok(!f.effects.some(([kind]) => kind === 'closer'));
});

test('a fresh daemon red-CI snapshot with a clean verdict routes to the hammer', async t => {
  const f = cleanClosureFixture(t);
  f.args.runDaemonCleanMergeAttemptImpl = async ({ onGateSnapshot }) => {
    const liveGate = { candidateHead: HEAD, prState: 'OPEN', mergeable: 'MERGEABLE',
      requiredChecks: [{ name: 'unit', status: 'COMPLETED', conclusion: 'FAILURE' }] };
    onGateSnapshot(liveGate);
    return { disposition: 'failed-closed', reason: 'gate-not-eligible', reasons: ['ci-not-green'], liveGate };
  };
  const result = await maybeDispatchAmaClosureFor(f.args);
  assert.deepEqual(tuple(result.nextAction), ['hammer', 'hammer', 'ci-red-clean-verdict']);
  assert.equal(result.dispatched, true);
  assert.ok(f.effects.some(([kind]) => kind === 'closer'));
});

test('admitted daemon repair uses the common policy without waiving proof or caps', () => {
  const repair = { daemonExecution: { reason: 'merge-retry-budget-exhausted', headSha: HEAD } };
  assert.deepEqual(tuple(pair(base({ progress: repair })).decision), ['hammer', 'hammer', 'retry-no-merge']);
  const capped = pair(base({ progress: repair, policy: { autonomousMergeExecutionEnabled: true,
    hammerCap: { headSha: HEAD, retryExhausted: true } } }));
  assert.equal(capped.decision.actor, 'closure-recovery');
  assert.equal(pair(base({ progress: repair, reviews: { ...clean, headSha: OLD } })).decision.action, 'review');
  const shared = pair(base({ progress: repair }));
  assert.equal(reviseClosureNextAction(shared, { progress: repair }), shared);
});

for (const reason of ['existing-dispatch-unknown', 'dispatch-retry-chain-unreadable',
  'dispatch-retry-exhausted', 'dispatch-branch-holder-block-exhausted']) {
  test(`receipt/holder reconciliation retains a recovery owner: ${reason}`, () => {
    const selected = pair(base({ checks: { conclusion: 'FAILURE' } }));
    const recovery = observeClosureResult(selected, { reason, dispatched: false });
    assert.equal(recovery.decision.actor, 'closure-recovery');
    assert.equal(recovery.decision.queue.intent, 'reconcile');
    assert.equal(hasHammerDispatchIntent(recovery, identity), false);
  });
}


test('rescue projections cannot turn recovery, deferral or a moved generation into launch eligibility', () => {
  const dispatch = pair(base({ checks: { conclusion: 'FAILURE' } }));
  for (const shared of [observeClosureResult(dispatch, { reason: 'existing-dispatch-unknown' }),
    observeClosureResult(dispatch, { capacity: { inFlight: 7, cap: 7 } }),
    observeClosureResult(dispatch, { reason: 'dispatch-branch-holder-block-exhausted' })]) {
    const result = classifyRescue({ headSha: HEAD, closureOwner: closureOwnerFromDecision(shared.decision) });
    assert.equal(result.decision, 'wait-closer');
    assert.equal(result.closureOwner.actor, shared.decision.actor);
  }
  assert.equal(classifyRescue({ headSha: OTHER,
    closureOwner: closureOwnerFromDecision(dispatch.decision) }).decision, 'wait-closer');
  assert.equal(classifyRescue({ headSha: HEAD,
    closureOwner: closureOwnerFromDecision(dispatch.decision) }).decision, 'hammer-eligible');
});


test('an exhausted wait report alone cannot replace the selected actor', async t => {
  const f = closureFixture(t, { maybeDispatchAmaCloserImpl: async () => ({ dispatched: false,
    skipMergeAgent: true, reason: 'in-flight', needsOperator: true,
    boundedWait: { exhausted: true, retryAfterMs: 30_000 } }) });
  const result = await maybeDispatchAmaClosureFor(f.args);
  assert.equal(result.nextAction.actor, 'hammer');
  assert.equal(result.closureOwner.actor, 'hammer');
  assert.equal(result.nextAction.reason, 'review-findings-final');
});


test('final hammer cap pages report the selected recovery workflow', async t => {
  const selected = observeClosureResult(pair(base()), { reason: 'hammer-retry-cap-exhausted' }).decision;
  const pages = [];
  const result = await routeToHammerOwner({ route: 'ci-blocked', rootDir: root(t), repoPath: identity.repo,
    prNumber: identity.prNumber, currentRevisionRef: HEAD, reviewedHeadSha: HEAD, logger: quiet,
    fetchMergeAgentCandidateImpl: async () => ({ headSha: HEAD }),
    buildMergeAgentDispatchJobImpl: () => ({}),
    resolveMergeAgentCoexistenceForWatcherImpl: async () => ({ outcome: 'ama-pending',
      amaClosureResult: { reason: 'hammer-retry-cap-exhausted', nextAction: selected } }),
    deliverAlertImpl: async (text, options) => pages.push({ text, options }),
  });
  assert.equal(result.outcome, 'hammer-cap-exhausted');
  assert.equal(pages.length, 1);
  assert.match(pages[0].text, /action=hammer actor=closure-recovery reason=retry-exhausted/);
  assert.match(pages[0].text, /ageMs=\d+/);
  assert.equal(pages[0].options.payload.nextAction, selected);
  assert.doesNotMatch(pages[0].text, /no automatic step remains/);
});


test('queued preflight redecides changed checks and labels before dispatch', () => {
  const selected = pair(base({ checks: { conclusion: 'FAILURE' } }));
  const cleared = revalidateClosurePr(selected, { state: 'OPEN', headSha: HEAD,
    statusCheckRollup: [{ name: 'unit', status: 'COMPLETED', conclusion: 'SUCCESS' }] },
  { checksConclusion: 'SUCCESS' });
  assert.equal(cleared.decision.action, 'daemon-merge');
  assert.equal(hasHammerDispatchIntent(cleared, identity), false);
  assert.equal(selected.decision.reason, 'ci-red-final');
  const held = revalidateClosurePr(selected, { state: 'OPEN', headSha: HEAD, labels: ['do-not-merge'] });
  assert.equal(held.decision.action, 'operator-hold');
});

test('changed closure evidence reuses the same bounded launch observation within the pass', async t => {
  let reads = 0;
  const lease = { status: 'dispatched', lrqId: 'launch-05', headSha: HEAD, acquiredAt: AT };
  const options = { passSnapshot: base(), subjectKey: 'subject-05#5', rootDir: root(t),
    input: { currentHead: HEAD, reviewState: clean, lease, roundsLeft: true, checks: 'SUCCESS' },
    candidate: { headSha: HEAD, prState: 'OPEN', mergeable: 'MERGEABLE' },
    autonomousMergeExecutionEnabled: true, observedAt: AT,
    readLaunches: async () => { reads++; return launchSource({ state: 'complete', value: {
      launchRequestId: 'launch-05', launch: { status: 'running' } } }, lease, {}); },
  };
  const first = await resolveClosureNextAction(options);
  const next = await resolveClosureNextAction({ ...options, input: { ...options.input, roundsLeft: false } });
  assert.equal(reads, 1);
  assert.equal(next.decision.reason, 'live-owner');
  assert.equal(first.snapshot.observations.remediation.value.roundsLeft, true);
  assert.equal(next.snapshot.observations.remediation.value.roundsLeft, false);
});


test('validated terminal-head proof retains daemon recovery and exact-head binding', () => {
  const reviews = { ...clean, verdict: 'comment-only', headSha: OLD,
    nonBlockingFindingCount: 1 };
  const progress = { terminalReview: { validated: true, headSha: HEAD, reviewedHeadSha: OLD } };
  const selected = pair(base({ reviews, progress }));
  assert.equal(selected.decision.action, 'daemon-merge');
  assert.equal(selected.decision.reason, 'carried-clean-head');
  for (const proof of [{ ...progress.terminalReview, headSha: OTHER },
    { ...progress.terminalReview, reviewedHeadSha: OTHER }, { ...progress.terminalReview, validated: false }]) {
    assert.equal(pair(base({ reviews, progress: { terminalReview: proof } })).decision.action, 'review');
  }
  assert.equal(pair(base({ reviews, progress, controls: { safetyRefusal: { deterministic: true } } })).decision.actor,
    'closure-recovery');
});


test('terminal-head daemon preflight publishes its validated decision before mutation', async t => {
  const f = closureFixture(t);
  f.args.passSnapshot = base();
  f.args.reviewStateRow.reviewer_head_sha = OLD;
  f.args.fetchLatestHeadReviewBodiesImpl = async (_repo, _pr, head) => head === OLD ? [f.args.reviewStateRow.review_body] : [];
  f.args.proveCloserAuthoredStaleHeadImpl = async () => ({ proven: true, reviewedHead: OLD,
    currentHead: HEAD, closerCommits: [HEAD] });
  f.args.resolveHeadCloserCommitSuppressionImpl = async () => ({ suppressed: true, reason: 'closer-commit-trailer' });
  f.args.fetchHeadCloserVerifiedCommitImpl = async () => ({ sha: HEAD, parentSha: OLD, message: 'synthetic repair' });
  f.args.resolveHamTerminalRemediationEvidenceImpl = async () => null;
  let preflight = 0;
  f.args.runDaemonCleanMergeAttemptImpl = async ({ onGateSnapshot }) => {
    preflight++;
    onGateSnapshot({ candidateHead: HEAD, prState: 'OPEN', mergeable: 'MERGEABLE',
      requiredChecks: [{ name: 'unit', status: 'COMPLETED', conclusion: 'SUCCESS' }],
      terminalReviewValidated: true });
    const shared = await resolveSharedNextAction({ passSnapshot: f.args.passSnapshot });
    assert.equal(shared.decision.action, 'daemon-merge');
    return { disposition: 'merged', reason: 'merged', merged: true, remoteMergedConfirmed: true };
  };
  const result = await maybeDispatchAmaClosureFor(f.args);
  assert.equal(preflight, 1);
  assert.equal(result.nextAction.action, 'done');
  assert.ok(!f.effects.some(([kind]) => kind === 'closer'));
});


test('a recorded terminal judgment on an unchanged head retains daemon ownership', async t => {
  const f = closureFixture(t);
  f.args.headHasValidatedHamTerminalRemediationImpl = () => true;
  f.args.runDaemonCleanMergeAttemptImpl = async () => ({ disposition: 'merged', reason: 'merged', merged: true, remoteMergedConfirmed: true });
  const result = await maybeDispatchAmaClosureFor(f.args);
  assert.equal(f.effects[0][1].decision.action, 'daemon-merge');
  assert.equal(result.nextAction.action, 'done');
  assert.ok(!f.effects.some(([kind]) => kind === 'closer'));
});

for (const lifetime of [false, true]) test(`STOPSTALE-02: orchestration supersedes ${lifetime ? 'lifetime' : 'retry'} cap without changing its ledger`, async t => {
  const f = closureFixture(t);
  f.args.passSnapshot = base();
  f.args.loadConfigImpl = () => ({ getMergeAuthorityConfig: () => ({ enabled: true, strictMode: false }) });
  const capAt = '2025-12-31T23:59:00.000Z';
  markHammerRetryCapExhausted(f.args.rootDir, identity, { jobKey: lifetime ? OLD : HEAD,
    headSha: lifetime ? OLD : HEAD, attemptCount: lifetime ? 6 : 2,
    lifetime, alertEmitted: true, now: capAt });
  const before = readHammerRetryCapLedger(f.args.rootDir, identity);
  let daemonCalls = 0;
  f.args.runDaemonCleanMergeAttemptImpl = async ({ sharedNextAction }) => {
    daemonCalls++;
    assert.equal(sharedNextAction.snapshot.observations.policy.value.hammerCap.recordedAt, capAt);
    assert.equal(sharedNextAction.decision.actor, 'daemon');
    assert.ok(sharedNextAction.decision.evidenceRefs.includes('stop-superseded-by-exact-head-review'));
    assert.ok(sharedNextAction.decision.evidenceRefs.includes(`stop-reason:${lifetime ? 'lifetime' : 'retry'}-exhausted`));
    return { disposition: 'merged', reason: 'merged', merged: true, remoteMergedConfirmed: true };
  };
  const result = await maybeDispatchAmaClosureFor(f.args);
  assert.equal(daemonCalls, 1);
  assert.equal(result.nextAction.action, 'done');
  assert.ok(!f.effects.some(([kind]) => kind === 'closer'));
  assert.deepEqual(readHammerRetryCapLedger(f.args.rootDir, identity), before);
});

test('STOPSTALE-02: launch-source terminal time survives the closure projection', async () => {
  const review = { ...clean, postedAt: '2026-01-01T00:01:00.000Z' };
  const shared = await resolveClosureNextAction({ input: { currentHead: HEAD,
    reviewState: review, checks: 'SUCCESS', roundsLeft: false, lease: null },
    subjectKey: 'subject-05#5', candidate: { headSha: HEAD, prState: 'OPEN', mergeable: 'MERGEABLE' },
    autonomousMergeExecutionEnabled: true, observedAt: review.postedAt,
    readLaunches: async () => launchSource({ state: 'complete', value: { terminal: true,
      launch: { status: 'failed', terminal_at: AT }, retryChain: [] } }, { headSha: HEAD }, { retryExhausted: true }) });
  assert.equal(shared.decision.action, 'daemon-merge');
  assert.ok(shared.decision.evidenceRefs.includes('stop-reason:hammer-final-no-merge'));
  assert.equal(hasHammerDispatchIntent(shared, identity), false);
});

for (const overwritten of [false, true]) test(`STOPSTALE-03: ${overwritten ? 'overwritten' : 'repeated'} older-job lifetime stop cannot overtake a newer comment-only exact-head review`, async t => {
  const f = closureFixture(t);
  f.args.passSnapshot = base({ progress: { hammerHead: { headSha: HEAD, reason: 'closer-commit-trailer' } } });
  f.args.loadConfigImpl = () => ({ getMergeAuthorityConfig: () => ({ enabled: true, strictMode: false }) });
  const first = '2025-12-31T23:59:00.000Z';
  if (overwritten) {
    for (let i = 1; i <= 6; i++) recordHammerRetryDispatch(f.args.rootDir, identity, {
      jobKey: OLD, headSha: OLD, launchRequestId: `synthetic-launch-${i}`, now: first,
    });
  }
  markHammerRetryCapExhausted(f.args.rootDir, identity, { jobKey: OLD, headSha: OLD,
    lifetime: true, attemptCount: 6, alertEmitted: true, now: first });
  markHammerRetryCapExhausted(f.args.rootDir, identity, { jobKey: HEAD, headSha: HEAD,
    lifetime: true, attemptCount: 6, alertEmitted: true, now: '2026-01-01T00:02:00.000Z' });
  if (overwritten) updateHammerRetryCapLedger(f.args.rootDir, identity,
    ledger => ({ ...ledger, alertedAt: '2026-01-01T00:02:00.000Z' }));
  const before = readHammerRetryCapLedger(f.args.rootDir, identity);
  let daemonCalls = 0;
  f.args.runDaemonCleanMergeAttemptImpl = async ({ sharedNextAction, reviewState }) => {
    daemonCalls++;
    assert.equal(reviewState.verdict, 'comment-only');
    assert.equal(reviewState.blockingFindingCount, 0);
    assert.ok(reviewState.nonBlockingFindingCount > 0);
    assert.equal(sharedNextAction.snapshot.observations.policy.value.hammerCap.recordedAt, first);
    assert.equal(sharedNextAction.decision.action, 'daemon-merge');
    assert.ok(sharedNextAction.decision.evidenceRefs.includes('stop-reason:lifetime-exhausted'));
    return { disposition: 'merged', reason: 'merged', merged: true, remoteMergedConfirmed: true };
  };
  const result = await maybeDispatchAmaClosureFor(f.args);
  assert.equal(daemonCalls, 1);
  assert.equal(result.nextAction.action, 'done');
  assert.ok(!f.effects.some(([kind]) => kind === 'closer'));
  assert.deepEqual(readHammerRetryCapLedger(f.args.rootDir, identity), before);
});

test('STOPSTALE-01: orchestration reaches daemon merge after a recorded stop and newer non-blocking review', async t => {
  const f = closureFixture(t);
  f.args.passSnapshot = base();
  const stopAt = '2025-12-31T23:59:00.000Z';
  f.args.loadConfigImpl = () => ({ getMergeAuthorityConfig: () => ({ enabled: true, strictMode: false }) });
  f.args.readHammerStopForHeadImpl = () => ({ headSha: HEAD, predicate: 'synthetic-unattested-head',
    recordedAt: stopAt, stopKey: `${HEAD}:2:${stopAt}` });
  let daemonCalls = 0;
  f.args.runDaemonCleanMergeAttemptImpl = async () => {
    daemonCalls++;
    const nextActionShared = await resolveSharedNextAction({ passSnapshot: f.args.passSnapshot });
    assert.ok(nextActionShared.decision.evidenceRefs.includes('stop-superseded-by-exact-head-review'));
    return { disposition: 'merged', reason: 'merged', merged: true, remoteMergedConfirmed: true };
  };
  const result = await maybeDispatchAmaClosureFor(f.args);
  assert.equal(daemonCalls, 1);
  assert.equal(result.nextAction.action, 'done');
  assert.ok(!f.effects.some(([kind]) => kind === 'closer'));
});


function redCiFixture(t, { findings = true, elapsed = 60_000, jobStatus = null, jobHead = HEAD, jobRepo = identity.repo, jobCreatedAt = AT } = {}) {
  const f = cleanClosureFixture(t);
  const body = findings
    ? '## Blocking issues\n- Synthetic defect\n## Non-blocking issues\n- None.\n## Verdict\nRequest changes'
    : '## Blocking issues\n- None.\n## Non-blocking issues\n- None.\n## Verdict\nComment only';
  f.args.reviewStateRow.review_body = body;
  f.args.fetchLatestHeadReviewBodiesImpl = async () => [body];
  f.args.resolveReviewCycleExhaustionImpl = () => ({ reviewCycleExhausted: false });
  f.args.now = () => Date.parse(AT) + elapsed;
  f.args.passSnapshot = null;
  f.args.candidate.statusCheckRollup[0].conclusion = 'FAILURE';
  if (jobStatus) {
    const key = jobStatus === 'in_progress' ? 'inProgress' : jobStatus;
    const dir = getFollowUpJobDir(f.args.rootDir, key);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${followUpJobFilePrefix(jobRepo, 5)}synthetic.json`), JSON.stringify({
      repo: jobRepo, prNumber: 5, revisionRef: jobHead, status: jobStatus, createdAt: jobCreatedAt, reviewBody: body,
    }));
  }
  return f;
}

for (const findings of [false, true]) {
  test(`red CI with ${findings ? 'expired finding admission' : 'a clean verdict'} has a hammer owner`, async t => {
    const f = redCiFixture(t, { findings, elapsed: NEXT_ACTION_DEADLINE_MS.admission });
    const result = await maybeDispatchAmaClosureFor(f.args);
    assert.deepEqual(tuple(result.nextAction), ['hammer', 'hammer', 'ci-red-clean-verdict']);
    assert.equal(result.dispatched, true);
    assert.ok(f.effects.some(([kind]) => kind === 'closer'));
  });
}

for (const jobStatus of ['pending', 'in_progress']) {
  test(`current-head ${jobStatus} job truthfully owns red CI past admission expiry`, async t => {
    const f = redCiFixture(t, { jobStatus, elapsed: NEXT_ACTION_DEADLINE_MS.admission + 1 });
    const result = await maybeDispatchAmaClosureFor(f.args);
    assert.equal(result.nextAction.action, 'remediate');
    assert.equal(result.reason, 'active-remediation-job');
    assert.equal(result.dispatched, false);
    assert.ok(f.waits.length > 0);
    assert.ok(!f.effects.some(([kind]) => kind === 'closer'));
  });
}

for (const jobStatus of ['completed', 'failed', 'stopped']) {
  test(`terminal ${jobStatus} job sends red CI to the hammer despite findings and rounds`, async t => {
    const f = redCiFixture(t, { jobStatus });
    const result = await maybeDispatchAmaClosureFor(f.args);
    assert.deepEqual(tuple(result.nextAction), ['hammer', 'hammer', 'ci-red-clean-verdict']);
    assert.equal(result.dispatched, true);
  });
}

test('missing remediation job is named truthfully and admission expires across polls', async t => {
  const f = redCiFixture(t);
  const first = await maybeDispatchAmaClosureFor(f.args);
  assert.equal(first.reason, 'remediation-job-missing');
  assert.equal(first.nextAction.action, 'remediate');
  assert.equal(first.nextAction.deadline.class, 'admission');
  assert.equal(first.nextAction.deadline.at, new Date(Date.parse(AT) + NEXT_ACTION_DEADLINE_MS.admission).toISOString());
  assert.ok(f.waits.some(wait => wait.startedAt === Date.parse(AT)));
  f.args.now = () => Date.parse(first.nextAction.deadline.at);
  const expired = await maybeDispatchAmaClosureFor(f.args);
  assert.deepEqual(tuple(expired.nextAction), ['hammer', 'hammer', 'ci-red-clean-verdict']);
  assert.equal(expired.dispatched, true);
});


test('a missing queue job replaces a stale pass owner before red-CI routing', async t => {
  const f = redCiFixture(t, { findings: false });
  f.args.passSnapshot = base({ remediation: { roundsLeft: true, job: { status: 'in_progress', headSha: HEAD } } });
  const result = await maybeDispatchAmaClosureFor(f.args);
  assert.deepEqual(tuple(result.nextAction), ['hammer', 'hammer', 'ci-red-clean-verdict']);
  assert.equal(result.dispatched, true);
});

for (const jobStatus of ['pending', 'in_progress']) {
  for (const jobHead of [OLD, null]) {
    test(`gate and closure agree on mixed-case ${jobStatus} PR ownership at ${jobHead}`, async t => {
      const f = redCiFixture(t, { findings: false, jobStatus, jobHead, jobRepo: identity.repo.toUpperCase() });
      const terminalDir = getFollowUpJobDir(f.args.rootDir, 'completed');
      mkdirSync(terminalDir, { recursive: true });
      const originalReadDir = fs.readdirSync;
      let terminalReads = 0;
      fs.readdirSync = function (path, ...args) {
        if (path === terminalDir) terminalReads++;
        return originalReadDir.call(this, path, ...args);
      };
      syncBuiltinESMExports();
      let result;
      try { result = await maybeDispatchAmaClosureFor(f.args); }
      finally { fs.readdirSync = originalReadDir; syncBuiltinESMExports(); }
      assert.equal(result.nextAction.action, 'remediate');
      assert.equal(result.reason, 'active-remediation-job');
      assert.equal(result.dispatched, false);
      assert.ok(!f.effects.some(([kind]) => kind === 'closer'));
      assert.equal(terminalReads, 3, 'gate and ledger reads only; closure adds no terminal scan for a live owner');
    });
  }
}

for (const jobStatus of ['failed', 'stopped']) {
  test(`a new same-head review waits after an older ${jobStatus} job`, async t => {
    const f = redCiFixture(t, { jobStatus, jobCreatedAt: '2025-12-31T23:59:00.000Z' });
    const result = await maybeDispatchAmaClosureFor(f.args);
    assert.equal(result.nextAction.action, 'remediate', JSON.stringify(result.nextAction));
    assert.equal(result.reason, 'remediation-job-missing');
    assert.equal(result.dispatched, false);
    assert.ok(!f.effects.some(([kind]) => kind === 'closer'));
  });
}

test('real executed CI stop keeps its review baseline through closure preflight and closer evaluation', async t => {
  const f = closureFixture(t);
  const badCheck = { name: 'unit', conclusion: 'FAILURE', steps: [{ conclusion: 'failure' }] };
  f.args.candidate.statusCheckRollup = [badCheck];
  f.args.env = { ...process.env, HQ_ROOT: f.args.rootDir };
  writeAmaAuditEntry({ hqRoot: f.args.rootDir, ...identity, now: AT,
    attempt: { path: 'hammer', head: HEAD, outcome: 'failed-without-merge', reason: 'github-gate-not-green',
      startedAt: AT, githubGate: { reasons: ['ci-not-green'], badChecks: [badCheck] } } });
  const options = { rootDir: f.args.rootDir, hqRoot: f.args.rootDir, ...identity,
    prMetadata: { isOpen: true, headSha: HEAD, mergeableState: 'MERGEABLE', statusCheckRollup: [badCheck] },
    reviewState: clean, now: AT, logger: quiet, deliverAlertImpl: async () => ({ queued: true }) };
  assert.equal((await evaluateHammerStopHold(options)).action, 'hold');
  await maybeDispatchAmaClosureFor(f.args);
  assert.equal((await evaluateHammerStopHold(options)).action, 'hold');
});

test('closure infrastructure observer invokes the shared rerun owner', async t => {
  const f = closureFixture(t);
  f.args.candidate.statusCheckRollup = [{ name: 'unit', conclusion: 'FAILURE', steps: [],
    detailsUrl: `https://github.com/${identity.repo}/actions/runs/10/job/1` }];
  let calls = 0;
  f.args.recoverInfrastructureChecksImpl = async args => {
    calls++;
    assert.equal(args.headSha, HEAD);
    assert.equal(args.failedChecks[0].name, 'unit');
    return true;
  };
  const result = await maybeDispatchAmaClosureFor(f.args);
  assert.equal(calls, 1);
  assert.equal(result.nextAction.action, 'wait-for-CI');
  assert.ok(!f.effects.some(([kind]) => kind === 'closer' || kind === 'daemon'));
});


test('CLOSERSTOPTRANSIENT-01 transient stops never project a permanent automated stop', async () => {
  const hammerStop = { headSha: HEAD, predicate: 'unclassified-merge-failure', deterministic: false };
  const shared = await resolveClosureNextAction({ input: { currentHead: HEAD, reviewState: clean,
    hammerStop, lease: null, roundsLeft: false, checks: 'SUCCESS' },
    candidate: { headSha: HEAD, prState: 'OPEN', mergeable: 'MERGEABLE' },
    autonomousMergeExecutionEnabled: true, observedAt: AT });
  assert.equal(shared.snapshot.observations.controls.value.stop.deterministic, false);
  assert.notEqual(shared.decision.reason, 'automated-stop');
  const observed = observeClosureResult(shared, { hammerStop });
  assert.equal(observed.snapshot.observations.controls.value.stop.deterministic, false);
  assert.notEqual(observed.decision.reason, 'automated-stop');
});

for (const reason of ['hammer-validated-head', 'closer-commit-trailer']) {
  test(`HAMVALIDORPHAN-01 ${reason} retains bounded hammer ownership and rescue agrees`, async () => {
    const { default: classify } = await import('../src/merge-agent-rescue-classifier.mjs');
    const input = { reviewState: { ...clean, headSha: OLD }, currentHead: HEAD,
      hammerHead: { headSha: HEAD, reason }, lease: null, roundsLeft: true, checks: 'SUCCESS' };
    const shared = await resolveClosureNextAction({ input, passSnapshot: base({
      launches: { closer: { headSha: HEAD, launchRequestId: 'fixture-crashed',
        status: 'failed', outcome: 'no-merge', retryable: true, attempt: 1 } },
    }), candidate: { headSha: HEAD, prState: 'OPEN', mergeable: 'MERGEABLE' },
    autonomousMergeExecutionEnabled: true, observedAt: AT });
    assert.deepEqual(tuple(shared.decision), ['hammer', 'hammer', 'retry-no-merge']);
    assert.equal(shared.decision.attempt, 2);
    assert.equal(classify({ sharedNextAction: shared, headSha: HEAD }).decision, 'hammer-eligible');
    assert.equal(hasHammerDispatchIntent(shared, identity), true);
    assert.equal(shared.snapshot.observations.progress.value.terminalReview, undefined,
      'ownership cannot certify terminal validation or carry a stale verdict');
    const exhausted = reviseClosureNextAction(shared, { policy: {
      ...shared.snapshot.observations.policy.value, hammerCap: { headSha: HEAD, retryExhausted: true },
    } });
    assert.equal(exhausted.decision.reason, 'retry-exhausted');
    assert.equal(hasHammerDispatchIntent(exhausted, identity), false);
    const live = reviseClosureNextAction(shared, { launches: { closer: {
      headSha: HEAD, launchRequestId: 'fixture-live', status: 'running',
    } } });
    assert.equal(live.decision.reason, 'live-owner');
    assert.equal(hasHammerDispatchIntent(live, identity), false);
    const foreign = reviseClosureNextAction(shared, { progress: { hammerHead: { headSha: OTHER, reason } },
      launches: { closer: null } });
    assert.equal(foreign.decision.action, 'review');
    assert.equal(classify({ sharedNextAction: foreign, headSha: HEAD }).decision, 'rereview-eligible');
  });
}

for (const conclusion of ['PENDING', 'SUCCESS', 'FAILURE']) {
  test(`HAMRESUMEOWED-01: exact-head ${conclusion} selects its successor in one closure pass`, async t => {
    const { readHammerResumes } = await import('../src/ama/hammer-resume.mjs');
    const { readAmaAuditEntry } = await import('../src/ama/audit.mjs');
    const f = closureFixture(t);
    f.args.env = { HQ_ROOT: f.args.rootDir };
    writeAmaAuditEntry({ hqRoot: f.args.rootDir, ...identity, now: AT,
      attempt: { outcome: 'deferred', reason: 'required-checks-pending',
        attemptPhase: 'hammer-gh-pr-merge', resumeOwed: true, resumeHead: HEAD } });
    const check = f.args.candidate.statusCheckRollup[0];
    Object.assign(check, { status: conclusion === 'PENDING' ? 'IN_PROGRESS' : 'COMPLETED', conclusion });
    const result = await maybeDispatchAmaClosureFor(f.args);
    if (conclusion === 'PENDING') {
      assert.equal(result.dispatched, false);
      assert.equal(result.nextAction.action, 'wait-for-CI');
      assert.equal(f.effects.some(([kind]) => kind === 'closer' || kind === 'daemon'), false);
      assert.equal(readHammerResumes({ hqRoot: f.args.rootDir, ...identity }).length, 1);
      // No unrelated wake, review mutation or retry-budget reset: the next pass
      // observes CI completing on this same SHA and resumes immediately.
      Object.assign(check, { status: 'COMPLETED', conclusion: 'SUCCESS' });
      assert.equal((await maybeDispatchAmaClosureFor(f.args)).dispatched, true);
    } else {
      assert.equal(result.dispatched, true);
      assert.equal(result.nextAction.action, 'hammer');
      assert.equal(result.nextAction.reason, conclusion === 'SUCCESS' ? 'required-checks-resume' : 'ci-red-final');
      assert.equal(f.effects.some(([kind]) => kind === 'daemon'), false, 'receipt cannot authorize a bare merge');
    }
    const doc = readAmaAuditEntry(f.args.rootDir, identity.repo, identity.prNumber, HEAD);
    assert.equal(doc.attempts.at(-1).reason, conclusion === 'FAILURE' ? 'resume-checks-red' : 'resume-dispatched');
    assert.equal(readHammerResumes({ hqRoot: f.args.rootDir, ...identity }).length, 0);
  });
}

test('HAMRESUMEOWED-01: resume retains caps, holds, live ownership and dispatch refusal', async t => {
  const progress = { hammerResume: { headSha: HEAD, attemptNumber: 1 } };
  for (const observations of [
    { policy: { hammerCap: { retryExhausted: true, headSha: HEAD } } },
    { policy: { autonomousMergeExecutionEnabled: false } },
    { pr: { headSha: HEAD, state: 'OPEN', labels: ['no-merge-hold'] } },
    { launches: { closer: { headSha: HEAD, status: 'running' } } },
    { controls: { safetyRefusal: { deterministic: true, reason: 'synthetic-finding' } } },
  ]) {
    const decision = nextAction(base({ progress, ...observations }));
    assert.notEqual(decision.reason, 'required-checks-resume');
  }
  const f = closureFixture(t, { maybeDispatchAmaCloserImpl: async () => ({ dispatched: false,
    skipMergeAgent: true, reason: 'synthetic-refusal' }) });
  f.args.env = { HQ_ROOT: f.args.rootDir };
  writeAmaAuditEntry({ hqRoot: f.args.rootDir, ...identity, now: AT,
    attempt: { outcome: 'deferred', reason: 'required-checks-pending', resumeOwed: true, resumeHead: HEAD } });
  assert.equal((await maybeDispatchAmaClosureFor(f.args)).dispatched, false);
  const { readHammerResumes } = await import('../src/ama/hammer-resume.mjs');
  assert.equal(readHammerResumes({ hqRoot: f.args.rootDir, ...identity }).length, 1);
});

test('HAMRESUMEOWED-01: exhausted existing dispatch budgets explicitly close resume debt', async t => {
  const { recordHammerRetryDispatch } = await import('../src/ama/hammer-retry-cap.mjs');
  const { readHammerResumes } = await import('../src/ama/hammer-resume.mjs');
  const { readAmaAuditEntry } = await import('../src/ama/audit.mjs');
  const f = closureFixture(t, { deliverAlertImpl: async () => true,
    maybeDispatchAmaCloserImpl: async args => {
      assert.equal(args.sharedNextAction.decision.actor, 'closure-recovery');
      return { dispatched: false, skipMergeAgent: true, reason: 'hammer-retry-cap-exhausted' };
    } });
  f.args.env = { HQ_ROOT: f.args.rootDir };
  writeAmaAuditEntry({ hqRoot: f.args.rootDir, ...identity, now: AT,
    attempt: { outcome: 'deferred', reason: 'required-checks-pending', resumeOwed: true, resumeHead: HEAD } });
  for (let i = 0; i < 2; i++) recordHammerRetryDispatch(f.args.rootDir, identity, { jobKey: HEAD, headSha: HEAD, launchRequestId: `synthetic-cap-${i}` });
  const result = await maybeDispatchAmaClosureFor(f.args);
  assert.equal(result.dispatched, false, JSON.stringify(result));
  assert.equal(result.nextAction.actor, 'closure-recovery');
  assert.equal(f.effects.some(([kind]) => kind === 'closer' || kind === 'daemon'), false);
  assert.deepEqual(readHammerResumes({ hqRoot: f.args.rootDir, ...identity }), []);
  assert.equal(readAmaAuditEntry(f.args.rootDir, identity.repo, identity.prNumber, HEAD).attempts.at(-1).reason,
    'resume-budget-exhausted');
});

test('HAMRESUMEOWED-01: a recorded hammer head resumes validation across an unproven stale review delta', async t => {
  let dispatchArgs;
  const f = closureFixture(t, {
    proveCloserAuthoredStaleHeadImpl: async () => ({ proven: false, reason: 'hammer-app-attestation-missing',
      reviewedHead: OLD, currentHead: HEAD }),
    resolveHeadCloserCommitSuppressionImpl: async () => ({ suppressed: false }),
    maybeDispatchAmaCloserImpl: async args => { dispatchArgs = args; return { dispatched: false,
      skipMergeAgent: true, reason: 'terminal-evidence-required' }; },
  });
  f.args.env = { HQ_ROOT: f.args.rootDir };
  f.args.reviewStateRow.reviewer_head_sha = OLD;
  writeAmaAuditEntry({ hqRoot: f.args.rootDir, ...identity, now: AT,
    attempt: { outcome: 'deferred', reason: 'required-checks-pending', resumeOwed: true, resumeHead: HEAD } });
  const result = await maybeDispatchAmaClosureFor(f.args);
  assert.ok(dispatchArgs, 'receipt assigns the normal validation owner instead of another review');
  assert.equal(dispatchArgs.dispatchContext.allowStaleReviewHeadHammerResume, true);
  assert.equal(dispatchArgs.prMetadata.headSha, HEAD);
  assert.equal(dispatchArgs.reviewState.headSha, OLD);
  assert.equal(result.dispatched, false, 'receipt cannot waive missing terminal evidence');
  assert.equal(result.nextAction.reason, 'required-checks-resume');
});


test('OWNERUNREADABLE-02: mismatch recovery resolves the terminal placeholder and dispatches its successor once', async t => {
  const f = closureFixture(t);
  const snapshot = deriveNextActionSnapshot({ base: base(), observedAt: '2026-01-01T04:00:00.000Z', observations: {
    leases: { closer: { status: 'terminal', lrqId: 'synthetic-closer', headSha: HEAD } },
    launches: { state: 'complete', provenance: { sourceRef: 'closer-lease' }, value: { closer: {
      launchRequestId: 'synthetic-closer', headSha: HEAD, retryChainUnreadable: true, retryChainReadState: 'unresolved',
    } } },
  } });
  let reads = 0, attempts = 0, dispatches = 0;
  t.mock.method(dispatchReadTransport, 'lookup', async selector => {
    reads++;
    assert.equal(selector.include_retry_chain, true);
    return { schema_version: 1, status: 'found', complete: true, roots: ['synthetic-closer'],
      items: [{ launch_request_id: 'synthetic-closer', status: 'succeeded' }], retry_edges: [] };
  });
  f.args.maybeDispatchAmaCloserImpl = async args => {
    attempts++;
    if (attempts === 1) return { dispatched: false, reason: 'closure-decision-mismatch',
      nextActionShared: pair(snapshot), decisionMismatch: { resolvedReason: 'ownership-unreadable' } };
    assert.equal(args.sharedNextAction.decision.row, 'R08-retry');
    dispatches++;
    return { dispatched: true, reason: 'dispatched', launchRequestId: 'synthetic-successor' };
  };
  const result = await maybeDispatchAmaClosureFor(f.args);
  assert.equal(reads, 1);
  assert.equal(result.decisionReresolutions, 1);
  assert.equal(result.dispatched, true);
  assert.equal(dispatches, 1);
});


test('APPROVALREARM-01: orchestration clears an approval refusal before exhausted R07 selection', async t => {
  const f = closureFixture(t);
  f.args.env = { HQ_ROOT: f.args.rootDir };
  f.args.deliverAlertImpl = async () => {};
  f.args.maybeDispatchAmaCloserImpl = async args => {
    if (!hasHammerDispatchIntent(args.sharedNextAction, identity)) return { dispatched: false, reason: 'fixture-cap-refusal' };
    f.effects.push(['closer', args.sharedNextAction]);
    return { dispatched: true, reason: 'dispatched', launchRequestId: 'fixture-approved-launch' };
  };
  for (let i = 1; i <= 2; i++) {
    recordHammerRetryDispatch(f.args.rootDir, identity, { jobKey: HEAD, headSha: HEAD,
      launchRequestId: `fixture-approval-prior-${i}`, now: AT });
    writeAmaAuditEntry({ hqRoot: f.args.rootDir, ...identity, now: AT,
      attempt: { outcome: 'failed-without-merge', attemptPhase: 'hammer-gh-pr-merge',
        validatedHead: HEAD, reason: 'operator-label-required:operator-approved' } });
  }
  const held = await maybeDispatchAmaClosureFor(f.args);
  assert.equal(held.dispatched, false);
  assert.equal(f.effects.filter(([kind]) => kind === 'closer').length, 0);
  f.args.labelNames = ['operator-approved'];
  const approved = await maybeDispatchAmaClosureFor(f.args);
  assert.equal(approved.dispatched, true, JSON.stringify(approved));
  const selected = f.effects.find(([kind]) => kind === 'closer')?.[1];
  assert.equal(selected.decision.row, 'R07-approval');
  assert.equal(selected.decision.reason, 'operator-approval-applied');
  assert.equal(selected.snapshot.observations.policy.value.hammerCap.retryExhausted, false);
});


test('APPROVALREARM-01: watcher and closer share the gate-excluded hold baseline', async t => {
  const f = closureFixture(t);
  f.args.env = { HQ_ROOT: f.args.rootDir };
  f.args.deliverAlertImpl = async () => {};
  f.args.candidate.statusCheckRollup.push({ __typename: 'StatusContext',
    context: 'agent-os/adversarial-gate', state: 'PENDING' });
  f.args.loadConfigImpl = () => ({ getMergeAuthorityConfig: () => ({ enabled: true,
    requiredCheckContexts: ['unit'] }) });
  writeAmaAuditEntry({ hqRoot: f.args.rootDir, ...identity, now: AT,
    attempt: { outcome: 'failed-without-merge', attemptPhase: 'hammer-gh-pr-merge',
      validatedHead: HEAD, reason: 'operator-label-required:operator-approved' } });
  let watcherInputs;
  f.args.evaluateHammerStopHoldImpl = async args => {
    watcherInputs = args;
    assert.deepEqual(args.excludeContexts, ['agent-os/adversarial-gate']);
    assert.deepEqual(args.requiredCheckContexts, ['unit']);
    return evaluateHammerStopHold(args);
  };
  let closerEvaluation;
  f.args.maybeDispatchAmaCloserImpl = args => maybeDispatchAmaCloser({ ...args,
    dispatchContext: { ...args.dispatchContext, hqRoot: f.args.rootDir, dispatchedAt: watcherInputs.now },
    guardStackedBaseImpl: async () => null,
    evaluateHammerStopHoldImpl: async inputs => {
      closerEvaluation = await evaluateHammerStopHold(inputs);
      return closerEvaluation;
    },
    execFileImpl: async () => assert.fail('held approval must not launch or fetch'),
  });
  const result = await maybeDispatchAmaClosureFor(f.args);
  assert.ok(watcherInputs);
  const closer = await evaluateHammerStopHold({ ...watcherInputs,
    excludeContexts: ['agent-os/adversarial-gate'], requiredCheckContexts: ['unit'] });
  assert.equal(closer.action, 'hold');
  assert.equal(closer.changed, undefined, 'no spurious checks-change release without approval');
  assert.equal(closerEvaluation?.action, 'hold');
  assert.equal(result.dispatched, false);
  assert.equal(result.reason, 'hammer-stop-awaiting-input-change');
});
