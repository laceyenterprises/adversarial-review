// TOKDZ-01 — a `token-refresh-pending` refusal is a bounded hold, not a failed
// review attempt. These tests drive the real settle path, the real hold SQL, and
// the real route selection.
import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ensureReviewStateSchema } from '../src/review-state.mjs';
import {
  prepareMarkTokenRefreshHold,
} from '../src/review-state-statements.mjs';
import {
  readCascadeState,
  recordCascadeFailure,
  shouldBackoffReviewerSpawn,
} from '../src/reviewer-cascade.mjs';
import { settleReviewerAttempt } from '../src/reviewer-spawn-settle.mjs';
import { selectReviewerRouteForAttempt } from '../src/reviewer-route-selection.mjs';
import {
  TOKEN_REFRESH_ROTATION_GRACE_MS,
  computeTokenRefreshHold,
  parseTokenRefreshRefusal,
  resolveTokenRefreshHoldConfig,
  tokenRefreshHoldExhausted,
} from '../src/token-refresh-hold.mjs';

const REPO = 'laceyenterprises/agent-os';
const PR = 7286;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const CONFIG = resolveTokenRefreshHoldConfig({});

// The exact refusal the live reviewer printed on 2026-09-28 (#7286), plus the
// `expires_at` field the reviewer now appends.
function refusalText({ remainingMs, expiresAt = null }) {
  return '[token-refresh-pending] broker Claude reviewer token expires too soon for subprocess handoff: '
    + `remaining=${remainingMs}ms minimum=10919571ms${expiresAt ? ` expires_at=${expiresAt}` : ''}`;
}

function setupFixture({ infraAttempts = 0, reviewAttempts = 0 } = {}) {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'token-refresh-hold-'));
  mkdirSync(path.join(rootDir, 'data'), { recursive: true });
  const db = new Database(path.join(rootDir, 'data', 'reviews.db'));
  ensureReviewStateSchema(db);
  db.prepare(
    `INSERT INTO reviewed_prs
       (repo, pr_number, reviewed_at, reviewer, pr_state, review_status, review_attempts,
        infra_auto_recover_attempts, reviewer_session_uuid, reviewer_head_sha)
     VALUES (?, ?, ?, 'claude', 'open', 'reviewing', ?, ?, 'session-1', 'head-1')`
  ).run(REPO, PR, '2026-09-28T12:00:00.000Z', reviewAttempts, infraAttempts);
  const statements = {
    markPosted: db.prepare(
      "UPDATE reviewed_prs SET review_status = 'posted', review_attempts = review_attempts + 1 WHERE repo = ? AND pr_number = ?"
    ),
    markFailed: db.prepare(
      "UPDATE reviewed_prs SET review_status = 'failed', failed_at = ?, failure_message = ?, review_attempts = review_attempts + 1 WHERE repo = ? AND pr_number = ?"
    ),
    releaseReviewLease: db.prepare(
      "UPDATE reviewed_prs SET review_status = 'pending', failed_at = ?, failure_message = ?, review_attempts = review_attempts + 1 WHERE repo = ? AND pr_number = ? AND review_status = 'reviewing'"
    ),
    markCascadeFailed: db.prepare(
      "UPDATE reviewed_prs SET review_status = 'failed', failed_at = ?, failure_message = ? WHERE repo = ? AND pr_number = ?"
    ),
    markPendingUpstream: db.prepare(
      "UPDATE reviewed_prs SET review_status = 'pending-upstream', failed_at = ?, failure_message = ?, infra_auto_recover_attempts = COALESCE(infra_auto_recover_attempts, 0) + 1 WHERE repo = ? AND pr_number = ?"
    ),
    markTokenRefreshHold: prepareMarkTokenRefreshHold(db),
    getReviewRow: db.prepare('SELECT * FROM reviewed_prs WHERE repo = ? AND pr_number = ?'),
  };
  const readRow = () => statements.getReviewRow.get(REPO, PR);
  const reclaim = () => db.prepare(
    "UPDATE reviewed_prs SET review_status = 'reviewing', reviewer_session_uuid = 'session-n' WHERE repo = ? AND pr_number = ?"
  ).run(REPO, PR);
  return {
    rootDir,
    db,
    statements,
    readRow,
    reclaim,
    cleanup: () => {
      db.close();
      rmSync(rootDir, { recursive: true, force: true });
    },
  };
}

function settleRefusal(fixture, { failureAt, remainingMs, expiresAt = null }) {
  const warnings = [];
  settleReviewerAttempt({
    rootDir: fixture.rootDir,
    repoPath: REPO,
    prNumber: PR,
    reviewerModel: 'claude',
    result: {
      ok: false,
      failureClass: 'token-refresh-pending',
      error: 'Command failed with code 1',
      stderr: refusalText({ remainingMs, expiresAt }),
    },
    failureAt,
    maxRemediationRounds: 3,
    statements: fixture.statements,
    log: { warn: (line) => warnings.push(line) },
  });
  return warnings;
}

function claudeRoute() {
  return { reviewerModel: 'claude', botTokenEnv: 'GH_CLAUDE_REVIEWER_TOKEN', builderClass: 'codex' };
}

test('parseTokenRefreshRefusal reads the live refusal and prefers expires_at', () => {
  assert.deepEqual(parseTokenRefreshRefusal(refusalText({ remainingMs: 4994933 })), {
    remainingMs: 4994933,
    minimumMs: 10919571,
    expiresAtMs: null,
  });
  const parsed = parseTokenRefreshRefusal(refusalText({
    remainingMs: 4994933,
    expiresAt: '2026-09-28T20:54:30Z',
  }));
  assert.equal(parsed.expiresAtMs, Date.parse('2026-09-28T20:54:30Z'));
  assert.equal(parseTokenRefreshRefusal('[token-refresh-pending] no numbers here'), null);
});

test('hold waits for the expected rotation (expiry minus the bridge refresh window)', () => {
  const failureAtMs = Date.parse('2026-09-28T19:31:10Z');
  const hold = computeTokenRefreshHold({
    failureAtMs,
    floorMs: failureAtMs + MINUTE,
    // 35 min left: the bridge rotates at 30 min left, i.e. 5 min from now.
    refusal: { remainingMs: 35 * MINUTE, expiresAtMs: null },
    config: CONFIG,
  });
  assert.equal(hold.expectedRotationAt, new Date(failureAtMs + 5 * MINUTE).toISOString());
  assert.equal(hold.holdUntil, new Date(failureAtMs + 5 * MINUTE + TOKEN_REFRESH_ROTATION_GRACE_MS).toISOString());
  assert.equal(hold.maxHoldUntil, new Date(failureAtMs + CONFIG.maxHoldMs).toISOString());
  assert.equal(hold.refusals, 1);
});

test('hold is bounded: a far-off rotation parks only until maxHoldUntil, an overdue one re-checks on the backoff floor', () => {
  const failureAtMs = Date.parse('2026-09-28T19:31:10Z');
  const far = computeTokenRefreshHold({
    failureAtMs,
    floorMs: failureAtMs + MINUTE,
    // The live refusal: 83 min left, rotation 53 min out -- past the 30 min bound.
    refusal: { remainingMs: 4994933, expiresAtMs: null },
    config: CONFIG,
  });
  assert.equal(far.holdUntil, far.maxHoldUntil);
  const overdue = computeTokenRefreshHold({
    failureAtMs,
    floorMs: failureAtMs + 2 * MINUTE,
    // 4 min left: the bridge is 26 min late. Never tight-loop on it.
    refusal: { remainingMs: 4 * MINUTE, expiresAtMs: null },
    config: CONFIG,
  });
  assert.equal(overdue.holdUntil, new Date(failureAtMs + 2 * MINUTE).toISOString());
});

test('a continuing hold keeps its start; a stale one restarts', () => {
  const startMs = Date.parse('2026-09-28T19:00:00Z');
  const first = computeTokenRefreshHold({ failureAtMs: startMs, floorMs: startMs + MINUTE, config: CONFIG });
  const second = computeTokenRefreshHold({
    previousHold: first,
    failureAtMs: startMs + 31 * MINUTE,
    floorMs: startMs + 32 * MINUTE,
    config: CONFIG,
  });
  assert.equal(second.startedAt, first.startedAt);
  assert.equal(second.refusals, 2);
  const restarted = computeTokenRefreshHold({
    previousHold: first,
    failureAtMs: startMs + 5 * HOUR,
    floorMs: startMs + 5 * HOUR + MINUTE,
    config: CONFIG,
  });
  assert.equal(restarted.startedAt, new Date(startMs + 5 * HOUR).toISOString());
  assert.equal(restarted.refusals, 1);
});

test('tokenRefreshHoldExhausted fires only for the held model, only after the bound, never for a stale hold', () => {
  const startMs = Date.parse('2026-09-28T19:00:00Z');
  const hold = computeTokenRefreshHold({ failureAtMs: startMs, floorMs: startMs + MINUTE, config: CONFIG });
  assert.equal(tokenRefreshHoldExhausted(hold, { reviewerModel: 'claude', nowMs: startMs + 29 * MINUTE }), false);
  assert.equal(tokenRefreshHoldExhausted(hold, { reviewerModel: 'claude', nowMs: startMs + 30 * MINUTE }), true);
  assert.equal(tokenRefreshHoldExhausted(hold, { reviewerModel: 'gemini', nowMs: startMs + 30 * MINUTE }), false);
  assert.equal(tokenRefreshHoldExhausted(hold, { reviewerModel: 'claude', nowMs: startMs + 3 * HOUR }), false);
  assert.equal(tokenRefreshHoldExhausted(null, { reviewerModel: 'claude', nowMs: startMs }), false);
});

test('repeated refusals never charge review_attempts or infra_auto_recover_attempts and never strand the row', () => {
  // #7286 on the day of the SEV: infra 2/3, one refusal from terminal.
  const fixture = setupFixture({ infraAttempts: 2, reviewAttempts: 4 });
  try {
    let failureAtMs = Date.parse('2026-09-28T19:28:35Z');
    for (let refusal = 1; refusal <= 6; refusal += 1) {
      const warnings = settleRefusal(fixture, {
        failureAt: new Date(failureAtMs).toISOString(),
        remainingMs: 4994933 - (failureAtMs - Date.parse('2026-09-28T19:28:35Z')),
      });
      const row = fixture.readRow();
      assert.equal(row.review_status, 'pending-upstream', `refusal ${refusal} must stay a hold`);
      assert.equal(row.review_attempts, 4, `refusal ${refusal} must not charge review_attempts`);
      assert.equal(row.infra_auto_recover_attempts, 2, `refusal ${refusal} must not charge infra recovery`);
      assert.equal(row.reviewer_session_uuid, null);
      assert.match(row.failure_message, /^\[token-refresh-pending\] /);
      assert.match(warnings.join('\n'), /held without charging attempts/);
      const state = readCascadeState(fixture.rootDir, { repo: REPO, prNumber: PR });
      assert.equal(state.tokenRefreshHold.refusals, refusal);
      assert.equal(state.tokenRefreshHold.startedAt, '2026-09-28T19:28:35.000Z');
      assert.equal(state.nextRetryAfter, state.tokenRefreshHold.holdUntil);
      fixture.reclaim();
      failureAtMs = Date.parse(state.nextRetryAfter);
    }
  } finally {
    fixture.cleanup();
  }
});

test('the cascade gate holds the PR until the rotation, then releases it', () => {
  const fixture = setupFixture();
  try {
    const failureAt = '2026-09-28T19:31:10.000Z';
    const expiresAt = '2026-09-28T20:06:10Z'; // rotation (expiry - 30m) at 19:36:10
    settleRefusal(fixture, { failureAt, remainingMs: 35 * MINUTE, expiresAt });
    const state = readCascadeState(fixture.rootDir, { repo: REPO, prNumber: PR });
    assert.equal(state.tokenRefreshHold.expectedRotationAt, '2026-09-28T19:36:10.000Z');
    assert.equal(state.nextRetryAfter, '2026-09-28T19:37:10.000Z');
    assert.equal(
      shouldBackoffReviewerSpawn(fixture.rootDir, { repo: REPO, prNumber: PR, now: '2026-09-28T19:37:00.000Z' }).shouldBackoff,
      true,
    );
    assert.equal(
      shouldBackoffReviewerSpawn(fixture.rootDir, { repo: REPO, prNumber: PR, now: '2026-09-28T19:37:10.000Z' }).shouldBackoff,
      false,
    );
  } finally {
    fixture.cleanup();
  }
});

test('route selection keeps Claude through the hold and re-routes only once the bound passes', () => {
  const fixture = setupFixture();
  try {
    const startMs = Date.parse('2026-09-28T19:28:35Z');
    // Three quick refusals would have tripped the old 2-count exec fallback.
    for (let index = 0; index < 3; index += 1) {
      settleRefusal(fixture, {
        failureAt: new Date(startMs + index * MINUTE).toISOString(),
        remainingMs: 4 * MINUTE,
      });
      fixture.reclaim();
    }
    const row = fixture.readRow();
    const select = (nowMs) => selectReviewerRouteForAttempt({
      subject: { builderClass: 'codex' },
      baseRoute: claudeRoute(),
      rootDir: fixture.rootDir,
      repoPath: REPO,
      prNumber: PR,
      currentRow: row,
      headSha: 'head-1',
      env: {},
      nowMs,
    });
    const during = select(startMs + 20 * MINUTE);
    assert.equal(during.reviewerModel, 'claude');
    assert.equal(during.reviewerModelFallback, undefined);

    const afterBound = select(startMs + 31 * MINUTE);
    assert.notEqual(afterBound.reviewerModel, 'claude');
    assert.equal(afterBound.reviewerModelFallback.reason, 'token-refresh-hold-exhausted');
    assert.equal(afterBound.reviewerModelFallback.failureClass, 'token-refresh-pending');
    assert.equal(afterBound.reviewerModelFallback.failureCount, 3);
  } finally {
    fixture.cleanup();
  }
});

test('an exhausted hold survives a fallback reviewer\'s transient failure', () => {
  const fixture = setupFixture();
  try {
    const startMs = Date.parse('2026-09-28T19:00:00Z');
    settleRefusal(fixture, { failureAt: new Date(startMs).toISOString(), remainingMs: 4 * MINUTE });
    recordCascadeFailure(fixture.rootDir, {
      repo: REPO,
      prNumber: PR,
      failedAt: new Date(startMs + 31 * MINUTE).toISOString(),
      failureClass: 'provider-overloaded',
      reviewerModel: 'gemini',
    });
    const state = readCascadeState(fixture.rootDir, { repo: REPO, prNumber: PR });
    assert.equal(state.lastFailureClass, 'provider-overloaded');
    assert.equal(state.tokenRefreshHold.reviewerModel, 'claude');
    assert.equal(
      tokenRefreshHoldExhausted(state.tokenRefreshHold, { reviewerModel: 'claude', nowMs: startMs + 40 * MINUTE }),
      true,
    );
  } finally {
    fixture.cleanup();
  }
});

test('settle refuses to run a token-refresh hold without the hold statement', () => {
  const fixture = setupFixture();
  try {
    const statements = { ...fixture.statements };
    delete statements.markTokenRefreshHold;
    assert.throws(() => settleReviewerAttempt({
      rootDir: fixture.rootDir,
      repoPath: REPO,
      prNumber: PR,
      result: { ok: false, failureClass: 'token-refresh-pending', error: refusalText({ remainingMs: 1000 }) },
      failureAt: '2026-09-28T19:00:00.000Z',
      maxRemediationRounds: 3,
      statements,
      log: { warn() {} },
    }), /requires statements\.markTokenRefreshHold/);
  } finally {
    fixture.cleanup();
  }
});
