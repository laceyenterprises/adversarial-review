import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gitFixture, admitted, idle } from './helpers/queue-rebase-fixture.mjs';
import { handoffTime } from './helpers/queue-handoff-fixture.mjs';
import { createQueueRebaseService } from '../src/finalization/queue-rebase.mjs';
import { createQueueChecksService } from '../src/finalization/queue-checks.mjs';
import { createQueueMergeService } from '../src/finalization/queue-merge.mjs';
import { resolveQueueRequiredSet } from '../src/finalization/queue-check-reader.mjs';
import { createLaneRoutingController, resolveLaneRoute } from '../src/finalization/queue-routing.mjs';
import { openFinalizationShadowStore } from '../src/finalization/shadow-store.mjs';
import { CANARY_PRODUCERS, CANARY_ROLLBACK_STEPS } from '../src/finalization/queue-canary.mjs';
import { resolveQueueCutoverAdapter } from '../src/finalization/queue-cutover.mjs';
import { probeQueueOwner, queueProbeMain, queueRuntimeBuild } from '../src/finalization/queue-probe.mjs';

async function fixture(t) {
  const f = gitFixture(t), a = await admitted(f, { remediated: true });
  const lane = a.h.lane, build = queueRuntimeBuild();
  const cfg = { laneRoutes: [{ ...lane, executor: 'queue-v2' }] };
  let merged = false;
  const liveAdapter = { read: async () => {
    const value = structuredClone(a.live);
    value.subject.head = f.g(['--git-dir', f.remote, 'rev-parse', 'topic']);
    value.eligibility.primaryChange.headSha = value.subject.head;
    if (merged) Object.assign(value.subject, { state: 'merged', mergedAt: handoffTime(4), mergeCommitSha: 'd'.repeat(40), mergedBy: 'queue-app[bot]' });
    return value;
  } };
  const base = { store: f.store, owner: a.owner, liveAdapter, gitAdapter: f.adapter, now: f.now, load: idle };
  f.clock(2);
  await createQueueRebaseService(base).run({ fence: a.fence, entryId: a.ack.entryId });
  const requiredSet = resolveQueueRequiredSet({ cfg: { requiredCheckContexts: ['unit'] }, rules: { complete: true, contexts: [], sourceRef: 'fixture:rules', version: '1' } });
  const checkReader = { read: async ({ entry }) => ({ head: entry.candidate, base: entry.exactBase, requiredSet, complete: true,
    observedAt: f.now(), results: [{ name: 'unit', head: entry.candidate, conclusion: 'SUCCESS', url: 'https://example.invalid/check/1' }] }) };
  f.clock(3);
  await createQueueChecksService({ ...base, checkReader }).poll({ fence: a.fence, entryId: a.ack.entryId });
  f.clock(4);
  const deliver = { read: async ({ key }) => ({ id: key, sourceRef: 'fixture:delivery' }) };
  const result = await createQueueMergeService({ ...base, checkReader,
    identitySurface: { check: async () => ({ ok: true, login: 'queue-app[bot]', producerClass: 'closer-hammer', sourceRef: 'fixture:identity' }) },
    mergeSurface: { name: 'fake:merge', merge: async () => { merged = true; return { ok: true, payload: { merged: true, sha: 'd'.repeat(40) } }; } },
    deliveryAdapters: { 'merge-action-receipt': deliver, 'closure-audit': deliver },
  }).finalize({ fence: a.fence, entryId: a.ack.entryId });
  assert.equal(result.phase, 'merged');
  const routing = createLaneRoutingController({ store: f.store, now: f.now, runtime: { build, pid: 42 } });
  await routing.run({ cfg, lane, kind: 'daemon', queue: async () => ({ queued: true }) });
  const shadow = openFinalizationShadowStore({ db: f.store.db });
  const now = handoffTime(30), fresh = { observedAt: now, validUntil: handoffTime(150), sourceRef: 'fixture:process-observation' };
  for (const observedAt of ['2026-10-15T00:00:00Z', now]) shadow.append({
    subjectKey: { domainId: 'code-pr', subjectExternalId: `${lane.repository}#102` }, revisionRef: f.oldHead, observedAt,
    classification: { relation: 'agree', direction: 'benign', disposition: 'resolved' },
    v1Action: { kind: 'merge' }, v2Decision: { kind: 'finalize-now' }, sawHeadMove: true, sawExhaustion: true,
  });
  const owner = f.store.readOwner(lane), configGeneration = resolveLaneRoute(cfg, lane).configGeneration;
  const isolated = { environment: 'isolated', build, result: 'passed', observedAt: handoffTime(20), sourceRef: 'fixture:rollback' };
  const evidence = { schemaVersion: 1, lane, window: { from: handoffTime(-1), to: now },
    canaryApproval: { result: 'approved', principal: 'example-operator', observedAt: handoffTime(-2), sourceRef: 'fixture:canary-approval' },
    deployment: { ...fresh, inventory: { ...fresh, legacyWriters: 0 }, identity: { ...fresh, result: 'verified' },
      writers: ['watcher', 'follow-up', 'queue-consumer'].map((service, i) => ({ ...fresh, build, configGeneration, service, pid: 42 + i })),
      producers: CANARY_PRODUCERS.map(kind => ({ ...fresh, kind, adapter: `fixture:${kind}` })),
      queueOwner: { ...fresh, build, configGeneration, service: 'queue-consumer', pid: 44,
        ownerId: owner.owner_id, generation: owner.generation, routeGeneration: owner.route_generation } },
    entries: [{ entryId: a.ack.entryId, source: 'organic', sourceRef: 'fixture:organic-observation' }],
    closerReleases: [{ entryId: a.ack.entryId, ackId: a.ack.ackId, launchRequestId: a.h.closer.launchRequestId,
      build, releasedAt: handoffTime(1), observedAt: handoffTime(1), workerReleased: true, closerLeaseReleased: true, sourceRef: 'fixture:resource-release' }],
    rollback: { ...isolated, noOverlap: true, lostHandoffs: 0, duplicateHandoffs: 0, pendingReturns: 0,
      steps: CANARY_ROLLBACK_STEPS.map(id => ({ ...isolated, id })) } };
  const read = () => resolveQueueCutoverAdapter({ db: f.store.db }).read({ evidence, cfg, build, now });
  return { f, a, cfg, build, now, evidence, read };
}

test('cutover probe reads real merge-service receipts, effective route, loaded owners and release before CI without mutation', async t => {
  const p = await fixture(t);
  assert.equal(p.read().status, 'complete', JSON.stringify(p.read().pending));
  const path = join(p.f.root, 'data/finalization-queue-cutover.json');
  writeFileSync(path, JSON.stringify(p.evidence));
  const dbPath = join(p.f.root, 'data/reviews.db'), before = readFileSync(dbPath), files = readdirSync(join(p.f.root, 'data'), { recursive: true });
  const result = probeQueueOwner({ rootDir: p.f.root, capability: 'cutover', now: p.now, readConfig: () => p.cfg });
  assert.equal(result.capabilities.cutover.available, true); assert.equal(result.runtime.build, p.build);
  const e = result.rollout.expansion;
  assert.equal(e.route, 'queue-v2'); assert.equal(e.legacyWriters, 0); assert.equal(e.confirmedReceipts, 1);
  assert.equal(e.closersReleasedBeforeCi, true); assert.equal(e.metrics.lanes[0].merges, 1);
  assert.deepEqual(readFileSync(dbPath), before); assert.deepEqual(readdirSync(join(p.f.root, 'data'), { recursive: true }), files);
  let output = '';
  assert.equal(queueProbeMain(['--capability', 'cutover', '--json'], { probe: () => result, stdout: { write: s => { output += s; } } }), 0);
  assert.equal(JSON.parse(output).rollout.expansion.confirmedReceipts, 1);
});

test('missing, duplicate, foreign, future and late closer releases remain pending; every sampled closer must be released', async t => {
  const p = await fixture(t), original = structuredClone(p.evidence.closerReleases);
  const variants = [[], [original[0], original[0]], [{ ...original[0], ackId: 'foreign' }],
    [{ ...original[0], launchRequestId: 'foreign' }], [{ ...original[0], build: 'stale' }],
    [{ ...original[0], releasedAt: handoffTime(2) }], [{ ...original[0], releasedAt: handoffTime(-1) }],
    [{ ...original[0], observedAt: handoffTime(31) }], [{ ...original[0], closerLeaseReleased: false }]];
  for (const value of variants) {
    p.evidence.closerReleases = value;
    assert.equal(p.read().closersReleasedBeforeCi, false); assert.equal(p.read().status, 'pending');
  }
  p.evidence.closerReleases = original;
  assert.equal(p.read().closersReleasedBeforeCi, true);
});

test('unknown census, stale writer, wrong running owner, unapproved canary and unrehearsed rollback stay pending', async t => {
  const p = await fixture(t), original = structuredClone(p.evidence);
  const mutate = [e => { e.deployment.inventory.legacyWriters = null; }, e => { e.deployment.writers[1].build = 'old'; },
    e => { e.deployment.queueOwner.generation++; }, e => { e.canaryApproval.result = 'pending'; },
    e => { e.rollback.noOverlap = false; }, e => { e.entries[0].source = 'synthetic'; }];
  for (const change of mutate) {
    Object.assign(p.evidence, structuredClone(original)); change(p.evidence);
    assert.equal(p.read().status, 'pending');
  }
  Object.assign(p.evidence, original); p.evidence.deployment.inventory.legacyWriters = 1;
  assert.equal(p.read().legacyWriters, null); assert.equal(p.read().route, null);
});

test('corrupt digest or foreign candidate cannot count as confirmed merge receipt', async t => {
  const p = await fixture(t);
  p.f.store.db.prepare("UPDATE finalization_queue_merge_receipt SET candidate='foreign'").run();
  assert.equal(p.read().confirmedReceipts, 0);
  p.f.store.db.prepare('UPDATE finalization_queue_merge_receipt SET candidate=?').run(p.f.store.readEntry(p.a.ack.entryId).candidate);
  assert.equal(p.read().confirmedReceipts, 1);
  p.f.store.db.prepare("UPDATE finalization_queue_merge_receipt SET receipt_digest='corrupt'").run();
  assert.equal(p.read().confirmedReceipts, 0); assert.equal(p.read().rejectedReceipts.length, 1);
  assert.equal(p.read().status, 'pending');
});

test('missing organic observation artifact stays pending and other capability requests do not disclose expansion inputs', async t => {
  const p = await fixture(t);
  const options = { rootDir: p.f.root, now: p.now, readConfig: () => p.cfg };
  const result = probeQueueOwner({ ...options, capability: 'cutover' });
  assert.equal(result.capabilities.cutover.available, true);
  assert.equal(result.rollout.expansion.status, 'pending'); assert.equal(result.rollout.expansion.route, null);
  assert.equal(result.rollout.expansion.legacyWriters, null); assert.equal(result.rollout.expansion.confirmedReceipts, 0);
  assert.equal(probeQueueOwner({ ...options, capability: 'routing' }).rollout, undefined);
});
