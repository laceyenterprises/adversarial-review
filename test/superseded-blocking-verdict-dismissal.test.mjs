import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SUPERSEDED_BLOCKING_VERDICT_DISMISSAL_REASON,
  buildSupersededBlockingVerdictDismissalMessage,
  dismissSupersededBlockingVerdictAtRemediatedHead,
} from '../src/superseded-blocking-verdict-dismissal.mjs';
import {
  __test__ as githubApiTestables,
  dismissStandingChangesRequestedReviewsForHead,
} from '../src/github-api.mjs';
import { maybeDispatchAmaClosureFor } from '../src/watcher.mjs';

// ─────────────────────────────────────────────────────────────────────────────
// SVD-02 REGRESSION PROOF — a stale blocking verdict must become dismissable,
// and a LIVE one must stay untouchable.
//
// SEV: docs/postmortems/SEV-stale-blocking-verdict-is-structurally-undismissable-2026-08-26.md
//
// agent-os #5918 sat 4.5h at MERGEABLE/CLEAN with every required check green,
// blocked only by a CHANGES_REQUESTED judged at head 7432b8f03 that the HAM
// terminal remediation 72d25a7c1 had already made false — 31 minutes later, by
// adding exactly the file the finding said was untouched. Both pre-existing
// dismissal paths were gated on a state that the standing blocking verdict
// itself prevents, so nothing in the system could act on that fact until an
// operator dismissed it by hand. #5811 hit the same shape earlier.
//
// The third trigger keys on a VALIDATED HAM TERMINAL REMEDIATION AT THE CURRENT
// HEAD. Its entire value is that it CANNOT confuse a live finding with a stale
// one, so the supersession test is strict and the tests below pin that hard.
//
// NON-VACUITY: with the fix reverted these tests fail — see the PR body for the
// observed failures (the `requireSupersededCommitId` filter removed makes the
// live-finding tests fail; the module removed makes them all fail at import).
// ─────────────────────────────────────────────────────────────────────────────

const REPO = 'laceyenterprises/agent-os';
const PR = 5918;
// The head the 4th CHANGES_REQUESTED was judged at.
const JUDGED_HEAD = '7432b8f03aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
// The head the HAM terminal remediation landed at, which superseded it.
const REMEDIATING_HEAD = '72d25a7c1bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const REVIEWER_LOGIN = 'lacey-codex-reviewer';

const SILENT_LOGGER = { log() {}, warn() {} };

function reviewsEnvelope(reviews) {
  return {
    stdout:
      'HTTP/1.1 200 OK\nx-ratelimit-resource: core\nx-ratelimit-remaining: 4999\n' +
      `x-ratelimit-reset: 1780000000\n\n${JSON.stringify(reviews)}`,
  };
}

function changesRequested({ id, commitId, submittedAt, login = `${REVIEWER_LOGIN}[bot]` }) {
  return {
    id,
    user: { login },
    body: 'the diff does not touch projects/argus-security-route/SPEC.md',
    state: 'CHANGES_REQUESTED',
    submitted_at: submittedAt,
    commit_id: commitId,
  };
}

/**
 * Drive the REAL dismissal helper against a fake `gh`, so the strict-supersession
 * filter is exercised end to end rather than stubbed out. Records every dismissal
 * PUT the code actually issues.
 */
function makeGithubFixture(reviews) {
  const dismissalPuts = [];
  const dismissImpl = (execFileImpl, repo, prNumber, headSha, options = {}) =>
    dismissStandingChangesRequestedReviewsForHead(execFileImpl, repo, prNumber, headSha, {
      ...options,
      recordApiCallImpl: () => {},
    });
  const execFileImpl = async (command, args) => {
    assert.equal(command, 'gh');
    if (args[0] === 'api' && args.includes('-X') && args.includes('PUT')) {
      const path = args.find((arg) => String(arg).includes('/dismissals')) || '';
      const message = args.find((arg) => String(arg).startsWith('message=')) || '';
      dismissalPuts.push({ path, message });
      return { stdout: '{}' };
    }
    return reviewsEnvelope(reviews);
  };
  return { dismissImpl, execFileImpl, dismissalPuts };
}

function runTrigger({
  reviews,
  hamTerminalRemediationValidated = true,
  env = {},
  currentHeadSha = REMEDIATING_HEAD,
  authoritativeReviewerLogins = [REVIEWER_LOGIN],
  auditHasMarker = false,
}) {
  const fixture = makeGithubFixture(reviews);
  return dismissSupersededBlockingVerdictAtRemediatedHead({
    repo: REPO,
    prNumber: PR,
    currentHeadSha,
    hqRoot: '/nonexistent-svd02-fixture-hq-root',
    hamTerminalRemediationValidated,
    authoritativeReviewerLogins,
    env: { DISMISS_STALE_REQUEST_CHANGES_ON_RESOLVED: 'true', ...env },
    logger: SILENT_LOGGER,
    execFileImpl: fixture.execFileImpl,
    // The durable per-head AMA audit marker path, isolated from the real filesystem.
    headHasValidatedHamTerminalRemediationImpl: () => auditHasMarker,
    dismissStandingChangesRequestedReviewsForHeadImpl: fixture.dismissImpl,
  }).then((result) => ({ result, dismissalPuts: fixture.dismissalPuts }));
}

// ── (a) THE REPRO: stale verdict at a superseded head + a validated HAM terminal
//        remediation at the current head → DISMISSED. ─────────────────────────
test('(a) a blocking verdict at a SUPERSEDED head is dismissed when the current head carries a validated HAM terminal remediation', async () => {
  const { result, dismissalPuts } = await runTrigger({
    reviews: [
      changesRequested({ id: 5918001, commitId: JUDGED_HEAD, submittedAt: '2026-08-26T08:25:29Z' }),
    ],
  });

  assert.equal(result.ok, true, `expected a dismissal, got ${JSON.stringify(result)}`);
  assert.equal(result.dismissal.attempted, 1);
  assert.deepEqual(result.dismissal.dismissed.map((review) => review.id), ['5918001']);
  assert.equal(dismissalPuts.length, 1, 'exactly one dismissal PUT must be issued');
  assert.match(dismissalPuts[0].path, /pulls\/5918\/reviews\/5918001\/dismissals/);

  // The reason must be machine-readable and NAME BOTH HEADS.
  assert.match(dismissalPuts[0].message, new RegExp(`reason=${SUPERSEDED_BLOCKING_VERDICT_DISMISSAL_REASON}`));
  assert.match(dismissalPuts[0].message, new RegExp(`judged-head=${JUDGED_HEAD}`));
  assert.match(dismissalPuts[0].message, new RegExp(`remediating-head=${REMEDIATING_HEAD}`));
});

// ── (b) THE HARD CONSTRAINT: a blocking verdict AT the current head is a LIVE
//        finding and must NEVER be dismissed, however strong the HAM evidence. ──
test('(b) HARD CONSTRAINT: a blocking verdict whose commit_id EQUALS the current head is NEVER dismissed', async () => {
  const { result, dismissalPuts } = await runTrigger({
    reviews: [
      // Judged at the SAME head the HAM remediation produced: the reviewer saw
      // the remediated code and still blocked. This is a live finding.
      changesRequested({ id: 5918002, commitId: REMEDIATING_HEAD, submittedAt: '2026-08-26T09:10:00Z' }),
    ],
  });

  assert.equal(result.ok, true);
  assert.equal(result.dismissal.attempted, 0, 'a live finding must never be attempted');
  assert.deepEqual(result.dismissal.dismissed, []);
  assert.deepEqual(result.dismissal.retainedAtHead.map((review) => review.id), ['5918002']);
  assert.equal(dismissalPuts.length, 0, 'NO dismissal API call may be issued for a live finding');
});

// The same distinction under mixed input — the one case where losing it is
// silent: dismissing the stale verdict must not sweep the live one out with it.
test('(b2) HARD CONSTRAINT: with a stale AND a live verdict standing, only the superseded one is dismissed', async () => {
  const { result, dismissalPuts } = await runTrigger({
    reviews: [
      changesRequested({ id: 5918003, commitId: JUDGED_HEAD, submittedAt: '2026-08-26T08:25:29Z' }),
      changesRequested({ id: 5918004, commitId: REMEDIATING_HEAD, submittedAt: '2026-08-26T09:10:00Z' }),
    ],
  });

  assert.deepEqual(result.dismissal.dismissed.map((review) => review.id), ['5918003']);
  assert.deepEqual(result.dismissal.retainedAtHead.map((review) => review.id), ['5918004']);
  assert.equal(dismissalPuts.length, 1);
  assert.match(dismissalPuts[0].path, /reviews\/5918003\/dismissals/);
  assert.ok(
    !dismissalPuts.some((put) => put.path.includes('5918004')),
    'the live finding must not be dismissed',
  );
});

// A verdict with no resolvable `commit_id` cannot be PROVEN superseded. Fail
// closed — it is retained, exactly like a live finding.
test('(b3) HARD CONSTRAINT: a blocking verdict with an unresolvable commit_id is retained (fail closed)', async () => {
  const { result, dismissalPuts } = await runTrigger({
    reviews: [
      changesRequested({ id: 5918005, commitId: null, submittedAt: '2026-08-26T08:25:29Z' }),
    ],
  });

  assert.equal(result.dismissal.attempted, 0);
  assert.deepEqual(result.dismissal.retainedAtHead.map((review) => review.id), ['5918005']);
  assert.equal(dismissalPuts.length, 0);
});

// ── (c) superseded head but NO validated HAM terminal remediation → NOT
//        dismissed. Supersession alone is not authority; the remediation is. ───
test('(c) a superseded blocking verdict is NOT dismissed without a validated HAM terminal remediation', async () => {
  const { result, dismissalPuts } = await runTrigger({
    reviews: [
      changesRequested({ id: 5918006, commitId: JUDGED_HEAD, submittedAt: '2026-08-26T08:25:29Z' }),
    ],
    hamTerminalRemediationValidated: false,
    auditHasMarker: false,
  });

  assert.equal(result.skipped, 'no-validated-ham-terminal-remediation');
  assert.equal(dismissalPuts.length, 0, 'no GitHub call may be made without the remediation evidence');
});

// The durable per-head AMA audit marker is the equally-trusted second source of
// the same evidence (`headHasValidatedHamTerminalRemediation`).
test('(c2) the durable per-head AMA audit marker alone satisfies the remediation condition', async () => {
  const { result, dismissalPuts } = await runTrigger({
    reviews: [
      changesRequested({ id: 5918007, commitId: JUDGED_HEAD, submittedAt: '2026-08-26T08:25:29Z' }),
    ],
    hamTerminalRemediationValidated: false,
    auditHasMarker: true,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.dismissal.dismissed.map((review) => review.id), ['5918007']);
  assert.equal(dismissalPuts.length, 1);
});

// ── (d) the feature flag disabled → NOT dismissed. ───────────────────────────
test('(d) the trigger respects AGENT_OS_FEATURE_FLAGS_DISMISS_STALE_REQUEST_CHANGES_ON_RESOLVED=false', async () => {
  const { result, dismissalPuts } = await runTrigger({
    reviews: [
      changesRequested({ id: 5918008, commitId: JUDGED_HEAD, submittedAt: '2026-08-26T08:25:29Z' }),
    ],
    env: {
      DISMISS_STALE_REQUEST_CHANGES_ON_RESOLVED: undefined,
      AGENT_OS_FEATURE_FLAGS_DISMISS_STALE_REQUEST_CHANGES_ON_RESOLVED: 'false',
    },
  });

  assert.equal(result.skipped, 'disabled');
  assert.equal(dismissalPuts.length, 0);
});

test('(d2) the legacy DISMISS_STALE_REQUEST_CHANGES_ON_RESOLVED=0 env also disables the trigger', async () => {
  const { result, dismissalPuts } = await runTrigger({
    reviews: [
      changesRequested({ id: 5918009, commitId: JUDGED_HEAD, submittedAt: '2026-08-26T08:25:29Z' }),
    ],
    env: { DISMISS_STALE_REQUEST_CHANGES_ON_RESOLVED: '0' },
  });

  assert.equal(result.skipped, 'disabled');
  assert.equal(dismissalPuts.length, 0);
});

// ── Remaining guards on the trigger itself. ──────────────────────────────────
test('a non-authoritative reviewer\'s standing block is never dismissed by this trigger', async () => {
  const { result, dismissalPuts } = await runTrigger({
    reviews: [
      changesRequested({
        id: 5918010,
        commitId: JUDGED_HEAD,
        submittedAt: '2026-08-26T08:25:29Z',
        login: 'a-human-reviewer',
      }),
    ],
  });

  assert.equal(result.ok, true);
  assert.equal(result.dismissal.attempted, 0);
  assert.equal(dismissalPuts.length, 0);
});

test('an unresolved authoritative reviewer login set skips the trigger', async () => {
  const { result, dismissalPuts } = await runTrigger({
    reviews: [
      changesRequested({ id: 5918011, commitId: JUDGED_HEAD, submittedAt: '2026-08-26T08:25:29Z' }),
    ],
    authoritativeReviewerLogins: [],
  });

  assert.equal(result.skipped, 'authoritative-reviewer-logins-unresolved');
  assert.equal(dismissalPuts.length, 0);
});

test('a missing current head skips the trigger before any evidence read', async () => {
  const { result } = await runTrigger({ reviews: [], currentHeadSha: '' });
  assert.equal(result.skipped, 'no-current-head');
});

test('a GitHub dismissal failure never throws out of the tick', async () => {
  const result = await dismissSupersededBlockingVerdictAtRemediatedHead({
    repo: REPO,
    prNumber: PR,
    currentHeadSha: REMEDIATING_HEAD,
    hamTerminalRemediationValidated: true,
    authoritativeReviewerLogins: [REVIEWER_LOGIN],
    env: { DISMISS_STALE_REQUEST_CHANGES_ON_RESOLVED: 'true' },
    logger: SILENT_LOGGER,
    headHasValidatedHamTerminalRemediationImpl: () => false,
    dismissStandingChangesRequestedReviewsForHeadImpl: async () => {
      throw new Error('gh: 403 Resource not accessible by integration');
    },
  });

  assert.equal(result.ok, false);
  assert.match(String(result.error?.message || ''), /403/);
});

// ── The supersession primitive, isolated. ────────────────────────────────────
test('partitionStandingReviewsBySupersededHead: strictly-superseded only, everything else retained', () => {
  const { partitionStandingReviewsBySupersededHead } = githubApiTestables;
  const atHead = { id: '1', commitId: REMEDIATING_HEAD };
  const superseded = { id: '2', commitId: JUDGED_HEAD };
  const unknownHead = { id: '3', commitId: null };

  const result = partitionStandingReviewsBySupersededHead(
    [atHead, superseded, unknownHead],
    REMEDIATING_HEAD,
  );
  assert.deepEqual(result.superseded.map((review) => review.id), ['2']);
  assert.deepEqual(result.retainedAtHead.map((review) => review.id), ['1', '3']);

  // With no current head to compare against, NOTHING is superseded.
  const noHead = partitionStandingReviewsBySupersededHead([superseded], '');
  assert.deepEqual(noHead.superseded, []);
  assert.deepEqual(noHead.retainedAtHead.map((review) => review.id), ['2']);
});

test('the dismissal message names both the judged head and the remediating head', () => {
  const message = buildSupersededBlockingVerdictDismissalMessage({
    judgedHead: JUDGED_HEAD,
    remediatingHead: REMEDIATING_HEAD,
  });
  assert.match(message, new RegExp(`reason=${SUPERSEDED_BLOCKING_VERDICT_DISMISSAL_REASON}`));
  assert.match(message, new RegExp(`judged-head=${JUDGED_HEAD}`));
  assert.match(message, new RegExp(`remediating-head=${REMEDIATING_HEAD}`));
});

// ── The wiring. The trigger is worthless if the orchestration never calls it:
//    that is precisely the defect this SEV documents (two live, flag-enabled
//    dismissal paths that nothing could reach). ────────────────────────────────
test('orchestration: the third trigger runs at the current head BEFORE the daemon clean-merge attempt', async () => {
  const calls = [];
  const order = [];
  await maybeDispatchAmaClosureFor({
    reviewStateRow: {
      repo: REPO,
      pr_number: PR,
      pr_state: 'open',
      review_status: 'posted',
      review_body: '## Summary\nBlocking on the old head.\n## Verdict\nRequest changes',
      reviewer_head_sha: JUDGED_HEAD,
      reviewer_login: 'claude-reviewer-lacey',
    },
    dispatchJob: { blockingFindingCount: 1, blockingFindingState: 'known' },
    candidate: {
      headSha: REMEDIATING_HEAD,
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
    repoPath: REPO,
    prNumber: PR,
    currentRevisionRef: REMEDIATING_HEAD,
    logger: SILENT_LOGGER,
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
    resolveHeadCloserCommitSuppressionImpl: async () => ({ suppressed: true }),
    dismissSupersededBlockingVerdictAtRemediatedHeadImpl: async (args) => {
      order.push('dismiss');
      calls.push(args);
      return { skipped: 'fixture' };
    },
    runDaemonCleanMergeAttemptImpl: async () => {
      order.push('daemon');
      return { disposition: 'not-taken', reason: 'fixture' };
    },
    maybeDispatchAmaCloserImpl: async () => ({ dispatched: false, reason: 'fixture' }),
  });

  assert.deepEqual(order, ['dismiss', 'daemon'], 'the dismissal must precede the daemon merge attempt');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].repo, REPO);
  assert.equal(calls[0].prNumber, PR);
  // The CURRENT head, not the judged head — the trigger's whole premise.
  assert.equal(calls[0].currentHeadSha, REMEDIATING_HEAD);
});
