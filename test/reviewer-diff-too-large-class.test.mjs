import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DIFF_TOO_LARGE_FAILURE_CLASS,
  classifyReviewerFailure,
} from '../src/adapters/reviewer-runtime/cli-direct/classification.mjs';

// Verbatim from agent-os#5707's recorded failure_message.
const REAL_5707 = `[reviewer] DEBUG: fetching diff for laceyenterprises/agent-os#5707...
[reviewer] Failed to fetch diff for laceyenterprises/agent-os#5707: Command failed: gh pr diff 5707 --repo laceyenterprises/agent-os
could not find pull request diff: HTTP 406: Sorry, the diff exceeded the maximum number of lines (20000) (https://api.github.com/repos/laceyenterprises/agent-os/pulls/5707)
PullRequest.diff too_large`;

test('a diff over the GitHub API cap is classified, not left unknown', () => {
  // Regression for 2026-08-23. agent-os#5707 (+57 -33224 across 145 files,
  // ~33k lines) failed four first-pass attempts -- gemini x3, claude x1 --
  // every one at 0 minutes with this exact text, each recorded as `unknown`.
  // No retry can succeed: the diff size is a property of the PR, not a
  // transient condition. Classifying it `unknown` spent the whole review
  // budget on an impossible operation and left the operator with
  // "[unknown] Command failed with code 1" to act on.
  assert.equal(classifyReviewerFailure(REAL_5707, 1), DIFF_TOO_LARGE_FAILURE_CLASS);
  assert.equal(DIFF_TOO_LARGE_FAILURE_CLASS, 'diff-too-large');
});

test('the 406 arm requires diff-size context, not any 406', () => {
  // A bare 406 from some unrelated endpoint must not be swallowed into this
  // class; the guard is deliberately conjunctive.
  assert.notEqual(
    classifyReviewerFailure('HTTP 406: Not Acceptable', 1),
    DIFF_TOO_LARGE_FAILURE_CLASS,
  );
});

test('unrelated failures keep their existing classes', () => {
  // The new branch sits immediately before the `unknown` fallthrough, so it
  // must not shadow any earlier, more specific classification.
  assert.equal(
    classifyReviewerFailure('user can only have one pending review per pull request', 1),
    'pending-review-leak',
  );
  assert.equal(classifyReviewerFailure('TypeError: x is not a function', 1), 'bug');
  assert.equal(classifyReviewerFailure('something else entirely', 1), 'unknown');
});
