import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { spawn } from 'node:child_process';

import { ensureReviewStateSchema } from '../src/review-state.mjs';
import { prepareMarkAttemptStarted } from '../src/review-state-statements.mjs';
import {
  shouldReconcileReviewerSession,
  shouldReconcileStaleReviewerSession,
} from '../src/reviewer-orphan-reconcile.mjs';
import { reconcileReviewerSessions } from '../src/reviewer-reattach.mjs';

// SEV (agent-os #5059): a remediation advanced the PR head, a fresh review
// auto-armed, but the reviewer holding the `reviewing` single-owner claim
// DIED/HUNG without posting or releasing. The only per-poll release path
// (reconcileReviewerSessions, filtered by shouldReconcileReviewerSession) was
// gated behind the full ~20-min reviewer lease, so the dead reviewer's claim was
// invisible to recovery for the whole lease and the head sat un-reviewed ~30 min.
// These tests pin the lease-INDEPENDENT dead-reviewer fast path and its safety
// invariant (a provably-ALIVE reviewer keeps its full lease untouched).

const REPO = 'laceyenterprises/adversarial-review';
const PR = 5059;
const HEAD_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const HEAD_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const GRACE_MS = 300_000; // one poll interval; matches DEAD_REVIEWER_FAST_PATH_GRACE_MS
const LEASE_TIMEOUT_MS = 20 * 60 * 1000; // 1_200_000 — lease NOT expired in these fixtures

function setupDb() {
  const db = new Database(':memory:');
  ensureReviewStateSchema(db);
  return db;
}

function seedReviewing(db, overrides = {}) {
  db.prepare(
    `INSERT INTO reviewed_prs
       (repo, pr_number, reviewed_at, reviewer, pr_state, review_status,
        review_attempts, last_attempted_at, reviewer_session_uuid,
        reviewer_pgid, reviewer_started_at, reviewer_head_sha, reviewer_timeout_ms,
        reviewer_lease_expires_at, infra_auto_recover_attempts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    overrides.repo || REPO,
    overrides.prNumber || PR,
    '2026-08-08T21:00:00.000Z',
    overrides.reviewer || 'codex',
    'open',
    'reviewing',
    overrides.reviewAttempts ?? 2,
    Object.prototype.hasOwnProperty.call(overrides, 'lastAttemptedAt')
      ? overrides.lastAttemptedAt
      : overrides.startedAt,
    Object.prototype.hasOwnProperty.call(overrides, 'sessionUuid')
      ? overrides.sessionUuid
      : 'session-5059',
    Object.prototype.hasOwnProperty.call(overrides, 'pgid') ? overrides.pgid : 9001,
    overrides.startedAt,
    Object.prototype.hasOwnProperty.call(overrides, 'headSha') ? overrides.headSha : HEAD_A,
    Object.prototype.hasOwnProperty.call(overrides, 'reviewerTimeoutMs')
      ? overrides.reviewerTimeoutMs
      : LEASE_TIMEOUT_MS,
    Object.prototype.hasOwnProperty.call(overrides, 'reviewerLeaseExpiresAt')
      ? overrides.reviewerLeaseExpiresAt
      : null,
    overrides.infraAutoRecoverAttempts ?? 0
  );
}

function readRow(db, repo = REPO, prNumber = PR) {
  return db.prepare('SELECT * FROM reviewed_prs WHERE repo = ? AND pr_number = ?').get(repo, prNumber);
}

function makeOctokit(reviews = []) {
  return {
    rest: { pulls: { listReviews: async () => ({ data: reviews }) } },
  };
}

function makeLog() {
  const lines = [];
  return {
    lines,
    log(message) { lines.push(String(message)); },
    warn(message) { lines.push(String(message)); },
  };
}

// A detached child is its own process-group leader (setsid), so child.pid == pgid
// and probeReviewerProcessGroupAlive(child.pid) exercises the real kill(-pgid,0).
function spawnAlivePgid(t) {
  const child = spawn('sleep', ['120'], { detached: true, stdio: 'ignore' });
  child.unref();
  t.after(() => {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
  });
  return child.pid;
}

async function makeDeadPgid() {
  const child = spawn('sleep', ['120'], { detached: true, stdio: 'ignore' });
  const pid = child.pid;
  await new Promise((resolve) => {
    child.once('exit', resolve);
    try { process.kill(-pid, 'SIGKILL'); } catch { process.kill(pid, 'SIGKILL'); }
  });
  return pid;
}

test('shouldReconcileReviewerSession fast-paths a provably-dead reviewer before lease expiry', async () => {
  const now = new Date('2026-08-08T21:19:26.000Z'); // #5059: re-review start that then hung
  const startedAt = new Date(now.getTime() - (GRACE_MS + 1000)).toISOString();
  const db = setupDb();

  const deadPgid = await makeDeadPgid();
  seedReviewing(db, { startedAt, pgid: deadPgid, headSha: HEAD_A });
  const row = readRow(db);

  // Lease is deliberately NOT expired: started + 20min is well in the future,
  // so the legacy lease-gated path would leave this row invisible.
  assert.equal(
    shouldReconcileStaleReviewerSession(row, now, { leaseRecoveryEnabled: true, probeGroupAliveImpl: () => true }),
    false,
    'sanity: with the reviewer treated as ALIVE the row is not eligible pre-lease',
  );
  // The real pgid probe (no injection) proves the dead reviewer is now eligible.
  assert.equal(
    shouldReconcileReviewerSession(row, now),
    true,
    'dead reviewer past the grace is eligible for reconcile BEFORE the ~20-min lease',
  );
});

test('shouldReconcileReviewerSession leaves a provably-ALIVE same-lease reviewer alone (safety invariant)', async (t) => {
  const now = new Date('2026-08-08T21:19:26.000Z');
  const startedAt = new Date(now.getTime() - (GRACE_MS + 1000)).toISOString();
  const db = setupDb();

  const alivePgid = spawnAlivePgid(t);
  // IDENTICAL fixture to the dead case except the pgid points at a live group.
  seedReviewing(db, { startedAt, pgid: alivePgid, headSha: HEAD_A });
  const row = readRow(db);

  assert.equal(
    shouldReconcileReviewerSession(row, now),
    false,
    'a live slow reviewer keeps its full lease and is NEVER fast-pathed',
  );
});

test('reconcile releases a dead reviewer whose head advanced -> pending + armable (releaseSuperseded)', async () => {
  const now = new Date('2026-08-08T21:19:26.000Z');
  const startedAt = new Date(now.getTime() - (GRACE_MS + 1000)).toISOString();
  const db = setupDb();
  seedReviewing(db, { startedAt, pgid: 9001, headSha: HEAD_A });
  const log = makeLog();
  const settled = [];

  const result = await reconcileReviewerSessions({
    db,
    octokit: makeOctokit([]),
    now,
    log,
    leaseRecoveryEnabled: true,
    // Poll filter uses the real predicate; inject a dead group probe so the fast
    // path surfaces the row deterministically (no live process needed here).
    shouldReconcileRow: (r, n) => shouldReconcileReviewerSession(r, n, { probeGroupAliveImpl: () => false }),
    probeAlive: () => false, // reviewer process group is dead
    fetchHeadSha: async () => HEAD_B, // remediation advanced the head
    killProcessGroup: () => {},
    onTerminalDeadSession: async (event) => settled.push(event),
  });

  const row = readRow(db);
  assert.equal(result.reconciled, 1);
  assert.equal(row.review_status, 'pending', 'stuck reviewing claim released to pending');
  assert.equal(row.reviewer_head_sha, null, 'superseded head cleared');
  assert.equal(row.reviewer_session_uuid, null);
  assert.equal(row.reviewer_pgid, null);
  assert.deepEqual(
    settled.map(({ state, reason }) => ({ state, reason })),
    [{ state: 'cancelled', reason: 'stale-head-superseded' }],
  );
  assert.match(log.lines.join('\n'), /reviewer_reattach_invalidated/);

  // Armable: the claim CAS (only fires on pending/pending-upstream) now matches.
  const leaseExpiry = new Date(now.getTime() + LEASE_TIMEOUT_MS).toISOString();
  const armed = prepareMarkAttemptStarted(db).run(
    now.toISOString(), 'fresh-session', HEAD_B, LEASE_TIMEOUT_MS, leaseExpiry, REPO, PR,
  );
  assert.equal(armed.changes, 1, 'released row is re-armable by the reviewer claim CAS');
});

test('reconcile releases a dead reviewer on the SAME head -> pending (releasePending; the #5059 case)', async () => {
  const now = new Date('2026-08-08T21:19:26.000Z');
  const startedAt = new Date(now.getTime() - (GRACE_MS + 1000)).toISOString();
  const db = setupDb();
  seedReviewing(db, { startedAt, pgid: 9001, headSha: HEAD_A });
  const log = makeLog();
  const settled = [];

  const result = await reconcileReviewerSessions({
    db,
    octokit: makeOctokit([]), // no posted review from the dead worker
    now,
    log,
    leaseRecoveryEnabled: true,
    shouldReconcileRow: (r, n) => shouldReconcileReviewerSession(r, n, { probeGroupAliveImpl: () => false }),
    probeAlive: () => false, // dead worker, same head
    fetchHeadSha: async () => HEAD_A,
    onTerminalDeadSession: async (event) => settled.push(event),
  });

  const row = readRow(db);
  assert.equal(result.reconciled, 1);
  assert.equal(row.review_status, 'pending', 'dead same-head worker requeued to pending');
  assert.equal(row.reviewer_session_uuid, null);
  assert.deepEqual(
    settled.map(({ state, reason }) => ({ state, reason })),
    [{ state: 'cancelled', reason: 'dead-no-review' }],
  );
  assert.match(log.lines.join('\n'), /reviewer_reattach_requeued/);
});
