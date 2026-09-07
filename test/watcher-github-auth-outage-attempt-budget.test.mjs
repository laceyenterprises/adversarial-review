// watcher-github-auth-outage-attempt-budget.test.mjs — RTOK-01.
//
// A rejected GitHub credential is a FLEET-WIDE auth outage, not a reviewer
// failure. Every PR the watcher touches fails identically and simultaneously,
// for a reason that has nothing to do with the PR or its reviewer.
//
// Before this change a 401 carried no recognizable failure class, fell through
// to the terminal settle path, and was logged as
//
//     [watcher] Reviewer unknown-class failure on #6366; counting against
//     attempt budget (3/4)
//
// so one auth outage permanently burned the retry budget of every PR it
// touched. PRs #6366-#6370 were stranded with zero reviews exactly this way and
// could not self-recover even after the token was fixed.
//
// What is pinned here:
//   1. A 401 reviewer failure holds the PR at `pending-upstream` WITHOUT
//      charging review_attempts, so it resumes on its own once auth recovers.
//   2. The tagged `[github-auth-outage]` class the gh helper raises after a
//      failed re-mint is recognised the same way.
//   3. THE NEGATIVE CASE: an ordinary review failure still counts against the
//      attempt budget exactly as it does today. The outage branch must not
//      become a way for genuine failures to retry forever.
//   4. A token at/near expiry is re-minted BEFORE it is handed to a reviewer,
//      rather than being read once at process start and held past expiry.

import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import path from 'node:path';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { ensureReviewStateSchema } from '../src/review-state.mjs';
import { settleReviewerAttempt } from '../src/watcher.mjs';
import {
  refreshReviewerBrokerTokens,
  _resetReviewerTokenRefreshClockForTest,
  REVIEWER_TOKEN_REFRESH_SKEW_MS,
} from '../src/reviewer-broker-refresh.mjs';

const REPO = 'laceyenterprises/agent-os';
const HOUR_MS = 60 * 60 * 1000;

function setupFixture(prNumber) {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'watcher-auth-outage-'));
  mkdirSync(path.join(rootDir, 'data'), { recursive: true });
  const db = new Database(path.join(rootDir, 'data', 'reviews.db'));
  ensureReviewStateSchema(db);
  db.prepare(
    'INSERT INTO reviewed_prs (repo, pr_number, reviewed_at, reviewer, pr_state, review_status, review_attempts, infra_auto_recover_attempts) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(REPO, prNumber, '2026-09-07T03:00:00.000Z', 'gemini', 'open', 'reviewing', 0, 0);
  return { rootDir, db };
}

function statementsFor(db) {
  return {
    markPosted: db.prepare(
      "UPDATE reviewed_prs SET review_status = 'posted', posted_at = ?, failed_at = NULL, failure_message = NULL, review_attempts = review_attempts + 1, infra_auto_recover_attempts = 0 WHERE repo = ? AND pr_number = ?"
    ),
    markFailed: db.prepare(
      "UPDATE reviewed_prs SET review_status = 'failed', failed_at = ?, failure_message = ?, review_attempts = review_attempts + 1 WHERE repo = ? AND pr_number = ?"
    ),
    releaseReviewLease: db.prepare(
      "UPDATE reviewed_prs SET review_status = 'pending', failed_at = ?, failure_message = ?, review_attempts = review_attempts + 1 WHERE repo = ? AND pr_number = ? AND review_status = 'reviewing'"
    ),
    markFailedQuota: db.prepare(
      "UPDATE reviewed_prs SET review_status = 'failed', failed_at = ?, failure_message = ?, quota_reset_at_utc = ?, review_attempts = review_attempts + 1 WHERE repo = ? AND pr_number = ?"
    ),
    releaseReviewLeaseQuota: db.prepare(
      "UPDATE reviewed_prs SET review_status = 'pending', failed_at = ?, failure_message = ?, quota_reset_at_utc = ?, review_attempts = review_attempts + 1 WHERE repo = ? AND pr_number = ? AND review_status = 'reviewing'"
    ),
    markOutageTransient: db.prepare(
      "UPDATE reviewed_prs SET review_status = 'pending-upstream', failed_at = ?, failure_message = ?, quota_reset_at_utc = ? WHERE repo = ? AND pr_number = ? AND review_status = 'reviewing'"
    ),
    markCascadeFailed: db.prepare(
      "UPDATE reviewed_prs SET review_status = 'failed', failed_at = ?, failure_message = ? WHERE repo = ? AND pr_number = ?"
    ),
    markPendingUpstream: db.prepare(
      "UPDATE reviewed_prs SET review_status = 'pending-upstream', failed_at = ?, failure_message = ? WHERE repo = ? AND pr_number = ?"
    ),
    getReviewRow: db.prepare('SELECT * FROM reviewed_prs WHERE repo = ? AND pr_number = ?'),
  };
}

function settleWith(rootDir, db, prNumber, output) {
  settleReviewerAttempt({
    rootDir,
    repoPath: REPO,
    prNumber,
    result: { ok: false, failureClass: 'unknown', error: output, stdout: '', stderr: output },
    statements: statementsFor(db),
    failureAt: '2026-09-07T12:00:00.000Z',
    maxRemediationRounds: 3,
    log: { warn() {}, log() {}, error() {} },
  });
  return db.prepare('SELECT * FROM reviewed_prs WHERE repo = ? AND pr_number = ?').get(REPO, prNumber);
}

// The literal output the live watcher produced against the 9h-old ghs_ token.
const RAW_401 = [
  'Command failed with code 1',
  'stderr tail:',
  'gh: Bad credentials (HTTP 401)',
  'failed to run git: exit status 1',
].join('\n');

// What gh-cli.mjs now raises once a forced re-mint has already been tried.
const TAGGED_401 = [
  '[github-auth-outage] gh pr diff was rejected by GitHub authentication after a '
  + 'forced token re-mint: gh: Bad credentials (HTTP 401)',
].join('\n');

test('a raw 401 holds the PR without charging the attempt budget', () => {
  const { rootDir, db } = setupFixture(6366);
  try {
    const row = settleWith(rootDir, db, 6366, RAW_401);
    assert.equal(row.review_attempts, 0, 'an auth outage must not burn a reviewer attempt');
    assert.equal(row.review_status, 'pending-upstream');
    assert.match(row.failure_message, /outage-transient:github-auth-outage/);
  } finally {
    db.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('the tagged post-re-mint auth outage is recognised too', () => {
  const { rootDir, db } = setupFixture(6367);
  try {
    const row = settleWith(rootDir, db, 6367, TAGGED_401);
    assert.equal(row.review_attempts, 0);
    assert.equal(row.review_status, 'pending-upstream');
    assert.match(row.failure_message, /outage-transient:github-auth-outage/);
  } finally {
    db.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('an ordinary review failure STILL counts against the attempt budget', () => {
  const { rootDir, db } = setupFixture(6371);
  try {
    const row = settleWith(
      rootDir,
      db,
      6371,
      'Command failed with code 1\nstderr tail:\nreviewer produced no parseable verdict after 3 turns'
    );
    assert.equal(row.review_attempts, 1, 'a real review failure must still be charged');
    assert.notEqual(row.review_status, 'pending-upstream');
  } finally {
    db.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('a 403 is NOT treated as an auth outage', () => {
  // 403 on a valid token is permissions/rate-limit, not an expired credential;
  // re-minting cannot clear it, so it must keep its ordinary terminal handling.
  const { rootDir, db } = setupFixture(6372);
  try {
    const row = settleWith(
      rootDir,
      db,
      6372,
      'Command failed with code 1\nstderr tail:\ngh: Resource not accessible by integration (HTTP 403)'
    );
    assert.equal(row.review_attempts, 1);
    assert.notEqual(row.review_status, 'pending-upstream');
  } finally {
    db.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('a token near expiry is re-minted before it is handed to a reviewer', async () => {
  _resetReviewerTokenRefreshClockForTest();
  const now = Date.UTC(2026, 8, 7, 12, 0, 0);
  const env = {
    GEMINI_REVIEWER_AUTH_VIA_BROKER: 'true',
    OAUTH_BROKER_URL: 'http://127.0.0.1:4099',
    OAUTH_BROKER_SHARED_SECRET_FILE: '/secret/oauth-broker-shared-secret',
    // The stale value the 9h-old watcher was still holding.
    GH_GEMINI_REVIEWER_TOKEN: 'ghs_MINTED_AT_PROCESS_START',
  };
  const readSecret = () => 'broker-shared-secret';
  const silentLog = { warn() {}, log() {} };
  let mints = 0;
  // The broker always mints a token with a full hour of life, measured from the
  // moment it is asked -- exactly as the real GitHub App installation flow does.
  let brokerNowMs = now;
  const fetchImpl = async () => {
    mints += 1;
    const mintedAtMs = brokerNowMs;
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          access_token: `ghs_FRESH_${mints}`,
          provider: 'github-app-gemini-reviewer',
          metadata: {},
          expires_at: new Date(mintedAtMs + HOUR_MS).toISOString(),
        };
      },
    };
  };

  // First sight of the role always re-fetches: the startup token's expiry is
  // unknown to the watcher, which is precisely the state that let a token
  // minted at process start be held for nine hours.
  const first = await refreshReviewerBrokerTokens({
    env, now, fetchImpl, readFileImpl: readSecret, log: silentLog,
  });
  assert.equal(mints, 1);
  assert.equal(env.GH_GEMINI_REVIEWER_TOKEN, 'ghs_FRESH_1');
  assert.ok(first.refreshed.some((entry) => entry.role === 'gemini-reviewer'));

  // Well inside the token's life: no needless broker traffic.
  await refreshReviewerBrokerTokens({
    env, now: now + 60_000, fetchImpl, readFileImpl: readSecret, log: silentLog,
  });
  assert.equal(mints, 1, 'a comfortably valid token must not be re-minted every tick');

  // Near its real expiry: re-minted BEFORE it can be handed to a reviewer that
  // would then 401 mid-run. This is the step the old process-start-only read
  // never performed, which is how a one-hour token survived nine hours.
  const nearExpiryNow = now + HOUR_MS - REVIEWER_TOKEN_REFRESH_SKEW_MS + 1_000;
  brokerNowMs = nearExpiryNow;
  await refreshReviewerBrokerTokens({
    env, now: nearExpiryNow, fetchImpl, readFileImpl: readSecret, log: silentLog,
  });
  assert.equal(mints, 2, 'a token near expiry must be re-minted before use');
  assert.equal(env.GH_GEMINI_REVIEWER_TOKEN, 'ghs_FRESH_2');
});
