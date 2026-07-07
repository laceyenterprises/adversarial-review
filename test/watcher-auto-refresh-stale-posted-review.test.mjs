/* Watcher auto-refreshes stale posted reviews when PR HEAD has moved.
 *
 * Before this fix, a `posted` review row in reviewed_prs sat forever
 * even when the PR had been updated. The watcher's main reclaim CAS
 * (`stmtMarkAttemptStarted`) only matches rows in
 * `pending | pending-upstream`, never `posted` or generic `failed`. D3 (downstream
 * gate) saw the posted review on an older head SHA, reported "stale
 * review", and D4 stayed pending forever. The only recovery was
 * operator-applied `retrigger-review` label.
 *
 * The fix calls `requestReviewRereview` directly when the watcher sees
 * a posted row whose `reviewer_head_sha` no longer matches the current
 * PR head, unless a higher-priority convergence guard suppresses the
 * automatic refresh. requestReviewRereview's own CAS refuses `reviewing`,
 * so a head change mid-tick can't race a duplicate spawn.
 *
 * These tests exercise the contract end-to-end via the underlying
 * `requestReviewRereview` mutation, mirroring how the watcher invokes
 * it. The watcher-level integration is exercised by
 * `watcher-claim-loop.test.mjs` once the fix lands.
 *
 * See `projects/daemon-bounce-safety/SPEC.md` §6a for the broader
 * bounce/drain semantics and SRE spike round 6 in memory
 * `project_merge_agent_sre_spike_2026_05_16.md` for the trace that
 * pinpointed this gap.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  ensureReviewStateSchema,
  openReviewStateDb,
  requestReviewRereview,
} from '../src/review-state.mjs';
import {
  MERGE_AGENT_DISPATCHED_LABEL,
  MERGE_AGENT_REQUESTED_LABEL,
  MERGE_AGENT_STUCK_LABEL,
  NO_MERGE_HOLD_LABEL,
} from '../src/adapters/operator/github-pr-label-controls/index.mjs';
import { REVIEWER_CYCLE_CAP_REACHED_LABEL } from '../src/review-cycle-cap.mjs';
import {
  countCompletedReviewerRereviewRounds,
  createHeadCloserCommitSuppressionResolver,
  getStalePostedReviewAutoRereviewSuppression,
  getStalePostedReviewBudgetSuppression,
  getHeadCloserCommitSuppression,
  isExplicitOperatorReviewRetrigger,
  isTerminalCloserCommitIdentity,
  maybeDispatchAmaClosureFor,
  resolveFirstPassReviewBudgetSuppression,
} from '../src/watcher.mjs';


function makeTempRoot() {
  return mkdtempSync(path.join(tmpdir(), 'auto-refresh-stale-'));
}


function setupPostedRow(rootDir, {
  repo = 'laceyenterprises/agent-os',
  prNumber = 513,
  reviewerHeadSha = '7607992db51a',
  postedAt = '2026-05-16T21:44:46Z',
} = {}) {
  const db = openReviewStateDb(rootDir);
  ensureReviewStateSchema(db);
  db.prepare(
    `INSERT INTO reviewed_prs (
       repo, pr_number, reviewed_at, reviewer, pr_state,
       review_status, review_attempts, last_attempted_at, posted_at,
       reviewer_head_sha
     ) VALUES (?, ?, ?, ?, 'open',
              'posted', 1, ?, ?, ?)`
  ).run(
    repo,
    prNumber,
    postedAt,
    'codex',
    postedAt,
    postedAt,
    reviewerHeadSha,
  );
  return db;
}


function readRow(db, repo, prNumber) {
  return db.prepare(
    'SELECT * FROM reviewed_prs WHERE repo = ? AND pr_number = ?',
  ).get(repo, prNumber);
}


test('requestReviewRereview flips posted → pending when head moved', () => {
  // This is the exact mutation the watcher's auto-refresh path calls.
  // A posted row in reviewed_prs with a stale reviewer_head_sha gets
  // flipped to pending so the next watcher tick's claim CAS picks it up.
  const rootDir = makeTempRoot();
  try {
    const db = setupPostedRow(rootDir, {
      prNumber: 513,
      reviewerHeadSha: '7607992db51a',
    });

    const before = readRow(db, 'laceyenterprises/agent-os', 513);
    assert.equal(before.review_status, 'posted');
    assert.equal(before.reviewer_head_sha, '7607992db51a');

    const result = requestReviewRereview({
      rootDir,
      repo: 'laceyenterprises/agent-os',
      prNumber: 513,
      reason: 'auto-refresh: posted review on stale head 7607992db51a; current head is bb8be579d4a8',
    });

    assert.equal(result.triggered, true);
    const after = readRow(db, 'laceyenterprises/agent-os', 513);
    assert.equal(after.review_status, 'pending');
    assert.equal(after.posted_at, null);
    assert.match(after.rereview_reason, /auto-refresh: posted review on stale head/);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});


test('CAS refuses to reset a row in reviewing (no race against in-flight)', () => {
  // The auto-refresh path can fire mid-tick. If the watcher has
  // already claimed the row in this tick (status='reviewing'), the
  // CAS must NOT flip it back to pending — that would re-arm a row
  // whose reviewer subprocess is in flight, causing a duplicate spawn.
  const rootDir = makeTempRoot();
  try {
    const db = openReviewStateDb(rootDir);
    ensureReviewStateSchema(db);
    db.prepare(
      `INSERT INTO reviewed_prs (
         repo, pr_number, reviewed_at, reviewer, pr_state,
         review_status, review_attempts, last_attempted_at, reviewer_head_sha,
         reviewer_session_uuid, reviewer_started_at
       ) VALUES (?, ?, ?, ?, 'open',
                'reviewing', 0, ?, ?, ?, ?)`
    ).run(
      'laceyenterprises/agent-os',
      540,
      '2026-05-16T20:00:00Z',
      'codex',
      '2026-05-16T20:12:47Z',
      'fakehead1234',
      'session-uuid-x',
      '2026-05-16T20:12:47Z',
    );

    const result = requestReviewRereview({
      rootDir,
      repo: 'laceyenterprises/agent-os',
      prNumber: 540,
      reason: 'auto-refresh: posted review on stale head ... (would race)',
    });

    assert.equal(result.triggered, false);
    const row = readRow(db, 'laceyenterprises/agent-os', 540);
    assert.equal(
      row.review_status,
      'reviewing',
      'CAS must refuse to overwrite an in-flight reviewer claim',
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});


test('CAS skips when row is already pending (no thrash)', () => {
  // If something already armed the row for review (operator label,
  // earlier watcher tick), the auto-refresh path must not double-mutate.
  const rootDir = makeTempRoot();
  try {
    const db = openReviewStateDb(rootDir);
    ensureReviewStateSchema(db);
    db.prepare(
      `INSERT INTO reviewed_prs (
         repo, pr_number, reviewed_at, reviewer, pr_state,
         review_status, review_attempts, last_attempted_at
       ) VALUES (?, ?, ?, ?, 'open',
                'pending', 0, ?)`
    ).run(
      'laceyenterprises/agent-os',
      557,
      '2026-05-16T22:00:00Z',
      'codex',
      '2026-05-16T22:00:00Z',
    );

    const result = requestReviewRereview({
      rootDir,
      repo: 'laceyenterprises/agent-os',
      prNumber: 557,
      reason: 'auto-refresh would be a no-op',
    });

    assert.equal(result.triggered, false);
    const row = readRow(db, 'laceyenterprises/agent-os', 557);
    assert.equal(row.review_status, 'pending');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});


test('CAS skips when PR state is not open (closed/merged)', () => {
  // A posted row for a closed PR must not be flipped to pending; there
  // is no value in re-reviewing a terminal PR. requestReviewRereview's
  // CAS gates on pr_state='open' specifically to handle this.
  const rootDir = makeTempRoot();
  try {
    const db = openReviewStateDb(rootDir);
    ensureReviewStateSchema(db);
    db.prepare(
      `INSERT INTO reviewed_prs (
         repo, pr_number, reviewed_at, reviewer, pr_state,
         review_status, review_attempts, last_attempted_at, posted_at,
         reviewer_head_sha
       ) VALUES (?, ?, ?, ?, 'merged',
                'posted', 1, ?, ?, ?)`
    ).run(
      'laceyenterprises/agent-os',
      460,
      '2026-05-15T00:00:00Z',
      'codex',
      '2026-05-15T00:00:00Z',
      '2026-05-15T00:00:00Z',
      'stalehead0000',
    );

    const result = requestReviewRereview({
      rootDir,
      repo: 'laceyenterprises/agent-os',
      prNumber: 460,
      reason: 'auto-refresh would be wrong for closed PR',
    });

    assert.equal(result.triggered, false);
    const row = readRow(db, 'laceyenterprises/agent-os', 460);
    assert.equal(row.review_status, 'posted');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});


test('idempotent: second invocation against same head is a no-op (status already pending)', () => {
  // After the first auto-refresh flips posted → pending, the next
  // watcher tick should NOT re-fire — the CAS gates on
  // review_status NOT IN ('pending', 'reviewing', 'malformed').
  const rootDir = makeTempRoot();
  try {
    const db = setupPostedRow(rootDir);
    const first = requestReviewRereview({
      rootDir,
      repo: 'laceyenterprises/agent-os',
      prNumber: 513,
      reason: 'first call',
    });
    assert.equal(first.triggered, true);

    const second = requestReviewRereview({
      rootDir,
      repo: 'laceyenterprises/agent-os',
      prNumber: 513,
      reason: 'second call should be no-op',
    });
    assert.equal(second.triggered, false);

    const row = readRow(db, 'laceyenterprises/agent-os', 513);
    assert.equal(row.review_status, 'pending');
    // First-call reason wins (idempotent CAS doesn't overwrite).
    assert.match(row.rereview_reason, /first call/);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

// --- Merge-agent convergence suppresses stale-head auto-refresh only when the
// watcher can prove it is still current-head state. ---
//
// Regression for the 2026-05-25 infinite review<->remediation loop: the
// watcher's auto-refresh re-armed a fresh reviewer on every head move,
// including the merge-agent's own convergence force-pushes, so PRs under a
// merge-agent never merged. The watcher now suppresses only when the
// merge-agent request/dispatch is still current-head and live.

test('watcher suppresses stale-review auto-refresh for a scoped current-head merge-agent request', async () => {
  const suppression = await getStalePostedReviewAutoRereviewSuppression({
    repoPath: 'laceyenterprises/agent-os',
    prNumber: 877,
    currentHeadSha: 'head-new',
    currentRevisionRef: 'head-new',
    labelNames: [MERGE_AGENT_REQUESTED_LABEL],
    operatorSurface: {
      observeMergeAgentOverride: async () => ({ applied: true }),
    },
  });

  assert.deepEqual(suppression, {
    suppressed: true,
    reason: 'scoped-current-head-merge-agent-requested',
  });
});

test('watcher re-arms review after awaiting-rereview handoff when merge-agent-requested is stale', async () => {
  const suppression = await getStalePostedReviewAutoRereviewSuppression({
    repoPath: 'laceyenterprises/agent-os',
    prNumber: 877,
    currentHeadSha: 'head-new',
    currentRevisionRef: 'head-new',
    labelNames: [MERGE_AGENT_REQUESTED_LABEL],
    operatorSurface: {
      observeMergeAgentOverride: async () => ({ applied: false, reason: 'stale' }),
    },
  });

  assert.deepEqual(suppression, {
    suppressed: false,
    reason: null,
  });
});

test('watcher suppresses stale-review auto-refresh only for an active current-head merge-agent dispatch', async () => {
  const suppression = await getStalePostedReviewAutoRereviewSuppression({
    repoPath: 'laceyenterprises/agent-os',
    prNumber: 877,
    currentHeadSha: 'head-new',
    labelNames: [MERGE_AGENT_DISPATCHED_LABEL],
    isMergeAgentDispatchActiveForHeadImpl: async () => ({
      active: true,
      reason: 'dispatch-running',
    }),
  });

  assert.deepEqual(suppression, {
    suppressed: true,
    reason: 'dispatch-running',
  });
});

test('watcher ignores stranded merge-agent-dispatched labels once current-head dispatch state is gone', async () => {
  const suppression = await getStalePostedReviewAutoRereviewSuppression({
    repoPath: 'laceyenterprises/agent-os',
    prNumber: 877,
    currentHeadSha: 'head-new',
    labelNames: [MERGE_AGENT_DISPATCHED_LABEL],
    isMergeAgentDispatchActiveForHeadImpl: async () => ({
      active: false,
      reason: 'dispatch-failed',
    }),
  });

  assert.deepEqual(suppression, {
    suppressed: false,
    reason: null,
  });
});

test('watcher does not suppress rereview for raw hold/stuck labels without current-head merge-agent state', async () => {
  for (const labels of [
    [MERGE_AGENT_STUCK_LABEL],
    [NO_MERGE_HOLD_LABEL],
    [MERGE_AGENT_STUCK_LABEL, NO_MERGE_HOLD_LABEL],
  ]) {
    const suppression = await getStalePostedReviewAutoRereviewSuppression({
      repoPath: 'laceyenterprises/agent-os',
      prNumber: 877,
      currentHeadSha: 'head-new',
      labelNames: labels,
    });
    assert.deepEqual(suppression, {
      suppressed: false,
      reason: null,
    });
  }
});

test('watcher allows stale-review auto-refresh for the post-budget final review', () => {
  const suppression = getStalePostedReviewBudgetSuppression({
    rootDir: '/tmp/adversarial-review-test-root',
    repoPath: 'laceyenterprises/agent-os',
    prNumber: 2587,
    linearTicketId: 'ASB-09',
    reviewRow: { review_status: 'posted' },
    summarizePRRemediationLedgerImpl: () => ({
      completedRoundsForPR: 2,
      latestRiskClass: 'medium',
      latestMaxRounds: 2,
    }),
    resolveRoundBudgetForJobImpl: (job, { rootDir }) => {
      assert.equal(rootDir, '/tmp/adversarial-review-test-root');
      assert.equal(job.linearTicketId, 'ASB-09');
      assert.equal(job.riskClass, 'medium');
      return { roundBudget: 2, riskClass: 'medium' };
    },
    countCompletedReviewerRereviewRoundsImpl: () => 0,
  });

  assert.deepEqual(suppression, {
    suppressed: false,
    reason: null,
    completedRoundsForPR: 2,
    roundBudget: 2,
    riskClass: 'medium',
  });
});

test('watcher allows stale-review auto-refresh when only in-budget rereviews are completed', () => {
  const suppression = getStalePostedReviewBudgetSuppression({
    rootDir: '/tmp/adversarial-review-test-root',
    repoPath: 'laceyenterprises/agent-os',
    prNumber: 2587,
    linearTicketId: 'ASB-09',
    reviewRow: { review_status: 'posted' },
    summarizePRRemediationLedgerImpl: () => ({
      completedRoundsForPR: 2,
      latestRiskClass: 'medium',
      latestMaxRounds: 2,
    }),
    countCompletedReviewerRereviewRoundsImpl: () => 1,
    resolveRoundBudgetForJobImpl: () => ({ roundBudget: 2, riskClass: 'medium' }),
  });

  assert.deepEqual(suppression, {
    suppressed: false,
    reason: null,
    completedRoundsForPR: 2,
    roundBudget: 2,
    riskClass: 'medium',
  });
});

test('watcher allows exactly one post-budget stale-head final review, then suppresses the next head', () => {
  const common = {
    rootDir: '/tmp/adversarial-review-test-root',
    repoPath: 'laceyenterprises/agent-os',
    prNumber: 2980,
    linearTicketId: 'ASB-09',
    reviewRow: { review_status: 'posted' },
    summarizePRRemediationLedgerImpl: () => ({
      completedRoundsForPR: 2,
      latestRiskClass: 'medium',
      latestMaxRounds: 2,
    }),
    resolveRoundBudgetForJobImpl: () => ({ roundBudget: 2, riskClass: 'medium' }),
  };

  const beforeFinalReviewPosted = getStalePostedReviewBudgetSuppression({
    ...common,
    countCompletedReviewerRereviewRoundsImpl: () => 0,
  });
  assert.deepEqual(beforeFinalReviewPosted, {
    suppressed: false,
    reason: null,
    completedRoundsForPR: 2,
    roundBudget: 2,
    riskClass: 'medium',
  });

  const beforePostBudgetFinalReviewPosted = getStalePostedReviewBudgetSuppression({
    ...common,
    countCompletedReviewerRereviewRoundsImpl: () => 1,
  });
  assert.deepEqual(beforePostBudgetFinalReviewPosted, {
    suppressed: false,
    reason: null,
    completedRoundsForPR: 2,
    roundBudget: 2,
    riskClass: 'medium',
  });

  const afterPostBudgetFinalReviewPosted = getStalePostedReviewBudgetSuppression({
    ...common,
    countCompletedReviewerRereviewRoundsImpl: () => 2,
  });
  assert.deepEqual(afterPostBudgetFinalReviewPosted, {
    suppressed: true,
    reason: 'remediation-round-budget-exhausted',
    completedRoundsForPR: 2,
    roundBudget: 2,
    riskClass: 'medium',
  });
});

test('watcher identifies explicit operator review retrigger rows', () => {
  assert.equal(isExplicitOperatorReviewRetrigger({
    rereview_requested_at: '2026-07-03T12:00:00.000Z',
    rereview_reason: 'retrigger-review label applied; re-review requested on current HEAD.',
  }), true);
});

test('watcher allows stale-review auto-refresh while remediation budget remains', () => {
  const suppression = getStalePostedReviewBudgetSuppression({
    rootDir: '/tmp/adversarial-review-test-root',
    repoPath: 'laceyenterprises/agent-os',
    prNumber: 2588,
    reviewRow: { review_status: 'posted' },
    summarizePRRemediationLedgerImpl: () => ({
      completedRoundsForPR: 1,
      latestRiskClass: 'medium',
      latestMaxRounds: 2,
    }),
    resolveRoundBudgetForJobImpl: () => ({ roundBudget: 2, riskClass: 'medium' }),
    countCompletedReviewerRereviewRoundsImpl: () => 0,
  });

  assert.deepEqual(suppression, {
    suppressed: false,
    reason: null,
    completedRoundsForPR: 1,
    roundBudget: 2,
    riskClass: 'medium',
  });
});

test('watcher suppresses completed auto-refresh rereviews at the budget without remediation jobs', () => {
  const rootDir = makeTempRoot();
  try {
    const db = openReviewStateDb(rootDir);
    ensureReviewStateSchema(db);
    for (const attemptNumber of [1, 2]) {
      db.prepare(
        `INSERT INTO reviewer_passes (
           repo, pr_number, attempt_number, reviewer_class, reviewer_model, pass_kind,
           started_at, ended_at, status, metadata_json
         ) VALUES (?, ?, ?, 'codex', 'codex', 'rereview', ?, ?, 'completed', '{}')`
      ).run(
        'laceyenterprises/agent-os',
        2600,
        attemptNumber,
        `2026-07-01T00:0${attemptNumber}:00.000Z`,
        `2026-07-01T00:0${attemptNumber}:30.000Z`,
      );
    }

    assert.equal(countCompletedReviewerRereviewRounds({
      db,
      rootDir,
      repoPath: 'laceyenterprises/agent-os',
      prNumber: 2600,
    }), 2);

    const suppression = resolveFirstPassReviewBudgetSuppression({
      rootDir,
      repoPath: 'laceyenterprises/agent-os',
      prNumber: 2600,
      reviewRow: { review_status: 'posted' },
      db,
      summarizePRRemediationLedgerImpl: () => ({
        completedRoundsForPR: 0,
        latestRiskClass: 'medium',
        latestMaxRounds: 2,
      }),
      resolveRoundBudgetForJobImpl: () => ({ roundBudget: 2, riskClass: 'medium' }),
    });

    assert.deepEqual(suppression, {
      suppressed: true,
      reason: 'remediation-round-budget-exhausted',
      completedRoundsForPR: 2,
      roundBudget: 2,
      riskClass: 'medium',
    });
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('watcher allows the owed post-budget final review even when remediation rounds exceed budget', () => {
  const suppression = resolveFirstPassReviewBudgetSuppression({
    repoPath: 'laceyenterprises/agent-os',
    prNumber: 2606,
    reviewRow: { review_status: 'posted' },
    summarizePRRemediationLedgerImpl: () => ({
      completedRoundsForPR: 3,
      latestRiskClass: 'medium',
      latestMaxRounds: 2,
    }),
    countCompletedReviewerRereviewRoundsImpl: () => 0,
    resolveRoundBudgetForJobImpl: () => ({ roundBudget: 2, riskClass: 'medium' }),
  });

  assert.deepEqual(suppression, {
    suppressed: false,
    reason: null,
    completedRoundsForPR: 3,
    roundBudget: 2,
    riskClass: 'medium',
  });
});

test('watcher allows #3033-shaped exhausted moved head until the post-budget final review completes', () => {
  const finalOwed = resolveFirstPassReviewBudgetSuppression({
    repoPath: 'laceyenterprises/adversarial-review',
    prNumber: 3033,
    reviewRow: {
      review_status: 'posted',
      reviewer_head_sha: '02c1fd11',
    },
    summarizePRRemediationLedgerImpl: () => ({
      completedRoundsForPR: 2,
      latestRiskClass: 'medium',
      latestMaxRounds: 2,
    }),
    countCompletedReviewerRereviewRoundsImpl: () => 1,
    resolveRoundBudgetForJobImpl: () => ({ roundBudget: 2, riskClass: 'medium' }),
  });

  assert.deepEqual(finalOwed, {
    suppressed: false,
    reason: null,
    completedRoundsForPR: 2,
    roundBudget: 2,
    riskClass: 'medium',
  });

  const finalCompleted = resolveFirstPassReviewBudgetSuppression({
    repoPath: 'laceyenterprises/adversarial-review',
    prNumber: 3033,
    reviewRow: {
      review_status: 'posted',
      reviewer_head_sha: '42094c99',
    },
    summarizePRRemediationLedgerImpl: () => ({
      completedRoundsForPR: 2,
      latestRiskClass: 'medium',
      latestMaxRounds: 2,
    }),
    countCompletedReviewerRereviewRoundsImpl: () => 2,
    resolveRoundBudgetForJobImpl: () => ({ roundBudget: 2, riskClass: 'medium' }),
  });

  assert.deepEqual(finalCompleted, {
    suppressed: true,
    reason: 'remediation-round-budget-exhausted',
    completedRoundsForPR: 2,
    roundBudget: 2,
    riskClass: 'medium',
  });
});

// --- Head-aware round-budget override (agent-os#3272). ---
//
// Regression for "consistently missing the last review on a remediation chain":
// after the remediation round budget was exhausted, a genuinely-new CURRENT head
// (never reviewed) was suppressed as `remediation-round-budget-exhausted`. The
// settled-gate then correctly refused to settle a stale-reviewed head, so the PR
// could neither be re-reviewed nor closed. The round budget now yields to a
// never-reviewed current head; once that head IS reviewed, the budget resumes.

test('watcher never round-budget-suppresses a never-reviewed current head past budget (agent-os#3272)', () => {
  const suppression = resolveFirstPassReviewBudgetSuppression({
    repoPath: 'laceyenterprises/agent-os',
    prNumber: 3272,
    reviewRow: {
      review_status: 'posted',
      // last review landed on the prior remediation head...
      reviewer_head_sha: '0b01bbf34',
    },
    // ...but the chain has since advanced to a never-reviewed head.
    currentHeadSha: '39adeb7c1',
    summarizePRRemediationLedgerImpl: () => ({
      completedRoundsForPR: 2,
      latestRiskClass: 'medium',
      latestMaxRounds: 2,
    }),
    // Budget is exhausted by rereview count — legacy behavior would suppress.
    countCompletedReviewerRereviewRoundsImpl: () => 2,
    resolveRoundBudgetForJobImpl: () => ({ roundBudget: 2, riskClass: 'medium' }),
  });

  assert.deepEqual(suppression, {
    suppressed: false,
    reason: null,
    completedRoundsForPR: 2,
    roundBudget: 2,
    riskClass: 'medium',
  });
});

test('watcher resumes round-budget suppression once the current head has been reviewed', () => {
  const suppression = resolveFirstPassReviewBudgetSuppression({
    repoPath: 'laceyenterprises/agent-os',
    prNumber: 3272,
    reviewRow: {
      review_status: 'posted',
      // the current head has now itself been reviewed at/over budget.
      reviewer_head_sha: '39adeb7c1',
    },
    currentHeadSha: '39adeb7c1',
    summarizePRRemediationLedgerImpl: () => ({
      completedRoundsForPR: 2,
      latestRiskClass: 'medium',
      latestMaxRounds: 2,
    }),
    countCompletedReviewerRereviewRoundsImpl: () => 2,
    resolveRoundBudgetForJobImpl: () => ({ roundBudget: 2, riskClass: 'medium' }),
  });

  assert.deepEqual(suppression, {
    suppressed: true,
    reason: 'remediation-round-budget-exhausted',
    completedRoundsForPR: 2,
    roundBudget: 2,
    riskClass: 'medium',
  });
});

test('watcher allows a re-armed current head with no recorded reviewer_head_sha past budget', () => {
  const suppression = resolveFirstPassReviewBudgetSuppression({
    repoPath: 'laceyenterprises/agent-os',
    prNumber: 3272,
    // requestReviewRereview may reset the row before spawn; the current head is
    // still un-reviewed, so the owed review must not be budget-suppressed.
    reviewRow: { review_status: 'pending' },
    currentHeadSha: '39adeb7c1',
    summarizePRRemediationLedgerImpl: () => ({
      completedRoundsForPR: 2,
      latestRiskClass: 'medium',
      latestMaxRounds: 2,
    }),
    countCompletedReviewerRereviewRoundsImpl: () => 2,
    resolveRoundBudgetForJobImpl: () => ({ roundBudget: 2, riskClass: 'medium' }),
  });

  assert.deepEqual(suppression, {
    suppressed: false,
    reason: null,
    completedRoundsForPR: 2,
    roundBudget: 2,
    riskClass: 'medium',
  });
});

test('watcher keeps remediation-worker rereview within the final-review allowance', () => {
  const withinBudget = resolveFirstPassReviewBudgetSuppression({
    repoPath: 'laceyenterprises/agent-os',
    prNumber: 2601,
    reviewRow: { review_status: 'pending' },
    summarizePRRemediationLedgerImpl: () => ({
      completedRoundsForPR: 1,
      latestRiskClass: 'medium',
      latestMaxRounds: 2,
    }),
    countCompletedReviewerRereviewRoundsImpl: () => 1,
    resolveRoundBudgetForJobImpl: () => ({ roundBudget: 2, riskClass: 'medium' }),
  });
  assert.deepEqual(withinBudget, {
    suppressed: false,
    reason: null,
    completedRoundsForPR: 1,
    roundBudget: 2,
    riskClass: 'medium',
  });

  assert.equal(isTerminalCloserCommitIdentity({
    message: 'Fix backlog item\n\nWorker-Class: codex',
    commit: {
      committer: {
        name: 'codex',
        email: 'codex@example.com',
      },
    },
  }).suppressed, false);

  const finalAllowed = resolveFirstPassReviewBudgetSuppression({
    repoPath: 'laceyenterprises/agent-os',
    prNumber: 2602,
    reviewRow: { review_status: 'pending' },
    summarizePRRemediationLedgerImpl: () => ({
      completedRoundsForPR: 2,
      latestRiskClass: 'medium',
      latestMaxRounds: 2,
    }),
    countCompletedReviewerRereviewRoundsImpl: () => 0,
    resolveRoundBudgetForJobImpl: () => ({ roundBudget: 2, riskClass: 'medium' }),
  });
  assert.deepEqual(finalAllowed, {
    suppressed: false,
    reason: null,
    completedRoundsForPR: 2,
    roundBudget: 2,
    riskClass: 'medium',
  });
});

test('watcher suppresses closer identity commits even when budget remains', async () => {
  assert.deepEqual(isTerminalCloserCommitIdentity({
    message: 'Close resolved PR\n\nClosed-By: hammer (adversarial-pipe-mode)',
    commit: {
      committer: {
        name: 'Codex Remediation Worker',
        email: 'codex-remediation-worker@example.com',
      },
    },
  }), {
    suppressed: true,
    reason: 'closer-commit-trailer',
    matched: 'Closed-By',
  });
  assert.deepEqual(isTerminalCloserCommitIdentity({
    message: 'Close resolved PR',
    trailers: [
      { key: 'Closed-By', value: 'hammer (adversarial-pipe-mode)' },
    ],
  }), {
    suppressed: true,
    reason: 'closer-commit-trailer',
    matched: 'Closed-By',
  });
  assert.deepEqual(isTerminalCloserCommitIdentity({
    message: 'Close resolved PR',
    trailers: [
      { ClosedBy: 'not-a-supported-trailer-shape' },
    ],
  }), {
    suppressed: false,
    reason: null,
  });

  assert.equal(isTerminalCloserCommitIdentity({
    message: 'Finalize PR',
    committer: { login: 'merge-agent-lacey' },
    commit: {
      committer: {
        name: 'Merge Agent Worker',
        email: '282134940+merge-agent-lacey@users.noreply.github.com',
      },
    },
  }).reason, 'closer-commit-identity');

  const viaProbe = await getHeadCloserCommitSuppression({
    repoPath: 'laceyenterprises/agent-os',
    prNumber: 2603,
    headSha: 'abc123',
    execFileImpl: async () => ({
      stdout: JSON.stringify({
        sha: 'abc123',
        message: 'Finalize PR',
        committerLogin: 'merge-agent-lacey',
        authorLogin: null,
        committerName: 'Merge Agent Worker',
        committerEmail: '282134940+merge-agent-lacey@users.noreply.github.com',
      }),
    }),
  });
  assert.equal(viaProbe.suppressed, true);
  assert.equal(viaProbe.reason, 'closer-commit-identity');
});

test('watcher budget probe fails open without crashing', () => {
  const warnings = [];
  const budgetSuppression = resolveFirstPassReviewBudgetSuppression({
    repoPath: 'laceyenterprises/agent-os',
    prNumber: 2604,
    summarizePRRemediationLedgerImpl: () => {
      throw new Error('ledger unavailable');
    },
    logger: { warn: (message) => warnings.push(message) },
  });
  assert.equal(budgetSuppression.suppressed, false);
  assert.equal(budgetSuppression.reason, null);
  assert.equal(budgetSuppression.probeError, 'ledger unavailable');
  assert.equal(warnings.length, 1);
});

test('watcher retries transient closer identity probe failures before suppressing', async () => {
  const warnings = [];
  let calls = 0;
  const identitySuppression = await getHeadCloserCommitSuppression({
    repoPath: 'laceyenterprises/agent-os',
    prNumber: 2604,
    headSha: 'def456',
    execFileImpl: async () => {
      calls += 1;
      if (calls === 1) {
        const err = new Error('TLS handshake timeout');
        err.stderr = 'TLS handshake timeout';
        throw err;
      }
      if (calls === 2) {
        const err = new Error('secondary rate limit');
        err.stderr = 'secondary rate limit';
        throw err;
      }
      return {
        stdout: JSON.stringify({
          sha: 'def456',
          message: 'Finalize PR',
          committerLogin: 'merge-agent-lacey',
          authorLogin: null,
          committerName: 'Merge Agent Worker',
          committerEmail: '282134940+merge-agent-lacey@users.noreply.github.com',
        }),
      };
    },
    logger: { warn: (message) => warnings.push(message) },
    retryBackoffMs: [1, 1],
    sleepImpl: async () => {},
  });
  assert.equal(calls, 3);
  assert.equal(identitySuppression.suppressed, true);
  assert.equal(identitySuppression.reason, 'closer-commit-identity');
  assert.equal(warnings.length, 0);
});

test('watcher fails closed on non-transient closer identity probe errors', async () => {
  const warnings = [];
  await assert.rejects(
    getHeadCloserCommitSuppression({
      repoPath: 'laceyenterprises/agent-os',
      prNumber: 2604,
      headSha: 'def456',
      execFileImpl: async () => {
        const err = new Error('HTTP 404 Not Found');
        err.stderr = 'HTTP 404 Not Found';
        throw err;
      },
      logger: { warn: (message) => warnings.push(message) },
      retryBackoffMs: [1],
      sleepImpl: async () => {},
    }),
    /HTTP 404 Not Found/
  );
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /failing closed/);
  assert.doesNotMatch(warnings[0], /transient=/);
});

test('watcher closer identity resolver reuses the same commit probe result', async () => {
  let calls = 0;
  const resolveSuppression = createHeadCloserCommitSuppressionResolver({
    repoPath: 'laceyenterprises/agent-os',
    prNumber: 2605,
    headSha: 'fed789',
    execFileImpl: async () => {
      calls += 1;
      return {
        stdout: JSON.stringify({
          sha: 'fed789',
          message: 'Finalize PR',
          committerLogin: 'merge-agent-lacey',
          authorLogin: null,
          committerName: 'Merge Agent Worker',
          committerEmail: '282134940+merge-agent-lacey@users.noreply.github.com',
        }),
      };
    },
  });

  const first = await resolveSuppression();
  const second = await resolveSuppression();
  assert.equal(calls, 1);
  assert.equal(first, second);
  assert.equal(first.suppressed, true);
});

test('watcher recognizes explicit operator retrigger-review override marker', () => {
  assert.equal(isExplicitOperatorReviewRetrigger({
    rereview_requested_at: '2026-07-01T12:00:00.000Z',
    rereview_reason: 'retrigger-review label applied; re-review requested on current HEAD.',
  }), true);
  assert.equal(isExplicitOperatorReviewRetrigger({
    rereview_requested_at: '2026-07-01T12:00:00.000Z',
    rereview_reason: 'auto-refresh: posted review on stale head aaa; current head is bbb',
  }), false);
});

test('watcher preserves elevated legacy budgets before suppressing stale-review auto-refresh', () => {
  const suppression = getStalePostedReviewBudgetSuppression({
    rootDir: '/tmp/adversarial-review-test-root',
    repoPath: 'laceyenterprises/agent-os',
    prNumber: 2589,
    reviewRow: { review_status: 'posted' },
    summarizePRRemediationLedgerImpl: () => ({
      completedRoundsForPR: 2,
      latestRiskClass: 'medium',
      latestMaxRounds: 6,
    }),
    resolveRoundBudgetForJobImpl: () => ({ roundBudget: 2, riskClass: 'medium' }),
    countCompletedReviewerRereviewRoundsImpl: () => 0,
  });

  assert.deepEqual(suppression, {
    suppressed: false,
    reason: null,
    completedRoundsForPR: 2,
    roundBudget: 6,
    riskClass: 'medium',
  });
});

test('watcher treats null latestMaxRounds as absent when resolving stale-review budget', () => {
  const suppression = getStalePostedReviewBudgetSuppression({
    rootDir: '/tmp/adversarial-review-test-root',
    repoPath: 'laceyenterprises/agent-os',
    prNumber: 2590,
    reviewRow: { review_status: 'posted' },
    summarizePRRemediationLedgerImpl: () => ({
      completedRoundsForPR: 1,
      latestRiskClass: 'medium',
      latestMaxRounds: null,
    }),
    resolveRoundBudgetForJobImpl: () => ({ roundBudget: -1, riskClass: 'medium' }),
    countCompletedReviewerRereviewRoundsImpl: () => 0,
  });

  assert.deepEqual(suppression, {
    suppressed: false,
    reason: null,
    completedRoundsForPR: 1,
    roundBudget: -1,
    riskClass: 'medium',
  });
});

test('watcher suppresses stale-review auto-refresh when review-cycle cap is already paused', () => {
  const fromLabel = getStalePostedReviewBudgetSuppression({
    repoPath: 'laceyenterprises/agent-os',
    prNumber: 2591,
    reviewRow: { review_status: 'posted' },
    labelNames: [REVIEWER_CYCLE_CAP_REACHED_LABEL],
    summarizePRRemediationLedgerImpl: () => {
      throw new Error('label pause should short-circuit before ledger read');
    },
  });

  assert.deepEqual(fromLabel, {
    suppressed: true,
    reason: 'review-cycle-cap-paused',
  });

  const fromRow = getStalePostedReviewBudgetSuppression({
    repoPath: 'laceyenterprises/agent-os',
    prNumber: 2592,
    reviewRow: {
      review_status: 'failed',
      failure_message: '[review-cycle-cap] automatic review paused after 5 successive cycles',
    },
    summarizePRRemediationLedgerImpl: () => {
      throw new Error('row pause should short-circuit before ledger read');
    },
  });

  assert.deepEqual(fromRow, {
    suppressed: true,
    reason: 'review-cycle-cap-paused',
  });
});

test('MSM-04: exhausted stale posted review uses stable dispatch key with proved live HAM target', async () => {
  const rootDir = makeTempRoot();
  try {
    let liveReviewFetches = 0;
    const captured = [];
    const warnings = [];
    let closerProofCalls = 0;
    const currentHead = '6358df76358df76358df76358df76358df76358d';
    const staleReviewedHead = 'c727df4c727df4c727df4c727df4c727df4c727d';

    const result = await maybeDispatchAmaClosureFor({
      rootDir,
      repoPath: 'laceyenterprises/agent-os',
      prNumber: 3084,
      currentRevisionRef: currentHead,
      reviewStateRow: {
        repo: 'laceyenterprises/agent-os',
        pr_number: 3084,
        review_status: 'posted',
        reviewer: 'codex',
        reviewer_head_sha: staleReviewedHead,
        body_md: 'Verdict: Comment only\n\n## Blocking Issues\n- None.',
      },
      candidate: {
        headSha: currentHead,
        prState: 'open',
        isDraft: false,
        mergeable: 'MERGEABLE',
        mergeStateStatus: 'CLEAN',
        statusCheckRollup: [
          { __typename: 'CheckRun', name: 'test', conclusion: 'SUCCESS' },
        ],
        branchProtection: { requiredContexts: ['agent-os/adversarial-gate'] },
        prAuthor: 'codex-worker-bot',
        prUpdatedAt: '2026-07-04T12:00:00Z',
      },
      dispatchJob: { prUpdatedAt: '2026-07-04T12:00:00Z' },
      labelNames: [],
      loadConfigImpl: () => ({
        getMergeAuthorityConfig: () => ({
          enabled: true,
          workerClass: 'hammer',
          autoHammerOnEligibilityMiss: true,
          mergeMethod: 'squash',
          eligibility: { riskClasses: ['medium'] },
          branchProtection: {},
        }),
        getOrchestrationMode: () => 'native',
      }),
      resolveReviewCycleExhaustionImpl: () => ({
        reviewCycleExhausted: true,
        ledgerRiskClass: 'medium',
      }),
      resolveHeadCloserCommitSuppressionImpl: async ({ headSha }) => {
        closerProofCalls += 1;
        assert.equal(headSha, currentHead);
        return { suppressed: true, reason: 'closer-commit-trailer' };
      },
      fetchLatestHeadReviewBodiesImpl: async () => {
        liveReviewFetches += 1;
        throw new Error('fresh review lookup must not run on exhausted stale head');
      },
      maybeDispatchAmaCloserImpl: async (args) => {
        captured.push(args);
        return {
          dispatched: true,
          workerClass: 'hammer',
          dispatchId: 'dispatch-3084-current-head',
        };
      },
      logger: {
        warn(message) {
          warnings.push(message);
        },
        log() {},
      },
    });

    assert.equal(result.dispatched, true);
    assert.equal(captured.length, 1);
    assert.equal(captured[0].reviewState.reviewCycleExhausted, true);
    assert.equal(captured[0].reviewState.headSha, staleReviewedHead);
    assert.equal(captured[0].dispatchContext.reviewedSha, staleReviewedHead);
    assert.equal(captured[0].dispatchContext.targetRemediationSha, currentHead);
    assert.equal(captured[0].dispatchContext.dispatchRecordHeadSha, staleReviewedHead);
    assert.equal(captured[0].dispatchContext.dispatchReason, 'exhausted-final-hammer');
    assert.equal(captured[0].dispatchContext.allowStaleReviewHeadHammerResume, true);
    assert.equal(captured[0].prMetadata.headSha, currentHead);
    assert.equal(closerProofCalls, 1);
    assert.equal(liveReviewFetches, 0, 'no fresh adversarial review lookup is requested on exhaustion');
    assert.equal(warnings.join('\n').includes('no fresh adversarial review'), false);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});
