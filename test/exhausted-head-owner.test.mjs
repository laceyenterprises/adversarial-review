import './helpers/registry-session-fixture.mjs';
import './helpers/dispatch-files-preload.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { admitExhaustedHeadVerdict, isExhaustedHeadVerdictRequested } from '../src/exhausted-head-verdict.mjs';
import { closureOwnerShadowEvidence } from '../src/pr-next-action-consumer.mjs';
import { deriveNextActionSnapshot, nextAction } from '../src/pr-next-action.mjs';
import { evaluateHammerRetryCap } from '../src/ama/hammer-retry-cap.mjs';
import { escalateClosureBudget } from '../src/ama/closure-budget-escalation.mjs';
import { terminalHammerReviewCycleExhausted } from '../src/ama/dispatch-closer.mjs';
import { observeClosureWait } from '../src/ama/closure-wait.mjs';
import { __test__ as reviewer } from '../src/reviewer.mjs';
import { queueFollowUpForRecoveredPostedReview } from '../src/reviewer-pass-reaper.mjs';

const old = 'a'.repeat(40), head = 'b'.repeat(40), newer = 'c'.repeat(40);
const now = '2026-01-01T12:00:00.000Z';
const complete = value => ({ state: 'complete', value });
function decision({ reviewedHead = old, verdict = 'comment-only', findings = 1, lifetime = false, spent = true, deliveredReviews = 0 } = {}) {
  const input = { currentHead: head, deliveredReviews, reviewState: { headSha: reviewedHead, verdict,
    reviewCycleExhausted: true, blockingFindingState: 'known', blockingFindingCount: 0,
    nonBlockingFindingState: 'known', nonBlockingFindingCount: findings, postedAt: now },
  reviewCeilingReached: true, roundsLeft: false, retryExhausted: spent, lifetimeExhausted: lifetime,
  lease: null, followUpJob: null, checks: 'SUCCESS', strictMode: true };
  const evidence = closureOwnerShadowEvidence(input, { subjectKey: 'example/review#1', observedAt: now,
    autonomousMergeExecutionEnabled: true, candidate: { headSha: head, prState: 'OPEN', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' } });
  evidence.observations.launches = { closer: null };
  evidence.observations.controls = {};
  const snapshot = { subjectKey: evidence.subjectKey, head, observedAt: now, anchors: {},
    observations: Object.fromEntries(Object.entries(evidence.observations).filter(([, value]) => value !== undefined).map(([key, value]) => [key, complete(value)])) };
  return nextAction(snapshot);
}

test('EXHAUSTEDHEADOWNER-01: one admitted verdict per builder head, including repeated ticks and returning commits', async () => {
  let row = { reviewer_head_sha: old, revision_ref: old, review_status: 'posted' };
  const delivered = new Set(), launches = [];
  const admit = async (liveHead, closer = false) => {
    row = await admitExhaustedHeadVerdict({ exhausted: true, headSha: liveHead, row,
      countDelivered: () => Number(delivered.has(liveHead)), classifyCloser: async () => ({ suppressed: closer }),
      request: args => { launches.push(liveHead); row = { ...row, revision_ref: liveHead,
        rereview_requested_at: now, rereview_reason: args.reason, review_status: 'pending' }; }, readRow: () => row });
  };
  await admit(head); await admit(head);
  assert.equal(isExhaustedHeadVerdictRequested(row, head), true);
  delivered.add(head); row = { reviewer_head_sha: head, revision_ref: head, review_status: 'posted' };
  await admit(newer); await admit(newer);
  delivered.add(newer); row = { reviewer_head_sha: newer, revision_ref: newer, review_status: 'posted' };
  await admit(head); await admit(old, true);
  await admitExhaustedHeadVerdict({ exhausted: true, lifetimeExhausted: true, headSha: old, row,
    countDelivered: () => 0, classifyCloser: () => assert.fail('lifetime stop must not admit another review'),
    request: () => assert.fail('lifetime stop must select escalation'), readRow: () => row });
  assert.deepEqual(launches, [head, newer]);
  assert.deepEqual([decision().action, decision().actor], ['review', 'reviewer']);
});

test('returning to a delivered commit keeps closure and watcher ownership aligned', () => {
  const result = decision({ deliveredReviews: 1 });
  assert.deepEqual([result.action, result.actor, result.reason], ['hammer', 'hammer', 'review-ceiling']);
});

test('verdict-only live and recovered reviews never enqueue a remediation round', () => {
  const fail = () => { throw new Error('must not create or inspect remediation'); };
  assert.equal(reviewer.queueFollowUpForPostedReview({ verdictOnly: true, baseBranch: 'main', reviewText: 'Verdict: Comment only',
    summarizePRRemediationLedgerImpl: fail }).reason, 'exhausted-head-verdict-only');
  assert.equal(queueFollowUpForRecoveredPostedReview({ row: { metadata_json: '{"verdictOnly":true}',
    body_md: 'Verdict: Comment only', status: 'completed', gh_comment_id: 'fixture-review' },
    reviewRow: {}, summarizePRRemediationLedgerImpl: fail }).reason, 'exhausted-head-verdict-only');
});

test('fresh exact-head verdict routes findings to hammer, clean strict verdict to daemon; same-head and lifetime caps remain', () => {
  const ledger = { jobKey: old, suppressed: true, capRecordedAt: now };
  assert.equal(evaluateHammerRetryCap(ledger, { jobKey: head, headSha: head }).capExhausted, false);
  const findings = decision({ reviewedHead: head, spent: false });
  assert.deepEqual([findings.action, findings.actor], ['hammer', 'hammer']);
  for (const verdict of ['comment-only', 'request-changes']) assert.equal(terminalHammerReviewCycleExhausted({
    reviewCycleExhausted: true, verdict, remediationPending: false, completedRemediationRounds: 2,
  }), true, 'the existing terminal arming gate accepts the final verdict');
  const clean = decision({ reviewedHead: head, verdict: 'approved', findings: 0, spent: false });
  assert.equal(clean.action, 'daemon-merge');
  assert.equal(decision({ reviewedHead: head }).reason, 'retry-exhausted');
  assert.equal(decision({ lifetime: true }).reason, 'lifetime-exhausted');
});

test('head changes drop old deadlines; a lifetime stop has one named page across heads', async () => {
  const base = { head: old, observedAt: now, anchors: { postedAt: '2025-01-01T00:00:00Z' }, observations: {} };
  assert.deepEqual(deriveNextActionSnapshot({ base, head }).anchors, {});
  const rootDir = mkdtempSync(join(tmpdir(), 'exhausted-owner-'));
  let pages = 0;
  try {
    for (const liveHead of [head, head, newer]) {
      const result = await escalateClosureBudget({ rootDir, repo: 'example/review', prNumber: 1,
        now: Date.parse(now), result: { nextAction: { ...decision({ lifetime: true }), head: liveHead } },
        observeWaitImpl: args => observeClosureWait({ ...args, pageImpl: async () => { pages++; } }) });
      assert.equal(result.needsOperator, true);
      assert.equal(result.operatorReason, 'closure-lifetime-exhausted');
    }
    assert.equal(pages, 1);
  } finally { rmSync(rootDir, { recursive: true, force: true }); }
});
