import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { collectReviewPipelineHealth } from '../src/review-pipeline-health.mjs';
import { DEFAULT_REVIEWER_LEASE_RECOVERY_MAX_ATTEMPTS } from '../src/reviewer-lease.mjs';
import { ensureReviewStateSchema, openReviewStateDb } from '../src/review-state.mjs';

const NOW = '2026-08-11T18:00:00.000Z';
const REPO = 'laceyenterprises/adversarial-review';
const CAP = DEFAULT_REVIEWER_LEASE_RECOVERY_MAX_ATTEMPTS;

function tempRoot() {
  return mkdtempSync(path.join(tmpdir(), 'review-pipeline-health-stuck-'));
}

function openDb(rootDir) {
  const db = openReviewStateDb(rootDir);
  ensureReviewStateSchema(db);
  return db;
}

// Insert a reviewed_prs row including infra_auto_recover_attempts, which the
// shared insertReviewRow helper in review-pipeline-health.test.mjs does not
// cover. Column defaults come from the ensured schema, so an omitted attempt
// count falls back to 0.
function insertReviewRow(rootDir, overrides = {}) {
  const db = openDb(rootDir);
  try {
    db.prepare(
      `INSERT INTO reviewed_prs
         (repo, pr_number, reviewed_at, reviewer, pr_state, review_status,
          review_attempts, last_attempted_at, posted_at, failed_at,
          failure_message, infra_auto_recover_attempts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      overrides.repo || REPO,
      overrides.prNumber,
      overrides.reviewedAt || '2026-08-11T15:00:00.000Z',
      overrides.reviewer || 'claude',
      overrides.prState || 'open',
      overrides.reviewStatus || 'pending',
      overrides.reviewAttempts ?? 0,
      overrides.lastAttemptedAt ?? null,
      overrides.postedAt ?? null,
      overrides.failedAt ?? null,
      overrides.failureMessage ?? null,
      overrides.infraAutoRecoverAttempts ?? 0
    );
  } finally {
    db.close();
  }
}

function collect(rootDir) {
  return collectReviewPipelineHealth({ rootDir, now: () => new Date(NOW) });
}

function findingCodes(snapshot) {
  return snapshot.findings.map((finding) => finding.code);
}

test('stuck retry-loop finding fires for a failed PR at the infra auto-recovery cap', () => {
  const rootDir = tempRoot();
  insertReviewRow(rootDir, {
    prNumber: 5231,
    reviewStatus: 'failed',
    failedAt: '2026-08-11T15:30:00.000Z',
    failureMessage: '[oauth-broken] reviewer session token refresh failed',
    infraAutoRecoverAttempts: CAP,
  });

  const snapshot = collect(rootDir);
  assert.ok(findingCodes(snapshot).includes('review:stuck_retry_loop'));

  const finding = snapshot.findings.find((f) => f.code === 'review:stuck_retry_loop');
  // Page-severity intent; the collector clamps every source-level finding to
  // ticket in buildFinding (the review-freshness detector owns the sole page
  // for this domain), so the emitted tier is 'ticket'.
  assert.equal(finding.tier, 'ticket');
  assert.equal(finding.category, 'review-pipeline');
  // Names the affected PR (repo#number) in subject/message/evidence.
  assert.ok(finding.message.includes(`${REPO}#5231`));
  assert.ok(finding.evidence.some((line) => line.includes(`${REPO}#5231`)));
  assert.ok(/investigate reviewer auth\/infra/i.test(finding.recommended_action));
  assert.ok(/spawn an SRE/i.test(finding.recommended_action));
  // Surfaces the dominant failure class classified from failure_message.
  assert.equal(finding.details.dominantFailureClass, 'auth');
  assert.equal(finding.details.count, 1);
  assert.equal(finding.details.cap, CAP);

  // Structured sub-object is present on the snapshot without paging.
  assert.equal(snapshot.stuckReviewLoops.prs.length, 1);
  assert.equal(snapshot.stuckReviewLoops.prs[0].prNumber, 5231);
  assert.equal(snapshot.stuckReviewLoops.prs[0].infraAutoRecoverAttempts, CAP);
});

test('stuck retry-loop finding fires for a PR over the cap and reports the dominant failure class', () => {
  const rootDir = tempRoot();
  // Two PRs auth-stuck, one timeout-stuck: auth should dominate.
  insertReviewRow(rootDir, {
    prNumber: 1,
    reviewStatus: 'failed',
    failureMessage: '[oauth-broken] credential refresh failed',
    infraAutoRecoverAttempts: CAP + 1,
  });
  insertReviewRow(rootDir, {
    prNumber: 2,
    reviewStatus: 'failed',
    failureMessage: '[oauth-broken] token invalid',
    infraAutoRecoverAttempts: CAP,
  });
  insertReviewRow(rootDir, {
    prNumber: 3,
    reviewStatus: 'failed',
    failureMessage: '[reviewer-timeout] no output before deadline',
    infraAutoRecoverAttempts: CAP,
  });

  const snapshot = collect(rootDir);
  const finding = snapshot.findings.find((f) => f.code === 'review:stuck_retry_loop');
  assert.ok(finding);
  assert.equal(finding.details.count, 3);
  assert.equal(finding.details.dominantFailureClass, 'auth');
  assert.deepEqual(
    finding.details.byFailureClass,
    [
      { failureClass: 'auth', count: 2 },
      { failureClass: 'timeout', count: 1 },
    ]
  );
});

test('stuck retry-loop finding does not fire for healthy or still-recovering PRs', () => {
  const rootDir = tempRoot();
  // Healthy posted PR.
  insertReviewRow(rootDir, {
    prNumber: 10,
    reviewStatus: 'posted',
    postedAt: '2026-08-11T16:00:00.000Z',
  });
  // Failed but still within the recovery budget (attempts below cap).
  insertReviewRow(rootDir, {
    prNumber: 11,
    reviewStatus: 'failed',
    failureMessage: '[provider-overloaded] 529 backend capacity',
    infraAutoRecoverAttempts: CAP - 1,
  });

  const snapshot = collect(rootDir);
  assert.ok(!findingCodes(snapshot).includes('review:stuck_retry_loop'));
  assert.equal(snapshot.stuckReviewLoops.prs.length, 0);
});

test('stuck retry-loop finding ignores capped-out failed rows on closed/merged PRs', () => {
  const rootDir = tempRoot();
  insertReviewRow(rootDir, {
    prNumber: 20,
    prState: 'closed',
    reviewStatus: 'failed',
    failureMessage: '[oauth-broken] token invalid',
    infraAutoRecoverAttempts: CAP,
  });

  const snapshot = collect(rootDir);
  assert.ok(!findingCodes(snapshot).includes('review:stuck_retry_loop'));
  assert.equal(snapshot.stuckReviewLoops.prs.length, 0);
});

test('stuck retry-loop check does not throw and emits no finding when the DB is missing', () => {
  const rootDir = tempRoot();
  // No reviews.db written under rootDir/data.
  const snapshot = collect(rootDir);
  assert.equal(snapshot.reviewStateLedger.exists, false);
  assert.ok(!findingCodes(snapshot).includes('review:stuck_retry_loop'));
  assert.deepEqual(snapshot.stuckReviewLoops.prs, []);
  assert.equal(snapshot.stuckReviewLoops.cap, CAP);
});
