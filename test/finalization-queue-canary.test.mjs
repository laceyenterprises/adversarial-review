import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openFinalizationQueueStore } from '../src/finalization/queue-store.mjs';
import { createQueueOwner } from '../src/finalization/queue-owner.mjs';
import { createLaneRoutingController, resolveLaneRoute } from '../src/finalization/queue-routing.mjs';
import { createCleanReviewService } from '../src/finalization/queue-clean-review.mjs';
import { createQueueHandoffService } from '../src/finalization/queue-handoff-store.mjs';
import { createQueueAdmissionService } from '../src/finalization/queue-admission.mjs';
import { openFinalizationShadowStore } from '../src/finalization/shadow-store.mjs';
import { probeQueueOwner, queueProbeMain } from '../src/finalization/queue-probe.mjs';
import { queueRuntimeBuild } from '../src/finalization/queue-build.mjs';
import { CANARY_RECOVERIES, CANARY_PRODUCERS, CANARY_ROLLBACK_STEPS, resolveQueueCanaryAdapter } from '../src/finalization/queue-canary.mjs';
import { queueCleanFixture, queueLiveFixture } from './helpers/queue-clean-fixture.mjs';
import { queueHandoffFixture } from './helpers/queue-handoff-fixture.mjs';

const lane = { repository: 'example/review', base: 'main' };
const cfg = { laneRoutes: [{ ...lane, executor: 'queue-v2' }] };
const at = '2026-10-25T00:01:00.000Z', now = '2026-10-25T00:10:00.000Z';
const validUntil = '2026-10-25T00:14:00.000Z';
const drainAdapter = { read: async () => ({ quiescent: true, sourceRef: 'fake:drain', results: {} }) };
const sourced = { observedAt: now, validUntil, sourceRef: 'fixture:observation' };
const isolated = { observedAt: at, sourceRef: 'fixture:recovery', result: 'passed', environment: 'isolated' };

async function fixture(t, { count = 20, mixed = true } = {}) {
  const rootDir = mkdtempSync(join(tmpdir(), 'queue-canary-'));
  const store = openFinalizationQueueStore({ rootDir });
  t.after(() => { store.close(); rmSync(rootDir, { recursive: true, force: true }); });
  const shadow = openFinalizationShadowStore({ db: store.db });
  for (const observedAt of ['2026-10-17T00:00:00.000Z', now]) shadow.append({
    subjectKey: { domainId: 'code-pr', subjectExternalId: 'example/review#101' }, revisionRef: 'a'.repeat(40), observedAt,
    classification: { relation: 'agree', direction: 'benign', disposition: 'resolved' },
    v1Action: { kind: 'merge' }, v2Decision: { kind: 'finalize-now' }, sawHeadMove: true, sawExhaustion: true,
  });
  const build = queueRuntimeBuild();
  const routing = createLaneRoutingController({ store, now: () => at, runtime: { build, pid: 42 } });
  await routing.transfer({ cfg, lane, expectedGeneration: 0, drainAdapter });
  await routing.run({ cfg, lane, kind: 'daemon', queue: async () => ({ acknowledged: true }) });
  const owner = createQueueOwner({ store, now: () => at });
  const { fence } = await owner.claim({ lane, ownerId: 'fixture:owner', routeGeneration: 1, expiresAt: '2026-10-25T00:30:00.000Z' });
  for (let i = 0; i < count; i++) {
    const clean = !mixed || i % 2 === 0;
    const { h, e } = (clean ? queueCleanFixture : queueHandoffFixture)(101 + i);
    const service = (clean ? createCleanReviewService : createQueueHandoffService)({ store,
      evidenceAdapter: { read: async () => e }, now: () => at });
    await service.submit(h);
    const entry = store.entries(lane).at(-1);
    await createQueueAdmissionService({ store, liveAdapter: { read: async () => queueLiveFixture(h) }, now: () => at })
      .reconcile({ fence, entryId: entry.entryId });
    assert.equal(store.readEntry(entry.entryId).phase, 'ready');
    store.progress({ fence, entryId: entry.entryId, phase: 'returned-to-closer', at,
      patch: { reason: 'fixture:conflict' } });
  }
  const evidence = { schemaVersion: 1, lane, window: { from: '2026-10-25T00:00:00.000Z', to: now },
    deployment: { ...sourced, build, pid: 42, ownerId: fence.ownerId, ownerGeneration: fence.generation,
      routeGeneration: fence.routeGeneration, configGeneration: resolveLaneRoute(cfg, lane).configGeneration,
      inventory: { ...sourced, legacyWriters: 0 }, identity: { ...sourced, result: 'verified' },
      producers: CANARY_PRODUCERS.map(kind => ({ ...sourced, kind, adapter: `fake:${kind}` })) },
    entries: store.entries(lane).map(e => ({ entryId: e.entryId, source: 'organic', sourceRef: 'fixture:organic-observation' })),
    recoveries: CANARY_RECOVERIES.map(id => ({ ...isolated, build, id })),
    rollback: { ...isolated, build, noOverlap: true, lostHandoffs: 0, duplicateHandoffs: 0, pendingReturns: 0,
      steps: CANARY_ROLLBACK_STEPS.map(id => ({ ...isolated, build, id })) } };
  const read = () => resolveQueueCanaryAdapter({ db: store.db }).read({ evidence, cfg, build, now });
  const path = join(rootDir, 'data/finalization-queue-canary.json');
  const save = () => writeFileSync(path, JSON.stringify(evidence));
  return { rootDir, store, routing, owner, fence, evidence, read, path, save };
}

test('read-only deployed probe joins receipts, organic observations, metrics and explicit isolated results', async t => {
  const f = await fixture(t); f.save();
  const before = readFileSync(join(f.rootDir, 'data/reviews.db'));
  const files = readdirSync(join(f.rootDir, 'data'), { recursive: true });
  const result = probeQueueOwner({ rootDir: f.rootDir, now, readConfig: () => cfg });
  assert.equal(result.capabilities.canary.available, true); assert.ok(result.runtime.build);
  const c = result.rollout.canary;
  assert.equal(c.status, 'complete'); assert.equal(c.entries, 20);
  assert.equal(c.clean, 10); assert.equal(c.remediated, 10);
  assert.equal(c.sample.length, 20); assert.equal(c.sample[0].kind, 'clean');
  assert.equal(c.recoveryComplete, true); assert.equal(c.rollbackRehearsed, true);
  assert.deepEqual(c.outcomes, { 'returned-to-closer': 20 });
  assert.equal(c.metrics.lanes[0].arrivals, 20); assert.equal(c.metrics.lanes[0].merges, 0);
  assert.equal(c.metrics.lanes[0].serviceTimeSamples, 0); assert.equal(c.metrics.lanes[0].serviceTimeMeanMs, null);
  assert.deepEqual(readFileSync(join(f.rootDir, 'data/reviews.db')), before);
  assert.deepEqual(readdirSync(join(f.rootDir, 'data'), { recursive: true }), files);
  assert.equal(readFileSync(f.path, 'utf8'), JSON.stringify(f.evidence));
  let output = '';
  assert.equal(queueProbeMain(['--capability', 'canary', '--json'], { probe: () => result,
    stdout: { write: s => { output += s; } } }), 0);
  assert.equal(JSON.parse(output).rollout.canary.entries, 20);
});

test('19 entries, absent admission type, unknown/failed/duplicate recovery never project complete', async t => {
  const f = await fixture(t, { count: 19, mixed: false });
  f.evidence.recoveries[0].result = 'unknown';
  let c = f.read();
  assert.equal(c.entries, 19); assert.equal(c.status, 'pending');
  for (const reason of ['fewer-than-20-organic-entries', 'missing-admission-type', 'recovery-incomplete']) assert.ok(c.pending.includes(reason));
  assert.equal(c.recoveries[0].result, 'unknown');
  f.evidence.recoveries[0].result = 'failed'; assert.equal(f.read().recoveries[0].result, 'failed');
  f.evidence.recoveries[0].result = 'passed';
  f.evidence.recoveries[0].build = 'older-fixture-build'; assert.equal(f.read().recoveryComplete, false);
  f.evidence.recoveries.push(f.evidence.recoveries[0]); assert.equal(f.read().recoveryComplete, false);
  f.evidence.rollback.steps.reverse(); assert.equal(f.read().rollbackRehearsed, false);
});

test('counts exclude duplicate IDs, synthetic, foreign, missing and out-of-window entry observations', async t => {
  const f = await fixture(t);
  f.evidence.entries.push(f.evidence.entries[0], { entryId: 'foreign', source: 'organic', sourceRef: 'fixture' });
  f.evidence.entries[1].source = 'synthetic';
  const c = f.read(); assert.equal(c.entries, 19); assert.equal(c.rejected.length, 2);
  f.evidence.window.from = '2026-10-25T00:02:00.000Z'; assert.equal(f.read().entries, 0);
  f.evidence.window.to = '2026-10-26T00:00:00Z'; assert.throws(f.read, /window/);
});

test('before activation report build/config mismatch, stale observations, live writers and missing producers', async t => {
  const f = await fixture(t);
  f.evidence.deployment.build = 'old-build'; f.evidence.deployment.configGeneration = 'old-config';
  f.evidence.deployment.validUntil = now; f.evidence.deployment.inventory.legacyWriters = 1;
  f.evidence.deployment.producers.pop(); f.evidence.deployment.identity.result = 'unknown';
  f.evidence.deployment.routeGeneration--;
  const c = f.read(); assert.equal(c.preflight.ready, false);
  for (const issue of ['running-build-mismatch', 'running-config-mismatch', 'running-observation-stale-or-missing',
    'legacy-writers-live-or-unknown', 'producer-unavailable', 'identity-unverified', 'running-owner-unverified']) assert.ok(c.preflight.issues.includes(issue), issue);
  assert.deepEqual(c.preflight.missingProducers, ['drain-reconciliation']);
});

test('registered writer, stale entry deadline and unresolved intent remain operator-visible', async t => {
  const f = await fixture(t, { count: 0 });
  f.store.acknowledge({ lane, entryId: 'q-expired', prNumber: 900, head: 'a'.repeat(40), admissionGeneration: 1,
    handoffId: 'h-expired', ackId: 'a-expired', at: '2026-10-24T00:00:00Z' });
  f.store.db.prepare('INSERT INTO finalization_queue_legacy_writer VALUES (?,?,?,?,?,?,NULL)')
    .run('writer-old', lane.repository, lane.base, 0, 'closer', '{}');
  assert.ok(f.read().preflight.issues.includes('legacy-writers-live-or-unknown'));
  assert.deepEqual(f.read().preflight.staleDeadlines, ['q-expired']);
  f.store.progress({ fence: f.fence, entryId: 'q-expired', phase: 'parked-infrastructure', at });
  f.store.acknowledge({ lane, entryId: 'q-push', prNumber: 902, head: 'a'.repeat(40), admissionGeneration: 1,
    handoffId: 'h-push', ackId: 'a-push', at });
  for (const phase of ['ready', 'rebasing', 'publishing']) f.store.progress({ fence: f.fence, entryId: 'q-push', phase, at,
    patch: phase === 'publishing' ? { candidate: 'b'.repeat(40), exactBase: 'c'.repeat(40), proof: { sourceRef: 'fake:proof' } } : {} });
  await assert.rejects(f.owner.issue({ fence: f.fence, entryId: 'q-push', operationId: 'fake:lost-push', kind: 'push',
    invoke: async () => { throw new Error('fake:lost-reply'); } }));
  assert.ok(f.read().preflight.issues.includes('unresolved-operations'));
  assert.equal(f.read().preflight.unresolvedOperations, 1);
});

test('empty or unreadable observation file is pending; incompatible schema unavailable; diagnostics are redacted', async t => {
  const f = await fixture(t, { count: 0 });
  const probe = () => probeQueueOwner({ rootDir: f.rootDir, now, readConfig: () => cfg });
  assert.equal(probe().capabilities.canary.available, true);
  assert.equal(probe().rollout.canary.status, 'pending');
  for (const bytes of ['secret-like invalid input', '{"schemaVersion":2}']) {
    writeFileSync(f.path, bytes); const r = probe();
    assert.equal(r.rollout.canary.entries, 0); assert.equal(r.rollout.canary.recoveryComplete, false);
    assert.doesNotMatch(JSON.stringify(r), /secret-like/);
    assert.deepEqual(r.rollout.canary.pending, ['operator-evidence-unreadable-or-invalid']);
  }
  f.store.db.exec('DROP INDEX idx_finalization_queue_legacy_writer_lane');
  assert.equal(probe().capabilities.canary.available, false);
});

test('existing shadow readiness and every sourced rollback invariant remain necessary observations', async t => {
  const f = await fixture(t);
  f.store.db.exec('DELETE FROM finalization_shadow');
  assert.ok(f.read().preflight.issues.includes('shadow-readiness-pending'));
  for (const field of ['lostHandoffs', 'duplicateHandoffs', 'pendingReturns']) {
    f.evidence.rollback[field] = 1; assert.equal(f.read().rollbackRehearsed, false); f.evidence.rollback[field] = 0;
  }
  f.evidence.rollback.noOverlap = false; assert.equal(f.read().rollbackRehearsed, false);
});

test('rehearsal uses real fence/drain/reconcile/return/reverse-selector/bounce/reactivation with no lost handoff', async t => {
  const f = await fixture(t, { count: 0 });
  const { h, e } = queueCleanFixture(901);
  await createCleanReviewService({ store: f.store, evidenceAdapter: { read: async () => e }, now: () => at }).submit(h);
  const entry = f.store.entries(lane)[0];
  let legacyWrites = 0, returns = 0, loseAck = true;
  const receipts = new Map();
  const returnAdapter = { read: async r => {
    if (!receipts.has(r.deliveryKey)) { returns++; receipts.set(r.deliveryKey, { acknowledged: true, deliveryKey: r.deliveryKey, sourceRef: 'fake:durable-return' }); }
    if (loseAck) { loseAck = false; throw new Error('fake:ack-lost'); }
    return receipts.get(r.deliveryKey);
  } };
  const transfer = (config, adapters = {}) => f.routing.transfer({ cfg: config, lane,
    expectedGeneration: f.store.readOwner(lane).route_generation, ...adapters });
  assert.equal((await transfer({})).reason, 'route-drain-unproven');
  assert.equal((await f.routing.run({ cfg, lane, kind: 'daemon', queue: () => assert.fail('fenced queue') })).reason, 'lane-transfer-required');
  assert.equal((await f.routing.run({ cfg: {}, lane, kind: 'closer', legacy: () => { legacyWrites++; } })).reason, 'lane-transfer-required');
  assert.equal((await transfer({}, { drainAdapter, returnAdapter })).reason, 'legacy-return-unacknowledged');
  const restarted = openFinalizationQueueStore({ rootDir: f.rootDir });
  try {
    const controller = createLaneRoutingController({ store: restarted, now: () => at });
    assert.equal((await controller.transfer({ cfg: {}, lane, expectedGeneration: restarted.readOwner(lane).route_generation,
      drainAdapter, returnAdapter })).ok, true);
    // A fake service bounce reloads the reverse selector from the supplied config.
    assert.equal((await controller.run({ cfg, lane, kind: 'daemon', queue: () => assert.fail('old cached route') })).reason, 'lane-transfer-required');
    await controller.run({ cfg: {}, lane, kind: 'closer', legacy: async () => { legacyWrites++; } });
    assert.equal((await controller.transfer({ cfg, lane, expectedGeneration: restarted.readOwner(lane).route_generation, drainAdapter })).ok, true);
    assert.equal((await controller.run({ cfg: {}, lane, kind: 'closer', legacy: () => assert.fail('stale legacy') })).reason, 'lane-transfer-required');
    await controller.run({ cfg, lane, kind: 'daemon', queue: async () => 'reactivated' });
  } finally { restarted.close(); }
  await assert.rejects(f.owner.issue({ fence: f.fence, entryId: entry.entryId, operationId: 'old-owner', kind: 'merge', invoke: () => assert.fail('old owner mutation') }), /fence/);
  assert.equal(legacyWrites, 1); assert.equal(returns, 1); assert.equal(receipts.size, 1);
  assert.equal(f.routing.read(lane).pendingReturns.length, 0);
  assert.equal(f.store.readEntry(entry.entryId).phase, 'returned-to-closer');
  assert.equal(f.store.entries(lane).length, 1);
});
