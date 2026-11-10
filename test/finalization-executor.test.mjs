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

test('executor waits for a canonical live closer without dispatching or paging', async t => {
  const effects = [];
  const h = harness(t, {
    remediationSurface: { dispatch: async () => { effects.push('dispatch'); } },
    pageSurface: { deliver: async () => { effects.push('page'); } },
  });
  h.append('verdict_recorded', { revisionRef: 'head-A', verdictKind: 'request-changes',
    stageId: 'review', role: 'independent' }, 1);
  const ownerSnapshot = { subjectKey: subject.subjectExternalId, head: 'head-A', observedAt: at(2000),
    observations: {
      pr: { state: 'complete', value: { state: 'open', headSha: 'head-A' } },
      leases: { state: 'complete', value: { closer: { status: 'dispatched',
        headSha: 'head-A', updatedAt: at(0), deadlineAt: at(3000) } } },
      launches: { state: 'complete', value: { closer: null } },
    } };
  h.setLive({ state: 'open', head: 'head-A', sourceRef: 'fixture:live', ownerSnapshot });
  const result = await h.tick(2000);
  assert.equal(result.decision.kind, 'wait');
  assert.match(result.reason, /live-owner/);
  assert.equal(result.decision.deadline, at(3000));
  assert.deepEqual(effects, []);
  assert.equal(h.state().workflow.escalation, null);
});

test('owner evidence cannot suppress escalation after expiry or from a foreign/stale snapshot', async t => {
  const h = harness(t);
  // A new revision deliberately has no verdict, and its patience is expired.
  h.append('revision_advanced', { revisionRef: 'head-B' }, 1);
  h.append('provenance_observed', { revisionRef: 'head-B', builderBoundary: 'fixture:builder',
    primaryChange: 'preserved', hammerCommits: false, mergeMain: false }, 1);
  h.append('checks_settled', { revisionRef: 'head-B', conclusion: 'success', requiredChecksPresent: true }, 1);
  const s = { subjectKey: subject.subjectExternalId, head: 'head-B', observedAt: at(2000),
    observations: {
      pr: { state: 'complete', value: { state: 'open', headSha: 'head-B' } },
      leases: { state: 'complete', value: { closer: { status: 'dispatched',
        headSha: 'head-B', deadlineAt: at(2000) } } },
      launches: { state: 'complete', value: { closer: { status: 'running' } } },
    } };
  const state = h.state();
  for (const change of [
    {},
    { subjectKey: 'example/foreign#99', deadline: at(4000) },
    { observedAt: at(1000), deadline: at(4000) },
  ]) {
    const snapshot = structuredClone(s);
    Object.assign(snapshot, change);
    if (change.deadline) snapshot.observations.leases.value.closer.deadlineAt = change.deadline;
    const decision = eligible(state, { verdictPatienceMs: 1000 },
      { observedAt: at(2000), load, ownerSnapshot: snapshot });
    assert.equal(decision.kind, 'escalate');
    assert.match(decision.reason, /verdict patience expired/);
  }
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
for (const reply of ['throw', 'unsuccessful']) test(`uncertain ${reply} merge reply requires readback before retry`, async t => {
  let calls = 0;
  const h = harness(t, { adjudicateSurface: { merge: async () => {
    calls++;
    if (reply === 'throw') throw Error('fixture:lost-reply');
    return { ok: false };
  } } });
  assert.equal((await h.tick(100)).status, 'failed');
  const pending = h.state().workflow.operations['merge:head-A'];
  assert.equal(pending.observation, null);
  const recovery = await h.tick(200);
  assert.equal(recovery.action, 'reconcile-effects');
  assert.equal(recovery.reason, 'recovery-capability-unavailable');
  assert.equal(calls, 1);
  h.setLive({ state: 'merged', mergedRevision: 'head-A', principal: 'fixture-bot',
    planRequired: true, sourceRef: 'fixture:readback' });
  assert.equal((await h.tick(300)).action, 'deliver');
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
  assert.equal((await h.tick(100)).status, 'failed');
  const recovery = await h.tick(200);
  assert.equal(recovery.action, 'reconcile-effects');
  assert.equal(recovery.reason, 'recovery-capability-unavailable');
  assert.equal(h.state().workflow.operations['remediate:head-A:1'].observation, null);
  assert.equal(calls, 1);
  assert.equal(h.state().remediation.dispatched.length, 0);
});
test('authoritative absent dispatch evidence permits retry after a lost reply', async t => {
  let calls = 0;
  const h = harness(t, {
    remediationSurface: { dispatch: async () => {
      calls++;
      if (calls === 1) throw Error('fixture:lost-reply');
      return { admitted: true, launchId: 'fixture-launch', admittedAt: at(300) };
    } },
    recoverySurface: { reconcile: async ({ decision }) => ({
      ok: true, sourceRef: 'fixture:dispatch-readback',
      events: [makeFinalizationEvent('operation_observed', subject, {
        at: at(200), sourceRef: 'fixture:dispatch-readback', idempotencyKey: 'dispatch-absent',
        operationId: decision.operationId, outcome: 'absent', result: { launchId: null },
      })],
    }) },
  });
  h.append('verdict_recorded', { revisionRef: 'head-A', verdictKind: 'request-changes', stageId: 'review', role: 'independent' }, 1);
  assert.equal((await h.tick(100)).status, 'failed');
  assert.equal((await h.tick(200)).action, 'reconcile-effects');
  assert.equal((await h.tick(300)).action, 'dispatch-remediation');
  assert.equal(calls, 2);
  assert.equal(h.state().remediation.dispatched.length, 1);
});
test('lost close reply retains intent until authoritative closed readback', async t => {
  let calls = 0;
  const h = harness(t, { closeSurface: { close: async () => {
    calls++;
    throw Error('fixture:lost-close-reply');
  } } });
  h.append('operator_override', { overrideKind: 'close', principal: 'fixture-human', reason: 'obsolete PR' }, 1);
  assert.equal((await h.tick(100)).status, 'failed');
  assert.equal(Object.values(h.state().workflow.operations)[0].observation, null);
  const recovery = await h.tick(200);
  assert.equal(recovery.action, 'reconcile-effects');
  assert.equal(recovery.reason, 'recovery-capability-unavailable');
  assert.equal(calls, 1);
  h.setLive({ state: 'closed', sourceRef: 'fixture:closed-readback' });
  assert.equal((await h.tick(300)).action, 'settle-closed');
  assert.equal(calls, 1);
});
test('enabled executor requires a callable live reader at construction', t => {
  for (const liveSurface of [undefined, null, {}, { read: true }]) {
    assert.throws(() => harness(t, { liveSurface }),
      { name: 'TypeError', message: 'createFinalizationExecutor requires a liveSurface with read when enabled' });
  }
});
test('disabled executor remains inert without a live reader', async t => {
  const h = harness(t, { enabled: false, liveSurface: null });
  const before = h.state().eventCount;
  assert.equal((await h.tick(100)).action, 'gated-off');
  assert.equal(h.state().eventCount, before);
  assert.equal(h.leaseStore.read(subject), null);
});
test('missing lane router fails closed', async t => {
  const h = harness(t, { laneRouting: null });
  assert.equal((await h.tick(100)).status, 'failed');
  assert.equal(h.calls.length, 0);
});
test('configured live reader with unavailable evidence defers without mutation', async t => {
  const h = harness(t, { liveSurface: { read: async () => null } });
  assert.equal((await h.tick(100)).reason, 'authoritative-pr-reader-unavailable');
  assert.equal(h.calls.length, 0);
  assert.equal(h.leaseStore.read(subject), null);
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
