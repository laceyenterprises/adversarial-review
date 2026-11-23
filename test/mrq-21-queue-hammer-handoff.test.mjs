// MRQ-21: on a queue-v2 lane the hammer ends at its attested head. Its close
// step hands that exact head to the queue executor through the installed
// handoff surface, and the executor merges it under its own lane ownership.
// Synthetic fixtures only: a local Git remote, a temporary queue store and
// fake GitHub/merge surfaces. No network, credentials or Agent OS host.
import { installDispatchFileProducerFixture } from './helpers/dispatch-files-fixture.mjs';
installDispatchFileProducerFixture();
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { createQueueHandoffService } from '../src/finalization/queue-handoff-store.mjs';
import { createQueueCloserComposition, prepareQueueCloserDispatch } from '../src/finalization/queue-closer.mjs';
import { createQueueOwner } from '../src/finalization/queue-owner.mjs';
import { createQueueAdmissionService } from '../src/finalization/queue-admission.mjs';
import { createQueueRebaseService } from '../src/finalization/queue-rebase.mjs';
import { createQueueChecksService } from '../src/finalization/queue-checks.mjs';
import { createQueueMergeService } from '../src/finalization/queue-merge.mjs';
import { resolveQueueRequiredSet } from '../src/finalization/queue-check-reader.mjs';
import { createQueueClosureAuditDelivery, createQueueMergeActionDelivery } from '../src/finalization/queue-delivery.mjs';
import { validateQueueHandoff } from '../src/finalization/queue-handoff.mjs';
import { appendAmaAuditAttempt, readAmaAuditEntry } from '../src/ama/audit.mjs';
import { hammerStopOrigin } from '../src/ama/hammer-stop-origin.mjs';
import { admitHammerQueueHandoff, confirmHammerQueueHandoff, hammerReviewProof, runHammerQueueHandoffStep,
  runHammerQueueHandoffCommand, HAMMER_QUEUE_HANDOFF_ADMITTED } from '../src/finalization/hammer-queue-handoff.mjs';
import { gitFixture, idle } from './helpers/queue-rebase-fixture.mjs';
import { queueHandoffFixture, reviewHead, handoffTime } from './helpers/queue-handoff-fixture.mjs';
import { queueLiveFixture } from './helpers/queue-clean-fixture.mjs';

const lane = { repository: 'example/review', base: 'main' };
const cfg = { enabled: true, laneRoutes: [{ ...lane, executor: 'queue-v2' }] };
const BOT = 'queue-app[bot]';
const mergeSha = 'd'.repeat(40);
const requiredSet = resolveQueueRequiredSet({ cfg: { requiredCheckContexts: ['unit'] },
  rules: { complete: true, contexts: [], sourceRef: 'rules:fixture', version: '1' } });
const green = entry => ({ head: entry.candidate, base: entry.exactBase, requiredSet, complete: true, observedAt: handoffTime(0),
  results: [{ name: 'unit', head: entry.candidate, conclusion: 'SUCCESS', url: 'https://example.invalid/check/1' }] });
const auditBody = head => `<!-- hq:ham-terminal-remediation:audit -->\nSynthetic audit\n<sub>\nHAM-Validated-Head: ${head}\n</sub>`;

// One synthetic queue-v2 lane with a remote branch at the hammer's attested head.
function laneFixture(t) {
  const f = gitFixture(t, { noop: true });
  f.store.ensureLane(lane);
  const routeGeneration = f.store.readOwner(lane).route_generation;
  const hqRoot = join(f.root, 'hq');
  mkdirSync(join(hqRoot, '.hq'), { recursive: true, mode: 0o750 });
  writeFileSync(join(hqRoot, '.hq', 'config.json'), JSON.stringify({ ownerUser: userInfo().username }));
  const runDir = mkdtempSync(join(tmpdir(), 'mrq21-run-'));
  t.after(() => rmSync(runDir, { recursive: true, force: true }));
  const head = f.oldHead;
  const env = { HAM_REPO: lane.repository, HAM_PR_NUMBER: '102', POST_REMEDIATION_SHA: head,
    HAM_REVIEWED_SHA: reviewHead, HAM_PUBLISHED_AUDIT_HEAD: head, HAM_AUDIT_COMMENT_BODY: auditBody(head),
    HAM_QUEUE_ROUTE_GENERATION: String(routeGeneration), HAM_QUEUE_HANDOFF_COMMAND: '["/fixture/installed-handoff"]',
    HAM_QUEUE_CLOSER_WORKER_ID: 'closer-1', HAM_QUEUE_CLOSER_WORKER_CLASS: 'closer', HQ_LAUNCH_REQUEST_ID: 'close-1',
    HAM_RUN_DIR: runDir, HAM_HQ_ROOT: hqRoot };
  // The installed handoff surface: a trusted evidence adapter verifies the
  // request's facts (here, synthetic) and commits through the composition.
  const deliveries = [];
  const installed = async ({ command, requestPath }) => {
    const request = JSON.parse(readFileSync(requestPath, 'utf8'));
    deliveries.push({ command, request });
    const swap = value => JSON.parse(JSON.stringify(value).replaceAll('b'.repeat(40), request.head));
    const { h: base, e: evidence } = queueHandoffFixture(request.prNumber);
    const h = { ...swap(base), handoffId: request.handoffId, admissionGeneration: request.admissionGeneration,
      closer: request.closer, reviewProof: { digest: request.reviewProof.digest, head: request.head } };
    const e = { ...swap(evidence), reviewProof: { ok: true, head: request.head, digest: request.reviewProof.digest,
      sourceRef: 'live-audit:1' } };
    const service = createQueueHandoffService({ store: f.store, now: f.now, load: idle, evidenceAdapter: { read: async () => e } });
    let released = 0;
    const composition = createQueueCloserComposition({ rootDir: f.root, readConfig: () => cfg, handoffService: service,
      handoffInstructions: 'installed fixture handoff', releaseResources: () => { released++; } });
    const result = await composition.handoff(h, { routeGeneration: request.routeGeneration, deadline: request.deadline });
    assert.equal(released, 1);
    return result;
  };
  const audits = [];
  const step = (overrides = {}) => runHammerQueueHandoffStep({ env, rootDir: f.root, timeoutMs: 30_000,
    now: () => new Date(handoffTime(0)),
    readPr: async () => ({ state: 'OPEN', headSha: head, baseRefName: lane.base }),
    admit: args => admitHammerQueueHandoff({ ...args, run: installed }),
    appendAdmittedAudit: ({ head: auditHead, attempt }) => {
      audits.push(attempt);
      return appendAmaAuditAttempt({ hqRoot, repo: lane.repository, prNumber: 102, headSha: auditHead,
        attempt: { ...attempt, deliveryKey: `queue-handoff:${attempt.queueHandoff.entryId}:${attempt.launchRequestId}` },
        metadata: { closureAuthority: 'ham-terminal-remediation' } });
    }, ...overrides });
  return { f, head, env, hqRoot, deliveries, audits, step, routeGeneration };
}

// Drive the executor over the admitted entry with fake live/check/merge surfaces.
async function executor(x, { liveHead = () => x.head, mergeResponses = [] } = {}) {
  const { f } = x;
  const entry = f.store.entries(lane)[0];
  const { h } = queueHandoffFixture(102);
  const live = queueLiveFixture({ ...h, head: x.head });
  live.subject.baseSha = f.base;
  Object.assign(live.subject, { headRepository: 'example/review', headRef: 'topic' });
  Object.assign(live.permission, { canForcePush: true, canWriteHeadRepository: true, maintainerCanModify: true,
    fork: false, rulesSourceRef: 'rules:1', headRepository: 'example/review', headRef: 'topic' });
  const world = { merged: false };
  const liveAdapter = { read: async () => {
    const copy = structuredClone(live);
    copy.subject.head = world.mergedHead ?? liveHead();
    copy.eligibility.primaryChange.headSha = copy.subject.head;
    if (world.merged) Object.assign(copy.subject, { state: 'merged', mergeCommitSha: mergeSha, mergedAt: f.now(), mergedBy: BOT });
    return copy;
  } };
  const calls = [];
  const mergeSurface = { name: 'fake-squash', merge: async request => {
    calls.push(request);
    const scripted = mergeResponses.shift();
    if (scripted) return scripted;
    world.merged = true; world.mergedHead = request.revisionRef;
    return { ok: true, payload: { merged: true, sha: mergeSha } };
  } };
  const owner = createQueueOwner({ store: f.store, now: f.now });
  const claim = async () => (await owner.claim({ lane, ownerId: 'owner', expiresAt: handoffTime(4000) })).fence;
  const base = { store: f.store, owner, now: f.now, load: idle, liveAdapter, gitAdapter: f.adapter };
  const checkReader = { read: async ({ entry: e }) => green(e) };
  const merger = createQueueMergeService({ ...base, checkReader, mergeSurface,
    identitySurface: { check: async () => ({ ok: true, login: BOT, producerClass: 'closer-hammer', sourceRef: 'identity:merge' }) },
    pageAdapter: { read: async ({ payload }) => ({ id: payload.causeKey, status: 'queued' }) },
    deliveryAdapters: { 'merge-action-receipt': createQueueMergeActionDelivery({ hqRoot: x.hqRoot }),
      'closure-audit': createQueueClosureAuditDelivery({ hqRoot: x.hqRoot }) } });
  const pass = async () => {
    const fence = await claim();
    let current = await createQueueAdmissionService({ store: f.store, now: f.now, load: idle, liveAdapter })
      .reconcile({ fence, entryId: entry.entryId });
    if (current.phase !== 'ready') return current;
    current = await createQueueRebaseService(base).run({ fence, entryId: entry.entryId });
    if (!['waiting-checks', 'finalizing'].includes(current.phase)) return current;
    current = await createQueueChecksService({ ...base, checkReader }).poll({ fence, entryId: entry.entryId });
    if (current.phase !== 'finalizing') return current;
    return merger.finalize({ fence, entryId: entry.entryId });
  };
  return { entry, calls, pass, world };
}

test('MRQ-21: an attested head hands off, is admitted, and the executor merges exactly that head', async t => {
  const x = laneFixture(t);
  const result = await x.step();
  assert.equal(result.ok, true);
  assert.equal(result.outcome, HAMMER_QUEUE_HANDOFF_ADMITTED);
  assert.equal(result.head, x.head);
  // One delivery, through the installed argv, bound to repo, PR, head and review proof.
  assert.equal(x.deliveries.length, 1);
  const { request } = x.deliveries[0];
  assert.deepEqual(x.deliveries[0].command, ['/fixture/installed-handoff']);
  assert.deepEqual([request.lane, request.prNumber, request.head], [lane, 102, x.head]);
  assert.equal(request.reviewProof.digest, hammerReviewProof({ lane, prNumber: 102, head: x.head,
    reviewedSha: reviewHead, auditHead: x.head, auditBody: auditBody(x.head) }).digest);
  assert.equal(result.reviewProofDigest, request.reviewProof.digest);
  // The launch's required outcome: one superseded terminal audit naming it.
  const audit = readAmaAuditEntry(x.hqRoot, lane.repository, 102, x.head);
  assert.equal(audit.status, 'superseded');
  assert.equal(audit.attempts.length, 1);
  assert.equal(audit.attempts[0].reason, 'queue-handoff-admitted');
  assert.equal(audit.attempts[0].launchRequestId, 'close-1');
  assert.equal(audit.attempts[0].queueHandoff.entryId, result.entryId);
  // A duplicate wake for this head is suppressed by the durable ack.
  const prepared = await prepareQueueCloserDispatch({ rootDir: x.f.root, cfg, lane, prNumber: 102, head: x.head,
    composition: { hammerHandoffCommand: ['/fixture/installed-handoff'] } });
  assert.equal(prepared.reason, 'queue-handoff-acknowledged');
  // The executor merges the handed-off head itself, guarded by that head.
  const q = await executor(x);
  const merged = await q.pass();
  assert.equal(merged.phase, 'merged', JSON.stringify(merged));
  assert.equal(q.calls.length, 1);
  assert.equal(q.calls[0].revisionRef, x.head);
  assert.equal(merged.candidate, x.head);
  assert.equal(merged.merge.mergeSha, mergeSha);
});

test('MRQ-21: a retried launch replays the durable admission without a second delivery', async t => {
  const x = laneFixture(t);
  const first = await x.step();
  const second = await x.step();
  assert.equal(x.deliveries.length, 1);
  assert.equal(second.replay, true);
  assert.deepEqual([second.entryId, second.ackId, second.reviewProofDigest], [first.entryId, first.ackId, first.reviewProofDigest]);
  assert.equal(x.f.store.entries(lane).length, 1);
  assert.equal(readAmaAuditEntry(x.hqRoot, lane.repository, 102, x.head).attempts.length, 1, 'same delivery key appends once');
});

test('MRQ-21: a head move after the handoff voids it, merges nothing, and is never re-hammered from the old head', async t => {
  const x = laneFixture(t);
  const admitted = await x.step();
  const moved = 'e'.repeat(40);
  const q = await executor(x, { liveHead: () => moved });
  const result = await q.pass();
  assert.equal(result.phase, 'returned-to-closer');
  assert.equal(result.reason, 'external-head-change');
  assert.equal(q.calls.length, 0, 'no merge on a moved head');
  // The void entry keeps its receipt as history but no longer suppresses work.
  assert.equal(x.f.store.readEntry(admitted.entryId).phase, 'returned-to-closer');
  // The moved head has no handoff: it needs its own review and attested head.
  const fresh = await prepareQueueCloserDispatch({ rootDir: x.f.root, cfg, lane, prNumber: 102, head: moved,
    composition: { hammerHandoffCommand: ['/fixture/installed-handoff'] } });
  assert.equal(fresh.executor, 'queue-v2');
  assert.equal(fresh.queued, undefined);
  // A hammer step that observes the moved head stops on the world fact
  // (fresh review lifecycle) and never delivers a handoff for the old head.
  await assert.rejects(x.step({ readPr: async () => ({ state: 'OPEN', headSha: moved, baseRefName: lane.base }) }),
    error => error.code === 'head-changed');
  assert.equal(hammerStopOrigin('head-changed'), 'world');
  assert.equal(x.deliveries.length, 1);
});

test('MRQ-21: an executor transient merge failure is retried on the same head and the handoff is kept', async t => {
  const x = laneFixture(t);
  const admitted = await x.step();
  const q = await executor(x, { mergeResponses: [{ ok: false, reason: 'merge-refused' }] });
  const first = await q.pass();
  t.diagnostic(`first=${first.phase}:${first.reason}`); assert.notEqual(first.phase, 'merged');
  assert.notEqual(first.phase, 'returned-to-closer', 'a transient refusal never returns the head to a closer');
  assert.equal(q.calls.length, 1);
  // The admission, receipt and suppression all survive the failed attempt.
  const prepared = await prepareQueueCloserDispatch({ rootDir: x.f.root, cfg, lane, prNumber: 102, head: x.head,
    composition: { hammerHandoffCommand: ['/fixture/installed-handoff'] } });
  assert.equal(prepared.reason, 'queue-handoff-acknowledged');
  const receipt = confirmHammerQueueHandoff({ rootDir: x.f.root, request: x.deliveries[0].request,
    ack: { entryId: admitted.entryId, ackId: admitted.ackId, head: x.head, prNumber: 102, lane, admissionGeneration: 1 } });
  assert.equal(receipt.entryId, admitted.entryId);
  const retried = await q.pass();
  assert.equal(retried.phase, 'merged', JSON.stringify(retried));
  assert.equal(q.calls.length, 2);
  assert.deepEqual(q.calls.map(call => call.revisionRef), [x.head, x.head]);
  assert.equal(x.deliveries.length, 1, 'the executor retries; the hammer is not re-dispatched');
});

test('MRQ-21: merged, closed or moved PRs and unbound proofs never deliver a handoff', async t => {
  const x = laneFixture(t);
  for (const [live, code] of [[{ state: 'MERGED', headSha: x.head, baseRefName: 'main' }, 'already-merged'],
    [{ state: 'CLOSED', headSha: x.head, baseRefName: 'main' }, 'pr-closed'],
    [{ state: 'OPEN', headSha: 'f'.repeat(40), baseRefName: 'main' }, 'head-changed']]) {
    await assert.rejects(x.step({ readPr: async () => live }), error => error.code === code);
  }
  await assert.rejects(x.step({ readPr: async () => { throw new Error('transport'); } }),
    error => error.code === 'queue-handoff-unadmitted');
  for (const env of [{ HAM_PUBLISHED_AUDIT_HEAD: reviewHead }, { HAM_AUDIT_COMMENT_BODY: auditBody(reviewHead) },
    { HAM_QUEUE_CLOSER_WORKER_ID: '' }, { HAM_QUEUE_ROUTE_GENERATION: 'x' }]) {
    await assert.rejects(x.step({ env: { ...x.env, ...env } }), error => error.code === 'queue-handoff-unadmitted');
  }
  await assert.rejects(x.step({ env: { ...x.env, HAM_QUEUE_HANDOFF_COMMAND: '["relative/tool"]' },
    admit: args => admitHammerQueueHandoff(args) }), /command unavailable/);
  assert.equal(x.deliveries.length, 0);
  assert.equal(x.f.store.entries(lane).length, 0);
  assert.equal(hammerStopOrigin('queue-handoff-unadmitted'), 'infrastructure');
  assert.equal(hammerStopOrigin('pr-closed'), 'world');
});

test('MRQ-21: a reply whose durable receipt is not bound to this head, launch and review proof is unadmitted', async t => {
  const x = laneFixture(t);
  await x.step();
  const { request } = x.deliveries[0];
  const ack = x.f.store.entries(lane)[0];
  const reply = { entryId: ack.entryId, ackId: ack.ackId, head: x.head, prNumber: 102, lane, admissionGeneration: 1 };
  assert.equal(confirmHammerQueueHandoff({ rootDir: x.f.root, request, ack: reply }).ok, true);
  for (const tamper of [{ reviewProof: { ...request.reviewProof, digest: '0'.repeat(64) } },
    { closer: { ...request.closer, launchRequestId: 'other-launch' } }]) {
    assert.throws(() => confirmHammerQueueHandoff({ rootDir: x.f.root, request: { ...request, ...tamper }, ack: reply }),
      error => error.code === 'queue-handoff-unadmitted');
  }
  assert.throws(() => confirmHammerQueueHandoff({ rootDir: x.f.root, request, ack: { ...reply, head: 'e'.repeat(40) } }),
    /foreign/);
});

test('MRQ-21: the handoff validator binds an optional review proof to trusted evidence at the exact head', () => {
  const { h, e } = queueHandoffFixture(101);
  assert.equal(validateQueueHandoff(h, e), true, 'receipts without a review proof still validate');
  const digest = 'a'.repeat(64);
  const bound = { ...h, reviewProof: { digest, head: h.head } };
  assert.throws(() => validateQueueHandoff(bound, e), /review proof mismatch/);
  assert.equal(validateQueueHandoff(bound, { ...e, reviewProof: { ok: true, head: h.head, digest, sourceRef: 'audit:1' } }), true);
  assert.throws(() => validateQueueHandoff(bound, { ...e, reviewProof: { ok: true, head: h.head, digest: 'b'.repeat(64), sourceRef: 'audit:1' } }),
    /review proof mismatch/);
});

test('MRQ-21: legacy rendered phases and bootstrap carry no queue codes or inputs', async () => {
  const { renderHammerBootstrap, renderHammerProcedure, HAMMER_PHASES } = await import('../src/hammer-procedure.mjs');
  const { HAMMER_QUEUE_CONTROLLER_OUTCOMES } = await import('../src/ama/hammer-stop-origin.mjs');
  const values = { ROOT_DIR: '/fixture/root', RUN_DIR: '/fixture/run', HQ_ROOT: '/fixture/hq', REPO: lane.repository,
    PR_NUMBER: '7', PR_URL: 'https://github.com/example/review/pull/7', REVIEWED_SHA: reviewHead,
    TARGET_REMEDIATION_SHA: reviewHead, RISK_CLASS: 'low', MERGE_METHOD: 'squash', HQ_OWNER: 'fixture',
    AUDIT_PATH: '/fixture/audit.json', REVIEWER: 'codex', AMA_TRAILERS: 'Trailer: x', AMA_TRAILERS_SHELL: "''",
    REQUIRED_GATE_CONTEXT: 'gate', REVIEWED_BY: 'reviewer', DISPATCHED_AT: handoffTime(0) };
  const bootstrap = renderHammerBootstrap(values);
  assert.doesNotMatch(bootstrap, /HAM_FINALIZATION_EXECUTOR|HAM_QUEUE_|<<QUEUE_INPUTS>>/);
  assert.equal(bootstrap, renderHammerBootstrap({ ...values, QUEUE_INPUTS: '' }));
  for (const phase of HAMMER_PHASES) {
    const source = renderHammerProcedure(phase, values);
    for (const code of HAMMER_QUEUE_CONTROLLER_OUTCOMES) assert.ok(!source.includes(code), `${phase} names ${code}`);
    assert.doesNotMatch(source, /HAM-Queue-Launch-SHA256/);
    assert.equal(source, renderHammerProcedure(phase, { ...values, QUEUE_INPUTS: '' }));
    const queue = renderHammerProcedure(phase, { ...values, QUEUE_INPUTS: 'export HAM_FINALIZATION_EXECUTOR=queue-v2' });
    if (phase === 'hammer-publish') {
      assert.match(queue, /HAM-Queue-Launch-SHA256/);
      assert.match(queue, /HAM-Queue-Launch-SHA256[^\n]*\nHAM_AUDIT_COMMENT_BODY=[^\n]*\n[^\n]*\/bin\/github-outbound-body\.mjs/);
    } else assert.equal(queue, source);
  }
});


test('MRQ-21: audit header comparison normalizes SHA casing without changing the proof body', () => {
  const head = 'aBcD'.repeat(10);
  const proof = hammerReviewProof({ lane, prNumber: 102, head, reviewedSha: reviewHead,
    auditHead: head.toUpperCase(), auditBody: auditBody(head.toLowerCase()) });
  assert.equal(proof.head, head.toLowerCase());
  assert.throws(() => hammerReviewProof({ lane, prNumber: 102, head, reviewedSha: reviewHead,
    auditHead: head, auditBody: auditBody('f'.repeat(40)) }), /does not name the exact head/);
});

for (const prefix of ['', 'diagnostic line\n']) {
  test(`MRQ-21: installed handoff accepts formatted acknowledgement (${prefix ? 'with diagnostics' : 'JSON only'})`, async () => {
    const ack = { ack: { entryId: 'entry-1', ackId: 'ack-1', head: 'a'.repeat(40),
      lane: { repository: lane.repository, base: lane.base } } };
    const output = prefix + JSON.stringify(ack, null, 2) + '\n';
    const reply = await runHammerQueueHandoffCommand({ command: [process.execPath, '-e',
      `process.stdout.write(${JSON.stringify(output)})`], requestPath: '/fixture/request.json', timeoutMs: 10000 });
    assert.deepEqual(reply, ack);
  });
}
