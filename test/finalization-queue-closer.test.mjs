import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openFinalizationQueueStore } from '../src/finalization/queue-store.mjs';
import { createLaneRoutingController } from '../src/finalization/queue-routing.mjs';
import { createQueueHandoffService } from '../src/finalization/queue-handoff-store.mjs';
import { createCleanReviewService } from '../src/finalization/queue-clean-review.mjs';
import { prepareQueueCloserDispatch, createQueueCloserComposition, renderQueueCloserPrompt } from '../src/finalization/queue-closer.mjs';
import { maybeDispatchAmaCloser } from '../src/ama/dispatch-closer.mjs';
import { runDaemonCleanMergeAttempt } from '../src/daemon-clean-merge.mjs';
import { queueHandoffFixture, handoffTime } from './helpers/queue-handoff-fixture.mjs';
import { queueCleanFixture } from './helpers/queue-clean-fixture.mjs';

const lane = { repository: 'example/review', base: 'main' };
const cfg = { enabled: true, laneRoutes: [{ ...lane, executor: 'queue-v2' }] };
const drainAdapter = { read: async () => ({ quiescent: true, sourceRef: 'fake:drain', results: {} }) };
async function fixture(t) {
  const rootDir = mkdtempSync(join(tmpdir(), 'queue-closer-'));
  const store = openFinalizationQueueStore({ rootDir });
  t.after(() => { store.close(); rmSync(rootDir, { recursive: true, force: true }); });
  const routing = createLaneRoutingController({ store, now: () => handoffTime(0) });
  await routing.transfer({ cfg, lane, expectedGeneration: 0, drainAdapter });
  const { h, e } = queueHandoffFixture();
  const service = createQueueHandoffService({ store, now: () => handoffTime(0), evidenceAdapter: { read: async () => e } });
  let released = 0;
  const composition = createQueueCloserComposition({ rootDir, readConfig: () => cfg, handoffService: service, handoffInstructions: 'Use the installed handoff tool for this run.',
    releaseResources: ack => { assert.deepEqual(service.readAcknowledgement(h), ack); released++; } });
  const prepare = (extra = {}) => prepareQueueCloserDispatch({ rootDir, cfg, lane, prNumber: h.prNumber, head: h.head, composition, ...extra });
  return { rootDir, store, routing, h, e, service, composition, prepare, released: () => released };
}

test('queue closer renders only remediation/publication/handoff/exit, legacy remains selected on other lanes', async t => {
  const f = await fixture(t), prepared = await f.prepare();
  assert.equal(prepared.executor, 'queue-v2');
  const prompt = renderQueueCloserPrompt({ PR_URL: 'https://example.invalid/pr/101', REPO: lane.repository, PR_NUMBER: 101,
    REVIEWED_SHA: f.h.sourceReview.commitId, TARGET_REMEDIATION_SHA: f.h.head, RISK_CLASS: 'critical', RUN_DIR: '/fixture/run', ROOT_DIR: '/fixture' }, prepared);
  assert.match(prompt, /Exit successfully/); assert.match(prompt, /matching committed ack/);
  assert.match(prompt, /non-blocking findings/); assert.match(prompt, /source locations/);
  assert.doesNotMatch(prompt, /<<|ham_merge_phase\(|source .*hammer-/);
  assert.equal((await f.prepare({ lane: { ...lane, base: 'other' } })).executor, 'legacy');
  assert.equal((await f.prepare({ cfg: {} })).reason, 'lane-transfer-required');
  assert.equal((await f.prepare({ composition: null })).reason, 'queue-closer-composition-unavailable');
});

test('actual closer dispatcher suppresses twenty duplicate wakes after durable ack without legacy recovery or launch', async t => {
  const f = await fixture(t);
  await f.composition.handoff(f.h, { routeGeneration: 1 });
  assert.equal(f.released(), 1);
  let launches = 0;
  for (let i = 0; i < 20; i++) {
    const result = await maybeDispatchAmaCloser({ cfg, prMetadata: { prNumber: f.h.prNumber, headSha: f.h.head, baseBranch: lane.base, isOpen: true },
      dispatchContext: { rootDir: f.rootDir, repo: lane.repository },
      execFileImpl: async () => { launches++; assert.fail('duplicate closer'); },
      acquireMergeLeaseImpl: () => assert.fail('queue closer merge lease'),
      attemptDaemonCleanMergeImpl: () => assert.fail('queue closer merge'),
    });
    assert.equal(result.reason, 'queue-handoff-acknowledged'); assert.equal(result.skipMergeAgent, true);
  }
  assert.equal(launches, 0);
  f.store.db.prepare("UPDATE finalization_queue_entry SET phase='returned-to-closer',payload_json=json_set(payload_json,'$.phase','returned-to-closer') WHERE entry_id=?")
    .run(f.service.readAcknowledgement(f.h).entryId);
  assert.equal((await f.prepare()).executor, 'queue-v2', 'same-head returned work owes remediation');
});

test('failed publication, ack or resource release cannot report successful migrated closer completion', async t => {
  const f = await fixture(t); f.e.publication.ok = false;
  await assert.rejects(f.composition.handoff(f.h, { routeGeneration: 1 }), /publication/); assert.equal(f.released(), 0);
  assert.throws(() => createQueueCloserComposition({ rootDir: f.rootDir, readConfig: () => cfg, handoffService: f.service, handoffInstructions: 'tool' }), /release/);
  f.e.publication.ok = true;
  let failRelease = true;
  const c = createQueueCloserComposition({ rootDir: f.rootDir, readConfig: () => cfg, handoffService: f.service, handoffInstructions: 'tool',
    releaseResources: () => { if (failRelease) throw new Error('release failed'); } });
  await assert.rejects(c.handoff(f.h, { routeGeneration: 1 }), /release failed/);
  failRelease = false;
  assert.equal((await c.handoff(f.h, { routeGeneration: 1 })).outcome, 'queue-handoff-acknowledged');
  const count = f.store.db.prepare('SELECT COUNT(*) AS n FROM finalization_queue_handoff').get().n;
  assert.equal(count, 1);
});

test('clean daemon enqueues and confirms stored receipt, without merge lease/check waits or merge click', async t => {
  const f = await fixture(t), { h, e } = queueCleanFixture();
  const service = createCleanReviewService({ store: f.store, now: () => handoffTime(0), evidenceAdapter: { read: async () => e } });
  const args = { rootDir: f.rootDir, cfg, repoPath: lane.repository, prNumber: h.prNumber,
    candidate: { baseBranch: lane.base, headSha: h.head }, currentPrHeadSha: h.head,
    queueAdmission: () => service.submit(h),
    acquireMergeLeaseImpl: () => assert.fail('lease'), execFileImpl: () => assert.fail('merge/CI') };
  for (let i = 0; i < 20; i++) {
    const result = await runDaemonCleanMergeAttempt(args);
    assert.equal(result.queued, true); assert.equal(result.taken, true); assert.equal(result.skipMergeAgent, true);
  }
  assert.equal(f.store.entries(lane).length, 1);
  await assert.rejects(runDaemonCleanMergeAttempt({ ...args, queueAdmission: async () => ({ entryId: 'fake', ackId: 'fake' }) }), /foreign/);
  assert.equal((await runDaemonCleanMergeAttempt({ ...args, queueAdmission: undefined })).reason, 'queue-composition-unavailable');
});

test('in-flight legacy writer prevents cutover and rollback ack loss leaves both routes fenced', async t => {
  const f = await fixture(t);
  await f.routing.transfer({ cfg: {}, lane, expectedGeneration: 1, drainAdapter });
  let entered, release;
  const started = new Promise(r => { entered = r; }), done = new Promise(r => { release = r; });
  const old = f.routing.run({ cfg: {}, lane, kind: 'closer', legacy: async () => { entered(); await done; return 'done'; } });
  await started;
  assert.equal((await f.routing.transfer({ cfg, lane, expectedGeneration: 2, drainAdapter })).reason, 'owner-operation-in-flight');
  release(); await old;
  assert.equal((await f.routing.transfer({ cfg, lane, expectedGeneration: 2, drainAdapter })).ok, true);
  await assert.rejects(f.composition.handoff(f.h, { routeGeneration: 1 }), /generation/);
  await f.composition.handoff(f.h, { routeGeneration: 3 });
  const returnAdapter = { read: async () => null };
  assert.equal((await f.routing.transfer({ cfg: {}, lane, expectedGeneration: 3, drainAdapter, returnAdapter })).reason, 'legacy-return-unacknowledged');
  assert.equal((await f.prepare()).reason, 'lane-transfer-required');
  assert.equal((await f.prepare({ cfg: {} })).reason, 'lane-transfer-required');
  await assert.rejects(f.composition.handoff(f.h, { routeGeneration: 3 }), /transfer/);
});
