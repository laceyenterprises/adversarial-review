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
import {
  classifySuperSmallForDiff,
  describeSuperSmallDecision,
  resolveSingleReviewPolicy,
} from './super-small-classifier.mjs';

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
  resolveSingleReviewPolicyImpl = resolveSingleReviewPolicy,
  log = console,
} = {}) {
  let decision;
  let slimClassificationFailed = false;
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
    decision = fullModeFallback('classification-failed');
    slimClassificationFailed = true;
  }
  // SINGLEREVIEW-01: decorated in place so the durable record and the caller
  // see the same object. `promptStage` is the stage the review must run at.
  decision.singleReview = selectSingleReview({
    repo, prNumber, diff, labels, headSha, promptStage, env, resolveSingleReviewPolicyImpl, log,
  });
  decision.promptStage = decision.singleReview.applied ? 'last' : promptStage;
  if (slimClassificationFailed) return decision;

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
      singleReview: decision.singleReview.applied,
      singleReviewReasons: decision.singleReview.reasons.map((reason) => reason.code),
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
 * SINGLEREVIEW-01 — is this review the PR's one and only review round?
 *
 * Applies only to a review that would otherwise run at the `first` stage: a PR
 * that has already been through remediation is on the normal round loop, and a
 * later push does not buy it a second fast lane. Fail-soft like the rest of
 * this module — any error means normal rounds, today's behaviour.
 *
 * @returns {{applied: boolean, superSmall: boolean, basis: string|null, reasons: Array<object>, stats: object|null, headSha: string|null}}
 */
export function selectSingleReview({
  repo,
  prNumber,
  diff,
  labels = [],
  headSha = null,
  promptStage = null,
  env = process.env,
  resolveSingleReviewPolicyImpl = resolveSingleReviewPolicy,
  log = console,
} = {}) {
  try {
    const classification = classifySuperSmallForDiff({
      diff,
      labels,
      policy: resolveSingleReviewPolicyImpl({ env }),
    });
    const firstReview = promptStage === 'first';
    const applied = classification.superSmall && firstReview;
    if (classification.superSmall) {
      log?.log?.(
        `[reviewer] single-review: super-small ${repo}#${prNumber} ${describeSuperSmallDecision(classification)}` +
        (applied ? '; prompt stage=last' : `; not applied — prompt stage=${promptStage || 'unknown'} is not the first review`),
      );
    }
    return {
      applied,
      superSmall: classification.superSmall,
      basis: classification.basis,
      reasons: applied || !classification.superSmall
        ? classification.reasons
        : [{ code: 'not-first-review', promptStage: promptStage || null }],
      stats: classification.stats,
      headSha: headSha || null,
    };
  } catch (err) {
    log?.warn?.(
      `[reviewer] WARN: single-review classification failed for ${repo}#${prNumber}; ` +
      `keeping normal rounds: ${err?.message || err}`
    );
    return { applied: false, superSmall: false, basis: null, reasons: [{ code: 'classification-failed' }], stats: null, headSha: headSha || null };
  }
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
