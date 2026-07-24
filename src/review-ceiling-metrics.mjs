import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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

// REVIEW-DEDUP: the hard re-review ceiling must count DISTINCT reviewed head
// SHAs, not raw review events. `reviewed_prs.review_attempts` increments on
// every attempt — including duplicate reviews of an unchanged head and failed
// posts — so keying the ceiling on it let a single real round plus its
// duplicates trip the cap and deadlock the PR. Counting distinct completed-pass
// head SHAs makes duplicates of one head cost nothing against the ceiling while
// still bounding genuine head churn. Legacy passes with a NULL head_sha are not
// distinct-countable; callers fall back to `review_attempts` when this returns
// 0 so the safety cap never silently disengages for pre-`head_sha` rows.
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

// REVIEW-DEDUP: the hard ceiling needs a bounded landed-review count, not a raw
// event count. Completed modern heads collapse to one unit per head; failed or
// running attempts are attempt evidence, but they are not reviews and must not
// burn the final review a PR is owed. Legacy completed null-head pass rows
// remain bounded because their head cannot be de-duped.
export function countReviewCeilingUnits({
  db: dbOverride = null,
  rootDir = ROOT,
  repoPath,
  prNumber,
  fallbackReviewAttempts = 0,
} = {}) {
  const ownedDb = dbOverride ? null : openReviewStateDb(rootDir);
  const readDb = dbOverride || ownedDb;
  try {
    if (!dbOverride) ensureReviewStateSchema(readDb);
    const row = readDb.prepare(
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
          AND pass_kind IN ('first-pass', 'rereview')`
    ).get(repoPath, prNumber);
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
