import test from 'node:test';
import assert from 'node:assert/strict';
import { recoverOwnerlessReview } from '../src/ownerproof-review-recovery.mjs';

function fixture(overrides = {}) {
  const calls = [];
  const args = { rootDir: '/fixture', repo: 'example/repo', prNumber: 8085,
    reviewStateRow: { review_status: 'pending', revision_ref: 'old', review_attempts: 100 }, enabled: true,
    fetchCandidateImpl: async () => ({ prState: 'open', headSha: 'live', labels: [] }),
    fetchReviewsImpl: async () => [],
    recoverImpl: async input => { calls.push(input); return { outcome: 'ama-pending' }; }, ...overrides };
  return { calls, args };
}
test('spent pending review reaches watchdog before retry admission', async () => {
  const { calls, args } = fixture();
  await recoverOwnerlessReview(args);
  assert.equal(calls.length, 1); assert.equal(calls[0].headSha, 'live');
  assert.equal(calls[0].result.ownerProofFacts.reviewedHeadSha, null);
});
for (const prState of ['closed', 'merged']) test(`live ${prState} cancels stale pending recovery`, async () => {
  const { calls, args } = fixture({ fetchCandidateImpl: async () => ({ headSha: 'live', prState }) });
  await recoverOwnerlessReview(args); assert.equal(calls.length, 0);
});
test('posted rows use closure watchdog and disabled authority does not add reads', async () => {
  for (const overrides of [{ enabled: false }, { reviewStateRow: { review_status: 'posted' } }]) {
    const { args, calls } = fixture({ ...overrides, fetchCandidateImpl: () => assert.fail('no extra read') });
    await recoverOwnerlessReview(args); assert.equal(calls.length, 0);
  }
});
test('current-head review and live conflict/check state reach the watchdog', async () => {
  const { args, calls } = fixture({
    fetchCandidateImpl: async () => ({ headSha: 'live', prState: 'open', labels: [], mergeable: 'CONFLICTING', statusCheckRollup: [{ conclusion: 'FAILURE' }] }),
    fetchReviewsImpl: async () => ['## Verdict\nComment only'],
  });
  await recoverOwnerlessReview(args);
  assert.equal(calls[0].result.ownerProofFacts.verdict, 'comment-only');
  assert.equal(calls[0].result.ownerProofFacts.mergeable, 'CONFLICTING');
});
