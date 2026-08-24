import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_COMMENT_ONLY_HAMMER_TERMINAL_MS,
  isHammerRemediableEligibilityMiss,
} from '../src/ama/dispatch-closer.mjs';

// HMR-01. A settled comment-only PR could never reach the hammer at all:
//   - its only miss is a strict non-blocking refusal, which is NOT in
//     HAMMER_AUTO_REMEDIABLE_MISS_REASONS (that set is pr-not-mergeable /
//     ci-not-green only);
//   - the exhaustion branch cannot rescue it, because
//     reviewCycleExhaustedFromRounds needs completed remediation/re-review
//     rounds to reach the budget, and a comment-only verdict spawns NO
//     remediation rounds. The counter stays at 0 forever.
//
// Observed 2026-08-24: five PRs simultaneously terminal_but_unmerged with
// verdict=comment-only (#5845 #5846 #5847 #5851 #5854), all logging
// "AMA hammer route retained ownership: not-eligible".

const GRACE = DEFAULT_COMMENT_ONLY_HAMMER_TERMINAL_MS;
const NB = ['non-blocking-findings-present'];
const NB_UNKNOWN = ['non-blocking-findings-unknown', 'verdict-not-settled-success'];
const ZERO_FINDINGS = ['verdict-not-settled-success'];

test('the pre-existing behaviour is unchanged when no duration is supplied', () => {
  // Every existing caller passes no duration; they must be unaffected.
  assert.equal(isHammerRemediableEligibilityMiss(NB, {}), false);
  assert.equal(isHammerRemediableEligibilityMiss(NB, { reviewCycleExhausted: false }), false);
});

test('a FRESH comment-only verdict does not get a hammer', () => {
  // Codex-first, Hammer-last: no firing the moment the verdict settles.
  assert.equal(
    isHammerRemediableEligibilityMiss(NB, { settledCommentOnlyTerminalMs: 0 }),
    false,
  );
  assert.equal(
    isHammerRemediableEligibilityMiss(NB, { settledCommentOnlyTerminalMs: GRACE - 1 }),
    false,
  );
});

test('a comment-only PR terminal past the grace becomes hammer-eligible', () => {
  assert.equal(
    isHammerRemediableEligibilityMiss(NB, { settledCommentOnlyTerminalMs: GRACE }),
    true,
  );
  assert.equal(
    isHammerRemediableEligibilityMiss(NB, { settledCommentOnlyTerminalMs: GRACE * 7 }),
    true,
  );
});

test('a comment-only PR with unknown non-blocking state past the grace becomes hammer-eligible', () => {
  assert.equal(
    isHammerRemediableEligibilityMiss(NB_UNKNOWN, { settledCommentOnlyTerminalMs: GRACE }),
    true,
  );
});

test('a clean zero-finding comment-only PR terminal past the grace becomes hammer-eligible', () => {
  assert.equal(
    isHammerRemediableEligibilityMiss(ZERO_FINDINGS, { settledCommentOnlyTerminalMs: GRACE - 1 }),
    false,
  );
  assert.equal(
    isHammerRemediableEligibilityMiss(ZERO_FINDINGS, { settledCommentOnlyTerminalMs: GRACE }),
    true,
  );
});

test('a co-occurring BLOCKING finding still parks — the safety invariant', () => {
  // This is the line that must not move: blocking findings go through the
  // Codex remediation lane, never straight to an auto-hammer.
  assert.equal(
    isHammerRemediableEligibilityMiss(
      ['non-blocking-findings-present', 'blocking-findings-present'],
      { settledCommentOnlyTerminalMs: GRACE * 10 },
    ),
    false,
  );
});

test('a stale review head still parks even past the grace', () => {
  assert.equal(
    isHammerRemediableEligibilityMiss(
      ['non-blocking-findings-present', 'stale-review-head'],
      { settledCommentOnlyTerminalMs: GRACE * 10 },
    ),
    false,
  );
});

test('the grace is overridable', () => {
  assert.equal(
    isHammerRemediableEligibilityMiss(NB, {
      settledCommentOnlyTerminalMs: 1_000,
      commentOnlyTerminalGraceMs: 500,
    }),
    true,
  );
});

test('a bare verdict miss is inert without a measured comment-only terminal duration', () => {
  // Upstream supplies a duration only for settled comment-only verdicts.
  assert.equal(
    isHammerRemediableEligibilityMiss(ZERO_FINDINGS, {}),
    false,
  );
  assert.equal(
    isHammerRemediableEligibilityMiss(ZERO_FINDINGS, { settledCommentOnlyTerminalMs: null }),
    false,
  );
});

test('mechanical misses keep working exactly as before', () => {
  assert.equal(isHammerRemediableEligibilityMiss(['ci-not-green'], {}), true);
  assert.equal(isHammerRemediableEligibilityMiss(['pr-not-mergeable'], {}), true);
});

test('a non-finite duration is inert', () => {
  for (const v of [null, undefined, NaN, 'soon']) {
    assert.equal(
      isHammerRemediableEligibilityMiss(NB, {
        settledCommentOnlyTerminalMs: v,
        commentOnlyTerminalGraceMs: 0,
      }),
      false,
      `duration ${String(v)} must not admit`,
    );
  }
});
