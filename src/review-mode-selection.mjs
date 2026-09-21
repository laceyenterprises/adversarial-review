// RPL-08 — review-mode selection, as one call the reviewer can make.
//
// `slim-review-eligibility.mjs` holds the pure predicate and
// `review-mode-latency.mjs` holds the durable record; this is the orchestration
// that runs them in order and hands `reviewer.mjs` a single decision object.
// ARC-10 keeps `reviewer.mjs` a thin site: the ratchet on that file exists
// precisely so features land as leaf modules instead of another hundred lines
// of inline orchestration.

import { formatAdvisoryFindingsContext } from './prompt-context.mjs';
import { recordReviewModeSelected } from './review-mode-latency.mjs';
import {
  REVIEW_MODE,
  SLIM_REVIEW_REFUSAL,
  buildSlimReviewContextBanner,
  evaluateSlimReviewEligibilityForDiff,
  resolveSlimReviewPolicy,
  summarizeReviewModeDecision,
} from './slim-review-eligibility.mjs';

// What this function returns when anything inside it goes wrong. It is the
// shape of "classify nothing, change nothing": full mode, today's context
// bundle, today's behaviour.
function fullModeFallback(reason) {
  return {
    mode: REVIEW_MODE.FULL,
    slim: false,
    forcedBy: null,
    refusals: [{ code: SLIM_REVIEW_REFUSAL.CHANGED_FILES_UNKNOWN, detail: reason }],
    lowRiskClasses: [],
    stats: { files: 0, added: 0, removed: 0, changedLines: 0 },
  };
}

/**
 * Classify the PR, log the decision, and record it durably.
 *
 * The classification reads the diff the reviewer already fetched, so no GitHub
 * round trip is added to the review hot path — spending latency to decide
 * whether to save latency would defeat the ticket.
 *
 * NOTHING in here can fail the review. The predicate is pure table lookups and
 * the durable record is best-effort, so a throw should be impossible — but this
 * runs between "diff fetched" and "review generated", and a throw at that point
 * costs the PR its gate while still burning attempt budget. That is the
 * `adversarial-review.pipeline-availability` failure class, and it is not worth
 * risking for a latency optimisation. Any error degrades to full mode, which is
 * exactly the behaviour that shipped before RPL-08.
 *
 * @param {object} params
 * @param {string} params.rootDir                    Repository root (for `data/reviews.db`).
 * @param {string} params.repo                       `owner/name`.
 * @param {number} params.prNumber
 * @param {string} params.diff                       The fetched unified diff.
 * @param {Array<string|{name?: string}>} [params.labels]
 * @param {string|{login?: string}} [params.author]  PR author login.
 * @param {string|null} [params.headSha]
 * @param {number|null} [params.attemptNumber]
 * @param {string|null} [params.reviewerModel]
 * @param {string|null} [params.promptStage]
 * @param {object} [params.env]
 * @param {Function} [params.logStructuredEventImpl]  Seam for tests.
 * @param {Function} [params.recordReviewModeSelectedImpl]  Seam for tests.
 * @param {object} [params.log]
 * @returns {ReturnType<typeof evaluateSlimReviewEligibilityForDiff>}
 */
export function selectReviewMode({
  rootDir,
  repo,
  prNumber,
  diff,
  labels = [],
  author = null,
  headSha = null,
  attemptNumber = null,
  reviewerModel = null,
  promptStage = null,
  env = process.env,
  logStructuredEventImpl = null,
  recordReviewModeSelectedImpl = recordReviewModeSelected,
  log = console,
} = {}) {
  let decision;
  try {
    decision = evaluateSlimReviewEligibilityForDiff({
      diff,
      labels,
      author,
      policy: resolveSlimReviewPolicy(env),
    });
  } catch (err) {
    log?.warn?.(
      `[reviewer] WARN: review-mode classification failed for ${repo}#${prNumber}; ` +
      `falling back to full review: ${err?.message || err}`
    );
    return fullModeFallback('classification-failed');
  }

  try {
    const summary = summarizeReviewModeDecision(decision);
    logStructuredEventImpl?.(log, {
      event: 'review-mode-selection',
      level: 'info',
      repo,
      prNumber,
      headSha,
      reviewerModel,
      promptStage,
      mode: summary.mode,
      forcedBy: summary.forcedBy,
      lowRiskClasses: summary.lowRiskClasses,
      refusals: summary.refusals,
      changedFiles: summary.stats.files,
      changedLines: summary.stats.changedLines,
    });

    recordReviewModeSelectedImpl({
      rootDir, repo, prNumber, headSha, attemptNumber, reviewerModel, decision, log,
    });
  } catch (err) {
    // The decision itself is sound; only its observability failed. Keep it —
    // downgrading a correct classification because a log write threw would
    // trade real latency for nothing.
    log?.warn?.(
      `[reviewer] WARN: review-mode telemetry failed for ${repo}#${prNumber}: ${err?.message || err}`
    );
  }

  return decision;
}

/**
 * The slim replacement for the full reviewer context bundle.
 *
 * Two builders are deliberately absent. `fetchLinkedSpecContents` makes up to
 * twelve `gh api` content reads of up to 12 000 characters each — wall-clock on
 * the hot path, and on AGY also argv budget, where overflowing reroutes the
 * review to a costlier model or to chunking. `buildHardeningReviewContext`
 * spawns python3 against the session ledger and matches hardening contracts by
 * location path; every registered location is a gate-keeper surface, and
 * gate-keeper surfaces cannot reach this function, so for an eligible PR that
 * query is guaranteed cost and guaranteed silence.
 *
 * Advisory findings stay: they are already in memory and they are the watcher
 * speaking about this specific PR.
 *
 * @param {object} params
 * @param {string} params.repo
 * @param {number} params.prNumber
 * @param {object} params.decision                From {@link selectReviewMode}.
 * @param {Array<object>} [params.advisoryFindings]
 * @param {object} [params.log]
 * @returns {string}
 */
export function buildSlimReviewerExtraContext({
  repo,
  prNumber,
  decision,
  advisoryFindings = [],
  log = console,
} = {}) {
  const context = `${buildSlimReviewContextBanner(decision)}${formatAdvisoryFindingsContext(advisoryFindings)}`;
  log?.error?.(
    `[reviewer] DEBUG: slim review context for ${repo}#${prNumber} (${context.length} bytes; ` +
    'linked-spec and hardening-ledger context skipped)'
  );
  return context;
}

export { buildReviewModeAuditBlock } from './slim-review-eligibility.mjs';
