import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
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
import { parseArgs } from '../src/review-pipeline-health-cli.mjs';
import { ensureReviewStateSchema, openReviewStateDb } from '../src/review-state.mjs';

const NOW = '2026-05-25T18:00:00.000Z';
const REPO = 'laceyenterprises/adversarial-review';

function tempRoot() {
  return mkdtempSync(path.join(tmpdir(), 'review-pipeline-health-'));
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

test('unknown failure-rate finding definition code matches the spec contract and dashboard includes the unknown panels', () => {
  assert.ok(
    REVIEW_PIPELINE_HEALTH_FINDING_DEFINITIONS.some((definition) => definition.code === 'review:unknown_failure_rate_high')
  );

  const dashboard = JSON.parse(readFileSync('observability/grafana/review-pipeline-health.json', 'utf8'));
  const titles = dashboard.panels.map((panel) => panel.title);
  assert.ok(titles.includes('Unknown Failure Rate'));
  assert.ok(titles.includes('Unknown Failure Distinct PRs'));
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
