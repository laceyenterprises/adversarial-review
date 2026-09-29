// RPL-08 — review-mode selection, as one call the reviewer can make.
//
// `slim-review-eligibility.mjs` holds the pure predicate and
// `review-mode-latency.mjs` holds the durable record; this is the orchestration
// that runs them in order and hands `reviewer.mjs` a single decision object.
// ARC-10 keeps `reviewer.mjs` a thin site: the ratchet on that file exists
// precisely so features land as leaf modules instead of another hundred lines
// of inline orchestration.

import { voidSingleReviewCredit } from './follow-up-jobs.mjs';
import { pickReviewerStage } from './kernel/prompt-stage.mjs';
import { formatAdvisoryFindingsContext } from './prompt-context.mjs';
import { sleepSync } from './sqlite-busy-retry.mjs';
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
 * @param {{reviewAttemptNumber?: number, maxRemediationRounds?: number}|null} [params.stageContext]
 *   The watcher's stage inputs, used to re-pick the prompt stage after a
 *   single-review credit was voided.
 * @param {object} [params.log]
 * @returns {ReturnType<typeof evaluateSlimReviewEligibilityForDiff>}
 * @throws {Error} Only when a single-review credit void could not be persisted.
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
  voidSingleReviewCreditImpl = voidSingleReviewCredit,
  sleepImpl = sleepSync,
  stageContext = null,
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
  // A spent credit that could not be revoked is the one failure this module
  // does not absorb: it throws so the reviewer exits non-zero before dispatch
  // and the pass stays retryable (see `voidCredit`).
  // After a slim-classification failure there is no durable review-mode row
  // for the reaper to read back, so the lane is not applied (normal rounds);
  // a spent single-review credit can still be voided.
  decision.singleReview = selectSingleReview({
    rootDir, repo, prNumber, diff, labels, headSha, promptStage, env,
    allowApply: !slimClassificationFailed,
    resolveSingleReviewPolicyImpl, voidSingleReviewCreditImpl, sleepImpl, log,
  });
  if (decision.singleReview.voidFailed) {
    throw new Error(
      `single-review credit void did not persist for ${repo}#${prNumber}; ` +
      `refusing to review until it does: ${decision.singleReview.voidFailed.error}`,
    );
  }
  decision.promptStage = decision.singleReview.applied ? 'last' : promptStage;
  if (decision.singleReview.voided?.voided && stageContext) {
    try {
      decision.promptStage = pickReviewerStage({
        reviewAttemptNumber: stageContext.reviewAttemptNumber,
        completedRemediationRounds: decision.singleReview.voided.completedRoundsForPR,
        maxRemediationRounds: stageContext.maxRemediationRounds,
      });
    } catch (err) {
      log?.warn?.(`[reviewer] WARN: single-review re-stage failed for ${repo}#${prNumber}; keeping stage=${promptStage}: ${err?.message || err}`);
    }
  }
  // The reviewer's start line logs the watcher-computed stage; say which one runs.
  if (decision.promptStage !== promptStage) {
    log?.log?.(`[reviewer] Effective prompt stage for ${repo}#${prNumber}: ${decision.promptStage} (was ${promptStage}; single-review)`);
  }
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
  rootDir = null,
  repo,
  prNumber,
  diff,
  labels = [],
  headSha = null,
  promptStage = null,
  env = process.env,
  allowApply = true,
  resolveSingleReviewPolicyImpl = resolveSingleReviewPolicy,
  voidSingleReviewCreditImpl = voidSingleReviewCredit,
  sleepImpl = sleepSync,
  log = console,
} = {}) {
  try {
    const classification = classifySuperSmallForDiff({
      diff,
      labels,
      policy: resolveSingleReviewPolicyImpl({ env }),
    });
    const firstReview = promptStage === 'first';
    const applied = classification.superSmall && firstReview && allowApply === true;
    // A later head that no longer qualifies gets the PR's tier budget back,
    // so the change cannot be split into a small first push plus a sensitive
    // follow-up. No-op unless the ledger holds a single-review stop.
    const voided = !firstReview && !classification.superSmall && rootDir
      ? voidCredit({ rootDir, repo, prNumber, headSha, reasons: classification.reasons, voidSingleReviewCreditImpl, sleepImpl, log })
      : null;
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
      ...(voided?.voided ? { voided } : {}),
      ...(voided?.failed ? { voidFailed: { error: voided.error } } : {}),
    };
  } catch (err) {
    log?.warn?.(
      `[reviewer] WARN: single-review classification failed for ${repo}#${prNumber}; ` +
      `keeping normal rounds: ${err?.message || err}`
    );
    return { applied: false, superSmall: false, basis: null, reasons: [{ code: 'classification-failed' }], stats: null, headSha: headSha || null };
  }
}

const VOID_CREDIT_ATTEMPTS = 3;
const VOID_CREDIT_RETRY_BASE_MS = 100;

// The void is the only thing that takes a spent credit back, so it is not
// fail-soft: a head that outgrew the lane must not run the lenient `last`
// stage while the old credit still exhausts its budget. A transient write
// failure is retried; a persistent one returns `failed: true`, which the
// reviewer turns into a retryable pass failure before any dispatch.
function voidCredit({ rootDir, repo, prNumber, headSha, reasons, voidSingleReviewCreditImpl, sleepImpl = sleepSync, log }) {
  let lastError = null;
  for (let attempt = 1; attempt <= VOID_CREDIT_ATTEMPTS; attempt += 1) {
    try {
      const voided = voidSingleReviewCreditImpl({ rootDir, repo, prNumber, headSha, reasons });
      if (voided?.voided) {
        const codes = [...new Set((reasons || []).map((reason) => reason.code))].join(',') || 'unknown';
        log?.log?.(
          `[reviewer] single-review: voided ${repo}#${prNumber} credit — head no longer super-small (${codes}); ` +
          `completed rounds ${voided.previousCompletedRounds} -> ${voided.completedRoundsForPR}`,
        );
      }
      return voided;
    } catch (err) {
      lastError = err;
      log?.warn?.(
        `[reviewer] WARN: single-review void attempt ${attempt}/${VOID_CREDIT_ATTEMPTS} failed for ` +
        `${repo}#${prNumber}: ${err?.message || err}`,
      );
      if (attempt < VOID_CREDIT_ATTEMPTS) sleepImpl(VOID_CREDIT_RETRY_BASE_MS * attempt);
    }
  }
  return { voided: false, failed: true, error: String(lastError?.message || lastError || 'unknown') };
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
