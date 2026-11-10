import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { openFinalizationLedgerStore } from '../src/finalization/ledger-store.mjs';
import { openFinalizationExecutorLeaseStore } from '../src/finalization/executor-lease-store.mjs';
import { createFinalizationExecutor } from '../src/finalization/executor.mjs';
import { makeFinalizationEvent } from '../src/finalization/ledger-events.mjs';
import { fold } from '../src/finalization/ledger-fold.mjs';
import { eligible } from '../src/finalization/eligibility.mjs';

const subject = { domainId: 'code-pr', subjectExternalId: 'example/project#17' };
const at = n => new Date(Date.UTC(2030, 0, 1) + n).toISOString();
const load = { loadAvg1m: 0, cpuCount: 1, cpuBusyPercent: 100 };
function harness(t, options = {}) {
  const db = new Database(':memory:');
  t.after(() => db.close());
  const ledgerStore = openFinalizationLedgerStore({ db });
  const leaseStore = openFinalizationExecutorLeaseStore({ db });
  const append = (type, fields = {}, n = 0) => ledgerStore.append(makeFinalizationEvent(type, subject, {
    at: at(n), sourceRef: `fixture:${type}:${n}`, idempotencyKey: `${type}:${n}`, ...fields,
  }));
  append('revision_advanced', { revisionRef: 'head-A' });
  append('provenance_observed', { revisionRef: 'head-A', builderBoundary: 'fixture:builder',
    primaryChange: 'preserved', hammerCommits: false, mergeMain: false });
  append('checks_settled', { revisionRef: 'head-A', conclusion: 'success', requiredChecksPresent: true });
  append('verdict_recorded', { revisionRef: 'head-A', verdictKind: 'approved', stageId: 'review', role: 'independent' });
  let live = { state: 'open', head: 'head-A', base: 'main', sourceRef: 'fixture:live' };
  const calls = [];
  const executor = createFinalizationExecutor({ enabled: true, ledgerStore, leaseStore,
    holder: 'fixture-executor', policy: { checksPatienceMs: 1000, verdictPatienceMs: 1000, attestationPatienceMs: 1000 },
    laneRouting: { run: ({ legacy }) => legacy() },
    liveSurface: { read: async () => live },
    adjudicateSurface: { merge: async args => {
      calls.push(args);
      live = { ...live, state: 'merged', mergedRevision: args.revisionRef, principal: 'fixture-bot', planRequired: true };
      return { ok: true };
    } }, ...options,
  });
  return { executor, append, calls, ledgerStore, leaseStore, state: () => fold(ledgerStore.read(subject)),
    setLive: value => { live = value; }, tick: n => executor.tick(subject, { observedAt: at(n), load }) };
}

test('gated-off tick and execute cannot acquire authority or write', async t => {
  const h = harness(t, { enabled: false });
  assert.equal((await h.tick(100)).action, 'gated-off');
  const before = h.state().eventCount;
  await h.executor.execute(eligible(h.state(), {}, { observedAt: at(100) }), { subject, observedAt: at(100) });
  assert.equal(h.calls.length, 0);
  assert.equal(h.state().eventCount, before);
  assert.equal(h.leaseStore.read(subject), null);
});
test('landing requires authoritative readback and a separate verified PMA receipt', async t => {
  const h = harness(t, { deliverySurface: { reconcile: async () => ({ planRunId: 'fixture-plan', activation: 'verified', sourceRef: 'fixture:activation' }) } });
  assert.equal((await h.tick(100)).action, 'merge');
  assert.equal(h.state().finalized, null);
  assert.equal((await h.tick(200)).action, 'deliver');
  assert.equal(h.state().finalized, null);
  assert.equal((await h.tick(300)).action, 'settle-delivery');
  assert.equal(h.state().finalized.revisionRef, 'head-A');
  assert.equal((await h.tick(400)).reason, 'already finalized');
  assert.equal(h.calls.length, 1);
});
test('a manual foreign-revision merge settles delivery without calling merge', async t => {
  const h = harness(t);
  h.setLive({ state: 'merged', mergedRevision: 'external-head', principal: 'fixture-human', planRequired: true, sourceRef: 'fixture:manual' });
  assert.equal((await h.tick(100)).action, 'deliver');
  assert.equal(h.state().workflow.merge.principal, 'fixture-human');
  assert.equal(h.state().finalized, null);
  assert.equal(h.calls.length, 0);
});
test('closed PR settles before any claim or dispatch', async t => {
  const h = harness(t);
  h.setLive({ state: 'closed', sourceRef: 'fixture:closed' });
  assert.equal((await h.tick(100)).action, 'settle-closed');
  assert.equal(h.leaseStore.read(subject), null);
  assert.equal(h.calls.length, 0);
});
test('merge reply without live readback never finalizes or repeats an uncertain effect', async t => {
  let calls = 0;
  const h = harness(t, { adjudicateSurface: { merge: async () => { calls++; return { ok: true }; } } });
  await h.tick(100);
  assert.equal((await h.tick(200)).action, 'reconcile-effects');
  assert.equal(calls, 1);
  assert.equal(h.state().finalized, null);
});
test('crash after merge effect is reconciled without a second mutation', async t => {
  let calls = 0;
  let merged = false;
  const h = harness(t, {
    liveSurface: { read: async () => ({ state: merged ? 'merged' : 'open', head: 'head-A', mergedRevision: 'head-A', principal: 'fixture-bot', planRequired: true, sourceRef: 'fixture:live' }) },
    adjudicateSurface: { merge: async () => { calls++; merged = true; throw Error('fixture:crash'); } },
  });
  await h.tick(100);
  assert.equal((await h.tick(200)).action, 'deliver');
  assert.equal(calls, 1);
});
test('lease contention keeps the current holder and prevents effects', async t => {
  const h = harness(t);
  h.leaseStore.acquire({ subject, holder: 'rival', leaseId: 'rival-lease', now: at(0), deadline: at(500) });
  assert.equal((await h.tick(100)).action, 'lease-contended');
  assert.equal(h.calls.length, 0);
  assert.equal(h.leaseStore.read(subject).holder, 'rival');
});
test('a stale decision is discarded after a head move', async t => {
  const h = harness(t);
  const state = h.state();
  const decision = eligible(state, {}, { observedAt: at(100) });
  h.append('revision_advanced', { revisionRef: 'head-B' }, 150);
  const out = await h.executor.execute(decision, { subject, observedAt: at(200), basis: { eventCount: state.eventCount } });
  assert.equal(out.action, 're-decide');
  assert.equal(h.calls.length, 0);
});
test('head movement during identity read blocks the merge at the last read', async t => {
  let h;
  h = harness(t, { identitySurface: { check: async () => {
    h.setLive({ state: 'open', head: 'head-B', sourceRef: 'fixture:push' }); return { ok: true };
  } } });
  assert.equal((await h.tick(100)).reason, 'world-moved-before-merge');
  assert.equal(h.calls.length, 0);
});
for (const result of ['bounce', 'missing']) test(`attestation ${result} remains retryable without terminal refusal`, async t => {
  const h = harness(t, { identitySurface: { check: async () => {
    if (result === 'bounce') throw Error('fixture:503');
    return { ok: false, reason: 'fixture:attestation-missing' };
  } } });
  assert.equal((await h.tick(100)).action, 'refresh-attestation');
  assert.equal((await h.tick(200)).action, 'refresh-attestation');
  assert.equal(h.state().terminal, null);
  assert.equal(h.calls.length, 0);
});
test('explicit admission refusal records no dispatch or useful round', async t => {
  const h = harness(t, { remediationSurface: { dispatch: async () => ({ admitted: false, reason: 'fixture:busy' }) } });
  h.append('verdict_recorded', { revisionRef: 'head-A', verdictKind: 'request-changes', stageId: 'review', role: 'independent' }, 1);
  await h.tick(100); await h.tick(200);
  assert.equal(h.state().remediation.dispatched.length, 0);
  assert.equal(Object.keys(h.state().workflow.work).length, 0);
});
test('admitted launch is recorded once and receives admission-based patience', async t => {
  let calls = 0;
  const h = harness(t, { remediationSurface: { dispatch: async () => { calls++; return { admitted: true, launchId: 'fixture-launch', admittedAt: at(200) }; } } });
  h.append('verdict_recorded', { revisionRef: 'head-A', verdictKind: 'request-changes', stageId: 'review', role: 'independent' }, 1);
  await h.tick(200);
  const out = await h.tick(300);
  assert.equal(out.action, 'reconcile-dispatch');
  assert.equal(out.decision.deadline, at(1200));
  assert.equal(calls, 1);
});
test('unknown dispatch effect is reconciled before any retry', async t => {
  let calls = 0;
  const h = harness(t, { remediationSurface: { dispatch: async () => { calls++; throw Error('fixture:lost-reply'); } } });
  h.append('verdict_recorded', { revisionRef: 'head-A', verdictKind: 'request-changes', stageId: 'review', role: 'independent' }, 1);
  await h.tick(100); await h.tick(200);
  assert.equal(calls, 1);
  assert.equal(h.state().remediation.dispatched.length, 0);
});
test('missing live reader and missing lane router fail closed', async t => {
  for (const options of [{ liveSurface: null }, { laneRouting: null }]) {
    const h = harness(t, options);
    assert.equal((await h.tick(100)).status, options.liveSurface === null ? 'deferred' : 'failed');
    assert.equal(h.calls.length, 0);
  }
});
test('queue acknowledgement does not claim a merge', async t => {
  const h = harness(t, { laneRouting: { run: async () => ({ ok: true, queued: true }) } });
  assert.equal((await h.tick(100)).status, 'deferred');
  assert.equal(h.state().finalized, null);
  assert.equal(h.calls.length, 0);
});
test('kill switch intercepts dispatch, merge, conflict and PMA mutation', async t => {
  const h = harness(t, { policy: { autonomousExecutionDisabled: true } });
  const result = await h.tick(100);
  assert.equal(result.action, 'escalate');
  assert.equal(h.calls.length, 0);
  assert.ok(result.decision.owner);
});
test('failed page delivery retries with one stable episode key and persists acknowledgement', async t => {
  const keys = [];
  const h = harness(t, { pageSurface: { deliver: async ({ idempotencyKey }) => {
    keys.push(idempotencyKey);
    return keys.length > 1 ? { delivered: true, sourceRef: 'fixture:page-ack' } : { delivered: false };
  } } });
  await h.tick(1100); await h.tick(1200); await h.tick(1300);
  assert.equal(keys.length, 2);
  assert.equal(new Set(keys).size, 1);
  assert.equal(Object.keys(h.state().workflow.pages).length, 1);
});
