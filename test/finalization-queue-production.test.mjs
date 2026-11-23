import { installDispatchFileProducerFixture } from './helpers/dispatch-files-fixture.mjs';
installDispatchFileProducerFixture();
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HAM_AUDIT_COMMENT_AUTHOR_LOGINS } from '../src/ama/ham-provenance.mjs';
import { openFinalizationQueueStore } from '../src/finalization/queue-store.mjs';
import { validateCleanReview } from '../src/finalization/queue-clean-review.mjs';
import { validateQueueHandoff } from '../src/finalization/queue-handoff.mjs';
import { createGithubAdapterMergeSurface } from '../src/finalization/execution-surfaces.mjs';
import { createQueueConsumer } from '../src/finalization/queue-consumer.mjs';
import { createProductionQueue } from '../src/finalization/queue-production.mjs';
import { createQueueProductionEvidence } from '../src/finalization/queue-production-admission.mjs';
import { prepareQueueCloserDispatch } from '../src/finalization/queue-closer.mjs';
import { buildHammerQueueHandoffRequest, hammerReviewProof } from '../src/finalization/hammer-queue-handoff.mjs';
import { createQueueLiveReads, readQueueBranchPolicy } from '../src/finalization/queue-live.mjs';
import { classifyQueueChecks, resolveQueueRequiredSet } from '../src/finalization/queue-check-reader.mjs';
import { createQueueMergeActionDelivery } from '../src/finalization/queue-delivery.mjs';
import { createQueueGsr } from '../src/finalization/queue-gsr.mjs';
import { createQueueGitHub } from '../src/finalization/queue-github.mjs';
import { resolveQueueHandoffStore } from '../src/finalization/queue-handoff-store.mjs';
import { createLaneRoutingController } from '../src/finalization/queue-routing.mjs';
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

function receiptFixture({ prNumber, head, request }) {
  const { h, e } = { ...JSON.parse(JSON.stringify(request ? queueHandoffFixture(prNumber) : queueCleanFixture(prNumber)).replaceAll('b'.repeat(40), head)) };
  if (!request) return { input: { ...h, prNumber }, evidence: { ...e, subject: { ...e.subject, prNumber } } };
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
  assert.equal((await prepareQueueCloserDispatch({ rootDir: f.root, cfg, lane, prNumber: 102, head: f.oldHead })).queued, true);
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
  assert.equal((await prepareQueueCloserDispatch(target)).acknowledgement.entryId, result.entryId);
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
  snapshot.results[0].app.id = 7;
  assert.equal(classifyQueueChecks(snapshot).kind, 'green');
});

test('entitled credentials retain a valid token on transient refresh failure and never fall back to ambient auth', async () => {
  let now = 0, count = 0;
  const github = createQueueGitHub({ ownerFor: () => null, now: () => now, env: { GH_TOKEN: 'ambient-fixture' },
    mint: options => {
      assert.equal(options.requireInstallation, true);
      if (count++) throw Object.assign(new Error('broker fixture unavailable'), { transient: true });
      return { token: 'installation-fixture', expiresAtMs: 80_000 };
    } });
  assert.equal((await github.credential(lane.repository, 5_000)).token, 'installation-fixture');
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

for (const remediated of [false, true]) {
  test(`production evidence assembles validator-compatible ${remediated ? 'hammer' : 'clean'} evidence`, async () => {
    const head = 'b'.repeat(40), reviewed = remediated ? reviewHead : head, prNumber = 102;
    const closer = { workerId: 'fixture-closer', workerClass: 'hammer', launchRequestId: 'lrq_fixture' };
    const auditBody = launch => `<!-- hq:ham-terminal-remediation:audit -->\n`
      + `HAM-Base-Head: ${reviewed}\nHAM-Validated-Head: ${head}\nHAM-Queue-Launch-SHA256: ${createHash('sha256').update(launch).digest('hex')}`;
    const reviewer = 'claude-reviewer-lacey';
    const review = { id: 1, state: 'APPROVED', commit_id: reviewed, submitted_at: handoffTime(-20), user: { login: reviewer } };
    const verifiedRecord = (kind, atHead, producer, payload, extra = {}) => ({ valid: true, kind,
      repo: lane.repository, pr_number: prNumber, head_sha: atHead, producer_identity: producer, payload,
      signature: { algorithm: 'fixture', subject: producer, digest: `fixture:${kind}` }, ...extra });
    const rows = [verifiedRecord('reviewed', reviewed, reviewer, {}, { findings_count: 0, verdict: 'approved' }),
      verifiedRecord('produced', reviewed, 'fixture-builder', { source: 'hq_pr_open', worker_class: 'builder', launch_request_id: 'build-1' })];
    let comment = { id: 4, body: auditBody(closer.launchRequestId), updated_at: handoffTime(-1), user: { type: 'Bot', login: [...HAM_AUDIT_COMMENT_AUTHOR_LOGINS].find(login => login.endsWith('[bot]')) } };
    const subject = { state: 'open', lane, prNumber, head, labels: [], sourceRef: 'github:fixture' };
    const snapshot = { subject, pr: { draft: false }, get: async () => ({ status: 'ahead' }) };
    const live = { snapshot: () => snapshot, primary: () => ({ headSha: head, hasHammerCommits: false }),
      reviews: () => ({ applicable: [{ row: review, family: 'claude', findings: [], verdict: 'approved', sourceRef: 'review:1',
        currency: { current: true, reviewedHead: reviewed, currentHead: head, proof: remediated ? 'ancestry' : 'exact-head' } }],
      comments: [comment], snapshot: { state: 'OPEN', headSha: head, reviews: [review], comments: [comment] } }) };
    let signatures = 0;
    const observe = createQueueProductionEvidence({ rootDir: '/fixture', hqRoot: '/fixture', live, readChain: () => rows,
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
    }
    const { input, evidence } = await observe(parameters);
    assert.equal(remediated ? validateQueueHandoff(input, evidence) : validateCleanReview(input, evidence), true);
    assert.equal(signatures, Number(remediated));
  });
}

test('queue merge passes the exact candidate and explicit installation token to the existing surface', async () => {
  const invocation = [];
  const merge = createGithubAdapterMergeSurface({ recordReceipt: false, deleteBranch: false, envTokenSelector: 'merge-agent',
    env: { GHA_ADAPTER_BIN: '/fixture/github-adapter', GH_TOKEN: 'installation-fixture' },
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
  assert.ok(args.includes('--no-delete-branch'));
  assert.ok(!args.includes('--admin'));
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
