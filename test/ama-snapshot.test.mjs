import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildAmaPrMetadata,
  buildAmaReviewSnapshotFromCloserInputs,
  buildAmaReviewStateFromDispatchJob,
} from '../src/ama/snapshot.mjs';

test('buildAmaReviewStateFromDispatchJob carries blocker state from the dispatch job', () => {
  const reviewState = buildAmaReviewStateFromDispatchJob({
    dispatchJob: {
      headSha: 'abc123',
      riskClass: 'low',
      lastVerdict: 'approved',
      blockingFindingCount: 0,
      blockingFindingState: 'known',
      prAuthor: 'lacey',
    },
    remediationPending: false,
    operatorApprovalEvent: {
      headSha: 'abc123',
      actor: 'operator',
      id: 'evt_1',
      createdAt: '2026-06-11T20:00:00Z',
    },
  });
  assert.equal(reviewState.blockingFindingCount, 0);
  assert.equal(reviewState.blockingFindingState, 'known');
  assert.equal(reviewState.operatorApprovedEvidence.eventId, 'evt_1');
});

test('buildAmaReviewSnapshotFromCloserInputs reconstructs blocker and override state from reviews + timeline', () => {
  const { reviewState, options } = buildAmaReviewSnapshotFromCloserInputs({
    reviewsJson: {
      reviews: [
        {
          state: 'COMMENTED',
          body: '## Blocking Issues\n\n- None.\n',
          submittedAt: '2026-06-11T20:00:00Z',
          commit: { oid: 'abc123' },
          author: { login: 'claude-reviewer-lacey' },
        },
      ],
    },
    prJson: {
      author: { login: 'lacey' },
    },
    timelineJson: [
      {
        event: 'labeled',
        label: { name: 'operator-approved' },
        commit_id: 'abc123',
        actor: { login: 'operator' },
        id: 101,
        created_at: '2026-06-11T20:01:00Z',
      },
      {
        event: 'labeled',
        label: { name: 'adversarial-merge-requested' },
        commit_id: 'abc123',
        actor: { login: 'operator' },
        id: 102,
        created_at: '2026-06-11T20:02:00Z',
      },
    ],
    reviewedSha: 'abc123',
    riskClass: 'critical',
  });
  assert.equal(reviewState.verdict, 'comment-only');
  assert.equal(reviewState.blockingFindingCount, 0);
  assert.equal(reviewState.blockingFindingState, 'known');
  assert.equal(reviewState.remediationPending, false);
  assert.equal(reviewState.operatorApprovedEvidence.eventId, 101);
  assert.equal(options.adversarialMergeRequested.eventId, 102);
});

test('buildAmaReviewSnapshotFromCloserInputs fails closed when reviews exist only for an older head', () => {
  const { reviewState } = buildAmaReviewSnapshotFromCloserInputs({
    reviewsJson: {
      reviews: [
        {
          state: 'APPROVED',
          body: '## Blocking Issues\n\n- None.\n',
          submittedAt: '2026-06-11T20:00:00Z',
          commit: { oid: 'old-head' },
          author: { login: 'claude-reviewer-lacey' },
        },
      ],
    },
    prJson: {
      author: { login: 'lacey' },
    },
    timelineJson: [],
    reviewedSha: 'new-head',
    riskClass: 'low',
  });
  assert.equal(reviewState.verdict, '');
  assert.equal(reviewState.headSha, 'new-head');
  assert.equal(reviewState.remediationPending, true);
  assert.equal(reviewState.blockingFindingState, 'unknown');
});

test('buildAmaPrMetadata normalizes live PR inputs into the eligibility shape', () => {
  const metadata = buildAmaPrMetadata({
    prNumber: 12,
    headSha: 'def456',
    prState: 'open',
    mergeableState: 'mergeable',
    labels: ['operator-approved'],
    statusCheckRollup: [{ name: 'ci', conclusion: 'SUCCESS' }],
    requiredContexts: ['agent-os/adversarial-gate'],
    author: 'lacey',
  });
  assert.equal(metadata.isOpen, true);
  assert.equal(metadata.mergeableState, 'MERGEABLE');
  assert.deepEqual(metadata.branchProtection.requiredContexts, ['agent-os/adversarial-gate']);
});
