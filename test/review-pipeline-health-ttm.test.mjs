/**
 * TTM-01, at the finding surface: what the pipeline-health collector actually
 * emits for slow, for stuck, and for a budget it cannot measure.
 *
 * The escalation (page vs warn vs blind) is Sentinel's call -- every definition
 * here is `tier: 'ticket'` by contract. What this file pins is that the three
 * conditions produce three DIFFERENT codes, so Sentinel has something to
 * escalate differently.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { collectReviewPipelineHealth } from '../src/review-pipeline-health.mjs';
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
        review_status, posted_at, rereview_requested_at)
     VALUES (?, ?, ?, 'codex', ?, ?, ?, ?, ?, ?)`
  ).run(
    REPO, row.prNumber, row.reviewedAt, row.prState || 'open',
    row.mergedAt ?? null, null, row.reviewStatus || 'posted',
    row.postedAt ?? null, row.rereviewRequestedAt ?? null
  );
}

function insertPass(db, row) {
  db.prepare(
    `INSERT INTO reviewer_passes
       (repo, pr_number, attempt_number, reviewer_class, reviewer_model,
        pass_kind, started_at, ended_at, status, verdict, metadata_json)
     VALUES (?, ?, ?, 'codex', 'gpt-5', ?, ?, ?, 'completed', ?, '{}')`
  ).run(
    REPO, row.prNumber, row.attemptNumber ?? 1,
    (row.attemptNumber ?? 1) > 1 ? 'rereview' : 'first-pass',
    row.startedAt, row.endedAt, row.verdict ?? 'request-changes'
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
});
