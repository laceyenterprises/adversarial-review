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
