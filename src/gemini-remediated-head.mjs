// GEMINIREMEDIATE-01: Gemini may remediate a PR that Gemini would otherwise
// review. The remediator fallback used to refuse Gemini whenever Gemini was the
// reviewer of the next round, so (Gemini being the always-on reviewer) it could
// never remediate. The rule it protects is "no model reviews a head it
// produced", and that rule can be kept per round instead: Gemini remediates,
// and the review of the head Gemini produced goes to another reviewer model.
//
// Two halves live here so both sides read one definition:
//   - `alternateReviewerForGeminiRemediation` — the remediator preflight: is
//     there a non-Gemini reviewer model that may review this builder's PR and
//     has quota? Without one the refusal stays (and says why).
//   - `geminiRemediatedReviewerExclusions` — the review router: has Gemini
//     already written commits on this PR? Then Gemini is excluded from every
//     later review of it, because each later head contains Gemini's work.
import { listFollowUpJobsInDir } from './follow-up-jobs.mjs';
import {
  GEMINI_REMEDIATED_HEAD_REASON,
  normalizeBuilderClass,
  reviewerRefusesBuilder,
} from './adapters/subject/github-pr/routing.mjs';

export { GEMINI_REMEDIATED_HEAD_REASON };
const GEMINI_REMEDIATOR_CLASSES = new Set(['gemini', 'remediator-gemini']);
const FOLLOW_UP_STATE_KEYS = ['pending', 'inProgress', 'completed', 'failed', 'stopped'];
// Reviewer model → the quota harnesses that can serve it, corporate account first.
const QUOTA_HARNESSES_BY_REVIEWER = Object.freeze({
  claude: ['remediator-claude-corp', 'claude-code'],
  codex: ['remediator-codex-corp', 'codex'],
});

const ranOnGemini = (worker) => Boolean(worker?.spawnedAt)
  && [worker.workerClass, worker.model].some((value) => GEMINI_REMEDIATOR_CLASSES.has(String(value || '').trim().toLowerCase()));

export function jobHasGeminiRemediation(job) {
  const rounds = Array.isArray(job?.remediationPlan?.rounds) ? job.remediationPlan.rounds : [];
  return ranOnGemini(job?.remediationWorker) || rounds.some((round) => ranOnGemini(round?.worker));
}

/**
 * Reviewer models excluded from reviewing this PR's next head. Fail-open to no
 * exclusion is wrong here (it would let Gemini review its own head), so an
 * unreadable job store is reported as the exclusion being applied.
 */
export function geminiRemediatedReviewerExclusions({
  rootDir, repo, prNumber, listJobsImpl = listFollowUpJobsInDir, log = console,
} = {}) {
  try {
    for (const key of FOLLOW_UP_STATE_KEYS) {
      if (listJobsImpl(rootDir, key, { repo, prNumber }).some((entry) => jobHasGeminiRemediation(entry?.job))) {
        return ['gemini'];
      }
    }
    return [];
  } catch (error) {
    log.warn?.(`[watcher] gemini-remediated-head check failed for ${repo}#${prNumber}: ${error?.message || error}; `
      + 'excluding gemini from this review');
    return ['gemini'];
  }
}

/**
 * Remediator-side preflight. Gemini may take a remediation only when another
 * reviewer model can review the head it produces: not Gemini, not the builder's
 * own family (`reviewerRefusesBuilder`), and not capped. `capOf(harness)` is the
 * caller's cap state (fleet quota status plus the job's own quota evidence), so
 * the alternate is judged by the same evidence the remediator candidates are.
 * An unreadable status leaves the alternate unverified, which keeps Gemini
 * selectable the same way an unverified remediator candidate is.
 *
 * @returns {{ available: boolean, reviewerModel: string|null, reason: string|null,
 *   considered: Array<{ reviewerModel: string, selected: boolean, reason: string }> }}
 */
export function alternateReviewerForGeminiRemediation({ builderClass, capOf } = {}) {
  const normalizedBuilder = normalizeBuilderClass(builderClass);
  const considered = [];
  if (!normalizedBuilder) {
    return { available: false, reviewerModel: null, reason: 'unknown-builder-class', considered };
  }
  for (const [reviewerModel, harnesses] of Object.entries(QUOTA_HARNESSES_BY_REVIEWER)) {
    if (reviewerRefusesBuilder(normalizedBuilder, reviewerModel)) {
      considered.push({ reviewerModel, selected: false, reason: 'builder-family' });
      continue;
    }
    // Usable: not capped, not about to reset, and positively available when the
    // status is readable (`available` is null for an unreadable one). A corporate
    // account needs positive evidence, as a corporate remediator candidate does.
    const caps = harnesses.map((harness) => ({ harness, ...(capOf?.(harness) || { available: null }) }));
    const usable = caps.find((cap) => !cap.capped && !cap.resetsWithinHoldWindow
      && (cap.harness.endsWith('-corp') ? cap.available === true : cap.available !== false));
    if (usable) {
      considered.push({ reviewerModel, selected: true, reason: usable.available === true ? 'available' : 'unverified' });
      return { available: true, reviewerModel, reason: null, considered };
    }
    const blocked = caps.find((cap) => cap.capped) || caps[caps.length - 1];
    considered.push({ reviewerModel, selected: false,
      reason: blocked.capped ? `capped:${blocked.capSource}` : `unavailable:${blocked.state || 'unknown'}` });
  }
  return {
    available: false, reviewerModel: null, considered,
    reason: `no-alternate-reviewer:${considered.map((entry) => `${entry.reviewerModel}=${entry.reason}`).join(',') || 'none'}`,
  };
}
