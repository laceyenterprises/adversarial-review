// REVIEWBOUNCE-01: a review that posts after a daemon bounce settles as posted,
// and a bounce never spends the review retry cap.
//
// Replays agent-os PR 8000 (head 20bb48842974cc28e1ddd5269dd3112cd58ed764):
// gemini review started 15:15:17, a main-catchup deploy bounced the watcher at
// 15:17:16, the surviving reviewer posted an APPROVED comment-only review at
// 15:19:01, and the row still parked as "Review retry cap exhausted ... failure
// is not infrastructure-recoverable" with the gate at `success (review-failed)`.
import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { ensureReviewStateSchema } from '../src/review-state.mjs';
import { recoverReviewerRunRecords } from '../src/adapters/reviewer-runtime/index.mjs';
import { writeReviewerRunRecord } from '../src/adapters/reviewer-runtime/run-state.mjs';
import { reapRunningPassTimeouts } from '../src/reviewer-pass-reaper.mjs';
import { reviewRowInTerminalFailureState } from '../src/pollonce-phases.mjs';
import { infraRecoverableFailureClass } from '../src/reviewer-failure-classification.mjs';
import { MARK_INFRA_AUTO_RECOVERY_ATTEMPT_STARTED_SQL } from '../src/review-state-statements.mjs';
import { DEFAULT_REVIEWER_LEASE_RECOVERY_MAX_ATTEMPTS } from '../src/reviewer-lease.mjs';
import { pickAdversarialGateStatus } from '../src/adversarial-gate-status.mjs';
import {
  DAEMON_BOUNCE_FAILURE_CLASS,
  daemonBounceReviewerHold,
  isDaemonBounceFailure,
} from '../src/daemon-bounce-recovery.mjs';

const REPO = 'laceyenterprises/agent-os';
const PR = 8000;
const HEAD = '20bb48842974cc28e1ddd5269dd3112cd58ed764';
const OTHER_HEAD = '9d1c0ffee0000000000000000000000000000000';
const SESSION = 'gemini-8000-session';
const STARTED_AT = '2026-10-09T15:15:17.000Z';
const BOUNCED_AT = new Date('2026-10-09T15:17:16.000Z');
const POSTED_AT = '2026-10-09T15:19:01.000Z';
const BOUNCE_MESSAGE = '[daemon-bounce] Reviewer runtime could not reattach after kernel restart; re-queueing review.';
const QUIET_LOG = { log() {}, warn() {}, error() {} };

function setup() {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'reviewbounce-'));
  mkdirSync(path.join(rootDir, 'data'), { recursive: true });
  const db = new Database(path.join(rootDir, 'data', 'reviews.db'));
  ensureReviewStateSchema(db);
  return { rootDir, db };
}

function insertReviewingRow(db, { session = SESSION, head = HEAD } = {}) {
  db.prepare(
    `INSERT INTO reviewed_prs (
       repo, pr_number, reviewed_at, reviewer, pr_state, review_status,
       review_attempts, reviewer_session_uuid, reviewer_started_at, reviewer_head_sha,
       reviewer_pgid, reviewer_timeout_ms, reviewer_lease_expires_at, infra_auto_recover_attempts
     ) VALUES (?, ?, ?, 'gemini', 'open', 'reviewing', 0, ?, ?, ?, 7171, 1200000, ?, 0)`
  ).run(REPO, PR, STARTED_AT, session, STARTED_AT, head, '2026-10-09T15:40:00.000Z');
}

function insertRunningPass(db, { head = HEAD, session = SESSION, commentId = '5180008000' } = {}) {
  db.prepare(
    `INSERT INTO reviewer_passes (
       repo, pr_number, attempt_number, reviewer_class, reviewer_model,
       pass_kind, started_at, status, head_sha, gh_comment_id,
       body_captured_at, verdict, body_md, metadata_json
     ) VALUES (?, ?, 1, 'gemini', 'gemini', 'first-pass', ?, 'running', ?, ?, ?, 'comment-only', ?, ?)`
  ).run(
    REPO,
    PR,
    STARTED_AT,
    head,
    commentId,
    commentId ? POSTED_AT : null,
    '## Adversarial Review — Gemini\n\n## Verdict\nComment only',
    JSON.stringify({ reviewerSessionUuid: session }),
  );
}

async function bounceWatcher(rootDir, db) {
  writeReviewerRunRecord(rootDir, {
    sessionUuid: SESSION,
    domain: 'code-pr',
    runtime: 'cli-direct',
    state: 'heartbeating',
    pgid: 7171,
    spawnedAt: STARTED_AT,
    lastHeartbeatAt: '2026-10-09T15:17:00.000Z',
    reattachToken: SESSION,
  });
  return recoverReviewerRunRecords({
    rootDir,
    adapter: { reattach: async () => ({ failureClass: DAEMON_BOUNCE_FAILURE_CLASS }) },
    db,
    log: QUIET_LOG,
    now: BOUNCED_AT,
    leaseRecoveryEnabled: true,
  });
}

function reviewRow(db) {
  return db.prepare('SELECT * FROM reviewed_prs WHERE repo = ? AND pr_number = ?').get(REPO, PR);
}

function reap(rootDir, db, followUps = []) {
  return reapRunningPassTimeouts({
    db,
    rootDir,
    log: QUIET_LOG,
    now: () => new Date('2026-10-09T15:19:30.000Z'),
    queueFollowUpForRecoveredPostedReviewImpl: (args) => {
      followUps.push(args);
      return { queued: false, reason: 'test-stub' };
    },
  });
}

function claimInfraRecovery(db, row, failureClass) {
  return db.prepare(MARK_INFRA_AUTO_RECOVERY_ATTEMPT_STARTED_SQL).run(
    '2026-10-09T15:20:00.000Z',
    'requeued-session',
    HEAD,
    null,
    1200000,
    '2026-10-09T15:40:00.000Z',
    REPO,
    PR,
    row.failed_at,
    row.reviewer_head_sha,
    DEFAULT_REVIEWER_LEASE_RECOVERY_MAX_ATTEMPTS,
    0,
    failureClass,
  );
}

test('a daemon bounce re-queues the row without charging review_attempts', async () => {
  const { rootDir, db } = setup();
  try {
    insertReviewingRow(db);
    assert.deepEqual(await bounceWatcher(rootDir, db), { recovered: 1, pruned: 0 });
    const row = reviewRow(db);
    assert.equal(row.review_status, 'pending');
    assert.equal(row.failure_message, BOUNCE_MESSAGE);
    assert.equal(row.review_attempts, 0);
    assert.equal(row.failed_at, BOUNCED_AT.toISOString());
  } finally {
    db.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('PR 8000 replay: the review posted after the bounce settles the row as posted for the exact head', async () => {
  const { rootDir, db } = setup();
  try {
    insertReviewingRow(db);
    await bounceWatcher(rootDir, db);
    // The incident row had already been finalized to `failed` with the legacy
    // bounce charge before the reviewer posted.
    db.prepare(`UPDATE reviewed_prs SET review_status = 'failed', review_attempts = 1 WHERE pr_number = ?`).run(PR);
    const failedRow = reviewRow(db);
    assert.equal(pickAdversarialGateStatus({ reviewRow: failedRow, headSha: HEAD }).reason, 'review-failed');

    insertRunningPass(db);
    const followUps = [];
    const result = reap(rootDir, db, followUps);
    assert.equal(result.postedReviewArtifactsRecovered, 1);

    const row = reviewRow(db);
    assert.equal(row.review_status, 'posted');
    assert.equal(row.posted_at, POSTED_AT);
    assert.equal(row.failed_at, null);
    assert.equal(row.failure_message, null);
    assert.equal(row.infra_auto_recover_attempts, 0);
    assert.equal(row.reviewer_head_sha, HEAD);
    const pass = db.prepare('SELECT status, verdict, ended_at FROM reviewer_passes WHERE pr_number = ?').get(PR);
    assert.deepEqual(pass, { status: 'completed', verdict: 'comment-only', ended_at: POSTED_AT });
    assert.equal(followUps.length, 1, 'recovered post must reach the follow-up queue like any recovered post');

    const gate = pickAdversarialGateStatus({ reviewRow: row, headSha: HEAD });
    assert.notEqual(gate.reason, 'review-failed');
    assert.equal(reviewRowInTerminalFailureState(row, HEAD), false);
  } finally {
    db.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('a still-pending bounced row also settles when the bounced reviewer posts', async () => {
  const { rootDir, db } = setup();
  try {
    insertReviewingRow(db);
    await bounceWatcher(rootDir, db);
    insertRunningPass(db);
    reap(rootDir, db);
    const row = reviewRow(db);
    assert.equal(row.review_status, 'posted');
    assert.equal(row.review_attempts, 1, 'the review that posted is the only attempt charged');
  } finally {
    db.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('an artifact for a different head never settles the bounced row', async () => {
  const { rootDir, db } = setup();
  try {
    insertReviewingRow(db);
    await bounceWatcher(rootDir, db);
    db.prepare(`UPDATE reviewed_prs SET review_status = 'failed' WHERE pr_number = ?`).run(PR);
    insertRunningPass(db, { head: OTHER_HEAD });
    reap(rootDir, db);
    const row = reviewRow(db);
    assert.equal(row.review_status, 'failed');
    assert.equal(row.failure_message, BOUNCE_MESSAGE);
    assert.equal(row.posted_at, null);
  } finally {
    db.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('an artifact with no head, or from another reviewer session, never settles the bounced row', async () => {
  for (const pass of [{ head: null }, { session: 'some-other-session' }]) {
    const { rootDir, db } = setup();
    try {
      insertReviewingRow(db);
      await bounceWatcher(rootDir, db);
      insertRunningPass(db, pass);
      reap(rootDir, db);
      assert.equal(reviewRow(db).review_status, 'pending', JSON.stringify(pass));
    } finally {
      db.close();
      rmSync(rootDir, { recursive: true, force: true });
    }
  }
});

test('only daemon-bounce failures take the bounced-posted settle', () => {
  const { rootDir, db } = setup();
  try {
    insertReviewingRow(db);
    db.prepare(
      `UPDATE reviewed_prs SET review_status = 'failed', failed_at = ?, failure_message = ? WHERE pr_number = ?`
    ).run(BOUNCED_AT.toISOString(), '[reviewer-timeout] Reviewer pass timed out.', PR);
    insertRunningPass(db);
    reap(rootDir, db);
    assert.equal(reviewRow(db).review_status, 'failed');
  } finally {
    db.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('a bounce with no artifact is infra-recoverable and re-queues against the infra cap only', async () => {
  const { rootDir, db } = setup();
  try {
    insertReviewingRow(db);
    await bounceWatcher(rootDir, db);
    const bounced = reviewRow(db);
    assert.equal(isDaemonBounceFailure(bounced), true);
    assert.equal(reviewRowInTerminalFailureState(bounced, HEAD), true,
      'an uncharged bounce must still route through the bounded infra CAS');
    assert.equal(reviewRowInTerminalFailureState(bounced, OTHER_HEAD), false,
      'a moved head is a fresh review, not a bounce retry');
    assert.equal(infraRecoverableFailureClass(bounced), DAEMON_BOUNCE_FAILURE_CLASS);

    assert.equal(claimInfraRecovery(db, bounced, DAEMON_BOUNCE_FAILURE_CLASS).changes, 1);
    const claimed = reviewRow(db);
    assert.equal(claimed.review_status, 'reviewing');
    assert.equal(claimed.review_attempts, 0);
    assert.equal(claimed.infra_auto_recover_attempts, 1);
    assert.equal(claimed.failure_message, null);
  } finally {
    db.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('a legacy failed bounce row re-queues without touching review_attempts, bounded by the infra cap', async () => {
  const { rootDir, db } = setup();
  try {
    insertReviewingRow(db);
    await bounceWatcher(rootDir, db);
    db.prepare(`UPDATE reviewed_prs SET review_status = 'failed', review_attempts = 1 WHERE pr_number = ?`).run(PR);
    const failed = reviewRow(db);
    assert.equal(infraRecoverableFailureClass(failed), DAEMON_BOUNCE_FAILURE_CLASS);
    assert.equal(claimInfraRecovery(db, failed, DAEMON_BOUNCE_FAILURE_CLASS).changes, 1);
    assert.equal(reviewRow(db).review_attempts, 1);

    db.prepare(
      `UPDATE reviewed_prs SET review_status = 'failed', failure_message = ?, infra_auto_recover_attempts = ? WHERE pr_number = ?`
    ).run(BOUNCE_MESSAGE, DEFAULT_REVIEWER_LEASE_RECOVERY_MAX_ATTEMPTS, PR);
    assert.equal(claimInfraRecovery(db, reviewRow(db), DAEMON_BOUNCE_FAILURE_CLASS).changes, 0,
      'the infra cap still bounds bounce re-queues');
    assert.equal(claimInfraRecovery(db, failed, 'reviewer-timeout').changes, 0,
      'the class guard still ties the claim to the stored tag');
  } finally {
    db.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('daemonBounceReviewerHold waits only for a verified, live, in-budget bounced reviewer', () => {
  const row = {
    failure_message: BOUNCE_MESSAGE,
    failed_at: BOUNCED_AT.toISOString(),
    reviewer_pgid: 7171,
    reviewer_started_at: STARTED_AT,
    reviewer_timeout_ms: 1200000,
  };
  const alive = () => true;
  const verified = () => ({ match: true });
  const now = Date.parse('2026-10-09T15:18:00.000Z');

  const held = daemonBounceReviewerHold(row, { now, isAlive: alive, verifyIdentity: verified });
  assert.equal(held.hold, true);
  assert.equal(held.holdUntilMs, Date.parse(STARTED_AT) + 1200000);

  assert.equal(daemonBounceReviewerHold(row, { now, isAlive: () => false, verifyIdentity: verified }).hold, false);
  assert.equal(daemonBounceReviewerHold(row, { now, isAlive: () => null, verifyIdentity: verified }).hold, false);
  assert.equal(daemonBounceReviewerHold(row, { now, isAlive: alive, verifyIdentity: () => ({ match: false }) }).hold, false);
  assert.equal(daemonBounceReviewerHold(row, {
    now: Date.parse(STARTED_AT) + 1200000, isAlive: alive, verifyIdentity: verified,
  }).hold, false);
  assert.equal(daemonBounceReviewerHold({ ...row, reviewer_pgid: null }, { now, isAlive: alive, verifyIdentity: verified }).hold, false);
  assert.equal(daemonBounceReviewerHold({ ...row, failure_message: '[reviewer-timeout] x' }, {
    now, isAlive: alive, verifyIdentity: verified,
  }).hold, false);
  const fallback = daemonBounceReviewerHold({ ...row, reviewer_timeout_ms: null }, {
    now, isAlive: alive, verifyIdentity: verified,
  });
  assert.equal(fallback.holdUntilMs, BOUNCED_AT.getTime() + 60 * 60 * 1000);
});
