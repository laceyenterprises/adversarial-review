import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { writePrTerminalReconcileState } from '../src/pr-terminal-reconcile.mjs';
import {
  chmodSync,
  existsSync,
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
  buildRereviewCiRegressionReason,
} from '../src/reviewer-ci-admission.mjs';
import {
  REVIEW_PIPELINE_HEALTH_FINDING_DEFINITIONS,
  REVIEW_PIPELINE_HEALTH_METRICS,
  collectReviewPipelineHealth,
  renderReviewPipelinePrometheus,
  summarizeRoundBudgetAnomalies,
  resolveReviewPipelineHealthConfig,
  stoppedJobIsCiRegressionStopped,
} from '../src/review-pipeline-health.mjs';
import { PROVIDER_OVERLOADED_FAILURE_CLASS } from '../src/adapters/reviewer-runtime/cli-direct/classification.mjs';
import { QUOTA_EXHAUSTED_FAILURE_CLASS } from '../src/quota-exhaustion.mjs';
import { parseArgs } from '../src/review-pipeline-health-cli.mjs';
import { ensureReviewStateSchema, openReviewStateDb } from '../src/review-state.mjs';
import { REREVIEW_CI_BLOCKED_STATUS } from '../src/review-statuses.mjs';
import { DEFAULT_RUNNING_PASS_TIMEOUT_SECONDS } from '../src/reviewer-pass-reaper.mjs';
import { ensureTtmTrackerSchema } from '../src/ttm-tracker.mjs';

const NOW = '2026-05-25T18:00:00.000Z';
const REPO = 'laceyenterprises/adversarial-review';
const CI_REGRESSION_GATE = {
  failedChecks: [
    { name: 'fast-python-guards', state: 'FAILURE' },
    { name: 'repo-guards', state: 'CANCELLED' },
    { name: 'release-freeze-gate', state: 'CANCELLED' },
  ],
};

function producerShapedCiRegressionStopReason({
  repo = REPO,
  prNumber = 6838,
  currentRound = 3,
  maxRounds = 3,
} = {}) {
  return `Reached max remediation rounds (${currentRound}/${maxRounds}). ${buildRereviewCiRegressionReason({
    repo,
    prNumber,
    ciGate: CI_REGRESSION_GATE,
  })}`;
}

function tempRoot() {
  return mkdtempSync(path.join(tmpdir(), 'review-pipeline-health-'));
}

function launchctlPrintError({ message = 'launchctl print failed', stdout = '', stderr = '' } = {}) {
  const error = new Error(message);
  error.stdout = stdout;
  error.stderr = stderr;
  return error;
}

test('pipeline Sentinel findings are diagnostics, never pages', () => {
  assert.ok(REVIEW_PIPELINE_HEALTH_FINDING_DEFINITIONS.length > 0);
  assert.ok(
    REVIEW_PIPELINE_HEALTH_FINDING_DEFINITIONS.every((finding) => finding.tier === 'ticket')
  );
});

function openDb(rootDir) {
  const db = openReviewStateDb(rootDir);
  ensureReviewStateSchema(db);
  return db;
}

function allowNullReviewerPassMetadata(rootDir) {
  const db = openDb(rootDir);
  try {
    const schema = db.prepare(
      `SELECT sql
         FROM sqlite_master
        WHERE type = 'table'
          AND name = 'reviewer_passes'`
    ).get()?.sql;
    assert.ok(schema);
    const nullableSchema = schema.replace(
      /metadata_json\s+TEXT\s+NOT NULL\s+DEFAULT\s+'\{\}'/,
      `metadata_json        TEXT DEFAULT '{}'`,
    );
    assert.notEqual(nullableSchema, schema);
    const columns = db.prepare('PRAGMA table_info(reviewer_passes)').all().map((column) => column.name);
    const quotedColumns = columns.map((column) => `"${column.replaceAll('"', '""')}"`).join(', ');
    db.exec('BEGIN');
    try {
      db.exec('ALTER TABLE reviewer_passes RENAME TO reviewer_passes_notnull');
      db.exec(nullableSchema);
      db.exec(`INSERT INTO reviewer_passes (${quotedColumns}) SELECT ${quotedColumns} FROM reviewer_passes_notnull`);
      db.exec('DROP TABLE reviewer_passes_notnull');
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  } finally {
    db.close();
  }
}

function insertReviewRow(rootDir, overrides = {}) {
  const db = openDb(rootDir);
  try {
    db.prepare(
      `INSERT INTO reviewed_prs
         (repo, pr_number, reviewed_at, reviewer, pr_state, review_status,
          review_attempts, last_attempted_at, rereview_requested_at, posted_at,
          failed_at, failure_message, reviewer_head_sha)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      overrides.repo || REPO,
      overrides.prNumber || 946,
      overrides.reviewedAt || '2026-05-25T17:00:00.000Z',
      overrides.reviewer || 'claude',
      overrides.prState || 'open',
      overrides.reviewStatus || 'pending',
      overrides.reviewAttempts ?? 0,
      overrides.lastAttemptedAt ?? null,
      overrides.rereviewRequestedAt ?? null,
      overrides.postedAt ?? null,
      overrides.failedAt ?? null,
      overrides.failureMessage ?? null,
      overrides.reviewerHeadSha ?? null
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
          pass_kind, started_at, ended_at, status, head_sha, metadata_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      overrides.repo || REPO,
      overrides.prNumber || 950,
      overrides.attemptNumber ?? 1,
      overrides.reviewerClass || 'claude',
      overrides.reviewerModel || 'claude-sonnet',
      overrides.passKind || 'first-pass',
      Object.hasOwn(overrides, 'startedAt') ? overrides.startedAt : '2026-05-25T17:45:00.000Z',
      Object.hasOwn(overrides, 'endedAt') ? overrides.endedAt : '2026-05-25T17:50:00.000Z',
      overrides.status || 'failed',
      overrides.headSha ?? null,
      Object.hasOwn(overrides, 'metadataJson')
        ? overrides.metadataJson
        : JSON.stringify(overrides.metadata || { failureClass: 'timeout' })
    );
  } finally {
    db.close();
  }
}

function insertReviewerPasses(rootDir, passes) {
  for (const pass of passes) insertReviewerPass(rootDir, pass);
}

function reviewerModelSilentFinding(snapshot) {
  return snapshot.findings.find((entry) => entry.code === 'review:reviewer_model_silent');
}

function reviewerModelSilentDetails(snapshot, model) {
  return reviewerModelSilentFinding(snapshot)?.details.models?.find((entry) => entry.model === model);
}

test('previously-active reviewer model going silent raises its own finding', () => {
  const rootDir = tempRoot();
  try {
    insertReviewerPass(rootDir, {
      reviewerClass: 'claude',
      reviewerModel: 'claude',
      startedAt: '2026-05-23T17:00:00.000Z',
      endedAt: '2026-05-23T17:10:00.000Z',
      status: 'completed',
    });
    insertReviewerPass(rootDir, {
      prNumber: 951,
      reviewerClass: 'gemini',
      reviewerModel: 'gemini',
      startedAt: '2026-05-25T17:00:00.000Z',
      endedAt: '2026-05-25T17:10:00.000Z',
      status: 'completed',
    });
    insertReviewerPass(rootDir, {
      prNumber: 952,
      reviewerClass: 'claude',
      reviewerModel: 'claude',
      startedAt: '2026-05-25T17:00:00.000Z',
      endedAt: '2026-05-25T17:05:00.000Z',
      status: 'failed',
    });
    const db = openDb(rootDir);
    try {
      db.prepare(
        `UPDATE reviewer_passes
            SET gh_comment_id = ?, body_captured_at = ended_at
          WHERE pr_number = ?`
      ).run('claude-review-id', 950);
      db.prepare(
        `UPDATE reviewer_passes
            SET gh_comment_id = ?, body_captured_at = ended_at
          WHERE reviewer_model = ?`
      ).run('gemini-review-id', 'gemini');
    } finally {
      db.close();
    }

    const snapshot = collectReviewPipelineHealth({
      rootDir,
      now: () => new Date(NOW),
      config: {
        hostChecksEnabled: false,
        reviewerSilenceThresholdMs: 24 * 60 * 60 * 1000,
        reviewerActivityLookbackMs: 7 * 24 * 60 * 60 * 1000,
      },
    });
    const finding = reviewerModelSilentFinding(snapshot);
    const model = reviewerModelSilentDetails(snapshot, 'claude');
    assert.ok(finding);
    assert.ok(model);
    assert.equal(model.lastPostedAt, '2026-05-23T17:10:00.000Z');
    assert.equal(model.startedPasses, 1);
    assert.equal(reviewerModelSilentDetails(snapshot, 'gemini'), undefined);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('reviewer model silence aggregates simultaneous silent models into one finding', () => {
  const rootDir = tempRoot();
  try {
    insertReviewerPass(rootDir, {
      reviewerClass: 'claude',
      reviewerModel: 'claude-sonnet',
      startedAt: '2026-05-23T12:00:00.000Z',
      endedAt: '2026-05-23T12:10:00.000Z',
      status: 'completed',
    });
    insertReviewerPass(rootDir, {
      prNumber: 951,
      reviewerClass: 'codex',
      reviewerModel: 'gpt-5',
      startedAt: '2026-05-23T13:00:00.000Z',
      endedAt: '2026-05-23T13:10:00.000Z',
      status: 'completed',
    });
    insertReviewerPass(rootDir, {
      prNumber: 952,
      reviewerClass: 'claude',
      reviewerModel: 'claude-opus',
      startedAt: '2026-05-25T17:00:00.000Z',
      endedAt: '2026-05-25T17:05:00.000Z',
      status: 'failed',
    });
    insertReviewerPass(rootDir, {
      prNumber: 953,
      reviewerClass: 'codex',
      reviewerModel: 'gpt-5',
      startedAt: '2026-05-25T17:15:00.000Z',
      endedAt: '2026-05-25T17:20:00.000Z',
      status: 'failed',
    });
    const db = openDb(rootDir);
    try {
      db.prepare(
        `UPDATE reviewer_passes
            SET gh_comment_id = ?, body_captured_at = ended_at
          WHERE pr_number = ?`
      ).run('claude-review-id', 950);
      db.prepare(
        `UPDATE reviewer_passes
            SET gh_comment_id = ?, body_captured_at = ended_at
          WHERE pr_number = ?`
      ).run('codex-review-id', 951);
    } finally {
      db.close();
    }

    const snapshot = collectReviewPipelineHealth({
      rootDir,
      now: () => new Date(NOW),
      config: {
        hostChecksEnabled: false,
        reviewerSilenceThresholdMs: 24 * 60 * 60 * 1000,
        reviewerActivityLookbackMs: 7 * 24 * 60 * 60 * 1000,
      },
    });
    const findings = snapshot.findings.filter((entry) => entry.code === 'review:reviewer_model_silent');
    assert.equal(findings.length, 1);
    assert.deepEqual(
      findings[0].details.models.map((entry) => entry.model).sort(),
      ['claude', 'codex'],
    );
    assert.match(findings[0].subject, /claude/);
    assert.match(findings[0].subject, /codex/);
    assert.ok(findings[0].evidence.some((entry) => entry.includes('models=claude,codex')));
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('reviewer model silence stretches threshold to recent model cadence', () => {
  const rootDir = tempRoot();
  try {
    for (const [index, endedAt] of [
      '2026-05-20T12:00:00.000Z',
      '2026-05-22T12:00:00.000Z',
      '2026-05-24T12:00:00.000Z',
    ].entries()) {
      insertReviewerPass(rootDir, {
        prNumber: 960 + index,
        reviewerClass: 'claude',
        reviewerModel: 'claude-sonnet',
        startedAt: endedAt.replace('12:00:00', '11:50:00'),
        endedAt,
        status: 'completed',
      });
    }
    insertReviewerPass(rootDir, {
      prNumber: 963,
      reviewerClass: 'claude',
      reviewerModel: 'claude-sonnet',
      startedAt: '2026-05-25T17:00:00.000Z',
      endedAt: '2026-05-25T17:05:00.000Z',
      status: 'failed',
    });
    const db = openDb(rootDir);
    try {
      for (const prNumber of [960, 961, 962]) {
        db.prepare(
          `UPDATE reviewer_passes
              SET gh_comment_id = ?, body_captured_at = ended_at
            WHERE pr_number = ?`
        ).run(`claude-review-id-${prNumber}`, prNumber);
      }
    } finally {
      db.close();
    }

    const snapshot = collectReviewPipelineHealth({
      rootDir,
      now: () => new Date(NOW),
      config: {
        hostChecksEnabled: false,
        reviewerSilenceThresholdMs: 24 * 60 * 60 * 1000,
        reviewerActivityLookbackMs: 7 * 24 * 60 * 60 * 1000,
      },
    });
    assert.equal(reviewerModelSilentFinding(snapshot), undefined);
    const model = snapshot.reviewerModelSilence.models.find((entry) => entry.model === 'claude');
    assert.ok(model);
    assert.equal(model.thresholdMs, 48 * 60 * 60 * 1000);
    assert.equal(model.cadenceSampleSize, 2);
    assert.equal(model.startedPasses, 1);
    assert.equal(model.silent, false);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('reviewer model silence ignores empty comment ids and remediation pass noise', () => {
  const rootDir = tempRoot();
  try {
    insertReviewerPass(rootDir, {
      reviewerClass: 'claude',
      reviewerModel: 'claude',
      startedAt: '2026-05-23T16:00:00.000Z',
      endedAt: '2026-05-23T16:10:00.000Z',
      status: 'completed',
    });
    insertReviewerPass(rootDir, {
      prNumber: 951,
      reviewerClass: 'claude',
      reviewerModel: 'claude',
      startedAt: '2026-05-25T17:00:00.000Z',
      endedAt: '2026-05-25T17:05:00.000Z',
      status: 'completed',
    });
    insertReviewerPass(rootDir, {
      prNumber: 952,
      reviewerClass: 'claude-code',
      reviewerModel: 'claude-code',
      passKind: 'remediation',
      startedAt: '2026-05-25T17:30:00.000Z',
      endedAt: '2026-05-25T17:35:00.000Z',
      status: 'completed',
    });
    const db = openDb(rootDir);
    try {
      db.prepare(
        `UPDATE reviewer_passes
            SET gh_comment_id = ?, body_captured_at = ended_at
          WHERE pr_number = ?`
      ).run('claude-old-review-id', 950);
      db.prepare(
        `UPDATE reviewer_passes
            SET gh_comment_id = '', body_captured_at = ended_at
          WHERE pr_number = ?`
      ).run(951);
      db.prepare(
        `UPDATE reviewer_passes
            SET gh_comment_id = ?, body_captured_at = ended_at
          WHERE pr_number = ?`
      ).run('remediation-comment-id', 952);
    } finally {
      db.close();
    }

    const snapshot = collectReviewPipelineHealth({
      rootDir,
      now: () => new Date(NOW),
      config: {
        hostChecksEnabled: false,
        reviewerSilenceThresholdMs: 24 * 60 * 60 * 1000,
        reviewerActivityLookbackMs: 7 * 24 * 60 * 60 * 1000,
      },
    });
    const model = reviewerModelSilentDetails(snapshot, 'claude');
    assert.ok(model);
    assert.equal(model.lastPostedAt, '2026-05-23T16:10:00.000Z');
    assert.equal(model.startedPasses, 1);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('reviewer model silence parses timezone-less SQLite timestamps as UTC', () => {
  const previousTz = process.env.TZ;
  process.env.TZ = 'America/Los_Angeles';
  const rootDir = tempRoot();
  try {
    insertReviewerPass(rootDir, {
      reviewerClass: 'claude',
      reviewerModel: 'claude',
      startedAt: '2026-05-24 12:50:00',
      endedAt: '2026-05-24 13:00:00',
      status: 'completed',
    });
    insertReviewerPass(rootDir, {
      prNumber: 951,
      reviewerClass: 'claude',
      reviewerModel: 'claude',
      startedAt: '2026-05-25T17:00:00.000Z',
      endedAt: '2026-05-25T17:05:00.000Z',
      status: 'failed',
    });
    const db = openDb(rootDir);
    try {
      db.prepare(
        `UPDATE reviewer_passes
            SET gh_comment_id = ?, body_captured_at = ended_at
          WHERE pr_number = ?`
      ).run('claude-review-id', 950);
    } finally {
      db.close();
    }

    const snapshot = collectReviewPipelineHealth({
      rootDir,
      now: () => new Date(NOW),
      config: {
        hostChecksEnabled: false,
        reviewerSilenceThresholdMs: 24 * 60 * 60 * 1000,
        reviewerActivityLookbackMs: 7 * 24 * 60 * 60 * 1000,
      },
    });
    const model = reviewerModelSilentDetails(snapshot, 'claude');
    assert.ok(model);
    assert.equal(model.lastPostedAt, '2026-05-24T13:00:00.000Z');
    assert.equal(Math.round(model.ageMs / 3600000), 29);
  } finally {
    if (previousTz === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = previousTz;
    }
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('reviewer model silence ages out models with no posted review inside the activity lookback', () => {
  const rootDir = tempRoot();
  try {
    insertReviewerPass(rootDir, {
      reviewerClass: 'claude',
      reviewerModel: 'claude',
      startedAt: '2026-05-17T16:00:00.000Z',
      endedAt: '2026-05-17T16:10:00.000Z',
      status: 'completed',
    });
    insertReviewerPass(rootDir, {
      prNumber: 951,
      reviewerClass: 'claude',
      reviewerModel: 'claude',
      startedAt: '2026-05-25T17:00:00.000Z',
      endedAt: '2026-05-25T17:05:00.000Z',
      status: 'failed',
    });
    insertReviewerPass(rootDir, {
      prNumber: 952,
      reviewerClass: 'gemini',
      reviewerModel: 'gemini',
      startedAt: '2026-05-17T16:00:00.000Z',
      endedAt: '2026-05-17T16:10:00.000Z',
      status: 'completed',
    });
    const db = openDb(rootDir);
    try {
      db.prepare(
        `UPDATE reviewer_passes
            SET gh_comment_id = ?, body_captured_at = ended_at
          WHERE pr_number = ?`
      ).run('claude-old-review-id', 950);
      db.prepare(
        `UPDATE reviewer_passes
            SET gh_comment_id = ?, body_captured_at = ended_at
          WHERE pr_number = ?`
      ).run('gemini-old-review-id', 952);
    } finally {
      db.close();
    }

    const snapshot = collectReviewPipelineHealth({
      rootDir,
      now: () => new Date(NOW),
      config: {
        hostChecksEnabled: false,
        reviewerSilenceThresholdMs: 24 * 60 * 60 * 1000,
        reviewerActivityLookbackMs: 7 * 24 * 60 * 60 * 1000,
      },
    });
    assert.equal(reviewerModelSilentDetails(snapshot, 'claude'), undefined);
    assert.equal(reviewerModelSilentDetails(snapshot, 'gemini'), undefined);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('reviewer model silence matches configured classes through reviewer_class before reviewer_model variants', () => {
  const rootDir = tempRoot();
  try {
    insertReviewerPass(rootDir, {
      reviewerClass: 'claude',
      reviewerModel: 'hammer-claude',
      startedAt: '2026-05-23T17:00:00.000Z',
      endedAt: '2026-05-23T17:10:00.000Z',
      status: 'completed',
    });
    insertReviewerPass(rootDir, {
      prNumber: 951,
      reviewerClass: 'claude',
      reviewerModel: 'hammer-claude',
      startedAt: '2026-05-25T17:00:00.000Z',
      endedAt: '2026-05-25T17:05:00.000Z',
      status: 'failed',
    });
    const db = openDb(rootDir);
    try {
      db.prepare(
        `UPDATE reviewer_passes
            SET gh_comment_id = ?, body_captured_at = ended_at
          WHERE pr_number = ?`
      ).run('claude-review-id', 950);
    } finally {
      db.close();
    }

    const snapshot = collectReviewPipelineHealth({
      rootDir,
      now: () => new Date(NOW),
      config: {
        hostChecksEnabled: false,
        reviewerSilenceThresholdMs: 24 * 60 * 60 * 1000,
        reviewerActivityLookbackMs: 7 * 24 * 60 * 60 * 1000,
        reviewerModelSilenceClasses: ['claude'],
      },
    });
    assert.ok(reviewerModelSilentDetails(snapshot, 'claude'));
    assert.equal(reviewerModelSilentDetails(snapshot, 'hammer-claude'), undefined);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('reviewer model silence ignores empty comment ids when selecting latest posted review', () => {
  const rootDir = tempRoot();
  try {
    insertReviewerPass(rootDir, {
      prNumber: 952,
      reviewerClass: 'claude',
      reviewerModel: 'claude',
      startedAt: '2026-05-23T17:00:00.000Z',
      endedAt: '2026-05-23T17:10:00.000Z',
      status: 'completed',
    });
    insertReviewerPass(rootDir, {
      prNumber: 953,
      reviewerClass: 'claude',
      reviewerModel: 'claude',
      startedAt: '2026-05-25T17:00:00.000Z',
      endedAt: '2026-05-25T17:10:00.000Z',
      status: 'completed',
    });
    const db = openDb(rootDir);
    try {
      db.prepare(
        `UPDATE reviewer_passes
            SET gh_comment_id = ?, body_captured_at = ended_at
          WHERE pr_number = ?`
      ).run('claude-review-id', 952);
      db.prepare(
        `UPDATE reviewer_passes
            SET gh_comment_id = '', body_captured_at = ended_at
          WHERE pr_number = ?`
      ).run(953);
    } finally {
      db.close();
    }

    const snapshot = collectReviewPipelineHealth({
      rootDir,
      now: () => new Date(NOW),
      config: {
        hostChecksEnabled: false,
        reviewerSilenceThresholdMs: 24 * 60 * 60 * 1000,
        reviewerActivityLookbackMs: 7 * 24 * 60 * 60 * 1000,
      },
    });
    const model = reviewerModelSilentDetails(snapshot, 'claude');
    assert.ok(model);
    assert.equal(model.lastPostedAt, '2026-05-23T17:10:00.000Z');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('reviewer model silence ignores started_at for passes with no posted timestamp', () => {
  const rootDir = tempRoot();
  try {
    insertReviewerPass(rootDir, {
      prNumber: 954,
      reviewerClass: 'codex',
      reviewerModel: 'codex',
      startedAt: '2026-05-23T17:00:00.000Z',
      endedAt: '2026-05-23T17:10:00.000Z',
      status: 'completed',
    });
    insertReviewerPass(rootDir, {
      prNumber: 955,
      reviewerClass: 'codex',
      reviewerModel: 'codex',
      startedAt: '2026-05-25T17:50:00.000Z',
      endedAt: null,
      status: 'running',
    });
    const db = openDb(rootDir);
    try {
      db.prepare(
        `UPDATE reviewer_passes
            SET gh_comment_id = ?, body_captured_at = ended_at
          WHERE pr_number = ?`
      ).run('codex-review-id-old', 954);
      db.prepare(
        `UPDATE reviewer_passes
            SET gh_comment_id = ?
          WHERE pr_number = ?`
      ).run('codex-review-id-running', 955);
    } finally {
      db.close();
    }

    const snapshot = collectReviewPipelineHealth({
      rootDir,
      now: () => new Date(NOW),
      config: {
        hostChecksEnabled: false,
        reviewerSilenceThresholdMs: 24 * 60 * 60 * 1000,
        reviewerActivityLookbackMs: 7 * 24 * 60 * 60 * 1000,
      },
    });
    const model = reviewerModelSilentDetails(snapshot, 'codex');
    assert.ok(model);
    assert.equal(model.lastPostedAt, '2026-05-23T17:10:00.000Z');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('reviewer model silence clears after the activity lookback', () => {
  const rootDir = tempRoot();
  try {
    insertReviewerPass(rootDir, {
      reviewerClass: 'claude',
      reviewerModel: 'claude',
      startedAt: '2026-05-17 17:00:00',
      endedAt: '2026-05-17 18:00:00',
      status: 'completed',
    });
    const db = openDb(rootDir);
    try {
      db.prepare(
        `UPDATE reviewer_passes
            SET gh_comment_id = ?, body_captured_at = ended_at
          WHERE reviewer_model = ?`
      ).run('claude-review-id', 'claude');
    } finally {
      db.close();
    }

    const snapshot = collectReviewPipelineHealth({
      rootDir,
      now: () => new Date(NOW),
      config: {
        hostChecksEnabled: false,
        reviewerSilenceThresholdMs: 24 * 60 * 60 * 1000,
        reviewerActivityLookbackMs: 7 * 24 * 60 * 60 * 1000,
      },
    });
    assert.equal(reviewerModelSilentFinding(snapshot), undefined);
    const model = snapshot.reviewerModelSilence.models.find((entry) => entry.model === 'claude');
    assert.equal(model, undefined);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

function insertActiveTtmFlag(rootDir, overrides = {}) {
  const db = openDb(rootDir);
  try {
    ensureTtmTrackerSchema(db);
    const repo = overrides.repo || REPO;
    const prNumber = overrides.prNumber || 960;
    const flagKind = overrides.flagKind || 'terminal_but_unmerged';
    const eventKey = overrides.eventKey || `${repo}#${prNumber}:${flagKind}`;
    db.prepare(
      `INSERT INTO ttm_flag_state (
         event_key, repo, pr_number, flag_kind, state, first_observed_at,
         last_observed_at, resolved_at, opened_at, settled_at, merged_at,
         elapsed_minutes, budget_minutes, terminal_unmerged_minutes,
         review_rounds, details_json
       ) VALUES (?, ?, ?, ?, 'active', ?, ?, NULL, ?, ?, NULL, ?, ?, ?, ?, ?)`
    ).run(
      eventKey,
      repo,
      prNumber,
      flagKind,
      overrides.firstObservedAt || '2026-05-25T17:10:00.000Z',
      overrides.lastObservedAt || '2026-05-25T17:50:00.000Z',
      overrides.openedAt || '2026-05-25T17:00:00.000Z',
      overrides.settledAt || '2026-05-25T17:10:00.000Z',
      overrides.elapsedMinutes ?? 60,
      overrides.budgetMinutes ?? 30,
      overrides.terminalUnmergedMinutes ?? 50,
      overrides.reviewRounds ?? 0,
      JSON.stringify(overrides.details || { prState: 'open' }),
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

// TREC-01: both age-based findings that read `pr_state` are now stamped with
// whether the mirror row was verified against GitHub. Fixtures that are NOT
// about reconciliation seed a fresh clean sweep so they exercise the
// verified-mirror path; the unverified path has its own coverage in
// test/pr-terminal-reconcile.test.mjs and below.
function seedFreshReconcile(rootDir, { observedAt = NOW, unresolved = [] } = {}) {
  writePrTerminalReconcileState(rootDir, {
    source: 'test',
    observedAt,
    completedAt: observedAt,
    checked: 1,
    merged: 0,
    closed: 0,
    stillOpen: 1,
    unresolved,
    unresolvedCount: unresolved.length,
    deferredCount: 0,
  });
}

function findingCodes(snapshot) {
  return snapshot.findings.map((finding) => finding.code).sort();
}

test('conflicting open PRs are grouped by merge-tree conflict paths', () => {
  const rootDir = tempRoot();
  const calls = [];
  const execFileSyncImpl = (command, args, options = {}) => {
    calls.push({ command, args, cwd: options.cwd || null });
    if (command === 'gh') {
      assert.deepEqual(args.slice(0, 6), ['pr', 'list', '--repo', 'laceyenterprises/agent-os', '--state', 'open']);
      return JSON.stringify([
        {
          number: 6822,
          url: 'https://github.com/laceyenterprises/agent-os/pull/6822',
          title: '[codex] ACTASSERT-01',
          headRefName: 'codex/actassert',
          headRefOid: 'head-a',
          baseRefName: 'main',
          mergeable: 'CONFLICTING',
          isDraft: false,
        },
        {
          number: 6826,
          url: 'https://github.com/laceyenterprises/agent-os/pull/6826',
          title: '[codex] PCREPO-01',
          headRefName: 'codex/pcrepo',
          headRefOid: 'head-b',
          baseRefName: 'main',
          mergeable: 'CONFLICTING',
          isDraft: false,
        },
        {
          number: 6827,
          headRefOid: 'head-c',
          baseRefName: 'main',
          mergeable: 'MERGEABLE',
          isDraft: false,
        },
      ]);
    }
    if (command === 'git' && args[0] === 'cat-file') {
      return '';
    }
    if (command === 'git' && args[0] === 'merge-tree' && args.at(-1) === 'head-a') {
      return [
        '0fbf96c31adb255b6d545f3ad21fbfe275d62c8d',
        'docs/INDEX.md',
        'projects/worker-pool/prompts/a.md',
        '',
        'Auto-merging docs/INDEX.md',
        'CONFLICT (content): Merge conflict in docs/INDEX.md',
        '',
      ].join('\n');
    }
    if (command === 'git' && args[0] === 'merge-tree' && args.at(-1) === 'head-b') {
      const error = new Error('merge-tree conflict');
      error.stdout = [
        '2ce94f3a29f4143ce5f73ea68146df7bca394276',
        'docs/INDEX.md',
        'projects/worker-pool/prompts/b.md',
        '',
        'Auto-merging docs/INDEX.md',
        'CONFLICT (content): Merge conflict in docs/INDEX.md',
        '',
      ].join('\n');
      error.stderr = 'fatal: merge-tree reported conflicts';
      throw error;
    }
    throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
  };

  const snapshot = collectReviewPipelineHealth({
    rootDir,
    now: () => new Date(NOW),
    execFileSyncImpl,
    sleepSyncImpl: () => {},
    config: {
      conflictingPrChecksEnabled: true,
      conflictingPrRepo: 'laceyenterprises/agent-os',
      conflictingPrRepoRoot: '/repo/agent-os',
      conflictingPrMinSharedPathCount: 2,
    },
  });

  assert.equal(snapshot.conflictingOpenPrs.count, 2);
  assert.deepEqual(snapshot.conflictingOpenPrs.groupedPaths[0], {
    path: 'docs/INDEX.md',
    count: 2,
    prNumbers: [6822, 6826],
  });
  assert.deepEqual(snapshot.conflictingOpenPrs.sharedPathGroups, [{
    path: 'docs/INDEX.md',
    count: 2,
    prNumbers: [6822, 6826],
  }]);
  assert.deepEqual(snapshot.conflictingOpenPrs.errors, []);
  const finding = snapshot.findings.find((entry) => entry.code === 'review:conflicting_open_prs');
  assert.ok(finding);
  assert.match(finding.message, /docs\/INDEX\.md -> #6822, #6826/);
  assert.doesNotMatch(finding.message, /Auto-merging|0fbf96c/);
  assert.match(renderReviewPipelinePrometheus(snapshot), /^review_pipeline_conflicting_open_prs 2$/m);
  assert.match(renderReviewPipelinePrometheus(snapshot), /^review_pipeline_conflicting_open_prs_collected 1$/m);
  assert.match(renderReviewPipelinePrometheus(snapshot), /^review_pipeline_conflicting_open_pr_shared_path_groups 1$/m);
  assert.equal(calls.filter((call) => call.command === 'git' && call.args[0] === 'merge-tree').length, 2);
  assert.ok(calls.filter((call) => call.command === 'git').every((call) => call.cwd === '/repo/agent-os'));
});

test('conflicting open PR diagnostic only finds shared conflict paths', () => {
  const rootDir = tempRoot();
  const execFileSyncImpl = (command, args) => {
    if (command === 'gh') {
      return JSON.stringify([
        {
          number: 6822,
          headRefOid: 'head-a',
          baseRefName: 'main',
          mergeable: 'CONFLICTING',
          isDraft: false,
        },
      ]);
    }
    if (command === 'git' && args[0] === 'cat-file') {
      return '';
    }
    if (command === 'git' && args[0] === 'merge-tree') {
      return [
        '0fbf96c31adb255b6d545f3ad21fbfe275d62c8d',
        'docs/INDEX.md',
        '',
        'Auto-merging docs/INDEX.md',
        'CONFLICT (content): Merge conflict in docs/INDEX.md',
        '',
      ].join('\n');
    }
    throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
  };

  const snapshot = collectReviewPipelineHealth({
    rootDir,
    now: () => new Date(NOW),
    execFileSyncImpl,
    sleepSyncImpl: () => {},
    config: {
      conflictingPrChecksEnabled: true,
      conflictingPrRepo: 'laceyenterprises/agent-os',
      conflictingPrRepoRoot: '/repo/agent-os',
    },
  });

  assert.equal(snapshot.conflictingOpenPrs.count, 1);
  assert.equal(snapshot.conflictingOpenPrs.groupedPaths.length, 1);
  assert.equal(snapshot.conflictingOpenPrs.sharedPathGroups.length, 0);
  assert.ok(!findingCodes(snapshot).includes('review:conflicting_open_prs'));
});

test('conflicting open PR diagnostic treats per-PR probe failures as blind coverage', () => {
  const rootDir = tempRoot();
  const calls = [];
  const execFileSyncImpl = (command, args) => {
    calls.push({ command, args });
    if (command === 'gh') {
      return JSON.stringify([
        {
          number: 6818,
          headRefOid: 'dc90afc7e794821c9290a75f903d45cc76f35ec9',
          baseRefName: 'main',
          mergeable: 'CONFLICTING',
          isDraft: false,
        },
      ]);
    }
    if (command === 'git') {
      const error = new Error('not something we can merge');
      error.stderr = 'fatal: not something we can merge';
      throw error;
    }
    throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
  };

  const snapshot = collectReviewPipelineHealth({
    rootDir,
    now: () => new Date(NOW),
    execFileSyncImpl,
    sleepSyncImpl: () => {},
    config: {
      conflictingPrChecksEnabled: true,
      conflictingPrRepo: 'laceyenterprises/agent-os',
      conflictingPrRepoRoot: '/repo/agent-os',
      conflictingPrMinSharedPathCount: 1,
    },
  });

  assert.equal(snapshot.conflictingOpenPrs.count, 1);
  assert.equal(snapshot.conflictingOpenPrs.probedPrs, 0);
  assert.equal(snapshot.conflictingOpenPrs.unprobedPrs, 1);
  assert.equal(snapshot.conflictingOpenPrs.collected, false);
  assert.deepEqual(snapshot.conflictingOpenPrs.sharedPathGroups, []);
  assert.match(snapshot.conflictingOpenPrs.errors[0], /#6818: fatal: not something we can merge/);
  assert.ok(!findingCodes(snapshot).includes('review:conflicting_open_prs'));
  assert.ok(findingCodes(snapshot).includes('review:conflicting_open_prs_unreadable'));
  assert.match(renderReviewPipelinePrometheus(snapshot), /^review_pipeline_conflicting_open_prs 1$/m);
  assert.match(renderReviewPipelinePrometheus(snapshot), /^review_pipeline_conflicting_open_prs_collected 0$/m);
  assert.ok(calls.some((call) => call.command === 'git' && call.args[0] === 'fetch'));
});

test('conflicting open PR diagnostic failure creates a blind finding, not a zero-conflict finding', () => {
  const rootDir = tempRoot();
  let calls = 0;
  const execFileSyncImpl = () => {
    calls += 1;
    const error = new Error('gh unavailable');
    error.stderr = 'HTTP 502';
    throw error;
  };

  const snapshot = collectReviewPipelineHealth({
    rootDir,
    now: () => new Date(NOW),
    execFileSyncImpl,
    sleepSyncImpl: () => {},
    config: {
      conflictingPrChecksEnabled: true,
      conflictingPrRepo: 'laceyenterprises/agent-os',
      conflictingPrRepoRoot: '/repo/agent-os',
    },
  });

  assert.equal(snapshot.conflictingOpenPrs.count, 0);
  assert.equal(snapshot.conflictingOpenPrs.collected, false);
  assert.match(snapshot.conflictingOpenPrs.errors[0], /HTTP 502/);
  assert.ok(!findingCodes(snapshot).includes('review:conflicting_open_prs'));
  assert.ok(findingCodes(snapshot).includes('review:conflicting_open_prs_unreadable'));
  assert.match(renderReviewPipelinePrometheus(snapshot), /^review_pipeline_conflicting_open_prs 0$/m);
  assert.match(renderReviewPipelinePrometheus(snapshot), /^review_pipeline_conflicting_open_prs_collected 0$/m);
  assert.equal(calls, 3);
});

test('stopped remediation operational blockers surface in pipeline health findings', () => {
  const rootDir = tempRoot();
  writeJob(rootDir, 'stopped', 'job-auth-blocked', {
    jobId: 'job-auth-blocked',
    repo: REPO,
    prNumber: 6755,
    stoppedAt: '2026-05-25T17:30:00.000Z',
    parsedReply: {
      operationalBlockers: [{
        title: 'github-auth',
        finding: 'Human intervention required: GitHub credentials were invalid.',
        reasoning: 'gh auth status reported invalid GH_TOKEN and no non-interactive credential.',
      }],
    },
    operationalBlockerRecovery: {
      rescue: {
        kind: 'git-bundle',
        path: '/tmp/rescue.bundle',
        commitSha: 'bb3cd479c',
      },
    },
  });

  const snapshot = collectReviewPipelineHealth({ rootDir, now: () => new Date(NOW) });

  assert.equal(snapshot.operationalBlockers.total, 1);
  assert.equal(snapshot.operationalBlockers.byCategory[0].category, 'github-auth');
  assert.equal(snapshot.operationalBlockers.byCategory[0].oldest.prNumber, 6755);
  const finding = snapshot.findings.find(
    (entry) => entry.code === 'review:operational_blocker_human_intervention'
  );
  assert.ok(finding);
  assert.match(finding.message, /github-auth/);
  assert.match(renderReviewPipelinePrometheus(snapshot), /review_pipeline_operational_blocker_rounds\{category="github-auth"\} 1/);
});

test('operational blocker metric categories are bounded when worker text is unique', () => {
  const rootDir = tempRoot();
  writeJob(rootDir, 'stopped', 'job-unique-blocker', {
    jobId: 'job-unique-blocker',
    repo: REPO,
    prNumber: 6757,
    stoppedAt: '2026-05-25T17:30:00.000Z',
    parsedReply: {
      operationalBlockers: [{
        finding: 'push failed for commit abc123 at /Users/airlock/agent-os-hq/worktrees/job-unique-blocker',
        reasoning: 'operator intervention required for this one-off local failure',
      }],
    },
  });

  const snapshot = collectReviewPipelineHealth({ rootDir, now: () => new Date(NOW) });
  const rendered = renderReviewPipelinePrometheus(snapshot);

  assert.equal(snapshot.operationalBlockers.total, 1);
  assert.equal(snapshot.operationalBlockers.byCategory[0].category, 'other');
  assert.match(rendered, /review_pipeline_operational_blocker_rounds\{category="other"\} 1/);
  assert.doesNotMatch(rendered, /abc123|airlock|job-unique-blocker/);
});

test('operational blocker human-intervention finding ignores explicit no-action text', () => {
  const rootDir = tempRoot();
  writeJob(rootDir, 'stopped', 'job-auth-retrying', {
    jobId: 'job-auth-retrying',
    repo: REPO,
    prNumber: 6756,
    stoppedAt: '2026-05-25T17:30:00.000Z',
    parsedReply: {
      operationalBlockers: [{
        title: 'github-auth',
        finding: 'No human intervention required; credential retry is queued.',
        reasoning: 'Push is required after the token refresh completes.',
      }],
    },
  });

  const snapshot = collectReviewPipelineHealth({ rootDir, now: () => new Date(NOW) });

  assert.equal(snapshot.operationalBlockers.total, 1);
  assert.ok(!findingCodes(snapshot).includes('review:operational_blocker_human_intervention'));
});

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
  // TTM-01: a schema-less database is a database the collector cannot READ,
  // and SEN-02 says that is reported, not swallowed. It reports `blind`
  // (ticket severity, never pages) and nothing else -- in particular it makes
  // no health claim about the pipeline, which is what the previous empty list
  // silently did.
  // TREC-01 adds the second blind code: this fixture has no reconciliation
  // record either, so the collector cannot claim its open-PR population has
  // been verified against GitHub. Both are SEN-02 blindness reports, and
  // neither makes a health claim about the pipeline.
  assert.deepEqual(
    findingCodes(snapshot),
    ['review:pr_lifecycle_mirror_unverified', 'review:ttm_budget_model_unreadable'],
  );
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

  const output = renderReviewPipelinePrometheus(snapshot);
  assert.match(output, /^# TYPE review_pipeline_health_collector_up gauge$/m);
  assert.match(output, /^review_pipeline_health_collector_up 0$/m);
});

// BEHAVIOR CHANGE (2026-08-22): a missing ledger now also raises a finding.
//
// The Prometheus `collector_up 0` gauge asserted above was the ONLY down signal
// for this case. The findings/`--sentinel` stream — the surface Sentinel and
// `hq adversarial pipeline-health` actually consume — stayed completely silent
// and shipped an all-zero snapshot, which reads as a healthy idle pipeline.
// Combined with the CLI's old `process.cwd()` root default, that produced a
// confident false CLEAN from the wrong directory. See the terminal-Hammer Sev-1
// (agent-os docs/postmortems/INCIDENT-SEV1-terminal-hammer-revision-ref-deadlock-2026-08-22.md).
test('collector emits a finding when the review-state ledger is missing entirely', () => {
  const rootDir = tempRoot();
  const snapshot = collectReviewPipelineHealth({ rootDir, now: () => new Date(NOW) });

  assert.ok(findingCodes(snapshot).includes('review:review_state_ledger_unreadable'));
  const finding = snapshot.findings.find(
    (item) => item.code === 'review:review_state_ledger_unreadable',
  );
  assert.equal(finding.tier, 'ticket');
  assert.match(finding.subject, /missing at the resolved root/);
  // The message must say why the zeros are untrustworthy, not merely that a file
  // is absent — the zeros are the part that misleads.
  assert.match(finding.message, /NOT because the pipeline is idle/);
  assert.match(finding.recommended_action, /Treat this snapshot as unusable/);
});

test('collector surfaces terminal reviewer failures on open PRs', () => {
  const rootDir = tempRoot();
  insertReviewRow(rootDir, {
    repo: REPO,
    prNumber: 6443,
    reviewStatus: 'failed',
    reviewAttempts: 3,
    failedAt: '2026-09-08T04:20:00.000Z',
    failureMessage: [
      '[github-review-create-terminal] Command failed with code 1',
      'stderr tail:',
      'gh api --method POST repos/laceyenterprises/agent-os/pulls/6443/reviews',
      'gh: Validation Failed (HTTP 422)',
    ].join('\n'),
  });

  const snapshot = collectReviewPipelineHealth({ rootDir, now: () => new Date(NOW) });
  assert.equal(snapshot.terminalReviewFailures.prs.length, 1);
  assert.equal(snapshot.terminalReviewFailures.prs[0].failureClass, 'github-review-create-terminal');
  assert.ok(findingCodes(snapshot).includes('review:terminal_review_failure_active'));
  const finding = snapshot.findings.find((item) => item.code === 'review:terminal_review_failure_active');
  assert.equal(finding.tier, 'ticket');
  assert.match(finding.message, /laceyenterprises\/adversarial-review#6443/);
  assert.match(finding.evidence[0], /class=github-review-create-terminal/);
});

test('parseArgs defaults rootDir to the tool root, not the caller cwd', () => {
  // `hq adversarial pipeline-health` execs this CLI without `--root`. Defaulting
  // to process.cwd() resolved the ledger relative to wherever the operator
  // happened to be standing and reported a false CLEAN.
  const options = parseArgs([]);
  // Assert structurally, not by directory name: the default must be the package
  // root that owns this CLI, wherever the checkout happens to live.
  assert.ok(
    existsSync(path.join(options.rootDir, 'src', 'review-pipeline-health-cli.mjs')),
    `expected the tool root that owns the CLI, got ${options.rootDir}`,
  );
  assert.ok(existsSync(path.join(options.rootDir, 'package.json')));
  // An explicit --root still wins.
  assert.equal(parseArgs(['--root', '/tmp/elsewhere']).rootDir, '/tmp/elsewhere');
  assert.equal(parseArgs(['--no-terminal-reconcile']).reconcileTerminalState, false);
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
  assert.equal(finding.tier, 'ticket');
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

test('collector surfaces first-pass wait, rereview share, and effective reviewer concurrency', () => {
  const rootDir = tempRoot();
  insertReviewRow(rootDir, {
    prNumber: 940,
    reviewStatus: 'pending',
    reviewedAt: new Date(Date.parse(NOW) - 10 * 60 * 1000).toISOString(),
  });
  insertReviewerPass(rootDir, {
    prNumber: 941,
    attemptNumber: 1,
    passKind: 'first-pass',
    status: 'completed',
    startedAt: '2026-05-25T17:30:00.000Z',
    endedAt: '2026-05-25T17:40:00.000Z',
  });
  insertReviewerPass(rootDir, {
    prNumber: 944,
    attemptNumber: 1,
    passKind: 'first-pass',
    status: 'completed',
    startedAt: '2026-05-25T16:55:00.000Z',
    endedAt: '2026-05-25T17:32:00.000Z',
  });
  insertReviewerPass(rootDir, {
    prNumber: 942,
    attemptNumber: 1,
    passKind: 'first-pass',
    status: 'completed',
    startedAt: '2026-05-25T17:35:00.000Z',
    endedAt: '2026-05-25T17:45:00.000Z',
  });
  insertReviewerPass(rootDir, {
    prNumber: 943,
    attemptNumber: 2,
    passKind: 'rereview',
    status: 'completed',
    startedAt: '2026-05-25T17:50:00.000Z',
    endedAt: '2026-05-25T17:55:00.000Z',
  });

  const snapshot = collectReviewPipelineHealth({ rootDir, now: () => new Date(NOW) });
  assert.equal(snapshot.reviewerCapacity.totalPasses, 4);
  assert.equal(snapshot.reviewerCapacity.firstPassPasses, 3);
  assert.equal(snapshot.reviewerCapacity.rereviewPasses, 1);
  assert.equal(snapshot.reviewerCapacity.rereviewShare, 1 / 4);
  assert.equal(snapshot.reviewerCapacity.effectiveConcurrency, 2);

  const output = renderReviewPipelinePrometheus(snapshot);
  assert.match(output, /^review_pipeline_first_pass_wait_seconds 600$/m);
  assert.match(output, /^review_pipeline_rereview_capacity_share\{window="3600000ms"\} 0\.25$/m);
  assert.match(output, /^review_pipeline_effective_reviewer_concurrency\{window="3600000ms"\} 2$/m);
});

test('reviewer capacity excludes abandoned and stale running passes', () => {
  const rootDir = tempRoot();
  insertReviewerPass(rootDir, {
    prNumber: 960,
    attemptNumber: 1,
    passKind: 'first-pass',
    status: 'abandoned',
    startedAt: '2026-05-25T16:00:00.000Z',
    endedAt: '2026-05-25T17:30:00.000Z',
  });
  insertReviewerPass(rootDir, {
    prNumber: 961,
    attemptNumber: 1,
    passKind: 'rereview',
    status: 'running',
    startedAt: '2026-05-25T16:30:00.000Z',
  });
  const db = openDb(rootDir);
  try {
    db.prepare('UPDATE reviewer_passes SET ended_at = NULL WHERE pr_number = ?').run(961);
  } finally {
    db.close();
  }
  insertReviewerPass(rootDir, {
    prNumber: 962,
    attemptNumber: 1,
    passKind: 'first-pass',
    status: 'completed',
    startedAt: '2026-05-25T17:50:00.000Z',
    endedAt: '2026-05-25T17:55:00.000Z',
  });

  const snapshot = collectReviewPipelineHealth({ rootDir, now: () => new Date(NOW) });

  assert.equal(snapshot.reviewerCapacity.totalPasses, 1);
  assert.equal(snapshot.reviewerCapacity.firstPassPasses, 1);
  assert.equal(snapshot.reviewerCapacity.rereviewPasses, 0);
  assert.equal(snapshot.reviewerCapacity.effectiveConcurrency, 1);
});

test('lane-share supermajority fires when rereviews dominate while first pass waits', () => {
  const rootDir = tempRoot();
  seedFreshReconcile(rootDir);
  insertReviewRow(rootDir, {
    prNumber: 970,
    reviewedAt: '2026-05-25T17:50:00.000Z',
    reviewStatus: 'pending',
  });
  insertReviewRow(rootDir, {
    prNumber: 971,
    reviewedAt: '2026-05-25T17:49:00.000Z',
    reviewStatus: 'pending',
  });
  for (let index = 0; index < 4; index += 1) {
    insertReviewerPass(rootDir, {
      prNumber: 980 + index,
      attemptNumber: 2,
      passKind: 'rereview',
      status: 'completed',
      startedAt: `2026-05-25T17:${10 + index}:00.000Z`,
      endedAt: `2026-05-25T17:${20 + index}:00.000Z`,
    });
  }
  insertReviewerPass(rootDir, {
    prNumber: 984,
    attemptNumber: 1,
    passKind: 'first-pass',
    status: 'completed',
    startedAt: '2026-05-25T17:20:00.000Z',
    endedAt: '2026-05-25T17:21:00.000Z',
  });

  const snapshot = collectReviewPipelineHealth({
    rootDir,
    now: () => new Date(NOW),
    configOverrides: { reviewLaneShareSupermajorityMinPasses: 5 },
  });
  const finding = snapshot.findings.find((item) => item.code === 'review:review_lane_share_supermajority');

  assert.ok(finding, findingCodes(snapshot).join(','));
  assert.equal(finding.details.dominantLane, 'rereview');
  assert.equal(finding.details.starvedLane, 'first-pass');
  assert.equal(finding.details.totalPasses, 5);
  assert.equal(finding.details.distinctQueuedPrs, 2);
  assert.equal(finding.details.queuedOtherLane.prNumber, 971);
});

test('lane-share supermajority stays quiet when opposite-lane work is fresh', () => {
  const rootDir = tempRoot();
  seedFreshReconcile(rootDir);
  insertReviewRow(rootDir, {
    prNumber: 970,
    reviewedAt: '2026-05-25T17:59:30.000Z',
    reviewStatus: 'pending',
  });
  insertReviewRow(rootDir, {
    prNumber: 971,
    reviewedAt: '2026-05-25T17:59:00.000Z',
    reviewStatus: 'pending',
  });
  for (let index = 0; index < 5; index += 1) {
    insertReviewerPass(rootDir, {
      prNumber: 980 + index,
      attemptNumber: 2,
      passKind: 'rereview',
      status: 'completed',
      startedAt: `2026-05-25T17:${10 + index}:00.000Z`,
      endedAt: `2026-05-25T17:${20 + index}:00.000Z`,
    });
  }

  const snapshot = collectReviewPipelineHealth({
    rootDir,
    now: () => new Date(NOW),
    configOverrides: { reviewLaneShareSupermajorityMinPasses: 5 },
  });

  assert.ok(!snapshot.findings.some((item) => item.code === 'review:review_lane_share_supermajority'));
});

test('lane-share supermajority stays quiet on single-slot reviewer hosts', () => {
  const rootDir = tempRoot();
  seedFreshReconcile(rootDir);
  insertReviewRow(rootDir, {
    prNumber: 970,
    reviewedAt: '2026-05-25T17:40:00.000Z',
    reviewStatus: 'pending',
  });
  insertReviewRow(rootDir, {
    prNumber: 971,
    reviewedAt: '2026-05-25T17:39:00.000Z',
    reviewStatus: 'pending',
  });
  for (let index = 0; index < 5; index += 1) {
    insertReviewerPass(rootDir, {
      prNumber: 980 + index,
      attemptNumber: 2,
      passKind: 'rereview',
      status: 'completed',
      startedAt: `2026-05-25T17:${10 + (index * 2)}:00.000Z`,
      endedAt: `2026-05-25T17:${11 + (index * 2)}:00.000Z`,
    });
  }

  const snapshot = collectReviewPipelineHealth({
    rootDir,
    now: () => new Date(NOW),
    configOverrides: { reviewLaneShareSupermajorityMinPasses: 5 },
  });

  assert.equal(snapshot.reviewerCapacity.effectiveConcurrency, 1);
  assert.ok(!snapshot.findings.some((item) => item.code === 'review:review_lane_share_supermajority'));
});

test('lane-share supermajority requires distinct queued PR evidence', () => {
  const rootDir = tempRoot();
  seedFreshReconcile(rootDir);
  insertReviewRow(rootDir, {
    prNumber: 970,
    reviewedAt: '2026-05-25T17:40:00.000Z',
    reviewStatus: 'pending',
  });
  for (let index = 0; index < 4; index += 1) {
    insertReviewerPass(rootDir, {
      prNumber: 980 + index,
      attemptNumber: 2,
      passKind: 'rereview',
      status: 'completed',
      startedAt: `2026-05-25T17:${10 + index}:00.000Z`,
      endedAt: `2026-05-25T17:${20 + index}:00.000Z`,
    });
  }
  insertReviewerPass(rootDir, {
    prNumber: 984,
    attemptNumber: 1,
    passKind: 'first-pass',
    status: 'completed',
    startedAt: '2026-05-25T17:20:00.000Z',
    endedAt: '2026-05-25T17:21:00.000Z',
  });

  const snapshot = collectReviewPipelineHealth({
    rootDir,
    now: () => new Date(NOW),
    configOverrides: { reviewLaneShareSupermajorityMinPasses: 5 },
  });

  assert.ok(!snapshot.findings.some((item) => item.code === 'review:review_lane_share_supermajority'));
});

test('lane-share supermajority stays quiet when the other lane is empty', () => {
  const rootDir = tempRoot();
  for (let index = 0; index < 5; index += 1) {
    insertReviewerPass(rootDir, {
      prNumber: 990 + index,
      attemptNumber: 2,
      passKind: 'rereview',
      status: 'completed',
      startedAt: `2026-05-25T17:${10 + index}:00.000Z`,
      endedAt: `2026-05-25T17:${11 + index}:00.000Z`,
    });
  }

  const snapshot = collectReviewPipelineHealth({
    rootDir,
    now: () => new Date(NOW),
    configOverrides: { reviewLaneShareSupermajorityMinPasses: 5 },
  });

  assert.ok(!snapshot.findings.some((item) => item.code === 'review:review_lane_share_supermajority'));
});

test('rereview lane unfair-share definition has an emitted finding path', () => {
  const rootDir = tempRoot();
  for (let index = 0; index < 3; index += 1) {
    insertReviewerPass(rootDir, {
      prNumber: 990,
      attemptNumber: index + 2,
      passKind: 'rereview',
      status: 'completed',
      startedAt: `2026-05-25T17:${10 + index}:00.000Z`,
      endedAt: `2026-05-25T17:${11 + index}:00.000Z`,
    });
  }
  insertReviewerPass(rootDir, {
    prNumber: 991,
    attemptNumber: 2,
    passKind: 'rereview',
    status: 'completed',
    startedAt: '2026-05-25T17:20:00.000Z',
    endedAt: '2026-05-25T17:21:00.000Z',
  });

  const snapshot = collectReviewPipelineHealth({ rootDir, now: () => new Date(NOW) });
  const finding = snapshot.findings.find((item) => item.code === 'review:rereview_lane_unfair_share');

  assert.ok(finding, findingCodes(snapshot).join(','));
  assert.equal(finding.details.monopolist.prNumber, 990);
  assert.equal(finding.details.totalPasses, 4);
});

test('reviewer capacity skips degenerate intervals without leaking concurrency', () => {
  const rootDir = tempRoot();
  insertReviewerPass(rootDir, {
    prNumber: 963,
    attemptNumber: 1,
    passKind: 'first-pass',
    status: 'completed',
    startedAt: '2026-05-25T17:10:00.000Z',
    endedAt: '2026-05-25T17:10:00.000Z',
  });
  insertReviewerPass(rootDir, {
    prNumber: 964,
    attemptNumber: 1,
    passKind: 'first-pass',
    status: 'completed',
    startedAt: '2026-05-25T17:20:00.000Z',
    endedAt: '2026-05-25T17:25:00.000Z',
  });

  const snapshot = collectReviewPipelineHealth({ rootDir, now: () => new Date(NOW) });

  assert.equal(snapshot.reviewerCapacity.totalPasses, 2);
  assert.equal(snapshot.reviewerCapacity.effectiveConcurrency, 1);
});

test('AFH fallback edge supermajority fires at threshold', () => {
  const rootDir = tempRoot();
  for (let i = 0; i < 4; i += 1) {
    insertReviewerPass(rootDir, {
      prNumber: 980 + i,
      attemptNumber: 1,
      passKind: 'first-pass',
      status: 'completed',
      startedAt: `2026-05-25T17:${10 + i}:00.000Z`,
      endedAt: `2026-05-25T17:${11 + i}:00.000Z`,
      metadata: {
        afhReviewerFallback: {
          fromReviewerModel: 'claude',
          toReviewerModel: 'gemini',
          reason: 'claude-launchctl-asuser-unavailable',
        },
      },
    });
  }
  insertReviewerPass(rootDir, {
    prNumber: 984,
    attemptNumber: 1,
    passKind: 'first-pass',
    status: 'completed',
    startedAt: '2026-05-25T17:20:00.000Z',
    endedAt: '2026-05-25T17:21:00.000Z',
    metadata: {},
  });

  const snapshot = collectReviewPipelineHealth({ rootDir, now: () => new Date(NOW) });

  assert.equal(snapshot.afhFallbackSupermajority.active, true);
  assert.equal(snapshot.afhFallbackSupermajority.dominant.edge, 'claude -> gemini');
  assert.equal(snapshot.afhFallbackSupermajority.dominant.reason, 'claude-launchctl-asuser-unavailable');
  assert.equal(snapshot.afhFallbackSupermajority.dominant.share, 0.8);
  assert.ok(findingCodes(snapshot).includes('review:afh_fallback_edge_supermajority'));
  const finding = snapshot.findings.find(
    (item) => item.code === 'review:afh_fallback_edge_supermajority',
  );
  assert.equal(finding.tier, 'ticket');
  const output = renderReviewPipelinePrometheus(snapshot);
  assert.match(
    output,
    /^review_pipeline_afh_fallback_edge_share\{edge="claude -> gemini",from="claude",to="gemini",reason="claude-launchctl-asuser-unavailable",window="3600000ms"\} 0\.8$/m
  );
  assert.match(output, /^review_pipeline_afh_fallback_supermajority_active 1$/m);
});

test('AFH fallback edge supermajority requires a distinct PR floor', () => {
  const rootDir = tempRoot();
  for (let i = 0; i < 5; i += 1) {
    insertReviewerPass(rootDir, {
      prNumber: 981,
      attemptNumber: i + 1,
      passKind: i % 2 === 0 ? 'first-pass' : 'rereview',
      status: 'completed',
      startedAt: `2026-05-25T17:${10 + i}:00.000Z`,
      endedAt: `2026-05-25T17:${11 + i}:00.000Z`,
      metadata: {
        afhReviewerFallback: {
          fromReviewerModel: 'claude',
          toReviewerModel: 'gemini',
          reason: 'claude-launchctl-asuser-unavailable',
        },
      },
    });
  }

  const snapshot = collectReviewPipelineHealth({ rootDir, now: () => new Date(NOW) });

  assert.equal(snapshot.afhFallbackSupermajority.totalSelections, 5);
  assert.equal(snapshot.afhFallbackSupermajority.dominant.distinctPrs, 1);
  assert.equal(snapshot.afhFallbackSupermajority.distinctPrFloor, 2);
  assert.equal(snapshot.afhFallbackSupermajority.active, false);
  assert.ok(!findingCodes(snapshot).includes('review:afh_fallback_edge_supermajority'));
  assert.match(renderReviewPipelinePrometheus(snapshot), /^review_pipeline_afh_fallback_supermajority_active 0$/m);
});

test('AFH fallback edge supermajority bounds the configured threshold', () => {
  const high = collectReviewPipelineHealth({
    rootDir: tempRoot(),
    now: () => new Date(NOW),
    config: { afhFallbackSupermajorityThreshold: 1.5 },
  });
  assert.equal(high.config.afhFallbackSupermajorityThreshold, 1);

  const low = collectReviewPipelineHealth({
    rootDir: tempRoot(),
    now: () => new Date(NOW),
    config: { afhFallbackSupermajorityThreshold: -0.1 },
  });
  assert.equal(low.config.afhFallbackSupermajorityThreshold, 0.8);
});

test('AFH fallback edge supermajority stays quiet below threshold', () => {
  const rootDir = tempRoot();
  for (let i = 0; i < 3; i += 1) {
    insertReviewerPass(rootDir, {
      prNumber: 990 + i,
      attemptNumber: 1,
      passKind: 'first-pass',
      status: 'completed',
      startedAt: `2026-05-25T17:${10 + i}:00.000Z`,
      endedAt: `2026-05-25T17:${11 + i}:00.000Z`,
      metadata: {
        afhReviewerFallback: {
          fromReviewerModel: 'claude',
          toReviewerModel: 'gemini',
          reason: 'claude-launchctl-asuser-unavailable',
        },
      },
    });
  }
  insertReviewerPass(rootDir, {
    prNumber: 994,
    attemptNumber: 1,
    passKind: 'first-pass',
    status: 'completed',
    startedAt: '2026-05-25T17:20:00.000Z',
    endedAt: '2026-05-25T17:21:00.000Z',
    metadata: {},
  });
  insertReviewerPass(rootDir, {
    prNumber: 995,
    attemptNumber: 1,
    passKind: 'first-pass',
    status: 'completed',
    startedAt: '2026-05-25T17:22:00.000Z',
    endedAt: '2026-05-25T17:23:00.000Z',
    metadata: {},
  });

  const snapshot = collectReviewPipelineHealth({ rootDir, now: () => new Date(NOW) });

  assert.equal(snapshot.afhFallbackSupermajority.totalSelections, 5);
  assert.equal(snapshot.afhFallbackSupermajority.dominant.share, 0.6);
  assert.equal(snapshot.afhFallbackSupermajority.active, false);
  assert.ok(!findingCodes(snapshot).includes('review:afh_fallback_edge_supermajority'));
  assert.match(renderReviewPipelinePrometheus(snapshot), /^review_pipeline_afh_fallback_supermajority_active 0$/m);
});

test('queue starvation default threshold is 10m, not 30m', () => {
  // At the old 30m default the alarm was silent through a visible pile-up: 11
  // open PRs, first-pass depth 4, oldest pending 19.4m after its reviewer exited
  // 1. A first-review SLA in tens of minutes does not describe a fleet that
  // reviews within ~3 minutes when healthy.
  const rootDir = tempRoot();
  insertReviewRow(rootDir, {
    prNumber: 947,
    reviewStatus: 'pending',
    // 20 minutes before NOW: over a 10m bar, under a 30m one.
    reviewedAt: new Date(Date.parse(NOW) - 20 * 60 * 1000).toISOString(),
  });

  // Default config — no explicit threshold passed.
  const withDefault = collectReviewPipelineHealth({ rootDir, now: () => new Date(NOW) });
  assert.ok(
    findingCodes(withDefault).includes('review:queue_starvation'),
    'a 20m-old pending first-pass review must fire on the DEFAULT threshold',
  );

  const atOldThreshold = collectReviewPipelineHealth({
    rootDir,
    now: () => new Date(NOW),
    config: { queueStarvationMaxAgeMs: 30 * 60 * 1000 },
  });
  assert.ok(
    !findingCodes(atOldThreshold).includes('review:queue_starvation'),
    'sanity: the same row is silent at the old 30m threshold',
  );
});

test('queue starvation distinguishes a FAILED reviewer from an unstarted one', () => {
  // The two cases need different operator responses: a reviewer that ran and
  // exited non-zero is a runtime problem (a blind retrigger reproduces it),
  // whereas a row nothing picked up is a watcher/capacity problem.
  const rootDir = tempRoot();
  insertReviewRow(rootDir, {
    prNumber: 948,
    reviewStatus: 'pending',
    reviewedAt: '2026-05-25T17:00:00.000Z',
  });
  const db = openDb(rootDir);
  try {
    db.prepare(
      'UPDATE reviewed_prs SET failed_at = ?, failure_message = ?, review_attempts = ? '
      + 'WHERE pr_number = ?',
    ).run('2026-05-25T17:02:00.000Z', 'Command failed with code 1', 1, 948);
  } finally {
    db.close();
  }

  seedFreshReconcile(rootDir);
  const snapshot = collectReviewPipelineHealth({ rootDir, now: () => new Date(NOW) });
  const finding = snapshot.findings.find((item) => item.code === 'review:queue_starvation');
  assert.ok(finding, 'expected the starvation finding');
  assert.equal(finding.details.mirrorVerified, true);
  assert.match(finding.message, /reviewer FAILED/);
  assert.match(finding.message, /Command failed with code 1/);
  assert.match(finding.recommended_action, /reviewer-runtime, not capacity/);
  assert.equal(finding.details.reviewerFailed, true);
  assert.equal(finding.details.reviewAttempts, 1);
  assert.equal(finding.details.failedCount, 1);
  // Depth belongs in the subject so the pile-up size is visible at a glance.
  assert.match(finding.subject, /1 PR\(s\) awaiting first-pass review/);
});

test('queue starvation on an unverified mirror row stops blaming reviewer capacity', () => {
  // TREC-01 / SEV2 2026-09-07. agent-os#6394 was CLOSED at 05:50:15Z and was
  // still `firstPassQueue.oldest` at 06:18:52Z -- one of only three entries, so
  // a third of the reported depth was phantom. The finding told the operator to
  // check reviewer capacity and bounce the adversarial-watcher. The watcher was
  // healthy; the advice was actively wrong.
  //
  // The finding still fires (a genuinely starved queue must page). What changes
  // is that it now says the row is unverified and tells the operator to confirm
  // terminal state FIRST.
  const rootDir = tempRoot();
  insertReviewRow(rootDir, {
    prNumber: 6394,
    reviewStatus: 'pending',
    reviewedAt: '2026-05-25T17:00:00.000Z',
  });
  seedFreshReconcile(rootDir, {
    unresolved: [{
      repo: 'laceyenterprises/adversarial-review',
      prNumber: 6394,
      reason: 'Command failed: gh api -i graphql — gh: Bad credentials (HTTP 401)',
    }],
  });

  const snapshot = collectReviewPipelineHealth({ rootDir, now: () => new Date(NOW) });
  const finding = snapshot.findings.find((item) => item.code === 'review:queue_starvation');
  assert.ok(finding, 'the finding must NOT be suppressed — a real starved queue still pages');
  assert.equal(finding.details.mirrorVerified, false);
  assert.match(finding.subject, /mirror state UNVERIFIED against GitHub/);
  assert.match(finding.recommended_action, /may be a PR that is already merged or closed/);
  assert.match(finding.recommended_action, /do not bounce the watcher on this signal alone/);
  assert.equal(
    /check adversarial-watcher liveness and reviewer capacity/.test(finding.recommended_action),
    false,
    'an unverified row must not carry the bounce-the-watcher advice',
  );

  // And the cause is reported alongside the symptom, naming the real fault.
  const blind = snapshot.findings.find((item) => item.code === 'review:pr_lifecycle_mirror_unverified');
  assert.ok(blind, 'the mirror-unverified cause must be reported');
  assert.match(blind.evidence.join('\n'), /Bad credentials \(HTTP 401\)/);
});

test('a mirror reconciled inside the staleness window emits no blindness finding', () => {
  const rootDir = tempRoot();
  insertReviewRow(rootDir, { prNumber: 950, reviewStatus: 'posted', postedAt: NOW });
  seedFreshReconcile(rootDir);
  const snapshot = collectReviewPipelineHealth({ rootDir, now: () => new Date(NOW) });
  assert.equal(
    findingCodes(snapshot).includes('review:pr_lifecycle_mirror_unverified'),
    false,
  );
  assert.equal(snapshot.lifecycleReconciliation.blind, false);
  assert.equal(snapshot.lifecycleReconciliation.observedAt, NOW);
});

test('a stale reconciliation record reports blind without touching either threshold', () => {
  const rootDir = tempRoot();
  insertReviewRow(rootDir, { prNumber: 951, reviewStatus: 'posted', postedAt: NOW });
  // Two hours before NOW, far outside the 15m window.
  seedFreshReconcile(rootDir, { observedAt: '2026-05-25T16:00:00.000Z' });
  const snapshot = collectReviewPipelineHealth({ rootDir, now: () => new Date(NOW) });
  const blind = snapshot.findings.find((item) => item.code === 'review:pr_lifecycle_mirror_unverified');
  assert.ok(blind);
  assert.equal(blind.details.reason, 'reconcile-record-stale');
  // The explicit ticket constraint: never widen a threshold to hide this.
  assert.equal(snapshot.config.queueStarvationMaxAgeMs, 600000);
  assert.match(blind.recommended_action, /rather than adjusting either threshold/);
  assert.match(blind.recommended_action, /Do not silence the age-based findings/);
});

test('queue starvation reports an unstarted row as capacity, not reviewer failure', () => {
  const rootDir = tempRoot();
  insertReviewRow(rootDir, {
    prNumber: 949,
    reviewStatus: 'pending',
    reviewedAt: '2026-05-25T17:00:00.000Z',
  });
  seedFreshReconcile(rootDir);
  const snapshot = collectReviewPipelineHealth({ rootDir, now: () => new Date(NOW) });
  const finding = snapshot.findings.find((item) => item.code === 'review:queue_starvation');
  assert.ok(finding);
  assert.equal(finding.details.mirrorVerified, true);
  assert.match(finding.message, /no reviewer has picked it up/);
  assert.match(finding.recommended_action, /Nothing picked this up/);
  assert.equal(finding.details.reviewerFailed, false);
});

test('terminal reconciliation evicts an out-of-band closed PR from first-pass queue alerts', () => {
  const rootDir = tempRoot();
  insertReviewRow(rootDir, {
    prNumber: 6394,
    reviewStatus: 'pending',
    reviewedAt: '2026-05-25T17:00:00.000Z',
  });

  const snapshot = collectReviewPipelineHealth({
    rootDir,
    now: () => new Date(NOW),
    reconcileTerminalState: true,
    fetchPRTerminalStateSyncImpl: (repo, prNumber) => {
      assert.equal(repo, REPO);
      assert.equal(prNumber, 6394);
      return {
        state: 'CLOSED',
        mergedAt: null,
        closedAt: '2026-05-25T17:30:00.000Z',
      };
    },
  });

  assert.ok(!findingCodes(snapshot).includes('review:queue_starvation'));
  assert.equal(snapshot.firstPassQueue.depth, 0);
  assert.equal(snapshot.terminalReconciliation.reconciled, 1);
  assert.equal(snapshot.terminalReconciliation.updated[0].githubObservedState, 'closed');

  const db = openDb(rootDir);
  try {
    const row = db.prepare(
      'SELECT pr_state, closed_at FROM reviewed_prs WHERE repo = ? AND pr_number = ?'
    ).get(REPO, 6394);
    assert.equal(row.pr_state, 'closed');
    assert.equal(row.closed_at, '2026-05-25T17:30:00.000Z');
  } finally {
    db.close();
  }
});

test('terminal reconciliation resolves an out-of-band merged terminal-unmerged flag', () => {
  const rootDir = tempRoot();
  insertReviewRow(rootDir, {
    prNumber: 6364,
    reviewStatus: 'posted',
    postedAt: '2026-05-25T17:10:00.000Z',
    reviewedAt: '2026-05-25T17:00:00.000Z',
  });
  insertReviewerPass(rootDir, {
    prNumber: 6364,
    attemptNumber: 1,
    passKind: 'first-pass',
    startedAt: '2026-05-25T17:05:00.000Z',
    endedAt: '2026-05-25T17:10:00.000Z',
    status: 'completed',
    metadata: {},
  });
  const dbForVerdict = openDb(rootDir);
  try {
    dbForVerdict.prepare(
      "UPDATE reviewer_passes SET verdict = 'approved' WHERE repo = ? AND pr_number = ?"
    ).run(REPO, 6364);
  } finally {
    dbForVerdict.close();
  }
  insertActiveTtmFlag(rootDir, { prNumber: 6364 });

  const snapshot = collectReviewPipelineHealth({
    rootDir,
    now: () => new Date(NOW),
    reconcileTerminalState: true,
    config: { ttm: { terminalUnmergedMinutes: 10 } },
    fetchPRTerminalStateSyncImpl: (repo, prNumber) => {
      assert.equal(repo, REPO);
      assert.equal(prNumber, 6364);
      return {
        state: 'MERGED',
        mergedAt: '2026-05-25T17:35:00.000Z',
        closedAt: '2026-05-25T17:35:00.000Z',
      };
    },
  });

  assert.ok(!findingCodes(snapshot).includes('review:terminal_but_unmerged'));
  assert.equal(snapshot.ttm.flags.some((flag) => flag.prNumber === 6364), false);
  assert.equal(snapshot.terminalReconciliation.reconciled, 1);
  assert.equal(snapshot.terminalReconciliation.resolvedFlags, 1);

  const db = openDb(rootDir);
  try {
    const row = db.prepare(
      'SELECT pr_state, merged_at FROM reviewed_prs WHERE repo = ? AND pr_number = ?'
    ).get(REPO, 6364);
    assert.equal(row.pr_state, 'merged');
    assert.equal(row.merged_at, '2026-05-25T17:35:00.000Z');
    const flag = db.prepare(
      'SELECT state, resolved_at, merged_at, details_json FROM ttm_flag_state WHERE event_key = ?'
    ).get(`${REPO}#6364:terminal_but_unmerged`);
    assert.equal(flag.state, 'resolved');
    assert.equal(flag.resolved_at, NOW);
    assert.equal(flag.merged_at, '2026-05-25T17:35:00.000Z');
    assert.equal(JSON.parse(flag.details_json).githubObservedState, 'merged');
  } finally {
    db.close();
  }
});

test('terminal reconciliation retries transient gh failures before reconciling', () => {
  const rootDir = tempRoot();
  insertReviewRow(rootDir, {
    prNumber: 6395,
    reviewStatus: 'pending',
    reviewedAt: '2026-05-25T17:00:00.000Z',
  });
  let attempts = 0;
  const sleeps = [];

  const snapshot = collectReviewPipelineHealth({
    rootDir,
    now: () => new Date(NOW),
    reconcileTerminalState: true,
    sleepSyncImpl: (delayMs) => sleeps.push(delayMs),
    execFileSyncImpl: (command, args) => {
      assert.equal(command, 'gh');
      assert.deepEqual(args, [
        'pr', 'view', '6395', '--repo', REPO, '--json', 'state,mergedAt,closedAt',
      ]);
      attempts += 1;
      if (attempts < 3) {
        const error = new Error('TLS handshake timeout');
        error.stderr = 'TLS handshake timeout';
        throw error;
      }
      return JSON.stringify({
        state: 'CLOSED',
        mergedAt: null,
        closedAt: '2026-05-25T17:40:00.000Z',
      });
    },
  });

  assert.equal(attempts, 3);
  assert.deepEqual(sleeps, [100, 250]);
  assert.equal(snapshot.terminalReconciliation.errors.length, 0);
  assert.equal(snapshot.terminalReconciliation.reconciled, 1);
});

test('terminal reconciliation refuses writable reviews.db when caller uid differs from owner', () => {
  if (typeof process.getuid !== 'function') return;

  const rootDir = tempRoot();
  insertReviewRow(rootDir, {
    prNumber: 6396,
    reviewStatus: 'pending',
    reviewedAt: '2026-05-25T17:00:00.000Z',
  });
  const originalDescriptor = Object.getOwnPropertyDescriptor(process, 'getuid');
  const originalGetuid = process.getuid;
  Object.defineProperty(process, 'getuid', {
    configurable: true,
    value: () => originalGetuid.call(process) + 1,
  });
  try {
    const snapshot = collectReviewPipelineHealth({
      rootDir,
      now: () => new Date(NOW),
      reconcileTerminalState: true,
      fetchPRTerminalStateSyncImpl: () => {
        throw new Error('should not fetch before ownership guard');
      },
    });
    assert.match(
      snapshot.terminalReconciliation.errors[0]?.error || '',
      /refusing cross-user review state database write/,
    );
  } finally {
    if (originalDescriptor) {
      Object.defineProperty(process, 'getuid', originalDescriptor);
    } else {
      delete process.getuid;
    }
  }
});

test('an in-flight review does not count as starvation', () => {
  // `summarizeFirstPassQueue` selects only review_status='pending'. A review that
  // is actually RUNNING must never trip the alarm, or a 10m bar would page on
  // every slow-but-healthy review.
  const rootDir = tempRoot();
  insertReviewRow(rootDir, {
    prNumber: 950,
    reviewStatus: 'reviewing',
    reviewedAt: '2026-05-25T16:00:00.000Z',
  });
  const snapshot = collectReviewPipelineHealth({ rootDir, now: () => new Date(NOW) });
  assert.ok(!findingCodes(snapshot).includes('review:queue_starvation'));
  assert.equal(snapshot.firstPassQueue.depth, 0);
});

test('CI-blocked rereviews do not count as starvation and get their own finding', () => {
  const rootDir = tempRoot();
  insertReviewRow(rootDir, {
    prNumber: 951,
    reviewStatus: REREVIEW_CI_BLOCKED_STATUS,
    reviewedAt: '2026-05-25T16:00:00.000Z',
    lastAttemptedAt: '2026-05-25T16:05:00.000Z',
    failedAt: '2026-05-25T16:05:00.000Z',
    failureMessage: '[ci-regression-no-job] public-clone-readiness=FAILURE',
  });
  const snapshot = collectReviewPipelineHealth({ rootDir, now: () => new Date(NOW) });

  assert.ok(!findingCodes(snapshot).includes('review:queue_starvation'));
  assert.equal(snapshot.firstPassQueue.depth, 0);
  assert.equal(snapshot.ciBlockedRereviews.count, 1);
  assert.equal(snapshot.ciBlockedRereviews.oldest.prNumber, 951);
  const finding = snapshot.findings.find((item) => item.code === 'review:rereview_ci_blocked');
  assert.equal(finding.tier, 'ticket');
  assert.match(finding.message, /review_status='ci-blocked'/);
  assert.match(finding.recommended_action, /Fix the failing external CI/);

  const output = renderReviewPipelinePrometheus(snapshot);
  assert.match(output, /^review_pipeline_ci_blocked_rereviews 1$/m);
});

test('a rereview deferred behind active remediation is not first-pass starvation', () => {
  const rootDir = tempRoot();
  insertReviewRow(rootDir, {
    prNumber: 6803,
    reviewStatus: 'pending',
    reviewedAt: '2026-05-25T16:00:00.000Z',
    lastAttemptedAt: '2026-05-25T16:05:00.000Z',
    postedAt: '2026-05-25T15:45:00.000Z',
    reviewAttempts: 1,
    failedAt: '2026-05-25T16:05:00.000Z',
    failureMessage: '[ci-regression-requeued] CFG schema parity=FAILURE, repo-guards=FAILURE',
  });
  writeJob(rootDir, 'in-progress', 'job-6803', {
    kind: 'adversarial-review-follow-up',
    jobId: 'laceyenterprises__agent-os-pr-6803-2026-09-14T04-27-38-241Z',
    repo: REPO,
    prNumber: 6803,
    createdAt: '2026-05-25T16:10:00.000Z',
    claimedAt: '2026-05-25T16:12:00.000Z',
  });
  seedFreshReconcile(rootDir);

  const snapshot = collectReviewPipelineHealth({ rootDir, now: () => new Date(NOW) });
  assert.ok(!findingCodes(snapshot).includes('review:queue_starvation'));
  assert.equal(snapshot.firstPassQueue.firstPassPrs.length, 0);
  assert.equal(snapshot.deferredRereviews.count, 1);
  assert.equal(snapshot.deferredRereviews.oldest.reason, 'active-follow-up-job');
  assert.equal(snapshot.deferredRereviews.oldest.reviewAttempts, 1);
  assert.equal(snapshot.deferredRereviews.oldest.jobKind, 'adversarial-review-follow-up');
  assert.equal(snapshot.deferredRereviews.oldest.jobAgeMs, 108 * 60 * 1000);
  const finding = snapshot.findings.find((item) => item.code === 'review:rereview_deferred');
  assert.equal(finding.tier, 'ticket');
  assert.match(finding.message, /waiting on purpose: active-follow-up-job/);
  assert.equal(finding.details.prs[0].jobPath, undefined);
  assert.match(finding.evidence[0], /job_age=6480000ms/);
  assert.match(finding.recommended_action, /active follow-up job/);
  assert.equal(
    /check adversarial-watcher liveness and reviewer capacity/.test(finding.recommended_action),
    false,
  );
  assert.equal(
    snapshot.firstPassQueue.firstPassPrs.length
      + snapshot.deferredRereviews.count
      + snapshot.queuedRereviews.count,
    snapshot.firstPassQueue.pendingDepth,
  );
  const output = renderReviewPipelinePrometheus(snapshot);
  assert.match(output, /^review_pipeline_first_pass_queue_depth 0$/m);
  assert.match(output, /^review_pipeline_pending_queue_depth 1$/m);
});

test('stopped CI regression classifier matches structured and producer-derived stop metadata', () => {
  assert.equal(stoppedJobIsCiRegressionStopped({
    remediationPlan: {
      stop: {
        code: 'max-rounds-reached',
        reason: 'Reached max remediation rounds (3/3). Operator stopped after unrelated failure.',
        ciRegression: true,
      },
    },
  }), true);
  assert.equal(stoppedJobIsCiRegressionStopped({
    reason: producerShapedCiRegressionStopReason(),
    remediationPlan: {
      stop: {
        code: 'max-rounds-reached',
        reason: producerShapedCiRegressionStopReason(),
      },
    },
  }), true);
  assert.equal(stoppedJobIsCiRegressionStopped({
    reason: producerShapedCiRegressionStopReason(),
    remediationPlan: {
      stop: {
        code: 'max-rounds-reached',
        reason: 'Reached max remediation rounds (3/3). Operator stopped after unrelated failure.',
      },
    },
  }), false);
});

test('a CI-stopped rereview with a production-shaped stopped job is not first-pass starvation', () => {
  const rootDir = tempRoot();
  insertReviewRow(rootDir, {
    prNumber: 6838,
    reviewStatus: 'pending',
    reviewedAt: '2026-05-25T11:14:00.000Z',
    lastAttemptedAt: '2026-05-25T16:05:00.000Z',
    reviewAttempts: 0,
    failedAt: '2026-05-25T16:05:00.000Z',
    reviewerHeadSha: 'ci-stopped-head',
  });
  insertReviewerPass(rootDir, {
    prNumber: 6838,
    attemptNumber: 1,
    passKind: 'rereview',
    status: 'failed',
    startedAt: '2026-05-25T16:04:00.000Z',
    endedAt: '2026-05-25T16:05:00.000Z',
    headSha: 'ci-stopped-head',
    metadata: { failureClass: 'ci-regression-stopped' },
  });
  writeJob(rootDir, 'stopped', 'job-6838', {
    kind: 'adversarial-review-follow-up',
    jobId: 'laceyenterprises__agent-os-pr-6838-2026-09-14T16-19-41-000Z',
    repo: REPO,
    prNumber: 6838,
    createdAt: '2026-05-25T15:55:00.000Z',
    stoppedAt: '2026-05-25T16:05:00.000Z',
    remediationPlan: {
      stop: {
        code: 'max-rounds-reached',
        reason: producerShapedCiRegressionStopReason(),
        ciRegression: true,
        stoppedAt: '2026-05-25T16:05:00.000Z',
      },
    },
  });
  seedFreshReconcile(rootDir);

  const snapshot = collectReviewPipelineHealth({
    rootDir,
    now: () => new Date(NOW),
    config: { queueStarvationMaxAgeMs: 10 * 60 * 1000 },
  });

  assert.ok(!findingCodes(snapshot).includes('review:queue_starvation'));
  assert.equal(snapshot.firstPassQueue.firstPassPrs.length, 0);
  assert.equal(snapshot.deferredRereviews.count, 1);
  assert.equal(snapshot.deferredRereviews.oldest.prNumber, 6838);
  assert.equal(snapshot.deferredRereviews.oldest.passKind, 'rereview');
  assert.equal(snapshot.deferredRereviews.oldest.reason, 'ci-regression-stopped');
  assert.equal(snapshot.deferredRereviews.oldest.reviewAttempts, 1);
  assert.equal(snapshot.deferredRereviews.oldest.reviewerClaimStarts, 1);
  assert.equal(snapshot.deferredRereviews.oldest.claimedAndReleased, true);
  assert.equal(snapshot.queuedRereviews.count, 0);
  const finding = snapshot.findings.find((item) => item.code === 'review:rereview_deferred');
  assert.match(finding?.recommended_action, /No follow-up job is running/);
  assert.match(finding?.recommended_action, /requeue remediation or re-arm re-review manually/);
});

test('a released ci-head-moved rereview claim is deferred, not first-pass starvation', () => {
  const rootDir = tempRoot();
  insertReviewRow(rootDir, {
    prNumber: 6827,
    reviewStatus: 'pending',
    reviewedAt: '2026-05-25T01:56:00.000Z',
    lastAttemptedAt: '2026-05-25T02:01:00.000Z',
    reviewAttempts: 0,
    failedAt: '2026-05-25T02:01:00.000Z',
    failureMessage: 'Released reviewer claim after ci-head-moved.',
    reviewerHeadSha: '247bc7c2b10e',
  });
  insertReviewerPass(rootDir, {
    prNumber: 6827,
    attemptNumber: 1,
    passKind: 'rereview',
    status: 'failed',
    startedAt: '2026-05-25T02:00:00.000Z',
    endedAt: '2026-05-25T02:01:00.000Z',
    headSha: '247bc7c2b10e',
    metadata: {
      failureClass: 'ci-head-moved',
      claimedHeadSha: '247bc7c2b10e',
      observedCiHeadSha: 'a03767026514',
    },
  });
  seedFreshReconcile(rootDir);

  const snapshot = collectReviewPipelineHealth({
    rootDir,
    now: () => new Date(NOW),
    config: { queueStarvationMaxAgeMs: 10 * 60 * 1000 },
  });

  assert.ok(!findingCodes(snapshot).includes('review:queue_starvation'));
  assert.equal(snapshot.firstPassQueue.firstPassPrs.length, 0);
  assert.equal(snapshot.deferredRereviews.count, 1);
  assert.equal(snapshot.deferredRereviews.oldest.prNumber, 6827);
  assert.equal(snapshot.deferredRereviews.oldest.passKind, 'rereview');
  assert.equal(snapshot.deferredRereviews.oldest.derivedPassKind, 'first-pass');
  assert.equal(snapshot.deferredRereviews.oldest.reason, 'ci-head-moved');
  assert.equal(snapshot.deferredRereviews.oldest.reviewAttempts, 1);
  assert.equal(snapshot.deferredRereviews.oldest.reviewerClaimStarts, 1);
  assert.equal(snapshot.deferredRereviews.oldest.claimedAndReleased, true);
  assert.equal(snapshot.deferredRereviews.oldest.jobState, null);
  assert.equal(snapshot.queuedRereviews.count, 0);
  const finding = snapshot.findings.find((item) => item.code === 'review:rereview_deferred');
  assert.match(finding?.message, /waiting on purpose: ci-head-moved/);
  assert.match(finding?.evidence[0], /attempts=1/);
});

test('a released rereview claim without metadata is still deferred', () => {
  const rootDir = tempRoot();
  allowNullReviewerPassMetadata(rootDir);
  insertReviewRow(rootDir, {
    prNumber: 6828,
    reviewStatus: 'pending',
    reviewedAt: '2026-05-25T01:56:00.000Z',
    lastAttemptedAt: '2026-05-25T02:01:00.000Z',
    reviewAttempts: 0,
    failedAt: '2026-05-25T02:01:00.000Z',
    failureMessage: 'Released reviewer claim after ci-head-moved.',
    reviewerHeadSha: '247bc7c2b10e',
  });
  insertReviewerPass(rootDir, {
    prNumber: 6828,
    attemptNumber: 1,
    passKind: 'rereview',
    status: 'failed',
    startedAt: '2026-05-25T02:00:00.000Z',
    endedAt: '2026-05-25T02:01:00.000Z',
    headSha: '247bc7c2b10e',
    metadataJson: null,
  });
  seedFreshReconcile(rootDir);

  const snapshot = collectReviewPipelineHealth({
    rootDir,
    now: () => new Date(NOW),
    config: { queueStarvationMaxAgeMs: 10 * 60 * 1000 },
  });

  assert.ok(!findingCodes(snapshot).includes('review:queue_starvation'));
  assert.equal(snapshot.firstPassQueue.firstPassPrs.length, 0);
  assert.equal(snapshot.deferredRereviews.count, 1);
  assert.equal(snapshot.deferredRereviews.oldest.prNumber, 6828);
  assert.equal(snapshot.deferredRereviews.oldest.passKind, 'rereview');
  assert.equal(snapshot.deferredRereviews.oldest.reason, 'Released reviewer claim after ci-head-moved.');
  assert.equal(snapshot.deferredRereviews.oldest.reviewAttempts, 1);
  assert.equal(snapshot.deferredRereviews.oldest.reviewerClaimStarts, 1);
  assert.equal(snapshot.deferredRereviews.oldest.claimedAndReleased, true);
  assert.equal(snapshot.queuedRereviews.count, 0);
});

test('rereview claim counts are scoped to the current reviewer head', () => {
  const rootDir = tempRoot();
  insertReviewRow(rootDir, {
    prNumber: 6829,
    reviewStatus: 'pending',
    reviewedAt: '2026-05-25T01:56:00.000Z',
    lastAttemptedAt: '2026-05-25T02:01:00.000Z',
    rereviewRequestedAt: '2026-05-25T02:02:00.000Z',
    reviewAttempts: 1,
    reviewerHeadSha: 'current-head',
  });
  insertReviewRow(rootDir, {
    prNumber: 6830,
    reviewStatus: 'pending',
    reviewedAt: '2026-05-25T01:56:00.000Z',
    lastAttemptedAt: '2026-05-25T02:01:00.000Z',
    rereviewRequestedAt: '2026-05-25T02:02:00.000Z',
    reviewAttempts: 1,
    reviewerHeadSha: 'current-head',
  });
  for (const prNumber of [6829, 6830]) {
    insertReviewerPasses(rootDir, [
      ...Array.from({ length: 5 }, (_, index) => ({
        prNumber,
        attemptNumber: index + 1,
        passKind: 'rereview',
        status: 'failed',
        startedAt: `2026-05-25T01:0${index}:00.000Z`,
        endedAt: `2026-05-25T01:0${index}:30.000Z`,
        headSha: 'old-head',
      })),
      {
        prNumber,
        attemptNumber: 6,
        passKind: 'rereview',
        status: 'failed',
        startedAt: '2026-05-25T02:00:00.000Z',
        endedAt: '2026-05-25T02:01:00.000Z',
        headSha: 'current-head',
      },
    ]);
  }
  writeJob(rootDir, 'pending', 'job-6829', {
    kind: 'adversarial-review-follow-up',
    jobId: 'laceyenterprises__agent-os-pr-6829-2026-09-14T16-19-41-000Z',
    repo: REPO,
    prNumber: 6829,
    createdAt: '2026-05-25T02:03:00.000Z',
  });
  seedFreshReconcile(rootDir);

  const snapshot = collectReviewPipelineHealth({
    rootDir,
    now: () => new Date(NOW),
    config: { queueStarvationMaxAgeMs: 10 * 60 * 1000 },
  });

  assert.equal(snapshot.deferredRereviews.count, 1);
  assert.equal(snapshot.deferredRereviews.oldest.prNumber, 6829);
  assert.equal(snapshot.deferredRereviews.oldest.reviewAttempts, 1);
  assert.equal(snapshot.deferredRereviews.oldest.reviewerClaimStarts, 1);
  assert.equal(snapshot.deferredRereviews.oldest.claimedAndReleased, false);
  assert.equal(snapshot.queuedRereviews.count, 1);
  assert.equal(snapshot.queuedRereviews.oldest.prNumber, 6830);
  assert.equal(snapshot.queuedRereviews.oldest.reviewAttempts, 1);
  assert.equal(snapshot.queuedRereviews.oldest.reviewerClaimStarts, 1);
  assert.equal(snapshot.queuedRereviews.oldest.claimedAndReleased, false);
});

test('a stopped CI regression job older than the rereview request does not defer the queue', () => {
  const rootDir = tempRoot();
  insertReviewRow(rootDir, {
    prNumber: 6839,
    reviewStatus: 'pending',
    reviewedAt: '2026-05-25T11:14:00.000Z',
    lastAttemptedAt: '2026-05-25T12:00:00.000Z',
    reviewAttempts: 0,
    failedAt: '2026-05-25T12:00:00.000Z',
    rereviewRequestedAt: '2026-05-25T16:00:00.000Z',
  });
  insertReviewerPass(rootDir, {
    prNumber: 6839,
    attemptNumber: 1,
    passKind: 'rereview',
    status: 'failed',
    startedAt: '2026-05-25T11:59:00.000Z',
    endedAt: '2026-05-25T12:00:00.000Z',
    metadata: { failureClass: 'ci-regression-stopped' },
  });
  writeJob(rootDir, 'stopped', 'job-6839', {
    kind: 'adversarial-review-follow-up',
    jobId: 'laceyenterprises__agent-os-pr-6839-2026-09-14T12-00-00-000Z',
    repo: REPO,
    prNumber: 6839,
    createdAt: '2026-05-25T11:50:00.000Z',
    stoppedAt: '2026-05-25T12:00:00.000Z',
    remediationPlan: {
      stop: {
        code: 'max-rounds-reached',
        reason: producerShapedCiRegressionStopReason({ prNumber: 6839 }),
        ciRegression: true,
        stoppedAt: '2026-05-25T12:00:00.000Z',
      },
    },
  });
  seedFreshReconcile(rootDir);

  const snapshot = collectReviewPipelineHealth({
    rootDir,
    now: () => new Date(NOW),
    config: { queueStarvationMaxAgeMs: 10 * 60 * 1000 },
  });

  assert.equal(snapshot.deferredRereviews.count, 0);
  assert.equal(snapshot.queuedRereviews.count, 1);
  assert.equal(snapshot.queuedRereviews.oldest.prNumber, 6839);
  assert.equal(snapshot.queuedRereviews.oldest.requestedAt, '2026-05-25T16:00:00.000Z');
  assert.equal(snapshot.queuedRereviews.oldest.readinessSource, 'rereview-requested');
});

test('a stopped job without CI evidence stays in the watcher lane', () => {
  const rootDir = tempRoot();
  insertReviewRow(rootDir, {
    prNumber: 6840,
    reviewStatus: 'pending',
    reviewedAt: '2026-05-25T11:14:00.000Z',
    lastAttemptedAt: '2026-05-25T16:05:00.000Z',
    reviewAttempts: 0,
    failedAt: '2026-05-25T16:05:00.000Z',
    failureMessage: '[operator-cancelled] follow-up job stopped by hand',
  });
  insertReviewerPass(rootDir, {
    prNumber: 6840,
    attemptNumber: 1,
    passKind: 'rereview',
    status: 'failed',
    startedAt: '2026-05-25T16:04:00.000Z',
    endedAt: '2026-05-25T16:05:00.000Z',
    metadata: { failureClass: 'operator-cancelled' },
  });
  writeJob(rootDir, 'stopped', 'job-6840', {
    kind: 'adversarial-review-follow-up',
    jobId: 'laceyenterprises__agent-os-pr-6840-2026-09-14T16-05-00-000Z',
    repo: REPO,
    prNumber: 6840,
    stoppedAt: '2026-05-25T16:05:00.000Z',
    remediationPlan: {
      stop: {
        code: 'operator-cancelled',
        reason: 'Stopped by operator request.',
        stoppedAt: '2026-05-25T16:05:00.000Z',
      },
    },
    reviewBody: 'Blocking issue: the ci-regression classifier is wrong here.',
  });
  seedFreshReconcile(rootDir);

  const snapshot = collectReviewPipelineHealth({
    rootDir,
    now: () => new Date(NOW),
    config: { queueStarvationMaxAgeMs: 10 * 60 * 1000 },
  });

  assert.equal(snapshot.deferredRereviews.count, 0);
  assert.equal(snapshot.queuedRereviews.count, 0);
  assert.equal(snapshot.firstPassQueue.firstPassPrs.length, 1);
  assert.equal(snapshot.firstPassQueue.oldestFirstPass.prNumber, 6840);
  assert.ok(findingCodes(snapshot).includes('review:queue_starvation'));
});

test('prior rereview pass history does not relabel watcher first-pass rows', () => {
  const rootDir = tempRoot();
  insertReviewRow(rootDir, {
    prNumber: 6841,
    reviewStatus: 'pending',
    reviewedAt: '2026-05-25T16:00:00.000Z',
    lastAttemptedAt: '2026-05-25T16:05:00.000Z',
    postedAt: null,
    rereviewRequestedAt: null,
    reviewAttempts: 0,
  });
  insertReviewerPass(rootDir, {
    prNumber: 6841,
    attemptNumber: 4,
    passKind: 'rereview',
    status: 'completed',
    startedAt: '2026-05-25T15:04:00.000Z',
    endedAt: '2026-05-25T15:05:00.000Z',
  });
  seedFreshReconcile(rootDir);

  const snapshot = collectReviewPipelineHealth({
    rootDir,
    now: () => new Date(NOW),
    config: { queueStarvationMaxAgeMs: 10 * 60 * 1000 },
  });

  assert.equal(snapshot.firstPassQueue.firstPassPrs.length, 1);
  assert.equal(snapshot.firstPassQueue.oldestFirstPass.prNumber, 6841);
  assert.equal(snapshot.firstPassQueue.oldestFirstPass.passKind, 'first-pass');
  assert.equal(snapshot.firstPassQueue.oldestFirstPass.latestReviewerPassKind, 'rereview');
  assert.equal(snapshot.queuedRereviews.count, 0);
  assert.ok(findingCodes(snapshot).includes('review:queue_starvation'));
});

test('prior head reviewer pass history does not count as current first-pass claim starts', () => {
  const rootDir = tempRoot();
  insertReviewRow(rootDir, {
    prNumber: 6842,
    reviewStatus: 'pending',
    reviewedAt: '2026-05-25T16:00:00.000Z',
    lastAttemptedAt: '2026-05-25T16:05:00.000Z',
    postedAt: null,
    rereviewRequestedAt: null,
    reviewAttempts: 0,
    reviewerHeadSha: 'current-head',
  });
  insertReviewerPass(rootDir, {
    prNumber: 6842,
    attemptNumber: 3,
    passKind: 'first-pass',
    status: 'failed',
    startedAt: '2026-05-25T15:04:00.000Z',
    endedAt: '2026-05-25T15:05:00.000Z',
    headSha: 'old-head',
  });
  seedFreshReconcile(rootDir);

  const snapshot = collectReviewPipelineHealth({
    rootDir,
    now: () => new Date(NOW),
    config: { queueStarvationMaxAgeMs: 10 * 60 * 1000 },
  });

  assert.equal(snapshot.firstPassQueue.firstPassPrs.length, 1);
  assert.equal(snapshot.firstPassQueue.oldestFirstPass.prNumber, 6842);
  assert.equal(snapshot.firstPassQueue.oldestFirstPass.reviewerClaimStarts, 0);
  assert.equal(snapshot.firstPassQueue.oldestFirstPass.claimedAndReleased, false);
});

test('lane-share supermajority requires a non-empty verified first-pass backlog after filtering', () => {
  const rootDir = tempRoot();
  seedFreshReconcile(rootDir);
  insertReviewRow(rootDir, {
    prNumber: 6838,
    reviewStatus: 'pending',
    reviewedAt: '2026-05-25T11:14:00.000Z',
    lastAttemptedAt: '2026-05-25T16:05:00.000Z',
    reviewAttempts: 0,
    failedAt: '2026-05-25T16:05:00.000Z',
  });
  insertReviewerPass(rootDir, {
    prNumber: 6838,
    attemptNumber: 1,
    passKind: 'rereview',
    status: 'failed',
    startedAt: '2026-05-25T16:04:00.000Z',
    endedAt: '2026-05-25T16:05:00.000Z',
    metadata: { failureClass: 'ci-regression-stopped' },
  });
  writeJob(rootDir, 'stopped', 'job-6838', {
    kind: 'adversarial-review-follow-up',
    jobId: 'laceyenterprises__agent-os-pr-6838-2026-09-14T16-19-41-000Z',
    repo: REPO,
    prNumber: 6838,
    stoppedAt: '2026-05-25T16:05:00.000Z',
    remediationPlan: {
      stop: {
        code: 'max-rounds-reached',
        reason: producerShapedCiRegressionStopReason(),
        ciRegression: true,
        stoppedAt: '2026-05-25T16:05:00.000Z',
      },
    },
  });
  for (let index = 0; index < 5; index += 1) {
    insertReviewerPass(rootDir, {
      prNumber: 6900 + index,
      attemptNumber: 2,
      passKind: 'rereview',
      status: 'completed',
      startedAt: `2026-05-25T17:${10 + index}:00.000Z`,
      endedAt: `2026-05-25T17:${20 + index}:00.000Z`,
    });
  }

  const snapshot = collectReviewPipelineHealth({
    rootDir,
    now: () => new Date(NOW),
    config: { reviewLaneShareSupermajorityMinPasses: 5 },
  });

  assert.equal(snapshot.reviewerCapacity.totalPasses, 5);
  assert.equal(snapshot.reviewerCapacity.rereviewPasses, 5);
  assert.equal(snapshot.firstPassQueue.firstPassPrs.length, 0);
  assert.ok(!findingCodes(snapshot).includes('review:queue_starvation'));
  assert.ok(!findingCodes(snapshot).includes('review:review_lane_share_supermajority'));
});

test('a rereview with a completed remediation job remains visible in the rereview lane', () => {
  const rootDir = tempRoot();
  insertReviewRow(rootDir, {
    prNumber: 6803,
    reviewStatus: 'pending',
    reviewedAt: '2026-05-25T16:00:00.000Z',
    lastAttemptedAt: '2026-05-25T16:05:00.000Z',
    postedAt: '2026-05-25T15:45:00.000Z',
    reviewAttempts: 1,
    failedAt: '2026-05-25T16:05:00.000Z',
    failureMessage: '[ci-regression-requeued] CFG schema parity=FAILURE, repo-guards=FAILURE',
  });
  writeJob(rootDir, 'completed', 'job-6803', {
    kind: 'adversarial-review-follow-up',
    jobId: 'laceyenterprises__agent-os-pr-6803-2026-09-14T04-27-38-241Z',
    repo: REPO,
    prNumber: 6803,
    createdAt: '2026-05-25T16:10:00.000Z',
    completedAt: '2026-05-25T17:59:00.000Z',
  });
  seedFreshReconcile(rootDir);

  const snapshot = collectReviewPipelineHealth({
    rootDir,
    now: () => new Date(NOW),
    config: { queueStarvationMaxAgeMs: 10 * 60 * 1000 },
  });

  assert.ok(!findingCodes(snapshot).includes('review:queue_starvation'));
  assert.equal(snapshot.firstPassQueue.firstPassPrs.length, 0);
  assert.equal(snapshot.deferredRereviews.count, 0);
  assert.equal(snapshot.queuedRereviews.count, 1);
  assert.equal(snapshot.queuedRereviews.oldest.prNumber, 6803);
  assert.equal(snapshot.queuedRereviews.oldest.requestedAt, '2026-05-25T17:59:00.000Z');
  assert.equal(snapshot.queuedRereviews.oldest.ageMs, 60 * 1000);
  assert.equal(snapshot.queuedRereviews.oldest.readinessSource, 'follow-up-job-terminal');
  assert.equal(snapshot.queuedRereviews.oldest.failureMessage?.startsWith('[ci-regression-requeued]'), true);
  assert.equal(
    snapshot.firstPassQueue.firstPassPrs.length
      + snapshot.deferredRereviews.count
      + snapshot.queuedRereviews.count,
    snapshot.firstPassQueue.pendingDepth,
  );
  const finding = snapshot.findings.find((item) => item.code === 'review:rereview_queue_wait');
  assert.equal(finding, undefined);
});

test('queued rereview oldest is selected by materialized age, not SQL empty-string order', () => {
  const rootDir = tempRoot();
  insertReviewRow(rootDir, {
    prNumber: 6805,
    reviewStatus: 'pending',
    reviewedAt: '2026-05-25T17:50:00.000Z',
    postedAt: '2026-05-25T17:45:00.000Z',
    rereviewRequestedAt: '',
    failedAt: '2026-05-25T17:55:00.000Z',
    reviewAttempts: 1,
  });
  insertReviewRow(rootDir, {
    prNumber: 6806,
    reviewStatus: 'pending',
    reviewedAt: '2026-05-25T16:00:00.000Z',
    postedAt: '2026-05-25T15:45:00.000Z',
    rereviewRequestedAt: '2026-05-25T16:30:00.000Z',
    reviewAttempts: 2,
  });
  seedFreshReconcile(rootDir);

  const snapshot = collectReviewPipelineHealth({
    rootDir,
    now: () => new Date(NOW),
    config: { queueStarvationMaxAgeMs: 10 * 60 * 1000 },
  });

  assert.equal(snapshot.queuedRereviews.count, 2);
  assert.equal(snapshot.queuedRereviews.oldest.prNumber, 6806);
});

test('unrelated active follow-up jobs do not defer rereview admission', () => {
  const rootDir = tempRoot();
  insertReviewRow(rootDir, {
    prNumber: 6807,
    reviewStatus: 'pending',
    reviewedAt: '2026-05-25T16:00:00.000Z',
    postedAt: '2026-05-25T15:45:00.000Z',
    rereviewRequestedAt: '2026-05-25T16:30:00.000Z',
    reviewAttempts: 2,
  });
  writeJob(rootDir, 'in-progress', 'job-6807-wake', {
    kind: 'hammer-wake',
    jobId: 'unrelated-wake-job',
    repo: REPO,
    prNumber: 6807,
    createdAt: '2026-05-25T16:10:00.000Z',
    claimedAt: '2026-05-25T16:12:00.000Z',
  });
  seedFreshReconcile(rootDir);

  const snapshot = collectReviewPipelineHealth({
    rootDir,
    now: () => new Date(NOW),
    config: { queueStarvationMaxAgeMs: 10 * 60 * 1000 },
  });

  assert.equal(snapshot.deferredRereviews.count, 0);
  assert.equal(snapshot.queuedRereviews.count, 1);
  assert.equal(snapshot.queuedRereviews.oldest.prNumber, 6807);
});

test('an old rereview without a deferral reason reports the rereview lane, not first pass', () => {
  const rootDir = tempRoot();
  insertReviewRow(rootDir, {
    prNumber: 6804,
    reviewStatus: 'pending',
    reviewedAt: '2026-05-25T16:00:00.000Z',
    postedAt: '2026-05-25T15:45:00.000Z',
    rereviewRequestedAt: '2026-05-25T16:30:00.000Z',
    reviewAttempts: 2,
  });
  seedFreshReconcile(rootDir);

  const snapshot = collectReviewPipelineHealth({
    rootDir,
    now: () => new Date(NOW),
    config: { queueStarvationMaxAgeMs: 10 * 60 * 1000 },
  });
  assert.ok(!findingCodes(snapshot).includes('review:queue_starvation'));
  assert.equal(snapshot.firstPassQueue.firstPassPrs.length, 0);
  assert.equal(snapshot.queuedRereviews.count, 1);
  const finding = snapshot.findings.find((item) => item.code === 'review:rereview_queue_wait');
  assert.equal(finding.tier, 'ticket');
  assert.match(finding.message, /queued for re-review/);
  assert.match(finding.recommended_action, /re-review lane wait, not first-pass starvation/);
});

test('malformed PR title finding fires for open malformed review rows', () => {
  const rootDir = tempRoot();
  insertReviewRow(rootDir, {
    prNumber: 5738,
    reviewStatus: 'malformed',
    reviewedAt: '2026-05-25T17:45:00.000Z',
    failedAt: '2026-05-25T17:46:00.000Z',
    failureMessage: 'missing required reviewer tag prefix',
  });

  const snapshot = collectReviewPipelineHealth({ rootDir, now: () => new Date(NOW) });
  assert.ok(findingCodes(snapshot).includes('review:malformed_pr_title'));
  const finding = snapshot.findings.find((item) => item.code === 'review:malformed_pr_title');
  assert.equal(finding.tier, 'ticket');
  assert.match(finding.message, /review_status='malformed'/);
  assert.match(finding.message, /creation-time worker prefix/);
  assert.ok(finding.evidence.some((line) => line.includes(`${REPO}#5738`)));
  assert.equal(finding.details.count, 1);
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
      currentRound: 3,
      rounds: [{ round: 1, state: 'completed' }, { round: 2, state: 'completed' }, { round: 3, state: 'completed' }],
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

test('AMAGAP-01: conflicted backlog with no recent hammer dispatch raises a health finding', () => {
  const rootDir = tempRoot();
  const hqRoot = tempRoot();
  const stateDir = path.join(hqRoot, 'dispatch', '_auto_merge-fixture');
  const dispatchLog = path.join(hqRoot, 'dispatch', '_daemon', 'daemon.err.log');
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(path.dirname(dispatchLog), { recursive: true });
  writeFileSync(path.join(stateDir, 'daemon-state.json'), `${JSON.stringify({
    dirtyPrBacklog: {
      dirtyPrCount: 2,
      recordedAt: '2026-05-25T15:00:00.000Z',
      signature: ['laceyenterprises/agent-os#6651@aaa', 'laceyenterprises/agent-os#6666@bbb'],
    },
  }, null, 2)}\n`);
  writeFileSync(dispatchLog, '2026-05-25 14:30:00,000 INFO worker_class=codex spawned\n');
  utimesSync(dispatchLog, new Date('2026-05-25T14:30:00.000Z'), new Date('2026-05-25T14:30:00.000Z'));

  const snapshot = collectReviewPipelineHealth({
    rootDir,
    hqRoot,
    now: () => new Date(NOW),
    env: { USER: 'fixture', ADVERSARIAL_REVIEW_PIPELINE_HEALTH_HOST_CHECKS: '1' },
    config: { hammerDispatchStallMaxAgeMs: 60 * 60 * 1000 },
  });

  assert.ok(findingCodes(snapshot).includes('review:hammer_dispatch_stalled_with_conflicts'));
  assert.equal(snapshot.hammerDispatchStall.active, true);
  assert.equal(snapshot.hammerDispatchStall.backlog.dirtyPrCount, 2);
  assert.match(renderReviewPipelinePrometheus(snapshot), /review_pipeline_hammer_dispatch_stalled 1/);

  writeFileSync(
    dispatchLog,
    '2026-05-25 10:45:00,000 INFO cwp.daemon spawned lrq_1 pid=123 worker_class=hammer\n',
  );
  utimesSync(dispatchLog, new Date('2026-05-25T17:45:00.000Z'), new Date('2026-05-25T17:45:00.000Z'));
  const recovered = collectReviewPipelineHealth({
    rootDir,
    hqRoot,
    now: () => new Date(NOW),
    env: { USER: 'fixture', ADVERSARIAL_REVIEW_PIPELINE_HEALTH_HOST_CHECKS: '1' },
    config: { hammerDispatchStallMaxAgeMs: 60 * 60 * 1000 },
  });
  assert.ok(!findingCodes(recovered).includes('review:hammer_dispatch_stalled_with_conflicts'));
  assert.equal(recovered.hammerDispatchStall.active, false);
  assert.equal(recovered.hammerDispatchStall.hammerDispatchSeen, true);
});

test('AMAGAP-01: hammer dispatch stall probe is inert when host checks are disabled', () => {
  const rootDir = tempRoot();
  const hqRoot = tempRoot();
  const stateDir = path.join(hqRoot, 'dispatch', '_auto_merge-fixture');
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(path.join(stateDir, 'daemon-state.json'), `${JSON.stringify({
    dirtyPrBacklog: {
      dirtyPrCount: 9,
      recordedAt: '2026-05-25T15:00:00.000Z',
      signature: ['laceyenterprises/agent-os#6651@aaa'],
    },
  }, null, 2)}\n`);

  const snapshot = collectReviewPipelineHealth({
    rootDir,
    hqRoot,
    now: () => new Date(NOW),
    env: { USER: 'fixture', ADVERSARIAL_REVIEW_PIPELINE_HEALTH_HOST_CHECKS: '0' },
    config: { hammerDispatchStallMaxAgeMs: 60 * 60 * 1000 },
  });

  assert.ok(!findingCodes(snapshot).includes('review:hammer_dispatch_stalled_with_conflicts'));
  assert.equal(snapshot.hammerDispatchStall.active, false);
  assert.equal(snapshot.hammerDispatchStall.backlog.present, false);
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

test('health output names aborted HCP preflights and estimated reviewer minutes lost', () => {
  const rootDir = tempRoot();
  insertReviewRow(rootDir, {
    prNumber: 6670,
    reviewStatus: 'pending-upstream',
    reviewAttempts: 0,
    lastAttemptedAt: '2026-09-12T14:37:58.000Z',
    failedAt: '2026-09-12T14:37:58.000Z',
    failureMessage: '[hcp-unavailable] HCP healthz http://127.0.0.1:8002/v1/healthz failed: This operation was aborted',
  });
  insertReviewerPass(rootDir, {
    prNumber: 6670,
    reviewerClass: 'gemini',
    reviewerModel: 'gemini',
    passKind: 'first-pass',
    startedAt: '2026-09-12T13:00:00.000Z',
    endedAt: '2026-09-12T13:04:00.000Z',
    status: 'completed',
    metadata: {},
  });
  insertReviewerPass(rootDir, {
    prNumber: 6670,
    attemptNumber: 2,
    reviewerClass: 'codex',
    reviewerModel: 'gpt-5',
    passKind: 'rereview',
    startedAt: '2026-09-12T14:13:08.000Z',
    endedAt: '2026-09-12T14:25:44.000Z',
    status: 'completed',
    metadata: {},
  });

  const snapshot = collectReviewPipelineHealth({ rootDir, now: () => new Date('2026-09-12T14:40:00.000Z') });

  assert.equal(snapshot.hcpPreflightAborts.active, 1);
  assert.equal(snapshot.hcpPreflightAborts.reviewerMinutesLost, 12.6);
  assert.equal(snapshot.hcpPreflightAborts.examples[0].prNumber, 6670);
  assert.equal(snapshot.hcpPreflightAborts.examples[0].reviewerModel, 'gpt-5');
  assert.equal(snapshot.hcpPreflightAborts.examples[0].passKind, 'rereview');
  const output = renderReviewPipelinePrometheus(snapshot);
  assert.match(output, /^review_pipeline_hcp_preflight_aborted_passes 1$/m);
  assert.match(output, /^review_pipeline_hcp_preflight_aborted_reviewer_minutes_lost 12\.6$/m);
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
  const source = readFileSync('src/review-pipeline-health.mjs', 'utf8');
  const emitted = Array.from(source.matchAll(/buildFinding\(\{\s*code: '(review:[a-z_]+)'/g), (match) => match[1]).sort();
  assert.deepEqual(emitted, defined);
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

// ── Failure-class banner poisoning (2026-08-22) ──────────────────────────────
//
// adversarial-review#886 failed with `PullRequest.diff too_large` (a 33,168-line
// diff over GitHub's 20,000-line API cap). pipeline-health reported
// `dominantFailureClass: auth` and told the operator to investigate reviewer
// credentials, because the captured stdout tail contains the routine banner
// `(OAuth-only mode; prompt stage=first)` and the classifier matched a bare
// `includes('oauth')`. The banner prints on EVERY gemini review, so this
// poisoned the `auth` class for that whole reviewer.
test('a routine OAuth banner in the tail does not classify a failure as auth', () => {
  const rootDir = tempRoot();
  insertReviewRow(rootDir, {
    prNumber: 960,
    reviewStatus: 'failed',
    reviewedAt: '2026-05-25T17:00:00.000Z',
  });
  const db = openDb(rootDir);
  try {
    db.prepare(
      'UPDATE reviewed_prs SET failure_message = ?, infra_auto_recover_attempts = ? WHERE pr_number = ?',
    ).run(
      '[unknown] Command failed with code 1\nstdout tail:\n'
      + '[reviewer] Starting review: laceyenterprises/adversarial-review#886 '
      + 'model=gemini (OAuth-only mode; prompt stage=first)\n'
      + 'could not find pull request diff: HTTP 406: Sorry, the diff exceeded the '
      + 'maximum number of lines (20000)\nPullRequest.diff too_large',
      3,
      960,
    );
  } finally {
    db.close();
  }

  const snapshot = collectReviewPipelineHealth({ rootDir, now: () => new Date(NOW) });
  const finding = snapshot.findings.find((item) => item.code === 'review:stuck_retry_loop');
  assert.ok(finding, 'expected the stuck-retry-loop finding');
  assert.equal(finding.details.dominantFailureClass, 'diff-too-large');
  assert.notEqual(finding.details.dominantFailureClass, 'auth');
  // The advice must not send an operator after credentials for a diff-size problem.
  assert.equal(typeof finding.recommended_action, 'string');
  assert.match(finding.recommended_action, /NOT a reviewer auth\/infra problem/);
  assert.match(finding.recommended_action, /do not retrigger/);
});

test('claude account-level 429 in a captured tail is classified as quota, not auth', () => {
  const rootDir = tempRoot();
  insertReviewRow(rootDir, {
    prNumber: 961,
    reviewStatus: 'failed',
    reviewedAt: '2026-05-25T17:00:00.000Z',
  });
  const db = openDb(rootDir);
  try {
    db.prepare(
      'UPDATE reviewed_prs SET failure_message = ?, infra_auto_recover_attempts = ? WHERE pr_number = ?',
    ).run(
      '[cascade] Command failed with code 1\nstdout tail:\n'
      + '[reviewer] Starting review: laceyenterprises/agent-os#6548 '
      + 'model=claude (OAuth-only mode; prompt stage=last)\n'
      + '{"api_error_status":429,"result":"API Error: Request rejected (429) · '
      + 'This request would exceed your account\'s rate limit. Please try again later."}',
      3,
      961,
    );
  } finally {
    db.close();
  }

  const snapshot = collectReviewPipelineHealth({ rootDir, now: () => new Date(NOW) });
  const finding = snapshot.findings.find((item) => item.code === 'review:stuck_retry_loop');
  assert.ok(finding, 'expected the stuck-retry-loop finding');
  assert.equal(finding.details.dominantFailureClass, QUOTA_EXHAUSTED_FAILURE_CLASS);
  assert.notEqual(finding.details.dominantFailureClass, 'auth');
});

test('reviewer_pass_zombie threshold stays above the reaper timeout', () => {
  // The reviewer-pass-reaper ends a hung pass at
  // DEFAULT_RUNNING_PASS_TIMEOUT_SECONDS. This finding exists to catch a reaper
  // that is NOT doing its job, so alarming earlier than the reaper can act is
  // guaranteed noise: the operator has no lever, and the condition resolves
  // itself. It previously defaulted to 30 minutes -- half the reaper timeout --
  // so every hung pass produced 30 minutes of unactionable ticket (observed
  // 2026-08-22: three gemini passes ticketed at 48-50m, reaper due at 60m).
  //
  // The reaper timeout is imported, not restated, so retuning the reaper is
  // caught here instead of passing against a stale duplicate constant.
  const reaperTimeoutMs = DEFAULT_RUNNING_PASS_TIMEOUT_SECONDS * 1000;
  const config = resolveReviewPipelineHealthConfig({});
  assert.ok(
    config.runningReviewerPassMaxAgeMs > reaperTimeoutMs,
    `zombie threshold ${config.runningReviewerPassMaxAgeMs}ms must exceed the ` +
      `reaper timeout ${reaperTimeoutMs}ms`
  );
});

test('reviewer model silence defaults and class allowlist are configurable', () => {
  const defaults = resolveReviewPipelineHealthConfig({});
  assert.equal(defaults.reviewerSilenceThresholdMs, 24 * 60 * 60 * 1000);
  assert.equal(defaults.reviewerActivityLookbackMs, 7 * 24 * 60 * 60 * 1000);
  assert.deepEqual(defaults.reviewerModelSilenceClasses, ['claude', 'codex', 'gemini']);

  const configured = resolveReviewPipelineHealthConfig({
    ADVERSARIAL_REVIEW_PIPELINE_HEALTH_REVIEWER_MODEL_SILENCE_CLASSES:
      ' claude, hammer-claude, claude ',
  });
  assert.deepEqual(configured.reviewerModelSilenceClasses, ['claude', 'hammer-claude']);
});

test('reviewer_pass_zombie default tracks the reaper timeout it is derived from', () => {
  // Guards the coupling itself: if the derivation is ever re-hardcoded, a future
  // change to DEFAULT_RUNNING_PASS_TIMEOUT_SECONDS would leave this default
  // pinned at 90 minutes and silently re-invert the alarm against its
  // remediation. Pipeline-health config overrides are unaffected -- only the
  // default is coupled.
  const config = resolveReviewPipelineHealthConfig({});
  assert.equal(
    config.runningReviewerPassMaxAgeMs,
    Math.round(DEFAULT_RUNNING_PASS_TIMEOUT_SECONDS * 1000 * 1.5)
  );
});

test('a completed job that overran its round budget is history, not a ticket', () => {
  // Regression for 2026-08-23. `summarizeRoundBudgetAnomalies` counted bare
  // budget overruns on COMPLETED job records. Those records are immutable and
  // never reaped, so the finding could only ever grow: it sat pinned at exactly
  // 34 for a whole operator shift -- 34/34 `completed`, 29 of them from May,
  // and ZERO in the awaiting-rereview state the finding's own recommended
  // action says to inspect. A ticket that cannot clear trains its reader to
  // skip the surface.
  const job = {
    repo: 'laceyenterprises/agent-os',
    prNumber: 4242,
    jobId: 'j1',
    riskClass: 'medium', // budget 3
    remediationPlan: { rounds: [{ round: 1 }, { round: 2 }, { round: 3 }, { round: 4 }] },
  };

  const completed = summarizeRoundBudgetAnomalies([{ state: 'completed', job }]);
  assert.equal(
    completed.anomalies.length,
    0,
    'a completed overrun must not raise a ticket that can never clear'
  );

  // Still live -> still actionable.
  const inProgress = summarizeRoundBudgetAnomalies([{ state: 'in-progress', job }]);
  assert.equal(inProgress.anomalies.length, 1);
  assert.ok(inProgress.anomalies[0].codes.includes('round-count-exceeds-risk-budget'));
});
