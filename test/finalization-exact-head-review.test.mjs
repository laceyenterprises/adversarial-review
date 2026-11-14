import './helpers/load-aware-timeout-fixture.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openReviewStateDb, ensureReviewStateSchema, requestReviewRereview } from '../src/review-state.mjs';
import { reconcileExplicitReviewIntents, consumeExplicitReviewIntent } from '../src/explicit-review-intent.mjs';
import { openFinalizationLedgerStore } from '../src/finalization/ledger-store.mjs';
import { openFinalizationExecutorLeaseStore } from '../src/finalization/executor-lease-store.mjs';
import { openFinalizationShadowStore } from '../src/finalization/shadow-store.mjs';
import { createFinalizationExecutor } from '../src/finalization/executor.mjs';
import { createExactHeadReviewSurface, readFinalRemediatorHead } from '../src/finalization/exact-head-review.mjs';
import { makeFinalizationEvent } from '../src/finalization/ledger-events.mjs';
import { recordLiveShadow } from '../src/finalization/live-shadow.mjs';
import { fold } from '../src/finalization/ledger-fold.mjs';
import { eligible } from '../src/finalization/eligibility.mjs';

const repo = 'example/project', prNumber = 17;
const subject = { domainId: 'code-pr', subjectExternalId: `${repo}#${prNumber}` };
const oldHead = 'a'.repeat(40), head = 'b'.repeat(40), movedHead = 'c'.repeat(40);
const at = n => new Date(Date.UTC(2030, 0, 1) + n).toISOString();
const load = { loadAvg1m: 0, cpuCount: 1, cpuBusyPercent: 100 };
const complete = value => ({ state: 'complete', value, provenance: { sourceRef: 'fixture:read' } });
const quiet = { log() {}, warn() {} };

function fixture(t, changeJob = job => job) {
  t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2030, 0, 1) });
  const rootDir = mkdtempSync(join(tmpdir(), 'v2-exact-'));
  const db = openReviewStateDb(rootDir);
  ensureReviewStateSchema(db);
  t.after(() => { db.close(); rmSync(rootDir, { recursive: true, force: true }); });
  db.prepare(`INSERT INTO reviewed_prs (repo, pr_number, reviewed_at, reviewer,
    review_status, pr_state, revision_ref, reviewer_head_sha, posted_at, review_attempts)
    VALUES (?, ?, ?, 'claude', 'posted', 'open', ?, ?, ?, 3)`)
    .run(repo, prNumber, at(0), oldHead, oldHead, at(0));
  const job = changeJob({ jobId: 'fixture-job', repo, prNumber, status: 'completed',
    revisionRef: oldHead, completedAt: at(0),
    remediationPlan: { currentRound: 4, maxRounds: 4 },
    completion: { finalRemediationPush: true, workerPushedHeadSha: head },
    reReview: { requested: false, nextAction: { head, action: 'hammer' } } });
  const jobDir = join(rootDir, 'data', 'follow-up-jobs', 'completed');
  mkdirSync(jobDir, { recursive: true });
  const jobPath = join(jobDir, 'example__project-pr-17-fixture.json');
  writeFileSync(jobPath, JSON.stringify(job));
  const ledgerStore = openFinalizationLedgerStore({ db });
  const leaseStore = openFinalizationExecutorLeaseStore({ db });
  let seq = 0;
  const append = (type, fields = {}) => ledgerStore.append(makeFinalizationEvent(type, subject, {
    at: at(0), sourceRef: `fixture:${++seq}`, idempotencyKey: `fixture:${seq}`, ...fields,
  }));
  append('revision_advanced', { revisionRef: head });
  append('provenance_observed', { revisionRef: head, builderBoundary: oldHead,
    primaryChange: 'preserved', hammerCommits: false, mergeMain: false });
  append('checks_settled', { revisionRef: head, conclusion: 'success', requiredChecksPresent: true });
  let live = { state: 'open', head, sourceRef: 'fixture:live' };
  const requests = [];
  const reviewSurface = createExactHeadReviewSurface({ rootDir, requestRereview: args => {
    requests.push(args);
    return requestReviewRereview({ ...args, logger: quiet });
  } });
  const build = options => createFinalizationExecutor({ enabled: true, ledgerStore, leaseStore,
    reviewSurface, liveSurface: { read: async () => live }, holder: 'fixture-executor', ...options });
  let executor = build();
  return { rootDir, db, jobPath, append, requests, ledgerStore, reviewSurface, build,
    restart: () => { executor = build(); },
    setLive: value => { live = value; },
    tick: () => executor.tick(subject, { observedAt: at(100), load }),
    intents: () => db.prepare('SELECT * FROM explicit_review_intents ORDER BY request_id').all(),
    row: () => db.prepare('SELECT * FROM reviewed_prs WHERE repo=? AND pr_number=?').get(repo, prNumber),
  };
}

test('final-round remediator head queues once, survives restart, preserves budgets and continues from verdict', async t => {
  const f = fixture(t);
  const beforeJob = readFileSync(f.jobPath, 'utf8');
  const first = await f.tick();
  assert.equal(first.action, 'request-reexact-review');
  assert.equal(first.status, 'executed');
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].targetRevisionRef, head);
  assert.equal(f.requests[0].preserveBudgets, true);
  assert.equal(f.intents().length, 1);
  assert.equal(f.intents()[0].head_sha, head);
  assert.equal(f.row().review_attempts, 3);
  f.restart();
  assert.equal((await f.tick()).decision.nextAction, 'monitor-review');
  assert.equal(f.requests.length, 1);
  assert.equal(readFileSync(f.jobPath, 'utf8'), beforeJob);
  f.append('verdict_recorded', { revisionRef: head, stageId: 'review', role: 'independent', verdictKind: 'approved' });
  const state = fold(f.ledgerStore.read(subject));
  assert.equal(eligible(state, {}, { observedAt: at(100), load }).nextAction, 'merge');
});

test('head movement before issuance discards the old request', async t => {
  const f = fixture(t);
  let reads = 0;
  const executor = f.build({ liveSurface: { read: async () => ({
    state: 'open', head: ++reads === 1 ? head : movedHead, sourceRef: 'fixture:live',
  }) } });
  const result = await executor.tick(subject, { observedAt: at(100), load });
  assert.equal(result.action, 're-decide');
  assert.equal(f.requests.length, 0);
  assert.equal(f.intents().length, 0);
});

test('expired verdict patience still permits a bounded recovery refresh and request', async t => {
  const f = fixture(t);
  const budgets = [];
  const executor = f.build({ liveSurface: { read: async ({ timeoutMs }) => {
    budgets.push(timeoutMs);
    return { state: 'open', head, sourceRef: 'fixture:live' };
  } } });
  const result = await executor.tick(subject, { observedAt: at(31 * 60 * 1000), load });
  assert.equal(result.action, 'request-reexact-review');
  assert.equal(result.status, 'executed');
  assert.equal(f.requests.length, 1);
  assert.equal(budgets.length, 2);
  assert.ok(budgets.every(ms => ms > 1 && ms <= 30000));
});

test('a verdict arriving in the authoritative refresh prevents a stale request', async t => {
  const f = fixture(t);
  let reads = 0;
  const executor = f.build({ liveSurface: { read: async () => ({
    state: 'open', head, sourceRef: 'fixture:live',
    ...(++reads > 1 ? { ownerSnapshot: { observations: {
      reviews: complete({ headSha: head, verdict: 'approved' }),
    } } } : {}),
  }) } });
  assert.equal((await executor.tick(subject, { observedAt: at(100), load })).action, 're-decide');
  assert.equal(f.requests.length, 0);
});

test('the queue transaction preserves a verdict posted after the final head refresh', async t => {
  const f = fixture(t);
  const executor = f.build({ reviewSurface: { ...f.reviewSurface, request: args => {
    f.db.prepare(`UPDATE reviewed_prs SET reviewer_head_sha=?, revision_ref=?
      WHERE repo=? AND pr_number=?`).run(head, head, repo, prNumber);
    return f.reviewSurface.request(args);
  } } });
  const result = await executor.tick(subject, { observedAt: at(100), load });
  assert.equal(result.reason, 'verdict-at-requested-head');
  assert.equal(f.requests.length, 0);
  assert.equal(f.intents().length, 0);
  assert.equal(f.row().review_status, 'posted');
  assert.equal(f.row().reviewer_head_sha, head);
});

test('two live executors share one request and the rootDir composition uses the existing API', async t => {
  const f = fixture(t);
  const one = f.build({ rootDir: f.rootDir, reviewSurface: undefined, holder: 'fixture-one' });
  const two = f.build({ rootDir: f.rootDir, reviewSurface: undefined, holder: 'fixture-two' });
  await Promise.all([one.tick(subject, { observedAt: at(100), load }),
    two.tick(subject, { observedAt: at(100), load })]);
  assert.equal(f.intents().length, 1);
  assert.equal(f.intents()[0].state, 'pending');
});

test('head movement cancels an accepted pending request through the existing watcher lifecycle', async t => {
  const f = fixture(t);
  await f.tick();
  f.setLive({ state: 'open', head: movedHead, sourceRef: 'fixture:moved' });
  f.append('revision_advanced', { revisionRef: movedHead });
  await reconcileExplicitReviewIntents(f.db, { repo, prNumber, headSha: movedHead,
    now: at(200), notify: async () => {} });
  await f.tick();
  assert.equal(f.requests.length, 1);
  assert.equal(f.intents()[0].state, 'refused');
  assert.equal(f.intents()[0].reason, 'head-changed');
});

for (const [name, change] of [
  ['builder head', job => ({ ...job, completion: {} })],
  ['unspent budget', job => ({ ...job, remediationPlan: { currentRound: 3, maxRounds: 4 } })],
  ['unproven worker push', job => ({ ...job, completion: { ...job.completion, workerPushedHeadSha: oldHead } })],
  ['ordinary re-review already requested', job => ({ ...job, reReview: { ...job.reReview, requested: true } })],
  ['hammer handoff worker', job => ({ ...job, closureHandoff: { reason: 'final-fix-all' } })],
  ['unfinished remediator', job => ({ ...job, status: 'in_progress' })],
]) {
  test(`${name} retains the existing decision without requesting`, async t => {
    const f = fixture(t, change);
    assert.equal(readFinalRemediatorHead({ rootDir: f.rootDir, repo, prNumber, headSha: head }), null);
    assert.notEqual((await f.tick()).action, 'request-reexact-review');
    assert.equal(f.requests.length, 0);
    assert.equal(f.intents().length, 0);
  });
}

test('a verdict at the head leaves the normal path unchanged', async t => {
  const f = fixture(t);
  f.append('verdict_recorded', { revisionRef: head, stageId: 'review', role: 'independent', verdictKind: 'request-changes' });
  assert.equal((await f.tick()).decision.kind, 'remediate');
  assert.equal(f.requests.length, 0);
});

test('the pure decision requires matching subject/head proof and preserves operator holds', t => {
  const f = fixture(t);
  const state = fold(f.ledgerStore.read(subject));
  const proof = readFinalRemediatorHead({ rootDir: f.rootDir, repo, prNumber, headSha: head });
  const decide = (finalRemediatorHead, ownerSnapshot) => eligible(state, {}, {
    observedAt: at(31 * 60 * 1000), load, finalRemediatorHead, ownerSnapshot,
  });
  assert.equal(decide(proof).nextAction, 'request-reexact-review');
  for (const other of [{ ...proof, repo: 'example/other' }, { ...proof, prNumber: 18 },
    { ...proof, headSha: movedHead }, { ...proof, suppressed: false }]) {
    assert.notEqual(decide(other).nextAction, 'request-reexact-review');
  }
  assert.notEqual(decide(proof, { observations: {
    pr: complete({ labels: ['no-merge-hold'] }),
  } }).nextAction, 'request-reexact-review');
});

test('shadow persists would-request decisions on repeated ticks without queueing', t => {
  const f = fixture(t);
  const shadowStore = openFinalizationShadowStore({ db: f.db });
  for (const n of [100, 200]) {
    const snapshot = { subjectKey: subject.subjectExternalId, head, observedAt: at(n), observations: {
      pr: complete({ state: 'open', headSha: head, mergeable: 'MERGEABLE' }),
      reviews: complete({ headSha: oldHead, verdict: 'approved' }),
      checks: complete({ headSha: head, requiredContexts: ['unit'], rollup: [
        { name: 'unit', status: 'COMPLETED', conclusion: 'SUCCESS' },
      ] }),
    } };
    const record = recordLiveShadow({ rootDir: f.rootDir, snapshot, repo, prNumber,
      legacy: { action: 'hammer', reason: 'suppressed-final-push' }, source: 'fixture', shadowStore });
    assert.equal(record.v2Decision.nextAction, 'request-reexact-review');
    assert.ok(record.v2Decision.evidence.includes(`remediation-push:fixture-job:${head}`));
  }
  assert.equal(shadowStore.read().length, 2);
  assert.equal(f.intents().length, 0);
  assert.equal(f.row().review_status, 'posted');
  assert.equal(f.requests.length, 0);
});

test('an operator request and v2 coalesce onto one pending head receipt', async t => {
  const f = fixture(t);
  requestReviewRereview({ rootDir: f.rootDir, db: f.db, repo, prNumber, requestedAt: at(0),
    reason: 'retrigger-review: synthetic request', targetRevisionRef: head, logger: quiet,
    explicitReviewRequest: { requestId: 'fixture-operator-request', actor: 'fixture-operator' } });
  await f.tick();
  assert.equal(f.intents().filter(i => i.state === 'pending').length, 1);
  assert.equal(f.intents().filter(i => i.state === 'coalesced').length, 1);
  assert.equal((await f.tick()).decision.nextAction, 'monitor-review');
  assert.equal(f.requests.length, 1);
});

test('lost acknowledgement replays the API receipt without rearming a consumed review', async t => {
  const f = fixture(t);
  let fail = true;
  const executor = f.build({ reviewSurface: { ...f.reviewSurface, request: async args => {
    const result = await f.reviewSurface.request(args);
    if (fail) { fail = false; throw Error('fixture:lost-ack'); }
    return result;
  } } });
  const tick = () => executor.tick(subject, { observedAt: at(100), load });
  await tick();
  const intent = f.intents()[0];
  f.db.prepare(`UPDATE reviewed_prs SET review_status='reviewing', reviewer_head_sha=?,
    reviewer_session_uuid='fixture-session' WHERE repo=? AND pr_number=?`).run(head, repo, prNumber);
  assert.equal(consumeExplicitReviewIntent(f.db, intent, {
    headSha: head, sessionUuid: 'fixture-session', now: at(100),
  }), true);
  assert.equal((await tick()).status, 'executed');
  assert.equal(f.intents().length, 1);
  assert.equal(f.intents()[0].state, 'consumed');
  assert.equal(f.row().review_status, 'reviewing');
  assert.equal((await tick()).decision.nextAction, 'monitor-review');
});

test('disabled execution and the kill switch cannot queue re-review', async t => {
  const f = fixture(t);
  for (const options of [{ enabled: false }, { policy: { autonomousExecutionDisabled: true } }]) {
    const executor = f.build(options);
    await executor.tick(subject, { observedAt: at(100), load });
  }
  assert.equal(f.requests.length, 0);
  assert.equal(f.intents().length, 0);
});
