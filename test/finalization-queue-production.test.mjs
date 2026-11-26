import { installDispatchFileProducerFixture } from './helpers/dispatch-files-fixture.mjs';
installDispatchFileProducerFixture();
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HAM_AUDIT_COMMENT_AUTHOR_LOGINS } from '../src/ama/ham-provenance.mjs';
import { openFinalizationQueueStore } from '../src/finalization/queue-store.mjs';
import { validateCleanReview } from '../src/finalization/queue-clean-review.mjs';
import { validateQueueHandoff } from '../src/finalization/queue-handoff.mjs';
import { createGithubAdapterMergeSurface } from '../src/finalization/execution-surfaces.mjs';
import { createQueueConsumer } from '../src/finalization/queue-consumer.mjs';
import { createProductionQueue, reconcileProductionOperations } from '../src/finalization/queue-production.mjs';
import { createQueueProductionEvidence } from '../src/finalization/queue-production-admission.mjs';
import { prepareQueueCloserDispatch, readCompletedQueueHandoff } from '../src/finalization/queue-closer.mjs';
import { buildHammerQueueHandoffRequest, hammerReviewProof } from '../src/finalization/hammer-queue-handoff.mjs';
import { createQueueLiveReads, readQueueBranchPolicy } from '../src/finalization/queue-live.mjs';
import { classifyQueueChecks, resolveQueueRequiredSet } from '../src/finalization/queue-check-reader.mjs';
import { createQueueMergeActionDelivery } from '../src/finalization/queue-delivery.mjs';
import { createQueueGsr } from '../src/finalization/queue-gsr.mjs';
import { createQueueGitHub } from '../src/finalization/queue-github.mjs';
import { resolveQueueHandoffStore } from '../src/finalization/queue-handoff-store.mjs';
import { createLaneRoutingController } from '../src/finalization/queue-routing.mjs';
import { ensureReviewStateSchema } from '../src/review-state.mjs';
import { withRepositoryStateMigration } from '../src/repository-state-lock.mjs';
import { gitFixture, idle } from './helpers/queue-rebase-fixture.mjs';
import { queueCleanFixture, queueLiveFixture } from './helpers/queue-clean-fixture.mjs';
import { handoffTime, queueHandoffFixture, reviewHead } from './helpers/queue-handoff-fixture.mjs';

const lane = { repository: 'example/review', base: 'main' };
const cfg = { enabled: true, laneRoutes: [{ ...lane, executor: 'queue-v2' }] };
const refuse = () => assert.fail('unexpected adapter invocation');
const mergeSha = 'd'.repeat(40);
const bot = 'queue-app[bot]';
const requiredSet = resolveQueueRequiredSet({ cfg: { requiredCheckContexts: ['unit'] },
  rules: { complete: true, contexts: [], sourceRef: 'rules:fixture', version: '1' } });

function receiptFixture({ prNumber, head, request, admissionGeneration = 1 }) {
  const { h, e } = { ...JSON.parse(JSON.stringify(request ? queueHandoffFixture(prNumber) : queueCleanFixture(prNumber)).replaceAll('b'.repeat(40), head)) };
  if (!request) return { input: { ...h, prNumber, admissionGeneration,
    handoffId: admissionGeneration === 1 ? h.handoffId : `${h.handoffId}-${admissionGeneration}` },
  evidence: { ...e, subject: { ...e.subject, prNumber } } };
  h.handoffId = request.handoffId;
  h.reviewProof = request.reviewProof;
  e.reviewProof = { ok: true, head, digest: request.reviewProof.digest, sourceRef: 'github:audit' };
  return { input: h, evidence: e };
}

async function transfer(f) {
  const store = openFinalizationQueueStore({ rootDir: f.root });
  try {
    const route = createLaneRoutingController({ store, now: f.now });
    const result = await route.transfer({ cfg, lane, expectedGeneration: 0,
      drainAdapter: { read: () => ({ quiescent: true, sourceRef: 'fixture:drained', results: {} }) } });
    assert.equal(result.ok, true);
    assert.equal(store.readOwner(lane).route_generation, 1);
    return result.route.route_generation;
  } finally { store.close(); }
}

function fixtureRequest(head, routeGeneration, { prNumber = 102, auditBody, closer = queueHandoffFixture(prNumber).h.closer } = {}) {
  auditBody ??= `HAM-Validated-Head: ${head}`;
  return buildHammerQueueHandoffRequest({ lane, prNumber, head, closer, routeGeneration,
    deadline: handoffTime(60), reviewProof: hammerReviewProof({ lane, prNumber, head, reviewedSha: reviewHead, auditHead: head, auditBody }) });
}

test('legacy/default config schedules nothing and a queue selector alone grants no ownership', async t => {
  const q = createProductionQueue({ rootDir: '/fixture/never-opened', readConfig: () => ({}), openStore: refuse });
  await q.tick();
  const f = gitFixture(t, { noop: true });
  const consumer = createQueueConsumer({ rootDir: f.root, readConfig: () => cfg, now: f.now, compose: refuse });
  await consumer.tick();
  assert.equal(f.store.readOwner(lane), null);
  const admission = createProductionQueue({ rootDir: f.root, readConfig: () => cfg, now: f.now, observe: refuse });
  const result = await admission.admitHammer(fixtureRequest(f.oldHead, 0));
  assert.equal(result.reason, 'lane-transfer-required');
  assert.deepEqual(f.store.entries(lane), []);
  assert.equal(f.store.readOwner(lane).route_generation, 0);
});

test('the AMA master switch stops a transferred queue and refuses fresh admission', async t => {
  const f = gitFixture(t, { noop: true });
  const routeGeneration = await transfer(f);
  const production = createProductionQueue({ rootDir: f.root, readConfig: () => cfg, now: f.now, observe: receiptFixture });
  const route = { lane, routeGeneration };
  const entry = await production.admitClean({ route, prNumber: 102, head: f.oldHead });
  const owner = f.store.readOwner(lane);
  const readConfig = () => ({ ...cfg, enabled: false });
  await createQueueConsumer({ rootDir: f.root, readConfig, openStore: refuse, compose: refuse }).tick();
  assert.deepEqual(f.store.readEntry(entry.entryId), entry);
  assert.deepEqual(f.store.readOwner(lane), owner);
  const disabled = createProductionQueue({ rootDir: f.root, readConfig, now: f.now, observe: refuse });
  await assert.rejects(disabled.admitClean({ route, prNumber: 103, head: f.oldHead }), /queue-admission-paused/);
});

test('the production handoff receiver checks the route fence and replays a committed receipt', async t => {
  const f = gitFixture(t, { noop: true });
  const generation = await transfer(f);
  let observations = 0;
  const production = createProductionQueue({ rootDir: f.root, readConfig: () => cfg, now: f.now,
    observe: args => { observations++; return receiptFixture(args); } });
  assert.equal((await production.admitHammer(fixtureRequest(f.oldHead, generation - 1))).reason, 'route-generation-mismatch');
  assert.equal(observations, 0);
  const request = fixtureRequest(f.oldHead, generation);
  const ack = await production.admitHammer(request);
  assert.equal(ack.head, f.oldHead);
  assert.deepEqual(await production.admitHammer(request), ack);
  assert.deepEqual(resolveQueueHandoffStore(f.store).read(request).ack, ack);
  assert.equal(observations, 1);
  assert.equal(f.store.entries(lane).length, 1);
  const entry = f.store.readEntry(ack.entryId);
  assert.deepEqual(readCompletedQueueHandoff(f.store, { lane, prNumber: 102, head: f.oldHead },
    { includeClean: true }), { entry, ack });
  const dispatch = await prepareQueueCloserDispatch({ rootDir: f.root, cfg, lane, prNumber: 102, head: f.oldHead });
  assert.equal(dispatch.queued, true);
  assert.deepEqual(dispatch.acknowledgement, entry);
});

test('the installed handoff receiver accepts larger inventory files within its byte limit', t => {
  const root = mkdtempSync(join(tmpdir(), 'queue-handoff-request-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'handoff.json');
  const receive = () => JSON.parse(execFileSync(process.execPath, ['bin/finalization-queue-handoff.mjs', path], {
    encoding: 'utf8',
    env: { ...process.env, HQ_LAUNCH_REQUEST_ID: 'unmatched-fixture' },
  }));
  writeFileSync(path, JSON.stringify({ inventory: 'a'.repeat(32 * 1024) }));
  assert.equal(receive().reason, 'queue-hammer-launch-mismatch');
  writeFileSync(path, JSON.stringify({ inventory: 'a'.repeat(1024 * 1024) }));
  assert.equal(receive().reason, 'queue-handoff-request-unreadable');
});

test('the installed handoff receiver reports invalid argument counts', () => {
  const result = JSON.parse(execFileSync(process.execPath, ['bin/finalization-queue-handoff.mjs'], { encoding: 'utf8' }));
  assert.deepEqual(result, { ok: false, reason: 'queue-handoff-arguments-invalid' });
});

test('a drain committed during admission prevents the durable acknowledgement', async t => {
  const f = gitFixture(t, { noop: true });
  const generation = await transfer(f);
  const gsr = createQueueGsr({ store: f.store, now: f.now });
  const q = createProductionQueue({ rootDir: f.root, now: f.now, readConfig: () => cfg,
    observe: args => {
      gsr.drain('maintenance-window:fixture');
      return receiptFixture(args);
    } });
  await assert.rejects(q.admitClean({ route: { lane, routeGeneration: generation }, prNumber: 102, head: f.oldHead }), /queue-admission-paused/);
  assert.deepEqual(f.store.entries(lane), []);
});

test('installed closer command uses absolute argv and a durable clean receipt suppresses another closer', async t => {
  const f = gitFixture(t, { noop: true });
  const generation = await transfer(f);
  mkdirSync(join(f.root, 'bin'));
  writeFileSync(join(f.root, 'bin', 'finalization-queue-handoff.mjs'), '/* fixture command */');
  const target = { rootDir: f.root, cfg, lane, prNumber: 102, head: f.oldHead };
  const preflight = await prepareQueueCloserDispatch(target);
  assert.deepEqual(preflight.handoffCommand, [process.execPath, join(f.root, 'bin', 'finalization-queue-handoff.mjs')]);
  assert.equal(preflight.route.routeGeneration, generation);
  const production = createProductionQueue({ rootDir: f.root, readConfig: () => cfg, now: f.now, observe: receiptFixture });
  const result = await production.admitClean({ route: preflight.route, prNumber: 102, head: f.oldHead });
  assert.equal(result.phase, 'acknowledged');
  const entry = f.store.readEntry(result.entryId);
  assert.deepEqual(readCompletedQueueHandoff(f.store, target, { includeClean: true }), { entry, ack: null });
  assert.deepEqual((await prepareQueueCloserDispatch(target)).acknowledgement, entry);
});

function fakeWorld(f, setup, { moved = false, checksGreen = () => true } = {}) {
  let merged = false;
  const writes = [], returns = [], deliveries = [];
  const original = queueLiveFixture(setup.input);
  Object.assign(original.subject, { baseSha: f.base, headRepository: lane.repository, headRef: 'topic' });
  Object.assign(original.permission, { canForcePush: true, canWriteHeadRepository: true, maintainerCanModify: true,
    fork: false, rulesSourceRef: 'rules:fixture', headRepository: lane.repository, headRef: 'topic' });
  const compose = () => ({ gitAdapter: f.adapter, load: idle,
    liveAdapter: { read: () => {
      const copy = structuredClone(original);
      if (moved) copy.subject.head = 'f'.repeat(40);
      if (merged) Object.assign(copy.subject, { state: 'merged', mergeCommitSha: mergeSha, mergedAt: f.now(), mergedBy: bot });
      return copy;
    } },
    checkReader: { read: ({ entry }) => ({ head: entry.candidate, base: entry.exactBase, requiredSet, complete: true,
      results: [{ name: 'unit', head: entry.candidate, conclusion: checksGreen() ? 'SUCCESS' : 'PENDING' }] }) },
    identitySurface: { check: () => ({ ok: true, login: bot, producerClass: 'ama-daemon', sourceRef: 'fixture:app' }) },
    mergeSurface: { merge: args => { writes.push(args); merged = true; return { ok: true, payload: { sha: mergeSha } }; } },
    returnSubject: entry => { returns.push(entry); },
    deliveryAdapters: Object.fromEntries(['merge-action-receipt', 'closure-audit'].map(kind => [kind, { read: ({ key }) => {
      deliveries.push(key); return { id: key, sourceRef: 'fixture:delivery' };
    } }])),
  });
  return { compose, writes, returns, deliveries };
}

test('a stalled admission warns once and leaves the repository migration lock available', async t => {
  const f = gitFixture(t, { noop: true });
  const routeGeneration = await transfer(f);
  const fixture = receiptFixture({ prNumber: 102, head: f.oldHead });
  const production = createProductionQueue({ rootDir: f.root, readConfig: () => cfg, now: f.now, observe: () => fixture });
  await production.admitClean({ route: { lane, routeGeneration }, prNumber: 102, head: f.oldHead });
  const world = fakeWorld(f, fixture);
  const adapters = world.compose();
  const { read } = adapters.liveAdapter;
  let enter, release;
  const entered = new Promise(resolve => { enter = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  let firstRead = true;
  adapters.liveAdapter.read = async args => {
    if (firstRead) {
      firstRead = false;
      enter();
      await gate;
    }
    return read(args);
  };
  const warnings = [];
  const consumer = createQueueConsumer({ rootDir: f.root, readConfig: () => cfg, now: f.now,
    compose: () => adapters, logger: { warn: message => warnings.push(message) } });
  const running = consumer.tick();
  try {
    await entered;
    // An exclusive recovery cycle can run during remote admission I/O.
    assert.equal(withRepositoryStateMigration(f.root, () => 'available'), 'available');
    f.clock(179);
    await consumer.tick();
    assert.deepEqual(warnings, []);
    f.clock(180);
    await consumer.tick();
    await consumer.tick();
    assert.deepEqual(warnings, ['[finalization-queue] prior tick is still running beyond its stall threshold']);
    assert.equal(world.writes.length, 0);
  } finally {
    release();
    await running;
  }
  await consumer.tick();
  assert.equal(world.writes.length, 1);
});

test('lifting an expired hold permits fresh clean admission and a single merge', async t => {
  const f = gitFixture(t, { noop: true });
  const routeGeneration = await transfer(f);
  const fixture = receiptFixture({ prNumber: 102, head: f.oldHead });
  const production = createProductionQueue({ rootDir: f.root, readConfig: () => cfg, now: f.now, observe: receiptFixture });
  const input = { route: { lane, routeGeneration }, prNumber: 102, head: f.oldHead };
  const original = await production.admitClean(input);
  const world = fakeWorld(f, fixture);
  const adapters = world.compose();
  const { read } = adapters.liveAdapter;
  let held = true;
  adapters.liveAdapter.read = args => {
    const observation = read(args);
    if (held) observation.subject.labels = ['no-merge-hold'];
    return observation;
  };
  const pages = [];
  adapters.pageAdapter = { read: ({ payload }) => {
    pages.push(payload);
    return { id: payload.causeKey, sourceRef: 'fixture:page' };
  } };
  const consumer = createQueueConsumer({ rootDir: f.root, readConfig: () => cfg, now: f.now,
    compose: () => adapters, logger: { warn: message => assert.fail(message) } });
  await consumer.tick();
  assert.equal(f.store.readEntry(original.entryId).phase, 'parked-hold');
  f.clock(original.patience.effectiveMs / 1000);
  await consumer.tick();
  assert.equal(f.store.readEntry(original.entryId).phase, 'returned-to-closer');
  assert.equal(world.writes.length, 0);
  held = false;
  const fresh = await production.admitClean(input);
  assert.equal(fresh.admissionGeneration, 2);
  // Durable admission generation, rather than physical row order, determines preflight custody.
  f.store.db.prepare(`UPDATE finalization_queue_entry SET rowid =
    (SELECT MAX(rowid) + 1 FROM finalization_queue_entry) WHERE entry_id = ?`).run(original.entryId);
  assert.equal(readCompletedQueueHandoff(f.store, { lane, prNumber: 102, head: f.oldHead },
    { includeClean: true })?.entry.entryId, fresh.entryId);
  await consumer.tick();
  await consumer.tick();
  assert.equal(f.store.readEntry(fresh.entryId).phase, 'merged');
  assert.equal(world.writes.length, 1);
  assert.equal(pages.length, 1);
  assert.equal(pages[0].reason, 'admission-deadline-expired');
});

for (const remediated of [false, true]) {
  test(`watcher consumer finalizes one exact ${remediated ? 'remediated' : 'clean'} head through the queue and outbox`, async t => {
    const f = gitFixture(t, { noop: true });
    const generation = await transfer(f);
    const request = remediated ? fixtureRequest(f.oldHead, generation) : null;
    const fixture = receiptFixture({ prNumber: 102, head: f.oldHead, request });
    const production = createProductionQueue({ rootDir: f.root, readConfig: () => cfg, now: f.now, observe: () => fixture });
    const ack = remediated ? await production.admitHammer(request) : await production.admitClean({ route: { lane, routeGeneration: generation }, prNumber: 102, head: f.oldHead });
    const world = fakeWorld(f, fixture);
    const q = createQueueConsumer({ rootDir: f.root, readConfig: () => cfg, now: f.now, compose: world.compose,
      logger: { warn: message => assert.fail(message) } });
    const gsr = createQueueGsr({ store: f.store, now: f.now });
    gsr.drain('maintenance-window:fixture');
    await q.tick();
    assert.equal(f.store.readEntry(ack.entryId).phase, 'acknowledged');
    assert.equal(world.writes.length, 0);
    gsr.resume('maintenance-window:fixture');
    await Promise.all([q.tick(), q.tick()]);
    await q.tick();
    assert.equal(f.store.readEntry(ack.entryId).phase, 'merged');
    assert.equal(f.store.readOwner(lane).owner_state, 'idle');
    assert.equal(world.writes.length, 1);
    assert.equal(world.writes[0].revisionRef, f.oldHead);
    assert.equal(world.deliveries.length, 2);
  });
}

test('a moved head returns its receipt for a fresh review without calling the writer', async t => {
  const f = gitFixture(t, { noop: true });
  const generation = await transfer(f);
  const request = fixtureRequest(f.oldHead, generation);
  const fixture = receiptFixture({ prNumber: 102, head: f.oldHead, request });
  const production = createProductionQueue({ rootDir: f.root, readConfig: () => cfg, now: f.now, observe: () => fixture });
  const ack = await production.admitHammer(request);
  const world = fakeWorld(f, fixture, { moved: true });
  await createQueueConsumer({ rootDir: f.root, readConfig: () => cfg, now: f.now, compose: world.compose }).tick();
  assert.equal(f.store.readEntry(ack.entryId).phase, 'returned-to-closer');
  assert.equal(world.writes.length, 0);
  assert.deepEqual(world.returns.map(entry => [entry.entryId, entry.reason]), [[ack.entryId, 'external-head-change']]);
});

test('the watcher relinquishes an active fence after an ambiguous merge response', async t => {
  const f = gitFixture(t, { noop: true });
  const generation = await transfer(f);
  const fixture = receiptFixture({ prNumber: 102, head: f.oldHead });
  const production = createProductionQueue({ rootDir: f.root, readConfig: () => cfg, now: f.now, observe: () => fixture });
  await production.admitClean({ route: { lane, routeGeneration: generation }, prNumber: 102, head: f.oldHead });
  const world = fakeWorld(f, fixture);
  const adapters = world.compose();
  let attempts = 0;
  adapters.mergeSurface.merge = () => { attempts++; throw new Error('lost reply'); };
  const q = createQueueConsumer({ rootDir: f.root, readConfig: () => cfg, now: f.now, compose: () => adapters,
    logger: { warn: () => {} } });
  await q.tick();
  assert.equal(f.store.readOwner(lane).owner_state, 'parked');
  assert.equal(f.store.operations(lane).length, 1);
  await q.tick();
  assert.equal(attempts, 1);
  assert.equal(f.store.operations(lane).length, 1);
});

test('the same watcher reconciles an accepted merge after a lost reply and an unavailable readback', async t => {
  const f = gitFixture(t, { noop: true });
  const routeGeneration = await transfer(f);
  const fixture = receiptFixture({ prNumber: 102, head: f.oldHead });
  const production = createProductionQueue({ rootDir: f.root, readConfig: () => cfg, now: f.now, observe: () => fixture });
  const { entryId } = await production.admitClean({ route: { lane, routeGeneration }, prNumber: 102, head: f.oldHead });
  const world = fakeWorld(f, fixture);
  const adapters = world.compose();
  const { merge } = adapters.mergeSurface;
  const { read } = adapters.liveAdapter;
  let readbacks = 0;
  adapters.mergeSurface.merge = args => { merge(args); throw new Error('lost reply'); };
  adapters.liveAdapter.read = args => {
    if (args.kind === 'merge-reconcile' && ++readbacks <= 2) throw new Error('read unavailable');
    return read(args);
  };
  const consumer = createQueueConsumer({ rootDir: f.root, readConfig: () => cfg, now: f.now,
    logger: { warn: () => {} }, compose: ({ store, ownerId }) => ({
      ...adapters, recoveryAdapter: { stopDrainAndReconcile: args => reconcileProductionOperations({
        ...args, store, ownerId, liveAdapter: adapters.liveAdapter,
      }) },
    }),
  });
  await consumer.tick();
  assert.equal(f.store.readOwner(lane).owner_state, 'parked');
  assert.equal(f.store.operations(lane).length, 1);
  await consumer.tick();
  assert.equal(f.store.readEntry(entryId).phase, 'merged');
  assert.deepEqual(f.store.operations(lane), []);
  assert.equal(world.writes.length, 1);
  assert.equal(readbacks, 3);
});

for (const phase of ['parked-hold', 'parked-permission']) {
  test(`the watcher throttles ${phase} probes across restarts and settles expiry once`, async t => {
    const f = gitFixture(t, { noop: true });
    const generation = await transfer(f);
    const fixture = receiptFixture({ prNumber: 102, head: f.oldHead });
    const production = createProductionQueue({ rootDir: f.root, readConfig: () => cfg, now: f.now, observe: receiptFixture });
    const subject = { lane, prNumber: 102, head: f.oldHead };
    const input = { route: { lane, routeGeneration: generation }, ...subject };
    const { entryId } = await production.admitClean(input);
    let reads = 0;
    const start = () => createQueueConsumer({ rootDir: f.root, readConfig: () => cfg, now: f.now,
      logger: { warn: message => assert.fail(message) },
      compose: () => ({ liveAdapter: { read() {
        reads++;
        const live = queueLiveFixture(fixture.input);
        if (phase === 'parked-hold') live.subject.labels = ['no-merge-hold'];
        else live.permission.canPush = false;
        return live;
      } } }),
    });
    const consumer = start();
    await consumer.tick();
    const parked = f.store.readEntry(entryId);
    assert.equal(parked.phase, phase);
    assert.equal(reads, 1);
    const initialFence = f.store.readOwner(lane).generation;
    f.clock(59);
    await consumer.tick();
    assert.equal(f.store.readOwner(lane).generation, initialFence);
    assert.equal(reads, 1);
    f.clock(60);
    await start().tick();
    assert.equal(reads, 2);
    assert.equal(f.store.readEntry(entryId).updatedAt, f.now());
    f.clock(61);
    await start().tick();
    assert.equal(reads, 2);
    f.clock(parked.patience.effectiveMs / 1000 - 1);
    await start().tick();
    assert.equal(reads, 3);
    assert.equal(f.store.readEntry(entryId).phase, phase);
    f.clock(parked.patience.effectiveMs / 1000);
    await start().tick();
    const expired = f.store.readEntry(entryId);
    assert.equal(expired.phase, 'returned-to-closer');
    assert.equal(expired.reason, 'admission-deadline-expired');
    assert.deepEqual(expired.patience, parked.patience);
    const settledFence = f.store.readOwner(lane).generation;
    await start().tick();
    assert.equal(f.store.readOwner(lane).generation, settledFence);
    assert.equal(reads, 3);
    assert.equal(readCompletedQueueHandoff(f.store, subject, { includeClean: true }), null);
    const readmitted = await production.admitClean(input);
    assert.equal(readmitted.admissionGeneration, 2);
    assert.notEqual(readmitted.entryId, entryId);
  });
}

test('a required check supplied by a foreign App cannot satisfy branch rules', async () => {
  const policy = await readQueueBranchPolicy(async path => {
    if (path.includes('/rules/')) return [{ type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'unit', integration_id: 7 }] } }];
    if (path.endsWith('/protection')) return { required_status_checks: { contexts: ['unit'], checks: [{ context: 'unit', app_id: 7 }] } };
    return { name: lane.base, protected: true, commit: { sha: reviewHead } };
  }, lane);
  const requiredSet = resolveQueueRequiredSet({ cfg: {}, rules: policy });
  const snapshot = { head: reviewHead, complete: true, requiredSet,
    results: [{ name: 'unit', app: { id: 8 }, head: reviewHead, conclusion: 'SUCCESS' }] };
  assert.equal(classifyQueueChecks(snapshot).kind, 'wait');
  snapshot.results.push({ __typename: 'StatusContext', context: 'unit', head: reviewHead, state: 'SUCCESS' });
  assert.equal(classifyQueueChecks(snapshot).reason, 'queue-branch-policy-unsupported');
  snapshot.results[0].app.id = 7;
  assert.equal(classifyQueueChecks(snapshot).kind, 'green');
});

test('ruleset-only branches tolerate an absent classic protection endpoint', async () => {
  const missing = Object.assign(new Error('unavailable'), { stderr: 'gh: HTTP 404' });
  let protection;
  const read = async path => {
    if (path.includes('/rules/')) return [{ type: 'required_status_checks', parameters: {
      required_status_checks: [{ context: 'unit', integration_id: 7 }],
    } }];
    if (path.endsWith('/protection')) throw missing;
    return { name: lane.base, protected: true, protection, commit: { sha: reviewHead } };
  };
  assert.deepEqual((await readQueueBranchPolicy(read, lane)).checkApps, [{ context: 'unit', appId: 7 }]);
  protection = { enabled: true };
  await assert.rejects(readQueueBranchPolicy(read, lane), error => error === missing);
});

test('same-name checks satisfy distinct App pins with each App’s latest run', async () => {
  const policy = await readQueueBranchPolicy(async path => {
    if (path.includes('/rules/')) return [{ type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'unit', integration_id: 7 }] } }];
    if (path.endsWith('/protection')) return { required_status_checks: { contexts: ['unit'], checks: [{ context: 'unit', app_id: 8 }] } };
    return { name: lane.base, protected: true, commit: { sha: reviewHead } };
  }, lane);
  const requiredSet = resolveQueueRequiredSet({ cfg: {}, rules: policy });
  const check = (id, conclusion, createdAt) => ({ name: 'unit', app: { id }, head: reviewHead, conclusion, createdAt });
  const snapshot = { head: reviewHead, complete: true, requiredSet,
    results: [check(7, 'SUCCESS'), check(9, 'SUCCESS')] };
  assert.equal(classifyQueueChecks(snapshot).reason, 'missing-required-check:unit');
  snapshot.results.push(check(8, 'FAILURE', '2026-11-23T00:00:00Z'));
  assert.equal(classifyQueueChecks(snapshot).kind, 'red');
  snapshot.results.push(check(8, 'SUCCESS', '2026-11-23T00:01:00Z'));
  assert.equal(classifyQueueChecks(snapshot).kind, 'green');
  snapshot.results.push(check(8, 'FAILURE', '2026-11-23T00:02:00Z'), check(7, 'SUCCESS', '2026-11-23T00:04:00Z'));
  assert.equal(classifyQueueChecks(snapshot).kind, 'red');
  snapshot.results.push({ ...check(8, null, '2026-11-23T00:03:00Z'), status: 'IN_PROGRESS' });
  assert.equal(classifyQueueChecks(snapshot).reason, 'checks-pending');
  snapshot.results.push(check(8, 'SUCCESS', '2026-11-23T00:05:00Z'));
  assert.equal(classifyQueueChecks(snapshot).kind, 'green');
});

test('entitled credentials retain a valid token on transient refresh failure and never fall back to ambient auth', async () => {
  let now = 0, count = 0;
  const github = createQueueGitHub({ now: () => now, env: { GH_TOKEN: 'ambient-fixture' },
    mint: options => {
      assert.equal(options.repo, lane.repository);
      if (count++) throw Object.assign(new Error('broker fixture unavailable'), { transient: true });
      return { token: 'installation-fixture', expiresAtMs: 80_000 };
    } });
  assert.equal((await github.credential(lane.repository, 5_000)).token, 'installation-fixture');
  assert.equal(github.childEnv('installation-fixture').GH_TOKEN, 'installation-fixture');
  assert.equal(github.childEnv(null).GH_TOKEN, undefined);
  now = 35_000;
  assert.equal((await github.credential(lane.repository, 5_000)).token, 'installation-fixture');
  now = 79_000;
  await assert.rejects(github.credential(lane.repository, 5_000), /queue-credential-unavailable/);
  await assert.rejects(createQueueGitHub({ env: {}, readWithHammerEntitlement: true }).get(lane.repository, ['fixture'], { timeoutMs: 5_000 }), /queue-hammer-credential-unavailable/);
});

test('missing accounting delivery leaves the outbox pending', () => {
  const adapter = createQueueMergeActionDelivery({ write: () => null });
  assert.throws(() => adapter.read({ payload: { deliveryKey: 'fixture:pending' } }), /merge-action-delivery-unavailable/);
});

test('production evidence refuses subject movement and missing signed source records', async () => {
  const head = 'b'.repeat(40);
  let liveHead = reviewHead;
  const live = { snapshot: async () => ({ subject: { state: 'open', lane, head: liveHead, labels: [] }, pr: { draft: false } }),
    reviews: async () => ({ applicable: [{ row: { commit_id: head, state: 'APPROVED', id: 1 }, findings: [], verdict: 'approved' }] }) };
  const observe = createQueueProductionEvidence({ hqRoot: '/fixture', rootDir: '/fixture', live,
    readChain: () => [], now: () => handoffTime(0) });
  await assert.rejects(observe({ lane, head, prNumber: 102, cfg, deadline: handoffTime(10) }), /queue-admission-subject-ineligible/);
  liveHead = head;
  await assert.rejects(observe({ lane, head, prNumber: 102, cfg, deadline: handoffTime(10) }), /queue-source-review-attestation-unavailable/);
});

test('production admission accepts string labels and still refuses operator holds', async () => {
  const head = 'b'.repeat(40);
  const subject = { state: 'open', head, labels: ['reviewed', { name: 'ready' }] };
  const observe = createQueueProductionEvidence({ hqRoot: '/fixture', rootDir: '/fixture',
    live: { snapshot: () => ({ subject, pr: { draft: false } }), reviews: () => ({ applicable: [] }) },
    readChain: () => [], now: () => handoffTime(0) });
  const args = { lane, head, prNumber: 102, cfg, deadline: handoffTime(10) };
  await assert.rejects(observe(args), /queue-admission-review-unavailable/);
  subject.labels.push('no-merge-hold');
  await assert.rejects(observe(args), /queue-admission-subject-ineligible/);
  subject.labels = [''];
  await assert.rejects(observe(args), /queue-admission-subject-ineligible/);
});

for (const result of ['clean', 'ordinary', 'unknown']) {
  test(`production admission preserves ${result} validation evidence through finalization`, async t => {
    const remediated = result !== 'clean';
    const f = remediated ? gitFixture(t, { noop: true }) : null;
    const head = f?.oldHead ?? 'b'.repeat(40), reviewed = remediated ? reviewHead : head, prNumber = 102;
    let validationResult = result;
    if (result === 'unknown') {
      f.g(['checkout', 'topic']);
      const config = join(f.root, 'config.yaml');
      writeFileSync(config, 'version: 1\nroles:\n  adversarial:\n    merge_authority:\n      required_check_contexts: [unit]\n');
      writeFileSync(join(f.root, 'validation.json'), JSON.stringify({ head, selectedCheckCount: 5, checks: [{ result: 'pass' }] }));
      writeFileSync(join(f.root, `validation-deferred-${head}.json`), JSON.stringify({ schemaVersion: 1, head,
        validation: 'unknown', reason: 'absolute-timeout', ciAuthoritative: true, localFailureObserved: false,
        cleanup: 'finished', cleanCheckout: true, coverageComplete: false, localValidationReceipt: 'validation.json' }));
      const recordedResult = execFileSync(process.execPath, [join(import.meta.dirname, '../bin/hammer-validate.mjs'),
        '--queue-validation-result', head], { cwd: f.source, encoding: 'utf8',
        env: { ...process.env, HAM_RUN_DIR: f.root, HAM_REPO: lane.repository, AGENT_OS_CONFIG_PATH: config } });
      validationResult = recordedResult.trim();
      assert.equal(validationResult, result);
    }
    const closer = { workerId: 'fixture-closer', workerClass: 'hammer', launchRequestId: 'lrq_fixture' };
    const auditBody = launch => `<!-- hq:ham-terminal-remediation:audit -->\n`
      + `HAM-Base-Head: ${reviewed}\nHAM-Validated-Head: ${head}\nHAM-Queue-Launch-SHA256: ${createHash('sha256').update(launch).digest('hex')}\n`
      + `HAM-Queue-Validation: ${validationResult}\n`
      + '- **Blocking bug** (blocking) — fixed src/example.mjs';
    const reviewer = 'claude-reviewer-lacey';
    const review = { id: 1, state: 'APPROVED', commit_id: reviewed, submitted_at: handoffTime(-20), user: { login: reviewer } };
    const verifiedRecord = (kind, atHead, producer, payload, extra = {}) => ({ valid: true, kind,
      repo: lane.repository, pr_number: prNumber, head_sha: atHead, producer_identity: producer, payload,
      signature: { algorithm: 'fixture', subject: producer, digest: `fixture:${kind}` }, ...extra });
    const currency = { current: true, reviewedHead: reviewed, currentHead: head, proof: remediated ? 'ancestry' : 'exact-head',
      sourceRef: 'compare:fixture' };
    const findings = remediated ? [
      { findingId: 'blocker', severity: 'blocking', title: 'Blocking bug' },
      { findingId: 'advisory', severity: 'non-blocking', title: 'Optional cleanup' },
    ].map(finding => ({ ...finding, reviewId: '1', reviewCommitId: reviewed, sourceRef: 'review:1', currency })) : [];
    const rows = [verifiedRecord('reviewed', reviewed, reviewer, {}, { findings_count: findings.length, verdict: 'approved' }),
      verifiedRecord('produced', reviewed, 'fixture-builder', { source: 'hq_pr_open', worker_class: 'builder', launch_request_id: 'build-1' })];
    let comment = { id: 4, body: auditBody(closer.launchRequestId), updated_at: handoffTime(-1), user: { type: 'Bot', login: [...HAM_AUDIT_COMMENT_AUTHOR_LOGINS].find(login => login.endsWith('[bot]')) } };
    const subject = { state: 'open', lane, prNumber, head, labels: [], sourceRef: 'github:fixture' };
    const files = [{ filename: 'src/example.mjs', patch: '@@ -1 +1 @@\n-old\n+fixed' }];
    const snapshot = { subject, pr: { draft: false }, get: async () => ({ status: 'ahead', files }) };
    const live = { snapshot: () => snapshot, primary: () => ({ headSha: head, hasHammerCommits: false }),
      reviews: () => ({ applicable: [{ row: review, family: 'claude', findings, verdict: 'approved', sourceRef: 'review:1', currency }],
      comments: [comment], snapshot: { state: 'OPEN', headSha: head, reviews: [review], comments: [comment] } }) };
    let signatures = 0;
    if (f) ensureReviewStateSchema(f.store.db);
    const observe = createQueueProductionEvidence({ rootDir: f?.root ?? '/fixture', hqRoot: '/fixture', live, readChain: () => rows,
      now: () => handoffTime(0), readDispatches: () => [{ ...closer, dispatchWorkerClass: closer.workerClass,
        state: 'dispatched', reviewedSha: reviewed, dispatchedAt: handoffTime(-10) }],
      sign: () => {
        signatures++;
        return { valid: true, ref: 'sig:hammer', sourceRef: 'head-attestation:sig:hammer',
          record: verifiedRecord('produced', head, 'fixture-hammer', { launch_request_id: closer.launchRequestId, worker_class: closer.workerClass }) };
      } });
    const parameters = { lane, prNumber, head, cfg, deadline: handoffTime(60) };
    if (remediated) {
      parameters.request = fixtureRequest(head, 1, { closer, auditBody: auditBody(closer.launchRequestId) });
      comment = { ...comment, body: auditBody('lrq_foreign') };
      await assert.rejects(observe(parameters), /queue-exact-hammer-audit-unavailable/);
      assert.equal(signatures, 0);
      comment = { ...comment, body: auditBody(closer.launchRequestId) };
      await assert.rejects(observe(parameters), /queue-exact-finding-fix-unavailable/);
      parameters.cfg = { ...cfg, strictNonBlockingRemediation: false };
      const fixed = files.pop();
      await assert.rejects(observe(parameters), /queue-exact-finding-fix-unavailable/);
      files.push(fixed);
      const verifiedComment = comment;
      comment = { ...comment, body: comment.body.replace(`HAM-Queue-Validation: ${result}\n`, '') };
      parameters.request = fixtureRequest(head, 1, { closer, auditBody: comment.body });
      await assert.rejects(observe(parameters), /queue-exact-hammer-validation-result-unavailable/);
      comment = verifiedComment;
      parameters.request = fixtureRequest(head, 1, { closer, auditBody: comment.body });
    }
    const { input, evidence } = await observe(parameters);
    assert.equal(remediated ? validateQueueHandoff(input, evidence) : validateCleanReview(input, evidence), true);
    assert.equal(signatures, Number(remediated));
    if (remediated) {
      assert.deepEqual(input.dispositions.map(d => [d.findingId, d.resolution]), [['blocker', 'fixed'], ['advisory', 'deferred']]);
      assert.deepEqual(evidence.review.findings.map(f => f.findingId), ['blocker', 'advisory']);
      const store = resolveQueueHandoffStore(f.store);
      const routeGeneration = await transfer(f);
      const production = createProductionQueue({ rootDir: f.root, readConfig: () => parameters.cfg, now: f.now, observe });
      const ack = await production.admitHammer({ ...parameters.request, routeGeneration });
      f.reopen();
      const persisted = resolveQueueHandoffStore(f.store).read(parameters.request);
      assert.equal(persisted.ack.entryId, ack.entryId);
      assert.equal(validateQueueHandoff(persisted.handoff, persisted.evidence), true);
      if (result === 'unknown') {
        assert.deepEqual(persisted.evidence.localValidation, { head, sourceRef: input.localValidation.sourceRef,
          result: 'unknown', ciAuthoritative: true, cleanup: 'finished', cleanCheckout: true, localFailureObserved: false });
        const world = fakeWorld(f, { input });
        const adapters = world.compose();
        const noCi = resolveQueueRequiredSet({ cfg: {}, rules: { complete: true, contexts: [], sourceRef: 'rules:fixture', version: '1' } });
        adapters.checkReader.read = ({ entry }) => ({ head: entry.candidate, base: entry.exactBase, requiredSet: noCi,
          complete: true, results: [], noCi: { ok: true, configured: true, head: entry.candidate, sourceRef: 'no-ci:fixture' } });
        const consumer = createQueueConsumer({ rootDir: f.root, readConfig: () => parameters.cfg, now: f.now,
          compose: () => adapters, logger: { warn: message => assert.fail(message) } });
        await consumer.tick();
        assert.equal(f.store.readEntry(ack.entryId).phase, 'returned-to-closer');
        assert.equal(world.returns[0]?.reason, 'local-validation-unknown-required-contexts-undeclared');
        assert.equal(world.writes.length, 0);
      }

      Object.assign(findings[0], { file: 'src/example.mjs', lines: '1' });
      findings.push({ ...findings[0], findingId: 'second-blocker', lines: '2' });
      rows[0].findings_count = findings.length;
      await assert.rejects(observe(parameters), /queue-exact-finding-fix-unavailable/);
      comment = { ...comment, body: `${comment.body}\n- **Blocking bug** (blocking) — also fixed src/example.mjs` };
      parameters.request = fixtureRequest(head, 1, { closer, auditBody: comment.body });
      const duplicate = await observe(parameters);
      assert.equal(validateQueueHandoff(duplicate.input, duplicate.evidence), true);
      assert.deepEqual(duplicate.input.dispositions.map(d => [d.findingId, d.resolution]),
        [['blocker', 'fixed'], ['advisory', 'deferred'], ['second-blocker', 'fixed']]);
    }
  });
}

test('queue merge passes the exact candidate and explicit installation token to the existing surface', async () => {
  const invocation = [];
  const merge = createGithubAdapterMergeSurface({ recordReceipt: false, deleteBranch: false, envTokenSelector: 'merge-agent',
    env: { GHA_ADAPTER_BIN: '/fixture/github-adapter', GH_TOKEN: 'installation-fixture', GITHUB_TOKEN: 'foreign-ambient-fixture' },
    execFileImpl: async (command, args, options) => {
      invocation.push({ command, args, options });
      return { stdout: '{"merged":true}' };
    } }).merge;
  assert.equal((await merge({ subjectExternalId: `${lane.repository}#102`, revisionRef: reviewHead, timeoutMs: 5_000 })).ok, true);
  assert.equal(invocation.length, 1);
  const [{ command, args, options }] = invocation;
  assert.equal(command, '/fixture/github-adapter');
  assert.equal(args[args.indexOf('--match-head-commit') + 1], reviewHead);
  assert.equal(args[args.indexOf('--merge-method') + 1], 'squash');
  assert.equal(args[args.indexOf('--auth-mode') + 1], 'env-token');
  assert.equal(options.env.GH_TOKEN, 'installation-fixture');
  assert.equal(options.env.GITHUB_TOKEN, 'installation-fixture');
  assert.ok(args.includes('--no-delete-branch'));
  assert.ok(!args.includes('--admin'));
  const unavailable = createGithubAdapterMergeSurface({ recordReceipt: false, envTokenSelector: 'merge-agent',
    env: { GHA_ADAPTER_BIN: '/fixture/github-adapter', GITHUB_TOKEN: 'foreign-ambient-fixture' },
    execFileImpl: refuse }).merge;
  const result = await unavailable({ subjectExternalId: `${lane.repository}#102`, revisionRef: reviewHead, timeoutMs: 5_000 });
  assert.equal(result.reason, 'adapter-unavailable');
});

test('the next watcher resumes a published CI wait under the original deadline', async t => {
  const f = gitFixture(t, { noop: true });
  const generation = await transfer(f);
  const fixture = receiptFixture({ prNumber: 102, head: f.oldHead });
  const production = createProductionQueue({ rootDir: f.root, readConfig: () => cfg, now: f.now, observe: () => fixture });
  const ack = await production.admitClean({ route: { lane, routeGeneration: generation }, prNumber: 102, head: f.oldHead });
  let green = false;
  const world = fakeWorld(f, fixture, { checksGreen: () => green });
  const start = () => createQueueConsumer({ rootDir: f.root, readConfig: () => cfg, now: f.now, compose: world.compose });
  await start().tick();
  const waiting = f.store.readEntry(ack.entryId);
  assert.equal(waiting.phase, 'waiting-checks');
  assert.equal(world.writes.length, 0);
  f.clock(2);
  green = true;
  await start().tick();
  const merged = f.store.readEntry(ack.entryId);
  assert.equal(merged.phase, 'merged');
  assert.deepEqual(merged.patience, waiting.patience);
  assert.equal(merged.candidate, waiting.candidate);
  assert.equal(world.writes.length, 1);
});

test('the production PR observation reads all label pages and preserves merged readback', async () => {
  const head = 'b'.repeat(40);
  let merged = false, unreadableMerger = false;
  const paths = [];
  const live = createQueueLiveReads({ github: { reader: () => async path => {
    paths.push(path);
    if (path.includes('/labels?')) {
      return path.endsWith('page=1') ? Array.from({ length: 100 }, (_, id) => ({ id, name: `fixture-${id}` }))
        : [{ id: 123, name: 'do-not-merge' }];
    }
    return { number: 102, state: merged ? 'closed' : 'open', merged,
      base: { repo: { full_name: lane.repository }, ref: lane.base, sha: reviewHead },
      head: { repo: { full_name: lane.repository }, ref: 'topic', sha: head }, labels: [],
      merged_at: merged ? handoffTime(4) : null, merge_commit_sha: merged ? mergeSha : null,
      merged_by: merged && !unreadableMerger ? { login: bot } : null };
  } } });
  const budget = { timeoutMs: 1000 };
  const { subject } = await live.snapshot(lane, 102, budget);
  assert.equal(subject.labels.length, 101);
  assert.equal(subject.labels.at(-1).name, 'do-not-merge');
  paths.length = 0;
  merged = true;
  const terminal = (await live.snapshot(lane, 102, budget)).subject;
  assert.deepEqual([terminal.state, terminal.mergeCommitSha, terminal.mergedBy], ['merged', mergeSha, bot]);
  assert.equal(paths.length, 1);
  unreadableMerger = true;
  await assert.rejects(live.snapshot(lane, 102, budget), /queue-merge-readback-incomplete/);
});
