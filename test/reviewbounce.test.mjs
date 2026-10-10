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
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { ensureReviewStateSchema } from '../src/review-state.mjs';
import { recoverReviewerRunRecords } from '../src/adapters/reviewer-runtime/index.mjs';
import { writeReviewerRunRecord } from '../src/adapters/reviewer-runtime/run-state.mjs';
import { reapRunningPassTimeouts, queueFollowUpForRecoveredPostedReview } from '../src/reviewer-pass-reaper.mjs';
import { reviewRowInTerminalFailureState } from '../src/pollonce-phases.mjs';
import { infraRecoverableFailureClass } from '../src/reviewer-failure-classification.mjs';
import {
  MARK_INFRA_AUTO_RECOVERY_ATTEMPT_STARTED_SQL,
  MARK_DAEMON_BOUNCE_RECOVERY_ATTEMPT_STARTED_SQL,
} from '../src/review-state-statements.mjs';
import { settleDaemonBouncePostedReview } from '../src/daemon-bounce-posted-review.mjs';
import { DEFAULT_REVIEWER_LEASE_RECOVERY_MAX_ATTEMPTS } from '../src/reviewer-lease.mjs';
import { pickAdversarialGateStatus } from '../src/adversarial-gate-status.mjs';
import {
  DAEMON_BOUNCE_FAILURE_CLASS,
  daemonBounceReviewerHold,
  bouncedPostedReviewSettleSql,
  reconcileDaemonBounceBeforeRetry,
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
  if (failureClass === DAEMON_BOUNCE_FAILURE_CLASS) {
    return db.prepare(MARK_DAEMON_BOUNCE_RECOVERY_ATTEMPT_STARTED_SQL).run(
      '2026-10-09T15:20:00.000Z', 'requeued-session', HEAD, null, 1200000,
      '2026-10-09T15:40:00.000Z', REPO, PR,
      row.reviewer_session_uuid, row.reviewer_started_at, row.failed_at,
      row.reviewer_head_sha, DEFAULT_REVIEWER_LEASE_RECOVERY_MAX_ATTEMPTS,
    );
  }
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

for (const status of ['failed', 'pending']) {
  for (const [field, value] of [
    ['reviewer_session_uuid', 'new-bounce-session'],
    ['reviewer_started_at', '2026-10-09T15:21:00.000Z'],
    ['failed_at', '2026-10-09T15:22:00.000Z'],
    ['reviewer_head_sha', OTHER_HEAD],
  ]) test(`bounce replacement refuses changed ${field} on a ${status} row`, async () => {
    const { rootDir, db } = setup();
    try {
      insertReviewingRow(db);
      await bounceWatcher(rootDir, db);
      const inspected = reviewRow(db);
      const result = await expiredBounceRecovery({ db, overrides: {
        isAlive: () => false,
        sleep: async () => {},
        findPostedReview: async () => {
          db.prepare(`UPDATE reviewed_prs SET review_status = ?, ${field} = ?
            WHERE pr_number = ?`).run(status, value, PR);
          return null;
        },
      } });
      assert.equal(result.handled, false, 'only the inspected process was confirmed dead');
      const replacement = reviewRow(db);
      assert.equal(claimInfraRecovery(db, inspected, DAEMON_BOUNCE_FAILURE_CLASS).changes, 0);
      assert.deepEqual(reviewRow(db), replacement, 'new process evidence and attempts must survive');
    } finally {
      db.close();
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
}

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

test('daemonBounceReviewerHold never releases a live bounced reviewer merely because its timeout expired', () => {
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
  assert.equal(daemonBounceReviewerHold(row, { now, isAlive: () => null, verifyIdentity: verified }).hold, true);
  assert.equal(daemonBounceReviewerHold(row, { now, isAlive: alive, verifyIdentity: () => ({ match: false }) }).hold, true);
  assert.equal(daemonBounceReviewerHold(row, {
    now: Date.parse(STARTED_AT) + 1200000, isAlive: alive, verifyIdentity: verified,
  }).hold, true);
  assert.equal(daemonBounceReviewerHold({ ...row, reviewer_pgid: null }, { now, isAlive: alive, verifyIdentity: verified }).hold, true);
  assert.equal(daemonBounceReviewerHold({ ...row, failure_message: '[reviewer-timeout] x' }, {
    now, isAlive: alive, verifyIdentity: verified,
  }).hold, false);
  const fallback = daemonBounceReviewerHold({ ...row, reviewer_timeout_ms: null }, {
    now, isAlive: alive, verifyIdentity: verified,
  });
  assert.equal(fallback.holdUntilMs, BOUNCED_AT.getTime() + 60 * 60 * 1000);
  assert.equal(daemonBounceReviewerHold({ ...row, reviewer_timeout_ms: null }, {
    now: BOUNCED_AT.getTime() + 60 * 60 * 1000, isAlive: alive, verifyIdentity: verified,
  }).expired, false, 'a fallback hold is not a persisted timeout that authorizes termination');
});

// Integration with the actual bounce transition, posted-settle SQL and infra
// claim: every async step must preserve the original claim until recovery wins.
async function expiredBounceRecovery({ db, overrides = {}, events = [] }) {
  const row = reviewRow(db);
  return reconcileDaemonBounceBeforeRetry({
    row,
    now: Date.parse(STARTED_AT) + row.reviewer_timeout_ms,
    ownPgid: () => 9999,
    verifyIdentity: () => ({ match: true }),
    isAlive: () => true,
    sleep: async (ms) => {
      events.push(`wait:${ms}`);
      assert.deepEqual(reviewRow(db), row, 'cleanup/reprobe must preserve original claim evidence');
    },
    findPostedReview: async (candidate, options) => {
      assert.equal(candidate.reviewer_session_uuid, SESSION);
      assert.deepEqual(options, { refresh: true, headSha: HEAD });
      events.push('probe');
      return null;
    },
    markPosted: ({ row, postedAt }) => db.prepare(bouncedPostedReviewSettleSql(
      'reviewer_session_uuid = ? AND reviewer_started_at = ? AND failed_at = ?'
    )).run(postedAt, row.repo, row.pr_number, row.reviewer_head_sha,
      row.reviewer_head_sha, row.reviewer_session_uuid, row.reviewer_started_at, row.failed_at).changes,
    settleRunRecord: async ({ state }) => { events.push(`settle:${state}`); },
    ...overrides,
  });
}

test('expired live bounce allows replacement only after TERM/KILL exit confirmation and late-post reprobes', async () => {
  const { rootDir, db } = setup();
  try {
    insertReviewingRow(db);
    await bounceWatcher(rootDir, db);
    const events = [];
    let alive = true;
    const result = await expiredBounceRecovery({ db, events, overrides: {
      isAlive: () => alive,
      killProcessGroup: (pgid, signal) => {
        assert.equal(pgid, 7171);
        events.push(signal);
        if (signal === 'SIGKILL') alive = false;
      },
    } });
    assert.deepEqual(events, ['SIGTERM', 'wait:200', 'wait:200', 'wait:200',
      'SIGKILL', 'wait:100', 'probe', 'wait:500', 'probe', 'wait:1500', 'probe',
      'wait:3000', 'probe', 'settle:cancelled']);
    assert.equal(result.handled, false);
    assert.equal(reviewRow(db).reviewer_session_uuid, SESSION);
    assert.equal(claimInfraRecovery(db, reviewRow(db), DAEMON_BOUNCE_FAILURE_CLASS).changes, 1);
    assert.equal(reviewRow(db).reviewer_session_uuid, 'requeued-session');
  } finally {
    db.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('a late exact-head review after expired-bounce termination settles the original claim instead of replacing it', async () => {
  const { rootDir, db } = setup();
  try {
    insertReviewingRow(db);
    await bounceWatcher(rootDir, db);
    const events = [];
    let alive = true;
    let probes = 0;
    const result = await expiredBounceRecovery({ db, events, overrides: {
      isAlive: () => alive,
      killProcessGroup: (_pgid, signal) => { events.push(signal); alive = false; },
      findPostedReview: async () => {
        assert.equal(alive, false, 'late-post reconciliation follows confirmed process exit');
        events.push('probe');
        probes += 1;
        return probes === 4 ? { commit_id: HEAD, submitted_at: POSTED_AT } : null;
      },
    } });
    assert.equal(result.reason, 'marked-posted');
    assert.equal(result.handled, true);
    assert.equal(events.includes('SIGKILL'), false);
    assert.equal(events.at(-1), 'settle:completed');
    assert.equal(reviewRow(db).review_status, 'posted');
    assert.equal(reviewRow(db).reviewer_session_uuid, SESSION);
    assert.equal(reviewRow(db).infra_auto_recover_attempts, 0);
    assert.equal(claimInfraRecovery(db, reviewRow(db), DAEMON_BOUNCE_FAILURE_CLASS).changes, 0);
  } finally {
    db.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('inconclusive expired-bounce cleanup or GitHub reconciliation preserves the entire original claim', async () => {
  for (const mode of ['survives', 'unknown-liveness', 'unknown-identity', 'signal-failure',
    'identity-changed', 'probe-failure', 'cas-lost', 'own-group', 'unknown-own-group']) {
    const { rootDir, db } = setup();
    try {
      insertReviewingRow(db);
      await bounceWatcher(rootDir, db);
      const original = reviewRow(db);
      const events = [];
      let alive = !['probe-failure', 'cas-lost'].includes(mode);
      let identityMatch = mode !== 'unknown-identity';
      const result = await expiredBounceRecovery({ db, events, overrides: {
        isAlive: () => mode === 'unknown-liveness' ? null : alive,
        verifyIdentity: () => ({ match: identityMatch }),
        ownPgid: () => mode === 'own-group' ? 7171 : mode === 'unknown-own-group' ? null : 9999,
        killProcessGroup: (_pgid, signal) => {
          events.push(signal);
          if (mode === 'signal-failure') throw new Error('EPERM');
          if (mode === 'identity-changed') identityMatch = false;
        },
        findPostedReview: async () => {
          if (mode === 'probe-failure') throw new Error('GitHub timeout');
          if (mode === 'cas-lost') return { commit_id: HEAD, submitted_at: POSTED_AT };
          assert.fail('unconfirmed process exit must never reach the review probe');
        },
        markPosted: () => 0,
      } });
      assert.equal(result.handled, true, mode);
      assert.deepEqual(reviewRow(db), original, mode);
      assert.equal(events.some((event) => event.startsWith('settle:')), false, mode);
      if (mode === 'identity-changed') assert.equal(events.includes('SIGKILL'), false);
      if (['unknown-liveness', 'unknown-identity', 'own-group', 'unknown-own-group'].includes(mode)) {
        assert.equal(events.length, 0, mode);
      }
    } finally {
      db.close();
      rmSync(rootDir, { recursive: true, force: true });
    }
  }
});

test('expired-bounce late-post settlement cannot overwrite a replacement session', async () => {
  const { rootDir, db } = setup();
  try {
    insertReviewingRow(db);
    await bounceWatcher(rootDir, db);
    const result = await expiredBounceRecovery({ db, overrides: {
      isAlive: () => false,
      findPostedReview: async () => {
        claimInfraRecovery(db, reviewRow(db), DAEMON_BOUNCE_FAILURE_CLASS);
        return { commit_id: HEAD, submitted_at: POSTED_AT };
      },
      settleRunRecord: async () => assert.fail('lost CAS must not settle a run record'),
    } });
    assert.equal(result.reason, 'posted-reconcile-cas-lost');
    assert.equal(result.handled, true);
    assert.equal(reviewRow(db).review_status, 'reviewing');
    assert.equal(reviewRow(db).reviewer_session_uuid, 'requeued-session');
  } finally {
    db.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

const BLOCKING_REVIEW = {
  id: 5180008000,
  commit_id: HEAD,
  submitted_at: POSTED_AT,
  state: 'CHANGES_REQUESTED',
  body: '## Blocking Issues\n\n- **Broken handoff**\n  - Queue is missing.\n\n## Verdict\nRequest changes',
};

function queueRecoveredReview(args) {
  return queueFollowUpForRecoveredPostedReview({
    ...args,
    summarizePRRemediationLedgerImpl: () => ({ completedRoundsForPR: 0 }),
    resolveRoundBudgetForJobImpl: () => ({ riskClass: 'critical', roundBudget: 2 }),
    resolveHandoffConfigImpl: () => ({ enabled: false }),
    readSingleReviewDecisionImpl: () => null,
  });
}

test('bounce probe captures a blocking review and hands off before a later artifact arrives', async () => {
  const { rootDir, db } = setup();
  try {
    insertReviewingRow(db);
    await bounceWatcher(rootDir, db);
    insertRunningPass(db, { commentId: null });
    db.exec('UPDATE reviewer_passes SET body_md = NULL, verdict = NULL');
    let handoff;
    const result = await expiredBounceRecovery({ db, overrides: {
      isAlive: () => false,
      findPostedReview: async () => BLOCKING_REVIEW,
      markPosted: (args) => settleDaemonBouncePostedReview({ db, rootDir, ...args,
        queueFollowUp: (payload) => {
          assert.equal(payload.row.body_md, BLOCKING_REVIEW.body);
          assert.equal(payload.row.verdict, 'request-changes');
          assert.equal(payload.row.gh_comment_id, String(BLOCKING_REVIEW.id));
          handoff = queueRecoveredReview(payload);
        },
      }),
    } });
    assert.equal(result.reason, 'marked-posted');
    assert.equal(reviewRow(db).review_status, 'posted');
    const pass = db.prepare('SELECT * FROM reviewer_passes').get();
    assert.equal(pass.body_md, BLOCKING_REVIEW.body);
    assert.equal(pass.verdict, 'request-changes');
    assert.equal(pass.gh_comment_id, String(BLOCKING_REVIEW.id));
    assert.equal(pass.body_captured_at, POSTED_AT);
    assert.equal(pass.status, 'completed');
    const job = JSON.parse(readFileSync(handoff.jobPath, 'utf8'));
    assert.equal(job.reviewBody, BLOCKING_REVIEW.body);
    assert.equal(job.revisionRef, HEAD);
    // The original reviewer may finish artifact capture even after probe recovery.
    db.prepare('UPDATE reviewer_passes SET body_captured_at = ? WHERE pass_id = ?')
      .run('2026-10-09T15:20:00.000Z', pass.pass_id);
    const followUps = [];
    reap(rootDir, db, followUps);
    assert.equal(followUps.length, 0, 'the completed recovered pass already has its handoff');
    assert.equal(queueRecoveredReview({ rootDir, row: pass, reviewRow: reviewRow(db),
      reviewPostedAt: POSTED_AT }).reason, 'duplicate-review-follow-up');
  } finally {
    db.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

for (const failure of ['capture', 'queue', 'after-queue']) {
  test(`late-post settlement remains retryable after ${failure} failure`, async () => {
    const { rootDir, db } = setup();
    try {
      insertReviewingRow(db);
      await bounceWatcher(rootDir, db);
      insertRunningPass(db, { commentId: null });
      db.exec('UPDATE reviewer_passes SET body_md = NULL, verdict = NULL');
      const original = reviewRow(db);
      const originalPass = db.prepare('SELECT * FROM reviewer_passes').get();
      if (failure === 'capture') {
        db.exec(`CREATE TRIGGER reject_capture BEFORE UPDATE ON reviewer_passes
          BEGIN SELECT RAISE(ABORT, 'fixture capture failure'); END`);
      }
      const recover = (queueFollowUp) => expiredBounceRecovery({ db, overrides: {
        isAlive: () => false,
        findPostedReview: async () => BLOCKING_REVIEW,
        markPosted: (args) => settleDaemonBouncePostedReview({ db, rootDir, ...args, queueFollowUp }),
      } });
      const failed = await recover((args) => {
        if (failure === 'after-queue') queueRecoveredReview(args);
        throw new Error('fixture queue failure');
      });
      assert.equal(failed.reason, 'bounce-recovery-inconclusive');
      assert.deepEqual(reviewRow(db), original);
      assert.deepEqual(db.prepare('SELECT * FROM reviewer_passes').get(), originalPass);
      if (failure === 'capture') db.exec('DROP TRIGGER reject_capture');
      let handoff;
      const retried = await recover((args) => { handoff = queueRecoveredReview(args); });
      assert.equal(retried.reason, 'marked-posted');
      assert.equal(reviewRow(db).review_attempts, 1);
      assert.equal(handoff.queued, failure !== 'after-queue');
      if (failure === 'after-queue') assert.equal(handoff.reason, 'duplicate-review-follow-up');
    } finally {
      db.close();
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
}
