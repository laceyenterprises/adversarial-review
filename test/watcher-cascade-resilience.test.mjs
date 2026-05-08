import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { ensureReviewStateSchema } from '../src/review-state.mjs';
import {
  CASCADE_FAILURE_CAP,
  classifyReviewerFailure,
  clearCascadeState,
  getCascadeStatePath,
  isReviewerSubprocessTimeout,
  readCascadeState,
  recordCascadeFailure,
  shouldBackoffReviewerSpawn,
} from '../src/reviewer-cascade.mjs';
import { settleReviewerAttempt } from '../src/watcher.mjs';

const execFileAsync = promisify(execFile);

function setupFixture() {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'watcher-cascade-'));
  mkdirSync(path.join(rootDir, 'data'), { recursive: true });
  const db = new Database(path.join(rootDir, 'data', 'reviews.db'));
  ensureReviewStateSchema(db);
  db.prepare(
    'INSERT INTO reviewed_prs (repo, pr_number, reviewed_at, reviewer, pr_state, review_status, review_attempts) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(
    'laceyenterprises/adversarial-review',
    195,
    '2026-05-04T07:00:00.000Z',
    'claude',
    'open',
    'pending',
    0
  );
  return { rootDir, db };
}

const stmtMarkCascadeFailed = (db) => db.prepare(
  "UPDATE reviewed_prs SET review_status = 'failed', failed_at = ?, failure_message = ? WHERE repo = ? AND pr_number = ?"
);
const stmtMarkPendingUpstream = (db) => db.prepare(
  "UPDATE reviewed_prs SET review_status = 'pending-upstream', failed_at = ?, failure_message = ? WHERE repo = ? AND pr_number = ?"
);
const stmtMarkBugFailed = (db) => db.prepare(
  "UPDATE reviewed_prs SET review_status = 'failed', failed_at = ?, failure_message = ?, review_attempts = review_attempts + 1 WHERE repo = ? AND pr_number = ?"
);

test('cascade simulator backs off and does not increment attempt counter', () => {
  const { rootDir, db } = setupFixture();
  try {
    const failedAt = '2026-05-04T07:10:00.000Z';
    const cascadeState = recordCascadeFailure(rootDir, {
      repo: 'laceyenterprises/adversarial-review',
      prNumber: 195,
      failedAt,
    });
    stmtMarkCascadeFailed(db).run(
      failedAt,
      'All upstream attempts failed in LiteLLM reviewer lane.',
      'laceyenterprises/adversarial-review',
      195
    );

    const row = db.prepare(
      'SELECT review_status, review_attempts, failed_at FROM reviewed_prs WHERE repo = ? AND pr_number = ?'
    ).get('laceyenterprises/adversarial-review', 195);

    assert.equal(classifyReviewerFailure('All upstream attempts failed', 1), 'cascade');
    assert.equal(row.review_status, 'failed');
    assert.equal(row.review_attempts, 0, 'cascade retries must not burn the normal attempt counter');
    assert.equal(row.failed_at, failedAt);
    assert.equal(cascadeState.consecutiveCascadeFailures, 1);
    assert.equal(cascadeState.backoffMinutes, 1);
    assert.equal(cascadeState.nextRetryAfter, '2026-05-04T07:11:00.000Z');
    assert.equal(
      shouldBackoffReviewerSpawn(rootDir, {
        repo: 'laceyenterprises/adversarial-review',
        prNumber: 195,
        now: '2026-05-04T07:10:30.000Z',
      }).shouldBackoff,
      true
    );
  } finally {
    db.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('bug simulator counts normally and does not create cascade state', () => {
  const { rootDir, db } = setupFixture();
  try {
    const failedAt = '2026-05-04T07:12:00.000Z';
    stmtMarkBugFailed(db).run(
      failedAt,
      'spawn reviewer failed: cannot find reviewer binary',
      'laceyenterprises/adversarial-review',
      195
    );

    const row = db.prepare(
      'SELECT review_status, review_attempts, failed_at, failure_message FROM reviewed_prs WHERE repo = ? AND pr_number = ?'
    ).get('laceyenterprises/adversarial-review', 195);

    assert.equal(classifyReviewerFailure('cannot find reviewer binary', 127), 'bug');
    assert.equal(classifyReviewerFailure('spawn failed', null, 'ENOENT'), 'bug');
    assert.equal(row.review_status, 'failed');
    assert.equal(row.review_attempts, 1);
    assert.equal(row.failed_at, failedAt);
    assert.match(row.failure_message, /cannot find/i);
    assert.equal(readCascadeState(rootDir, {
      repo: 'laceyenterprises/adversarial-review',
      prNumber: 195,
    }), null);
  } finally {
    db.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('rate-limit and 5xx heuristics distinguish real 429s from cascades', () => {
  assert.equal(
    classifyReviewerFailure('RateLimitError: rate_limit_exceeded for current quota window', 1),
    'unknown'
  );
  assert.equal(
    classifyReviewerFailure('upstream retry exhausted after HTTP/1.1 503 from LiteLLM', 1),
    'cascade'
  );
});

test('reviewer subprocess timeouts get a distinct failure class', async () => {
  await assert.rejects(
    execFileAsync(
      process.execPath,
      ['-e', 'setTimeout(() => {}, 10_000)'],
      { timeout: 50, killSignal: 'SIGTERM' }
    ),
    (err) => {
      assert.equal(err.killed, true);
      assert.equal(err.signal, 'SIGTERM');
      assert.equal(err.code, null);
      assert.equal(isReviewerSubprocessTimeout(err, { killSignal: 'SIGTERM' }), true);
      assert.equal(
        classifyReviewerFailure(
          err.stderr || err.message,
          err.exitCode ?? err.code,
          err.code,
          err
        ),
        'reviewer-timeout'
      );
      return true;
    }
  );
});

test('launchctl bootstrap errors get a distinct failure class', () => {
  assert.equal(
    classifyReviewerFailure(
      'LaunchctlSessionError: Claude launchctl session bootstrap failed: Command failed: /bin/launchctl asuser 501 /usr/bin/env -u ANTHROPIC_API_KEY /opt/homebrew/bin/claude auth status',
      1
    ),
    'launchctl-bootstrap'
  );
});

test('reviewer controller aborts do not engage cascade backoff', () => {
  const abortErr = Object.assign(new Error('The operation was aborted'), {
    code: 'ABORT_ERR',
    killed: true,
    signal: 'SIGTERM',
  });

  assert.equal(isReviewerSubprocessTimeout(abortErr, { killSignal: 'SIGTERM' }), false);
  assert.equal(
    classifyReviewerFailure(abortErr.message, null, abortErr.code, abortErr),
    'unknown'
  );
});

test('recovery clears cascade state after a successful review', () => {
  const { rootDir, db } = setupFixture();
  try {
    recordCascadeFailure(rootDir, {
      repo: 'laceyenterprises/adversarial-review',
      prNumber: 195,
      failedAt: '2026-05-04T07:10:00.000Z',
    });
    clearCascadeState(rootDir, {
      repo: 'laceyenterprises/adversarial-review',
      prNumber: 195,
    });

    assert.equal(readCascadeState(rootDir, {
      repo: 'laceyenterprises/adversarial-review',
      prNumber: 195,
    }), null);
    assert.equal(
      shouldBackoffReviewerSpawn(rootDir, {
        repo: 'laceyenterprises/adversarial-review',
        prNumber: 195,
        now: '2026-05-04T07:12:00.000Z',
      }).shouldBackoff,
      false
    );
  } finally {
    db.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('cascade state paths validate PR numbers and encode repo slugs losslessly', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'watcher-cascade-paths-'));
  try {
    const encoded = getCascadeStatePath(rootDir, {
      repo: 'laceyenterprises/a__b',
      prNumber: 195,
    });
    const slashEncoded = getCascadeStatePath(rootDir, {
      repo: 'laceyenterprises/a/b',
      prNumber: 195,
    });

    assert.notEqual(encoded, slashEncoded);
    assert.throws(
      () => getCascadeStatePath(rootDir, { repo: 'laceyenterprises/adversarial-review', prNumber: 'NaN' }),
      /Invalid PR number/
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('invalid cascade timestamps fail closed until state is cleared or rewritten', () => {
  const { rootDir, db } = setupFixture();
  try {
    const statePath = getCascadeStatePath(rootDir, {
      repo: 'laceyenterprises/adversarial-review',
      prNumber: 195,
    });
    mkdirSync(path.dirname(statePath), { recursive: true });
    writeFileSync(
      statePath,
      `${JSON.stringify({
        consecutiveCascadeFailures: 2,
        lastFailureAt: '2026-05-04T07:10:00.000Z',
        nextRetryAfter: 'not-a-date',
        backoffMinutes: 2,
      })}\n`,
      'utf8'
    );

    const gate = shouldBackoffReviewerSpawn(rootDir, {
      repo: 'laceyenterprises/adversarial-review',
      prNumber: 195,
      now: '2026-05-04T07:12:00.000Z',
    });
    assert.equal(gate.shouldBackoff, true);
  } finally {
    db.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('pending-upstream engages after five consecutive cascades and further retries stay capped', () => {
  const { rootDir, db } = setupFixture();
  try {
    let state;
    for (let i = 0; i < CASCADE_FAILURE_CAP; i += 1) {
      state = recordCascadeFailure(rootDir, {
        repo: 'laceyenterprises/adversarial-review',
        prNumber: 195,
        failedAt: `2026-05-04T07:1${i}:00.000Z`,
      });
    }

    stmtMarkPendingUpstream(db).run(
      '2026-05-04T07:14:00.000Z',
      'Upstream cascade persisted through five retries.',
      'laceyenterprises/adversarial-review',
      195
    );

    const row = db.prepare(
      'SELECT review_status, review_attempts FROM reviewed_prs WHERE repo = ? AND pr_number = ?'
    ).get('laceyenterprises/adversarial-review', 195);

    assert.equal(state.consecutiveCascadeFailures, 5);
    assert.equal(state.backoffMinutes, 15);
    assert.equal(row.review_status, 'pending-upstream');
    assert.equal(row.review_attempts, 0);
    assert.equal(
      shouldBackoffReviewerSpawn(rootDir, {
        repo: 'laceyenterprises/adversarial-review',
        prNumber: 195,
        now: '2026-05-04T07:20:00.000Z',
      }).shouldBackoff,
      true
    );

    const capped = recordCascadeFailure(rootDir, {
      repo: 'laceyenterprises/adversarial-review',
      prNumber: 195,
      failedAt: '2026-05-04T07:30:00.000Z',
    });
    assert.equal(capped.consecutiveCascadeFailures, CASCADE_FAILURE_CAP, 'pending-upstream retries stay capped');
    assert.equal(capped.backoffMinutes, 15);
  } finally {
    db.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('recordCascadeFailure writes atomically via temp-file rename', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'watcher-cascade-atomic-'));
  try {
    const targetPath = getCascadeStatePath(rootDir, {
      repo: 'laceyenterprises/adversarial-review',
      prNumber: 195,
    });
    const tmpPath = `${targetPath}.tmp`;
    mkdirSync(path.dirname(targetPath), { recursive: true });
    recordCascadeFailure(rootDir, {
      repo: 'laceyenterprises/adversarial-review',
      prNumber: 195,
      failedAt: '2026-05-04T07:10:00.000Z',
    });

    const state = JSON.parse(readFileSync(targetPath, 'utf8'));
    assert.equal(state.consecutiveCascadeFailures, 1);
    assert.throws(() => readFileSync(tmpPath, 'utf8'), /ENOENT/);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('settleReviewerAttempt preserves pending-upstream audit fields and clears cascade state on success', () => {
  const { rootDir, db } = setupFixture();
  try {
    const repo = 'laceyenterprises/adversarial-review';
    const prNumber = 195;
    const statements = {
      markPosted: db.prepare(
        "UPDATE reviewed_prs SET review_status = 'posted', posted_at = ?, failed_at = NULL, failure_message = NULL, review_attempts = review_attempts + 1 WHERE repo = ? AND pr_number = ?"
      ),
      markFailed: stmtMarkBugFailed(db),
      markCascadeFailed: stmtMarkCascadeFailed(db),
      markPendingUpstream: stmtMarkPendingUpstream(db),
      getReviewRow: db.prepare('SELECT * FROM reviewed_prs WHERE repo = ? AND pr_number = ?'),
    };

    for (let i = 0; i < CASCADE_FAILURE_CAP; i += 1) {
      recordCascadeFailure(rootDir, { repo, prNumber, failedAt: `2026-05-04T07:1${i}:00.000Z` });
    }
    stmtMarkPendingUpstream(db).run(
      '2026-05-04T07:14:00.000Z',
      'Upstream cascade persisted through five retries.',
      repo,
      prNumber
    );

    db.prepare(
      `UPDATE reviewed_prs
          SET review_status = 'reviewing',
              last_attempted_at = ?,
              failed_at = CASE
                WHEN review_status = 'pending-upstream' THEN failed_at
                ELSE NULL
              END,
              failure_message = CASE
                WHEN review_status = 'pending-upstream' THEN failure_message
                ELSE NULL
              END
        WHERE repo = ?
          AND pr_number = ?
          AND review_status IN ('pending', 'failed', 'pending-upstream')`
    ).run('2026-05-04T07:30:00.000Z', repo, prNumber);

    let row = db.prepare(
      'SELECT review_status, failed_at, failure_message FROM reviewed_prs WHERE repo = ? AND pr_number = ?'
    ).get(repo, prNumber);
    assert.equal(row.failed_at, '2026-05-04T07:14:00.000Z');
    assert.equal(row.failure_message, 'Upstream cascade persisted through five retries.');

    settleReviewerAttempt({
      rootDir,
      repoPath: repo,
      prNumber,
      result: { ok: true },
      statements,
      log: { warn() {} },
    });

    row = db.prepare(
      'SELECT review_status, review_attempts, failure_message FROM reviewed_prs WHERE repo = ? AND pr_number = ?'
    ).get(repo, prNumber);
    assert.equal(row.review_status, 'posted');
    assert.equal(row.review_attempts, 1);
    assert.equal(row.failure_message, null);
    assert.equal(readCascadeState(rootDir, { repo, prNumber }), null);
  } finally {
    db.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('settleReviewerAttempt records cascade failures and marks pending-upstream at the cap', () => {
  const { rootDir, db } = setupFixture();
  try {
    const repo = 'laceyenterprises/adversarial-review';
    const prNumber = 195;
    const statements = {
      markPosted: db.prepare(
        "UPDATE reviewed_prs SET review_status = 'posted', posted_at = ?, failed_at = NULL, failure_message = NULL, review_attempts = review_attempts + 1 WHERE repo = ? AND pr_number = ?"
      ),
      markFailed: stmtMarkBugFailed(db),
      markCascadeFailed: stmtMarkCascadeFailed(db),
      markPendingUpstream: stmtMarkPendingUpstream(db),
      getReviewRow: db.prepare('SELECT * FROM reviewed_prs WHERE repo = ? AND pr_number = ?'),
    };

    for (let i = 0; i < CASCADE_FAILURE_CAP; i += 1) {
      settleReviewerAttempt({
        rootDir,
        repoPath: repo,
        prNumber,
        result: {
          ok: false,
          error: 'All upstream attempts failed in LiteLLM reviewer lane.',
          failureClass: 'cascade',
        },
        failureAt: `2026-05-04T07:1${i}:00.000Z`,
        maxRemediationRounds: 1,
        statements,
        log: { warn() {} },
      });
    }

    const row = db.prepare(
      'SELECT review_status, review_attempts, failure_message FROM reviewed_prs WHERE repo = ? AND pr_number = ?'
    ).get(repo, prNumber);
    const state = readCascadeState(rootDir, { repo, prNumber });

    assert.equal(row.review_status, 'pending-upstream');
    assert.equal(row.review_attempts, 0);
    assert.match(row.failure_message, /^\[cascade\]/);
    assert.match(row.failure_message, /All upstream attempts failed/);
    assert.equal(state.consecutiveCascadeFailures, CASCADE_FAILURE_CAP);
    assert.equal(state.backoffMinutes, 15);
  } finally {
    db.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('settleReviewerAttempt records reviewer timeout class without burning attempts', () => {
  const { rootDir, db } = setupFixture();
  try {
    const repo = 'laceyenterprises/adversarial-review';
    const prNumber = 195;
    const warnings = [];
    const statements = {
      markPosted: db.prepare(
        "UPDATE reviewed_prs SET review_status = 'posted', posted_at = ?, failed_at = NULL, failure_message = NULL, review_attempts = review_attempts + 1 WHERE repo = ? AND pr_number = ?"
      ),
      markFailed: stmtMarkBugFailed(db),
      markCascadeFailed: stmtMarkCascadeFailed(db),
      markPendingUpstream: stmtMarkPendingUpstream(db),
      getReviewRow: db.prepare('SELECT * FROM reviewed_prs WHERE repo = ? AND pr_number = ?'),
    };

    settleReviewerAttempt({
      rootDir,
      repoPath: repo,
      prNumber,
      result: {
        ok: false,
        error: 'Command failed after reviewer timeout',
        failureClass: 'reviewer-timeout',
      },
      failureAt: '2026-05-04T07:10:00.000Z',
      maxRemediationRounds: 1,
      statements,
      log: { warn: (line) => warnings.push(line) },
    });

    const row = db.prepare(
      'SELECT review_status, review_attempts, failure_message FROM reviewed_prs WHERE repo = ? AND pr_number = ?'
    ).get(repo, prNumber);

    assert.equal(row.review_status, 'failed');
    assert.equal(row.review_attempts, 0);
    assert.match(row.failure_message, /^\[reviewer-timeout\]/);
    assert.match(warnings.join('\n'), /Reviewer reviewer-timeout failure/);
    assert.equal(readCascadeState(rootDir, { repo, prNumber }).consecutiveCascadeFailures, 1);
  } finally {
    db.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});
