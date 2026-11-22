import './helpers/load-aware-timeout-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureReviewStateSchema, openReviewStateDb, requestReviewRereview } from '../src/review-state.mjs';
import { pendingExplicitReviewIntent, consumeExplicitReviewIntent, reconcileExplicitReviewIntents,
  explicitReviewRefusalBody, refuseFailedExplicitReviewDispatch, requeueUnstartedExplicitReviewDispatch,
  recordExplicitReviewIntent, remediationReviewRequest, priorityReviewIntent, handoffAutomaticReview,
  disputedFindingsReviewRequest, isDisputedFindingsReviewIntent } from '../src/explicit-review-intent.mjs';
import { routeCappedReviewToClosure } from '../src/hamclose-review-admission.mjs';
import { closeoutRereview, remediationCloseout } from '../src/remediation-closeout.mjs';
import { deriveNextActionSnapshot } from '../src/pr-next-action.mjs';
import { resolveAlreadyReviewedHeadDedup, createHeadDispatchLease } from '../src/reviewed-head-dispatch-gate.mjs';
import { tryRetriggerReviewFromLabel } from '../src/follow-up-retrigger-review-label.mjs';
import { applyLivePackCrossEditReview, evaluateLivePackCrossEdits } from '../src/live-pack-cross-edit.mjs';
import { classifyOperatorGatedFindings } from '../src/ama/operator-label-gates.mjs';
import { isEligibleForAmaClosure } from '../src/ama/eligibility.mjs';
import { recoverAmaAutomation } from '../src/ama/automated-recovery.mjs';
import { matrixPair, clean, OLD } from './helpers/next-action-matrix.mjs';
import { DEFAULT_ADVERSARIAL_GATE_CONTEXT } from '../src/adversarial-gate-context.mjs';
import { main as retriggerReview } from '../src/retrigger-review.mjs';

const repo = 'example/review-fixture', prNumber = 71, headSha = 'a'.repeat(40);
const quiet = { log() {}, warn() {}, error() {} };
for (const requestKey of ['request_id', 'requestId']) {
  for (const headKey of ['head_sha', 'headSha']) {
    test(`LAC-2315: dispute intent matches exact identity using ${requestKey}/${headKey}`, () => {
      const request = disputedFindingsReviewRequest(headSha);
      const intent = { actor: request.actor, [requestKey]: request.requestId, [headKey]: headSha };
      assert.equal(isDisputedFindingsReviewIntent(intent, headSha), true);
      assert.equal(isDisputedFindingsReviewIntent({ ...intent, actor: 'remediation-watch' }, headSha), false);
      assert.equal(isDisputedFindingsReviewIntent({ ...intent, [requestKey]: 'other-request' }, headSha), false);
      assert.equal(isDisputedFindingsReviewIntent({ ...intent, [headKey]: 'b'.repeat(40) }, headSha), false);
    });
  }
}

test('LAC-2315: dispute intent normalization preserves database identity precedence', () => {
  const request = disputedFindingsReviewRequest(headSha);
  const intent = { ...request, headSha };
  assert.equal(isDisputedFindingsReviewIntent(null, headSha), false);
  assert.equal(isDisputedFindingsReviewIntent({ actor: request.actor }, headSha), false);
  assert.equal(isDisputedFindingsReviewIntent({ ...intent, request_id: null, head_sha: null }, headSha), true);
  assert.equal(isDisputedFindingsReviewIntent({ ...intent, request_id: 'other-request' }, headSha), false);
  assert.equal(isDisputedFindingsReviewIntent({ ...intent, head_sha: 'b'.repeat(40) }, headSha), false);
});

function fixture(t) {
  const rootDir = mkdtempSync(join(tmpdir(), 'explicit-review-intent-'));
  let db = openReviewStateDb(rootDir);
  ensureReviewStateSchema(db);
  db.prepare(`INSERT INTO reviewed_prs (repo, pr_number, reviewed_at, reviewer,
    review_status, pr_state, revision_ref, reviewer_head_sha, posted_at)
    VALUES (?, ?, ?, 'claude', 'posted', 'open', ?, ?, ?)`)
    .run(repo, prNumber, new Date().toISOString(), headSha, headSha, new Date().toISOString());
  t.after(() => { db.close(); rmSync(rootDir, { recursive: true, force: true }); });
  return { rootDir, get db() { return db; }, restart() { db.close(); db = openReviewStateDb(rootDir); ensureReviewStateSchema(db); },
    request(options = {}) { return requestReviewRereview({ rootDir, db, repo, prNumber,
      targetRevisionRef: headSha, reason: 'retrigger-review: synthetic request',
      explicitReviewRequest: { requestId: 'request-one', actor: 'fixture-operator' }, ...options }); },
    intent(now) { return pendingExplicitReviewIntent(db, { repo, prNumber, headSha, ...(now ? { now } : {}) }); },
  };
}
const dedup = intent => resolveAlreadyReviewedHeadDedup({ repoPath: repo, prNumber, headSha,
  explicitReviewIntent: intent, fetchReviewsForHeadImpl: async () => [{ id: 'fixture-review', submittedAt: '2026-01-01T00:00:00Z' }] });
function claimAndConsume(f, intent, sessionUuid = 'fixture-session') {
  f.db.prepare(`UPDATE reviewed_prs SET review_status = 'reviewing', reviewer_session_uuid = ?,
    reviewer_head_sha = ? WHERE repo = ? AND pr_number = ? AND review_status = 'pending'`)
    .run(sessionUuid, headSha, repo, prNumber);
  return f.db.transaction(() => consumeExplicitReviewIntent(f.db, intent, { headSha, sessionUuid })).immediate();
}

test('RETRIGGERDEDUP-01: CLI accepts the existing row head and creates a request receipt', async t => {
  const f = fixture(t);
  const errors = [];
  const result = await retriggerReview(['--root-dir', f.rootDir, '--audit-root-dir', f.rootDir,
    '--repo', repo, '--pr', String(prNumber), '--reason', 'synthetic retry', '--no-bump-budget'], {
    stdout: { write() {} }, stderr: { write: text => errors.push(text) },
    fetchCurrentHeadShaImpl: async () => headSha,
  });
  assert.equal(result, 0, errors.join(''));
  assert.equal(f.intent().head_sha, headSha);
});

test('RETRIGGERDEDUP-01: a durable same-head request consumes once under its claim and lease', async t => {
  const f = fixture(t);
  assert.equal((await dedup(null)).alreadyReviewed, true);
  assert.equal(f.request().triggered, true);
  const intent = f.intent();
  assert.equal(intent.actor, 'fixture-operator');
  assert.ok(Date.parse(intent.expires_at) - Date.parse(intent.requested_at) >= 900_000);
  assert.equal((await dedup(intent)).reason, 'explicit-review-intent');
  assert.equal(consumeExplicitReviewIntent(f.db, intent, { headSha, sessionUuid: 'no-claim' }), false);
  const lease = createHeadDispatchLease(), key = `${repo}#${prNumber}@${headSha}`;
  assert.equal(lease.tryAcquire(key), true);
  assert.equal(lease.tryAcquire(key), false);
  assert.equal(claimAndConsume(f, intent), true);
  assert.equal(claimAndConsume(f, intent), false);
  assert.equal(f.intent(), undefined);
  assert.equal((await dedup(f.intent())).alreadyReviewed, true);
  assert.equal(f.request().reason, 'explicit-review-request-consumed');
  lease.release(key);
});

test('RETRIGGERDEDUP-01: request replay and coalescing preserve the waiting threshold across restart', t => {
  const f = fixture(t);
  f.request();
  const original = f.intent();
  f.request({ explicitReviewRequest: { requestId: 'request-two', actor: 'fixture-rescue' } });
  f.restart();
  assert.deepEqual(f.intent(), original);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM explicit_review_intents WHERE state = 'pending'").get().n, 1);
  assert.equal(f.request().status, 'already-pending');
  assert.equal(f.request({ explicitReviewRequest: { requestId: 'request-two', actor: 'fixture-rescue' } }).status, 'already-pending');
  assert.equal(f.intent().expires_at, original.expires_at);
  assert.equal(f.request({ targetRevisionRef: 'b'.repeat(40) }).reason, 'explicit-review-request-identity-mismatch');
  assert.equal(f.request({ explicitReviewRequest: { requestId: 'request-one', actor: 'other-actor' } }).reason,
    'explicit-review-request-identity-mismatch');
});

const finalReview = '## Blocking issues\n- None.\n\n## Non-blocking issues\n- An unresolved finding.\n\n## Verdict\nComment only';
const witnessOld = 'b'.repeat(40);
const reviewedAt = '2026-11-20T22:29:53.000Z';
const completedAt = '2026-11-20T22:50:00.000Z';

function remediationAdmissionFixture(t, { reviewBody = finalReview, delivery = 'completed', pending = false,
  passes = 3, completedRoundTimestamps } = {}) {
  const f = fixture(t);
  f.db.prepare(`UPDATE reviewed_prs SET reviewer='gemini', review_status=?, revision_ref=?,
    reviewer_head_sha=?, posted_at=?, review_attempts=6, failed_at=? WHERE repo=? AND pr_number=?`)
    .run(pending ? 'pending' : delivery === 'failed' ? 'failed' : 'posted',
      pending ? headSha : witnessOld, pending ? null : witnessOld,
      delivery === 'completed' && !pending ? reviewedAt : null,
      delivery === 'failed' ? reviewedAt : null, repo, prNumber);
  const insert = f.db.prepare(`INSERT INTO reviewer_passes(repo,pr_number,attempt_number,reviewer_class,pass_kind,
    started_at,ended_at,status,head_sha,gh_comment_id,body_md) VALUES (?,?,?,'gemini',?,?,?,?,?,?,?)`);
  for (let i = 1; i <= passes; i++) {
    insert.run(repo, prNumber, i, i === 1 ? 'first-pass' : 'rereview',
      reviewedAt, reviewedAt, delivery, witnessOld, delivery === 'completed' ? `review-${i}` : null,
      delivery === 'completed' ? reviewBody : null);
  }
  const job = { jobId: 'example__review-fixture-pr-71-ci-only', repo, prNumber, reviewBody,
    revisionRef: witnessOld, remediationPlan: { currentRound: 6, maxRounds: 2 } };
  const closeout = remediationCloseout({ rootDir: f.rootDir, job, completedAt, headSha,
    ciGate: { headSha, state: 'green' }, snapshot: deriveNextActionSnapshot({ observations: {
      launches: { closer: null }, leases: { closer: null }, policy: { autonomousMergeExecutionEnabled: true },
    } }) });
  const completionRequest = closeoutRereview(closeout, 'retrigger-review: the CI patch is ready');
  const queue = () => f.request({ explicitReviewRequest: remediationReviewRequest(job.jobId, 2),
    reason: completionRequest.reason, requestedAt: completedAt });
  const row = () => f.db.prepare('SELECT * FROM reviewed_prs WHERE repo=? AND pr_number=?').get(repo, prNumber);
  const handoff = (observed = row()) => routeCappedReviewToClosure({ db: f.db, repo, prNumber, headSha,
    row: observed, ceiling: 3, roundBudget: 2, completedRoundTimestamps, logger: quiet });
  return { ...f, completionRequest, queue, row, handoff };
}

for (const pending of [false, true]) test(`CI-only worker completion reaches capped closeout (already pending: ${pending})`, async t => {
  const f = remediationAdmissionFixture(t, { pending });
  assert.equal(f.completionRequest.requested, true, 'completion without publication proof requests review admission');
  assert.equal(f.queue().status, pending ? 'already-pending' : 'pending');
  const workerIntent = f.intent();
  assert.equal(workerIntent.actor, 'remediation-watch');
  assert.equal(priorityReviewIntent(workerIntent), null);
  assert.doesNotMatch(f.row().rereview_reason || '', /^retrigger-review:/u);
  assert.equal((await dedup(workerIntent)).alreadyReviewed, true);
  assert.equal(f.handoff(), true);
  assert.equal(f.row().review_status, 'posted');
  assert.equal(f.row().reviewer_head_sha, witnessOld, 'restore the reviewed head, never certify the CI patch');
  assert.equal(f.row().review_attempts, 6);
  assert.equal(f.intent(), undefined);
  assert.equal(f.queue().reason, 'explicit-review-request-refused');
});

test('capped admission preserves ci-blocked failed-check context for CIBLOCKHAM', t => {
  const f = remediationAdmissionFixture(t);
  f.queue();
  f.db.prepare(`UPDATE reviewed_prs SET review_status='ci-blocked', failed_at=?,
    failure_message='[ci-regression-no-job] unit failed' WHERE repo=? AND pr_number=?`)
    .run(completedAt, repo, prNumber);
  const before = f.row(), receipt = f.intent();
  assert.equal(f.handoff(), false);
  assert.deepEqual(f.row(), before);
  assert.deepEqual(f.intent(), receipt);
});

test('automatic handoff rolls back receipt settlement and row writes on a failed comparison or exception', t => {
  const f = remediationAdmissionFixture(t);
  f.queue();
  const before = f.row(), receipt = f.intent();
  const handoff = callback => handoffAutomaticReview(f.db, { repo, prNumber, headSha }, 'fixture-handoff', callback);
  const write = () => f.db.prepare("UPDATE reviewed_prs SET review_status='posted' WHERE repo=? AND pr_number=?")
    .run(repo, prNumber);
  assert.equal(handoff(() => { write(); return false; }), false);
  assert.deepEqual(f.row(), before);
  assert.deepEqual(f.intent(), receipt);
  assert.throws(() => handoff(() => { write(); throw new Error('fixture failure'); }), /fixture failure/);
  assert.deepEqual(f.row(), before);
  assert.deepEqual(f.intent(), receipt);
});

for (const humanFirst of [false, true]) test(`exact-head operator request wins coalescing (operator first: ${humanFirst})`, async t => {
  const f = remediationAdmissionFixture(t, { pending: true });
  const operator = () => f.request();
  humanFirst ? operator() : f.queue();
  const before = f.intent();
  const observed = f.row();
  humanFirst ? f.queue() : operator();
  const intent = f.intent();
  assert.equal(intent.actor, 'fixture-operator');
  assert.equal(intent.expires_at, before.expires_at);
  assert.equal(f.handoff(observed), false);
  assert.equal((await dedup(priorityReviewIntent(intent))).reason, 'explicit-review-intent');
  assert.match(f.row().rereview_reason, /^retrigger-review:/u);
  assert.equal(claimAndConsume(f, intent), true);
  assert.equal(f.queue().reason, 'explicit-review-request-consumed');
});

for (const [name, options] of [
  ['below the delivered ceiling', { passes: 1 }],
  ['missing the first review', { passes: 0, pending: true }],
  ['failed initial review', { delivery: 'failed' }],
  ['unreadable verdict', { reviewBody: 'Incomplete output' }],
  ['blocking verdict', { reviewBody: finalReview.replace('Comment only', 'Request changes') }],
]) test(`worker admission still owes review ${name}`, t => {
  const f = remediationAdmissionFixture(t, options);
  assert.equal(f.queue().explicitReviewIntent.actor, 'remediation-watch');
  assert.equal(f.handoff(), false);
  assert.equal(f.row().review_status, 'pending');
  assert.equal(claimAndConsume(f, f.intent()), true);
});

test('capped completion retains the live reviewing claim', t => {
  const f = remediationAdmissionFixture(t);
  f.queue();
  const observed = f.row();
  assert.equal(claimAndConsume(f, f.intent()), true);
  assert.equal(f.handoff(observed), false);
  assert.equal(f.row().review_status, 'reviewing');
});

test('worker completion coalesces without resetting an operator CI hold', t => {
  const f = remediationAdmissionFixture(t);
  f.request();
  f.db.prepare("UPDATE reviewed_prs SET review_status = 'ci-blocked'").run();
  const held = f.row();
  assert.equal(f.queue().status, 'already-pending');
  assert.deepEqual(f.row(), held);
  assert.equal(f.intent().actor, 'fixture-operator');
});

test('a delivered post-budget final pass requires no redundant review below the hard ceiling', t => {
  const f = remediationAdmissionFixture(t, { passes: 2,
    completedRoundTimestamps: [
      { round: 2, terminalAt: '2026-11-20T22:00:00.000Z' },
      { round: 6, terminalAt: completedAt },
    ] });
  f.queue();
  assert.equal(f.handoff(), true);
  assert.equal(f.row().reviewer_head_sha, witnessOld);
  assert.equal(f.handoff(), true, 'a later poll retains the same exact-head ownership');
});

test('RETRIGGERDEDUP-01: a failed dispatch reports refusal without rearming a consumed request', async t => {
  const f = fixture(t);
  f.request();
  const intent = f.intent();
  assert.equal(claimAndConsume(f, intent), true);
  assert.equal(refuseFailedExplicitReviewDispatch(f.db, intent, 'other-session'), false);
  assert.equal(refuseFailedExplicitReviewDispatch(f.db, intent, 'fixture-session'), true);
  f.restart();
  const notices = [];
  await reconcileExplicitReviewIntents(f.db, { repo, prNumber, headSha,
    notify: async receipt => notices.push(explicitReviewRefusalBody(receipt)) });
  assert.match(notices[0], /reviewer-dispatch-failed/);
  assert.equal(f.request().status, 'blocked');
  assert.equal((await dedup(f.intent())).alreadyReviewed, true);
});

for (const [kind, extra, expected] of [
  ['head move', { headSha: 'b'.repeat(40) }, 'head-changed'],
  ['terminal', { terminal: true }, 'pr-terminal'],
]) test(`RETRIGGERDEDUP-01: ${kind} persists refusal and retries visible delivery`, async t => {
  const f = fixture(t);
  f.request();
  const intent = f.intent(), notices = [];
  const options = { repo, prNumber, now: intent.requested_at, ...extra, logger: quiet };
  await reconcileExplicitReviewIntents(f.db, { ...options, notify: async () => { throw new Error('synthetic outage'); } });
  f.restart();
  for (let i = 0; i < 2; i++) await reconcileExplicitReviewIntents(f.db, {
    ...options, notify: async receipt => notices.push(explicitReviewRefusalBody(receipt)),
  });
  assert.equal(notices.length, 1);
  assert.match(notices[0], new RegExp(expected));
  assert.doesNotMatch(notices[0], /retrigger-review|re-apply/);
  assert.equal(f.intent(), undefined);
});

test('RETRIGGERDEDUP-01: different heads cannot spend the request and refused resets create no intent', async t => {
  const f = fixture(t);
  f.request();
  const intent = f.intent();
  assert.equal((await dedup({ ...intent, head_sha: 'b'.repeat(40) })).alreadyReviewed, true);
  f.db.prepare("UPDATE reviewed_prs SET review_status = 'reviewing'").run();
  assert.equal(f.request({ explicitReviewRequest: { requestId: 'other', actor: 'fixture-operator' } }).reason, 'review-in-flight');
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM explicit_review_intents').get().n, 1);
});

test('RETRIGGERDEDUP-01: accepted waiver-label re-review produces a clean audited review and normal AMA eligibility', async t => {
  const f = fixture(t);
  const diff = 'diff --git a/projects/sample-pack/SPEC.md b/projects/sample-pack/SPEC.md\n--- a/projects/sample-pack/SPEC.md\n+++ b/projects/sample-pack/SPEC.md\n@@ -1 +1 @@\n-old\n+new\n';
  const text = '## Blocking issues\n- None.\n\n## Non-blocking issues\n- None.\n\n## Verdict\nApproved\n';
  const review = labels => applyLivePackCrossEditReview(text, { repo, prNumber, diff, labels, reviewerHeadSha: headSha,
    prContext: { title: '[codex] SAMPLE-02: fixture', baseRefName: 'main' }, log: quiet,
    evaluateImpl: args => evaluateLivePackCrossEdits({ ...args,
      fetchFileAtRefImpl: async () => JSON.stringify({ planId: 'synthetic-plan', tickets: [{ id: 'SAMPLE-01' }] }),
      readActiveDagRunsImpl: async () => ({ ok: true, runs: [{ run_id: 'synthetic-run', state: 'running' }] }),
    }),
  });
  const oldBody = await review([]);
  assert.equal(classifyOperatorGatedFindings(oldBody).allGated, true);
  const calls = [];
  const accepted = await tryRetriggerReviewFromLabel({ rootDir: f.rootDir, repo, prNumber, revisionRef: headSha,
    labelActor: 'fixture-operator', labelEvent: { id: 'fixture-label-event', actor: 'fixture-operator', createdAt: new Date().toISOString() },
    execFileImpl: async (_file, args) => { calls.push(args); return { stdout: '', stderr: '' }; },
    appendAuditRow() {}, findAuditRow() { return null; }, logger: quiet });
  assert.equal(accepted.rereviewResult.triggered, true);
  assert.equal((await dedup(f.intent())).alreadyReviewed, false);
  assert.equal(claimAndConsume(f, f.intent()), true);
  const body = await review(['live-pack-edit-approved']);
  assert.equal(classifyOperatorGatedFindings(oldBody).allGated, true, 'label never rewrites historical findings');
  assert.equal(classifyOperatorGatedFindings(body).gated.length, 0);
  assert.match(body, /Operator waiver observed by this fresh review.*live-pack-edit-approved/);
  const state = { verdict: 'approved', headSha, riskClass: 'low', remediationPending: false,
    blockingFindingCount: 0, blockingFindingState: 'known', nonBlockingFindingCount: 0,
    nonBlockingFindingState: 'known', prAuthor: 'fixture-builder', reviewerFamily: 'claude' };
  const metadata = { prNumber, headSha, isOpen: true, isDraft: false, mergeableState: 'MERGEABLE',
    labels: ['live-pack-edit-approved'], statusCheckRollup: [{ name: 'fixture-ci', conclusion: 'SUCCESS' }],
    branchProtection: { requiredContexts: [DEFAULT_ADVERSARIAL_GATE_CONTEXT] }, author: 'fixture-builder' };
  const config = { enabled: true, workerClass: 'codex', eligibility: { riskClasses: ['low'] }, branchProtection: {} };
  assert.equal(isEligibleForAmaClosure(state, metadata, config).eligible, true, JSON.stringify(isEligibleForAmaClosure(state, metadata, config)));
  assert.equal((await dedup(f.intent())).alreadyReviewed, true);
  assert.ok(calls.some(args => args.includes('--remove-label')));
});

test('RETRIGGERDEDUP-01: the rescue rereview mutation records the same durable intent once', async t => {
  const f = fixture(t);
  const shared = matrixPair({ reviews: { ...clean, headSha: OLD } });
  const run = () => recoverAmaAutomation({ rootDir: f.rootDir, repo, prNumber, headSha: shared.decision.head,
    result: { nextAction: shared.decision }, reviewStateRow: { review_status: 'posted', posted_at: 'fixture-review' },
    requestRereviewImpl: options => f.request({ ...options, targetRevisionRef: headSha }),
    dispatchHammer: async () => assert.fail('review recovery cannot merge'), pageImpl: async () => assert.fail('no page expected'),
    logger: quiet });
  await run();
  await run();
  assert.equal(f.intent().actor, 'merge-agent-rescue');
  assert.match(f.intent().request_id, /^ama-rescue:/);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM explicit_review_intents').get().n, 1);
  assert.equal((await dedup(f.intent())).alreadyReviewed, false);
  assert.equal(claimAndConsume(f, f.intent()), true);
});

test('RETRIGGERDEDUP-01: a label coalescing onto a pending intent reports a queued retrigger', async t => {
  const f = fixture(t);
  assert.equal(f.request().triggered, true);
  const accepted = await tryRetriggerReviewFromLabel({ rootDir: f.rootDir, repo, prNumber, revisionRef: headSha,
    labelActor: 'fixture-operator', labelEvent: { id: 'fixture-coalesced-event', actor: 'fixture-operator', createdAt: new Date().toISOString() },
    execFileImpl: async () => ({ stdout: '', stderr: '' }), appendAuditRow() {}, findAuditRow() { return null; }, logger: quiet });
  assert.equal(accepted.rereviewResult.status, 'already-pending');
  assert.equal(accepted.rereviewResult.explicitReviewIntent.request_id, 'request-one');
  assert.equal(accepted.outcome, 'review-retriggered');
  assert.equal(accepted.detail, 'explicit re-review queued; capacity waits retry automatically');
});


test('REREVIEWDEFER-01: overdue capacity wait survives restart, coalesces, notifies once and consumes once', async t => {
  const f = fixture(t);
  f.request();
  f.db.prepare("UPDATE explicit_review_intents SET requested_at='2026-01-01T00:00:00Z', expires_at='2026-01-01T00:15:00Z'").run();
  const notices = [];
  const options = { repo, prNumber, headSha, now: '2026-01-02T00:00:00Z', logger: quiet };
  await reconcileExplicitReviewIntents(f.db, { ...options, notify: async () => { throw new Error('synthetic outage'); } });
  f.restart();
  for (let tick = 0; tick < 3; tick++) await reconcileExplicitReviewIntents(f.db, {
    ...options, notify: async intent => notices.push(explicitReviewRefusalBody(intent)),
  });
  assert.equal(notices.length, 1);
  assert.match(notices[0], /Re-review queued/);
  assert.match(notices[0], /busy since 2026-01-01T00:00:00Z/);
  assert.doesNotMatch(notices[0], /retrigger-review|re-apply|could not run/);
  assert.equal(f.request().status, 'already-pending');
  f.request({ explicitReviewRequest: { requestId: 'after-long-wait', actor: 'fixture-operator' } });
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM explicit_review_intents WHERE state='pending'").get().n, 1);
  assert.equal((await dedup(f.intent())).alreadyReviewed, false);
  assert.equal(claimAndConsume(f, f.intent()), true);
  assert.equal(f.intent(), undefined);
  assert.equal((await dedup(f.intent())).alreadyReviewed, true);
});

test('REREVIEWDEFER-01: positively unstarted launches return only their own consumed intent', t => {
  const f = fixture(t);
  f.request();
  const intent = f.intent();
  assert.equal(claimAndConsume(f, intent), true);
  assert.equal(requeueUnstartedExplicitReviewDispatch(f.db, intent, 'other-session'), false);
  f.db.prepare("UPDATE reviewed_prs SET reviewer_session_uuid = 'newer-session'").run();
  assert.equal(requeueUnstartedExplicitReviewDispatch(f.db, intent, 'fixture-session'), false);
  f.db.prepare("UPDATE reviewed_prs SET reviewer_session_uuid = 'fixture-session'").run();
  assert.equal(requeueUnstartedExplicitReviewDispatch(f.db, intent, 'fixture-session'), true);
  assert.equal(f.intent().state, 'pending');
  assert.equal(requeueUnstartedExplicitReviewDispatch(f.db, intent, 'fixture-session'), false);
});

test('REREVIEWDEFER-01: waiting observation scales with load without becoming an expiry', async t => {
  const f = fixture(t);
  const requestedAt = '2026-01-01T00:00:00Z';
  const intent = recordExplicitReviewIntent(f.db, { repo, prNumber, headSha,
    requestId: 'load-fixture', actor: 'fixture', requestedAt,
    waitOptions: { loadAvg1m: 12, cpuCount: 4, cpuBusyPercent: 85,
      enabled: true, maxMultiplier: 6 },
  });
  assert.equal(Date.parse(intent.expires_at) - Date.parse(requestedAt), 5_400_000);
  const notices = [];
  const run = now => reconcileExplicitReviewIntents(f.db, { repo, prNumber, headSha,
    now, notify: async receipt => notices.push(explicitReviewRefusalBody(receipt)) });
  await run('2026-01-01T00:16:00Z');
  assert.equal(notices.length, 0);
  await run('2026-01-01T01:30:00Z');
  assert.equal(notices.length, 1);
  assert.equal(f.intent().state, 'pending');
  await reconcileExplicitReviewIntents(f.db, { repo, prNumber, headSha,
    terminal: true, now: '2026-01-01T02:00:00Z',
    notify: async receipt => notices.push(explicitReviewRefusalBody(receipt)) });
  assert.equal(notices.length, 2, 'waiting delivery must not suppress terminal delivery');
  assert.match(notices[1], /pr-terminal/);
  assert.doesNotMatch(notices[1], /retrigger-review|re-apply/);
});
