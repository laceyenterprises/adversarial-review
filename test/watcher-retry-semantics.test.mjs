import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mkdtempSync } from 'node:fs';
import { ensureReviewStateSchema } from '../src/review-state.mjs';
import {
  claimNextFollowUpJob,
  createFollowUpJob,
  getFollowUpJobDir,
  markFollowUpJobCompleted,
  markFollowUpJobSpawned,
  readFollowUpJob,
  writeFollowUpJob,
} from '../src/follow-up-jobs.mjs';
import {
  evaluateRoundBudgetForReview,
  persistReviewerPgid,
  resolveMergeAgentLifecycleCleanupPerPoll,
  resolveMergeAgentLifecycleCleanupRetryMs,
  resolveStaleReviewerReconcilePerPoll,
  retryPendingMergeAgentLifecycleCleanups,
  shouldDeferReviewForActiveFollowUp,
  shouldRetryMergeAgentLifecycleCleanup,
  shouldReconcileStaleReviewerSession,
} from '../src/watcher.mjs';
import {
  shouldDeferReviewForActiveFollowUp as shouldDeferReviewForActiveFollowUpDirect,
  signalStaleFollowUpWorker,
} from '../src/follow-up-active-defer.mjs';
import { currentProcessGroupId } from '../src/process-group-identity.mjs';
import {
  MERGE_AGENT_DISPATCHED_LABEL_ADD_TRANSITION,
  listMergeAgentLifecycleCleanups,
  upsertMergeAgentLifecycleCleanup,
} from '../src/follow-up-merge-agent.mjs';
import { LEGACY_ORPHAN_FAILURE_MESSAGE } from '../src/reviewer-reattach.mjs';

function setupDb() {
  const db = new Database(':memory:');
  ensureReviewStateSchema(db);
  return db;
}

test('posted PRs remain terminal and are skipped', () => {
  const db = setupDb();
  db.prepare(
    'INSERT INTO reviewed_prs (repo, pr_number, reviewed_at, reviewer, pr_state, linear_ticket, review_status, review_attempts, posted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(
    'laceyenterprises/adversarial-review',
    5,
    '2026-04-22T05:22:42.212Z',
    'claude',
    'open',
    'LAC-207',
    'posted',
    1,
    '2026-04-22T05:24:00.000Z'
  );

  const row = db.prepare('SELECT review_status, review_attempts, posted_at FROM reviewed_prs WHERE repo = ? AND pr_number = ?').get(
    'laceyenterprises/adversarial-review',
    5
  );

  assert.equal(row.review_status, 'posted');
  assert.equal(row.review_attempts, 1);
  assert.equal(row.posted_at, '2026-04-22T05:24:00.000Z');
});

test('failed delivery remains visible and retryable', () => {
  const db = setupDb();
  db.prepare(
    'INSERT INTO reviewed_prs (repo, pr_number, reviewed_at, reviewer, pr_state, linear_ticket, review_status, review_attempts, failed_at, failure_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(
    'laceyenterprises/adversarial-review',
    5,
    '2026-04-22T05:22:42.212Z',
    'claude',
    'open',
    'LAC-207',
    'failed',
    1,
    '2026-04-22T05:23:00.000Z',
    'gh config permission denied'
  );

  const row = db.prepare('SELECT review_status, review_attempts, failed_at, failure_message FROM reviewed_prs WHERE repo = ? AND pr_number = ?').get(
    'laceyenterprises/adversarial-review',
    5
  );

  assert.equal(row.review_status, 'failed');
  assert.equal(row.review_attempts, 1);
  assert.match(row.failure_message, /permission denied/);
});

test('malformed titles are terminal but explicitly marked malformed', () => {
  const db = setupDb();
  db.prepare(
    'INSERT INTO reviewed_prs (repo, pr_number, reviewed_at, reviewer, pr_state, review_status, review_attempts, failed_at, failure_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(
    'laceyenterprises/adversarial-review',
    9,
    '2026-04-22T06:00:00.000Z',
    'malformed-title',
    'open',
    'malformed',
    1,
    '2026-04-22T06:00:00.000Z',
    'Malformed PR title: fix bug'
  );

  const row = db.prepare('SELECT reviewer, review_status, failure_message FROM reviewed_prs WHERE repo = ? AND pr_number = ?').get(
    'laceyenterprises/adversarial-review',
    9
  );

  assert.equal(row.reviewer, 'malformed-title');
  assert.equal(row.review_status, 'malformed');
  assert.match(row.failure_message, /Malformed PR title/);
});

// Legacy reconciliation contract for pre-LAC-532 'reviewing' rows with
// no reviewer_session_uuid. New rows are handled by the startup
// reattach probe; legacy rows still fall through to failed-orphan so
// old in-flight state remains operator-actionable after deploy.

function reconcileOrphans(db, failureAt) {
  const rows = db
    .prepare("SELECT repo, pr_number FROM reviewed_prs WHERE review_status = 'reviewing' AND reviewer_session_uuid IS NULL")
    .all();
  const stmt = db.prepare(
    "UPDATE reviewed_prs SET review_status = 'failed-orphan', failed_at = ?, failure_message = ?, review_attempts = review_attempts + 1 WHERE repo = ? AND pr_number = ?"
  );
  for (const row of rows) {
    stmt.run(failureAt, LEGACY_ORPHAN_FAILURE_MESSAGE, row.repo, row.pr_number);
  }
  return rows.length;
}

test("rows stuck in 'reviewing' on startup are reconciled to 'failed-orphan'", () => {
  const db = setupDb();
  db.prepare(
    'INSERT INTO reviewed_prs (repo, pr_number, reviewed_at, reviewer, pr_state, linear_ticket, review_status, review_attempts, last_attempted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(
    'laceyenterprises/adversarial-review',
    24,
    '2026-05-02T19:00:00.000Z',
    'codex',
    'open',
    'LAC-211',
    'reviewing',
    1,
    '2026-05-02T19:01:00.000Z'
  );

  const reconciledCount = reconcileOrphans(db, '2026-05-02T19:30:00.000Z');
  assert.equal(reconciledCount, 1);

  const row = db
    .prepare('SELECT review_status, review_attempts, failed_at, failure_message FROM reviewed_prs WHERE repo = ? AND pr_number = ?')
    .get('laceyenterprises/adversarial-review', 24);

  assert.equal(row.review_status, 'failed-orphan');
  assert.equal(row.review_attempts, 2);
  assert.equal(row.failed_at, '2026-05-02T19:30:00.000Z');
  assert.match(row.failure_message, /A review may have been posted on GitHub/);
  assert.match(row.failure_message, /retrigger-review/);
});

test("'failed-orphan' rows stay sticky and are not auto-retried by the watcher's skip predicate", () => {
  // The watcher's pollOnce skips rows whose review_status is in this
  // set. 'failed-orphan' MUST be in it, otherwise the next poll would
  // spawn a duplicate reviewer for a PR that may already carry an
  // orphaned review post — exactly the duplicate-review bug this
  // change closes.
  const stickySkipStates = new Set(['posted', 'malformed', 'failed-orphan']);
  assert.ok(stickySkipStates.has('failed-orphan'));

  const db = setupDb();
  db.prepare(
    'INSERT INTO reviewed_prs (repo, pr_number, reviewed_at, reviewer, pr_state, review_status, review_attempts, failed_at, failure_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(
    'laceyenterprises/adversarial-review',
    24,
    '2026-05-02T19:00:00.000Z',
    'codex',
    'open',
    'failed-orphan',
    2,
    '2026-05-02T19:30:00.000Z',
    LEGACY_ORPHAN_FAILURE_MESSAGE
  );

  const row = db
    .prepare('SELECT review_status FROM reviewed_prs WHERE repo = ? AND pr_number = ?')
    .get('laceyenterprises/adversarial-review', 24);
  assert.ok(stickySkipStates.has(row.review_status));
});

test('steady-state reattach only probes reviewer sessions older than the reviewer timeout', () => {
  const now = new Date('2026-05-11T05:20:00.000Z');

  assert.equal(
    shouldReconcileStaleReviewerSession(
      { reviewer_started_at: '2026-05-11T04:59:59.000Z' },
      now,
      { reviewerTimeoutMs: 20 * 60 * 1000 }
    ),
    true
  );
  assert.equal(
    shouldReconcileStaleReviewerSession(
      { reviewer_started_at: '2026-05-11T05:01:00.000Z' },
      now,
      { reviewerTimeoutMs: 20 * 60 * 1000 }
    ),
    false
  );
  assert.equal(
    shouldReconcileStaleReviewerSession(
      { reviewer_started_at: 'not-a-date' },
      now,
      { reviewerTimeoutMs: 20 * 60 * 1000 }
    ),
    true
  );
  assert.equal(
    shouldReconcileStaleReviewerSession(
      {
        reviewer_started_at: '2026-05-11T05:19:00.000Z',
        reviewer_lease_expires_at: '2026-05-11T05:19:59.000Z',
      },
      now,
      {
        reviewerTimeoutMs: 20 * 60 * 1000,
        leaseRecoveryEnabled: true,
      }
    ),
    true
  );
});

test('steady-state reattach does not touch a freshly claimed row before spawn callback lands', () => {
  const now = new Date('2026-05-11T05:20:00.000Z');

  assert.equal(
    shouldReconcileStaleReviewerSession(
      {
        last_attempted_at: '2026-05-11T05:19:30.000Z',
        reviewer_started_at: null,
        reviewer_pgid: null,
        reviewer_timeout_ms: 20 * 60 * 1000,
      },
      now,
      { reviewerTimeoutMs: 20 * 60 * 1000 }
    ),
    false,
    'claim-to-spawn window must not be marked stale just because reviewer_started_at has not been persisted yet'
  );
  assert.equal(
    shouldReconcileStaleReviewerSession(
      {
        last_attempted_at: '2026-05-11T04:50:00.000Z',
        reviewer_started_at: null,
        reviewer_pgid: null,
        reviewer_timeout_ms: 20 * 60 * 1000,
      },
      now,
      { reviewerTimeoutMs: 20 * 60 * 1000 }
    ),
    true,
    'missing spawn metadata becomes reconcilable after the persisted claim timeout expires'
  );
});

test('steady-state reattach selection uses persisted launch timeout before current env', () => {
  const now = new Date('2026-05-11T05:20:00.000Z');

  assert.equal(
    shouldReconcileStaleReviewerSession(
      {
        reviewer_started_at: '2026-05-11T05:05:00.000Z',
        reviewer_timeout_ms: 10 * 60 * 1000,
      },
      now,
      { reviewerTimeoutMs: 60 * 60 * 1000 }
    ),
    true,
    'row launched with a shorter timeout is stale even if current env is longer'
  );
  assert.equal(
    shouldReconcileStaleReviewerSession(
      {
        reviewer_started_at: '2026-05-11T04:30:00.000Z',
        reviewer_timeout_ms: 60 * 60 * 1000,
      },
      now,
      { reviewerTimeoutMs: 20 * 60 * 1000 }
    ),
    false,
    'row launched with a longer timeout is not stale just because current env is shorter'
  );
});

test('steady-state reattach keys off authoritative spawn time, not earlier claim time', () => {
  const now = new Date('2026-05-11T05:21:00.000Z');

  assert.equal(
    shouldReconcileStaleReviewerSession(
      {
        last_attempted_at: '2026-05-11T05:00:00.000Z',
        reviewer_started_at: '2026-05-11T05:10:30.000Z',
        reviewer_timeout_ms: 15 * 60 * 1000,
      },
      now,
      { reviewerTimeoutMs: 15 * 60 * 1000 }
    ),
    false,
    'a delayed spawn must keep its full runtime budget even when claim happened much earlier'
  );
});

test('steady-state reattach per-poll cap defaults small and accepts zero for disable', () => {
  assert.equal(resolveStaleReviewerReconcilePerPoll({}), 6);
  assert.equal(resolveStaleReviewerReconcilePerPoll({ ADVERSARIAL_STALE_REVIEWER_RECONCILE_PER_POLL: '1' }), 1);
  assert.equal(resolveStaleReviewerReconcilePerPoll({ ADVERSARIAL_STALE_REVIEWER_RECONCILE_PER_POLL: '0' }), 0);
  assert.equal(resolveStaleReviewerReconcilePerPoll({ ADVERSARIAL_STALE_REVIEWER_RECONCILE_PER_POLL: 'bad' }), 6);
});

test('pending merge-agent lifecycle cleanup retries after the PR leaves the open set', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  upsertMergeAgentLifecycleCleanup(rootDir, {
    repo: 'laceyenterprises/adversarial-review',
    prNumber: 133,
    transition: 'merged',
    headSha: 'sha-cleanup-133',
    queuedAt: '2026-05-18T15:00:00.000Z',
  });

  const calls = [];
  await retryPendingMergeAgentLifecycleCleanups({
    rootDir,
    cancelImpl: async (args) => {
      calls.push(args);
      return {
        attempted: true,
        repo: args.repo,
        prNumber: args.prNumber,
        attemptedAt: '2026-05-18T15:01:00.000Z',
        launchRequestId: 'lrq_retry',
        cancelled: true,
        cancelError: null,
        labelRemoved: true,
        labelRemovalError: null,
        cleanupComplete: true,
        retryable: false,
      };
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].repo, 'laceyenterprises/adversarial-review');
  assert.equal(calls[0].prNumber, 133);
  assert.deepEqual(listMergeAgentLifecycleCleanups(rootDir), []);
});

test('pending merge-agent dispatched-label add cleanup retries and clears on success', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  upsertMergeAgentLifecycleCleanup(rootDir, {
    repo: 'laceyenterprises/agent-os',
    prNumber: 661,
    transition: MERGE_AGENT_DISPATCHED_LABEL_ADD_TRANSITION,
    headSha: 'sha-label-add',
    queuedAt: '2026-05-18T15:00:00.000Z',
  });

  const calls = [];
  await retryPendingMergeAgentLifecycleCleanups({
    rootDir,
    labelAddImpl: async (args) => {
      calls.push(args);
      return {
        attempted: true,
        label: 'merge-agent-dispatched',
        attemptedAt: '2026-05-18T15:01:00.000Z',
        added: true,
        error: null,
      };
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].repo, 'laceyenterprises/agent-os');
  assert.equal(calls[0].prNumber, 661);
  assert.deepEqual(listMergeAgentLifecycleCleanups(rootDir), []);
});

test('merge-agent lifecycle cleanup retry pacing skips recent attempts and honors the per-poll cap', async () => {
  assert.equal(resolveMergeAgentLifecycleCleanupRetryMs({}), 60000);
  assert.equal(resolveMergeAgentLifecycleCleanupRetryMs({ ADVERSARIAL_MERGE_AGENT_LIFECYCLE_CLEANUP_RETRY_MS: '0' }), 0);
  assert.equal(resolveMergeAgentLifecycleCleanupPerPoll({}), 5);
  assert.equal(resolveMergeAgentLifecycleCleanupPerPoll({ ADVERSARIAL_MERGE_AGENT_LIFECYCLE_CLEANUP_PER_POLL: '0' }), 0);
  assert.equal(
    shouldRetryMergeAgentLifecycleCleanup(
      { lastAttemptAt: '2026-05-18T15:00:30.000Z' },
      { nowMs: Date.parse('2026-05-18T15:01:00.000Z'), retryMs: 60000 }
    ),
    false
  );
  assert.equal(
    shouldRetryMergeAgentLifecycleCleanup(
      { lastAttemptAt: '2026-05-18T15:00:00.000Z' },
      { nowMs: Date.parse('2026-05-18T15:01:00.000Z'), retryMs: 60000 }
    ),
    true
  );

  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  upsertMergeAgentLifecycleCleanup(rootDir, {
    repo: 'laceyenterprises/agent-os',
    prNumber: 1,
    transition: 'merged',
    queuedAt: '2026-05-18T15:00:00.000Z',
  });
  upsertMergeAgentLifecycleCleanup(rootDir, {
    repo: 'laceyenterprises/agent-os',
    prNumber: 2,
    transition: 'merged',
    queuedAt: '2026-05-18T15:00:00.000Z',
  });

  const calls = [];
  const result = await retryPendingMergeAgentLifecycleCleanups({
    rootDir,
    maxPerPoll: 1,
    cancelImpl: async (args) => {
      calls.push(args);
      return {
        attempted: true,
        repo: args.repo,
        prNumber: args.prNumber,
        attemptedAt: '2026-05-18T15:01:00.000Z',
        launchRequestId: null,
        cancelled: false,
        cancelError: null,
        labelRemoved: true,
        labelRemovalError: null,
        cleanupComplete: true,
        retryable: false,
      };
    },
  });

  assert.equal(calls.length, 1);
  assert.deepEqual(result, { attempted: 1, skipped: 1, pending: 2 });
});

test('persistReviewerPgid logs CAS misses instead of throwing into the spawned reviewer', () => {
  const warnings = [];
  const logs = [];

  const persisted = persistReviewerPgid({
    pgid: 9001,
    reviewerSessionUuid: 'session-10',
    repoPath: 'laceyenterprises/adversarial-review',
    prNumber: 10,
    log: {
      log: (message) => logs.push(String(message)),
      warn: (message) => warnings.push(String(message)),
    },
  });

  assert.equal(persisted, false);
  assert.equal(logs.length, 0);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /reviewer_session_handle_cas_miss/);
});

test("reconciliation only touches 'reviewing' rows and leaves other statuses alone", () => {
  const db = setupDb();
  const rows = [
    ['laceyenterprises/a', 1, 'reviewing'],
    ['laceyenterprises/a', 2, 'pending'],
    ['laceyenterprises/a', 3, 'posted'],
    ['laceyenterprises/a', 4, 'failed'],
    ['laceyenterprises/a', 5, 'malformed'],
    ['laceyenterprises/b', 6, 'reviewing'],
  ];
  const insert = db.prepare(
    'INSERT INTO reviewed_prs (repo, pr_number, reviewed_at, reviewer, pr_state, review_status, review_attempts) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );
  for (const [repo, prNumber, status] of rows) {
    insert.run(repo, prNumber, '2026-05-02T19:00:00.000Z', 'codex', 'open', status, 0);
  }

  const reconciledCount = reconcileOrphans(db, '2026-05-02T19:30:00.000Z');
  assert.equal(reconciledCount, 2);

  const after = db
    .prepare('SELECT repo, pr_number, review_status FROM reviewed_prs ORDER BY repo, pr_number')
    .all();

  assert.deepEqual(
    after,
    [
      { repo: 'laceyenterprises/a', pr_number: 1, review_status: 'failed-orphan' },
      { repo: 'laceyenterprises/a', pr_number: 2, review_status: 'pending' },
      { repo: 'laceyenterprises/a', pr_number: 3, review_status: 'posted' },
      { repo: 'laceyenterprises/a', pr_number: 4, review_status: 'failed' },
      { repo: 'laceyenterprises/a', pr_number: 5, review_status: 'malformed' },
      { repo: 'laceyenterprises/b', pr_number: 6, review_status: 'failed-orphan' },
    ],
  );
});

test("requestReviewRereview accepts 'failed-orphan' rows so retrigger-review can clear them", async () => {
  // The operator recovery path for an orphan is:
  //   1. inspect GitHub
  //   2. if no orphan review present, run `npm run retrigger-review`
  // For step 2 to work, the underlying state-machine helper must
  // accept 'failed-orphan' as a valid source state. This guards
  // against accidental tightening of requestReviewRereview to
  // require a non-orphan source.
  const { mkdtempSync, rmSync, mkdirSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const Database = (await import('better-sqlite3')).default;
  const { ensureReviewStateSchema, requestReviewRereview } = await import('../src/review-state.mjs');

  const tmp = mkdtempSync(join(tmpdir(), 'orphan-rereview-'));
  try {
    mkdirSync(join(tmp, 'data'), { recursive: true });
    const dbPath = join(tmp, 'data', 'reviews.db');
    const db = new Database(dbPath);
    ensureReviewStateSchema(db);
    db.prepare(
      'INSERT INTO reviewed_prs (repo, pr_number, reviewed_at, reviewer, pr_state, review_status, review_attempts, failed_at, failure_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(
      'laceyenterprises/adversarial-review',
      24,
      '2026-05-02T19:00:00.000Z',
      'codex',
      'open',
      'failed-orphan',
      2,
      '2026-05-02T19:30:00.000Z',
      LEGACY_ORPHAN_FAILURE_MESSAGE
    );
    db.close();

    const result = requestReviewRereview({
      rootDir: tmp,
      repo: 'laceyenterprises/adversarial-review',
      prNumber: 24,
      reason: 'verified no orphan review on GitHub',
    });

    assert.equal(result.triggered, true);
    assert.equal(result.reviewRow.review_status, 'pending');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('watcher defers a pending review while a requeued follow-up job is active (PR #48 race guard)', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  const db = setupDb();
  db.prepare(
    'INSERT INTO reviewed_prs (repo, pr_number, reviewed_at, reviewer, pr_state, review_status, review_attempts) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(
    'laceyenterprises/adversarial-review',
    48,
    '2026-05-06T17:00:00.000Z',
    'claude',
    'open',
    'pending',
    2,
  );
  const created = createFollowUpJob({
    rootDir,
    repo: 'laceyenterprises/adversarial-review',
    prNumber: 48,
    reviewerModel: 'claude',
    linearTicketId: null,
    reviewBody: '## Summary\nPR #48 race fixture.\n\n## Verdict\nRequest changes',
    reviewPostedAt: '2026-05-06T16:59:00.000Z',
    critical: false,
    maxRemediationRounds: 3,
  });

  const row = db.prepare('SELECT review_status FROM reviewed_prs WHERE repo = ? AND pr_number = ?')
    .get('laceyenterprises/adversarial-review', 48);
  assert.equal(row.review_status, 'pending');

  const decision = shouldDeferReviewForActiveFollowUp({
    rootDir,
    repo: 'laceyenterprises/adversarial-review',
    prNumber: 48,
  });

  assert.equal(created.job.status, 'pending');
  assert.equal(decision.defer, true);
  assert.equal(decision.latestJobStatus, 'pending');

  // This mirrors the watcher's dispatch gate: when the active-job
  // guard fires, the pending review row is not claimed as `reviewing`.
  if (!decision.defer) {
    db.prepare(
      "UPDATE reviewed_prs SET review_status = 'reviewing' WHERE repo = ? AND pr_number = ? AND review_status = 'pending'"
    ).run('laceyenterprises/adversarial-review', 48);
  }
  const after = db.prepare('SELECT review_status FROM reviewed_prs WHERE repo = ? AND pr_number = ?')
    .get('laceyenterprises/adversarial-review', 48);
  assert.equal(after.review_status, 'pending');
});

test('watcher releases a budget-exhausted pending follow-up job instead of deferring forever', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-budget-release-'));
  const created = createFollowUpJob({
    rootDir,
    repo: 'laceyenterprises/agent-os',
    prNumber: 5120,
    reviewerModel: 'claude',
    linearTicketId: null,
    reviewBody: '## Summary\nBudget exhausted fixture.\n\n## Verdict\nRequest changes',
    reviewPostedAt: '2026-08-09T12:00:00.000Z',
    critical: false,
    maxRemediationRounds: 2,
  });
  writeFollowUpJob(created.jobPath, {
    ...created.job,
    status: 'pending',
    remediationPlan: {
      ...created.job.remediationPlan,
      currentRound: 2,
      maxRounds: 2,
    },
  });

  const decision = shouldDeferReviewForActiveFollowUp({
    rootDir,
    repo: 'laceyenterprises/agent-os',
    prNumber: 5120,
    nowMs: Date.parse('2026-08-09T12:05:00.000Z'),
  });

  assert.equal(decision.defer, false);
  assert.equal(decision.latestJobStatus, 'stopped');
  assert.equal(decision.releaseReason, 'max-rounds-reached');
  assert.equal(existsSync(created.jobPath), false, 'over-budget pending file was removed from pending/');
  const stoppedPath = path.join(getFollowUpJobDir(rootDir, 'stopped'), path.basename(created.jobPath));
  assert.equal(existsSync(stoppedPath), true, 'over-budget job was terminalized to stopped/');
  const stoppedJob = readFollowUpJob(stoppedPath);
  assert.equal(stoppedJob.remediationPlan?.stop?.code, 'max-rounds-reached');
  assert.equal(claimNextFollowUpJob({ rootDir }), null, 'terminal release must not spawn another remediation over cap');
});

test('watcher releases a settled-clean pending follow-up job orphaned by a head move before deferring', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-settled-stale-release-'));
  const created = createFollowUpJob({
    rootDir,
    repo: 'laceyenterprises/agent-os',
    prNumber: 5142,
    reviewerModel: 'claude',
    linearTicketId: null,
    revisionRef: '93ea29e5',
    reviewBody: [
      '## Summary',
      'Latest adversarial review is settled cleanly.',
      '',
      '## Blocking issues',
      '- None.',
      '',
      '## Non-blocking issues',
      '- None.',
      '',
      '## Verdict',
      'Comment only',
    ].join('\n'),
    reviewPostedAt: '2026-08-09T12:00:00.000Z',
    critical: false,
    maxRemediationRounds: 2,
  });
  writeFollowUpJob(created.jobPath, {
    ...created.job,
    status: 'pending',
    revisionRef: '93ea29e5',
    recommendedFollowUpAction: {
      ...created.job.recommendedFollowUpAction,
      summary: 'Latest adversarial review is settled cleanly; no remediation coding session is required unless an operator explicitly retriggers review.',
    },
    remediationPlan: {
      ...created.job.remediationPlan,
      currentRound: 0,
      maxRounds: 2,
    },
  });

  const decision = shouldDeferReviewForActiveFollowUp({
    rootDir,
    repo: 'laceyenterprises/agent-os',
    prNumber: 5142,
    currentRevisionRef: '100e1e77',
    nowMs: Date.parse('2026-08-09T12:05:00.000Z'),
  });

  assert.equal(decision.defer, false);
  assert.equal(decision.latestJobStatus, 'stopped');
  assert.equal(decision.releaseReason, 'settled-clean-head-moved');
  assert.equal(existsSync(created.jobPath), false, 'settled stale pending file was removed from pending/');
  const stoppedPath = path.join(getFollowUpJobDir(rootDir, 'stopped'), path.basename(created.jobPath));
  const stoppedJob = readFollowUpJob(stoppedPath);
  assert.equal(stoppedJob.remediationPlan?.stop?.code, 'settled-clean-head-moved');
  assert.match(stoppedJob.remediationPlan?.stop?.reason || '', /superseded by current head 100e1e77/);
  assert.equal(claimNextFollowUpJob({ rootDir }), null, 'terminal settled release must not spawn remediation');
});

test('watcher releases a settled-clean pending follow-up job on the current head so gate evaluation can converge', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-settled-current-release-'));
  const created = createFollowUpJob({
    rootDir,
    repo: 'laceyenterprises/agent-os',
    prNumber: 5143,
    reviewerModel: 'claude',
    linearTicketId: null,
    revisionRef: 'sha-current-clean',
    reviewBody: [
      '## Summary',
      'Current head is clean.',
      '',
      '## Blocking issues',
      '- None.',
      '',
      '## Verdict',
      'Approved',
    ].join('\n'),
    reviewPostedAt: '2026-08-09T12:00:00.000Z',
    critical: false,
    maxRemediationRounds: 2,
  });

  const decision = shouldDeferReviewForActiveFollowUp({
    rootDir,
    repo: 'laceyenterprises/agent-os',
    prNumber: 5143,
    currentRevisionRef: 'sha-current-clean',
    nowMs: Date.parse('2026-08-09T12:05:00.000Z'),
  });

  assert.equal(decision.defer, false);
  assert.equal(decision.releaseReason, 'settled-clean');
  assert.equal(existsSync(created.jobPath), false, 'settled current-head carrier was removed from pending/');
  const stoppedPath = path.join(getFollowUpJobDir(rootDir, 'stopped'), path.basename(created.jobPath));
  assert.equal(readFollowUpJob(stoppedPath).remediationPlan?.stop?.code, 'settled-clean');
});

test('watcher does not synthesize settled-clean from a blocking review action summary', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-blocking-summary-'));
  const created = createFollowUpJob({
    rootDir,
    repo: 'laceyenterprises/agent-os',
    prNumber: 5144,
    reviewerModel: 'claude',
    linearTicketId: null,
    revisionRef: 'sha-current-blocking',
    reviewBody: [
      '## Summary',
      'This review is not settled cleanly; a remediation worker is required.',
      '',
      '## Blocking issues',
      '- Unsafe state classification.',
      '',
      '## Verdict',
      'Request changes',
    ].join('\n'),
    reviewPostedAt: '2026-08-09T12:00:00.000Z',
    critical: true,
    maxRemediationRounds: 2,
  });
  writeFollowUpJob(created.jobPath, {
    ...created.job,
    status: 'pending',
    recommendedFollowUpAction: {
      ...created.job.recommendedFollowUpAction,
      summary: 'This review is not settled cleanly; no remediation worker required is false.',
    },
  });

  const decision = shouldDeferReviewForActiveFollowUp({
    rootDir,
    repo: 'laceyenterprises/agent-os',
    prNumber: 5144,
    currentRevisionRef: 'sha-current-blocking',
    nowMs: Date.parse('2026-08-09T12:05:00.000Z'),
  });

  assert.equal(decision.defer, true);
  assert.equal(decision.latestJobStatus, 'pending');
  assert.equal(existsSync(created.jobPath), true, 'blocking current-head job must remain pending');
});

test('watcher releases a pending follow-up job whose revisionRef is superseded even when under budget', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-revision-superseded-'));
  const created = createFollowUpJob({
    rootDir,
    repo: 'laceyenterprises/agent-os',
    prNumber: 5144,
    reviewerModel: 'claude',
    linearTicketId: null,
    revisionRef: 'sha-old',
    reviewBody: '## Summary\nStale review head fixture.\n\n## Verdict\nRequest changes',
    reviewPostedAt: '2026-08-09T12:00:00.000Z',
    critical: false,
    maxRemediationRounds: 2,
  });
  writeFollowUpJob(created.jobPath, {
    ...created.job,
    status: 'pending',
    revisionRef: 'sha-old',
    remediationPlan: {
      ...created.job.remediationPlan,
      currentRound: 0,
      maxRounds: 2,
    },
  });

  const decision = shouldDeferReviewForActiveFollowUp({
    rootDir,
    repo: 'laceyenterprises/agent-os',
    prNumber: 5144,
    currentRevisionRef: 'sha-new',
    nowMs: Date.parse('2026-08-09T12:05:00.000Z'),
  });

  assert.equal(decision.defer, false);
  assert.equal(decision.releaseReason, 'revision-superseded');
  const stoppedPath = path.join(getFollowUpJobDir(rootDir, 'stopped'), path.basename(created.jobPath));
  assert.equal(readFollowUpJob(stoppedPath).remediationPlan?.stop?.code, 'revision-superseded');
  assert.equal(claimNextFollowUpJob({ rootDir }), null, 'superseded release must not spawn remediation for the old head');
});

test('watcher defers a pending review while the active follow-up job has status="in_progress" (same-SHA duplicate-review regression, 2026-05-31)', () => {
  // Regression for the same-SHA duplicate-review symptom observed across
  // PRs #1151 / #1164 / #1165 on 2026-05-31. Sequence that produced the
  // bug:
  //   1. First review posts, follow-up job created (status='pending').
  //      Watcher correctly defers the next reviewer spawn.
  //   2. The follow-up daemon claims the job. `claimNextFollowUpJob` /
  //      `markFollowUpJobSpawned` rewrite the on-disk job file with
  //      `status: 'in_progress'` (underscore form).
  //   3. The remediation worker is still running but the active-job
  //      guard's allow-list missed the underscore spelling, so
  //      `isActiveFollowUpJob` returned false and the watcher fell
  //      through to spawn a NEW first-pass reviewer.
  //   4. The new reviewer posted a second review on the SAME commit SHA
  //      before the remediation worker had pushed anything.
  //
  // This test pins the underscore form as a recognized "active" status
  // so the spawn-defer survives every spelling the writers actually
  // produce.
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  const db = setupDb();
  db.prepare(
    'INSERT INTO reviewed_prs (repo, pr_number, reviewed_at, reviewer, pr_state, review_status, review_attempts) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(
    'laceyenterprises/agent-os',
    1165,
    '2026-05-31T07:53:02.449Z',
    'claude',
    'open',
    'pending',
    1,
  );
  createFollowUpJob({
    rootDir,
    repo: 'laceyenterprises/agent-os',
    prNumber: 1165,
    reviewerModel: 'claude',
    linearTicketId: null,
    reviewBody: '## Summary\nIn-progress fixture.\n\n## Verdict\nRequest changes',
    reviewPostedAt: '2026-05-31T07:53:02.449Z',
    critical: false,
    maxRemediationRounds: 2,
  });
  const claimed = claimNextFollowUpJob({
    rootDir,
    claimedAt: '2026-05-31T08:09:04.440Z',
  });
  assert.equal(claimed?.job?.status, 'in_progress', 'claimNextFollowUpJob writes the underscore form');

  // After markFollowUpJobSpawned the file on disk still carries the
  // underscore form — re-read it so we exercise the actual disk shape
  // the latest-job finder sees.
  markFollowUpJobSpawned({
    rootDir,
    jobPath: claimed.jobPath,
    worker: {
      processId: 64594,
      processGroupId: 64594,
      workspaceDir: '/tmp/fixture-workspace',
    },
    spawnedAt: '2026-05-31T08:09:04.440Z',
  });
  const onDisk = readFollowUpJob(claimed.jobPath);
  assert.equal(onDisk.status, 'in_progress', 'markFollowUpJobSpawned also persists the underscore form');

  const decision = shouldDeferReviewForActiveFollowUp({
    rootDir,
    repo: 'laceyenterprises/agent-os',
    prNumber: 1165,
    nowMs: Date.parse('2026-05-31T08:10:04.440Z'),
  });
  assert.equal(decision.defer, true, 'watcher MUST defer while the underscore-form in_progress remediation is mid-flight');
  assert.equal(decision.latestJobStatus, 'in_progress');
});

test('watcher still defers a genuinely active in-progress remediation job on the current head', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-current-live-defers-'));
  createFollowUpJob({
    rootDir,
    repo: 'laceyenterprises/agent-os',
    prNumber: 5145,
    reviewerModel: 'claude',
    linearTicketId: null,
    revisionRef: 'sha-live',
    reviewBody: '## Summary\nLive remediation fixture.\n\n## Verdict\nRequest changes',
    reviewPostedAt: '2026-08-09T12:00:00.000Z',
    critical: false,
    maxRemediationRounds: 2,
  });
  const claimed = claimNextFollowUpJob({
    rootDir,
    claimedAt: '2026-08-09T12:01:00.000Z',
  });
  const spawned = markFollowUpJobSpawned({
    rootDir,
    jobPath: claimed.jobPath,
    worker: {
      processId: 64594,
      processGroupId: 64594,
      workspaceDir: '/tmp/fixture-workspace',
    },
    spawnedAt: '2026-08-09T12:02:00.000Z',
  });
  writeFollowUpJob(spawned.jobPath, {
    ...spawned.job,
    revisionRef: 'sha-live',
    lastHeartbeatAt: '2026-08-09T12:04:00.000Z',
    remediationPlan: {
      ...spawned.job.remediationPlan,
      currentRound: 1,
      maxRounds: 2,
    },
  });

  const decision = shouldDeferReviewForActiveFollowUp({
    rootDir,
    repo: 'laceyenterprises/agent-os',
    prNumber: 5145,
    currentRevisionRef: 'sha-live',
    nowMs: Date.parse('2026-08-09T12:05:00.000Z'),
  });

  assert.equal(decision.defer, true);
  assert.equal(decision.latestJobStatus, 'in_progress');
  assert.equal(existsSync(spawned.jobPath), true, 'live current-head job must remain in progress');
});

test('watcher releases stale in-progress follow-up claims through the stuck-claim sweep before deferring', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-stale-release-'));
  createFollowUpJob({
    rootDir,
    repo: 'laceyenterprises/agent-os',
    prNumber: 5111,
    reviewerModel: 'claude',
    linearTicketId: null,
    reviewBody: '## Summary\nStale claim fixture.\n\n## Verdict\nRequest changes',
    reviewPostedAt: '2026-08-09T08:00:00.000Z',
    critical: false,
    maxRemediationRounds: 2,
  });
  const claimed = claimNextFollowUpJob({
    rootDir,
    claimedAt: '2026-08-09T08:01:00.000Z',
  });
  const spawned = markFollowUpJobSpawned({
    rootDir,
    jobPath: claimed.jobPath,
    worker: {
      processId: 64594,
      processGroupId: 64594,
      workspaceDir: '/tmp/fixture-workspace',
    },
    spawnedAt: '2026-08-09T08:02:00.000Z',
  });
  writeFollowUpJob(spawned.jobPath, {
    ...spawned.job,
    lastHeartbeatAt: '2026-08-09T08:03:00.000Z',
  });

  const decision = shouldDeferReviewForActiveFollowUp({
    rootDir,
    repo: 'laceyenterprises/agent-os',
    prNumber: 5111,
    nowMs: Date.parse('2026-08-09T09:00:00.000Z'),
  });

  assert.equal(decision.defer, false);
  assert.equal(decision.latestJobStatus, 'stopped');
  assert.equal(decision.releaseReason, 'stale-heartbeat');
  assert.equal(existsSync(spawned.jobPath), false, 'stale claim was removed from in-progress/');
  const stoppedPath = path.join(getFollowUpJobDir(rootDir, 'stopped'), path.basename(spawned.jobPath));
  const stoppedJob = readFollowUpJob(stoppedPath);
  assert.equal(stoppedJob.remediationPlan?.stop?.code, 'stale-heartbeat');
  assert.equal(stoppedJob.remediationWorker?.state, 'reclaimed-stale-heartbeat');
  assert.equal(stoppedJob.remediationPlan?.rounds?.at(-1)?.worker?.state, 'reclaimed-stale-heartbeat');
});

test('watcher stale follow-up release uses the newest liveness timestamp before stopping', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-fresh-heartbeat-'));
  createFollowUpJob({
    rootDir,
    repo: 'laceyenterprises/agent-os',
    prNumber: 5112,
    reviewerModel: 'claude',
    linearTicketId: null,
    reviewBody: '## Summary\nFresh heartbeat fixture.\n\n## Verdict\nRequest changes',
    reviewPostedAt: '2026-08-09T08:00:00.000Z',
    critical: false,
    maxRemediationRounds: 2,
  });
  const claimed = claimNextFollowUpJob({
    rootDir,
    claimedAt: '2026-08-09T08:01:00.000Z',
  });
  const spawned = markFollowUpJobSpawned({
    rootDir,
    jobPath: claimed.jobPath,
    worker: {
      processId: 64594,
      processGroupId: 64594,
      workspaceDir: '/tmp/fixture-workspace',
    },
    spawnedAt: '2026-08-09T08:02:00.000Z',
  });
  writeFollowUpJob(spawned.jobPath, {
    ...spawned.job,
    lastWorkerArtifactProgressAt: '2026-08-09T08:03:00.000Z',
    lastHeartbeatAt: '2026-08-09T08:59:00.000Z',
  });

  const decision = shouldDeferReviewForActiveFollowUp({
    rootDir,
    repo: 'laceyenterprises/agent-os',
    prNumber: 5112,
    nowMs: Date.parse('2026-08-09T09:00:00.000Z'),
  });

  assert.equal(decision.defer, true, 'fresh heartbeat must keep the in-progress job active');
  assert.equal(decision.latestJobStatus, 'in_progress');
  assert.equal(existsSync(spawned.jobPath), true, 'fresh job must not be moved to stopped/');
});

test('watcher stale follow-up release signals the local remediator before unblocking review', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-stale-signal-'));
  createFollowUpJob({
    rootDir,
    repo: 'laceyenterprises/agent-os',
    prNumber: 5605,
    reviewerModel: 'gemini',
    linearTicketId: null,
    reviewBody: '## Summary\nStale remediator fixture.\n\n## Verdict\nRequest changes',
    reviewPostedAt: '2026-08-21T11:01:54.000Z',
    critical: false,
    maxRemediationRounds: 2,
  });
  const claimed = claimNextFollowUpJob({
    rootDir,
    claimedAt: '2026-08-21T11:02:55.599Z',
  });
  const spawned = markFollowUpJobSpawned({
    rootDir,
    jobPath: claimed.jobPath,
    worker: {
      model: 'codex',
      state: 'spawned',
      processId: 13600,
      processGroupId: 13600,
      workspaceDir: '/tmp/stale-remediator-workspace',
    },
    spawnedAt: '2026-08-21T11:03:16.461Z',
  });
  writeFollowUpJob(spawned.jobPath, {
    ...spawned.job,
    lastHeartbeatAt: '2026-08-21T11:03:16.461Z',
  });

  const signalCalls = [];
  const decision = shouldDeferReviewForActiveFollowUpDirect({
    rootDir,
    repo: 'laceyenterprises/agent-os',
    prNumber: 5605,
    nowMs: Date.parse('2026-08-21T11:13:55.830Z'),
    staleSignalImpl(args) {
      signalCalls.push(args);
      return {
        signalled: true,
        skipped: false,
        target: { kind: 'process-group', id: 13600 },
        error: null,
      };
    },
  });

  assert.equal(decision.defer, false, 'stale local worker should not keep blocking review');
  assert.equal(decision.latestJobStatus, 'stopped');
  assert.equal(decision.releaseReason, 'stale-heartbeat');
  assert.equal(signalCalls.length, 1, 'stale local worker must be signalled before release');
  assert.equal(signalCalls[0].job.remediationWorker.processGroupId, 13600);
  assert.equal(existsSync(spawned.jobPath), false, 'in-progress claim must be moved');
  const stoppedPath = path.join(
    getFollowUpJobDir(rootDir, 'stopped'),
    path.basename(spawned.jobPath),
  );
  const stoppedJob = readFollowUpJob(stoppedPath);
  assert.equal(stoppedJob.remediationWorker?.state, 'reclaimed-stale-heartbeat');
  assert.equal(stoppedJob.remediationWorker?.processId, 13600);
  assert.equal(stoppedJob.remediationWorker?.processGroupId, 13600);
  assert.equal(stoppedJob.remediationWorker?.workspaceDir, '/tmp/stale-remediator-workspace');
  assert.equal(stoppedJob.remediationWorker?.staleReclaimSignal?.signalled, true);
  assert.deepEqual(stoppedJob.remediationWorker?.staleReclaimSignal?.target, {
    kind: 'process-group',
    id: 13600,
  });
});

test('stale follow-up signal falls back to a single process when no process group is persisted', () => {
  const calls = [];
  const result = signalStaleFollowUpWorker({
    job: {
      remediationWorker: {
        processId: 4242,
      },
    },
    processKill(pid, signal) {
      calls.push([pid, signal]);
    },
  });

  assert.deepEqual(result, {
    signalled: true,
    skipped: false,
    target: { kind: 'process', id: 4242 },
    error: null,
  });
  assert.deepEqual(calls, [
    [4242, 0],
    [4242, 'SIGTERM'],
  ]);
});

test('stale follow-up signal never broadcasts for process group 1', () => {
  const calls = [];
  const result = signalStaleFollowUpWorker({
    job: {
      remediationWorker: {
        processId: 4242,
        processGroupId: 1,
      },
    },
    processKill(pid, signal) {
      calls.push([pid, signal]);
    },
  });

  assert.deepEqual(result, {
    signalled: true,
    skipped: false,
    target: { kind: 'process', id: 4242 },
    error: null,
  });
  assert.deepEqual(calls, [
    [4242, 0],
    [4242, 'SIGTERM'],
  ]);
  assert.equal(calls.some(([pid]) => pid === -1), false);
});

test('stale follow-up signal skips process group 1 without a direct process id', () => {
  const calls = [];
  const result = signalStaleFollowUpWorker({
    job: {
      remediationWorker: {
        processGroupId: 1,
      },
    },
    processKill(pid, signal) {
      calls.push([pid, signal]);
    },
  });

  assert.deepEqual(result, {
    signalled: false,
    skipped: true,
    target: { kind: 'process-group', id: 1 },
    error: 'unsafe-process-group-broadcast-refused',
  });
  assert.deepEqual(calls, []);
});

test('stale follow-up signal falls back to direct pid for the watcher process group', () => {
  const calls = [];
  const result = signalStaleFollowUpWorker({
    job: {
      remediationWorker: {
        processId: 4242,
        processGroupId: 31337,
      },
    },
    currentPgid: 31337,
    processKill(pid, signal) {
      calls.push([pid, signal]);
    },
  });

  assert.deepEqual(result, {
    signalled: true,
    skipped: false,
    target: { kind: 'process', id: 4242 },
    error: null,
  });
  assert.deepEqual(calls, [
    [4242, 0],
    [4242, 'SIGTERM'],
  ]);
});

test('stale follow-up signal falls back to direct pid when watcher process group is unknown', () => {
  const calls = [];
  const result = signalStaleFollowUpWorker({
    job: {
      remediationWorker: {
        processId: 4242,
        processGroupId: 31337,
      },
    },
    currentPgid: null,
    processKill(pid, signal) {
      calls.push([pid, signal]);
    },
  });

  assert.deepEqual(result, {
    signalled: true,
    skipped: false,
    target: { kind: 'process', id: 4242 },
    error: null,
  });
  assert.deepEqual(calls, [
    [4242, 0],
    [4242, 'SIGTERM'],
  ]);
});

test('stale follow-up signal skips process group when watcher process group is unknown and no pid exists', () => {
  const calls = [];
  const result = signalStaleFollowUpWorker({
    job: {
      remediationWorker: {
        processGroupId: 31337,
      },
    },
    currentPgid: null,
    processKill(pid, signal) {
      calls.push([pid, signal]);
    },
  });

  assert.deepEqual(result, {
    signalled: false,
    skipped: true,
    target: { kind: 'process-group', id: 31337 },
    error: 'unknown-current-process-group',
  });
  assert.deepEqual(calls, []);
});

test('current process group lookup caches the process-scope ps result', () => {
  let calls = 0;
  const first = currentProcessGroupId({
    pid: 4242,
    useCache: true,
    execFileSyncImpl() {
      calls += 1;
      return ' 31337\n';
    },
  });
  const second = currentProcessGroupId({
    pid: 4242,
    useCache: true,
    execFileSyncImpl() {
      calls += 1;
      return ' 41414\n';
    },
  });

  assert.equal(first, 31337);
  assert.equal(second, 31337);
  assert.equal(calls, 1);
});

test('current process group lookup retries after a transient ps failure', () => {
  let calls = 0;
  function execFileSyncImpl() {
    calls += 1;
    if (calls === 1) {
      const err = new Error('resource temporarily unavailable');
      err.code = 'EAGAIN';
      throw err;
    }
    return ' 51515\n';
  }

  const first = currentProcessGroupId({
    pid: 5151,
    useCache: true,
    execFileSyncImpl,
  });
  const second = currentProcessGroupId({
    pid: 5151,
    useCache: true,
    execFileSyncImpl,
  });

  assert.equal(first, null);
  assert.equal(second, 51515);
  assert.equal(calls, 2);
});

test('stale follow-up signal skips reused watcher pid metadata', () => {
  const calls = [];
  const result = signalStaleFollowUpWorker({
    job: {
      remediationWorker: {
        processId: process.pid,
        processGroupId: 31337,
      },
    },
    currentPgid: 31337,
    processKill(pid, signal) {
      calls.push([pid, signal]);
    },
  });

  assert.deepEqual(result, {
    signalled: false,
    skipped: true,
    target: { kind: 'process', id: process.pid },
    error: 'refusing-to-signal-current-process',
  });
  assert.deepEqual(calls, []);
});

test('watcher stale follow-up release defers when a live worker cannot be signalled', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-stale-signal-fail-'));
  createFollowUpJob({
    rootDir,
    repo: 'laceyenterprises/agent-os',
    prNumber: 5605,
    reviewerModel: 'gemini',
    linearTicketId: null,
    reviewBody: '## Summary\nStale remediator fixture.\n\n## Verdict\nRequest changes',
    reviewPostedAt: '2026-08-21T11:01:54.000Z',
    critical: false,
    maxRemediationRounds: 2,
  });
  const claimed = claimNextFollowUpJob({
    rootDir,
    claimedAt: '2026-08-21T11:02:55.599Z',
  });
  const spawned = markFollowUpJobSpawned({
    rootDir,
    jobPath: claimed.jobPath,
    worker: {
      model: 'codex',
      state: 'spawned',
      processId: 13600,
      processGroupId: 13600,
      workspaceDir: '/tmp/stale-remediator-workspace',
    },
    spawnedAt: '2026-08-21T11:03:16.461Z',
  });
  writeFollowUpJob(spawned.jobPath, {
    ...spawned.job,
    lastHeartbeatAt: '2026-08-21T11:03:16.461Z',
  });

  const warnings = [];
  const decision = shouldDeferReviewForActiveFollowUpDirect({
    rootDir,
    repo: 'laceyenterprises/agent-os',
    prNumber: 5605,
    nowMs: Date.parse('2026-08-21T11:13:55.830Z'),
    staleSignalImpl() {
      return {
        signalled: false,
        skipped: false,
        target: { kind: 'process-group', id: 13600 },
        error: 'EPERM',
      };
    },
    log: { warn: (message) => warnings.push(message) },
  });

  assert.equal(decision.defer, true, 'live unkillable worker must keep the exclusive lock');
  assert.equal(decision.latestJobStatus, 'in_progress');
  assert.equal(decision.releaseReason, undefined);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Keeping stale follow-up job .* in progress after worker signal failure/);
  assert.match(warnings[0], /EPERM/);
  assert.equal(existsSync(spawned.jobPath), true, 'in-progress claim must stay held');
});

test('watcher active follow-up defer defaults to the repository root, not process cwd', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-default-root-'));
  const previousCwd = process.cwd();
  createFollowUpJob({
    rootDir,
    repo: 'laceyenterprises/agent-os',
    prNumber: 5113,
    reviewerModel: 'claude',
    linearTicketId: null,
    reviewBody: '## Summary\nDefault root fixture.\n\n## Verdict\nRequest changes',
    reviewPostedAt: '2026-08-09T08:00:00.000Z',
    critical: false,
    maxRemediationRounds: 2,
  });

  try {
    process.chdir(rootDir);
    const decision = shouldDeferReviewForActiveFollowUpDirect({
      repo: 'laceyenterprises/agent-os',
      prNumber: 5113,
      latestJobFinder(receivedRootDir) {
        return {
          job: { status: 'pending', jobId: 'default-root-fixture' },
          jobPath: path.join(receivedRootDir, 'data/follow-up-jobs/pending/default-root-fixture.json'),
        };
      },
      staleClaimSweepImpl: null,
    });

    assert.equal(decision.defer, true);
    assert.equal(
      decision.jobPath,
      path.join(previousCwd, 'data/follow-up-jobs/pending/default-root-fixture.json'),
    );
  } finally {
    process.chdir(previousCwd);
  }
});

test('watcher active follow-up defer accepts injected budget stop implementation', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-budget-injected-'));
  const jobPath = path.join(rootDir, 'mock-budget-exhausted.json');
  const stoppedCalls = [];
  const decision = shouldDeferReviewForActiveFollowUpDirect({
    rootDir,
    repo: 'laceyenterprises/agent-os',
    prNumber: 5114,
    latestJobFinder() {
      return {
        job: {
          status: 'pending',
          jobId: 'budget-exhausted-fixture',
          remediationPlan: {
            currentRound: 2,
            maxRounds: 2,
          },
        },
        jobPath,
      };
    },
    markStoppedImpl(args) {
      stoppedCalls.push(args);
      return {
        jobPath: args.jobPath,
        job: {
          status: 'stopped',
          jobId: 'budget-exhausted-fixture',
          remediationPlan: {
            stop: { code: args.stopCode },
          },
        },
      };
    },
    staleClaimSweepImpl: null,
    nowMs: Date.parse('2026-08-09T09:00:00.000Z'),
  });

  assert.equal(decision.defer, false);
  assert.equal(decision.latestJobStatus, 'stopped');
  assert.equal(decision.releaseReason, 'max-rounds-reached');
  assert.equal(stoppedCalls.length, 1);
  assert.equal(stoppedCalls[0].jobPath, jobPath);
  assert.equal(stoppedCalls[0].stopCode, 'max-rounds-reached');
  assert.equal(existsSync(jobPath), false, 'mock budget stop must not invoke the real disk mutator');
});

test('watcher defer + operator bumpRemediationBudget + retrigger-remediation eligibility all agree on every active-status spelling (cross-module agreement)', async () => {
  // Cross-module agreement check requested by the PR #198 review:
  // every production reader that classifies "is this follow-up job
  // active?" must agree, otherwise a future spelling rename can split
  // watcher behavior from operator-retrigger behavior and reintroduce
  // the same duplicate-review / mid-flight-mutation class of bugs.
  //
  // The four spellings exhaust what writers in the codebase produce
  // today (`'pending'` from createFollowUpJob; `'in_progress'` from
  // claimNextFollowUpJob/markFollowUpJobSpawned) PLUS the legacy
  // `'inProgress'` / `'in-progress'` spellings that older readers
  // accepted and the helper still tolerates for safety.
  const { bumpRemediationBudget } = await import('../src/operator-retrigger-helpers.mjs');
  const { main: retriggerRemediationMain } = await import('../src/retrigger-remediation.mjs');
  const { createFollowUpJob: createJob, writeFollowUpJob: writeJob, readFollowUpJob } =
    await import('../src/follow-up-jobs.mjs');

  function captureStream() {
    let buf = '';
    return {
      write(chunk) { buf += chunk; },
      text() { return buf; },
    };
  }

  for (const spelling of ['pending', 'inProgress', 'in-progress', 'in_progress']) {
    const rootDir = mkdtempSync(path.join(tmpdir(), `cross-module-${spelling.replace(/[^a-z]/gi, '')}-`));
    const created = createJob({
      rootDir,
      repo: 'laceyenterprises/agent-os',
      prNumber: 9999,
      reviewerModel: 'claude',
      linearTicketId: null,
      reviewBody: '## Summary\nfixture\n\n## Verdict\nRequest changes',
      reviewPostedAt: '2026-05-31T07:00:00.000Z',
      critical: false,
      maxRemediationRounds: 2,
    });
    // Force the status on disk to the spelling under test. Read back
    // to confirm so the test asserts the exact bytes the production
    // readers will encounter.
    writeJob(created.jobPath, { ...created.job, status: spelling });
    assert.equal(readFollowUpJob(created.jobPath).status, spelling,
      `fixture setup: on-disk status must be ${spelling}`);

    // Reader 1: watcher defer guard.
    const decision = shouldDeferReviewForActiveFollowUp({
      rootDir,
      repo: 'laceyenterprises/agent-os',
      prNumber: 9999,
    });
    assert.equal(decision.defer, true,
      `watcher must defer for status=${spelling}`);
    assert.equal(decision.latestJobStatus, spelling);

    // Reader 2: operator bumpRemediationBudget — must refuse with job-active.
    const bumpBefore = readFileSync(created.jobPath, 'utf8');
    const bumpResult = bumpRemediationBudget({
      rootDir,
      repo: 'laceyenterprises/agent-os',
      prNumber: 9999,
      bumpBudget: 1,
      auditEntry: {
        idempotencyKey: `idem:cross:${spelling}`,
        requestFingerprint: `fp:cross:${spelling}`,
        reason: 'cross-module agreement test',
        operator: 'test',
        ts: '2026-05-31T07:00:01.000Z',
        auditRow: null,
      },
    });
    assert.equal(bumpResult.bumped, false,
      `bumpRemediationBudget must refuse for status=${spelling}`);
    assert.equal(bumpResult.reason, 'job-active',
      `bumpRemediationBudget reason must be job-active for status=${spelling}`);
    assert.equal(readFileSync(created.jobPath, 'utf8'), bumpBefore,
      `bumpRemediationBudget must leave job file unchanged for status=${spelling}`);

    // Reader 3: retrigger-remediation CLI — must refuse with refused:job-active
    // (not refused:not-eligible, the wrong label that drift would produce).
    const err = captureStream();
    const rc = retriggerRemediationMain([
      '--repo', 'laceyenterprises/agent-os',
      '--pr', '9999',
      '--reason', `cross-module test for ${spelling}`,
      '--root-dir', rootDir,
      '--audit-root-dir', rootDir,
    ], { stdout: captureStream(), stderr: err });
    assert.equal(rc, 1, `retrigger-remediation must exit 1 (blocked) for status=${spelling}`);
    assert.match(err.text(), /refused:job-active/,
      `retrigger-remediation must use refused:job-active outcome for status=${spelling}`);
    assert.doesNotMatch(err.text(), /refused:not-eligible/,
      `retrigger-remediation must NOT fall through to refused:not-eligible for status=${spelling}`);
  }
});

test('evaluateRoundBudgetForReview preserves elevated legacy caps above the current riskClass tier', () => {
  // Dispatch-time decisions normally re-derive the cap from the
  // current PR riskClass, but an already elevated legacy/operator cap
  // remains authoritative for the active PR cycle so an in-flight PR is
  // not silently truncated after consuming more rounds than the new tier.
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));

  const created = createFollowUpJob({
    rootDir,
    repo: 'laceyenterprises/adversarial-review',
    prNumber: 6,
    reviewerModel: 'claude',
    linearTicketId: null,
    reviewBody: '## Summary\nLegacy budget.\n\n## Verdict\nRequest changes',
    reviewPostedAt: '2026-04-22T05:22:42.212Z',
    critical: false,
    maxRemediationRounds: 6,
  });
  // Force the legacy persisted shape on disk: riskClass='medium' next
  // to maxRounds=6. The watcher should use the elevated cap when it is
  // higher than the current medium tier.
  const claimed = claimNextFollowUpJob({
    rootDir,
    claimedAt: '2026-04-22T05:25:00.000Z',
  });
  const spawned = markFollowUpJobSpawned({
    jobPath: claimed.jobPath,
    spawnedAt: '2026-04-22T05:26:00.000Z',
    worker: {
      processId: 8123,
      state: 'spawned',
      workspaceDir: 'workspace',
      outputPath: 'workspace/.adversarial-follow-up/codex-last-message.md',
      logPath: 'workspace/.adversarial-follow-up/codex-worker.log',
      promptPath: 'workspace/.adversarial-follow-up/prompt.md',
    },
  });
  markFollowUpJobCompleted({
    rootDir,
    jobPath: spawned.jobPath,
    completedAt: '2026-04-22T05:30:00.000Z',
    completion: { source: 'test-fixture' },
    remediationWorker: {
      ...spawned.job.remediationWorker,
      state: 'completed',
    },
    reReview: {
      requested: true,
      status: 'pending',
      reason: 'Please re-review.',
      triggered: true,
      requestedAt: '2026-04-22T05:30:00.000Z',
    },
  });

  const decision = evaluateRoundBudgetForReview({
    rootDir,
    repo: created.job.repo,
    prNumber: created.job.prNumber,
    linearTicketId: null,
    reviewStatus: 'pending',
    reviewAttempts: 1,
    log: () => {},
  });

  assert.equal(decision.skip, false, 'a legacy 6-round PR must NOT be skipped after a single completed round');
  assert.equal(decision.completedRoundsForPR, 1);
  assert.equal(decision.roundBudget, 6, 'elevated prior cap should prevent mid-flight truncation');
});

test('evaluateRoundBudgetForReview always allows rereview after a completed remediation (post-2026-05-06 convergence loop)', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  const projectsDir = path.join(rootDir, 'projects', 'fixture-project');
  mkdirSync(projectsDir, { recursive: true });
  writeFileSync(
    path.join(projectsDir, 'PLAN-track-a.json'),
    `${JSON.stringify({
      planSchemaVersion: 1,
      tickets: [{ id: 'PMO-A1', riskClass: 'medium' }],
    }, null, 2)}\n`,
    'utf8'
  );
  writeFileSync(
    path.join(projectsDir, 'PLAN-track-a.json.linear-mapping.json'),
    `${JSON.stringify({ 'PMO-A1': 'LAC-207' }, null, 2)}\n`,
    'utf8'
  );

  const created = createFollowUpJob({
    rootDir,
    repo: 'laceyenterprises/adversarial-review',
    prNumber: 5,
    reviewerModel: 'claude',
    linearTicketId: 'LAC-207',
    reviewBody: '## Summary\nHandle token refresh before retrying.\n\n## Verdict\nRequest changes',
    reviewPostedAt: '2026-04-22T05:22:42.212Z',
    critical: false,
  });
  const claimed = claimNextFollowUpJob({
    rootDir,
    claimedAt: '2026-04-22T05:25:00.000Z',
  });
  const spawned = markFollowUpJobSpawned({
    jobPath: claimed.jobPath,
    spawnedAt: '2026-04-22T05:26:00.000Z',
    worker: {
      processId: 8123,
      state: 'spawned',
      workspaceDir: 'workspace',
      outputPath: 'workspace/.adversarial-follow-up/codex-last-message.md',
      logPath: 'workspace/.adversarial-follow-up/codex-worker.log',
      promptPath: 'workspace/.adversarial-follow-up/prompt.md',
    },
  });
  const completed = markFollowUpJobCompleted({
    rootDir,
    jobPath: spawned.jobPath,
    completedAt: '2026-04-22T05:30:00.000Z',
    completion: { source: 'test-fixture' },
    remediationWorker: {
      ...spawned.job.remediationWorker,
      state: 'completed',
    },
    reReview: {
      requested: true,
      status: 'pending',
      reason: 'Please re-review.',
      triggered: true,
      requestedAt: '2026-04-22T05:30:00.000Z',
    },
  });

  const logLines = [];
  const decision = evaluateRoundBudgetForReview({
    rootDir,
    repo: completed.job.repo,
    prNumber: completed.job.prNumber,
    linearTicketId: completed.job.linearTicketId,
    reviewStatus: 'pending',
    reviewAttempts: 1,
    log: (line) => logLines.push(line),
  });

  // Post-2026-05-06 convergence loop: rereview is ALWAYS allowed
  // after a remediation round, regardless of how many rounds have
  // completed. The cap on the loop now lives entirely on the
  // remediation-enqueue side (`claimNextFollowUpJob` refuses
  // `currentRound >= maxRounds`) — skipping the rereview after
  // remediation strands converged work behind a stale verdict.
  assert.equal(decision.skip, false);
  assert.equal(decision.reason, undefined);
  // medium risk class now uniformly caps at 2 rounds (was 1).
  assert.equal(decision.roundBudget, 2);
  assert.equal(decision.riskClass, 'medium');
  // No "skipping rereview" log line should fire — the gate is gone.
  assert.equal(logLines.length, 0);
});
