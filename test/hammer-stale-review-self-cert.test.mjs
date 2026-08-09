import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isTerminalCloserCommitIdentity,
} from '../src/head-closer-commit-suppression.mjs';
import { isHammerRemediableEligibilityMiss } from '../src/ama/dispatch-closer.mjs';
import { maybeDispatchAmaClosureFor } from '../src/watcher.mjs';

// ─────────────────────────────────────────────────────────────────────────────
// STALE-REVIEW-HEAD SELF-CERTIFICATION SAFETY PROOF (#5053).
//
// When the hammer remediates a PR, its own commit advances the head → the settled
// review is flagged `stale-review-head` → the eligibility miss returned
// `not-eligible` and the no-dispatch "retain" tick spun forever (a live 50-min
// stall). The fix un-gates the own-commit suppression proof from review-cycle
// exhaustion so a comment-only / non-blocking review's moved head can resume — but
// ONLY when the live head commit is the terminal closer's own commit. An EXTERNAL
// push (a non-closer committer) can never forge that identity, so it stays blocked.
//
// This is the safety invariant. The stash-and-fail evidence in the PR body reverts
// ONLY the Fix-A source hunks and shows the self-cert assertions below FLIP to
// failing while the external-push assertions still pass.
// ─────────────────────────────────────────────────────────────────────────────

const REVIEWED_HEAD = 'head-a-reviewed-00000000000000000000000';
const CURRENT_HEAD = 'head-b-current-000000000000000000000000';

// The un-forgeable primitive: a committer login is set by GitHub, not by the
// pusher. Only the terminal-closer bot identities self-certify.
test('primitive: the terminal closer own commit self-certifies; an external committer never does', () => {
  const closer = isTerminalCloserCommitIdentity({ committer: { login: 'the-hammer-lacey[bot]' } });
  assert.equal(closer.suppressed, true);

  const external = isTerminalCloserCommitIdentity({ committer: { login: 'some-human-contributor' } });
  assert.equal(external.suppressed, false);

  // A forged trailer on an external-authored commit does NOT help: identity is read
  // from the committer login / closer trailer the platform stamps, and a plain
  // human push carries neither.
  const forgedBody = isTerminalCloserCommitIdentity({
    committer: { login: 'attacker' },
    message: 'sneaky\n\nApproved-By: hammer\n',
  });
  assert.equal(forgedBody.suppressed, false);
});

// Fix A part 2 — the eligibility-miss remediability predicate, NON-exhausted branch.
test('isHammerRemediableEligibilityMiss: self-cert flag strips stale-review-head (non-exhausted); external stays blocked', () => {
  const reasons = ['stale-review-head', 'ci-not-green'];

  // SELF-CERT: with the resume flag armed (own-commit proof upstream), stale-review-head
  // is stripped and the remaining actionable+remediable ci-not-green makes it eligible.
  assert.equal(
    isHammerRemediableEligibilityMiss(reasons, {
      reviewCycleExhausted: false,
      allowStaleReviewHeadHammerResume: true,
    }),
    true,
  );

  // EXTERNAL PUSH: no flag → stale-review-head stays → blocked (it is not a
  // hammer-auto-remediable reason).
  assert.equal(
    isHammerRemediableEligibilityMiss(reasons, {
      reviewCycleExhausted: false,
      allowStaleReviewHeadHammerResume: false,
    }),
    false,
  );

  // A self-cert flag must NOT conjure a dispatch when there is nothing actionable
  // left after stripping stale-review-head (no purposeless hammer).
  assert.equal(
    isHammerRemediableEligibilityMiss(['stale-review-head'], {
      reviewCycleExhausted: false,
      allowStaleReviewHeadHammerResume: true,
    }),
    false,
  );
});

// The exhausted branch (AR#790's sibling) must keep its exact prior behavior.
test('isHammerRemediableEligibilityMiss: exhausted branch unchanged (self-cert resumes, external blocks)', () => {
  assert.equal(
    isHammerRemediableEligibilityMiss(['stale-review-head'], {
      reviewCycleExhausted: true,
      allowStaleReviewHeadHammerResume: true,
    }),
    true,
  );
  assert.equal(
    isHammerRemediableEligibilityMiss(['stale-review-head'], {
      reviewCycleExhausted: true,
      allowStaleReviewHeadHammerResume: false,
    }),
    false,
  );
});

// ─────────────────────────────────────────────────────────────────────────────────
// #5093 (follow-on to #5053): a fully-clean / settled review whose head the
// closer's OWN commit advanced parks forever. After #5053 strips the
// self-certified `stale-review-head`, the ONLY remaining miss on a zero-finding
// clean review is `verdict-not-settled-success` (the settled verdict cannot be
// confirmed at the moved head) -- which failed the non-exhausted `hasActionable`
// gate, so the closer never resumed and the retain-loop cap blew (17/32/9+ vs 3).
// The fix treats `verdict-not-settled-success` as actionable for the PROVEN
// closer-commit self-cert case ONLY; every other case is unchanged.
// ─────────────────────────────────────────────────────────────────────────────────
test('isHammerRemediableEligibilityMiss: #5093 clean-review closer-commit stale head resumes (non-exhausted)', () => {
  // THE #5093 REPRO: not-exhausted, closer-commit self-cert armed, a clean review
  // whose only misses are the (stripped) stale head + the settled-verdict gate it
  // caused -> the hammer resumes and re-validates fail-closed before merge.
  assert.equal(
    isHammerRemediableEligibilityMiss(['stale-review-head', 'verdict-not-settled-success'], {
      reviewCycleExhausted: false,
      allowStaleReviewHeadHammerResume: true,
    }),
    true,
  );

  // SAFETY: the SAME reasons WITHOUT the self-cert flag (external / non-closer
  // stale head) must still park for a fresh review -- never self-cert.
  assert.equal(
    isHammerRemediableEligibilityMiss(['stale-review-head', 'verdict-not-settled-success'], {
      reviewCycleExhausted: false,
      allowStaleReviewHeadHammerResume: false,
    }),
    false,
  );

  // NARROWNESS: `verdict-not-settled-success` becomes actionable ONLY because the
  // closer-commit stale head was self-certified. A bare `verdict-not-settled-success`
  // with NO stale-review-head (so `closerStaleHeadResume` cannot arm) still parks in
  // the non-exhausted branch -- the fix does not broaden the verdict gate at large.
  assert.equal(
    isHammerRemediableEligibilityMiss(['verdict-not-settled-success'], {
      reviewCycleExhausted: false,
      allowStaleReviewHeadHammerResume: true,
    }),
    false,
  );
});

// Regression guard: the enumerated invariants that must NOT move with the #5093 fix.
test('isHammerRemediableEligibilityMiss: #5093 fix preserves every neighboring invariant', () => {
  // not-exhausted + no resume + bare stale -> park (unchanged).
  assert.equal(
    isHammerRemediableEligibilityMiss(['stale-review-head'], {
      reviewCycleExhausted: false,
      allowStaleReviewHeadHammerResume: false,
    }),
    false,
  );
  // exhausted + no resume + stale -> park (unchanged).
  assert.equal(
    isHammerRemediableEligibilityMiss(['stale-review-head'], {
      reviewCycleExhausted: true,
      allowStaleReviewHeadHammerResume: false,
    }),
    false,
  );
  // exhausted + resume + stale -> eligible (unchanged).
  assert.equal(
    isHammerRemediableEligibilityMiss(['stale-review-head'], {
      reviewCycleExhausted: true,
      allowStaleReviewHeadHammerResume: true,
    }),
    true,
  );
  // not-exhausted + plain actionable finding, no resume -> eligible via the
  // hasActionable path (unchanged).
  assert.equal(
    isHammerRemediableEligibilityMiss(['non-blocking-findings-present'], {
      reviewCycleExhausted: false,
    }),
    true,
  );
  // #5053's "no purposeless hammer": a bare closer-commit stale head with NOTHING
  // else to act on still parks even with the resume flag armed (unchanged).
  assert.equal(
    isHammerRemediableEligibilityMiss(['stale-review-head'], {
      reviewCycleExhausted: false,
      allowStaleReviewHeadHammerResume: true,
    }),
    false,
  );
});

// Fix A part 1 — the orchestration arms `allowStaleReviewHeadHammerResume` for a
// stale reviewed head on a NON-exhausted (comment-only) review, gated on the
// own-commit suppression proof.
async function runOrchestrationForSuppression(suppressed) {
  let payload = null;
  await maybeDispatchAmaClosureFor({
    reviewStateRow: {
      repo: 'laceyenterprises/nonexistent-selfcert-fixture',
      pr_number: 5053,
      pr_state: 'open',
      review_status: 'posted',
      review_body: '## Summary\nClean on the old head.\n## Verdict\nComment only',
      reviewer_head_sha: REVIEWED_HEAD,
      reviewer_login: 'claude-reviewer-lacey',
    },
    dispatchJob: { blockingFindingCount: 0, blockingFindingState: 'known' },
    candidate: {
      headSha: CURRENT_HEAD,
      riskClass: 'low',
      prAuthor: 'codex-worker-bot',
      prState: 'open',
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'CLEAN',
      statusCheckRollup: [],
      branchProtection: { requiredContexts: [] },
      isDraft: false,
    },
    labelNames: [],
    operatorApprovalEvent: null,
    adversarialMergeRequestedEvent: null,
    repoPath: 'laceyenterprises/nonexistent-selfcert-fixture',
    prNumber: 5053,
    currentRevisionRef: CURRENT_HEAD,
    logger: { warn() {}, log() {} },
    // Keep the review STALE + offline: the live-head reconcile fails closed to
    // `resolved:false`, so the gate snapshot uses the reviewed (old) head.
    fetchLatestHeadReviewBodiesImpl: async () => {
      throw new Error('no live head review in fixture');
    },
    loadConfigImpl: () => ({
      getMergeAuthorityConfig() {
        return {
          enabled: true,
          eligibility: {
            riskClasses: ['low', 'medium', 'high', 'critical'],
            highRiskRequiresTwoKey: false,
          },
          branchProtection: { required: false },
        };
      },
      getOrchestrationMode() {
        return 'native';
      },
    }),
    // The own-commit suppression proof — injected so the test is deterministic and
    // offline. suppressed:true models the hammer's own remediation commit at the
    // live head; suppressed:false models an external push.
    resolveHeadCloserCommitSuppressionImpl: async () => ({ suppressed }),
    // Force the daemon clean-merge path to decline so the tick falls through to the
    // hammer dispatch, where the resume flag is threaded into dispatchContext.
    runDaemonCleanMergeAttemptImpl: async () => ({ disposition: 'not-taken', reason: 'fixture' }),
    maybeDispatchAmaCloserImpl: async (p) => {
      payload = p;
      return { dispatched: false, reason: 'fixture' };
    },
  });
  return payload;
}

test('orchestration: a self-certified stale head arms hammer resume (eligible to land)', async () => {
  const payload = await runOrchestrationForSuppression(true);
  assert.ok(payload, 'the hammer dispatch payload must be built (daemon declined)');
  // Confirm the fixture is actually exercising the STALE-head path.
  assert.equal(payload.reviewState.headSha, REVIEWED_HEAD);
  assert.equal(payload.prMetadata.headSha, CURRENT_HEAD);
  // SELF-CERT → resume armed.
  assert.equal(payload.dispatchContext.allowStaleReviewHeadHammerResume, true);
});

test('orchestration: an external push at a stale head NEVER arms hammer resume (stays blocked)', async () => {
  const payload = await runOrchestrationForSuppression(false);
  assert.ok(payload, 'the hammer dispatch payload must be built (daemon declined)');
  assert.equal(payload.reviewState.headSha, REVIEWED_HEAD);
  assert.equal(payload.prMetadata.headSha, CURRENT_HEAD);
  // EXTERNAL PUSH → resume NEVER armed. This is the safety invariant.
  assert.equal(payload.dispatchContext.allowStaleReviewHeadHammerResume, false);
});
