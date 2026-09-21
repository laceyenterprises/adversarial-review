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
  buildSlimReviewContextBanner,
  evaluateSlimReviewEligibilityForDiff,
  resolveSlimReviewPolicy,
  summarizeReviewModeDecision,
} from './slim-review-eligibility.mjs';

/**
 * Classify the PR, log the decision, and record it durably.
 *
 * The classification reads the diff the reviewer already fetched, so no GitHub
 * round trip is added to the review hot path — spending latency to decide
 * whether to save latency would defeat the ticket.
 *
 * Neither the structured log nor the durable record can fail the review: the
 * record is best-effort by construction, and the log is a console write.
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
  const decision = evaluateSlimReviewEligibilityForDiff({
    diff,
    labels,
    author,
    policy: resolveSlimReviewPolicy(env),
  });
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
