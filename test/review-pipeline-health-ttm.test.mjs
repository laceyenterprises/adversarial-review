/**
 * TTM-01, at the finding surface: what the pipeline-health collector actually
 * emits for slow, for stuck, and for a budget it cannot measure.
 *
 * Stalls that mean "clean PRs are not landing" are page-tier at the source;
 * budget-only slowness stays a ticket. What this file pins is that the
 * conditions produce different codes and severities, so downstream surfaces do
 * not have to infer the outcome from intermediate metrics.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  collectReviewPipelineHealth,
  renderReviewPipelinePrometheus,
} from '../src/review-pipeline-health.mjs';
import { ensureReviewStateSchema, openReviewStateDb } from '../src/review-state.mjs';

const REPO = 'laceyenterprises/agent-os';
const NOW = '2026-09-06T12:00:00.000Z';
const NOW_MS = Date.parse(NOW);

const tempRoot = () => mkdtempSync(path.join(tmpdir(), 'review-health-ttm-'));
const iso = (minutesAgo) => new Date(NOW_MS - minutesAgo * 60_000).toISOString();

function insertPr(db, row) {
  db.prepare(
    `INSERT INTO reviewed_prs
       (repo, pr_number, reviewed_at, reviewer, pr_state, merged_at, closed_at,
        review_status, posted_at, rereview_requested_at, reviewer_lease_expires_at)
     VALUES (?, ?, ?, 'codex', ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    REPO, row.prNumber, row.reviewedAt, row.prState || 'open',
    row.mergedAt ?? null, null, row.reviewStatus || 'posted',
    row.postedAt ?? null, row.rereviewRequestedAt ?? null,
    row.reviewerLeaseExpiresAt ?? null
  );
}

function insertPass(db, row) {
  db.prepare(
    `INSERT INTO reviewer_passes
       (repo, pr_number, attempt_number, reviewer_class, reviewer_model,
        pass_kind, started_at, ended_at, status, verdict, metadata_json)
     VALUES (?, ?, ?, 'codex', 'gpt-5', ?, ?, ?, ?, ?, '{}')`
  ).run(
    REPO, row.prNumber, row.attemptNumber ?? 1,
    (row.attemptNumber ?? 1) > 1 ? 'rereview' : 'first-pass',
    row.startedAt, row.endedAt, row.status ?? 'completed',
    row.verdict ?? 'request-changes'
  );
}

/** Merged history so the budget has a real distribution to derive from. */
function seedDistribution(db, { baseMinutes, perRoundMinutes }) {
  db.transaction(() => {
    let prNumber = 100;
    let mergeIndex = 0;
    for (let rounds = 0; rounds <= 4; rounds += 1) {
      const centre = baseMinutes + rounds * perRoundMinutes;
      for (let i = 0; i < 12; i += 1) {
        const ttm = centre * (0.75 + 0.5 * (i / 11));
        const mergedMinutesAgo = 360 + mergeIndex * 25;
        const reviewedAt = iso(mergedMinutesAgo + ttm);
        insertPr(db, {
          prNumber,
          reviewedAt,
          prState: 'merged',
          mergedAt: iso(mergedMinutesAgo),
          postedAt: iso(mergedMinutesAgo + 1),
        });
        for (let attempt = 1; attempt <= rounds + 1; attempt += 1) {
          insertPass(db, {
            prNumber,
            attemptNumber: attempt,
            startedAt: reviewedAt,
            endedAt: iso(mergedMinutesAgo + 1),
          });
        }
        prNumber += 1;
        mergeIndex += 1;
      }
    }
  })();
}

const codes = (snapshot) => snapshot.findings.map((finding) => finding.code);
const findingFor = (snapshot, code) => snapshot.findings.find((f) => f.code === code);

test('a stalled PR emits pr_progress_stalled, and a merely slow one emits only the trend code', () => {
  const rootDir = tempRoot();
  const db = openReviewStateDb(rootDir);
  ensureReviewStateSchema(db);
  try {
    seedDistribution(db, { baseMinutes: 60, perRoundMinutes: 20 });

    // STUCK: a re-review requested 45m ago that nothing has picked up. The PR
    // is only 60m old, INSIDE the derived budget, so the budget code cannot be
    // what flags it.
    insertPr(db, {
      prNumber: 9001,
      reviewedAt: iso(60),
      reviewStatus: 'pending',
      postedAt: iso(55),
      rereviewRequestedAt: iso(45),
    });
    insertPass(db, { prNumber: 9001, attemptNumber: 1, startedAt: iso(58), endedAt: iso(55) });

    // SLOW: no stall of any kind, just over the derived budget.
    insertPr(db, { prNumber: 9002, reviewedAt: iso(400), reviewStatus: 'pending' });
    insertPass(db, { prNumber: 9002, attemptNumber: 1, startedAt: iso(398), endedAt: iso(20) });
  } finally {
    db.close();
  }

  const snapshot = collectReviewPipelineHealth({ rootDir, now: () => new Date(NOW), env: {} });
  const emitted = codes(snapshot);

  assert.ok(emitted.includes('review:pr_progress_stalled'), `emitted: ${emitted.join(', ')}`);
  assert.ok(emitted.includes('review:ttm_budget_breach'), `emitted: ${emitted.join(', ')}`);

  const stalled = findingFor(snapshot, 'review:pr_progress_stalled');
  assert.equal(stalled.tier, 'ticket', 'the collector never emits a page; Sentinel escalates');
  assert.equal(stalled.details.progressClass, 'stuck');
  assert.equal(stalled.details.flagKind, 'rereview_unanswered');
  assert.deepEqual(stalled.details.flags.map((flag) => flag.prNumber), [9001]);

  const slow = findingFor(snapshot, 'review:ttm_budget_breach');
  assert.equal(slow.details.progressClass, 'slow');
  assert.deepEqual(slow.details.flags.map((flag) => flag.prNumber), [9002]);
  // The derivation travels with the finding: a budget with no stated
  // provenance is how the old one drifted out of date unnoticed.
  assert.equal(slow.details.budgetProvenance.source, 'measured-fit');
  assert.equal(slow.details.budgetProvenance.percentile, 90);
  assert.ok(slow.details.budgetProvenance.sampleCount >= 25);
  assert.match(slow.message, /budget derived at p90 from \d+ measured merge\(s\)/);
  assert.match(slow.recommended_action, /Trend only|THROUGHPUT signal/);
});

test('concurrent progress-stall reasons emit one finding and one Prometheus series', () => {
  const rootDir = tempRoot();
  const db = openReviewStateDb(rootDir);
  ensureReviewStateSchema(db);
  try {
    seedDistribution(db, { baseMinutes: 400, perRoundMinutes: 100 });

    insertPr(db, {
      prNumber: 9010,
      reviewedAt: iso(90),
      reviewStatus: 'pending',
      postedAt: iso(85),
      rereviewRequestedAt: iso(45),
    });
    insertPass(db, { prNumber: 9010, attemptNumber: 1, startedAt: iso(88), endedAt: iso(85) });

    insertPr(db, {
      prNumber: 9011,
      reviewedAt: iso(90),
      reviewStatus: 'reviewing',
      reviewerLeaseExpiresAt: iso(45),
    });
    insertPass(db, {
      prNumber: 9011,
      attemptNumber: 1,
      startedAt: iso(88),
      endedAt: null,
      status: 'running',
      verdict: null,
    });
  } finally {
    db.close();
  }

  const snapshot = collectReviewPipelineHealth({ rootDir, now: () => new Date(NOW), env: {} });
  const stalledFindings = snapshot.findings.filter((finding) => (
    finding.code === 'review:pr_progress_stalled'
  ));

  assert.equal(stalledFindings.length, 1);
  assert.deepEqual(
    stalledFindings[0].details.flagKinds.sort(),
    ['rereview_unanswered', 'reviewer_lease_expired']
  );
  assert.deepEqual(
    stalledFindings[0].details.flags.map((flag) => flag.prNumber).sort(),
    [9010, 9011]
  );

  const prometheus = renderReviewPipelinePrometheus(snapshot);
  assert.equal(
    prometheus.match(/^review_pipeline_sentinel_finding_active\{code="review:pr_progress_stalled",tier="ticket"\} 1$/gm)?.length,
    1
  );
});

test('terminal-but-unmerged emits a page-tier outcome alarm', () => {
  const rootDir = tempRoot();
  const db = openReviewStateDb(rootDir);
  try {
    ensureReviewStateSchema(db);
    seedDistribution(db, { baseMinutes: 30, perRoundMinutes: 20 });
    insertPr(db, {
      prNumber: 9101,
      reviewedAt: iso(420),
      reviewStatus: 'posted',
      postedAt: iso(410),
    });
    insertPass(db, {
      prNumber: 9101,
      attemptNumber: 1,
      startedAt: iso(415),
      endedAt: iso(410),
      verdict: 'approved',
    });
  } finally {
    db.close();
  }

  const snapshot = collectReviewPipelineHealth({ rootDir, now: () => new Date(NOW), env: {} });
  const terminal = findingFor(snapshot, 'review:terminal_but_unmerged');

  assert.equal(snapshot.ttm.rollup.terminalButUnmergedOpenCount, 1);
  assert.equal(terminal.tier, 'page');
  assert.equal(terminal.details.progressClass, 'stuck');
  assert.match(terminal.subject, /terminal clean PR/);
});

test('an unreadable distribution emits the blind code and withholds the slow one', () => {
  const rootDir = tempRoot();
  const db = openReviewStateDb(rootDir);
  ensureReviewStateSchema(db);
  try {
    seedDistribution(db, { baseMinutes: 20, perRoundMinutes: 5 });
    // Far past any plausible budget: if the collector could measure one, this
    // PR would certainly be reported slow.
    insertPr(db, { prNumber: 9003, reviewedAt: iso(900), reviewStatus: 'pending' });
    // Now break exactly the read the budget derives from.
    db.exec('DROP TABLE reviewer_passes');
  } finally {
    db.close();
  }

  const snapshot = collectReviewPipelineHealth({ rootDir, now: () => new Date(NOW), env: {} });
  const emitted = codes(snapshot);

  assert.ok(emitted.includes('review:ttm_budget_model_unreadable'), `emitted: ${emitted.join(', ')}`);
  assert.ok(
    !emitted.includes('review:ttm_budget_breach'),
    'a budget nobody could measure must not produce a breach verdict'
  );
  const blind = findingFor(snapshot, 'review:ttm_budget_model_unreadable');
  assert.equal(blind.details.blind, true);
  assert.match(blind.message, /NOT a health verdict/);
  assert.equal(snapshot.ttm.rollup.budgetBlind, true);
  assert.equal(
    snapshot.ttm.rollup.openPrsBreachingBudget,
    null,
    'blind must read as a gap, never as zero breaches'
  );
  const prometheus = renderReviewPipelinePrometheus(snapshot);
  assert.match(prometheus, /^review_pipeline_ttm_open_budget_breaches NaN$/m);
  assert.match(prometheus, /^review_pipeline_ttm_budget_minutes\{component="base"\} NaN$/m);
  assert.match(prometheus, /^review_pipeline_ttm_budget_minutes\{component="per_round"\} NaN$/m);
  assert.match(prometheus, /^review_pipeline_ttm_queue_pressure_multiplier NaN$/m);
  assert.doesNotMatch(prometheus, /^review_pipeline_ttm_open_budget_breaches 0$/m);
});
