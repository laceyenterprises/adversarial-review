/* Watcher auto-refreshes stale posted reviews when PR HEAD has moved.
 *
 * Before this fix, a `posted` review row in reviewed_prs sat forever
 * even when the PR had been updated. The watcher's main reclaim CAS
 * (`stmtMarkAttemptStarted`) only matches rows in
 * `pending | failed | pending-upstream`, never `posted`. D3 (downstream
 * gate) saw the posted review on an older head SHA, reported "stale
 * review", and D4 stayed pending forever. The only recovery was
 * operator-applied `retrigger-review` label.
 *
 * The fix calls `requestReviewRereview` directly when the watcher sees
 * a posted row whose `reviewer_head_sha` no longer matches the current
 * PR head. requestReviewRereview's own CAS refuses `reviewing`, so a
 * head change mid-tick can't race a duplicate spawn.
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
  AUTO_REREVIEW_SUPPRESSING_LABELS,
  MERGE_AGENT_DISPATCHED_LABEL,
  MERGE_AGENT_REQUESTED_LABEL,
  MERGE_AGENT_STUCK_LABEL,
  NO_MERGE_HOLD_LABEL,
  autoRereviewSuppressedByLabel,
} from '../src/adapters/operator/github-pr-label-controls/index.mjs';


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

// --- Merge-agent-owned PRs are exempt from stale-head auto-refresh ---
//
// Regression for the 2026-05-25 infinite review<->remediation loop: the
// watcher's auto-refresh re-armed a fresh reviewer on every head move,
// including the merge-agent's own convergence force-pushes, so PRs under a
// merge-agent (or held) never merged (#877 hit review_attempts=4 +
// merge-agent-stuck). The watcher now skips auto-refresh when
// autoRereviewSuppressedByLabel() is true.

test('autoRereviewSuppressedByLabel suppresses for each merge-agent / hold label', () => {
  for (const label of [
    MERGE_AGENT_DISPATCHED_LABEL,
    MERGE_AGENT_REQUESTED_LABEL,
    MERGE_AGENT_STUCK_LABEL,
    NO_MERGE_HOLD_LABEL,
  ]) {
    assert.equal(
      autoRereviewSuppressedByLabel([label]),
      true,
      `expected ${label} to suppress auto-refresh`
    );
    // Still suppresses when mixed with unrelated labels.
    assert.equal(autoRereviewSuppressedByLabel(['some-other', label, 'area/x']), true);
  }
  // The exported set is the single source of truth for the predicate.
  assert.deepEqual(
    [...AUTO_REREVIEW_SUPPRESSING_LABELS].sort(),
    [
      MERGE_AGENT_DISPATCHED_LABEL,
      MERGE_AGENT_REQUESTED_LABEL,
      MERGE_AGENT_STUCK_LABEL,
      NO_MERGE_HOLD_LABEL,
    ].sort()
  );
});

test('autoRereviewSuppressedByLabel does NOT suppress for unrelated / empty / malformed inputs', () => {
  assert.equal(autoRereviewSuppressedByLabel([]), false);
  assert.equal(autoRereviewSuppressedByLabel(['retrigger-review', 'area/worker-pool']), false);
  // A non-array (defensive): must not throw and must not suppress.
  assert.equal(autoRereviewSuppressedByLabel(null), false);
  assert.equal(autoRereviewSuppressedByLabel(undefined), false);
  assert.equal(autoRereviewSuppressedByLabel('merge-agent-stuck'), false);
  // Mixed types in the array are filtered, not crashed on.
  assert.equal(autoRereviewSuppressedByLabel([{ name: MERGE_AGENT_STUCK_LABEL }, 42]), false);
});

test('watcher auto-refresh decision: head-moved AND suppressed → no rereview', () => {
  // Mirrors the exact boolean the watcher evaluates at the auto-refresh site:
  //   postedReviewHeadMoved && !autoRereviewSuppressedByLabel(prLabelNames)
  const postedReviewHeadMoved = true; // posted row, head SHA differs, non-terminal
  const wouldRereview = (labels) =>
    postedReviewHeadMoved && !autoRereviewSuppressedByLabel(labels);

  assert.equal(wouldRereview([MERGE_AGENT_DISPATCHED_LABEL]), false);
  assert.equal(wouldRereview([MERGE_AGENT_STUCK_LABEL]), false);
  assert.equal(wouldRereview([NO_MERGE_HOLD_LABEL]), false);
  // No ownership/hold label → auto-refresh still fires (preserves the original
  // stale-review recovery behavior).
  assert.equal(wouldRereview(['area/x']), true);
  assert.equal(wouldRereview([]), true);
});
