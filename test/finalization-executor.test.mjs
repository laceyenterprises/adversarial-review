// ARC-17 — the leased finalization executor (docs/SPEC-merge-authority-v2.md §4).
// Mandatory tests: lease contention, re-fold discard on world-move, execute
// idempotency under repeat, and the kill-switch fail-closed audit row. Plus the
// gated-off master switch and the ARC-20/ARC-22 surface seams.

import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';

import { openFinalizationLedgerStore } from '../src/finalization/ledger-store.mjs';
import { openFinalizationExecutorLeaseStore } from '../src/finalization/executor-lease-store.mjs';
import { createFinalizationExecutor } from '../src/finalization/executor.mjs';
import { fold } from '../src/finalization/ledger-fold.mjs';
import { eligible } from '../src/finalization/eligibility.mjs';
import {
  checksSettled,
  revisionAdvanced,
  verdictRecorded,
} from '../src/finalization/ledger-events.mjs';

const REF = { domainId: 'code-pr', subjectExternalId: 'owner/repo#17' };
const t = (n) => new Date(Date.parse('2026-07-19T00:00:00.000Z') + n * 60000).toISOString();

function harness() {
  const db = new Database(':memory:');
  const ledgerStore = openFinalizationLedgerStore({ db });
  const leaseStore = openFinalizationExecutorLeaseStore({ db });
  return { db, ledgerStore, leaseStore };
}

// Append the events that make a subject finalize-eligible at `rev`.
function makeEligible(ledgerStore, rev = 'sha-A', base = 0) {
  ledgerStore.append(revisionAdvanced(REF, { at: t(base), revisionRef: rev, sourceRef: `push-${rev}` }));
  ledgerStore.append(checksSettled(REF, { at: t(base + 1), revisionRef: rev, conclusion: 'success', requiredChecksPresent: true, sourceRef: `ci-${rev}` }));
  ledgerStore.append(verdictRecorded(REF, { at: t(base + 2), revisionRef: rev, stageId: 'security', role: 'claude-reviewer', verdictKind: 'approved', sourceRef: `rev-${rev}` }));
}

function recordingMergeSurface() {
  const calls = [];
  return {
    name: 'fake-adjudicate',
    calls,
    async merge(args) {
      calls.push(args);
      return { ok: true, via: 'fake-adjudicate' };
    },
  };
}

test('ships gated off: tick is inert — no lease, no ledger write, no merge', async () => {
  const { ledgerStore, leaseStore } = harness();
  makeEligible(ledgerStore);
  const merge = recordingMergeSurface();
  const exec = createFinalizationExecutor({ ledgerStore, leaseStore, adjudicateSurface: merge, enabled: false });

  const out = await exec.tick(REF, { observedAt: t(10) });

  assert.equal(out.status, 'skipped');
  assert.equal(out.action, 'gated-off');
  assert.equal(merge.calls.length, 0, 'no merge while gated off');
  assert.equal(leaseStore.read(REF), null, 'no lease taken while gated off');
  assert.equal(ledgerStore.read(REF).length, 3, 'no ledger event appended while gated off');
});

test('finalize-now merges through the adjudicate surface and marks finalized', async () => {
  const { ledgerStore, leaseStore } = harness();
  makeEligible(ledgerStore);
  const merge = recordingMergeSurface();
  const exec = createFinalizationExecutor({ ledgerStore, leaseStore, adjudicateSurface: merge, enabled: true, mergeMethod: 'squash' });

  const out = await exec.tick(REF, { observedAt: t(10) });

  assert.equal(out.status, 'executed');
  assert.equal(out.action, 'merge');
  assert.equal(merge.calls.length, 1);
  assert.equal(merge.calls[0].revisionRef, 'sha-A');
  assert.equal(merge.calls[0].mergeMethod, 'squash');
  const state = fold(ledgerStore.read(REF));
  assert.equal(state.finalized?.kind, 'finalized');
  assert.equal(state.finalized?.revisionRef, 'sha-A');
  // The lease is released after the tick.
  assert.equal(leaseStore.read(REF), null, 'lease released after tick');
});

test('lease contention: a subject held by another executor is deferred, not acted', async () => {
  const { ledgerStore, leaseStore } = harness();
  makeEligible(ledgerStore);
  // Another executor is holding the lease with an unexpired deadline.
  leaseStore.acquire({ subject: REF, holder: 'other-exec', leaseId: 'other', now: t(9), deadline: t(20) });

  const merge = recordingMergeSurface();
  const exec = createFinalizationExecutor({ ledgerStore, leaseStore, adjudicateSurface: merge, enabled: true });
  const out = await exec.tick(REF, { observedAt: t(10) });

  assert.equal(out.status, 'deferred');
  assert.equal(out.action, 'lease-contended');
  assert.match(out.reason, /other-exec/);
  assert.equal(merge.calls.length, 0, 'contended subject is never merged');
  assert.equal(leaseStore.read(REF).holder, 'other-exec', 'the other holder is untouched');
});

test('re-fold discard on world-move: a stale decision is not executed', async () => {
  const { ledgerStore, leaseStore } = harness();
  makeEligible(ledgerStore);
  const merge = recordingMergeSurface();
  const exec = createFinalizationExecutor({ ledgerStore, leaseStore, adjudicateSurface: merge, enabled: true });

  // Decide at the current basis.
  const state = fold(ledgerStore.read(REF));
  const decision = eligible(state, undefined, { observedAt: t(10) });
  assert.equal(decision.kind, 'finalize-now');
  const basis = { eventCount: state.eventCount };

  // The world moves: a new revision is advanced before we execute the decision.
  ledgerStore.append(revisionAdvanced(REF, { at: t(11), revisionRef: 'sha-B', sourceRef: 'push-B' }));

  const out = await exec.execute(decision, { subject: REF, observedAt: t(12), basis });

  assert.equal(out.status, 'deferred');
  assert.equal(out.action, 're-decide');
  assert.match(out.reason, /world moved/);
  assert.equal(merge.calls.length, 0, 'the stale-revision decision is never merged');
  assert.equal(fold(ledgerStore.read(REF)).finalized, null, 'no finalized mark written for a discarded decision');
});

test('execute idempotency under repeat: a second execute does not re-merge', async () => {
  const { ledgerStore, leaseStore } = harness();
  makeEligible(ledgerStore);
  const merge = recordingMergeSurface();
  const exec = createFinalizationExecutor({ ledgerStore, leaseStore, adjudicateSurface: merge, enabled: true });

  const first = await exec.tick(REF, { observedAt: t(10) });
  assert.equal(first.status, 'executed');
  assert.equal(merge.calls.length, 1);

  // Repeat ticks re-fold, see the terminal `finalized` mark, and skip.
  const second = await exec.tick(REF, { observedAt: t(11) });
  const third = await exec.tick(REF, { observedAt: t(12) });

  assert.equal(second.status, 'skipped');
  assert.match(second.reason, /already finalized/);
  assert.equal(third.status, 'skipped');
  assert.equal(merge.calls.length, 1, 'merge is issued exactly once across repeats');
  assert.equal(fold(ledgerStore.read(REF)).eventCount, 4, 'exactly one finalized event appended (3 setup + 1)');
});

test('kill-switch fail-closed audit row: a mutating decision escalates, never merges', async () => {
  const { ledgerStore, leaseStore } = harness();
  makeEligible(ledgerStore);
  const merge = recordingMergeSurface();
  const exec = createFinalizationExecutor({
    ledgerStore, leaseStore, adjudicateSurface: merge, enabled: true,
    policy: { autonomousExecutionDisabled: true },
  });

  const out = await exec.tick(REF, { observedAt: t(10) });

  assert.equal(out.status, 'skipped');
  assert.equal(out.action, 'escalate');
  assert.equal(out.killSwitch, true);
  assert.equal(merge.calls.length, 0, 'kill switch blocks the merge adapter');

  // The fail-closed audit row: an `escalated` ledger event naming the interception.
  const events = ledgerStore.read(REF);
  const escalation = events.find((e) => e.type === 'escalated');
  assert.ok(escalation, 'an escalated audit event is recorded');
  assert.match(escalation.reason, /kill switch/i);
  assert.match(escalation.reason, /autonomous execution disabled/i);

  // It does not re-page: a second tick re-reads the terminal mark, appends nothing.
  await exec.tick(REF, { observedAt: t(11) });
  assert.equal(ledgerStore.read(REF).filter((e) => e.type === 'escalated').length, 1, 'no duplicate escalation / re-page');
});

test('executor-level kill-switch interception guards the mutation boundary directly', async () => {
  const { ledgerStore, leaseStore } = harness();
  makeEligible(ledgerStore);
  const merge = recordingMergeSurface();
  const exec = createFinalizationExecutor({
    ledgerStore, leaseStore, adjudicateSurface: merge, enabled: true,
    policy: { autonomousExecutionDisabled: true },
  });

  // A finalize-now decision arrives at execute() (e.g. computed under a different
  // policy). The executor re-checks the kill switch before any adapter call.
  const state = fold(ledgerStore.read(REF));
  const decision = { kind: 'finalize-now', subjectKey: REF, revisionRef: 'sha-A', observedAt: t(10) };
  const out = await exec.execute(decision, { subject: REF, observedAt: t(10), basis: { eventCount: state.eventCount } });

  assert.equal(out.killSwitch, true);
  assert.equal(out.action, 'escalate');
  assert.equal(merge.calls.length, 0, 'no merge adapter call past the kill switch');
});

test('identity/attestation surface (ARC-22) fail-closed: a denied check blocks the merge', async () => {
  const { ledgerStore, leaseStore } = harness();
  makeEligible(ledgerStore);
  const merge = recordingMergeSurface();
  const identitySurface = { check: async () => ({ ok: false, reason: 'attestation missing at head' }) };
  const exec = createFinalizationExecutor({
    ledgerStore, leaseStore, adjudicateSurface: merge, identitySurface, enabled: true,
  });

  const out = await exec.tick(REF, { observedAt: t(10) });

  assert.equal(out.status, 'skipped');
  assert.equal(out.action, 'escalate');
  assert.match(out.reason, /attestation missing/);
  assert.equal(merge.calls.length, 0, 'a failed identity check blocks the merge');
  assert.ok(ledgerStore.read(REF).some((e) => e.type === 'escalated'), 'the denial is recorded');
});

test('identity/attestation surface errors fail the tick without terminal escalation', async () => {
  const { ledgerStore, leaseStore } = harness();
  makeEligible(ledgerStore);
  const merge = recordingMergeSurface();
  const identitySurface = { check: async () => { throw new Error('surface unavailable'); } };
  const exec = createFinalizationExecutor({
    ledgerStore, leaseStore, adjudicateSurface: merge, identitySurface, enabled: true,
  });

  const out = await exec.tick(REF, { observedAt: t(10) });

  assert.equal(out.status, 'failed');
  assert.equal(out.action, 'merge');
  assert.match(out.reason, /surface unavailable/);
  assert.equal(merge.calls.length, 0, 'an unavailable identity surface blocks the merge');
  assert.equal(ledgerStore.read(REF).some((e) => e.type === 'escalated'), false, 'transient errors remain retryable');
});

test('an unavailable local merge adapter records terminal escalation', async () => {
  const { ledgerStore, leaseStore } = harness();
  makeEligible(ledgerStore);
  const unavailable = {
    name: 'github-adapter (local fallback)',
    merge: async () => ({ ok: false, reason: 'adapter-unavailable', detail: 'binary not resolvable' }),
  };
  const exec = createFinalizationExecutor({ ledgerStore, leaseStore, mergeFallback: unavailable, enabled: true });

  const out = await exec.tick(REF, { observedAt: t(10) });

  assert.equal(out.status, 'skipped');
  assert.equal(out.action, 'escalate');
  assert.match(out.reason, /no merge surface available/);
  assert.ok(ledgerStore.read(REF).some((e) => e.type === 'escalated'), 'missing adapter is recorded terminally');
});

test('remediate dispatches, and replaying the same decision is idempotent on the round key', async () => {
  const { ledgerStore, leaseStore } = harness();
  // A blocking verdict at the head → eligible returns remediate(round 1).
  ledgerStore.append(revisionAdvanced(REF, { at: t(0), revisionRef: 'sha-A', sourceRef: 'push-A' }));
  ledgerStore.append(checksSettled(REF, { at: t(1), revisionRef: 'sha-A', conclusion: 'success', requiredChecksPresent: true, sourceRef: 'ci-A' }));
  ledgerStore.append(verdictRecorded(REF, { at: t(2), revisionRef: 'sha-A', stageId: 'security', role: 'claude-reviewer', verdictKind: 'request-changes', sourceRef: 'rev-A' }));

  const dispatches = [];
  const remediationSurface = { dispatch: async (a) => { dispatches.push(a); } };
  const exec = createFinalizationExecutor({ ledgerStore, leaseStore, remediationSurface, enabled: true });

  const decision = eligible(fold(ledgerStore.read(REF)), undefined, { observedAt: t(10) });
  assert.equal(decision.kind, 'remediate');
  assert.equal(decision.round, 1);

  // Execute the round-1 decision, then REPLAY the very same decision. The second
  // pass re-folds, sees round 1 already dispatched, and skips (idempotent).
  const first = await exec.execute(decision, { subject: REF, observedAt: t(10) });
  assert.equal(first.status, 'executed');
  assert.equal(first.action, 'dispatch-remediation');
  assert.equal(dispatches.length, 1);
  assert.equal(dispatches[0].round, 1);

  const replay = await exec.execute(decision, { subject: REF, observedAt: t(11) });
  assert.equal(replay.status, 'skipped');
  assert.match(replay.reason, /already dispatched/);
  assert.equal(dispatches.length, 1, 'a replayed round-1 decision does not re-dispatch');
});

test('merge surface failure fails closed: no finalized mark, retried next tick', async () => {
  const { ledgerStore, leaseStore } = harness();
  makeEligible(ledgerStore);
  let attempts = 0;
  const flaky = {
    name: 'flaky',
    merge: async () => {
      attempts += 1;
      return attempts === 1 ? { ok: false, reason: 'merge-refused', detail: 'head moved' } : { ok: true };
    },
  };
  const exec = createFinalizationExecutor({ ledgerStore, leaseStore, adjudicateSurface: flaky, enabled: true });

  const first = await exec.tick(REF, { observedAt: t(10) });
  assert.equal(first.status, 'failed');
  assert.equal(fold(ledgerStore.read(REF)).finalized, null, 'no finalized mark on a failed merge');

  // The next tick re-folds and retries; the merge now succeeds.
  const second = await exec.tick(REF, { observedAt: t(11) });
  assert.equal(second.status, 'executed');
  assert.equal(fold(ledgerStore.read(REF)).finalized?.kind, 'finalized');
});
