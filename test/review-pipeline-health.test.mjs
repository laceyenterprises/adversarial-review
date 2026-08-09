import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  REVIEW_PIPELINE_HEALTH_FINDING_DEFINITIONS,
  REVIEW_PIPELINE_HEALTH_METRICS,
  collectReviewPipelineHealth,
  renderReviewPipelinePrometheus,
} from '../src/review-pipeline-health.mjs';
import { PROVIDER_OVERLOADED_FAILURE_CLASS } from '../src/adapters/reviewer-runtime/cli-direct/classification.mjs';
import { QUOTA_EXHAUSTED_FAILURE_CLASS } from '../src/quota-exhaustion.mjs';
import { parseArgs } from '../src/review-pipeline-health-cli.mjs';
import { ensureReviewStateSchema, openReviewStateDb } from '../src/review-state.mjs';

const NOW = '2026-05-25T18:00:00.000Z';
const REPO = 'laceyenterprises/adversarial-review';

function tempRoot() {
  return mkdtempSync(path.join(tmpdir(), 'review-pipeline-health-'));
}

function launchctlPrintError({ message = 'launchctl print failed', stdout = '', stderr = '' } = {}) {
  const error = new Error(message);
  error.stdout = stdout;
  error.stderr = stderr;
  return error;
}

function openDb(rootDir) {
  const db = openReviewStateDb(rootDir);
  ensureReviewStateSchema(db);
  return db;
}

function insertReviewRow(rootDir, overrides = {}) {
  const db = openDb(rootDir);
  try {
    db.prepare(
      `INSERT INTO reviewed_prs
         (repo, pr_number, reviewed_at, reviewer, pr_state, review_status,
          review_attempts, last_attempted_at, posted_at, failed_at, failure_message)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      overrides.repo || REPO,
      overrides.prNumber || 946,
      overrides.reviewedAt || '2026-05-25T17:00:00.000Z',
      overrides.reviewer || 'claude',
      overrides.prState || 'open',
      overrides.reviewStatus || 'pending',
      overrides.reviewAttempts ?? 0,
      overrides.lastAttemptedAt ?? null,
      overrides.postedAt ?? null,
      overrides.failedAt ?? null,
      overrides.failureMessage ?? null
    );
  } finally {
    db.close();
  }
}

function insertReviewerPass(rootDir, overrides = {}) {
  const db = openDb(rootDir);
  try {
    db.prepare(
      `INSERT INTO reviewer_passes
         (repo, pr_number, attempt_number, reviewer_class, reviewer_model,
          pass_kind, started_at, ended_at, status, metadata_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      overrides.repo || REPO,
      overrides.prNumber || 950,
      overrides.attemptNumber ?? 1,
      overrides.reviewerClass || 'claude',
      overrides.reviewerModel || 'claude-sonnet',
      overrides.passKind || 'first-pass',
      overrides.startedAt || '2026-05-25T17:45:00.000Z',
      overrides.endedAt || '2026-05-25T17:50:00.000Z',
      overrides.status || 'failed',
      JSON.stringify(overrides.metadata || { failureClass: 'timeout' })
    );
  } finally {
    db.close();
  }
}

function insertReviewerPasses(rootDir, passes) {
  for (const pass of passes) insertReviewerPass(rootDir, pass);
}

function writeJob(rootDir, state, name, job) {
  const dir = path.join(rootDir, 'data', 'follow-up-jobs', state);
  mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${name}.json`);
  writeFileSync(filePath, `${JSON.stringify(job, null, 2)}\n`);
  return filePath;
}

function findingCodes(snapshot) {
  return snapshot.findings.map((finding) => finding.code).sort();
}

test('reviewer death-rate finding fires on a high failed/attempted ratio and clears when passes recover', () => {
  const rootDir = tempRoot();
  insertReviewRow(rootDir, { prNumber: 1, reviewStatus: 'posted', postedAt: '2026-05-25T17:00:00.000Z' });
  insertReviewerPass(rootDir, { attemptNumber: 1, status: 'failed', metadata: { failureClass: 'timeout' } });
  insertReviewerPass(rootDir, { attemptNumber: 2, status: 'failed', metadata: { failureClass: 'timeout' } });
  insertReviewerPass(rootDir, { attemptNumber: 3, status: 'failed', metadata: { failureClass: 'timeout' } });
  insertReviewerPass(rootDir, { attemptNumber: 4, status: 'completed', metadata: {} });

  const firing = collectReviewPipelineHealth({ rootDir, now: () => new Date(NOW) });
  assert.ok(findingCodes(firing).includes('review:reviewer_death_rate_high'));

  const db = openDb(rootDir);
  try {
    db.prepare("UPDATE reviewer_passes SET status = 'completed', metadata_json = '{}'").run();
  } finally {
    db.close();
  }

  const cleared = collectReviewPipelineHealth({ rootDir, now: () => new Date(NOW) });
  assert.ok(!findingCodes(cleared).includes('review:reviewer_death_rate_high'));
});

test('reviewer death-rate finding aggregates mixed failure classes over settled attempts only', () => {
  const rootDir = tempRoot();
  insertReviewRow(rootDir, { prNumber: 2, reviewStatus: 'posted', postedAt: '2026-05-25T17:00:00.000Z' });
  insertReviewerPass(rootDir, { prNumber: 2, attemptNumber: 1, status: 'failed', metadata: { failureClass: 'timeout' } });
  insertReviewerPass(rootDir, { prNumber: 2, attemptNumber: 2, status: 'failed', metadata: { failureClass: 'oauth refresh failed' } });
  insertReviewerPass(rootDir, { prNumber: 2, attemptNumber: 3, status: 'failed', metadata: { failureClass: 'upstream 502' } });
  insertReviewerPass(rootDir, { prNumber: 2, attemptNumber: 4, status: 'failed', metadata: { failureClass: 'token expired' } });
  insertReviewerPass(rootDir, { prNumber: 2, attemptNumber: 5, status: 'completed', metadata: {} });
  insertReviewerPass(rootDir, { prNumber: 2, attemptNumber: 6, status: 'completed', metadata: {} });
  insertReviewerPass(rootDir, { prNumber: 2, attemptNumber: 7, status: 'running', endedAt: null, metadata: {} });
  insertReviewerPass(rootDir, { prNumber: 2, attemptNumber: 8, status: 'cancelled', metadata: {} });

  const snapshot = collectReviewPipelineHealth({ rootDir, now: () => new Date(NOW) });
  assert.ok(findingCodes(snapshot).includes('review:reviewer_death_rate_high'));
  assert.equal(snapshot.reviewer.failed, 4);
  assert.equal(snapshot.reviewer.settled, 6);
  assert.equal(snapshot.reviewer.failureRatios.find((row) => row.failureClass === 'auth')?.failed, 2);
  assert.equal(snapshot.findings[0].details.excludedStatuses.join(','), 'running,cancelled');
});

test('reviewer health classifier recognizes server and service overload wording', () => {
  const rootDir = tempRoot();
  insertReviewRow(rootDir, { prNumber: 3, reviewStatus: 'posted', postedAt: '2026-05-25T17:00:00.000Z' });
  insertReviewerPass(rootDir, {
    prNumber: 3,
    attemptNumber: 1,
    status: 'failed',
    metadata: { failureClass: 'The server is overloaded; retry later' },
  });
  insertReviewerPass(rootDir, {
    prNumber: 3,
    attemptNumber: 2,
    status: 'failed',
    metadata: { failureClass: 'The service is temporarily overloaded' },
  });

  const snapshot = collectReviewPipelineHealth({ rootDir, now: () => new Date(NOW) });
  assert.equal(
    snapshot.reviewer.failureRatios.find((row) => row.failureClass === PROVIDER_OVERLOADED_FAILURE_CLASS)?.failed,
    2
  );
});

test('unknown failure-rate finding fires on 6/10 failures from 2 distinct PRs in-window', () => {
  const rootDir = tempRoot();
  insertReviewRow(rootDir, { prNumber: 40, reviewStatus: 'posted', postedAt: '2026-05-25T17:00:00.000Z' });
  insertReviewRow(rootDir, { prNumber: 41, reviewStatus: 'posted', postedAt: '2026-05-25T17:00:00.000Z' });
  insertReviewerPasses(rootDir, [
    { prNumber: 40, attemptNumber: 1, startedAt: '2026-05-25T17:50:00.000Z', status: 'failed', metadata: {} },
    { prNumber: 40, attemptNumber: 2, startedAt: '2026-05-25T17:51:00.000Z', status: 'failed', metadata: {} },
    { prNumber: 40, attemptNumber: 3, startedAt: '2026-05-25T17:52:00.000Z', status: 'failed', metadata: {} },
    { prNumber: 41, attemptNumber: 1, startedAt: '2026-05-25T17:53:00.000Z', status: 'failed', metadata: {} },
    { prNumber: 41, attemptNumber: 2, startedAt: '2026-05-25T17:54:00.000Z', status: 'failed', metadata: {} },
    { prNumber: 41, attemptNumber: 3, startedAt: '2026-05-25T17:55:00.000Z', status: 'failed', metadata: {} },
    { prNumber: 40, attemptNumber: 4, startedAt: '2026-05-25T17:56:00.000Z', status: 'failed', metadata: { failureClass: 'timeout' } },
    { prNumber: 40, attemptNumber: 5, startedAt: '2026-05-25T17:57:00.000Z', status: 'failed', metadata: { failureClass: 'timeout' } },
    { prNumber: 41, attemptNumber: 4, startedAt: '2026-05-25T17:58:00.000Z', status: 'failed', metadata: { failureClass: 'auth' } },
    { prNumber: 41, attemptNumber: 5, startedAt: '2026-05-25T17:59:00.000Z', status: 'failed', metadata: { failureClass: 'upstream 502' } },
  ]);

  const snapshot = collectReviewPipelineHealth({ rootDir, now: () => new Date(NOW) });
  assert.ok(findingCodes(snapshot).includes('review:unknown_failure_rate_high'));
  assert.equal(snapshot.reviewer.unknownRateWindow.failed, 6);
  assert.equal(snapshot.reviewer.unknownRateWindow.totalFailures, 10);
  assert.equal(snapshot.reviewer.unknownRateWindow.distinctPrs, 2);
});

test('unknown failure-rate finding suppresses single-PR flapping by default and can opt out', () => {
  const rootDir = tempRoot();
  insertReviewRow(rootDir, { prNumber: 42, reviewStatus: 'posted', postedAt: '2026-05-25T17:00:00.000Z' });
  insertReviewerPasses(rootDir, [
    { prNumber: 42, attemptNumber: 1, startedAt: '2026-05-25T17:50:00.000Z', status: 'failed', metadata: {} },
    { prNumber: 42, attemptNumber: 2, startedAt: '2026-05-25T17:51:00.000Z', status: 'failed', metadata: {} },
    { prNumber: 42, attemptNumber: 3, startedAt: '2026-05-25T17:52:00.000Z', status: 'failed', metadata: {} },
    { prNumber: 42, attemptNumber: 4, startedAt: '2026-05-25T17:53:00.000Z', status: 'failed', metadata: {} },
    { prNumber: 42, attemptNumber: 5, startedAt: '2026-05-25T17:54:00.000Z', status: 'failed', metadata: {} },
    { prNumber: 42, attemptNumber: 6, startedAt: '2026-05-25T17:55:00.000Z', status: 'failed', metadata: {} },
    { prNumber: 42, attemptNumber: 7, startedAt: '2026-05-25T17:56:00.000Z', status: 'failed', metadata: { failureClass: 'timeout' } },
    { prNumber: 42, attemptNumber: 8, startedAt: '2026-05-25T17:57:00.000Z', status: 'failed', metadata: { failureClass: 'timeout' } },
    { prNumber: 42, attemptNumber: 9, startedAt: '2026-05-25T17:58:00.000Z', status: 'failed', metadata: { failureClass: 'auth' } },
    { prNumber: 42, attemptNumber: 10, startedAt: '2026-05-25T17:59:00.000Z', status: 'failed', metadata: { failureClass: 'upstream 502' } },
  ]);

  const suppressed = collectReviewPipelineHealth({ rootDir, now: () => new Date(NOW) });
  assert.ok(!findingCodes(suppressed).includes('review:unknown_failure_rate_high'));

  const optedOut = collectReviewPipelineHealth({
    rootDir,
    now: () => new Date(NOW),
    env: { REVIEW_UNKNOWN_RATE_DISTINCT_PR_FLOOR: '1' },
  });
  assert.ok(findingCodes(optedOut).includes('review:unknown_failure_rate_high'));
});

test('unknown failure-rate finding clears below threshold and respects sample floor', () => {
  const rootDir = tempRoot();
  insertReviewRow(rootDir, { prNumber: 43, reviewStatus: 'posted', postedAt: '2026-05-25T17:00:00.000Z' });
  insertReviewRow(rootDir, { prNumber: 44, reviewStatus: 'posted', postedAt: '2026-05-25T17:00:00.000Z' });
  insertReviewerPasses(rootDir, [
    { prNumber: 43, attemptNumber: 1, startedAt: '2026-05-25T17:50:00.000Z', status: 'failed', metadata: {} },
    { prNumber: 44, attemptNumber: 1, startedAt: '2026-05-25T17:51:00.000Z', status: 'failed', metadata: {} },
    { prNumber: 43, attemptNumber: 2, startedAt: '2026-05-25T17:52:00.000Z', status: 'failed', metadata: { failureClass: 'timeout' } },
    { prNumber: 44, attemptNumber: 2, startedAt: '2026-05-25T17:53:00.000Z', status: 'failed', metadata: { failureClass: 'timeout' } },
    { prNumber: 43, attemptNumber: 3, startedAt: '2026-05-25T17:54:00.000Z', status: 'failed', metadata: { failureClass: 'timeout' } },
    { prNumber: 44, attemptNumber: 3, startedAt: '2026-05-25T17:55:00.000Z', status: 'failed', metadata: { failureClass: 'auth' } },
    { prNumber: 43, attemptNumber: 4, startedAt: '2026-05-25T17:56:00.000Z', status: 'failed', metadata: { failureClass: 'auth' } },
    { prNumber: 44, attemptNumber: 4, startedAt: '2026-05-25T17:57:00.000Z', status: 'failed', metadata: { failureClass: 'upstream 502' } },
    { prNumber: 43, attemptNumber: 5, startedAt: '2026-05-25T17:58:00.000Z', status: 'failed', metadata: { failureClass: 'runtime' } },
    { prNumber: 44, attemptNumber: 5, startedAt: '2026-05-25T17:59:00.000Z', status: 'failed', metadata: { failureClass: 'orphan' } },
  ]);

  const cleared = collectReviewPipelineHealth({ rootDir, now: () => new Date(NOW) });
  assert.ok(!findingCodes(cleared).includes('review:unknown_failure_rate_high'));

  const sampleFloorRoot = tempRoot();
  insertReviewRow(sampleFloorRoot, { prNumber: 45, reviewStatus: 'posted', postedAt: '2026-05-25T17:00:00.000Z' });
  insertReviewRow(sampleFloorRoot, { prNumber: 46, reviewStatus: 'posted', postedAt: '2026-05-25T17:00:00.000Z' });
  insertReviewerPasses(sampleFloorRoot, [
    { prNumber: 45, attemptNumber: 1, startedAt: '2026-05-25T17:58:00.000Z', status: 'failed', metadata: {} },
    { prNumber: 46, attemptNumber: 1, startedAt: '2026-05-25T17:59:00.000Z', status: 'failed', metadata: { failureClass: 'timeout' } },
  ]);
  const sampleFloorSuppressed = collectReviewPipelineHealth({ rootDir: sampleFloorRoot, now: () => new Date(NOW) });
  assert.ok(!findingCodes(sampleFloorSuppressed).includes('review:unknown_failure_rate_high'));
});

test('unknown failure-rate finding respects configurable threshold and window', () => {
  const rootDir = tempRoot();
  insertReviewRow(rootDir, { prNumber: 47, reviewStatus: 'posted', postedAt: '2026-05-25T17:00:00.000Z' });
  insertReviewRow(rootDir, { prNumber: 48, reviewStatus: 'posted', postedAt: '2026-05-25T17:00:00.000Z' });
  insertReviewerPasses(rootDir, [
    { prNumber: 47, attemptNumber: 1, startedAt: '2026-05-25T17:50:00.000Z', status: 'failed', metadata: {} },
    { prNumber: 47, attemptNumber: 2, startedAt: '2026-05-25T17:51:00.000Z', status: 'failed', metadata: {} },
    { prNumber: 48, attemptNumber: 1, startedAt: '2026-05-25T17:52:00.000Z', status: 'failed', metadata: {} },
    { prNumber: 48, attemptNumber: 2, startedAt: '2026-05-25T17:53:00.000Z', status: 'failed', metadata: {} },
    { prNumber: 47, attemptNumber: 3, startedAt: '2026-05-25T17:54:00.000Z', status: 'failed', metadata: { failureClass: 'timeout' } },
    { prNumber: 47, attemptNumber: 4, startedAt: '2026-05-25T17:55:00.000Z', status: 'failed', metadata: { failureClass: 'timeout' } },
    { prNumber: 48, attemptNumber: 3, startedAt: '2026-05-25T17:56:00.000Z', status: 'failed', metadata: { failureClass: 'auth' } },
    { prNumber: 48, attemptNumber: 4, startedAt: '2026-05-25T17:57:00.000Z', status: 'failed', metadata: { failureClass: 'auth' } },
    { prNumber: 47, attemptNumber: 5, startedAt: '2026-05-25T17:58:00.000Z', status: 'failed', metadata: { failureClass: 'upstream 502' } },
    { prNumber: 48, attemptNumber: 5, startedAt: '2026-05-25T17:59:00.000Z', status: 'failed', metadata: { failureClass: 'runtime' } },
  ]);

  const defaultSnapshot = collectReviewPipelineHealth({ rootDir, now: () => new Date(NOW) });
  assert.ok(findingCodes(defaultSnapshot).includes('review:unknown_failure_rate_high'));

  const thresholdRaised = collectReviewPipelineHealth({
    rootDir,
    now: () => new Date(NOW),
    env: { REVIEW_UNKNOWN_RATE_THRESHOLD: '0.50' },
  });
  assert.ok(!findingCodes(thresholdRaised).includes('review:unknown_failure_rate_high'));

  const oneMinuteRoot = tempRoot();
  insertReviewRow(oneMinuteRoot, { prNumber: 49, reviewStatus: 'posted', postedAt: '2026-05-25T17:00:00.000Z' });
  insertReviewRow(oneMinuteRoot, { prNumber: 50, reviewStatus: 'posted', postedAt: '2026-05-25T17:00:00.000Z' });
  insertReviewerPasses(oneMinuteRoot, [
    { prNumber: 49, attemptNumber: 1, startedAt: '2026-05-25T17:59:10.000Z', status: 'failed', metadata: {} },
    { prNumber: 50, attemptNumber: 1, startedAt: '2026-05-25T17:59:20.000Z', status: 'failed', metadata: {} },
    { prNumber: 49, attemptNumber: 2, startedAt: '2026-05-25T17:59:30.000Z', status: 'failed', metadata: {} },
    { prNumber: 50, attemptNumber: 2, startedAt: '2026-05-25T17:59:40.000Z', status: 'failed', metadata: {} },
    { prNumber: 49, attemptNumber: 3, startedAt: '2026-05-25T17:59:50.000Z', status: 'failed', metadata: {} },
  ]);
  const oneMinuteSnapshot = collectReviewPipelineHealth({
    rootDir: oneMinuteRoot,
    now: () => new Date(NOW),
    env: { REVIEW_UNKNOWN_RATE_WINDOW_MINUTES: '1' },
  });
  assert.ok(findingCodes(oneMinuteSnapshot).includes('review:unknown_failure_rate_high'));
  assert.equal(oneMinuteSnapshot.reviewer.unknownRateWindow.windowMs, 60_000);
});

test('collector reads review state without mutating legacy or missing-schema databases', () => {
  const rootDir = tempRoot();
  const dataDir = path.join(rootDir, 'data');
  mkdirSync(dataDir, { recursive: true });
  const dbPath = path.join(dataDir, 'reviews.db');
  const seedDb = new Database(dbPath);
  try {
    seedDb.exec('CREATE TABLE placeholder(id INTEGER PRIMARY KEY, note TEXT);');
  } finally {
    seedDb.close();
  }

  const snapshot = collectReviewPipelineHealth({ rootDir, now: () => new Date(NOW) });
  assert.deepEqual(findingCodes(snapshot), []);
  assert.equal(snapshot.reviewer.total, 0);
  assert.equal(snapshot.firstPassQueue.depth, 0);

  const verifyDb = new Database(dbPath, { readonly: true });
  try {
    const tableNames = verifyDb.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all();
    assert.deepEqual(tableNames.map((row) => row.name), ['placeholder']);
    assert.equal(verifyDb.pragma('user_version', { simple: true }), 0);
  } finally {
    verifyDb.close();
  }
});

test('collector emits a down signal when the review-state ledger is missing', () => {
  const rootDir = tempRoot();
  const snapshot = collectReviewPipelineHealth({ rootDir, now: () => new Date(NOW) });
  assert.equal(snapshot.reviewStateLedger.exists, false);
  assert.equal(snapshot.reviewStateLedger.readable, false);
  assert.ok(!findingCodes(snapshot).includes('review:review_state_ledger_unreadable'));

  const output = renderReviewPipelinePrometheus(snapshot);
  assert.match(output, /^# TYPE review_pipeline_health_collector_up gauge$/m);
  assert.match(output, /^review_pipeline_health_collector_up 0$/m);
});

test('collector emits a page finding when an existing review-state ledger cannot be opened', () => {
  const rootDir = tempRoot();
  mkdirSync(path.join(rootDir, 'data'), { recursive: true });
  mkdirSync(path.join(rootDir, 'data', 'reviews.db'));

  const snapshot = collectReviewPipelineHealth({ rootDir, now: () => new Date(NOW) });

  assert.equal(snapshot.reviewStateLedger.exists, true);
  assert.equal(snapshot.reviewStateLedger.readable, false);
  assert.ok(snapshot.reviewStateLedger.error);
  assert.ok(findingCodes(snapshot).includes('review:review_state_ledger_unreadable'));
  const finding = snapshot.findings.find((item) => item.code === 'review:review_state_ledger_unreadable');
  assert.equal(finding.tier, 'page');
  assert.match(finding.message, /reviews\.db/);
  assert.deepEqual(finding.evidence, [snapshot.reviewStateLedger.path]);
  assert.match(finding.recommended_action, /regular file with read access/);
  assert.doesNotMatch(finding.recommended_action, /native dependencies/);
  assert.deepEqual(finding.details, snapshot.reviewStateLedger);
});

test('collector skips unreadable follow-up job queues instead of failing the snapshot', () => {
  const rootDir = tempRoot();
  const unreadableDir = path.join(rootDir, 'data', 'follow-up-jobs', 'in-progress');
  mkdirSync(unreadableDir, { recursive: true });
  chmodSync(unreadableDir, 0o000);
  try {
    const snapshot = collectReviewPipelineHealth({ rootDir, now: () => new Date(NOW) });
    assert.equal(snapshot.reviewStateLedger.exists, false);
    assert.equal(snapshot.followUpQueues.states.in_progress, 0);
  } finally {
    chmodSync(unreadableDir, 0o700);
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('legacy fallback death-rate denominator counts only settled review rows', () => {
  const rootDir = tempRoot();
  insertReviewRow(rootDir, {
    prNumber: 31,
    reviewStatus: 'failed',
    lastAttemptedAt: '2026-05-25T17:40:00.000Z',
    failedAt: '2026-05-25T17:41:00.000Z',
    failureMessage: 'timeout',
  });
  insertReviewRow(rootDir, {
    prNumber: 32,
    reviewStatus: 'posted',
    lastAttemptedAt: '2026-05-25T17:42:00.000Z',
    postedAt: '2026-05-25T17:43:00.000Z',
  });
  insertReviewRow(rootDir, {
    prNumber: 33,
    reviewStatus: 'pending',
    lastAttemptedAt: '2026-05-25T17:44:00.000Z',
  });
  insertReviewRow(rootDir, {
    prNumber: 34,
    reviewStatus: 'reviewing',
    lastAttemptedAt: '2026-05-25T17:45:00.000Z',
  });

  const snapshot = collectReviewPipelineHealth({ rootDir, now: () => new Date(NOW) });
  assert.equal(snapshot.reviewer.total, 4);
  assert.equal(snapshot.reviewer.settled, 2);
  assert.equal(snapshot.reviewer.failed, 1);
  assert.equal(snapshot.reviewer.failureRatio, 0.5);
});

test('queue starvation finding fires on an old pending first-pass row and clears after posting', () => {
  const rootDir = tempRoot();
  insertReviewRow(rootDir, {
    prNumber: 946,
    reviewStatus: 'pending',
    reviewedAt: '2026-05-25T17:00:00.000Z',
  });

  const firing = collectReviewPipelineHealth({
    rootDir,
    now: () => new Date(NOW),
    config: { queueStarvationMaxAgeMs: 10 * 60 * 1000 },
  });
  assert.ok(findingCodes(firing).includes('review:queue_starvation'));

  const db = openDb(rootDir);
  try {
    db.prepare("UPDATE reviewed_prs SET review_status = 'posted', posted_at = ? WHERE pr_number = ?")
      .run('2026-05-25T18:00:00.000Z', 946);
  } finally {
    db.close();
  }

  const cleared = collectReviewPipelineHealth({
    rootDir,
    now: () => new Date(NOW),
    config: { queueStarvationMaxAgeMs: 10 * 60 * 1000 },
  });
  assert.ok(!findingCodes(cleared).includes('review:queue_starvation'));
});

test('remediation backlog finding fires on pending jobs and clears when the backlog drains', () => {
  const rootDir = tempRoot();
  insertReviewRow(rootDir, { prNumber: 10, reviewStatus: 'posted', postedAt: '2026-05-25T17:00:00.000Z' });
  const jobs = [
    writeJob(rootDir, 'pending', 'job-1', { jobId: 'job-1', repo: REPO, prNumber: 10, createdAt: '2026-05-25T17:00:00.000Z' }),
    writeJob(rootDir, 'pending', 'job-2', { jobId: 'job-2', repo: REPO, prNumber: 11, createdAt: '2026-05-25T17:01:00.000Z' }),
    writeJob(rootDir, 'pending', 'job-3', { jobId: 'job-3', repo: REPO, prNumber: 12, createdAt: '2026-05-25T17:02:00.000Z' }),
  ];

  const firing = collectReviewPipelineHealth({
    rootDir,
    now: () => new Date(NOW),
    config: { remediationBacklogThreshold: 2 },
  });
  assert.ok(findingCodes(firing).includes('review:remediation_backlog'));

  rmSync(jobs[0]);
  const completedDir = path.join(rootDir, 'data', 'follow-up-jobs', 'completed');
  mkdirSync(completedDir, { recursive: true });
  renameSync(jobs[1], path.join(completedDir, 'job-2.json'));

  const cleared = collectReviewPipelineHealth({
    rootDir,
    now: () => new Date(NOW),
    config: { remediationBacklogThreshold: 2 },
  });
  assert.ok(!findingCodes(cleared).includes('review:remediation_backlog'));
});

test('merge stalled finding fires on an old clean verdict and clears when the PR merges', () => {
  const rootDir = tempRoot();
  insertReviewRow(rootDir, {
    prNumber: 949,
    prState: 'open',
    reviewStatus: 'posted',
    postedAt: '2026-05-25T17:00:00.000Z',
  });
  writeJob(rootDir, 'stopped', 'clean-verdict', {
    jobId: 'clean-verdict',
    repo: REPO,
    prNumber: 949,
    status: 'stopped',
    createdAt: '2026-05-25T17:00:00.000Z',
    stoppedAt: '2026-05-25T17:15:00.000Z',
    remediationPlan: {
      stop: {
        code: 'review-settled',
        stoppedAt: '2026-05-25T17:15:00.000Z',
      },
    },
  });

  const firing = collectReviewPipelineHealth({
    rootDir,
    now: () => new Date(NOW),
    config: { mergeStalledMaxTicks: 1, pipelineTickIntervalMs: 5 * 60 * 1000 },
  });
  assert.ok(findingCodes(firing).includes('review:merge_stalled'));

  const db = openDb(rootDir);
  try {
    db.prepare("UPDATE reviewed_prs SET pr_state = 'merged', merged_at = ? WHERE pr_number = ?")
      .run('2026-05-25T18:00:00.000Z', 949);
  } finally {
    db.close();
  }

  const cleared = collectReviewPipelineHealth({
    rootDir,
    now: () => new Date(NOW),
    config: { mergeStalledMaxTicks: 1, pipelineTickIntervalMs: 5 * 60 * 1000 },
  });
  assert.ok(!findingCodes(cleared).includes('review:merge_stalled'));
});

test('merge stalled finding skips settled jobs with no review row', () => {
  const rootDir = tempRoot();
  openDb(rootDir).close();
  writeJob(rootDir, 'stopped', 'clean-verdict-orphan', {
    jobId: 'clean-verdict-orphan',
    repo: REPO,
    prNumber: 951,
    status: 'stopped',
    stoppedAt: '2026-05-25T17:15:00.000Z',
    remediationPlan: {
      stop: {
        code: 'review-settled',
        stoppedAt: '2026-05-25T17:15:00.000Z',
      },
    },
  });

  const snapshot = collectReviewPipelineHealth({
    rootDir,
    now: () => new Date(NOW),
    config: { mergeStalledMaxTicks: 1, pipelineTickIntervalMs: 5 * 60 * 1000 },
  });
  assert.ok(!findingCodes(snapshot).includes('review:merge_stalled'));
  assert.equal(snapshot.mergeStalls.candidates.length, 0);
});

test('stale AMA closer leases are reported without mutating lease files', () => {
  const rootDir = tempRoot();
  const leaseDir = path.join(rootDir, 'data', 'ama-closer-leases');
  mkdirSync(leaseDir, { recursive: true });
  const leasePath = path.join(leaseDir, 'laceyenterprises__agent-os-pr-12-abc.json');
  writeFileSync(leasePath, `${JSON.stringify({
    repo: 'laceyenterprises/agent-os',
    prNumber: 12,
    headSha: 'abc',
    acquiredAt: '2026-05-25T16:00:00.000Z',
    updatedAt: '2026-05-25T16:10:00.000Z',
    lrqId: 'lrq_ama',
    status: 'dispatched',
    terminalOutcome: null,
  }, null, 2)}\n`);
  const before = readFileSync(leasePath, 'utf8');

  const snapshot = collectReviewPipelineHealth({
    rootDir,
    now: () => new Date(NOW),
    config: { amaCloserLeaseMaxAgeMs: 20 * 60 * 1000 },
  });

  assert.ok(findingCodes(snapshot).includes('review:ama_closer_lease_stale'));
  assert.equal(snapshot.amaCloserLeases.stale[0].lrqId, 'lrq_ama');
  assert.equal(readFileSync(leasePath, 'utf8'), before);
});

test('stale AMA closer leases for merged PRs remain observable without paging', () => {
  const rootDir = tempRoot();
  const leaseDir = path.join(rootDir, 'data', 'ama-closer-leases');
  mkdirSync(leaseDir, { recursive: true });
  const leasePath = path.join(leaseDir, 'laceyenterprises__agent-os-pr-13-abc.json');
  writeFileSync(leasePath, `${JSON.stringify({
    repo: REPO,
    prNumber: 13,
    headSha: 'abc',
    acquiredAt: '2026-05-25T16:00:00.000Z',
    updatedAt: '2026-05-25T16:10:00.000Z',
    lrqId: 'lrq_merged_ama',
    status: 'dispatched',
    terminalOutcome: null,
  }, null, 2)}\n`);
  insertReviewRow(rootDir, { prNumber: 13, prState: 'merged' });

  const snapshot = collectReviewPipelineHealth({
    rootDir,
    now: () => new Date(NOW),
    config: { amaCloserLeaseMaxAgeMs: 20 * 60 * 1000 },
  });

  assert.ok(!findingCodes(snapshot).includes('review:ama_closer_lease_stale'));
  assert.equal(snapshot.amaCloserLeases.stale.length, 0);
  assert.equal(snapshot.amaCloserLeases.ignoredTerminalPrs[0].lrqId, 'lrq_merged_ama');
  assert.equal(snapshot.amaCloserLeases.ignoredTerminalPrs[0].prState, 'merged');
});

test('running reviewer passes older than threshold are reported as zombies', () => {
  const rootDir = tempRoot();
  insertReviewerPass(rootDir, {
    prNumber: 970,
    attemptNumber: 1,
    status: 'running',
    startedAt: '2026-05-25T17:00:00.000Z',
    endedAt: null,
    metadata: { session: 'stuck' },
  });
  insertReviewerPass(rootDir, {
    prNumber: 971,
    attemptNumber: 1,
    status: 'running',
    startedAt: '2026-05-25T17:55:00.000Z',
    endedAt: null,
    metadata: {},
  });

  const snapshot = collectReviewPipelineHealth({
    rootDir,
    now: () => new Date(NOW),
    config: { runningReviewerPassMaxAgeMs: 30 * 60 * 1000 },
  });

  assert.ok(findingCodes(snapshot).includes('review:reviewer_pass_zombie'));
  assert.deepEqual(snapshot.zombieReviewerPasses.rows.map((row) => row.prNumber), [970]);
});

test('round-budget selector detects over-budget and awaiting-rereview final-pass jobs', () => {
  const rootDir = tempRoot();
  writeJob(rootDir, 'in-progress', 'over-budget', {
    jobId: 'over-budget',
    repo: REPO,
    prNumber: 980,
    riskClass: 'low',
    remediationPlan: {
      currentRound: 2,
      rounds: [{ round: 1, state: 'completed' }, { round: 2, state: 'spawned' }],
    },
  });
  writeJob(rootDir, 'in-progress', 'awaiting-final', {
    jobId: 'awaiting-final',
    repo: REPO,
    prNumber: 981,
    riskClass: 'medium',
    status: 'awaiting-rereview',
    remediationPlan: {
      currentRound: 2,
      rounds: [{ round: 1, state: 'completed' }, { round: 2, state: 'completed' }],
    },
  });

  const snapshot = collectReviewPipelineHealth({ rootDir, now: () => new Date(NOW) });

  assert.ok(findingCodes(snapshot).includes('review:round_budget_anomaly'));
  assert.equal(snapshot.roundBudget.anomalies.length, 2);
  assert.ok(snapshot.roundBudget.anomalies.some((row) => row.codes.includes('round-count-exceeds-risk-budget')));
  assert.ok(snapshot.roundBudget.anomalies.some((row) => row.codes.includes('awaiting-rereview-on-budget-exhausted-final-pass')));
});

test('host checks are opt-in and report launchd, dispatch-log, and dag-autowalk anomalies', () => {
  const rootDir = tempRoot();
  const hqRoot = tempRoot();
  const dispatchLog = path.join(hqRoot, 'dispatch', '_daemon', 'daemon.err.log');
  mkdirSync(path.dirname(dispatchLog), { recursive: true });
  writeFileSync(dispatchLog, 'hammer spawn failed: entitlement-auth 403 exit 65\n');
  const dagErr = path.join(hqRoot, 'dag.err.log');
  const dagOut = path.join(hqRoot, 'dag.out.log');
  writeFileSync(dagErr, '');
  writeFileSync(dagOut, 'tick ok\n');
  const execFileSyncImpl = (_bin, argv) => {
    const target = argv.at(-1);
    if (target.includes('adversarial-follow-up')) {
      const error = new Error('not loaded');
      error.stderr = 'Could not find service';
      throw error;
    }
    if (target.includes('dag-autowalk')) return 'last exit code = 65\n';
    return 'state = running\nlast exit code = 0\n';
  };

  const disabled = collectReviewPipelineHealth({ rootDir, hqRoot, now: () => new Date(NOW), execFileSyncImpl });
  assert.ok(!findingCodes(disabled).includes('review:daemon_liveness'));

  const enabled = collectReviewPipelineHealth({
    rootDir,
    hqRoot,
    now: () => new Date(NOW),
    env: {
      USER: 'fixture',
      ADVERSARIAL_REVIEW_PIPELINE_HEALTH_HOST_CHECKS: '1',
      ADVERSARIAL_REVIEW_PIPELINE_HEALTH_DAG_AUTOWALK_ERR_LOG: dagErr,
      ADVERSARIAL_REVIEW_PIPELINE_HEALTH_DAG_AUTOWALK_OUT_LOG: dagOut,
    },
    execFileSyncImpl,
  });

  assert.ok(findingCodes(enabled).includes('review:daemon_liveness'));
  assert.ok(findingCodes(enabled).includes('review:dispatch_spawn_failures'));
  assert.ok(findingCodes(enabled).includes('review:dag_autowalk_launchd_unhealthy'));
  assert.equal(enabled.dispatchSpawnFailures.matches.length, 1);
  assert.equal(enabled.dagAutowalk.lastExitCode, 65);
});

test('system-domain launchd daemon resolves loaded without daemon_liveness finding', () => {
  const rootDir = tempRoot();
  const hqRoot = tempRoot();
  const calls = [];
  const env = {
    USER: 'fixture',
    ADVERSARIAL_REVIEW_PIPELINE_HEALTH_HOST_CHECKS: '1',
    ADVERSARIAL_REVIEW_PIPELINE_HEALTH_WATCHER_LABEL: 'fixture.watcher',
    ADVERSARIAL_REVIEW_PIPELINE_HEALTH_FOLLOW_UP_LABEL: 'fixture.follow-up',
    ADVERSARIAL_REVIEW_PIPELINE_HEALTH_DISPATCH_DAEMON_LABEL: 'fixture.dispatch',
    ADVERSARIAL_REVIEW_PIPELINE_HEALTH_DAG_AUTOWALK_LABEL: 'fixture.dag',
  };
  const execFileSyncImpl = (bin, argv) => {
    calls.push([bin, ...argv]);
    const target = argv.at(-1);
    if (target.endsWith('/fixture.follow-up') && target.startsWith('gui/')) {
      throw launchctlPrintError({
        stderr: [
          'Bad request.',
          'Could not find service "fixture.follow-up" in domain for uid',
        ].join('\n'),
      });
    }
    if (target === 'system/fixture.follow-up') return 'state = running\n';
    return 'state = running\nlast exit code = 0\n';
  };

  const snapshot = collectReviewPipelineHealth({
    rootDir,
    hqRoot,
    now: () => new Date(NOW),
    env,
    config: { launchdTransientRetryDelaysMs: [] },
    execFileSyncImpl,
  });

  assert.ok(!findingCodes(snapshot).includes('review:daemon_liveness'));
  const followUp = snapshot.launchd.services.find((service) => service.name === 'adversarial-follow-up');
  assert.equal(followUp.loaded, true);
  assert.equal(followUp.domain, 'system');
  assert.ok(calls.some((call) => call.join(' ') === 'sudo -n launchctl print system/fixture.follow-up'));
  assert.equal(calls.filter((call) => call.at(-1).endsWith('/fixture.follow-up')).length, 2);
});

test('gui-domain launchd daemon resolves loaded without system fallback', () => {
  const rootDir = tempRoot();
  const hqRoot = tempRoot();
  const calls = [];
  const execFileSyncImpl = (bin, argv) => {
    calls.push([bin, ...argv]);
    return 'state = running\nlast exit code = 0\n';
  };

  const snapshot = collectReviewPipelineHealth({
    rootDir,
    hqRoot,
    now: () => new Date(NOW),
    env: { USER: 'fixture', ADVERSARIAL_REVIEW_PIPELINE_HEALTH_HOST_CHECKS: '1' },
    execFileSyncImpl,
  });

  assert.ok(!findingCodes(snapshot).includes('review:daemon_liveness'));
  assert.ok(snapshot.launchd.services.every((service) => service.loaded));
  assert.equal(calls.some((call) => call[0] === 'sudo'), false);
});

test('daemon absent from both gui and system domains fires daemon_liveness', () => {
  const rootDir = tempRoot();
  const hqRoot = tempRoot();
  const calls = [];
  const env = {
    USER: 'fixture',
    ADVERSARIAL_REVIEW_PIPELINE_HEALTH_HOST_CHECKS: '1',
    ADVERSARIAL_REVIEW_PIPELINE_HEALTH_WATCHER_LABEL: 'fixture.watcher',
    ADVERSARIAL_REVIEW_PIPELINE_HEALTH_FOLLOW_UP_LABEL: 'fixture.follow-up',
    ADVERSARIAL_REVIEW_PIPELINE_HEALTH_DISPATCH_DAEMON_LABEL: 'fixture.dispatch',
    ADVERSARIAL_REVIEW_PIPELINE_HEALTH_DAG_AUTOWALK_LABEL: 'fixture.dag',
  };
  const execFileSyncImpl = (bin, argv) => {
    calls.push([bin, ...argv]);
    const target = argv.at(-1);
    if (target.endsWith('/fixture.follow-up')) {
      throw launchctlPrintError({ stderr: 'Could not find service "fixture.follow-up"\n' });
    }
    return 'state = running\nlast exit code = 0\n';
  };

  const snapshot = collectReviewPipelineHealth({
    rootDir,
    hqRoot,
    now: () => new Date(NOW),
    env,
    config: { launchdTransientRetryDelaysMs: [] },
    execFileSyncImpl,
  });

  assert.ok(findingCodes(snapshot).includes('review:daemon_liveness'));
  const followUp = snapshot.launchd.services.find((service) => service.name === 'adversarial-follow-up');
  assert.equal(followUp.loaded, false);
  assert.equal(followUp.error, 'launchctl-print-missing-service');
  assert.equal(calls.filter((call) => call.at(-1).endsWith('/fixture.follow-up')).length, 2);
});

test('system fallback uses sudo non-interactively and reports sudo privilege failure distinctly', () => {
  const rootDir = tempRoot();
  const hqRoot = tempRoot();
  const calls = [];
  const env = {
    USER: 'fixture',
    ADVERSARIAL_REVIEW_PIPELINE_HEALTH_HOST_CHECKS: '1',
    ADVERSARIAL_REVIEW_PIPELINE_HEALTH_FOLLOW_UP_LABEL: 'fixture.follow-up',
  };
  const execFileSyncImpl = (bin, argv) => {
    calls.push([bin, ...argv]);
    const target = argv.at(-1);
    if (target.endsWith('/fixture.follow-up') && target.startsWith('gui/')) {
      throw launchctlPrintError({ stderr: 'Could not find service "fixture.follow-up"\n' });
    }
    if (target === 'system/fixture.follow-up') {
      throw launchctlPrintError({ stderr: 'sudo: a password is required\n' });
    }
    return 'state = running\nlast exit code = 0\n';
  };

  const snapshot = collectReviewPipelineHealth({
    rootDir,
    hqRoot,
    now: () => new Date(NOW),
    env,
    config: { launchdTransientRetryDelaysMs: [] },
    execFileSyncImpl,
  });

  const followUp = snapshot.launchd.services.find((service) => service.name === 'adversarial-follow-up');
  assert.equal(calls.some((call) => call.join(' ') === 'sudo -n launchctl print system/fixture.follow-up'), true);
  assert.equal(followUp.loaded, null);
  assert.equal(followUp.probeFailure.kind, 'sudo-privilege');
  assert.equal(followUp.probeFailure.domain, 'system');
  assert.ok(!findingCodes(snapshot).includes('review:daemon_liveness'));
  assert.ok(findingCodes(snapshot).includes('review:daemon_probe_failure'));
});

test('dag-autowalk probe failure reports probe failure instead of unhealthy', () => {
  const rootDir = tempRoot();
  const hqRoot = tempRoot();
  const dagErr = path.join(hqRoot, 'dag.err.log');
  const dagOut = path.join(hqRoot, 'dag.out.log');
  mkdirSync(path.dirname(dagErr), { recursive: true });
  writeFileSync(dagErr, '');
  writeFileSync(dagOut, 'tick ok\n');
  const env = {
    USER: 'fixture',
    ADVERSARIAL_REVIEW_PIPELINE_HEALTH_HOST_CHECKS: '1',
    ADVERSARIAL_REVIEW_PIPELINE_HEALTH_DAG_AUTOWALK_LABEL: 'fixture.dag',
    ADVERSARIAL_REVIEW_PIPELINE_HEALTH_DAG_AUTOWALK_ERR_LOG: dagErr,
    ADVERSARIAL_REVIEW_PIPELINE_HEALTH_DAG_AUTOWALK_OUT_LOG: dagOut,
  };
  const execFileSyncImpl = (_bin, argv) => {
    const target = argv.at(-1);
    if (target.endsWith('/fixture.dag') && target.startsWith('gui/')) {
      throw launchctlPrintError({ stderr: 'Could not find service "fixture.dag"\n' });
    }
    if (target === 'system/fixture.dag') {
      throw launchctlPrintError({ stderr: 'sudo: a password is required\n' });
    }
    return 'state = running\nlast exit code = 0\n';
  };

  const snapshot = collectReviewPipelineHealth({
    rootDir,
    hqRoot,
    now: () => new Date(NOW),
    env,
    config: { launchdTransientRetryDelaysMs: [] },
    execFileSyncImpl,
  });

  assert.equal(snapshot.dagAutowalk.loaded, null);
  assert.equal(snapshot.dagAutowalk.probeFailure.kind, 'sudo-privilege');
  assert.ok(findingCodes(snapshot).includes('review:daemon_probe_failure'));
  assert.ok(!findingCodes(snapshot).includes('review:dag_autowalk_launchd_unhealthy'));
});

test('transient system-domain launchctl print failure is retried before reporting liveness', () => {
  const rootDir = tempRoot();
  const hqRoot = tempRoot();
  const calls = [];
  let followUpSystemAttempts = 0;
  const env = {
    USER: 'fixture',
    ADVERSARIAL_REVIEW_PIPELINE_HEALTH_HOST_CHECKS: '1',
    ADVERSARIAL_REVIEW_PIPELINE_HEALTH_FOLLOW_UP_LABEL: 'fixture.follow-up',
  };
  const execFileSyncImpl = (bin, argv) => {
    calls.push([bin, ...argv]);
    const target = argv.at(-1);
    if (target.endsWith('/fixture.follow-up') && target.startsWith('gui/')) {
      throw launchctlPrintError({ stderr: 'Could not find service "fixture.follow-up"\n' });
    }
    if (target === 'system/fixture.follow-up') {
      followUpSystemAttempts += 1;
      if (followUpSystemAttempts === 1) {
        throw launchctlPrintError({ stderr: 'Bootstrap failed: 5: Input/output error\n' });
      }
    }
    return 'state = running\nlast exit code = 0\n';
  };

  const snapshot = collectReviewPipelineHealth({
    rootDir,
    hqRoot,
    now: () => new Date(NOW),
    env,
    config: { launchdTransientRetryDelaysMs: [0] },
    execFileSyncImpl,
  });

  const followUp = snapshot.launchd.services.find((service) => service.name === 'adversarial-follow-up');
  assert.equal(followUp.loaded, true);
  assert.equal(followUp.domain, 'system');
  assert.equal(followUpSystemAttempts, 2);
  assert.equal(calls.filter((call) => call.at(-1).endsWith('/fixture.follow-up')).length, 4);
  assert.ok(!findingCodes(snapshot).includes('review:daemon_liveness'));
});

test('transient gui launchctl print failure is retried without system fallback or missing result', () => {
  const rootDir = tempRoot();
  const hqRoot = tempRoot();
  const calls = [];
  let followUpGuiAttempts = 0;
  const env = {
    USER: 'fixture',
    ADVERSARIAL_REVIEW_PIPELINE_HEALTH_HOST_CHECKS: '1',
    ADVERSARIAL_REVIEW_PIPELINE_HEALTH_FOLLOW_UP_LABEL: 'fixture.follow-up',
  };
  const execFileSyncImpl = (bin, argv) => {
    calls.push([bin, ...argv]);
    const target = argv.at(-1);
    if (target.endsWith('/fixture.follow-up') && target.startsWith('gui/')) {
      followUpGuiAttempts += 1;
      if (followUpGuiAttempts === 1) {
        throw launchctlPrintError({ stderr: 'Bootstrap failed: 5: Input/output error\n' });
      }
    }
    return 'state = running\nlast exit code = 0\n';
  };

  const snapshot = collectReviewPipelineHealth({
    rootDir,
    hqRoot,
    now: () => new Date(NOW),
    env,
    config: { launchdTransientRetryDelaysMs: [0] },
    execFileSyncImpl,
  });

  const followUp = snapshot.launchd.services.find((service) => service.name === 'adversarial-follow-up');
  assert.equal(followUp.loaded, true);
  assert.equal(followUp.domain, 'gui');
  assert.equal(followUpGuiAttempts, 2);
  assert.equal(calls.some((call) => call[0] === 'sudo'), false);
  assert.ok(!findingCodes(snapshot).includes('review:daemon_liveness'));
});

test('transient system-domain retry exhaustion remains observable', () => {
  const rootDir = tempRoot();
  const hqRoot = tempRoot();
  const calls = [];
  const env = {
    USER: 'fixture',
    ADVERSARIAL_REVIEW_PIPELINE_HEALTH_HOST_CHECKS: '1',
    ADVERSARIAL_REVIEW_PIPELINE_HEALTH_FOLLOW_UP_LABEL: 'fixture.follow-up',
  };
  const execFileSyncImpl = (bin, argv) => {
    calls.push([bin, ...argv]);
    const target = argv.at(-1);
    if (target.endsWith('/fixture.follow-up') && target.startsWith('gui/')) {
      throw launchctlPrintError({ stderr: 'Could not find service "fixture.follow-up"\n' });
    }
    if (target === 'system/fixture.follow-up') {
      throw launchctlPrintError({ stderr: 'Resource temporarily unavailable\n' });
    }
    return 'state = running\nlast exit code = 0\n';
  };

  const snapshot = collectReviewPipelineHealth({
    rootDir,
    hqRoot,
    now: () => new Date(NOW),
    env,
    config: { launchdTransientRetryDelaysMs: [0, 0] },
    execFileSyncImpl,
  });

  const followUp = snapshot.launchd.services.find((service) => service.name === 'adversarial-follow-up');
  assert.equal(followUp.loaded, null);
  assert.equal(followUp.domain, 'system');
  assert.equal(followUp.error, 'launchctl-print-transient-exhausted');
  assert.equal(followUp.probeFailure.kind, 'transient-exhausted');
  assert.equal(followUp.probeFailure.domain, 'system');
  assert.equal(followUp.probeFailure.attempts, 6);
  assert.equal(calls.filter((call) => call.at(-1).endsWith('/fixture.follow-up')).length, 6);
  assert.ok(!findingCodes(snapshot).includes('review:daemon_liveness'));
  assert.ok(findingCodes(snapshot).includes('review:daemon_probe_failure'));
});

test('transient retry exhaustion remains observable and does not fall through to system or missing', () => {
  const rootDir = tempRoot();
  const hqRoot = tempRoot();
  const calls = [];
  const env = {
    USER: 'fixture',
    ADVERSARIAL_REVIEW_PIPELINE_HEALTH_HOST_CHECKS: '1',
    ADVERSARIAL_REVIEW_PIPELINE_HEALTH_FOLLOW_UP_LABEL: 'fixture.follow-up',
  };
  const execFileSyncImpl = (bin, argv) => {
    calls.push([bin, ...argv]);
    const target = argv.at(-1);
    if (target.endsWith('/fixture.follow-up') && target.startsWith('gui/')) {
      throw launchctlPrintError({ stderr: 'Resource temporarily unavailable\n' });
    }
    return 'state = running\nlast exit code = 0\n';
  };

  const snapshot = collectReviewPipelineHealth({
    rootDir,
    hqRoot,
    now: () => new Date(NOW),
    env,
    config: { launchdTransientRetryDelaysMs: [0, 0] },
    execFileSyncImpl,
  });

  const followUp = snapshot.launchd.services.find((service) => service.name === 'adversarial-follow-up');
  assert.equal(followUp.loaded, null);
  assert.equal(followUp.error, 'launchctl-print-transient-exhausted');
  assert.equal(followUp.probeFailure.kind, 'transient-exhausted');
  assert.equal(followUp.probeFailure.attempts, 3);
  assert.equal(calls.filter((call) => call.at(-1).endsWith('/fixture.follow-up')).length, 3);
  assert.equal(calls.some((call) => call[0] === 'sudo'), false);
  assert.ok(!findingCodes(snapshot).includes('review:daemon_liveness'));
  assert.ok(findingCodes(snapshot).includes('review:daemon_probe_failure'));
});

test('dispatch spawn failure log lines are suppressed when stale or self-recovered', () => {
  const rootDir = tempRoot();
  const hqRoot = tempRoot();
  const dispatchLog = path.join(hqRoot, 'dispatch', '_daemon', 'daemon.err.log');
  mkdirSync(path.dirname(dispatchLog), { recursive: true });
  writeFileSync(
    dispatchLog,
    [
      'hammer spawn failed: entitlement-auth 403 exit 65',
      'hammer spawned successfully after retry',
      '',
    ].join('\n'),
  );
  const execFileSyncImpl = () => 'state = running\nlast exit code = 0\n';

  const recovered = collectReviewPipelineHealth({
    rootDir,
    hqRoot,
    now: () => new Date(NOW),
    env: { USER: 'fixture', ADVERSARIAL_REVIEW_PIPELINE_HEALTH_HOST_CHECKS: '1' },
    execFileSyncImpl,
  });
  assert.ok(!findingCodes(recovered).includes('review:dispatch_spawn_failures'));
  assert.equal(recovered.dispatchSpawnFailures.successAfterLastFailure, true);

  const oldNow = new Date(Date.parse(NOW) + 2 * 60 * 60 * 1000).toISOString();
  writeFileSync(dispatchLog, 'hammer spawn failed: entitlement-auth 403 exit 65\n');
  const oldMtime = new Date(Date.parse(NOW));
  utimesSync(dispatchLog, oldMtime, oldMtime);
  const stale = collectReviewPipelineHealth({
    rootDir,
    hqRoot,
    now: () => new Date(oldNow),
    env: { USER: 'fixture', ADVERSARIAL_REVIEW_PIPELINE_HEALTH_HOST_CHECKS: '1' },
    config: { dispatchSpawnFailureWindowMs: 1 },
    execFileSyncImpl,
  });
  assert.ok(!findingCodes(stale).includes('review:dispatch_spawn_failures'));
  assert.equal(stale.dispatchSpawnFailures.matches.length, 0);
});

test('dispatch spawn classifier ignores op cache backoff and successful daemon spawns', () => {
  const rootDir = tempRoot();
  const hqRoot = tempRoot();
  const dispatchLog = path.join(hqRoot, 'dispatch', '_daemon', 'daemon.err.log');
  mkdirSync(path.dirname(dispatchLog), { recursive: true });
  writeFileSync(
    dispatchLog,
    [
      '2026-07-29 16:20:21,403 WARNING node_id=laceyent cwp_dispatch.op_adapter op_owner_cache_stale_served age_seconds=348218 reason=rate_limit_backoff',
      '2026-07-29 16:36:45,764 INFO node_id=laceyent cwp.daemon spawned lrq_ba30778a-1f5b-4e6a-a127-1525d4aa4437 pid=62951 worker_class=hammer worker_id=hammer-ama-pr-4406',
      '2026-07-29 16:46:19,403 INFO node_id=laceyent cwp.daemon spawned lrq_3ba418e0-0fc2-4460-a36a-d30aa060ec01 pid=26261 worker_class=codex worker_id=codex-sbh-03-36e93ca1',
      '',
    ].join('\n'),
  );
  const execFileSyncImpl = () => 'state = running\nlast exit code = 0\n';

  const healthy = collectReviewPipelineHealth({
    rootDir,
    hqRoot,
    now: () => new Date(NOW),
    env: { USER: 'fixture', ADVERSARIAL_REVIEW_PIPELINE_HEALTH_HOST_CHECKS: '1' },
    execFileSyncImpl,
  });

  assert.ok(!findingCodes(healthy).includes('review:dispatch_spawn_failures'));
  assert.equal(healthy.dispatchSpawnFailures.matches.length, 0);
});

test('dispatch spawn classifier catches bounded rate-limit spawn failures', () => {
  const rootDir = tempRoot();
  const hqRoot = tempRoot();
  const dispatchLog = path.join(hqRoot, 'dispatch', '_daemon', 'daemon.err.log');
  mkdirSync(path.dirname(dispatchLog), { recursive: true });
  writeFileSync(
    dispatchLog,
    [
      '2026-07-29 16:31:11,001 ERROR node_id=laceyent worker_class=hammer failed to admit: secondary rate limit from GitHub',
      '2026-07-29 16:32:12,001 ERROR node_id=laceyent AWS rate-limit while trying to provision worker_class=closer',
      '',
    ].join('\n'),
  );
  const execFileSyncImpl = () => 'state = running\nlast exit code = 0\n';

  const unhealthy = collectReviewPipelineHealth({
    rootDir,
    hqRoot,
    now: () => new Date(NOW),
    env: { USER: 'fixture', ADVERSARIAL_REVIEW_PIPELINE_HEALTH_HOST_CHECKS: '1' },
    execFileSyncImpl,
  });

  assert.ok(findingCodes(unhealthy).includes('review:dispatch_spawn_failures'));
  assert.equal(unhealthy.dispatchSpawnFailures.matches.length, 2);
});

test('dispatch spawn classifier catches auth failures with monitored worker class first', () => {
  const rootDir = tempRoot();
  const hqRoot = tempRoot();
  const dispatchLog = path.join(hqRoot, 'dispatch', '_daemon', 'daemon.err.log');
  mkdirSync(path.dirname(dispatchLog), { recursive: true });
  writeFileSync(
    dispatchLog,
    [
      '2026-07-29 16:31:11,001 ERROR node_id=laceyent worker_class=hammer failed due to 403',
      '',
    ].join('\n'),
  );
  const execFileSyncImpl = () => 'state = running\nlast exit code = 0\n';

  const unhealthy = collectReviewPipelineHealth({
    rootDir,
    hqRoot,
    now: () => new Date(NOW),
    env: { USER: 'fixture', ADVERSARIAL_REVIEW_PIPELINE_HEALTH_HOST_CHECKS: '1' },
    execFileSyncImpl,
  });

  assert.ok(findingCodes(unhealthy).includes('review:dispatch_spawn_failures'));
  assert.equal(unhealthy.dispatchSpawnFailures.matches.length, 1);
});

test('dispatch spawn classifier catches failure text before monitored worker class', () => {
  const rootDir = tempRoot();
  const hqRoot = tempRoot();
  const dispatchLog = path.join(hqRoot, 'dispatch', '_daemon', 'daemon.err.log');
  mkdirSync(path.dirname(dispatchLog), { recursive: true });
  writeFileSync(
    dispatchLog,
    [
      '2026-07-29 16:31:11,001 ERROR node_id=laceyent failed to spawn hammer: image missing',
      '2026-07-29 16:32:12,001 ERROR node_id=laceyent spawn failed for worker_class=ama',
      '2026-07-29 16:33:13,001 ERROR node_id=laceyent spawn failure: closer',
      '',
    ].join('\n'),
  );
  const execFileSyncImpl = () => 'state = running\nlast exit code = 0\n';

  const unhealthy = collectReviewPipelineHealth({
    rootDir,
    hqRoot,
    now: () => new Date(NOW),
    env: { USER: 'fixture', ADVERSARIAL_REVIEW_PIPELINE_HEALTH_HOST_CHECKS: '1' },
    execFileSyncImpl,
  });

  assert.ok(findingCodes(unhealthy).includes('review:dispatch_spawn_failures'));
  assert.equal(unhealthy.dispatchSpawnFailures.matches.length, 3);
});

test('dispatch spawn classifier does not let unrelated successes recover monitored failures', () => {
  const rootDir = tempRoot();
  const hqRoot = tempRoot();
  const dispatchLog = path.join(hqRoot, 'dispatch', '_daemon', 'daemon.err.log');
  mkdirSync(path.dirname(dispatchLog), { recursive: true });
  writeFileSync(
    dispatchLog,
    [
      '2026-07-29 16:31:11,001 ERROR node_id=laceyent worker_class=hammer failed to spawn: image missing',
      '2026-07-29 16:46:19,403 INFO node_id=laceyent cwp.daemon spawned lrq_3ba418e0-0fc2-4460-a36a-d30aa060ec01 pid=26261 worker_class=codex worker_id=codex-sbh-03-36e93ca1',
      '',
    ].join('\n'),
  );
  const execFileSyncImpl = () => 'state = running\nlast exit code = 0\n';

  const unhealthy = collectReviewPipelineHealth({
    rootDir,
    hqRoot,
    now: () => new Date(NOW),
    env: { USER: 'fixture', ADVERSARIAL_REVIEW_PIPELINE_HEALTH_HOST_CHECKS: '1' },
    execFileSyncImpl,
  });

  assert.ok(findingCodes(unhealthy).includes('review:dispatch_spawn_failures'));
  assert.equal(unhealthy.dispatchSpawnFailures.matches.length, 1);
  assert.equal(unhealthy.dispatchSpawnFailures.successAfterLastFailure, false);
});

test('dispatch spawn classifier does not let worker-id embedded successes recover failures', () => {
  const rootDir = tempRoot();
  const hqRoot = tempRoot();
  const dispatchLog = path.join(hqRoot, 'dispatch', '_daemon', 'daemon.err.log');
  mkdirSync(path.dirname(dispatchLog), { recursive: true });
  writeFileSync(
    dispatchLog,
    [
      '2026-07-29 16:31:11,001 ERROR node_id=laceyent worker_class=hammer failed to spawn: image missing',
      '2026-07-29 16:46:19,403 INFO node_id=laceyent cwp.daemon spawned lrq_3ba418e0-0fc2-4460-a36a-d30aa060ec01 pid=26261 worker_class=codex worker_id=codex-hammer-123',
      '',
    ].join('\n'),
  );
  const execFileSyncImpl = () => 'state = running\nlast exit code = 0\n';

  const unhealthy = collectReviewPipelineHealth({
    rootDir,
    hqRoot,
    now: () => new Date(NOW),
    env: { USER: 'fixture', ADVERSARIAL_REVIEW_PIPELINE_HEALTH_HOST_CHECKS: '1' },
    execFileSyncImpl,
  });

  assert.ok(findingCodes(unhealthy).includes('review:dispatch_spawn_failures'));
  assert.equal(unhealthy.dispatchSpawnFailures.matches.length, 1);
  assert.equal(unhealthy.dispatchSpawnFailures.successAfterLastFailure, false);
});

test('dispatch spawn classifier ignores unmonitored worker spawn failures', () => {
  const rootDir = tempRoot();
  const hqRoot = tempRoot();
  const dispatchLog = path.join(hqRoot, 'dispatch', '_daemon', 'daemon.err.log');
  mkdirSync(path.dirname(dispatchLog), { recursive: true });
  writeFileSync(
    dispatchLog,
    [
      '2026-07-29 16:31:11,001 ERROR node_id=laceyent worker_class=codex failed to spawn: image missing',
      '2026-07-29 16:33:12,001 ERROR node_id=laceyent worker_class=search-indexer spawn failed: local cache unavailable',
      '2026-07-29 16:34:12,001 ERROR node_id=laceyent worker_class=codex failed to admit: secondary rate limit from GitHub',
      '2026-07-29 16:35:12,001 ERROR node_id=laceyent admit failed: secondary rate limit for worker_class=search-indexer',
      '',
    ].join('\n'),
  );
  const execFileSyncImpl = () => 'state = running\nlast exit code = 0\n';

  const healthy = collectReviewPipelineHealth({
    rootDir,
    hqRoot,
    now: () => new Date(NOW),
    env: { USER: 'fixture', ADVERSARIAL_REVIEW_PIPELINE_HEALTH_HOST_CHECKS: '1' },
    execFileSyncImpl,
  });

  assert.ok(!findingCodes(healthy).includes('review:dispatch_spawn_failures'));
  assert.equal(healthy.dispatchSpawnFailures.matches.length, 0);
});

test('dispatch spawn classifier does not match monitored names inside worker ids', () => {
  const rootDir = tempRoot();
  const hqRoot = tempRoot();
  const dispatchLog = path.join(hqRoot, 'dispatch', '_daemon', 'daemon.err.log');
  mkdirSync(path.dirname(dispatchLog), { recursive: true });
  writeFileSync(
    dispatchLog,
    [
      '2026-07-29 16:31:11,001 ERROR node_id=laceyent worker_id=codex-ama-123 failed to spawn: image missing',
      '2026-07-29 16:32:12,001 ERROR node_id=laceyent failed to spawn worker_id=codex-closer-456',
      '',
    ].join('\n'),
  );
  const execFileSyncImpl = () => 'state = running\nlast exit code = 0\n';

  const healthy = collectReviewPipelineHealth({
    rootDir,
    hqRoot,
    now: () => new Date(NOW),
    env: { USER: 'fixture', ADVERSARIAL_REVIEW_PIPELINE_HEALTH_HOST_CHECKS: '1' },
    execFileSyncImpl,
  });

  assert.ok(!findingCodes(healthy).includes('review:dispatch_spawn_failures'));
  assert.equal(healthy.dispatchSpawnFailures.matches.length, 0);
});

test('collector surfaces active provider overload backoffs and quota holds', () => {
  const rootDir = tempRoot();
  const overloadedPr = 960;
  const quotaPr = 961;
  openDb(rootDir).close();

  const cascadeStateDir = path.join(rootDir, 'data', 'cascade-state');
  mkdirSync(cascadeStateDir, { recursive: true });
  writeFileSync(
    path.join(cascadeStateDir, `${encodeURIComponent(REPO)}__${overloadedPr}.json`),
    `${JSON.stringify({
      consecutiveTransientFailures: 2,
      transientFailureBreakdown: { [PROVIDER_OVERLOADED_FAILURE_CLASS]: 2 },
      lastFailureClass: PROVIDER_OVERLOADED_FAILURE_CLASS,
      lastFailureAt: '2026-05-25T17:58:00.000Z',
      nextRetryAfter: '2026-05-25T18:05:00.000Z',
      backoffMinutes: 8,
    }, null, 2)}\n`
  );
  insertReviewRow(rootDir, {
    prNumber: quotaPr,
    reviewStatus: 'failed',
    reviewAttempts: 1,
    lastAttemptedAt: '2026-05-25T17:55:00.000Z',
    failedAt: '2026-05-25T17:55:00.000Z',
    failureMessage: '[quota-exhausted] usage limit; try again at 2026-05-25T18:10:00Z',
  });
  const db = openDb(rootDir);
  try {
    db.prepare('UPDATE reviewed_prs SET quota_reset_at_utc = ? WHERE repo = ? AND pr_number = ?')
      .run('2026-05-25T18:10:00.000Z', REPO, quotaPr);
  } finally {
    db.close();
  }

  const snapshot = collectReviewPipelineHealth({ rootDir, now: () => new Date(NOW) });
  assert.equal(snapshot.reviewerDegradation.active, 2);
  assert.equal(
    snapshot.reviewerDegradation.byClass.find((row) => row.failureClass === PROVIDER_OVERLOADED_FAILURE_CLASS)?.states['transient-backoff'],
    1
  );
  assert.equal(
    snapshot.reviewerDegradation.byClass.find((row) => row.failureClass === QUOTA_EXHAUSTED_FAILURE_CLASS)?.states['quota-hold'],
    1
  );
  assert.ok(findingCodes(snapshot).includes('review:reviewer_degradation_active'));

  const output = renderReviewPipelinePrometheus(snapshot);
  assert.match(
    output,
    /^review_pipeline_reviewer_degradation_active\{failure_class="provider-overloaded",state="transient-backoff"\} 1$/m
  );
  assert.match(
    output,
    /^review_pipeline_reviewer_degradation_active\{failure_class="quota-exhausted",state="quota-hold"\} 1$/m
  );
});

test('reviewer degradation does not activate global outage metrics', () => {
  const rootDir = tempRoot();
  openDb(rootDir).close();

  const cascadeStateDir = path.join(rootDir, 'data', 'cascade-state');
  mkdirSync(cascadeStateDir, { recursive: true });
  writeFileSync(
    path.join(cascadeStateDir, `${encodeURIComponent(REPO)}__779.json`),
    `${JSON.stringify({
      consecutiveTransientFailures: 1,
      transientFailureBreakdown: { [PROVIDER_OVERLOADED_FAILURE_CLASS]: 1 },
      lastFailureClass: PROVIDER_OVERLOADED_FAILURE_CLASS,
      lastFailureAt: '2026-05-25T17:58:00.000Z',
      nextRetryAfter: '2026-05-25T18:05:00.000Z',
      backoffMinutes: 8,
    }, null, 2)}\n`
  );

  const snapshot = collectReviewPipelineHealth({ rootDir, now: () => new Date(NOW) });
  assert.equal(snapshot.reviewerDegradation.active, 1);
  assert.equal(snapshot.outage.active, false);
  assert.equal(snapshot.outage.reason, null);
  assert.equal(snapshot.outage.reviews_paused, false);
  assert.equal(snapshot.outage.attempts_not_charged, 0);

  const output = renderReviewPipelinePrometheus(snapshot);
  assert.match(output, /^review_pipeline_reviewer_degradation_active\{failure_class="provider-overloaded",state="transient-backoff"\} 1$/m);
  assert.match(output, /^review_pipeline_outage_active 0$/m);
  assert.match(output, /^review_pipeline_outage_attempts_not_charged 0$/m);
});

test('malformed transient backoff retry dates are not treated as active degradation', () => {
  const rootDir = tempRoot();
  openDb(rootDir).close();

  const cascadeStateDir = path.join(rootDir, 'data', 'cascade-state');
  mkdirSync(cascadeStateDir, { recursive: true });
  writeFileSync(
    path.join(cascadeStateDir, `${encodeURIComponent(REPO)}__777.json`),
    `${JSON.stringify({
      consecutiveTransientFailures: 2,
      lastFailureClass: PROVIDER_OVERLOADED_FAILURE_CLASS,
      lastFailureAt: '2026-05-25T17:58:00.000Z',
      nextRetryAfter: 'not-a-date',
    }, null, 2)}\n`
  );

  const snapshot = collectReviewPipelineHealth({ rootDir, now: () => new Date(NOW) });
  assert.equal(snapshot.reviewerDegradation.active, 0);
  assert.ok(!findingCodes(snapshot).includes('review:reviewer_degradation_active'));
});

test('health output surfaces outage pause and attempts not charged', () => {
  const rootDir = tempRoot();
  insertReviewRow(rootDir, {
    prNumber: 778,
    reviewStatus: 'pending-upstream',
    reviewAttempts: 0,
    lastAttemptedAt: '2026-05-25T17:55:00.000Z',
    failedAt: '2026-05-25T17:55:00.000Z',
    failureMessage: '[outage-transient:quota-outage] [quota-exhausted] usage limit',
  });

  const snapshot = collectReviewPipelineHealth({ rootDir, now: () => new Date(NOW) });
  assert.equal(snapshot.outage.active, true);
  assert.equal(snapshot.outage.reason, 'quota-outage');
  assert.equal(snapshot.outage.reviews_paused, true);
  assert.equal(snapshot.outage.attempts_not_charged, 1);
  assert.deepEqual(snapshot.outage.reasons, [{ reason: 'quota-outage', count: 1 }]);

  const output = renderReviewPipelinePrometheus(snapshot);
  assert.match(output, /^review_pipeline_outage_active 1$/m);
  assert.match(output, /^review_pipeline_outage_attempts_not_charged 1$/m);
});

test('Grafana dashboard JSON references only exported review pipeline metric names', () => {
  const dashboard = JSON.parse(readFileSync('observability/grafana/review-pipeline-health.json', 'utf8'));
  const metricNames = new Set(REVIEW_PIPELINE_HEALTH_METRICS);
  const expressions = dashboard.panels.flatMap((panel) => (
    Array.isArray(panel.targets) ? panel.targets.map((target) => target.expr || '') : []
  ));
  const referenced = new Set();
  for (const expr of expressions) {
    for (const match of expr.matchAll(/\breview_pipeline_[a-z_]+(?:_total|_seconds|_jobs|_depth|_active)?\b/g)) {
      referenced.add(match[0]);
    }
  }
  assert.ok(referenced.size > 0);
  assert.deepEqual(
    Array.from(referenced).filter((name) => !metricNames.has(name)),
    []
  );
});

test('documented Sentinel findings match emitted finding definition codes', () => {
  const doc = readFileSync('docs/review-pipeline-health.md', 'utf8');
  const documented = Array.from(doc.matchAll(/`(review:[a-z_]+)`/g), (match) => match[1]).sort();
  const defined = REVIEW_PIPELINE_HEALTH_FINDING_DEFINITIONS.map((definition) => definition.code).sort();
  assert.deepEqual(documented, defined);
  for (const definition of REVIEW_PIPELINE_HEALTH_FINDING_DEFINITIONS) {
    assert.ok(
      definition.defaultThreshold === null || typeof definition.defaultThreshold === 'number',
      `${definition.code} defaultThreshold must stay null or numeric`
    );
  }
});

test('failure-rate/degradation finding definitions match the spec contract and dashboard panels', () => {
  assert.ok(
    REVIEW_PIPELINE_HEALTH_FINDING_DEFINITIONS.some((definition) => definition.code === 'review:unknown_failure_rate_high')
  );
  assert.ok(
    REVIEW_PIPELINE_HEALTH_FINDING_DEFINITIONS.some((definition) => definition.code === 'review:reviewer_degradation_active')
  );

  const dashboard = JSON.parse(readFileSync('observability/grafana/review-pipeline-health.json', 'utf8'));
  const titles = dashboard.panels.map((panel) => panel.title);
  assert.ok(titles.includes('Unknown Failure Rate'));
  assert.ok(titles.includes('Unknown Failure Distinct PRs'));
  assert.ok(titles.includes('Reviewer Degradation Holds'));
});

test('Prometheus renderer emits every dashboard metric at least once', () => {
  const rootDir = tempRoot();
  insertReviewRow(rootDir, { prNumber: 1, reviewStatus: 'pending' });
  const output = renderReviewPipelinePrometheus(
    collectReviewPipelineHealth({ rootDir, now: () => new Date(NOW) })
  );
  for (const metric of REVIEW_PIPELINE_HEALTH_METRICS) {
    assert.match(output, new RegExp(`^${metric}(?:\\{|\\s)`, 'm'));
  }
});

test('Prometheus renderer declares snapshot total metrics as gauges', () => {
  const rootDir = tempRoot();
  insertReviewRow(rootDir, { prNumber: 1, reviewStatus: 'pending' });
  const output = renderReviewPipelinePrometheus(
    collectReviewPipelineHealth({ rootDir, now: () => new Date(NOW) })
  );
  assert.match(output, /^# TYPE review_pipeline_reviewer_attempts_total gauge$/m);
  assert.match(output, /^# TYPE review_pipeline_merge_outcomes_total gauge$/m);
});

test('CLI parser rejects missing option values', () => {
  assert.throws(() => parseArgs(['--root']), /--root requires a directory/);
  assert.throws(() => parseArgs(['--now']), /--now requires an ISO timestamp/);
});

test('launchd liveness probe falls back to system domain on verified missing-service', () => {
  const rootDir = tempRoot();
  const calls = [];
  const execFileSyncImpl = (cmd, args) => {
    calls.push({ cmd, args: [...args] });
    const target = args.at(-1);
    
    if (target.includes('cwp-dispatch-daemon')) {
      const isGui = args.some(a => typeof a === 'string' && a.startsWith('gui/'));
      if (isGui) {
        const error = new Error('not loaded');
        error.stderr = 'Bad request.\nCould not find service'; 
        throw error;
      }
      return 'state = running\n';
    }
    
    if (target.includes('adversarial-watcher')) {
      const isGui = args.some(a => typeof a === 'string' && a.startsWith('gui/'));
      if (isGui) return 'state = running\n';
      throw new Error('should not fallback to system if gui succeeds');
    }
    
    if (target.includes('adversarial-follow-up')) {
      const error = new Error('not loaded');
      error.stderr = 'Could not find service';
      throw error;
    }

    if (target.includes('dag-autowalk')) return 'last exit code = 0\n';
    return 'state = running\nlast exit code = 0\n';
  };

  const snapshot = collectReviewPipelineHealth({
    rootDir,
    now: () => new Date(NOW),
    env: { USER: 'fixture', ADVERSARIAL_REVIEW_PIPELINE_HEALTH_HOST_CHECKS: '1' },
    execFileSyncImpl,
  });

  const findings = findingCodes(snapshot);
  
  assert.ok(findings.includes('review:daemon_liveness'));
  const livenessFinding = snapshot.findings.find(f => f.code === 'review:daemon_liveness');
  assert.ok(livenessFinding.subject.includes('1 pipeline daemon launchd service(s) are not loaded'));
  assert.ok(livenessFinding.message.includes('adversarial-follow-up'));
  assert.ok(!livenessFinding.message.includes('cwp-dispatch-daemon'));
  assert.ok(!livenessFinding.message.includes('adversarial-watcher'));

  const dispatchCalls = calls.filter(c => c.args.some(a => typeof a === 'string' && a.includes('cwp-dispatch-daemon')));
  assert.equal(dispatchCalls.length, 2);
  assert.equal(dispatchCalls[0].cmd, 'launchctl');
  assert.ok(dispatchCalls[0].args.some(a => typeof a === 'string' && a.startsWith('gui/')));
  assert.equal(dispatchCalls[1].cmd, 'sudo');
  assert.ok(dispatchCalls[1].args.includes('-n'));
  assert.ok(dispatchCalls[1].args.some(a => typeof a === 'string' && a.startsWith('system/')));
  
  const watcherCalls = calls.filter(c => c.args.some(a => typeof a === 'string' && a.includes('adversarial-watcher')));
  assert.equal(watcherCalls.length, 1);
  assert.equal(watcherCalls[0].cmd, 'launchctl');
});

test('launchd liveness probe handles sudo privilege failure distinctly', () => {
  const rootDir = tempRoot();
  const execFileSyncImpl = (cmd, args) => {
    const target = args.at(-1);
    if (target.includes('dag-autowalk')) return 'last exit code = 0\n';
    const isGui = args.some(a => typeof a === 'string' && a.startsWith('gui/'));
    if (isGui) {
      const error = new Error('not loaded');
      error.stderr = 'Could not find service';
      throw error;
    }
    const error = new Error('sudo failed');
    error.stderr = 'sudo: a password is required';
    throw error;
  };

  const snapshot = collectReviewPipelineHealth({
    rootDir,
    now: () => new Date(NOW),
    env: { USER: 'fixture', ADVERSARIAL_REVIEW_PIPELINE_HEALTH_HOST_CHECKS: '1' },
    execFileSyncImpl,
  });

  const downServices = snapshot.launchd.services.filter(s => s.loaded !== true);
  assert.equal(downServices.length, 3);
  for (const s of downServices) {
    assert.equal(s.error, 'sudo-privilege-denied');
  }
});

test('launchd liveness probe retries transient gui-domain errors and escalates on exhaustion', () => {
  const rootDir = tempRoot();
  let dispatchAttempts = 0;
  const sleeps = [];
  const execFileSyncImpl = (cmd, args) => {
    const target = args.at(-1);
    if (target.includes('dag-autowalk')) return 'last exit code = 0\n';
    
    if (target.includes('cwp-dispatch-daemon')) {
      dispatchAttempts++;
      const error = new Error('I/O error');
      error.stderr = 'Bootstrap failed: 5: Input/output error';
      throw error;
    }
    
    return 'state = running\n';
  };

  const snapshot = collectReviewPipelineHealth({
    rootDir,
    now: () => new Date(NOW),
    env: { USER: 'fixture', ADVERSARIAL_REVIEW_PIPELINE_HEALTH_HOST_CHECKS: '1' },
    execFileSyncImpl,
    sleepSyncImpl: (ms) => sleeps.push(ms),
  });

  assert.equal(dispatchAttempts, 3);
  assert.deepEqual(sleeps, [50, 150]);
  const dispatchService = snapshot.launchd.services.find(s => s.name === 'cwp-dispatch-daemon');
  assert.equal(dispatchService.loaded, null);
  assert.equal(dispatchService.error, 'launchctl-print-transient-exhausted');
  assert.equal(dispatchService.probeFailure.kind, 'transient-exhausted');
  
  assert.ok(findingCodes(snapshot).includes('review:daemon_probe_failure'));
  assert.ok(!findingCodes(snapshot).includes('review:daemon_liveness'));
});

test('launchd liveness probe preserves stderr diagnostics when stdout is present', () => {
  const rootDir = tempRoot();
  let sawSystemFallback = false;
  const execFileSyncImpl = (cmd, args) => {
    const target = args.at(-1);
    if (target.includes('cwp-dispatch-daemon') && cmd === 'launchctl') {
      const error = new Error('not loaded');
      error.stdout = 'partial diagnostic on stdout\n';
      error.stderr = 'Could not find service "adversarial-timeout-service"';
      throw error;
    }
    if (target.includes('cwp-dispatch-daemon') && cmd === 'sudo') {
      sawSystemFallback = true;
      return 'state = running\n';
    }
    return 'state = running\n';
  };

  const snapshot = collectReviewPipelineHealth({
    rootDir,
    now: () => new Date(NOW),
    env: { USER: 'fixture', ADVERSARIAL_REVIEW_PIPELINE_HEALTH_HOST_CHECKS: '1' },
    execFileSyncImpl,
    sleepSyncImpl: () => {
      throw new Error('should not sleep for missing-service fallback');
    },
  });

  const dispatchService = snapshot.launchd.services.find(s => s.name === 'cwp-dispatch-daemon');
  assert.equal(sawSystemFallback, true);
  assert.equal(dispatchService.loaded, true);
  assert.equal(dispatchService.raw, 'state = running\n');
});
