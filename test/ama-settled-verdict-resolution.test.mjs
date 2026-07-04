import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';

import { resolveSettledReviewVerdict } from '../src/adversarial-gate-status.mjs';
import { maybeDispatchAmaCloser } from '../src/ama/dispatch-closer.mjs';
import { isEligibleForAmaClosure } from '../src/ama/eligibility.mjs';
import { DEFAULT_ADVERSARIAL_GATE_CONTEXT } from '../src/adversarial-gate-context.mjs';

const CURRENT_USER = userInfo().username || process.env.USER || process.env.LOGNAME || 'unknown';

// These cover the AMA phantom-column fix: AMA must resolve the verdict +
// remediation-pending from the canonical follow-up-job / review-row body, NOT
// from non-existent reviewed_prs.last_verdict / .remediation_pending columns.

function finder(job) {
  return () => job;
}

test('comment-only verdict from the latest completed follow-up job body is settled-success', () => {
  const res = resolveSettledReviewVerdict('/root', {
    repo: 'acme/agent-os',
    prNumber: 1782,
    reviewRow: { review_status: 'posted' }, // no body column on the row
    latestJobFinder: finder({
      status: 'completed',
      reviewBody: '## Summary\n\nLooks good.\n\n## Verdict\n\nComment only',
    }),
  });
  assert.equal(res.verdict, 'comment-only');
  assert.equal(res.remediationPending, false);
});

test('approved verdict resolves to approved', () => {
  const res = resolveSettledReviewVerdict('/root', {
    repo: 'acme/agent-os',
    prNumber: 1,
    reviewRow: { review_status: 'posted' },
    latestJobFinder: finder({ status: 'completed', reviewBody: '## Verdict\n\nApproved' }),
  });
  assert.equal(res.verdict, 'approved');
  assert.equal(res.remediationPending, false);
});

test('request-changes verdict is NOT settled-success (verdict != comment-only/approved)', () => {
  const res = resolveSettledReviewVerdict('/root', {
    repo: 'acme/agent-os',
    prNumber: 2,
    reviewRow: { review_status: 'posted' },
    latestJobFinder: finder({ status: 'stopped', reviewBody: '## Verdict\n\nRequest changes' }),
  });
  assert.equal(res.verdict, 'request-changes');
  assert.equal(res.remediationPending, false);
});

test('an in-progress remediation is remediation-pending, not settled', () => {
  const res = resolveSettledReviewVerdict('/root', {
    repo: 'acme/agent-os',
    prNumber: 3,
    reviewRow: { review_status: 'posted' },
    latestJobFinder: finder({ status: 'in-progress', reviewBody: '## Verdict\n\nComment only' }),
  });
  assert.equal(res.verdict, '');
  assert.equal(res.remediationPending, true);
});

test('a pending remediation is remediation-pending, not settled', () => {
  const res = resolveSettledReviewVerdict('/root', {
    repo: 'acme/agent-os',
    prNumber: 4,
    reviewRow: { review_status: 'posted' },
    latestJobFinder: finder({ status: 'pending', reviewBody: '## Verdict\n\nApproved' }),
  });
  assert.equal(res.verdict, '');
  assert.equal(res.remediationPending, true);
});

test('a completed job with a queued re-review is remediation-pending, not settled', () => {
  const res = resolveSettledReviewVerdict('/root', {
    repo: 'acme/agent-os',
    prNumber: 5,
    reviewRow: { review_status: 'posted' },
    latestJobFinder: finder({
      status: 'completed',
      reReview: { requested: true },
      reviewBody: '## Verdict\n\nComment only',
    }),
  });
  assert.equal(res.verdict, '');
  assert.equal(res.remediationPending, true);
});

test('falls back to the review-row body when there is no follow-up job', () => {
  const res = resolveSettledReviewVerdict('/root', {
    repo: 'acme/agent-os',
    prNumber: 6,
    reviewRow: { review_status: 'posted', review_body: '## Verdict\n\nComment only' },
    latestJobFinder: finder(null),
  });
  assert.equal(res.verdict, 'comment-only');
  assert.equal(res.remediationPending, false);
});

test('completed latest job with missing body does not fall back to stale settled row verdict', () => {
  const res = resolveSettledReviewVerdict('/root', {
    repo: 'acme/agent-os',
    prNumber: 7,
    reviewRow: { review_body: '## Verdict\n\nComment only' },
    latestJobFinder: finder({ status: 'completed' }),
  });
  assert.equal(res.verdict, '');
  assert.equal(res.remediationPending, false);
});

for (const reviewStatus of ['pending', 'reviewing', 'pending-upstream']) {
  test(`${reviewStatus} review rows do not reuse an old clean body as settled`, () => {
    const res = resolveSettledReviewVerdict('/root', {
      repo: 'acme/agent-os',
      prNumber: 10,
      reviewRow: {
        review_status: reviewStatus,
        review_body: '## Verdict\n\nComment only',
        reviewer_head_sha: 'head-a',
      },
      currentHeadSha: 'head-a',
      latestJobFinder: finder({
        status: 'completed',
        reviewBody: '## Verdict\n\nApproved',
      }),
    });
    assert.equal(res.verdict, '');
    assert.equal(res.remediationPending, false);
    assert.equal(res.reviewedHeadSha, 'head-a');
  });
}

test('posted rows with stale reviewer_head_sha do not resolve settled-success', () => {
  const res = resolveSettledReviewVerdict('/root', {
    repo: 'acme/agent-os',
    prNumber: 11,
    reviewRow: {
      review_status: 'posted',
      review_body: '## Verdict\n\nComment only',
      reviewer_head_sha: 'head-a',
    },
    currentHeadSha: 'head-b',
    latestJobFinder: finder({
      status: 'completed',
      reviewBody: '## Verdict\n\nComment only',
    }),
  });
  assert.equal(res.verdict, '');
  assert.equal(res.remediationPending, false);
  assert.equal(res.reviewedHeadSha, 'head-a');
});

test('older-head follow-up jobs do not block a settled current-head review', () => {
  let seenQuery = null;
  const res = resolveSettledReviewVerdict('/root', {
    repo: 'acme/agent-os',
    prNumber: 12,
    reviewRow: {
      review_status: 'posted',
      review_body: '## Verdict\n\nComment only',
      reviewer_head_sha: 'head-new',
    },
    currentHeadSha: 'head-new',
    latestJobFinder: (rootDir, query) => {
      seenQuery = { rootDir, ...query };
      return !query.revisionRef || query.revisionRef === 'head-old'
        ? { status: 'pending', revisionRef: 'head-old', reviewBody: '## Verdict\n\nRequest changes' }
        : null;
    },
  });
  assert.equal(seenQuery.rootDir, '/root');
  assert.equal(seenQuery.repo, 'acme/agent-os');
  assert.equal(seenQuery.prNumber, 12);
  assert.equal(seenQuery.revisionRef, 'head-new');
  assert.equal(res.verdict, 'comment-only');
  assert.equal(res.remediationPending, false);
  assert.equal(res.reviewedHeadSha, 'head-new');
});

test('completed latest job with blank body does not fall back to stale settled row verdict', () => {
  const res = resolveSettledReviewVerdict('/root', {
    repo: 'acme/agent-os',
    prNumber: 8,
    reviewRow: { review_body: '## Verdict\n\nComment only' },
    latestJobFinder: finder({ status: 'completed', reviewBody: '   \n\t' }),
  });
  assert.equal(res.verdict, '');
  assert.equal(res.remediationPending, false);
});

test('no job and no row body yields empty verdict (not falsely settled)', () => {
  const res = resolveSettledReviewVerdict('/root', {
    repo: 'acme/agent-os',
    prNumber: 9,
    reviewRow: { review_status: 'posted' },
    latestJobFinder: finder(null),
  });
  assert.equal(res.verdict, '');
  assert.equal(res.remediationPending, false);
});

// --- Live-review reconciliation (fail-open guard, #1824 / #1816) ----------
// A completed remediation job's stored comment-only body can be STALE relative
// to a fresh `Request changes` review posted on the SAME head. When the caller
// supplies the live latest review(s) on currentHeadSha, they override the stale
// body and the closer must NOT see settled-success.

const HEAD = 'a'.repeat(40);

test('live Request-changes on head OVERRIDES a stale comment-only job body (the #1824 fail-open)', () => {
  const res = resolveSettledReviewVerdict('/root', {
    repo: 'acme/agent-os',
    prNumber: 1824,
    currentHeadSha: HEAD,
    reviewRow: { review_status: 'posted', reviewer_head_sha: HEAD },
    // Stale job body the closer used to trust:
    latestJobFinder: finder({ status: 'completed', reviewBody: '## Verdict\n\nComment only' }),
    // Live latest review on the same head says Request changes (newest-first):
    liveHeadReview: { resolved: true, bodies: ['## Verdict\n\nRequest changes'] },
  });
  assert.equal(res.verdict, 'request-changes');
  assert.equal(res.remediationPending, false);
});

test('live-review lookup failure fails CLOSED (empty verdict, never settled-success)', () => {
  const res = resolveSettledReviewVerdict('/root', {
    repo: 'acme/agent-os',
    prNumber: 1816,
    currentHeadSha: HEAD,
    reviewRow: { review_status: 'posted', reviewer_head_sha: HEAD },
    latestJobFinder: finder({ status: 'completed', reviewBody: '## Verdict\n\nComment only' }),
    liveHeadReview: { resolved: false },
  });
  assert.equal(res.verdict, '');
  assert.equal(res.remediationPending, false);
});

test('no verdict-bearing live review on the head fails CLOSED', () => {
  const res = resolveSettledReviewVerdict('/root', {
    repo: 'acme/agent-os',
    prNumber: 100,
    currentHeadSha: HEAD,
    reviewRow: { review_status: 'posted', reviewer_head_sha: HEAD },
    latestJobFinder: finder({ status: 'completed', reviewBody: '## Verdict\n\nComment only' }),
    liveHeadReview: { resolved: true, bodies: [] },
  });
  assert.equal(res.verdict, '');
});

test('legit settled-success survives reconciliation (live comment-only on head, the #1792 path)', () => {
  const res = resolveSettledReviewVerdict('/root', {
    repo: 'acme/agent-os',
    prNumber: 1792,
    currentHeadSha: HEAD,
    reviewRow: { review_status: 'posted', reviewer_head_sha: HEAD },
    latestJobFinder: finder({ status: 'completed', reviewBody: '## Verdict\n\nComment only' }),
    liveHeadReview: { resolved: true, bodies: ['## Verdict\n\nComment only'] },
  });
  assert.equal(res.verdict, 'comment-only');
  assert.equal(res.remediationPending, false);
});

test('reconciliation picks the NEWEST verdict-bearing live body (newest-first ordering)', () => {
  const res = resolveSettledReviewVerdict('/root', {
    repo: 'acme/agent-os',
    prNumber: 101,
    currentHeadSha: HEAD,
    reviewRow: { review_status: 'posted', reviewer_head_sha: HEAD },
    latestJobFinder: finder({ status: 'completed', reviewBody: '## Verdict\n\nComment only' }),
    // newest first: a non-verdict comment, then the real newest verdict, then an older one
    liveHeadReview: {
      resolved: true,
      bodies: ['LGTM (no verdict section)', '## Verdict\n\nRequest changes', '## Verdict\n\nComment only'],
    },
  });
  assert.equal(res.verdict, 'request-changes');
});

test('malformed liveHeadReview (missing bodies array) fails CLOSED', () => {
  const res = resolveSettledReviewVerdict('/root', {
    repo: 'acme/agent-os',
    prNumber: 102,
    currentHeadSha: HEAD,
    reviewRow: { review_status: 'posted', reviewer_head_sha: HEAD },
    latestJobFinder: finder({ status: 'completed', reviewBody: '## Verdict\n\nComment only' }),
    liveHeadReview: { resolved: true },
  });
  assert.equal(res.verdict, '');
});

test('omitting liveHeadReview preserves the legacy body-derived behavior (back-compat)', () => {
  const res = resolveSettledReviewVerdict('/root', {
    repo: 'acme/agent-os',
    prNumber: 103,
    currentHeadSha: HEAD,
    reviewRow: { review_status: 'posted', reviewer_head_sha: HEAD },
    latestJobFinder: finder({ status: 'completed', reviewBody: '## Verdict\n\nComment only' }),
  });
  assert.equal(res.verdict, 'comment-only');
});

// --- Blocking-findings classification (agent-os#1856 fail-closed bug) -------
// The AMA closer used to read blocking-findings off the merge-agent dispatch
// job (`dispatchJob.blockingFindingState`), which is computed from the latest
// *follow-up-job* body. A clean `comment-only` review with NO remediation job
// has no such body, so the closer defaulted to `'unknown'` and the eligibility
// predicate emitted `blocking-findings-unknown` -> `eligible: false` -> the
// closer deferred without merging. The classification must instead come from
// the SAME authoritative current-head body the verdict is resolved from.

const REVIEW_BODY = (verdict, blockingSection = null) =>
  `## Summary\nLooks fine.\n\n## Verdict\n\n${verdict}` +
  (blockingSection === null ? '' : `\n\n## Blocking Issues\n\n${blockingSection}`);

test('comment-only + empty `- None.` Blocking Issues section resolves to known: 0 (live head)', () => {
  const res = resolveSettledReviewVerdict('/root', {
    repo: 'acme/agent-os',
    prNumber: 1856,
    currentHeadSha: HEAD,
    reviewRow: { review_status: 'posted', reviewer_head_sha: HEAD },
    latestJobFinder: finder({ status: 'completed', reviewBody: REVIEW_BODY('Comment only', '- None.') }),
    liveHeadReview: { resolved: true, bodies: [REVIEW_BODY('Comment only', '- None.')] },
  });
  assert.equal(res.verdict, 'comment-only');
  assert.equal(res.blockingFindingState, 'known');
  assert.equal(res.blockingFindingCount, 0);
});

test('comment-only with NO Blocking Issues section resolves to known: 0 (live head)', () => {
  const res = resolveSettledReviewVerdict('/root', {
    repo: 'acme/agent-os',
    prNumber: 1857,
    currentHeadSha: HEAD,
    reviewRow: { review_status: 'posted', reviewer_head_sha: HEAD },
    latestJobFinder: finder({ status: 'completed', reviewBody: REVIEW_BODY('Comment only') }),
    liveHeadReview: { resolved: true, bodies: [REVIEW_BODY('Comment only')] },
  });
  assert.equal(res.verdict, 'comment-only');
  assert.equal(res.blockingFindingState, 'known');
  assert.equal(res.blockingFindingCount, 0);
});

test('comment-only with a REAL blocking finding reconciles to request-changes and count >= 1', () => {
  const res = resolveSettledReviewVerdict('/root', {
    repo: 'acme/agent-os',
    prNumber: 1858,
    currentHeadSha: HEAD,
    reviewRow: { review_status: 'posted', reviewer_head_sha: HEAD },
    latestJobFinder: finder({ status: 'completed', reviewBody: REVIEW_BODY('Comment only', '- None.') }),
    liveHeadReview: {
      resolved: true,
      bodies: [REVIEW_BODY('Comment only', '### 1. Null deref in handler\nThis crashes on empty input.\n')],
    },
  });
  assert.equal(res.verdict, 'request-changes');
  assert.equal(res.blockingFindingState, 'known');
  assert.ok(res.blockingFindingCount >= 1, `expected >= 1, got ${res.blockingFindingCount}`);
});

test('live-review lookup failure fails CLOSED on blocking-findings (unknown)', () => {
  const res = resolveSettledReviewVerdict('/root', {
    repo: 'acme/agent-os',
    prNumber: 1859,
    currentHeadSha: HEAD,
    reviewRow: { review_status: 'posted', reviewer_head_sha: HEAD },
    latestJobFinder: finder({ status: 'completed', reviewBody: REVIEW_BODY('Comment only', '- None.') }),
    liveHeadReview: { resolved: false },
  });
  assert.equal(res.verdict, '');
  assert.equal(res.blockingFindingState, 'unknown');
  assert.equal(res.blockingFindingCount, 0);
});

test('no verdict-bearing live body fails CLOSED on blocking-findings (unknown)', () => {
  const res = resolveSettledReviewVerdict('/root', {
    repo: 'acme/agent-os',
    prNumber: 1860,
    currentHeadSha: HEAD,
    reviewRow: { review_status: 'posted', reviewer_head_sha: HEAD },
    latestJobFinder: finder({ status: 'completed', reviewBody: REVIEW_BODY('Comment only', '- None.') }),
    liveHeadReview: { resolved: true, bodies: ['LGTM (no verdict section)'] },
  });
  assert.equal(res.verdict, '');
  assert.equal(res.blockingFindingState, 'unknown');
  assert.equal(res.blockingFindingCount, 0);
});

test('stale reviewer_head_sha fails CLOSED on blocking-findings (unknown)', () => {
  const res = resolveSettledReviewVerdict('/root', {
    repo: 'acme/agent-os',
    prNumber: 1861,
    currentHeadSha: 'b'.repeat(40),
    reviewRow: { review_status: 'posted', reviewer_head_sha: HEAD, review_body: REVIEW_BODY('Comment only', '- None.') },
    latestJobFinder: finder(null),
  });
  assert.equal(res.verdict, '');
  assert.equal(res.blockingFindingState, 'unknown');
});

test('non-posted review row fails CLOSED on blocking-findings (unknown)', () => {
  const res = resolveSettledReviewVerdict('/root', {
    repo: 'acme/agent-os',
    prNumber: 1862,
    reviewRow: { review_status: 'reviewing', review_body: REVIEW_BODY('Comment only', '- None.') },
    latestJobFinder: finder(null),
  });
  assert.equal(res.blockingFindingState, 'unknown');
});

test('remediation-pending fails CLOSED on blocking-findings (unknown)', () => {
  const res = resolveSettledReviewVerdict('/root', {
    repo: 'acme/agent-os',
    prNumber: 1863,
    reviewRow: { review_status: 'posted' },
    latestJobFinder: finder({ status: 'in-progress', reviewBody: REVIEW_BODY('Comment only', '- None.') }),
  });
  assert.equal(res.remediationPending, true);
  assert.equal(res.blockingFindingState, 'unknown');
});

test('back-compat (no liveHeadReview): stored comment-only body classifies known: 0', () => {
  const res = resolveSettledReviewVerdict('/root', {
    repo: 'acme/agent-os',
    prNumber: 1864,
    currentHeadSha: HEAD,
    reviewRow: { review_status: 'posted', reviewer_head_sha: HEAD },
    latestJobFinder: finder({ status: 'completed', reviewBody: REVIEW_BODY('Comment only', '- None.') }),
  });
  assert.equal(res.verdict, 'comment-only');
  assert.equal(res.blockingFindingState, 'known');
  assert.equal(res.blockingFindingCount, 0);
});

// --- End-to-end through the eligibility predicate --------------------------
// The whole point of the fix: a clean comment-only review with an empty
// Blocking Issues section must no longer emit `blocking-findings-unknown`, and
// a real finding / request-changes must STILL be ineligible.

function eligibilityFor(settledReview, { riskClass = 'low' } = {}) {
  const headSha = 'abc12345';
  const reviewState = {
    verdict: settledReview.verdict,
    headSha,
    riskClass,
    remediationPending: settledReview.remediationPending,
    operatorApprovedEvidence: null,
    blockingFindingCount: settledReview.blockingFindingCount,
    blockingFindingState: settledReview.blockingFindingState,
    nonBlockingFindingCount: settledReview.nonBlockingFindingCount,
    nonBlockingFindingState: settledReview.nonBlockingFindingState,
    prAuthor: 'codex-worker-bot',
  };
  const prMetadata = {
    prNumber: 1856,
    headSha,
    isOpen: true,
    isDraft: false,
    mergeableState: 'MERGEABLE',
    labels: [],
    statusCheckRollup: [{ __typename: 'CheckRun', name: 'test', conclusion: 'SUCCESS' }],
    branchProtection: { requiredContexts: [DEFAULT_ADVERSARIAL_GATE_CONTEXT] },
    author: 'codex-worker-bot',
  };
  const cfg = {
    enabled: true,
    workerClass: 'codex',
    mergeMethod: 'squash',
    eligibility: { riskClasses: ['low'] },
    branchProtection: {},
  };
  return isEligibleForAmaClosure(reviewState, prMetadata, cfg, {
    env: { ADV_GATE_STATUS_CONTEXT: DEFAULT_ADVERSARIAL_GATE_CONTEXT },
  });
}

test('E2E: comment-only + empty section no longer emits blocking-findings-unknown', () => {
  const HEAD2 = 'a'.repeat(40);
  const settled = resolveSettledReviewVerdict('/root', {
    repo: 'acme/agent-os',
    prNumber: 1856,
    currentHeadSha: HEAD2,
    reviewRow: { review_status: 'posted', reviewer_head_sha: HEAD2 },
    latestJobFinder: finder({ status: 'completed', reviewBody: REVIEW_BODY('Comment only', '- None.') }),
    liveHeadReview: { resolved: true, bodies: [REVIEW_BODY('Comment only', '- None.')] },
  });
  const result = eligibilityFor(settled);
  assert.ok(
    !result.reasons.includes('blocking-findings-unknown'),
    `unexpected reasons: ${JSON.stringify(result.reasons)}`,
  );
  assert.ok(
    !result.reasons.includes('blocking-findings-present'),
    `unexpected reasons: ${JSON.stringify(result.reasons)}`,
  );
  assert.ok(
    !result.reasons.includes('verdict-not-settled-success'),
    `unexpected reasons: ${JSON.stringify(result.reasons)}`,
  );
  assert.equal(result.eligible, true, `expected eligible, reasons: ${JSON.stringify(result.reasons)}`);
});

test('E2E: settled-success + eligible + clean mergeability dispatches AMA closer', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'ama-settled-clean-dispatch-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));

  const HEAD2 = 'b'.repeat(40);
  const settled = resolveSettledReviewVerdict('/root', {
    repo: 'acme/agent-os',
    prNumber: 2291,
    currentHeadSha: HEAD2,
    reviewRow: { review_status: 'posted', reviewer_head_sha: HEAD2 },
    latestJobFinder: finder({ status: 'completed', reviewBody: REVIEW_BODY('Comment only', '- None.') }),
    liveHeadReview: { resolved: true, bodies: [REVIEW_BODY('Comment only', '- None.')] },
  });
  const reviewState = {
    verdict: settled.verdict,
    headSha: HEAD2,
    riskClass: 'low',
    remediationPending: settled.remediationPending,
    operatorApprovedEvidence: null,
    blockingFindingCount: settled.blockingFindingCount,
    blockingFindingState: settled.blockingFindingState,
    nonBlockingFindingCount: settled.nonBlockingFindingCount,
    nonBlockingFindingState: settled.nonBlockingFindingState,
    prAuthor: 'codex-worker-bot',
  };
  const prMetadata = {
    prNumber: 2291,
    headSha: HEAD2,
    isOpen: true,
    isDraft: false,
    // Watcher normalizes GitHub mergeStateStatus=CLEAN to the eligibility
    // predicate's MERGEABLE state before invoking the closer.
    mergeableState: 'MERGEABLE',
    labels: [],
    statusCheckRollup: [{ __typename: 'CheckRun', name: DEFAULT_ADVERSARIAL_GATE_CONTEXT, conclusion: 'SUCCESS' }],
    branchProtection: { requiredContexts: [DEFAULT_ADVERSARIAL_GATE_CONTEXT] },
    author: 'codex-worker-bot',
  };
  const cfg = {
    enabled: true,
    workerClass: 'codex',
    mergeMethod: 'squash',
    eligibility: { riskClasses: ['low'] },
    branchProtection: {},
  };
  const eligibility = isEligibleForAmaClosure(reviewState, prMetadata, cfg, {
    env: { ADV_GATE_STATUS_CONTEXT: DEFAULT_ADVERSARIAL_GATE_CONTEXT },
  });
  assert.equal(eligibility.eligible, true, JSON.stringify(eligibility.reasons));

  const execCalls = [];
  const result = await maybeDispatchAmaCloser({
    reviewState,
    prMetadata,
    cfg,
    options: { env: { ADV_GATE_STATUS_CONTEXT: DEFAULT_ADVERSARIAL_GATE_CONTEXT } },
    dispatchContext: {
      rootDir,
      repo: 'acme/agent-os',
      prUrl: 'https://github.com/acme/agent-os/pull/2291',
      reviewedSha: HEAD2,
      riskClass: 'low',
      requiredGateContext: DEFAULT_ADVERSARIAL_GATE_CONTEXT,
      reviewedBy: 'codex-reviewer-lacey',
      reviewer: 'codex',
      parentSession: 'session:test:watcher',
      hqProject: 'adversarial-merge-authority',
      hqPath: '/bin/hq-test',
      hqRoot: join(rootDir, 'hq-root'),
      hqOwnerUser: CURRENT_USER,
      currentUser: CURRENT_USER,
      dispatchedAt: '2026-06-21T12:00:00Z',
    },
    execFileImpl: async (cmd, args) => {
      execCalls.push({ cmd, args });
      return { stdout: '{"dispatchId":"dispatch_clean","launchRequestId":"lrq_clean"}', stderr: '' };
    },
    readTemplateImpl: () => 'Close PR {{PR_URL}} at {{REVIEWED_SHA}} with {{MERGE_METHOD}}.',
  });

  assert.equal(result.dispatched, true);
  assert.equal(result.dispatchId, 'dispatch_clean');
  assert.equal(execCalls.length, 1);
  assert.equal(execCalls[0].args[execCalls[0].args.indexOf('--task-kind') + 1], 'merge');
  assert.equal(execCalls[0].args[execCalls[0].args.indexOf('--completion-shape') + 1], 'decision-only');
});

test('E2E: comment-only + real blocking finding stays ineligible (blocking-findings-present)', () => {
  const HEAD2 = 'a'.repeat(40);
  const settled = resolveSettledReviewVerdict('/root', {
    repo: 'acme/agent-os',
    prNumber: 1858,
    currentHeadSha: HEAD2,
    reviewRow: { review_status: 'posted', reviewer_head_sha: HEAD2 },
    latestJobFinder: finder({ status: 'completed', reviewBody: REVIEW_BODY('Comment only', '- None.') }),
    liveHeadReview: {
      resolved: true,
      bodies: [REVIEW_BODY('Comment only', '### 1. Null deref\nCrashes on empty input.\n')],
    },
  });
  const result = eligibilityFor(settled);
  assert.equal(result.eligible, false);
  assert.ok(result.reasons.includes('blocking-findings-present'), JSON.stringify(result.reasons));
});

test('E2E: request-changes stays ineligible (verdict-not-settled-success)', () => {
  const HEAD2 = 'a'.repeat(40);
  const settled = resolveSettledReviewVerdict('/root', {
    repo: 'acme/agent-os',
    prNumber: 1865,
    currentHeadSha: HEAD2,
    reviewRow: { review_status: 'posted', reviewer_head_sha: HEAD2 },
    latestJobFinder: finder({ status: 'stopped', reviewBody: REVIEW_BODY('Request changes') }),
    liveHeadReview: { resolved: true, bodies: [REVIEW_BODY('Request changes')] },
  });
  const result = eligibilityFor(settled);
  assert.equal(result.eligible, false);
  assert.ok(result.reasons.includes('verdict-not-settled-success'), JSON.stringify(result.reasons));
});

test('E2E: live-lookup failure stays ineligible (blocking-findings-unknown, fail-closed)', () => {
  const HEAD2 = 'a'.repeat(40);
  const settled = resolveSettledReviewVerdict('/root', {
    repo: 'acme/agent-os',
    prNumber: 1866,
    currentHeadSha: HEAD2,
    reviewRow: { review_status: 'posted', reviewer_head_sha: HEAD2 },
    latestJobFinder: finder({ status: 'completed', reviewBody: REVIEW_BODY('Comment only', '- None.') }),
    liveHeadReview: { resolved: false },
  });
  const result = eligibilityFor(settled);
  assert.equal(result.eligible, false);
  assert.ok(result.reasons.includes('blocking-findings-unknown'), JSON.stringify(result.reasons));
});
