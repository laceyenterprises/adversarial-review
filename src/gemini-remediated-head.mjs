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
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { FOLLOW_UP_JOB_DIRS, readFollowUpJob } from './follow-up-jobs.mjs';
import { followUpJobFileFilter } from './follow-up-job-names.mjs';
import {
  GEMINI_REMEDIATED_HEAD_REASON,
  ROUTE_BY_BUILDER_CLASS,
  normalizeBuilderClass,
  normalizeReviewerModel,
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

// The router asks this for every PR on every poll tick, and `completed/` holds
// the whole job history, so the default lister must not re-read the state
// directories each time. It caches each directory's entry names keyed by the
// directory's identity and mtime (adding, removing or renaming an entry moves
// the mtime) and reads only this PR's job files. A listing taken within
// RACY_LISTING_WINDOW_NS of the mtime is used but not cached: a write landing
// in the same mtime granule would not move it again.
const RACY_LISTING_WINDOW_NS = 2_000_000_000n;

export function createCachedFollowUpJobLister({
  statImpl = statSync,
  readdirImpl = readdirSync,
  readJobImpl = readFollowUpJob,
  nowNsImpl = () => BigInt(Date.now()) * 1_000_000n,
} = {}) {
  const listings = new Map();
  const entryNames = (dir) => {
    let stat;
    try {
      stat = statImpl(dir, { bigint: true });
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      listings.delete(dir);
      return [];
    }
    const key = `${stat.dev}:${stat.ino}:${stat.mtimeNs}`;
    const cached = listings.get(dir);
    if (cached?.key === key) return cached.names;
    const names = readdirImpl(dir);
    if (nowNsImpl() - stat.mtimeNs > RACY_LISTING_WINDOW_NS) listings.set(dir, { key, names });
    else listings.delete(dir);
    return names;
  };
  return function listFollowUpJobs(rootDir, stateKey, { repo, prNumber } = {}) {
    const parts = FOLLOW_UP_JOB_DIRS[stateKey];
    if (!parts) throw new Error(`Unknown follow-up job directory key: ${stateKey}`);
    const dir = join(rootDir, ...[].concat(parts));
    const matches = followUpJobFileFilter({ rootDir, repo, prNumber });
    const jobs = [];
    for (const name of entryNames(dir).filter(matches).sort()) {
      const jobPath = join(dir, name);
      try {
        jobs.push({ job: readJobImpl(jobPath), jobPath });
      } catch (error) {
        // A job moved between state directories after the listing; the
        // directory it moved into is read in the same pass.
        if (error?.code !== 'ENOENT') throw error;
      }
    }
    return jobs;
  };
}

const listFollowUpJobsCached = createCachedFollowUpJobLister();

/**
 * Reviewer models excluded from reviewing this PR's next head. Fail-open to no
 * exclusion is wrong here (it would let Gemini review its own head), so an
 * unreadable job store is reported as the exclusion being applied.
 */
export function geminiRemediatedReviewerExclusions({
  rootDir, repo, prNumber, listJobsImpl = listFollowUpJobsCached, log = console,
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
 * Remediator-side preflight. Gemini may take a remediation only when the
 * reviewer the router would pick for the head it produces (the builder's route
 * with Gemini excluded) can review it: not Gemini, not the builder's own family
 * (`reviewerRefusesBuilder`), and not capped. The caller passes that reviewer as
 * `reviewerModel` (the domain-resolved route); without one the default route
 * table's reviewer for the builder is used. `capOf(harness)` is the caller's cap
 * state (fleet quota status plus the job's own quota evidence), so the reviewer
 * is judged by the same evidence the remediator candidates are. An unreadable
 * status leaves it unverified, which keeps Gemini selectable the same way an
 * unverified remediator candidate is.
 *
 * @returns {{ available: boolean, reviewerModel: string|null, reason: string|null,
 *   considered: Array<{ reviewerModel: string, selected: boolean, reason: string }> }}
 */
export function alternateReviewerForGeminiRemediation({
  builderClass, capOf, routeTable = ROUTE_BY_BUILDER_CLASS, reviewerModel: routedReviewer,
} = {}) {
  const normalizedBuilder = normalizeBuilderClass(builderClass, routeTable);
  const considered = [];
  if (!normalizedBuilder) {
    return { available: false, reviewerModel: null, reason: 'unknown-builder-class', considered };
  }
  const reviewerModel = normalizeReviewerModel(routedReviewer === undefined
    ? routeTable?.[normalizedBuilder]?.reviewerModel
    : routedReviewer);
  const refuse = (reason) => {
    if (reviewerModel) considered.push({ reviewerModel, selected: false, reason });
    return { available: false, reviewerModel: null, considered,
      reason: `no-alternate-reviewer:${reviewerModel ? `${reviewerModel}=${reason}` : reason}` };
  };
  if (!reviewerModel) return refuse('no-routed-reviewer');
  if (reviewerModel === 'gemini') return refuse('routed-to-gemini');
  if (reviewerRefusesBuilder(normalizedBuilder, reviewerModel)) return refuse('builder-family');
  const harnesses = QUOTA_HARNESSES_BY_REVIEWER[reviewerModel];
  if (!harnesses) return refuse('no-quota-harness');
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
  return refuse(blocked.capped ? `capped:${blocked.capSource}` : `unavailable:${blocked.state || 'unknown'}`);
}
