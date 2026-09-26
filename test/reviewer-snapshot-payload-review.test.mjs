import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeEffectiveReviewVerdict } from '../src/kernel/verdict.mjs';
import { __test__ as reviewerTest } from '../src/reviewer.mjs';
import { ReviewerSnapshotPayloadError } from '../src/reviewer-workspace.mjs';

test('snapshot payload validation formats a blocking request-changes review', () => {
  const body = reviewerTest.formatReviewerSnapshotPayloadReview({
    repo: 'laceyenterprises/adversarial-review',
    prNumber: 1129,
    headSha: '0123456789abcdef0123456789abcdef01234567',
    error: new ReviewerSnapshotPayloadError('snapshot contains link escaping its root: escape -> /tmp/secret', {
      linkPath: 'escape',
      linkTarget: '/tmp/secret',
      headSha: '0123456789abcdef0123456789abcdef01234567',
    }),
  });

  assert.match(body, /^## Summary/);
  assert.match(body, /- \*\*Unsafe symlink escapes reviewer snapshot\*\*/);
  assert.match(body, /## Non-blocking issues\n- None\./);
  assert.equal(normalizeEffectiveReviewVerdict(body), 'request-changes');
});
