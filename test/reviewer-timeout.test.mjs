import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AGY_PRINT_TIMEOUT_SUBPROCESS_SLACK_MS,
  DEFAULT_AGY_PRINT_TIMEOUT_MS,
  DEFAULT_PROGRESS_TIMEOUT_MS,
  DEFAULT_REVIEWER_TIMEOUT_MS,
  resolveAgyPrintTimeoutMs,
  resolveAgyReviewerSubprocessTimeoutMs,
  resolveProgressTimeoutMs,
  resolveReviewerTimeoutMs,
} from '../src/reviewer-timeout.mjs';
import { AgentOSConfigError } from '../src/config-loader.mjs';

// Guards the subprocess timeout that protects spawnCaptured around the
// reviewer CLI calls. Raised 10m -> 20m on 2026-05-10 after PR #331 hit
// the 10m wall on a substantive spec diff. A future revert that drops
// it below 20m needs to fail this test, not silently shorten review
// budgets again. The progress timeout guards the separate no-output watchdog.
test('default reviewer timeout is 20 minutes', () => {
  assert.equal(DEFAULT_REVIEWER_TIMEOUT_MS, 20 * 60 * 1000);
});

test('resolveReviewerTimeoutMs falls back to default when env is unset', () => {
  assert.equal(resolveReviewerTimeoutMs({}), DEFAULT_REVIEWER_TIMEOUT_MS);
  assert.equal(resolveReviewerTimeoutMs({ ADVERSARIAL_REVIEWER_TIMEOUT_MS: '' }), DEFAULT_REVIEWER_TIMEOUT_MS);
});

test('resolveReviewerTimeoutMs honors a positive env override', () => {
  assert.equal(resolveReviewerTimeoutMs({ ADVERSARIAL_REVIEWER_TIMEOUT_MS: '60000' }), 60000);
  assert.equal(resolveReviewerTimeoutMs({ ADVERSARIAL_REVIEWER_TIMEOUT_MS: '1800000' }), 1800000);
});

test('resolveReviewerTimeoutMs falls back for integer non-positive overrides', () => {
  assert.equal(resolveReviewerTimeoutMs({ ADVERSARIAL_REVIEWER_TIMEOUT_MS: '0' }), DEFAULT_REVIEWER_TIMEOUT_MS);
  assert.equal(resolveReviewerTimeoutMs({ ADVERSARIAL_REVIEWER_TIMEOUT_MS: '-1000' }), DEFAULT_REVIEWER_TIMEOUT_MS);
});

test('resolveReviewerTimeoutMs fails loud for non-integer env overrides', () => {
  assert.throws(
    () => resolveReviewerTimeoutMs({ ADVERSARIAL_REVIEWER_TIMEOUT_MS: 'not-a-number' }),
    AgentOSConfigError
  );
  assert.throws(
    () => resolveReviewerTimeoutMs({ ADVERSARIAL_REVIEWER_TIMEOUT_MS: '120000.7' }),
    AgentOSConfigError
  );
});

test('default reviewer progress timeout is 15 minutes', () => {
  assert.equal(DEFAULT_PROGRESS_TIMEOUT_MS, 15 * 60 * 1000);
});

test('resolveProgressTimeoutMs follows the reviewer env override parser shape', () => {
  assert.equal(resolveProgressTimeoutMs({}), DEFAULT_PROGRESS_TIMEOUT_MS);
  assert.equal(resolveProgressTimeoutMs({ ADVERSARIAL_REVIEWER_PROGRESS_TIMEOUT_MS: '2500' }), 2500);
  assert.throws(
    () => resolveProgressTimeoutMs({ ADVERSARIAL_REVIEWER_PROGRESS_TIMEOUT_MS: '' }),
    AgentOSConfigError
  );
  assert.throws(
    () => resolveProgressTimeoutMs({ ADVERSARIAL_REVIEWER_PROGRESS_TIMEOUT_MS: '2500.9' }),
    AgentOSConfigError
  );
  assert.throws(
    () => resolveProgressTimeoutMs({ ADVERSARIAL_REVIEWER_PROGRESS_TIMEOUT_MS: '0' }),
    AgentOSConfigError
  );
  assert.throws(
    () => resolveProgressTimeoutMs({ ADVERSARIAL_REVIEWER_PROGRESS_TIMEOUT_MS: 'nope' }),
    AgentOSConfigError
  );
});

test('default agy print timeout is independent of shared reviewer timeout', () => {
  assert.equal(DEFAULT_AGY_PRINT_TIMEOUT_MS, 19 * 60 * 1000);
  assert.equal(resolveAgyPrintTimeoutMs({}), DEFAULT_AGY_PRINT_TIMEOUT_MS);
  assert.equal(
    resolveAgyPrintTimeoutMs({ AGENT_OS_REVIEWER_GEMINI_ANTIGRAVITY_PRINT_TIMEOUT_MS: '1500000' }),
    1_500_000,
  );
  assert.equal(
    resolveAgyPrintTimeoutMs({ ADVERSARIAL_REVIEW_GEMINI_ANTIGRAVITY_PRINT_TIMEOUT_MS: '1250000' }),
    1_250_000,
  );
});

test('agy reviewer subprocess timeout is never shorter than agy print timeout', () => {
  assert.equal(AGY_PRINT_TIMEOUT_SUBPROCESS_SLACK_MS, 30_000);
  assert.equal(
    resolveAgyReviewerSubprocessTimeoutMs(
      { AGENT_OS_REVIEWER_GEMINI_ANTIGRAVITY_PRINT_TIMEOUT_MS: '1500000' },
      { reviewerTimeoutMs: DEFAULT_REVIEWER_TIMEOUT_MS },
    ),
    1_530_000,
  );
  assert.equal(
    resolveAgyReviewerSubprocessTimeoutMs(
      { AGENT_OS_REVIEWER_GEMINI_ANTIGRAVITY_PRINT_TIMEOUT_MS: '60000' },
      { reviewerTimeoutMs: DEFAULT_REVIEWER_TIMEOUT_MS },
    ),
    DEFAULT_REVIEWER_TIMEOUT_MS,
  );
});

import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ensureReviewStateSchema } from '../src/review-state.mjs';
import { reapRunningPassTimeouts } from '../src/reviewer-pass-reaper.mjs';

function setupDb() {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'reviewer-timeout-'));
  mkdirSync(path.join(rootDir, 'data'), { recursive: true });
  const db = new Database(path.join(rootDir, 'data', 'reviews.db'));
  ensureReviewStateSchema(db);
  return { rootDir, db };
}

test('reapRunningPassTimeouts reaps a stuck running pass older than threshold', () => {
  const { rootDir, db } = setupDb();
  try {
    db.prepare(
      `INSERT INTO reviewer_passes (
         repo, pr_number, attempt_number, reviewer_class, pass_kind, started_at, status
       ) VALUES (?, ?, ?, ?, ?, datetime('now', '-3605 seconds'), 'running')`
    ).run('laceyenterprises/agent-os', 123, 1, 'codex', 'first-pass');

    const result = reapRunningPassTimeouts({ db, rootDir });
    assert.equal(result.reaped, 1);

    const row = db.prepare(`SELECT status, metadata_json, ended_at FROM reviewer_passes WHERE pr_number = 123`).get();
    assert.equal(row.status, 'failed');
    assert.ok(row.ended_at);
    const metadata = JSON.parse(row.metadata_json);
    assert.equal(metadata.failureClass, 'reviewer-timeout');
    assert.equal(metadata.failureReason, 'running-pass-timeout');
    assert.equal(metadata.timeoutThresholdSeconds, 3600);
  } finally {
    db.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('reapRunningPassTimeouts releases matching reviewed_prs claim for retry', () => {
  const { rootDir, db } = setupDb();
  try {
    const startedAt = new Date(Date.now() - 3_605_000).toISOString();
    db.prepare(
      `INSERT INTO reviewed_prs (
         repo, pr_number, reviewed_at, reviewer, pr_state, review_status,
         reviewer_session_uuid,
         reviewer_started_at, reviewer_head_sha, reviewer_lease_expires_at,
         infra_auto_recover_attempts
       ) VALUES (?, ?, ?, ?, 'open', 'reviewing', ?, ?, ?, ?, 0)`
    ).run(
      'laceyenterprises/agent-os',
      129,
      startedAt,
      'codex',
      'session-129',
      new Date(Date.now() - 3_604_000).toISOString(),
      'abc123',
      new Date(Date.now() - 1_000).toISOString()
    );
    db.prepare(
      `INSERT INTO reviewer_passes (
         repo, pr_number, attempt_number, reviewer_class, pass_kind,
         started_at, status, head_sha, metadata_json
       ) VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?)`
    ).run(
      'laceyenterprises/agent-os',
      129,
      1,
      'codex',
      'first-pass',
      startedAt,
      'abc123',
      JSON.stringify({ reviewerSessionUuid: 'session-129' })
    );

    const result = reapRunningPassTimeouts({ db, rootDir, log: { log() {}, warn() {}, error() {} } });
    assert.equal(result.reaped, 1);
    assert.equal(result.reviewClaimsReleased, 1);
    assert.equal(result.reviewClaimsFailed, 0);

    const pass = db.prepare(
      `SELECT status, metadata_json, ended_at FROM reviewer_passes WHERE pr_number = 129`
    ).get();
    assert.equal(pass.status, 'failed');
    assert.ok(pass.ended_at);
    assert.equal(JSON.parse(pass.metadata_json).failureClass, 'reviewer-timeout');

    const review = db.prepare(
      `SELECT review_status, failed_at, failure_message, reviewer_lease_expires_at,
              infra_auto_recover_attempts
         FROM reviewed_prs
        WHERE pr_number = 129`
    ).get();
    assert.equal(review.review_status, 'pending-upstream');
    assert.ok(review.failed_at);
    assert.match(review.failure_message, /^\[reviewer-timeout\]/);
    assert.equal(review.reviewer_lease_expires_at, null);
    assert.equal(review.infra_auto_recover_attempts, 1);
  } finally {
    db.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('reapRunningPassTimeouts leaves pass running when active claim evidence differs', () => {
  const { rootDir, db } = setupDb();
  try {
    const passStartedAt = new Date(Date.now() - 3_605_000).toISOString();
    const activeStartedAt = new Date(Date.now() - 60_000).toISOString();
    db.prepare(
      `INSERT INTO reviewed_prs (
         repo, pr_number, reviewed_at, reviewer, pr_state, review_status,
         reviewer_session_uuid, reviewer_started_at, reviewer_head_sha,
         infra_auto_recover_attempts
       ) VALUES (?, ?, ?, ?, 'open', 'reviewing', ?, ?, ?, 0)`
    ).run(
      'laceyenterprises/agent-os',
      130,
      passStartedAt,
      'codex',
      'active-session',
      activeStartedAt,
      'new-head'
    );
    db.prepare(
      `INSERT INTO reviewer_passes (
         repo, pr_number, attempt_number, reviewer_class, pass_kind,
         started_at, status, head_sha, metadata_json
       ) VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?)`
    ).run(
      'laceyenterprises/agent-os',
      130,
      1,
      'codex',
      'first-pass',
      passStartedAt,
      'old-head',
      JSON.stringify({ reviewerSessionUuid: 'old-session' })
    );

    const result = reapRunningPassTimeouts({ db, rootDir, log: { log() {}, warn() {}, error() {} } });
    assert.equal(result.reaped, 0);
    assert.equal(result.reviewClaimsReleased, 0);

    const pass = db.prepare(`SELECT status, ended_at FROM reviewer_passes WHERE pr_number = 130`).get();
    assert.equal(pass.status, 'running');
    assert.equal(pass.ended_at, null);
    const review = db.prepare(`SELECT review_status FROM reviewed_prs WHERE pr_number = 130`).get();
    assert.equal(review.review_status, 'reviewing');
  } finally {
    db.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('reapRunningPassTimeouts does not overwrite a settled pass', () => {
  const { rootDir, db } = setupDb();
  try {
    db.prepare(
      `INSERT INTO reviewer_passes (
         repo, pr_number, attempt_number, reviewer_class, pass_kind, started_at, ended_at, status, metadata_json
       ) VALUES (?, ?, ?, ?, ?, datetime('now', '-7200 seconds'), datetime('now', '-60 seconds'), 'completed', ?)`
    ).run('laceyenterprises/agent-os', 127, 1, 'codex', 'first-pass', JSON.stringify({ verdict: 'comment-only' }));

    const result = reapRunningPassTimeouts({ db, rootDir });
    assert.equal(result.reaped, 0);

    const row = db.prepare(
      `SELECT status, metadata_json, ended_at FROM reviewer_passes WHERE pr_number = 127`
    ).get();
    assert.equal(row.status, 'completed');
    assert.ok(row.ended_at);
    assert.deepEqual(JSON.parse(row.metadata_json), { verdict: 'comment-only' });
  } finally {
    db.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('reapRunningPassTimeouts skips running passes with unparsable started_at', () => {
  const { rootDir, db } = setupDb();
  try {
    db.prepare(
      `INSERT INTO reviewer_passes (
         repo, pr_number, attempt_number, reviewer_class, pass_kind, started_at, status
       ) VALUES (?, ?, ?, ?, ?, ?, 'running')`
    ).run('laceyenterprises/agent-os', 128, 1, 'codex', 'first-pass', 'not-a-timestamp');

    const result = reapRunningPassTimeouts({ db, rootDir });
    assert.equal(result.reaped, 0);

    const row = db.prepare(`SELECT status, ended_at FROM reviewer_passes WHERE pr_number = 128`).get();
    assert.equal(row.status, 'running');
    assert.equal(row.ended_at, null);
  } finally {
    db.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('reapRunningPassTimeouts leaves fresh running pass untouched', () => {
  const { rootDir, db } = setupDb();
  try {
    db.prepare(
      `INSERT INTO reviewer_passes (
         repo, pr_number, attempt_number, reviewer_class, pass_kind, started_at, status
       ) VALUES (?, ?, ?, ?, ?, datetime('now', '-3500 seconds'), 'running')`
    ).run('laceyenterprises/agent-os', 124, 1, 'codex', 'first-pass');

    const result = reapRunningPassTimeouts({ db, rootDir });
    assert.equal(result.reaped, 0);

    const row = db.prepare(`SELECT status FROM reviewer_passes WHERE pr_number = 124`).get();
    assert.equal(row.status, 'running');
  } finally {
    db.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('reapRunningPassTimeouts honors custom threshold via env', () => {
  const { rootDir, db } = setupDb();
  const oldEnv = process.env.AGENT_OS_REVIEWER_RUNNING_PASS_TIMEOUT_SECONDS;
  try {
    process.env.AGENT_OS_REVIEWER_RUNNING_PASS_TIMEOUT_SECONDS = '7200';
    db.prepare(
      `INSERT INTO reviewer_passes (
         repo, pr_number, attempt_number, reviewer_class, pass_kind, started_at, status
       ) VALUES (?, ?, ?, ?, ?, datetime('now', '-3700 seconds'), 'running')`
    ).run('laceyenterprises/agent-os', 125, 1, 'codex', 'first-pass');

    const result = reapRunningPassTimeouts({ db, rootDir });
    assert.equal(result.reaped, 0); // 3700s < 7200s, so untouched

    db.prepare(
      `INSERT INTO reviewer_passes (
         repo, pr_number, attempt_number, reviewer_class, pass_kind, started_at, status
       ) VALUES (?, ?, ?, ?, ?, datetime('now', '-7300 seconds'), 'running')`
    ).run('laceyenterprises/agent-os', 126, 1, 'codex', 'first-pass');

    const result2 = reapRunningPassTimeouts({ db, rootDir });
    assert.equal(result2.reaped, 1); // 7300s > 7200s, reaped

    const row = db.prepare(`SELECT status FROM reviewer_passes WHERE pr_number = 126`).get();
    assert.equal(row.status, 'failed');
  } finally {
    if (oldEnv === undefined) {
      delete process.env.AGENT_OS_REVIEWER_RUNNING_PASS_TIMEOUT_SECONDS;
    } else {
      process.env.AGENT_OS_REVIEWER_RUNNING_PASS_TIMEOUT_SECONDS = oldEnv;
    }
    db.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});
