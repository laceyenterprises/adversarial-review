import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPrimaryReversalReviewContext, checkPrimaryChange, fetchPrimaryChange } from '../src/ama/primary-change.mjs';
import { formatPrimaryReversalReviewContext, readPrimaryReversalReview,
  verifyPrimaryReversalReview } from '../src/ama/primary-reversal-review.mjs';
import { consumeExplicitReviewIntent } from '../src/explicit-review-intent.mjs';
import { ensureReviewStateSchema, openReviewStateDb, queuePrimaryReversalReview } from '../src/review-state.mjs';
import { evaluateMergeEligibility } from '../src/ama/merge-eligibility.mjs';
import { buildReviewerExtraContext } from '../src/reviewer-prompt.mjs';
import { primaryChangeFixture } from './helpers/primary-change.mjs';

const headSha = 'c'.repeat(40);
const primaryHead = 'a'.repeat(40);
const mergeBase = 'b'.repeat(40);
const removedAt = 'd'.repeat(40);
const source = { filename: 'src/source.mjs', status: 'modified', additions: 3, deletions: 0,
  patch: '@@ -2,0 +3,3 @@\n+startTimer();\n+\n+return deadline;' };
const destination = { filename: 'src/destination.mjs', status: 'added', additions: 2, deletions: 0,
  patch: '@@ -0,0 +1,2 @@\n+  startTimer();\n+return    deadline;' };
const approved = '## Blocking issues\n- None.\n## Non-blocking issues\n- None.\n## Verdict\nApproved';
const blocking = '## Blocking issues\n- Restore the timer.\n## Non-blocking issues\n- None.\n## Verdict\nRequest changes';
const rejectedCitation = { commit: headSha, review: 'PRR_old', finding: 1, kind: 'blocking', reason: 'lane-commit-provenance' };

function evidence(finalFiles = []) {
  return { ...primaryChangeFixture(headSha), primaryFiles: [source], finalFiles,
    diagnosticCommitRange: [{ sha: removedAt }, { sha: headSha }] };
}

test('reversal prompt context follows the reviewed head even after PR metadata advances', async () => {
  const options = {
    repo: 'fixture/repo',
    prNumber: 7,
    prContext: { headRefOid: removedAt },
    primaryReversalReview: {
      headSha,
      primaryHead,
      regions: [{ file: source.filename, start: 3, end: 5, commit: removedAt }],
    },
    readTenureReviewRangeImpl: () => null,
    readFindingDisputeReservationsImpl: () => [],
    fetchLinkedSpecContentsImpl: async () => '',
    buildHardeningReviewContextImpl: () => '',
    log: null,
  };
  const prompt = await buildReviewerExtraContext({ ...options, reviewedHeadSha: headSha });
  assert.match(prompt, /## Reverted primary-change regions/);
  assert.match(prompt, new RegExp(`src/source.mjs.*3–5.*${removedAt}`));
  for (const reviewedHeadSha of [removedAt, null]) {
    const otherPrompt = await buildReviewerExtraContext({ ...options, reviewedHeadSha });
    assert.doesNotMatch(otherPrompt, /## Reverted primary-change regions/);
  }
});

test('a later cross-file move preserves the normalized region', () => {
  assert.equal(checkPrimaryChange(evidence([destination]), headSha).ok, true);
  for (const change of [
    { ...destination, filename: 'test/destination.test.mjs' },
    { ...destination, patch: '@@ -0,0 +1,2 @@\n+return deadline;\n+startTimer();' },
    { ...destination, patch: '@@ -0,0 +1,2 @@\n+startTimer();\n+return tomorrow;' },
  ]) assert.equal(checkPrimaryChange(evidence([change]), headSha).reason, 'primary-change-reverted');
  assert.equal(checkPrimaryChange({ ...evidence([destination]), primaryFiles: [source, destination] },
    headSha).reason, 'primary-change-reverted');
});

async function runReplay(t, { body, rejected = [] }) {
  const rootDir = mkdtempSync(join(tmpdir(), 'primary-reversal-review-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const repo = 'fixture/repo', prNumber = 7;
  const args = { rootDir, repo, prNumber, headSha, signal: new AbortController().signal };
  const review = { id: 12, node_id: 'PRR_fixture', commit_id: headSha,
    user: { login: 'lacey-claude-reviewer[bot]' }, state: body === approved ? 'APPROVED' : 'CHANGES_REQUESTED', body };
  const primary = { sha: primaryHead, parents: [{ sha: mergeBase }], commit: { message: 'Add timer' } };
  const remove = { sha: removedAt, parents: [{ sha: primaryHead }],
    commit: { message: 'Remove timer\n\nWorker-Class: hammer' } };
  const later = { sha: headSha, parents: [{ sha: removedAt }], commit: { message: 'Follow-up' } };
  const previousReview = { ...review, id: 11, node_id: 'PRR_previous' };
  let reviews = [previousReview];
  const get = async path => {
    if (path.endsWith('/reviews?per_page=100')) return reviews;
    if (path.endsWith('/pulls/7')) return { base: { sha: mergeBase }, head: { sha: headSha } };
    if (path.includes('/compare/')) {
      const [, to] = path.split('...');
      if (to === primaryHead) return { merge_base_commit: { sha: mergeBase }, files: [source] };
      if (to === removedAt) return { merge_base_commit: { sha: mergeBase }, files: [] };
      if (to === headSha) return { merge_base_commit: { sha: mergeBase }, files: [],
        commits: [primary, remove, later], total_commits: 3 };
    }
    if (path.includes('/commits/')) return { ...remove, files: [] };
    throw new Error(`Unexpected synthetic read ${path}`);
  };
  const collect = () => fetchPrimaryChange({ ...args, get }, { fetchCiCostImpl: async () => ({ ok: true, headSha }) });
  const original = { ...await collect(), rejectedReversalAuthorizations: rejected };
  const refusal = checkPrimaryChange(original, headSha);
  assert.equal(refusal.reason, 'primary-change-reverted');
  assert.deepEqual(refusal.missingEvidence.rejected, rejected);
  const context = await buildPrimaryReversalReviewContext({ ...args, get }, original);
  assert.deepEqual(context.regions, [{ file: source.filename, start: 3, end: 5, commit: removedAt }]);
  assert.match(formatPrimaryReversalReviewContext(context, headSha), /## Reverted primary-change regions/);
  assert.match(formatPrimaryReversalReviewContext(context, headSha), new RegExp(`src/source.mjs.*3–5.*${removedAt}`));
  assert.equal(formatPrimaryReversalReviewContext(context, primaryHead), '');

  const db = openReviewStateDb(rootDir);
  t.after(() => db.close());
  ensureReviewStateSchema(db);
  db.prepare(`INSERT INTO reviewed_prs (repo, pr_number, pr_state, review_status, revision_ref, review_attempts, reviewed_at, reviewer)
    VALUES (?, ?, 'open', 'posted', ?, 4, CURRENT_TIMESTAMP, 'claude')`).run(repo, prNumber, headSha);
  const request = queuePrimaryReversalReview({ ...args, db, context });
  assert.equal(request.triggered, true);
  assert.equal(request.reviewRow.review_attempts, 4);
  assert.equal(readPrimaryReversalReview(rootDir, args).state, 'pending');
  assert.equal(readPrimaryReversalReview(join(rootDir, 'unused'), { ...args, db }).state, 'pending');
  assert.equal(db.open, true);
  const sessionUuid = 'fixture-review';
  db.prepare(`UPDATE reviewed_prs SET review_status='reviewing', reviewer_head_sha=?, reviewer_session_uuid=?`).run(headSha, sessionUuid);
  assert.equal(consumeExplicitReviewIntent(db, request.explicitReviewIntent, { headSha, sessionUuid }), true);
  assert.equal(readPrimaryReversalReview(rootDir, args).state, 'pending');
  db.prepare(`INSERT INTO reviewer_passes (repo, pr_number, attempt_number, pass_kind, reviewer_class, status, head_sha, gh_comment_id, metadata_json, started_at)
    VALUES (?, ?, 5, 'rereview', 'claude', 'completed', ?, ?, ?, CURRENT_TIMESTAMP)`).run(repo, prNumber, headSha, review.node_id,
    JSON.stringify({ primaryReversalReview: context.scope, reviewerSessionUuid: sessionUuid }));
  db.prepare(`UPDATE reviewed_prs SET review_status='posted'`).run();
  assert.equal(checkPrimaryChange(await collect(), headSha).reason, 'primary-change-reverted', 'a previously posted clean review has no authority');
  reviews = [previousReview, review];
  const refreshed = await collect();
  const replay = queuePrimaryReversalReview({ ...args, db, context });
  assert.equal(replay.triggered, false);
  assert.equal(replay.reason, 'explicit-review-request-consumed');
  const receipt = readPrimaryReversalReview(rootDir, { ...args, db });
  assert.deepEqual(receipt, readPrimaryReversalReview(rootDir, args));
  assert.equal(db.open, true);
  return { refreshed, review, receipt };
}

test('a provenance rejection requests one contextual review and returns its verified authorization to merge eligibility', async t => {
  const { refreshed, review, receipt } = await runReplay(t, { body: approved, rejected: [rejectedCitation] });
  const result = evaluateMergeEligibility({ primaryChange: refreshed, candidateHead: headSha, validatedHead: headSha,
    verdict: 'settled-success', requiredChecks: true, leaseHeld: true, mergeable: true, branchProtectionRequired: false, labels: [] });
  assert.equal(result.eligible, true, JSON.stringify(result));
  assert.equal(result.reversalAuthorization.authorization, `Reversal-Authorized-By: ${review.node_id} head=${headSha}`);
  assert.equal(checkPrimaryChange(refreshed, removedAt).ok, false);
  const changedScope = { ...refreshed, primaryFiles: [source, { ...source, filename: 'src/second.mjs' }] };
  assert.equal(checkPrimaryChange(changedScope, headSha).reason, 'primary-change-reverted');
  for (const invalid of [{ ...review, commit_id: removedAt }, { ...review, state: 'DISMISSED' },
    { ...review, user: { login: 'builder' } }, { ...review, body: '## Verdict\nApproved' }]) {
    assert.equal(verifyPrimaryReversalReview(receipt, [invalid]), null);
  }
});

test('a silent revert receives blocking findings for normal remediation and stays ineligible', async t => {
  const { refreshed } = await runReplay(t, { body: blocking });
  const refusal = checkPrimaryChange(refreshed, headSha);
  assert.equal(refusal.reason, 'primary-change-reverted');
  assert.equal(refusal.reversalReview.state, 'remediation');
  assert.equal(refusal.reversalAuthorization, undefined);
});
