import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { reviewerFailureClassFromStoredRow } from './reviewer-failure-classification.mjs';
import { ensureReviewStateSchema, openReviewStateDb } from './review-state.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// ARC-18: process-wide shared review-state connection, opened the same way the
// watcher opens its singleton. `closeOwnedReviewStateDb` compares against this
// so a caller-injected or singleton-backed connection is never closed out from
// under the process. In production `openReviewStateDb` returns a fresh handle
// per call, so an owned db never equals this one and is always closed; under
// test harnesses that stub `openReviewStateDb` to a shared singleton, an owned
// handle IS this object and must be left open. Only used for identity here.
const db = openReviewStateDb(ROOT);

// Count completed reviewer rereview passes for a PR.
//
// LAC-1559 — when `headSha` is supplied, count only rereviews of THAT head
// (`head_sha = ?`), so a genuinely new head reads 0 completed rounds and the
// per-risk round budget re-arms review for it, while same-head re-reviews stay
// bounded. When `headSha` is omitted the count spans all heads for the PR
// (per-PR), which the review-cycle-exhaustion convergence check relies on so
// head-thrashing cannot dodge the final hammer forever. Legacy rows written
// before the `head_sha` column exists carry NULL and simply do not match a
// specific-head filter (fail-safe toward re-arming, self-healing as new passes
// record their head).
export function countCompletedReviewerRereviewRounds({
  db: dbOverride = null,
  rootDir = ROOT,
  repoPath,
  prNumber,
  headSha = null,
} = {}) {
  const normalizedHeadSha = typeof headSha === 'string' && headSha.trim() !== ''
    ? headSha.trim()
    : null;
  const ownedDb = dbOverride ? null : openReviewStateDb(rootDir);
  const readDb = dbOverride || ownedDb;
  try {
    if (!dbOverride) ensureReviewStateSchema(readDb);
    const baseSql =
      `SELECT COUNT(*) AS count
         FROM reviewer_passes
        WHERE repo = ?
          AND pr_number = ?
          AND pass_kind = 'rereview'
          AND status = 'completed'`;
    const row = normalizedHeadSha === null
      ? readDb.prepare(baseSql).get(repoPath, prNumber)
      : readDb.prepare(`${baseSql}\n          AND head_sha = ?`).get(repoPath, prNumber, normalizedHeadSha);
    const count = Number(row?.count || 0);
    return Number.isFinite(count) && count > 0 ? count : 0;
  } finally {
    closeOwnedReviewStateDb(ownedDb);
  }
}

export function hasCompletedReviewerRereviewAfter({
  db: dbOverride = null,
  rootDir = ROOT,
  repoPath,
  prNumber,
  after,
} = {}) {
  if (typeof after !== 'string' || after.length === 0) return false;
  const ownedDb = dbOverride ? null : openReviewStateDb(rootDir);
  const readDb = dbOverride || ownedDb;
  try {
    if (!dbOverride) ensureReviewStateSchema(readDb);
    const row = readDb.prepare(
      `SELECT 1
         FROM reviewer_passes
        WHERE repo = ?
          AND pr_number = ?
          AND pass_kind = 'rereview'
          AND status = 'completed'
          AND started_at >= ?
        LIMIT 1`
    ).get(repoPath, prNumber, after);
    return Boolean(row);
  } finally {
    closeOwnedReviewStateDb(ownedDb);
  }
}

// REVIEW-DEDUP: this diagnostic helper counts DISTINCT reviewed head SHAs for a
// PR, not raw review events. The live spawn ceiling below is intentionally
// *current-head* scoped: a reviewer outcome for a stale head must not spend the
// final review owed to the head currently proposed for merge.
export function countDistinctReviewedHeadShas({
  db: dbOverride = null,
  rootDir = ROOT,
  repoPath,
  prNumber,
} = {}) {
  const ownedDb = dbOverride ? null : openReviewStateDb(rootDir);
  const readDb = dbOverride || ownedDb;
  try {
    if (!dbOverride) ensureReviewStateSchema(readDb);
    const row = readDb.prepare(
      `SELECT COUNT(DISTINCT head_sha) AS count
         FROM reviewer_passes
        WHERE repo = ?
          AND pr_number = ?
          AND pass_kind IN ('first-pass', 'rereview')
          AND status = 'completed'
          AND head_sha IS NOT NULL
          AND head_sha <> ''`
    ).get(repoPath, prNumber);
    const count = Number(row?.count || 0);
    return Number.isFinite(count) && count > 0 ? count : 0;
  } finally {
    closeOwnedReviewStateDb(ownedDb);
  }
}

function closeOwnedReviewStateDb(ownedDb) {
  if (!ownedDb || ownedDb === db) return;
  ownedDb.close();
}

// REVIEW-DEDUP: the hard ceiling needs a bounded landed-review count for the
// CURRENT head, not a raw PR-lifetime event count. Each completed modern pass
// on that head consumes one unit: GitHub normally deduplicates same-head
// reviews, but this still protects explicit requeues and fail-open paths. A
// stale-head outcome cannot burn the final review owed to a later remediation
// head. Failed/running attempts are attempt evidence, but they are not reviews.
// When the caller supplies a head, legacy NULL-head records and the PR-wide
// review_attempts counter are deliberately ignored: neither can prove that the
// current head was reviewed. The ceiling therefore re-arms for a new head while
// remaining a real circuit breaker for repeated reviews of that new head.
export function countReviewCeilingUnits({
  db: dbOverride = null,
  rootDir = ROOT,
  repoPath,
  prNumber,
  headSha = null,
  fallbackReviewAttempts = 0,
} = {}) {
  const normalizedHeadSha = typeof headSha === 'string' && headSha.trim() !== ''
    ? headSha.trim()
    : null;
  const ownedDb = dbOverride ? null : openReviewStateDb(rootDir);
  const readDb = dbOverride || ownedDb;
  try {
    if (!dbOverride) ensureReviewStateSchema(readDb);
    if (normalizedHeadSha !== null) {
      const row = readDb.prepare(
        `SELECT COUNT(*) AS completed_current_head_passes
           FROM reviewer_passes
          WHERE repo = ?
            AND pr_number = ?
            AND pass_kind IN ('first-pass', 'rereview')
            AND status = 'completed'
            AND head_sha = ?`,
      ).get(repoPath, prNumber, normalizedHeadSha);
      const completedCurrentHeadPasses = Number(row?.completed_current_head_passes || 0);
      return Number.isFinite(completedCurrentHeadPasses) && completedCurrentHeadPasses > 0
        ? completedCurrentHeadPasses
        : 0;
    }
    const baseSql =
      `SELECT COUNT(*) AS pass_count,
              COUNT(DISTINCT CASE
                WHEN status = 'completed'
                 AND head_sha IS NOT NULL
                 AND head_sha <> ''
                THEN head_sha
              END) AS distinct_completed_heads,
              SUM(CASE
                WHEN status = 'completed'
                 AND (head_sha IS NULL OR head_sha = '')
                THEN 1 ELSE 0
              END) AS legacy_unknown_head_passes
         FROM reviewer_passes
        WHERE repo = ?
          AND pr_number = ?
          AND pass_kind IN ('first-pass', 'rereview')`;
    const row = readDb.prepare(baseSql).get(repoPath, prNumber);
    const passCount = Number(row?.pass_count || 0);
    if (!Number.isFinite(passCount) || passCount <= 0) {
      const fallback = Number(fallbackReviewAttempts || 0);
      return Number.isFinite(fallback) && fallback > 0 ? fallback : 0;
    }
    const distinctCompletedHeads = Number(row?.distinct_completed_heads || 0);
    const legacyUnknownHeadPasses = Number(row?.legacy_unknown_head_passes || 0);
    return [
      distinctCompletedHeads,
      legacyUnknownHeadPasses,
    ].reduce((total, value) => total + (Number.isFinite(value) && value > 0 ? value : 0), 0);
  } finally {
    closeOwnedReviewStateDb(ownedDb);
  }
}

// Failed/running attempts are not reviews, but they still need an independent,
// current-head fuse so a deterministically broken reviewer path cannot respawn
// forever. A failure on a stale head is not evidence that the new head is
// broken, so it cannot block the review that new head is owed.
export function countReviewCeilingAttempts({
  db: dbOverride = null,
  rootDir = ROOT,
  repoPath,
  prNumber,
  headSha = null,
  fallbackReviewAttempts = 0,
} = {}) {
  const normalizedHeadSha = typeof headSha === 'string' && headSha.trim() !== ''
    ? headSha.trim()
    : null;
  const ownedDb = dbOverride ? null : openReviewStateDb(rootDir);
  const readDb = dbOverride || ownedDb;
  try {
    if (!dbOverride) ensureReviewStateSchema(readDb);
    const baseSql =
      `SELECT status, metadata_json
         FROM reviewer_passes
        WHERE repo = ?
          AND pr_number = ?
          AND pass_kind IN ('first-pass', 'rereview')`;
    const rows = normalizedHeadSha === null
      ? readDb.prepare(baseSql).all(repoPath, prNumber)
      : readDb.prepare(`${baseSql}\n          AND head_sha = ?`).all(repoPath, prNumber, normalizedHeadSha);
    if (rows.length > 0) {
      const transientFleetInfraClasses = new Set([
        'adapter_spawn_timeout',
        'dispatch-failed',
        'launchctl-bootstrap',
        'oauth-broken',
      ]);
      return rows.reduce((count, row) => {
        if (row?.status !== 'failed') return count + 1;
        const failureClass = reviewerFailureClassFromStoredRow(row);
        if (transientFleetInfraClasses.has(failureClass)) return count;
        return count + 1;
      }, 0);
    }
    if (normalizedHeadSha !== null) return 0;
    const fallback = Number(fallbackReviewAttempts || 0);
    return Number.isFinite(fallback) && fallback > 0 ? fallback : 0;
  } finally {
    closeOwnedReviewStateDb(ownedDb);
  }
}

/**
 * A review cycle is exhausted when EITHER round budget is spent:
 * remediation rounds (a review produced blocking findings and a remediation
 * worker ran) OR re-review rounds (reviewers ran to their budget). A
 * comment-only review — no blocking findings, so no remediation worker spawns —
 * only ever advances the re-review counter, so keying exhaustion solely on
 * remediation rounds parks CI-green/CLEAN PRs forever. Pure so it is unit
 * testable without a ledger/DB fixture.
 */
export function reviewCycleExhaustedFromRounds({
  effectiveRoundBudget,
  completedRemediationRounds,
  completedRereviewRounds,
}) {
  if (!Number.isFinite(effectiveRoundBudget) || effectiveRoundBudget <= 0) {
    return false;
  }
  const remediation = Number(completedRemediationRounds);
  const rereview = Number(completedRereviewRounds);
  return (
    (Number.isFinite(remediation) && remediation >= effectiveRoundBudget) ||
    (Number.isFinite(rereview) && rereview >= effectiveRoundBudget)
  );
}
