// RPL-08 — durable latency record for the review-mode decision.
//
// `slim-review-eligibility.mjs` is pure and must stay pure; this is the one
// impure edge that turns its decision into a row the latency report can read.
//
// It is best-effort on purpose. The reviewer's job is to post a review, and a
// diagnostic write must never be able to stop it: a locked `reviews.db`, a
// schema older than this deploy, or a missing data directory all degrade to a
// warning. Losing a diagnostic row costs one line of a report; failing the
// review costs the PR its gate and burns attempt budget (the
// `adversarial-review.pipeline-availability` failure class — 603 logged review
// posts lost to a non-review failure on the post path).

import { openReviewStateDb, ensureReviewStateSchema } from './review-state.mjs';
import { recordReviewLatencyEvent } from './review-latency-event-writer.mjs';
import { withSqliteBusyRetrySync } from './sqlite-busy-retry.mjs';
import { summarizeReviewModeDecision } from './slim-review-eligibility.mjs';

export const REVIEW_MODE_SELECTED_EVENT = 'review_mode_selected';

/**
 * Record which review mode a reviewer pass ran in.
 *
 * Idempotency is keyed on `(repo, pr, head, attempt)` so a reviewer that is
 * restarted or reattached on the same attempt writes one row, while a genuine
 * re-review on a new head or a new attempt writes its own — the report needs to
 * see a PR that fell out of the fast lane after remediation widened its diff.
 *
 * @param {object} params
 * @param {string} params.rootDir                 Repository root holding `data/reviews.db`.
 * @param {string} params.repo                    `owner/name`.
 * @param {number} params.prNumber
 * @param {string|null} [params.headSha]          Reviewed head.
 * @param {number|null} [params.attemptNumber]
 * @param {string|null} [params.reviewerModel]
 * @param {object} params.decision                From `evaluateSlimReviewEligibility`.
 * @param {Function} [params.openDbImpl]          Seam for tests.
 * @param {Function} [params.recordEventImpl]     Seam for tests.
 * @param {object} [params.log]
 * @returns {{recorded: boolean, reason?: string, summary: object}}
 */
export function recordReviewModeSelected({
  rootDir,
  repo,
  prNumber,
  headSha = null,
  attemptNumber = null,
  reviewerModel = null,
  decision,
  openDbImpl = openReviewStateDb,
  recordEventImpl = recordReviewLatencyEvent,
  log = console,
} = {}) {
  const summary = summarizeReviewModeDecision(decision);
  if (!rootDir || !repo || !Number.isInteger(Number(prNumber))) {
    return { recorded: false, reason: 'missing-subject', summary };
  }

  try {
    withSqliteBusyRetrySync(() => {
      const db = openDbImpl(rootDir);
      try {
        ensureReviewStateSchema(db);
        recordEventImpl(db, {
          repo,
          prNumber: Number(prNumber),
          domainId: 'code-pr',
          subjectExternalId: `${repo}#${prNumber}`,
          revisionRef: headSha || null,
          eventType: REVIEW_MODE_SELECTED_EVENT,
          source: 'reviewer',
          sourceRef: reviewerModel || null,
          idempotencyKey: `review-mode:${repo}#${prNumber}:${headSha || 'unknown-head'}:${attemptNumber ?? 'unknown-attempt'}`,
          // `reason` is the single discriminant the report groups on, so it
          // carries the mode and nothing else; the detail lives in the payload.
          reason: summary.mode,
          payload: {
            mode: summary.mode,
            slim: summary.slim,
            forcedBy: summary.forcedBy,
            lowRiskClasses: summary.lowRiskClasses,
            refusalCodes: summary.refusalCodes,
            stats: summary.stats,
            reviewerModel: reviewerModel || null,
            attemptNumber: Number.isFinite(Number(attemptNumber)) ? Number(attemptNumber) : null,
          },
        });
      } finally {
        db.close();
      }
    }, { label: `review-mode-latency:${repo}#${prNumber}`, log });
    return { recorded: true, summary };
  } catch (err) {
    log?.warn?.(
      `[reviewer] WARN: failed to record review-mode latency event for ${repo}#${prNumber}: ${err?.message || err}`,
    );
    return { recorded: false, reason: 'write-failed', summary };
  }
}
