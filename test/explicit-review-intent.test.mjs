import './helpers/rate-limit-state-isolation.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureReviewStateSchema, openReviewStateDb, requestReviewRereview } from '../src/review-state.mjs';
import { pendingExplicitReviewIntent, consumeExplicitReviewIntent, reconcileExplicitReviewIntents,
  explicitReviewRefusalBody, refuseFailedExplicitReviewDispatch } from '../src/explicit-review-intent.mjs';
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
  assert.equal(Date.parse(intent.expires_at) - Date.parse(intent.requested_at), 900_000);
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

test('RETRIGGERDEDUP-01: request replay and coalescing preserve the deadline across restart', t => {
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
  ['expiry', {}, 'reviewer-unavailable-before-dispatch-deadline'],
  ['head move', { headSha: 'b'.repeat(40) }, 'head-changed'],
  ['terminal', { terminal: true }, 'pr-terminal'],
]) test(`RETRIGGERDEDUP-01: ${kind} persists refusal and retries visible delivery`, async t => {
  const f = fixture(t);
  f.request();
  const intent = f.intent(), notices = [];
  const options = { repo, prNumber, now: kind === 'expiry' ? intent.expires_at : intent.requested_at, ...extra, logger: quiet };
  await reconcileExplicitReviewIntents(f.db, { ...options, notify: async () => { throw new Error('synthetic outage'); } });
  f.restart();
  for (let i = 0; i < 2; i++) await reconcileExplicitReviewIntents(f.db, {
    ...options, notify: async receipt => notices.push(explicitReviewRefusalBody(receipt)),
  });
  assert.equal(notices.length, 1);
  assert.match(notices[0], new RegExp(expected));
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
  assert.equal(accepted.detail, 'explicit re-review queued within the bounded dispatch window');
});
