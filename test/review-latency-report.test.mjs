import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  collectReviewLatencyReport,
  renderReviewLatencyReport,
} from '../src/review-latency-report.mjs';
import {
  ensureReviewStateSchema,
  openReviewStateDb,
  recordReviewLatencyEvent,
} from '../src/review-state.mjs';

const REPO = 'laceyenterprises/agent-os';

function tempRoot() {
  return mkdtempSync(path.join(tmpdir(), 'review-latency-report-'));
}

function openDb(rootDir) {
  const db = openReviewStateDb(rootDir);
  ensureReviewStateSchema(db);
  return db;
}

function writeJob(rootDir, state, name, job) {
  const dir = path.join(rootDir, 'data', 'follow-up-jobs', state);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${name}.json`), `${JSON.stringify(job, null, 2)}\n`);
}

test('review latency schema creates durable event table and indexes', () => {
  const rootDir = tempRoot();
  const db = openDb(rootDir);
  try {
    const table = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'review_latency_events'"
    ).get();
    assert.equal(table.name, 'review_latency_events');
    const columns = db.prepare("PRAGMA table_info('review_latency_events')").all().map((column) => column.name);
    assert.ok(columns.includes('event_type'));
    assert.ok(columns.includes('idempotency_key'));
    assert.ok(columns.includes('payload_json'));
    const indexes = db.prepare("PRAGMA index_list('review_latency_events')").all().map((index) => index.name);
    assert.ok(indexes.includes('review_latency_events_idempotency_unique'));
    assert.ok(indexes.includes('idx_review_latency_events_at'));
  } finally {
    db.close();
  }
});

test('review latency event append is idempotent by event type and idempotency key', () => {
  const rootDir = tempRoot();
  const db = openDb(rootDir);
  try {
    const first = recordReviewLatencyEvent(db, {
      repo: REPO,
      prNumber: 6601,
      eventType: 'hammer_wake',
      at: '2026-09-11T12:16:00.000Z',
      source: 'test',
      idempotencyKey: `${REPO}#6601:hammer:head-a`,
      payload: { route: 'hammer' },
    });
    const second = recordReviewLatencyEvent(db, {
      repo: REPO,
      prNumber: 6601,
      eventType: 'hammer_wake',
      at: '2026-09-11T12:17:00.000Z',
      source: 'test-replay',
      idempotencyKey: `${REPO}#6601:hammer:head-a`,
      payload: { route: 'hammer-replay' },
    });
    assert.equal(first.event_id, second.event_id);
    const count = db.prepare('SELECT COUNT(*) AS count FROM review_latency_events').get().count;
    assert.equal(count, 1);
    assert.equal(second.at, '2026-09-11T12:16:00.000Z');
  } finally {
    db.close();
  }
});

test('review latency event fallback lookup is scoped by generic subject identity', () => {
  const rootDir = tempRoot();
  const db = openDb(rootDir);
  try {
    const sharedAt = '2026-09-11T12:16:00.000Z';
    const first = recordReviewLatencyEvent(db, {
      domainId: 'research-finding',
      subjectExternalId: 'finding-a',
      eventType: 'hammer_wake',
      at: sharedAt,
      source: 'test-domain-a',
      payload: { subject: 'a' },
    });
    const second = recordReviewLatencyEvent(db, {
      domainId: 'ticket-triage',
      subjectExternalId: 'finding-b',
      eventType: 'hammer_wake',
      at: sharedAt,
      source: 'test-domain-b',
      payload: { subject: 'b' },
    });

    assert.notEqual(first.event_id, second.event_id);
    assert.equal(first.domain_id, 'research-finding');
    assert.equal(first.subject_external_id, 'finding-a');
    assert.equal(JSON.parse(first.payload_json).subject, 'a');
    assert.equal(second.domain_id, 'ticket-triage');
    assert.equal(second.subject_external_id, 'finding-b');
    assert.equal(JSON.parse(second.payload_json).subject, 'b');
  } finally {
    db.close();
  }
});

test('latency report backfills critical path and queue state from fixtures', () => {
  const rootDir = tempRoot();
  const db = openDb(rootDir);
  try {
    db.prepare(
      `INSERT INTO reviewed_prs (
         repo, pr_number, reviewed_at, reviewer, pr_state, review_status,
         review_attempts, last_attempted_at, posted_at, reviewer_started_at,
         merged_at
       ) VALUES (?, ?, ?, ?, 'merged', 'posted', 1, ?, ?, ?, ?)`
    ).run(
      REPO,
      6601,
      '2026-09-11T12:00:00.000Z',
      'agy-gemini',
      '2026-09-11T12:02:00.000Z',
      '2026-09-11T12:08:00.000Z',
      '2026-09-11T12:03:00.000Z',
      '2026-09-11T12:20:00.000Z',
    );
    db.prepare(
      `INSERT INTO reviewer_passes (
         repo, pr_number, attempt_number, reviewer_class, reviewer_model,
         pass_kind, started_at, ended_at, status, gh_comment_id, body_captured_at, metadata_json
       ) VALUES (?, ?, 1, 'gemini', 'agy-gemini-2.5', 'first-pass', ?, ?, 'completed', 'R_1', ?, ?)`
    ).run(
      REPO,
      6601,
      '2026-09-11T12:03:00.000Z',
      '2026-09-11T12:08:00.000Z',
      '2026-09-11T12:08:00.000Z',
      JSON.stringify({ firstOutputAt: '2026-09-11T12:03:30.000Z' }),
    );
    db.prepare(
      `INSERT INTO reviewed_prs (
         repo, pr_number, reviewed_at, reviewer, pr_state, review_status,
         review_attempts, rereview_requested_at, failure_message
       ) VALUES (?, ?, ?, 'codex', 'open', 'pending', 1, ?, ?)`
    ).run(
      REPO,
      6602,
      '2026-09-11T11:30:00.000Z',
      '2026-09-11T12:10:00.000Z',
      'awaiting rereview',
    );
    recordReviewLatencyEvent(db, {
      repo: REPO,
      prNumber: 6601,
      eventType: 'hammer_wake',
      at: '2026-09-11T12:16:00.000Z',
      source: 'test-hammer',
      idempotencyKey: 'hammer-6601',
    });
    recordReviewLatencyEvent(db, {
      repo: REPO,
      prNumber: 6601,
      eventType: 'deploy_observed',
      at: '2026-09-11T12:29:00.000Z',
      source: 'test-main-catchup',
      idempotencyKey: 'deploy-6601',
    });
  } finally {
    db.close();
  }

  writeJob(rootDir, 'stopped', 'job-6601', {
    jobId: 'job-6601',
    repo: REPO,
    prNumber: 6601,
    createdAt: '2026-09-11T12:09:00.000Z',
    stoppedAt: '2026-09-11T12:15:00.000Z',
    remediationPlan: {
      stop: {
        code: 'review-settled',
        stoppedAt: '2026-09-11T12:15:00.000Z',
      },
    },
  });

  const report = collectReviewLatencyReport({
    rootDir,
    since: '24h',
    now: () => new Date('2026-09-11T13:00:00.000Z'),
  });

  assert.equal(report.schema, 'adversarial-review-latency-report/v1');
  assert.equal(report.reviewStateLedger.readable, true);
  assert.equal(report.surfaces.explicitEvents, 2);
  assert.equal(report.queue.count, 1);
  assert.equal(report.queue.oldest.prNumber, 6602);
  assert.equal(report.topWaitingReasons[0].reason, 'rereview-pending');
  assert.equal(report.reviewerSlots.reviewingRows, 0);
  assert.equal(report.agyRouteState.available, true);

  const admission = report.stages.find((stage) => stage.key === 'review_eligible_to_row_claimed');
  assert.equal(admission.p50Ms, 2 * 60 * 1000);
  const postToFollowUp = report.stages.find((stage) => stage.key === 'gh_post_to_follow_up_created');
  assert.equal(postToFollowUp.p50Ms, 60 * 1000);
  const mergeToDeploy = report.stages.find((stage) => stage.key === 'merge_to_deploy_observed');
  assert.equal(mergeToDeploy.p50Ms, 9 * 60 * 1000);

  const text = renderReviewLatencyReport(report);
  assert.match(text, /review_eligible -> row_claimed/);
  assert.match(text, /current queue: 1 waiting/);
  assert.match(text, /recent wakes:/);
  assert.match(text, /hammer_wake/);
});

test('latency report includes reviewed PR rows with in-window terminal activity', () => {
  const rootDir = tempRoot();
  const db = openDb(rootDir);
  try {
    db.prepare(
      `INSERT INTO reviewed_prs (
         repo, pr_number, reviewed_at, reviewer, pr_state, review_status,
         review_attempts, posted_at, merged_at
       ) VALUES (?, ?, ?, 'gemini', 'merged', 'posted', 1, ?, ?)`
    ).run(
      REPO,
      6610,
      '2026-09-09T12:00:00.000Z',
      '2026-09-09T12:08:00.000Z',
      '2026-09-11T12:20:00.000Z',
    );
    recordReviewLatencyEvent(db, {
      repo: REPO,
      prNumber: 6610,
      eventType: 'deploy_observed',
      at: '2026-09-11T12:29:00.000Z',
      source: 'test-main-catchup',
      idempotencyKey: 'deploy-6610',
    });
  } finally {
    db.close();
  }

  const report = collectReviewLatencyReport({
    rootDir,
    since: '24h',
    now: () => new Date('2026-09-11T13:00:00.000Z'),
  });

  assert.equal(report.surfaces.reviewedPrRows, 1);
  const mergeToDeploy = report.stages.find((stage) => stage.key === 'merge_to_deploy_observed');
  assert.equal(mergeToDeploy.sampleCount, 1);
  assert.equal(mergeToDeploy.p50Ms, 9 * 60 * 1000);
});

test('latency report includes reviewer passes and follow-up jobs ending in the window', () => {
  const rootDir = tempRoot();
  const db = openDb(rootDir);
  try {
    db.prepare(
      `INSERT INTO reviewer_passes (
         repo, pr_number, attempt_number, reviewer_class, reviewer_model,
         pass_kind, started_at, ended_at, status, gh_comment_id, body_captured_at, metadata_json
       ) VALUES (?, ?, 1, 'gemini', 'agy-gemini-2.5', 'first-pass', ?, ?, 'completed', 'R_6611', ?, ?)`
    ).run(
      REPO,
      6611,
      '2026-09-09T12:03:00.000Z',
      '2026-09-11T12:08:00.000Z',
      '2026-09-11T12:08:00.000Z',
      JSON.stringify({ firstOutputAt: '2026-09-11T12:03:30.000Z' }),
    );
    recordReviewLatencyEvent(db, {
      repo: REPO,
      prNumber: 6611,
      eventType: 'hammer_wake',
      at: '2026-09-11T12:16:00.000Z',
      source: 'test-hammer',
      idempotencyKey: 'hammer-6611',
    });
  } finally {
    db.close();
  }
  writeJob(rootDir, 'stopped', 'job-6611', {
    jobId: 'job-6611',
    repo: REPO,
    prNumber: 6611,
    createdAt: '2026-09-09T12:09:00.000Z',
    stoppedAt: '2026-09-11T12:15:00.000Z',
    remediationPlan: {
      stop: {
        code: 'review-settled',
        stoppedAt: '2026-09-11T12:15:00.000Z',
      },
    },
  });

  const report = collectReviewLatencyReport({
    rootDir,
    since: '24h',
    now: () => new Date('2026-09-11T13:00:00.000Z'),
  });

  assert.equal(report.surfaces.reviewerPassRows, 1);
  assert.equal(report.surfaces.followUpJobs, 1);
  const reviewerPost = report.stages.find((stage) => stage.key === 'reviewer_first_output_to_gh_post');
  assert.equal(reviewerPost.sampleCount, 1);
  assert.equal(reviewerPost.p50Ms, 4.5 * 60 * 1000);
  const cleanToWake = report.stages.find((stage) => stage.key === 'clean_verdict_to_hammer_wake');
  assert.equal(cleanToWake.sampleCount, 1);
  assert.equal(cleanToWake.p50Ms, 60 * 1000);
});

test('latency report keeps generic domain subjects in separate timelines', () => {
  const rootDir = tempRoot();
  const db = openDb(rootDir);
  try {
    recordReviewLatencyEvent(db, {
      domainId: 'research-finding',
      subjectExternalId: 'finding-a',
      eventType: 'reviewer_started',
      at: '2026-09-11T12:00:00.000Z',
      source: 'test-domain-a',
      idempotencyKey: 'domain-a-started',
    });
    recordReviewLatencyEvent(db, {
      domainId: 'research-finding',
      subjectExternalId: 'finding-b',
      eventType: 'reviewer_first_output',
      at: '2026-09-11T12:10:00.000Z',
      source: 'test-domain-b',
      idempotencyKey: 'domain-b-first-output',
    });
  } finally {
    db.close();
  }

  const report = collectReviewLatencyReport({
    rootDir,
    since: '24h',
    now: () => new Date('2026-09-11T13:00:00.000Z'),
  });

  assert.equal(report.surfaces.explicitEvents, 2);
  const reviewerRuntime = report.stages.find((stage) => stage.key === 'row_claimed_to_reviewer_first_output');
  assert.equal(reviewerRuntime.sampleCount, 0);
  assert.equal(reviewerRuntime.p50Ms, null);
});
