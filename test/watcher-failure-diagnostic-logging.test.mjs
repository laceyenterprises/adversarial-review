// LAC-545 regression coverage. The 2026-05-11 incident chain that
// motivated this test:
//   - Codex reviewer fails on every `[claude-code]` PR
//   - err.stderr captured by spawnCaptured, fed to classifyReviewerFailure
//   - watcher.mjs's `settleReviewerAttempt` never logged the captured text
//   - failure-class lands as `'unknown'`, operator sees only the bare
//     `Reviewer unknown-class failure on #N` log line, no actionable detail
//
// These tests guard the contract that:
//   (a) failure paths emit `[reviewer:<N>] stderr (failure-class=<class>): <preview>`
//   (b) when stdout is non-empty it also gets logged
//   (c) `<preview>` head+tail-truncates long payloads but emits short ones
//       verbatim
//   (d) empty stderr does not produce a bogus log line
//
// We construct a fake `settleReviewerAttempt` invocation by importing the
// real function and feeding it a minimal in-memory DB + a stubbed
// statements bag — same pattern as watcher-cascade-resilience.test.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { ensureReviewStateSchema } from '../src/review-state.mjs';
import { settleReviewerAttempt } from '../src/watcher.mjs';

const REPO = 'laceyenterprises/agent-os';
const PR = 357;

function makeStatements(db) {
  return {
    markPosted: db.prepare(
      "UPDATE reviewed_prs SET review_status = 'posted', posted_at = ?, failed_at = NULL, failure_message = NULL, review_attempts = review_attempts + 1 WHERE repo = ? AND pr_number = ?"
    ),
    markFailed: db.prepare(
      "UPDATE reviewed_prs SET review_status = 'failed', failed_at = ?, failure_message = ?, review_attempts = review_attempts + 1 WHERE repo = ? AND pr_number = ?"
    ),
    markCascadeFailed: db.prepare(
      "UPDATE reviewed_prs SET review_status = 'failed', failed_at = ?, failure_message = ?, review_attempts = review_attempts + 1 WHERE repo = ? AND pr_number = ?"
    ),
    markPendingUpstream: db.prepare(
      "UPDATE reviewed_prs SET review_status = 'pending-upstream', failed_at = ?, failure_message = ? WHERE repo = ? AND pr_number = ?"
    ),
    getReviewRow: db.prepare(
      'SELECT * FROM reviewed_prs WHERE repo = ? AND pr_number = ?'
    ),
  };
}

function setupDb() {
  const db = new Database(':memory:');
  ensureReviewStateSchema(db);
  db.prepare(
    `INSERT INTO reviewed_prs (repo, pr_number, reviewed_at, reviewer, pr_state, linear_ticket, review_status, review_attempts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(REPO, PR, '2026-05-11T00:00:00.000Z', 'codex', 'open', null, 'pending', 0);
  return db;
}

function captureLogs() {
  const lines = [];
  return {
    lines,
    log: (msg) => lines.push(`log:${msg}`),
    warn: (msg) => lines.push(`warn:${msg}`),
    error: (msg) => lines.push(`error:${msg}`),
  };
}

test('failure path logs captured stderr with the failure class', () => {
  const db = setupDb();
  const log = captureLogs();
  const stderr = 'Codex payload did not contain recognizable review sections';

  settleReviewerAttempt({
    rootDir: '/tmp/lac-545-fixture-' + Date.now(),
    repoPath: REPO,
    prNumber: PR,
    result: {
      ok: false,
      error: stderr,
      stderr,
      stdout: '',
      failureClass: 'unknown',
    },
    failureAt: '2026-05-11T00:01:00.000Z',
    maxRemediationRounds: 2,
    statements: makeStatements(db),
    log,
  });

  const joined = log.lines.join('\n');
  assert.match(joined, /\[reviewer:357\] stderr \(failure-class=unknown\): Codex payload did not contain recognizable review sections/);
  // Pre-existing log line about the attempt budget must still fire.
  assert.match(joined, /Reviewer unknown-class failure on #357/);
});

test('failure path also logs captured stdout when non-empty', () => {
  const db = setupDb();
  const log = captureLogs();

  settleReviewerAttempt({
    rootDir: '/tmp/lac-545-fixture-' + Date.now(),
    repoPath: REPO,
    prNumber: PR,
    result: {
      ok: false,
      error: 'oops',
      stderr: 'stderr text',
      stdout: 'stdout text from codex CLI',
      failureClass: 'bug',
    },
    failureAt: '2026-05-11T00:02:00.000Z',
    maxRemediationRounds: 2,
    statements: makeStatements(db),
    log,
  });

  const joined = log.lines.join('\n');
  assert.match(joined, /\[reviewer:357\] stderr \(failure-class=bug\): stderr text/);
  assert.match(joined, /\[reviewer:357\] stdout \(failure-class=bug\): stdout text from codex CLI/);
});

test('preview head+tail-truncates long stderr', () => {
  const db = setupDb();
  const log = captureLogs();
  // Payload comfortably above the 800-char head+tail cap.
  const longStderr = 'A'.repeat(500) + 'MIDDLE_REGION_SHOULD_BE_ELIDED' + 'B'.repeat(500);

  settleReviewerAttempt({
    rootDir: '/tmp/lac-545-fixture-' + Date.now(),
    repoPath: REPO,
    prNumber: PR,
    result: {
      ok: false,
      error: longStderr,
      stderr: longStderr,
      stdout: '',
      failureClass: 'unknown',
    },
    failureAt: '2026-05-11T00:03:00.000Z',
    maxRemediationRounds: 2,
    statements: makeStatements(db),
    log,
  });

  const joined = log.lines.join('\n');
  // Head present, tail present, truncated middle.
  assert.match(joined, /\[reviewer:357\] stderr \(failure-class=unknown\): A{400}/);
  assert.match(joined, /…<truncated \d+ chars>… B{400}/);
  assert.doesNotMatch(joined, /MIDDLE_REGION_SHOULD_BE_ELIDED/);
});

test('empty stderr does not emit a bogus log line', () => {
  const db = setupDb();
  const log = captureLogs();

  settleReviewerAttempt({
    rootDir: '/tmp/lac-545-fixture-' + Date.now(),
    repoPath: REPO,
    prNumber: PR,
    result: {
      ok: false,
      error: '',
      stderr: '',
      stdout: '',
      failureClass: 'unknown',
    },
    failureAt: '2026-05-11T00:04:00.000Z',
    maxRemediationRounds: 2,
    statements: makeStatements(db),
    log,
  });

  const joined = log.lines.join('\n');
  // No spurious "[reviewer:357] stderr ..." or "[reviewer:357] stdout ..." line
  // when there's nothing captured to log.
  assert.doesNotMatch(joined, /\[reviewer:357\] stderr \(failure-class=/);
  assert.doesNotMatch(joined, /\[reviewer:357\] stdout \(failure-class=/);
  // The pre-existing attempt-budget log line still fires though.
  assert.match(joined, /Reviewer unknown-class failure on #357/);
});

test('cascade-class transient failure path also logs stderr', () => {
  // Same diagnostic contract on the transient branch — cascade-class
  // failures should also surface their captured stderr so a future
  // operator can see WHY the cascade-classifier fired.
  const db = setupDb();
  const log = captureLogs();
  const stderr = 'all upstream attempts failed: 503 from litellm';

  settleReviewerAttempt({
    rootDir: '/tmp/lac-545-fixture-' + Date.now(),
    repoPath: REPO,
    prNumber: PR,
    result: {
      ok: false,
      error: stderr,
      stderr,
      stdout: '',
      failureClass: 'cascade',
    },
    failureAt: '2026-05-11T00:05:00.000Z',
    maxRemediationRounds: 2,
    statements: makeStatements(db),
    log,
  });

  const joined = log.lines.join('\n');
  assert.match(joined, /\[reviewer:357\] stderr \(failure-class=cascade\): all upstream attempts failed/);
});
