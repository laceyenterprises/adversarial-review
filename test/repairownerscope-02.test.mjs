// REPAIROWNERSCOPE-02: a repair reservation whose owner the review app cannot read
// escalates once at the deadline and names the operator action; once the owner is
// readable it resolves, and a terminal owner releases the review gate. The fake
// producer applies the documented visibility rule (a launch is readable only
// through an exact project/repository grant) behind the real dispatch-read
// client, and the real closure-wait store deduplicates the page. Every fixture
// is synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reserveRepairEpoch, reconcileRepairOwner, bindRepairHead, pendingRepairEpoch,
  repairEpochForHead, repairReservationOwnsPr, repairOwnerOperatorAction, repairOperatorHoldReason,
  REPAIR_ABSENCE_ESCALATE_MS, REPAIR_OWNER_OBSERVE_MS } from '../src/repair-epochs.mjs';
import { readDispatchLaunches } from '../src/dispatch-read-client.mjs';
import { observeClosureWait } from '../src/ama/closure-wait.mjs';
import { nextAction, deriveNextActionSnapshot } from '../src/pr-next-action.mjs';
import { resolveTtmOwner } from '../src/ttm-owner.mjs';

const repo = 'example/widgets';
const prNumber = 41;
const base = 'a'.repeat(40);
const moved = 'b'.repeat(40);
const ownerKey = 'repair-key-two';
// The project the review service's own remediation handoff and the merge-agent
// recovery record by default; it appears in this repository's source.
const handoffProject = 'pr-merge-orchestration';
const closerProject = 'fixture-closer-project';
const reservedAt = '2026-01-01T00:00:00.000Z';
const at = ms => Date.parse(reservedAt) + ms;

const launch = (over = {}) => ({ launch_request_id: 'lrq_synthetic_owner_two', idempotency_key: ownerKey,
  status: 'succeeded', target_repo: repo, head_sha: base, identity_ambiguous: false,
  project_ref: handoffProject, ...over });

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
    return { schema_version: 1, status: items.length ? 'found' : 'not_found', complete: true,
      roots: items.map(row => row.launch_request_id), items, retry_edges: [], scope_complete: false };
  };
  return { calls, readImpl: (selector, args) => readDispatchLaunches(selector,
    { ...args, dispatchSession: { dispatchLookup } }) };
}

function fixture(t, over = {}) {
  const rootDir = mkdtempSync(join(tmpdir(), 'repair-owner-scope-two-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const pages = [];
  const observeWait = args => observeClosureWait({ ...args,
    pageImpl: async (text, options) => { pages.push({ text, options }); return { ok: true }; } });
  return { rootDir, repo, prNumber, headSha: base, ownerKey, cause: 'closure-retry-exhausted',
    now: reservedAt, pages, observeWait, ...over };
}

const snapshot = epoch => deriveNextActionSnapshot({ subjectKey: `${repo}#${prNumber}`, head: moved,
  observedAt: reservedAt, observations: { pr: { state: 'OPEN', headSha: moved, labels: [] },
    policy: { autonomousMergeExecutionEnabled: true }, progress: { repairEpoch: epoch } } });
const CLOSER_ONLY = [{ project_ref: closerProject, repo }];
const DECLARED = [...CLOSER_ONLY, { project_ref: handoffProject, repo }];

test('a declared pr-merge-orchestration owner resolves; before the grant it escalates naming the exact pair', async t => {
  const f = fixture(t);
  reserveRepairEpoch({ ...f, dispatchProjectRef: handoffProject });
  const hidden = fakeProducer({ launches: [launch()], grants: CLOSER_ONLY });
  const { rootDir, observeWait } = f;
  const held = await reconcileRepairOwner({ rootDir, repo, prNumber, headSha: moved,
    now: at(REPAIR_ABSENCE_ESCALATE_MS), readImpl: hidden.readImpl, observeWait });
  assert.equal(held.ownerState, 'unknown');
  assert.deepEqual(hidden.calls.at(-1), { idempotency_key: ownerKey, project_ref: handoffProject, repo });
  assert.deepEqual(repairOwnerOperatorAction(held),
    { action: 'grant-owner-dispatch-read', scope: 'recorded', project: handoffProject });
  assert.equal(f.pages.length, 1);
  assert.match(f.pages[0].text, new RegExp(`project ${handoffProject} and repository ${repo}`));
  assert.doesNotMatch(f.pages[0].text, new RegExp(ownerKey));
  const action = nextAction(snapshot(held));
  assert.equal(action.reason, 'repair-owner-unproven');
  assert.ok(action.evidenceRefs.includes('operator-action:grant-owner-dispatch-read'));
  assert.ok(action.evidenceRefs.includes(`repair-owner-scope:${handoffProject}`));

  // The operator applies the declared pair: the owner resolves on the next pass.
  const visible = fakeProducer({ launches: [launch()], grants: DECLARED });
  const readPublisher = async () => ({ ok: true, rowHeadSha: moved, launchRequestId: 'lrq_synthetic_owner_two' });
  const resolved = await reconcileRepairOwner({ rootDir, repo, prNumber, headSha: moved,
    now: at(REPAIR_ABSENCE_ESCALATE_MS + REPAIR_OWNER_OBSERVE_MS), readImpl: visible.readImpl,
    readPublisher, observeWait });
  assert.equal(resolved.ownerState, 'terminal');
  assert.equal(resolved.ownerLaunch, 'lrq_synthetic_owner_two');
  assert.equal(repairOwnerOperatorAction(resolved), null);
  assert.equal(repairOperatorHoldReason(resolved), null);
  assert.equal(f.pages.length, 1, 'a resolved owner sends no further page');
});

test('an unscoped legacy epoch escalates once at the deadline and names the operator action', async t => {
  const f = fixture(t);
  const epoch = reserveRepairEpoch(f).epoch;
  assert.equal(Object.hasOwn(epoch, 'dispatchProjectRef'), false);
  const hidden = fakeProducer({ launches: [launch()], grants: CLOSER_ONLY });
  const pass = now => reconcileRepairOwner({ rootDir: f.rootDir, repo, prNumber, headSha: moved, now,
    readImpl: hidden.readImpl, observeWait: f.observeWait });

  // Before the deadline: custody is the repair worker's and nothing pages.
  const early = await pass(at(REPAIR_ABSENCE_ESCALATE_MS - REPAIR_OWNER_OBSERVE_MS));
  assert.equal(early.ownerState, 'unknown');
  assert.equal(repairOwnerOperatorAction(early), null);
  assert.equal(nextAction(snapshot(early)).reason, 'repair-in-place-owned');
  assert.equal(f.pages.length, 0);

  // At the deadline: one page, operator custody, and the named action.
  const due = await pass(at(REPAIR_ABSENCE_ESCALATE_MS));
  assert.equal(due.ownerState, 'unknown');
  assert.equal(Object.hasOwn(due, 'dispatchProjectRef'), false, 'no scope is guessed');
  assert.deepEqual(repairOwnerOperatorAction(due), { action: 'establish-owner-dispatch-scope', scope: 'unrecorded' });
  assert.equal(f.pages.length, 1);
  assert.equal(f.pages[0].options.severity, 'SEV1');
  assert.match(f.pages[0].options.dedupKey, /repair-owner-unproven$/);
  assert.match(f.pages[0].text, /records no dispatch scope/);
  assert.match(f.pages[0].text, /retire-legacy-repair\.mjs/);
  assert.match(f.pages[0].text, new RegExp(moved));
  const action = nextAction(snapshot(due));
  assert.equal(action.action, 'operator-hold');
  assert.equal(action.actor, 'operator');
  assert.ok(action.evidenceRefs.includes('operator-action:establish-owner-dispatch-scope'));
  assert.ok(action.evidenceRefs.includes('repair-owner-scope:unrecorded'));
  assert.match(resolveTtmOwner({ repairEpoch: due }).reason, /operator action: establish-owner-dispatch-scope/);

  // Later passes keep operator custody but never page again for this reservation.
  await pass(at(REPAIR_ABSENCE_ESCALATE_MS + REPAIR_OWNER_OBSERVE_MS));
  await pass(at(REPAIR_ABSENCE_ESCALATE_MS + 4 * REPAIR_OWNER_OBSERVE_MS));
  assert.equal(f.pages.length, 1);
  assert.equal(repairOperatorHoldReason(pendingRepairEpoch(f.rootDir, f)), 'repair-owner-unproven');
});

test('a terminal owner releases the review gate at the moved head and the review binds', async t => {
  const f = fixture(t);
  const epoch = reserveRepairEpoch(f).epoch;
  // The legacy epoch's owner becomes readable once its project is granted.
  const visible = fakeProducer({ launches: [launch()], grants: DECLARED });
  assert.equal(repairReservationOwnsPr(epoch, moved), true);
  const readPublisher = async () => ({ ok: true, rowHeadSha: moved, launchRequestId: 'lrq_synthetic_owner_two' });
  const released = await reconcileRepairOwner({ rootDir: f.rootDir, repo, prNumber, headSha: moved,
    now: at(REPAIR_ABSENCE_ESCALATE_MS * 3), readImpl: visible.readImpl, readPublisher, observeWait: f.observeWait });
  assert.equal(released.ownerState, 'terminal');
  assert.equal(released.dispatchProjectRef, handoffProject, 'the scope is recorded once from the owner record');
  assert.equal(released.publicationHead, moved);
  assert.equal(released.publicationLaunch, 'lrq_synthetic_owner_two');
  assert.equal(repairReservationOwnsPr(released, moved), false, 'the gate releases on this pass');
  const bound = bindRepairHead({ rootDir: f.rootDir, repo, prNumber, headSha: moved, epochId: epoch.id });
  assert.equal(bound.reviewHead, moved);
  assert.equal(pendingRepairEpoch(f.rootDir, f), null);
  assert.equal(repairEpochForHead(f.rootDir, f, moved).id, epoch.id);
  // The next pass finds the bound epoch for this head and keeps the gate open.
  const next = await reconcileRepairOwner({ rootDir: f.rootDir, repo, prNumber, headSha: moved,
    now: at(REPAIR_ABSENCE_ESCALATE_MS * 3 + REPAIR_OWNER_OBSERVE_MS), readImpl: visible.readImpl,
    includeReviewedHead: true, observeWait: f.observeWait });
  assert.equal(next.reviewHead, moved);
  assert.equal(repairReservationOwnsPr(next, moved), false);
  assert.equal(f.pages.length, 0);
});

test('a terminal owner whose head moved without its attestation retires custody instead of holding', async t => {
  const f = fixture(t);
  reserveRepairEpoch({ ...f, dispatchProjectRef: handoffProject });
  const visible = fakeProducer({ launches: [launch({ status: 'failed' })], grants: DECLARED });
  const readPublisher = async () => ({ ok: false, reason: 'missing-produced-head-attestation' });
  const result = await reconcileRepairOwner({ rootDir: f.rootDir, repo, prNumber, headSha: moved,
    now: at(REPAIR_OWNER_OBSERVE_MS), readImpl: visible.readImpl, readPublisher, observeWait: f.observeWait });
  assert.equal(result, null, 'no pending reservation remains');
  assert.equal(pendingRepairEpoch(f.rootDir, f), null);
  assert.equal(repairReservationOwnsPr(pendingRepairEpoch(f.rootDir, f), moved), false);
  assert.equal(f.pages.length, 0);
});
