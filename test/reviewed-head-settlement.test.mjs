import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureReviewStateSchema, forceResetReviewToPending, requestReviewRereview } from '../src/review-state.mjs';
import {
  prepareMarkAttemptStarted,
  prepareMarkPosted,
  prepareReleaseUnsettledPostedReview,
} from '../src/review-state-statements.mjs';
import { settleReviewerAttempt } from '../src/reviewer-spawn-settle.mjs';
import { isEligibleForAmaClosure } from '../src/ama/eligibility.mjs';
import { DEFAULT_ADVERSARIAL_GATE_CONTEXT } from '../src/adversarial-gate-context.mjs';
import { reapRunningPassTimeouts } from '../src/reviewer-pass-reaper.mjs';
import { reconcileReviewerSessions, reviewerBotLoginAliases } from '../src/reviewer-reattach.mjs';
import { reconcilePostedFailedOrphans } from '../src/orphan-post-reconcile.mjs';

const repo = 'example/review-head';
const head = 'a'.repeat(40);
const session = 'synthetic-session';
const startedAt = '2026-01-01T00:00:00.000Z';

function fixture(t) {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(startedAt) });
  const rootDir = mkdtempSync(join(tmpdir(), 'reviewhead-settle-'));
  const db = new Database(':memory:');
  ensureReviewStateSchema(db);
  t.after(() => { db.close(); rmSync(rootDir, { recursive: true, force: true }); });
  db.prepare(`INSERT INTO reviewed_prs (repo, pr_number, reviewed_at, reviewer,
    review_status, revision_ref, review_attempts, infra_auto_recover_attempts,
    review_population_retry_attempts) VALUES (?, 1, ?, 'claude', 'pending', ?, 2, 1, 1)`)
    .run(repo, startedAt, head);
  assert.equal(prepareMarkAttemptStarted(db).run(startedAt, session, head, head,
    600_000, '2026-01-01T00:10:00.000Z', head, repo, 1).changes, 1);
  const statements = {
    markPosted: prepareMarkPosted(db),
    releaseUnsettledPostedReview: prepareReleaseUnsettledPostedReview(db),
    getReviewRow: db.prepare('SELECT * FROM reviewed_prs WHERE repo = ? AND pr_number = ?'),
  };
  const row = () => statements.getReviewRow.get(repo, 1);
  const logs = [];
  const settle = (reviewerHeadSha = head) => settleReviewerAttempt({
    rootDir, repoPath: repo, prNumber: 1, reviewerSessionUuid: session,
    reviewerHeadSha, result: { ok: true, durablePostedAt: Date.now() },
    statements, log: { warn: message => logs.push(message) },
  });
  return { rootDir, db, row, logs, settle };
}

test('REVIEWHEAD-01: an orphan re-review during a pre-spawn claim waits until settlement', t => {
  const { rootDir, db, row, settle } = fixture(t);
  const before = row();
  t.mock.timers.tick(15_000);
  const request = () => requestReviewRereview({ rootDir, db, repo, prNumber: 1,
    requestedAt: new Date().toISOString(), targetRevisionRef: head,
    reason: `system-orphan-head-review:${head}`, ownerlessRecovery: true,
    preserveBudgets: true });
  assert.equal(request().reason, 'review-in-flight');
  assert.deepEqual(row(), before);
  t.mock.timers.tick(59_000);
  db.prepare('UPDATE reviewed_prs SET reviewer_started_at = ?, reviewer_pgid = 42')
    .run(new Date().toISOString());
  t.mock.timers.tick(219_000);
  settle();
  const posted = row();
  assert.equal(posted.review_status, 'posted');
  assert.equal(posted.reviewer_head_sha, head);
  assert.equal(posted.reviewer_session_uuid, session);
  assert.equal(posted.posted_at, new Date().toISOString());
  assert.equal(posted.review_attempts, before.review_attempts + 1);

  const eligibility = isEligibleForAmaClosure({ headSha: posted.reviewer_head_sha,
    verdict: 'comment-only', riskClass: 'low', remediationPending: false,
    blockingFindingCount: 0, blockingFindingState: 'known',
    nonBlockingFindingCount: 0, nonBlockingFindingState: 'known' },
  { headSha: head, isOpen: true, isDraft: false, mergeableState: 'MERGEABLE', labels: [],
    statusCheckRollup: [{ __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }],
    branchProtection: { requiredContexts: [DEFAULT_ADVERSARIAL_GATE_CONTEXT] } },
  { enabled: true, eligibility: { riskClasses: ['low'] }, branchProtection: {} },
  { env: { ADV_GATE_STATUS_CONTEXT: DEFAULT_ADVERSARIAL_GATE_CONTEXT } });
  assert.equal(eligibility.eligible, true, JSON.stringify(eligibility.reasons));

  assert.equal(request().triggered, true);
  assert.equal(row().review_status, 'pending');
  assert.equal(row().revision_ref, head);
  assert.equal(row().rereview_reason, `system-orphan-head-review:${head}`);
});

for (const damage of ['cleared-claim', 'wrong-claim-head', 'missing-reviewed-head']) {
  test(`REVIEWHEAD-01: ${damage} settlement requeues without posting or charging`, t => {
    const { db, row, logs, settle } = fixture(t);
    const liveHead = 'b'.repeat(40);
    if (damage === 'cleared-claim') db.prepare(`UPDATE reviewed_prs SET review_status = 'pending',
      reviewer_session_uuid = NULL, reviewer_head_sha = NULL`).run();
    if (damage === 'wrong-claim-head') db.prepare('UPDATE reviewed_prs SET reviewer_head_sha = ?').run(liveHead);
    db.prepare('UPDATE reviewed_prs SET revision_ref = ?').run(liveHead);
    const before = row();
    settle(damage === 'missing-reviewed-head' ? null : head);
    const after = row();
    assert.equal(after.review_status, 'pending');
    assert.equal(after.posted_at, null);
    assert.equal(after.revision_ref, liveHead);
    assert.equal(after.reviewer_session_uuid, null);
    assert.equal(after.reviewer_head_sha, null);
    assert.equal(after.reviewer_lease_expires_at, null);
    assert.equal(after.review_attempts, before.review_attempts);
    assert.equal(after.infra_auto_recover_attempts, before.infra_auto_recover_attempts);
    assert.equal(after.review_population_retry_attempts, before.review_population_retry_attempts);
    assert.match(logs.join('\n'), /posted-settlement-.*released_to_pending=true/);
  });
}

test('REVIEWHEAD-01: a late success cannot post or release a replacement session', t => {
  const { db, row, logs, settle } = fixture(t);
  db.prepare("UPDATE reviewed_prs SET reviewer_session_uuid = 'synthetic-replacement'").run();
  const before = row();
  settle();
  assert.deepEqual(row(), before);
  assert.match(logs.join('\n'), /posted-settlement-claim-mismatch.*released_to_pending=false/);
});

test('REVIEWHEAD-01: an operator reset without exit proof preserves a pre-spawn claim', t => {
  const { db, rootDir, row } = fixture(t);
  const before = row();
  const result = forceResetReviewToPending({ db, rootDir, repo, prNumber: 1,
    expectedReviewerSessionUuid: session, expectedReviewerPgid: null });
  assert.equal(result.reset, false);
  assert.equal(result.reason, 'review-in-flight');
  assert.deepEqual(row(), before);
});

for (const reviewedHead of [head, null]) {
  test(`REVIEWHEAD-01: artifact recovery records its pass head or requeues (${reviewedHead ? 'known' : 'missing'})`, t => {
    const { db, rootDir, row, logs } = fixture(t);
    db.prepare(`INSERT INTO reviewer_passes (repo, pr_number, attempt_number,
      reviewer_class, reviewer_model, pass_kind, started_at, status, head_sha,
      gh_comment_id, body_captured_at, metadata_json)
      VALUES (?, 1, 1, 'claude', 'claude', 'first-pass', ?, 'running', ?,
        'synthetic-review', ?, ?)`)
      .run(repo, startedAt, reviewedHead, startedAt, JSON.stringify({ reviewerSessionUuid: session }));
    const before = row();
    reapRunningPassTimeouts({ db, rootDir, now: () => new Date(),
      log: { log() {}, warn: message => logs.push(message) },
      queueFollowUpForRecoveredPostedReviewImpl: () => ({ queued: false }) });
    assert.equal(row().review_status, reviewedHead ? 'posted' : 'pending');
    assert.equal(row().reviewer_head_sha, reviewedHead);
    assert.equal(row().review_attempts, before.review_attempts + (reviewedHead ? 1 : 0));
    if (!reviewedHead) {
      assert.equal(row().infra_auto_recover_attempts, before.infra_auto_recover_attempts);
      assert.match(logs.join('\n'), /posted-settlement-unmatched-recovery/);
    }
  });

  test(`REVIEWHEAD-01: reattachment records recovered review head or requeues (${reviewedHead ? 'known' : 'missing'})`, async t => {
    const { db, rootDir, row, logs } = fixture(t);
    db.prepare('UPDATE reviewed_prs SET reviewer_head_sha = NULL, reviewer_started_at = ?, reviewer_pgid = 42')
      .run(startedAt);
    const before = row();
    t.mock.timers.tick(1_200_000);
    await reconcileReviewerSessions({ db, rootDir, now: new Date(),
      log: { log() {}, warn: message => logs.push(message) },
      probeSession: async () => ({ alive: false, matched: false }),
      fetchHeadSha: async () => head,
      fetchLivePrState: async () => ({ state: 'open', merged_at: null, head: { sha: head } }),
      findPostedReview: async () => ({ submitted_at: new Date().toISOString(), commit_id: reviewedHead }),
    });
    assert.equal(row().review_status, reviewedHead ? 'posted' : 'pending');
    assert.equal(row().reviewer_head_sha, reviewedHead);
    assert.equal(row().review_attempts, before.review_attempts + (reviewedHead ? 1 : 0));
    if (!reviewedHead) assert.match(logs.join('\n'), /posted-settlement-unmatched-recovery/);
  });
}

test('REVIEWHEAD-01: a re-review reset during posted-orphan reconciliation cannot recreate a headless posted row', async t => {
  const { db, rootDir, row, logs } = fixture(t);
  db.prepare(`UPDATE reviewed_prs SET review_status = 'failed-orphan', reviewer_started_at = ?`).run(startedAt);
  const before = row();
  await reconcilePostedFailedOrphans({ db, rootDir, apply: true,
    getPull: async () => {
      db.prepare(`UPDATE reviewed_prs SET review_status = 'pending', reviewer_head_sha = NULL,
        reviewer_session_uuid = NULL`).run();
      return { state: 'open', merged_at: null };
    },
    listReviews: async () => [{ id: 'synthetic-review', state: 'COMMENTED', commit_id: head,
      submitted_at: startedAt, user: { login: reviewerBotLoginAliases('claude')[0] } }],
    log: { warn: message => logs.push(message) },
  });
  assert.equal(row().review_status, 'pending');
  assert.equal(row().reviewer_head_sha, null);
  assert.equal(row().revision_ref, head);
  assert.equal(row().review_attempts, before.review_attempts);
  assert.match(logs.join('\n'), /posted-settlement-unmatched-recovery/);
});
