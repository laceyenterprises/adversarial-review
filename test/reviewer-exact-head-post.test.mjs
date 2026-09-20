import assert from 'node:assert/strict';
import test from 'node:test';

import { exactHeadReviewEventForBody } from '../src/reviewer-exact-head-post.mjs';

function reviewBody({ blocking = '- None.', nonBlocking = '- None.', verdict = 'Comment only' } = {}) {
  return [
    '## Summary',
    'Review complete.',
    '',
    '## Blocking issues',
    blocking,
    '',
    '## Non-blocking issues',
    nonBlocking,
    '',
    '## Verdict',
    verdict,
  ].join('\n');
}

test('zero-finding comment-only review submits APPROVE', () => {
  assert.equal(exactHeadReviewEventForBody(reviewBody()), 'APPROVE');
});

test('comment-only review with a non-blocking finding stays COMMENT', () => {
  assert.equal(exactHeadReviewEventForBody(reviewBody({
    nonBlocking: '- **Keep the boundary**\n  - **Problem:** A real finding remains.',
  })), 'COMMENT');
});

test('blocking finding stays REQUEST_CHANGES', () => {
  assert.equal(exactHeadReviewEventForBody(reviewBody({
    blocking: '- **Unsafe merge**\n  - **Problem:** A blocker remains.',
    verdict: 'Request changes',
  })), 'REQUEST_CHANGES');
});

test('missing finding sections fail closed as COMMENT', () => {
  assert.equal(exactHeadReviewEventForBody('## Verdict\nComment only'), 'COMMENT');
});
