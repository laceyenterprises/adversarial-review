// RPL-08 — the durable review-mode record and its report rollup.
//
// The write is deliberately best-effort, so the most important assertions here
// are the negative ones: a failing diagnostic write must never propagate into
// the review path. A reviewer that dies after generating a review but before
// posting it burns attempt budget and leaves the PR ungated — the failure class
// that cost 603 logged review posts.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  REVIEW_MODE_SELECTED_EVENT,
  recordReviewModeSelected,
} from '../src/review-mode-latency.mjs';
import {
  FORCE_FULL_REVIEW_LABEL,
  REVIEW_MODE,
  evaluateSlimReviewEligibilityForDiff,
  resolveSlimReviewPolicy,
} from '../src/slim-review-eligibility.mjs';
import {
  collectReviewLatencyReport,
  renderReviewLatencyReport,
} from '../src/review-latency-report.mjs';
import { ensureReviewStateSchema, openReviewStateDb } from '../src/review-state.mjs';

const REPO = 'laceyenterprises/agent-os';
const POLICY = resolveSlimReviewPolicy({});
const SILENT_LOG = { warn() {}, error() {}, log() {} };

const DOCS_DIFF = `diff --git a/docs/GLOSSARY.md b/docs/GLOSSARY.md
--- a/docs/GLOSSARY.md
+++ b/docs/GLOSSARY.md
@@ -1 +1,2 @@
 # Glossary
+**Slim review** — the RPL-08 low-risk fast lane.
`;

const WATCHER_DIFF = `diff --git a/src/watcher.mjs b/src/watcher.mjs
--- a/src/watcher.mjs
+++ b/src/watcher.mjs
@@ -1 +1,2 @@
 const a = 1;
+const b = 2;
`;

function tempRoot() {
  return mkdtempSync(path.join(tmpdir(), 'review-mode-latency-'));
}

function decide(diff, labels = []) {
  return evaluateSlimReviewEligibilityForDiff({ diff, labels, policy: POLICY });
}

function readEvents(rootDir) {
  const db = openReviewStateDb(rootDir);
  try {
    ensureReviewStateSchema(db);
    return db.prepare(
      `SELECT repo, pr_number, revision_ref, event_type, stage, source, source_ref,
              idempotency_key, reason, payload_json
         FROM review_latency_events
        WHERE event_type = ?
        ORDER BY event_id`
    ).all(REVIEW_MODE_SELECTED_EVENT);
  } finally {
    db.close();
  }
}

test('a slim decision is recorded with its classification and diff stats', () => {
  const rootDir = tempRoot();
  const result = recordReviewModeSelected({
    rootDir,
    repo: REPO,
    prNumber: 4242,
    headSha: 'abc123',
    attemptNumber: 1,
    reviewerModel: 'gemini',
    decision: decide(DOCS_DIFF),
    log: SILENT_LOG,
  });
  assert.equal(result.recorded, true);

  const [row] = readEvents(rootDir);
  assert.equal(row.repo, REPO);
  assert.equal(row.pr_number, 4242);
  assert.equal(row.revision_ref, 'abc123');
  assert.equal(row.stage, 'diagnostics');
  assert.equal(row.source, 'reviewer');
  assert.equal(row.source_ref, 'gemini');
  assert.equal(row.reason, REVIEW_MODE.SLIM);

  const payload = JSON.parse(row.payload_json);
  assert.equal(payload.mode, REVIEW_MODE.SLIM);
  assert.equal(payload.slim, true);
  assert.equal(payload.forcedBy, null);
  assert.deepEqual(payload.lowRiskClasses, ['docs']);
  assert.deepEqual(payload.refusalCodes, []);
  assert.equal(payload.stats.files, 1);
  assert.equal(payload.attemptNumber, 1);
});

test('full and forced-full are recorded as distinct modes', () => {
  const rootDir = tempRoot();
  recordReviewModeSelected({
    rootDir, repo: REPO, prNumber: 1, headSha: 'h1', attemptNumber: 1,
    decision: decide(WATCHER_DIFF), log: SILENT_LOG,
  });
  recordReviewModeSelected({
    rootDir, repo: REPO, prNumber: 2, headSha: 'h2', attemptNumber: 1,
    decision: decide(DOCS_DIFF, [FORCE_FULL_REVIEW_LABEL]), log: SILENT_LOG,
  });

  const rows = readEvents(rootDir);
  assert.deepEqual(rows.map((row) => row.reason), [REVIEW_MODE.FULL, REVIEW_MODE.FORCED_FULL]);
  const forced = JSON.parse(rows[1].payload_json);
  assert.equal(forced.forcedBy, `label:${FORCE_FULL_REVIEW_LABEL}`);
  const full = JSON.parse(rows[0].payload_json);
  assert.ok(full.refusalCodes.includes('gate-keeper-path'));
});

test('the same attempt on the same head records exactly one row', () => {
  const rootDir = tempRoot();
  const args = {
    rootDir, repo: REPO, prNumber: 7, headSha: 'head-1', attemptNumber: 1,
    decision: decide(DOCS_DIFF), log: SILENT_LOG,
  };
  recordReviewModeSelected(args);
  recordReviewModeSelected(args);
  assert.equal(readEvents(rootDir).length, 1);
});

test('a new head or a new attempt records its own row', () => {
  const rootDir = tempRoot();
  recordReviewModeSelected({
    rootDir, repo: REPO, prNumber: 7, headSha: 'head-1', attemptNumber: 1,
    decision: decide(DOCS_DIFF), log: SILENT_LOG,
  });
  recordReviewModeSelected({
    rootDir, repo: REPO, prNumber: 7, headSha: 'head-1', attemptNumber: 2,
    decision: decide(DOCS_DIFF), log: SILENT_LOG,
  });
  // Remediation widened the diff onto a gate-keeper surface: the PR leaves the
  // fast lane, and the report has to be able to see that transition.
  recordReviewModeSelected({
    rootDir, repo: REPO, prNumber: 7, headSha: 'head-2', attemptNumber: 3,
    decision: decide(WATCHER_DIFF), log: SILENT_LOG,
  });

  const rows = readEvents(rootDir);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((row) => row.reason), [
    REVIEW_MODE.SLIM, REVIEW_MODE.SLIM, REVIEW_MODE.FULL,
  ]);
});

test('a write failure degrades to a warning and never throws', () => {
  const warnings = [];
  const result = recordReviewModeSelected({
    rootDir: tempRoot(),
    repo: REPO,
    prNumber: 9,
    headSha: 'h',
    attemptNumber: 1,
    decision: decide(DOCS_DIFF),
    openDbImpl: () => { throw new Error('ENOENT: reviews.db is unreadable'); },
    log: { warn: (message) => warnings.push(message) },
  });
  assert.equal(result.recorded, false);
  assert.equal(result.reason, 'write-failed');
  // The caller still gets the decision summary, so the structured log line and
  // the posted-review audit block are unaffected by the failed write.
  assert.equal(result.summary.mode, REVIEW_MODE.SLIM);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /failed to record review-mode latency event/);
});

test('a missing subject is refused without touching the database', () => {
  let opened = 0;
  const result = recordReviewModeSelected({
    rootDir: null,
    repo: REPO,
    prNumber: 9,
    decision: decide(DOCS_DIFF),
    openDbImpl: () => { opened += 1; throw new Error('should not open'); },
    log: SILENT_LOG,
  });
  assert.equal(result.recorded, false);
  assert.equal(result.reason, 'missing-subject');
  assert.equal(opened, 0);
});

// ---------------------------------------------------------------------------
// Report rollup.
// ---------------------------------------------------------------------------

test('the latency report summarizes the review-mode mix and why slim was refused', () => {
  const rootDir = tempRoot();
  for (const [prNumber, diff, labels] of [
    [1, DOCS_DIFF, []],
    [2, DOCS_DIFF, []],
    [3, WATCHER_DIFF, []],
    [4, DOCS_DIFF, [FORCE_FULL_REVIEW_LABEL]],
  ]) {
    recordReviewModeSelected({
      rootDir, repo: REPO, prNumber, headSha: `h${prNumber}`, attemptNumber: 1,
      reviewerModel: 'gemini', decision: decide(diff, labels), log: SILENT_LOG,
    });
  }

  const report = collectReviewLatencyReport({ rootDir, since: '24h' });
  assert.equal(report.reviewModes.total, 4);
  assert.equal(report.reviewModes.slim, 2);
  assert.equal(report.reviewModes.full, 1);
  assert.equal(report.reviewModes['forced-full'], 1);
  assert.equal(report.reviewModes.unknownMode, 0);
  assert.equal(report.reviewModes.slimRate, 0.5);
  // Three, not two: the forced-full PR still carries the classification the
  // predicate derived, so an operator can see the override was applied to a
  // change the rules called low risk rather than to a risky one.
  assert.deepEqual(report.reviewModes.lowRiskClasses, [{ lowRiskClass: 'docs', count: 3 }]);

  const refusalCodes = report.reviewModes.topRefusals.map((item) => item.code);
  assert.ok(refusalCodes.includes('gate-keeper-path'));
  assert.ok(refusalCodes.includes('operator-forced-full'));

  const rendered = renderReviewLatencyReport(report);
  assert.match(rendered, /review modes: slim=2 full=1 forced_full=1 slim_rate=50%/);
  assert.match(rendered, /slim refused by: .*gate-keeper-path=1/);
});

test('a report over a database with no review-mode events stays well formed', () => {
  const report = collectReviewLatencyReport({ rootDir: tempRoot(), since: '24h' });
  assert.equal(report.reviewModes.total, 0);
  assert.equal(report.reviewModes.slimRate, null);
  assert.deepEqual(report.reviewModes.topRefusals, []);
  assert.match(renderReviewLatencyReport(report), /review modes: slim=0 full=0 forced_full=0 slim_rate=-/);
});

test('review_mode_selected is a diagnostic and defines no latency stage boundary', () => {
  const rootDir = tempRoot();
  recordReviewModeSelected({
    rootDir, repo: REPO, prNumber: 1, headSha: 'h1', attemptNumber: 1,
    decision: decide(DOCS_DIFF), log: SILENT_LOG,
  });
  const report = collectReviewLatencyReport({ rootDir, since: '24h' });
  assert.ok(report.eventTypes.includes(REVIEW_MODE_SELECTED_EVENT));
  for (const stage of report.stages) {
    assert.equal(stage.sampleCount, 0, `${stage.key} must not be driven by a diagnostic event`);
  }
});
