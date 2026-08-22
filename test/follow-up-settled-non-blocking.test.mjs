// Regression: the non-blocking settled-clean deadlock (agent-os#5671/#5672/#5673).
//
// A comment-only review carrying non-blocking findings was classified here as
// settled-clean, so the follow-up job stopped with "no remediation coding
// session is required". Meanwhile `isEligibleForAmaClosure` refused closure with
// `non-blocking-findings-present`. Nothing remediated, nothing merged, nothing
// escalated — three PRs sat 90-140 minutes with no closer lease ever acquired,
// while every liveness surface stayed green.
//
// `docs/SPEC-merge-authority-v2.md` forbids exactly this: strict_mode (default
// on) routes non-blocking findings to `remediate`, and exhaustion "always closes
// by landing, never by abandoning… never an indefinite wait".
//
// These pin that this module and `src/ama/eligibility.mjs` agree.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyFollowUpCriticality,
  isSettledCleanClassification,
  isSettledReviewJob,
} from '../src/follow-up-jobs.mjs';

const review = ({ verdict, blocking = '- None.', nonBlocking = '- None.' }) => `## Adversarial Review — Gemini

## Summary
Synthetic body for the settled-clean predicate.

## Blocking issues
${blocking}

## Non-blocking issues
${nonBlocking}

## Verdict
${verdict}
`;

const A_NON_BLOCKING_FINDING = `- **Fragile HTML attribute regex**
  - **File:** \`x.mjs\`
  - **Lines:** \`20\`
  - **Problem:** regex too strict.
  - **Why it matters:** silent miss.
  - **Recommended fix:** relax it.`;

const A_BLOCKING_FINDING = `- **Cross-user ownership change**
  - **File:** \`y.mjs\`
  - **Lines:** \`10\`
  - **Problem:** chmod crashes for non-owner.
  - **Why it matters:** permanent break.
  - **Recommended fix:** escalate properly.`;

test('comment-only with NO findings stays settled clean', () => {
  const c = classifyFollowUpCriticality(review({ verdict: 'Comment only' }));
  assert.equal(c.critical, false);
  assert.equal(c.nonBlockingFindingState, 'known');
  assert.equal(c.nonBlockingFindingCount, 0);
  assert.equal(isSettledCleanClassification(c), true);
});

test('comment-only WITH non-blocking findings is NOT settled clean under strict mode', () => {
  const c = classifyFollowUpCriticality(
    review({ verdict: 'Comment only', nonBlocking: A_NON_BLOCKING_FINDING }),
  );
  assert.equal(c.critical, false, 'non-blocking findings must not make it critical');
  assert.equal(c.nonBlockingFindingCount, 1);
  assert.equal(
    isSettledCleanClassification(c),
    false,
    'this is the deadlock: it must owe a remediation round, not stop',
  );
});

test('approved WITH non-blocking findings is NOT settled clean under strict mode', () => {
  const c = classifyFollowUpCriticality(
    review({ verdict: 'Approved', nonBlocking: A_NON_BLOCKING_FINDING }),
  );
  assert.equal(isSettledCleanClassification(c), false);
});

test('strict_mode=false permits settling over known non-blocking findings', () => {
  const c = classifyFollowUpCriticality(
    review({ verdict: 'Comment only', nonBlocking: A_NON_BLOCKING_FINDING }),
  );
  assert.equal(isSettledCleanClassification(c, { strictNonBlockingRemediation: false }), true);
});

test('an unparseable non-blocking section is not settled clean', () => {
  // Mirrors eligibility's `non-blocking-findings-unknown` refusal: unknown must
  // owe a round rather than short-circuit closure.
  const body = `## Adversarial Review\n\n## Blocking issues\n- None.\n\n## Verdict\nComment only\n`;
  const c = classifyFollowUpCriticality(body);
  if (c.nonBlockingFindingState !== 'known') {
    assert.equal(isSettledCleanClassification(c), false);
  } else {
    assert.equal(c.nonBlockingFindingCount, 0);
  }
});

test('request-changes is never settled clean regardless of non-blocking state', () => {
  const c = classifyFollowUpCriticality(
    review({ verdict: 'Request changes', blocking: A_BLOCKING_FINDING }),
  );
  assert.equal(c.critical, true);
  assert.equal(isSettledCleanClassification(c), false);
  assert.equal(isSettledCleanClassification(c, { strictNonBlockingRemediation: false }), false);
});

test('isSettledReviewJob owes a round for a comment-only job with non-blocking findings', () => {
  const job = {
    reviewBody: review({ verdict: 'Comment only', nonBlocking: A_NON_BLOCKING_FINDING }),
  };
  assert.equal(isSettledReviewJob(job), false, 'must not be stopped as settled');
});

test('isSettledReviewJob still settles a genuinely clean comment-only job', () => {
  assert.equal(isSettledReviewJob({ reviewBody: review({ verdict: 'Comment only' }) }), true);
});

test('operator retrigger override still wins over settled classification', () => {
  const job = {
    reviewBody: review({ verdict: 'Comment only' }),
    remediationPlan: { nextAction: { operatorOverride: true } },
  };
  assert.equal(isSettledReviewJob(job), false);
});
