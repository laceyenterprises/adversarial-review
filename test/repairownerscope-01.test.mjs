// REPAIROWNERSCOPE-01: a repair reservation's owner launch must be readable by
// the review app. The fake producer below applies the documented visibility rule
// (a launch is readable only through an exact project/repository grant) behind
// the real dispatch-read client, so absence-proof and failure handling are real.
// Every fixture is synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reserveRepairEpoch, observeRepairOwner, reconcileRepairOwner, bindRepairHead,
  pendingRepairEpoch, repairEpochForHead, repairReservationOwnsPr,
  REPAIR_ABSENCE_ESCALATE_MS, REPAIR_OWNER_OBSERVE_MS } from '../src/repair-epochs.mjs';
import { readHammerRetryCapLedger } from '../src/ama/hammer-retry-cap.mjs';
import { readDispatchLaunches } from '../src/dispatch-read-client.mjs';

const repo = 'example/widgets';
const prNumber = 31;
const base = 'a'.repeat(40);
const moved = 'b'.repeat(40);
const ownerProject = 'fixture-repair-project';
const closerProject = 'fixture-closer-project';

const launch = (over = {}) => ({ launch_request_id: 'lrq_synthetic_owner', idempotency_key: 'repair-key-one',
  status: 'succeeded', target_repo: repo, head_sha: base, identity_ambiguous: false,
  project_ref: ownerProject, ...over });

// Visibility: the (project_ref, repo) pair must be granted. A scoped selector
// needs its own exact pair or is refused, exactly like the producer's 403.
function fakeProducer({ launches, grants }) {
  const calls = [];
  const dispatchLookup = async selector => {
    calls.push(selector);
    const granted = row => grants.some(g => g.project_ref === row.project_ref && g.repo === row.target_repo);
    const scoped = 'project_ref' in selector || 'repo' in selector;
    if (scoped && !grants.some(g => g.project_ref === selector.project_ref && g.repo === selector.repo)) {
      throw Object.assign(new Error('app-contract 403 dispatch_scope_denied'), { status: 403 });
    }
    const matching = launches.filter(row => selector.idempotency_key
      ? row.idempotency_key === selector.idempotency_key
      : selector.launch_request_ids.includes(row.launch_request_id));
    const items = matching.filter(granted);
    const reply = { schema_version: 1, status: items.length ? 'found' : 'not_found', complete: true,
      roots: items.map(row => row.launch_request_id), items, retry_edges: [], scope_complete: false };
    if (!items.length && scoped && !matching.length && selector.idempotency_key) {
      reply.scope_complete = true;
      reply.absence_proof = { version: 1, kind: 'canonical-exact-selector-absence', selector,
        grant_id: 'project-repository-dispatch-read', observed_at: new Date().toISOString() };
    }
    return reply;
  };
  return { calls, dispatchLookup,
    readImpl: (selector, args) => readDispatchLaunches(selector, { ...args, dispatchSession: { dispatchLookup } }) };
}

function fixture(t, over = {}) {
  const rootDir = mkdtempSync(join(tmpdir(), 'repair-owner-scope-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  return { rootDir, repo, prNumber, headSha: base, ownerKey: 'repair-key-one',
    cause: 'conflict-without-owner', now: '2026-01-01T00:00:00Z', ...over };
}
const COVERED = [{ project_ref: closerProject, repo }, { project_ref: ownerProject, repo }];
const CLOSER_ONLY = [{ project_ref: closerProject, repo }];

test('the owner launch is invisible to a closer-only grant: unknown, never absent', async t => {
  const f = fixture(t);
  const epoch = reserveRepairEpoch({ ...f, dispatchProjectRef: ownerProject }).epoch;
  const legacy = reserveRepairEpoch({ ...fixture(t), ownerKey: 'repair-key-one' }).epoch;
  const producer = fakeProducer({ launches: [launch()], grants: CLOSER_ONLY });
  // Scoped epoch: the exact pair is not granted, so the read is refused.
  const scoped = await observeRepairOwner({ ...f, epoch, readImpl: producer.readImpl });
  assert.equal(scoped.ownerState, 'unknown');
  assert.deepEqual(producer.calls.at(-1), { idempotency_key: 'repair-key-one', project_ref: ownerProject, repo });
  // Legacy epoch: the key read is filtered to nothing and certifies nothing.
  const unscoped = await observeRepairOwner({ ...f, epoch: legacy, readImpl: producer.readImpl });
  assert.equal(unscoped.ownerState, 'unknown');
  assert.equal(unscoped.ownerLaunch, undefined);
  const direct = await producer.readImpl({ idempotency_key: 'repair-key-one' }, {});
  assert.deepEqual([direct.ok, direct.detail], [false, 'dispatch absence scope unproven']);
});

test('a scoped owner launch resolves to terminal and live once the app grant covers it', async t => {
  for (const [status, state] of [['succeeded', 'terminal'], ['canceled', 'terminal'], ['running', 'live']]) {
    const f = fixture(t);
    const epoch = reserveRepairEpoch({ ...f, dispatchProjectRef: ownerProject }).epoch;
    const producer = fakeProducer({ launches: [launch({ status })], grants: COVERED });
    const observed = await observeRepairOwner({ ...f, epoch, readImpl: producer.readImpl });
    assert.equal(observed.ownerState, state, status);
    assert.equal(observed.ownerLaunch, 'lrq_synthetic_owner');
    assert.deepEqual(producer.calls[0], { idempotency_key: 'repair-key-one', project_ref: ownerProject, repo });
  }
});

test('publication binds at the moved head, the review gate releases, and the review binds', async t => {
  const f = fixture(t);
  const epoch = reserveRepairEpoch({ ...f, dispatchProjectRef: ownerProject }).epoch;
  const producer = fakeProducer({ launches: [launch()], grants: COVERED });
  let publisherReads = 0;
  const readPublisher = async () => {
    publisherReads++;
    return { ok: true, rowHeadSha: moved, launchRequestId: 'lrq_synthetic_owner' };
  };
  assert.equal(repairReservationOwnsPr(epoch, moved), true, 'before publication the reservation owns the PR');
  const reconciled = await reconcileRepairOwner({ ...f, headSha: moved, readImpl: producer.readImpl, readPublisher });
  assert.equal(reconciled.ownerState, 'terminal');
  assert.equal(reconciled.publicationHead, moved);
  assert.equal(reconciled.publicationLaunch, 'lrq_synthetic_owner');
  assert.equal(publisherReads, 1);
  assert.equal(repairReservationOwnsPr(reconciled, moved), false, 'the gate releases at the published head');
  assert.equal(repairReservationOwnsPr(reconciled, 'c'.repeat(40)), true, 'a different head stays held');
  const bound = bindRepairHead({ ...f, headSha: moved, epochId: reconciled.id });
  assert.equal(bound.reviewHead, moved);
  assert.equal(repairEpochForHead(f.rootDir, f, moved).id, epoch.id);
  assert.equal(pendingRepairEpoch(f.rootDir, f), null);
});

test('an unscoped legacy epoch derives its scope once from the owner launch record', async t => {
  const f = fixture(t);
  const legacy = reserveRepairEpoch(f).epoch;
  assert.equal(Object.hasOwn(legacy, 'dispatchProjectRef'), false);
  const producer = fakeProducer({ launches: [launch({ status: 'running' })], grants: COVERED });
  const first = await reconcileRepairOwner({ ...f, now: Date.parse(f.now) + 60_000, readImpl: producer.readImpl });
  assert.equal(first.ownerState, 'live');
  assert.equal(first.dispatchProjectRef, ownerProject);
  assert.equal(first.dispatchProjectDerivedAt, first.ownerObservedAt);
  assert.equal(readHammerRetryCapLedger(f.rootDir, f).repairEpochs[0].dispatchProjectRef, ownerProject);
  // Later observations use the recorded scope and never re-derive or overwrite it.
  producer.calls.length = 0;
  const second = await reconcileRepairOwner({ ...f, now: Date.parse(f.now) + 60_000 + REPAIR_OWNER_OBSERVE_MS,
    readImpl: producer.readImpl });
  assert.deepEqual(producer.calls[0], { idempotency_key: 'repair-key-one', project_ref: ownerProject, repo });
  assert.equal(second.dispatchProjectRef, ownerProject);
  assert.equal(second.dispatchProjectDerivedAt, first.dispatchProjectDerivedAt);
});

test('scope is never guessed: an unresolved owner derives nothing and escalates through the overdue path', async t => {
  const f = fixture(t);
  const legacy = reserveRepairEpoch(f).epoch;
  const producer = fakeProducer({ launches: [launch()], grants: CLOSER_ONLY });
  const waits = [];
  const observeWait = async wait => { waits.push(wait); };
  const now = Date.parse(f.now) + REPAIR_ABSENCE_ESCALATE_MS;
  const observed = await reconcileRepairOwner({ ...f, now, readImpl: producer.readImpl, observeWait });
  assert.equal(observed.ownerState, 'unknown');
  assert.equal(Object.hasOwn(observed, 'dispatchProjectRef'), false);
  assert.equal(Object.hasOwn(observed, 'dispatchProjectDerivedAt'), false);
  assert.equal(waits.length, 1);
  assert.equal(waits[0].waitClass, 'repair-owner-unproven');
  assert.equal(waits[0].immediate, true);
  assert.equal(waits[0].headSha, `${legacy.baseHead}:${legacy.id}`);
});

test('a failed owner record read stays unknown and records no scope', async t => {
  const f = fixture(t);
  reserveRepairEpoch(f);
  for (const readImpl of [
    async () => ({ ok: false, reason: 'dispatch-read-unavailable', detail: 'dispatch lookup failed' }),
    async () => { throw new Error('transport down'); },
  ]) {
    const epoch = pendingRepairEpoch(f.rootDir, f);
    const observed = await observeRepairOwner({ ...f, epoch, readImpl: async (...args) => {
      try { return await readImpl(...args); } catch { return { ok: false, reason: 'dispatch-read-unavailable' }; }
    } });
    assert.equal(observed.ownerState, 'unknown');
    assert.equal(observed.ownerProjectRef, undefined);
  }
  // A key read that finds the owner but whose retry-chain read fails derives nothing either.
  const epoch = pendingRepairEpoch(f.rootDir, f);
  const producer = fakeProducer({ launches: [launch()], grants: COVERED });
  const partial = await observeRepairOwner({ ...f, epoch, readImpl: (selector, args) => selector.idempotency_key
    ? producer.readImpl(selector, args) : { ok: false, reason: 'dispatch-read-unavailable' } });
  assert.equal(partial.ownerState, 'unknown');
  assert.equal(partial.ownerProjectRef, undefined);
  const after = await reconcileRepairOwner({ ...f, now: Date.parse(f.now) + 60_000,
    readImpl: (selector, args) => selector.idempotency_key
      ? producer.readImpl(selector, args) : { ok: false, reason: 'dispatch-read-unavailable' } });
  assert.equal(Object.hasOwn(after, 'dispatchProjectRef'), false);
});

test('an owner record that contradicts the bound scope is not resolved', async t => {
  const f = fixture(t);
  const epoch = reserveRepairEpoch({ ...f, dispatchProjectRef: ownerProject }).epoch;
  const contradicting = { ok: true, roots: ['lrq_synthetic_owner'],
    rows: [launch({ project_ref: 'other-project' })], retryEdges: [] };
  const observed = await observeRepairOwner({ ...f, epoch, readImpl: async () => contradicting });
  assert.equal(observed.ownerState, 'unknown');
});

test('owner records without a project (older producers) and malformed projects derive no scope', async t => {
  for (const project_ref of [undefined, '', 'has space', 'x'.repeat(257), 7]) {
    const f = fixture(t);
    const epoch = reserveRepairEpoch(f).epoch;
    const row = launch({ status: 'running' });
    if (project_ref === undefined) delete row.project_ref; else row.project_ref = project_ref;
    const observed = await observeRepairOwner({ ...f, epoch, readImpl: async () => (
      { ok: true, roots: [row.launch_request_id], rows: [row], retryEdges: [] }) });
    assert.equal(observed.ownerState, 'live');
    assert.equal(observed.ownerProjectRef, undefined);
  }
});
