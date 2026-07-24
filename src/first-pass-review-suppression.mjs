import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { fetchSubmittedReviewsForHead } from './github-api.mjs';
import { resolveRoundBudgetForJob, summarizePRRemediationLedger } from './follow-up-jobs.mjs';
import {
  countCompletedReviewerRereviewRounds,
  hasCompletedReviewerRereviewAfter,
} from './review-ceiling-metrics.mjs';
import { REVIEWER_CYCLE_CAP_REACHED_LABEL } from './review-cycle-cap.mjs';
import { isAutomaticReviewCycleCapPause, normalizeLabelNames } from './review-cycle-cap-actions.mjs';
import { isExplicitOperatorRetriggerReason } from './retrigger-review-reason.mjs';
import {
  stmtMarkFailed,
  stmtReleaseReviewLease,
  stmtRestoreSameHeadSuppressedReviewPosted,
} from './review-state-db.mjs';

const execFileAsync = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Adapt the GitHub reviews reader to the dedup gate's injectable shape. Keeps
// the authoritative signal a live per-review `commit_id` lookup (never the
// SQLite memo, never attestations, never a log grep).
export function fetchReviewsForHeadForDedup({ repoPath, prNumber, headSha, reviewerLogins } = {}) {
  return fetchSubmittedReviewsForHead(execFileAsync, repoPath, prNumber, headSha, {
    authoritativeReviewerLogins: reviewerLogins,
  });
}

export function resolveFirstPassReviewBudgetSuppression({
  rootDir = ROOT,
  domainId,
  repoPath,
  prNumber,
  linearTicketId = null,
  reviewRow = null,
  currentHeadSha = null,
  labelNames = [],
  logger = console,
  db: dbOverride = null,
  summarizePRRemediationLedgerImpl = summarizePRRemediationLedger,
  resolveRoundBudgetForJobImpl = resolveRoundBudgetForJob,
  countCompletedReviewerRereviewRoundsImpl = countCompletedReviewerRereviewRounds,
  hasCompletedReviewerRereviewAfterImpl = hasCompletedReviewerRereviewAfter,
} = {}) {
  const normalizedLabelNames = new Set(normalizeLabelNames(labelNames));
  if (
    normalizedLabelNames.has(REVIEWER_CYCLE_CAP_REACHED_LABEL) ||
    isAutomaticReviewCycleCapPause(reviewRow)
  ) {
    return {
      suppressed: true,
      reason: 'review-cycle-cap-paused',
    };
  }

  // LAC-1559: the completed-rereview budget is keyed per (repo, pr, head). A
  // head move re-arms review because the new head reads 0 completed rounds,
  // while same-head re-reviews stay bounded by the per-risk round budget.
  const suppliedCurrentHeadSha =
    typeof currentHeadSha === 'string' && currentHeadSha.length > 0 ? currentHeadSha : null;

  let ledger;
  let resolution;
  let completedRereviewRounds = 0;
  try {
    ledger = summarizePRRemediationLedgerImpl(rootDir, { domainId, repo: repoPath, prNumber });
    completedRereviewRounds = countCompletedReviewerRereviewRoundsImpl({
      db: dbOverride,
      rootDir,
      domainId,
      repoPath,
      prNumber,
      headSha: suppliedCurrentHeadSha,
    });
    resolution = resolveRoundBudgetForJobImpl({
      linearTicketId,
      riskClass: ledger.latestRiskClass,
    }, { rootDir });
  } catch (err) {
    logger?.warn?.(
      `[watcher] first-pass review budget probe failed for ${repoPath}#${prNumber}; ` +
        `allowing review spawn path: ${err?.message || err}`
    );
    return {
      suppressed: false,
      reason: null,
      probeError: err?.message || String(err),
    };
  }

  const latestMaxRoundsValue = ledger.latestMaxRounds;
  const latestMaxRounds = Number(latestMaxRoundsValue);
  const hasLatestMaxRounds = latestMaxRoundsValue !== null && latestMaxRoundsValue !== undefined;
  const roundBudget = hasLatestMaxRounds &&
    Number.isInteger(latestMaxRounds) &&
    latestMaxRounds > resolution.roundBudget
      ? latestMaxRounds
      : resolution.roundBudget;
  const completedRemediationRoundsForPR = Number(ledger.completedRoundsForPR || 0);
  const completedRoundsForPR = Math.max(
    Number.isFinite(completedRemediationRoundsForPR) ? completedRemediationRoundsForPR : 0,
    Number.isFinite(completedRereviewRounds) ? completedRereviewRounds : 0,
  );
  const hasPositiveRoundBudget =
    Number.isFinite(roundBudget) &&
    roundBudget > 0;
  const remediationBudgetConsumed =
    Number.isFinite(completedRemediationRoundsForPR) &&
    Number.isFinite(roundBudget) &&
    roundBudget >= 0 &&
    completedRemediationRoundsForPR >= roundBudget;
  const postBudgetFinalReviewCompleted =
    Number.isFinite(completedRereviewRounds) &&
    remediationBudgetConsumed &&
    completedRereviewRounds >= roundBudget;
  let remediationBudgetConsumedAt = Array.isArray(ledger.completedRoundTimestamps)
    ? ledger.completedRoundTimestamps
        .filter(({ round, terminalAt }) => Number(round) >= roundBudget && typeof terminalAt === 'string')
        .map(({ terminalAt }) => terminalAt)
        .sort()[0] || null
    : null;
  if (remediationBudgetConsumedAt === null && roundBudget === 0 && completedRemediationRoundsForPR === 0) {
    remediationBudgetConsumedAt = '1970-01-01T00:00:00.000Z';
  }
  // #81: prove the single owed final review independently of the author-push
  // budget. Reviewers may coalesce intermediate pushes, so their lifetime
  // rereview count is not comparable to the remediation round number.
  const postBudgetFinalReviewCompletedForPR =
    remediationBudgetConsumed &&
    remediationBudgetConsumedAt !== null &&
    hasCompletedReviewerRereviewAfterImpl({
      db: dbOverride,
      rootDir,
      repoPath,
      prNumber,
      after: remediationBudgetConsumedAt,
    });
  const rereviewBudgetConsumed =
    Number.isFinite(completedRereviewRounds) &&
    hasPositiveRoundBudget &&
    completedRereviewRounds >= roundBudget;
  // Head-aware override: a moved-to / never-reviewed CURRENT head owes exactly
  // one final review after the remediation budget is consumed. Return a
  // distinct reason so the caller treats that pass as the terminal lenient
  // review, not as another ordinary in-budget review cycle. A later moved head
  // over the remediation cap must keep using this owed-final-review signal;
  // otherwise a request-changes -> push-commit loop can bypass the remediation
  // round cap until only the absolute review-cycle cap remains.
  const reviewedHeadSha =
    typeof reviewRow?.reviewer_head_sha === 'string' && reviewRow.reviewer_head_sha.length > 0
      ? reviewRow.reviewer_head_sha
      : null;
  // `reviewer_head_sha` is set when the reviewer STARTS a head and survives a
  // failed attempt: the failure paths (stmtReleaseReviewLease / stmtMarkFailed)
  // record failed_at + failure_message but leave reviewer_head_sha intact. Keyed
  // only on reviewer_head_sha, the watcher therefore treats a review that failed
  // BEFORE posting to GitHub (e.g. a gemini exec SIGKILL / `[unknown] command
  // failed` shape) as "already reviewed", so `same-head-already-reviewed`
  // suppresses the retry and the caller fabricates a `posted` row (via
  // stmtRestoreSameHeadSuppressedReviewPosted) for a review that never reached
  // GitHub — the 2026-07-14 phantom-suppression bug that permanently blocked
  // re-review + landing of otherwise-clean PRs. A same-head match therefore only
  // counts as reviewed when the row carries NO unresolved failure: a failed_at
  // that has not been superseded by a later posted_at means the last attempt on
  // this head failed, so it stays retryable. This also covers the
  // moved-head-then-refailed case (failed_at > posted_at) while preserving the
  // legitimate RRD-01 dedup — an ordinary already-reviewed same-head repeat has
  // no failure recorded and is still suppressed.
  const parseReviewTimestamp = (value) => {
    if (typeof value !== 'string' || value.length === 0) return Number.NaN;
    // Normalize a timezone-less datetime to UTC before parsing. SQLite's
    // CURRENT_TIMESTAMP uses a space separator ("YYYY-MM-DD HH:MM:SS"); accept a
    // `T` separator too so a JS `.toISOString()` value that lost its trailing `Z`
    // is still pinned to UTC instead of falling through to Date.parse's local-time
    // interpretation (which would skew failure/lease ordering on a non-UTC host).
    const normalized = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(value)
      ? `${value.replace(' ', 'T')}Z`
      : value;
    return Date.parse(normalized);
  };
  const failedAtMs = parseReviewTimestamp(reviewRow?.failed_at);
  const postedAtMs = parseReviewTimestamp(reviewRow?.posted_at);
  const reviewerLeaseExpiresAtMs = parseReviewTimestamp(reviewRow?.reviewer_lease_expires_at);
  const currentHeadReviewLeaseValid =
    Number.isFinite(reviewerLeaseExpiresAtMs) &&
    reviewerLeaseExpiresAtMs > Date.now();
  const currentHeadReviewInFlight =
    suppliedCurrentHeadSha !== null &&
    reviewedHeadSha === suppliedCurrentHeadSha &&
    reviewRow?.review_status === 'reviewing' &&
    currentHeadReviewLeaseValid;
  if (currentHeadReviewInFlight) {
    return {
      suppressed: true,
      reason: 'same-head-review-in-flight',
      completedRoundsForPR,
      roundBudget,
      riskClass: resolution.riskClass,
    };
  }
  const hasUnresolvedFailure =
    reviewRow?.review_status !== 'posted' &&
    Number.isFinite(failedAtMs) &&
    (!Number.isFinite(postedAtMs) || failedAtMs >= postedAtMs);
  const hasExpiredOrMissingReviewLease =
    reviewRow?.review_status === 'reviewing' &&
    !currentHeadReviewLeaseValid;
  const currentHeadAlreadyReviewed =
    suppliedCurrentHeadSha !== null &&
    reviewedHeadSha === suppliedCurrentHeadSha &&
    !hasExpiredOrMissingReviewLease &&
    !hasUnresolvedFailure;
  if (currentHeadAlreadyReviewed && !isExplicitOperatorReviewRetrigger(reviewRow)) {
    return {
      suppressed: true,
      reason: 'same-head-already-reviewed',
      completedRoundsForPR,
      roundBudget,
      riskClass: resolution.riskClass,
    };
  }
  const currentHeadOwesPostBudgetFinalReview =
    suppliedCurrentHeadSha !== null &&
    !currentHeadAlreadyReviewed &&
    remediationBudgetConsumed &&
    !postBudgetFinalReviewCompletedForPR;
  if (currentHeadOwesPostBudgetFinalReview) {
    return {
      suppressed: false,
      reason: 'owed-post-budget-final-review',
      completedRoundsForPR,
      roundBudget,
      riskClass: resolution.riskClass,
    };
  }
  // #81: the PR already spent its post-budget final review and a hammer moved the
  // head again — suppress the re-review so the exhausted PR closes via the AMA
  // exhaustion->merge path (hammer terminal remediation) instead of re-opening
  // findings on every remediation push. This is the operator AMA policy: the
  // hammer closes on exhaustion, no gating re-review.
  if (postBudgetFinalReviewCompletedForPR) {
    return {
      suppressed: true,
      reason: 'post-budget-final-review-completed-for-pr',
      completedRoundsForPR,
      roundBudget,
      riskClass: resolution.riskClass,
    };
  }
  if (postBudgetFinalReviewCompleted) {
    return {
      suppressed: true,
      reason: 'remediation-round-budget-exhausted',
      completedRoundsForPR,
      roundBudget,
      riskClass: resolution.riskClass,
    };
  }
  if (rereviewBudgetConsumed) {
    return {
      suppressed: true,
      reason: 'remediation-round-budget-exhausted',
      completedRoundsForPR,
      roundBudget,
      riskClass: resolution.riskClass,
    };
  }

  return {
    suppressed: false,
    reason: null,
    completedRoundsForPR,
    roundBudget,
    riskClass: resolution.riskClass,
  };
}

export const getStalePostedReviewBudgetSuppression = resolveFirstPassReviewBudgetSuppression;

export function isExplicitOperatorReviewRetrigger(reviewRow = null) {
  return Boolean(
    reviewRow?.rereview_requested_at
    && isExplicitOperatorRetriggerReason(reviewRow.rereview_reason)
  );
}
