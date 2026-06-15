import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveSettledReviewVerdict } from '../src/adversarial-gate-status.mjs';

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
