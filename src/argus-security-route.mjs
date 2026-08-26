// ASR-04 — route instead of terminating.
//
// `adversarial-review#909` and `#910` sat 14 hours unreviewed. Nothing failed;
// nothing could route them. The lane resolves a reviewer from the worker-class
// prefix in the PR title, a bot cannot produce one, so the disposition was a
// TERMINAL `unroutable-bot-author` row: no reviewer, no retry, no escalation.
// The PR was not rejected. It was dropped. `#909` was a major bump of the native
// driver behind `reviews.db` — the database the review pipeline runs on.
//
// This module is the new disposition. It joins the two halves ASR-02 and ASR-03
// built — the pure classifier and the durable queue — into the one decision the
// watcher makes per PR head:
//
//   classify (author + changed files) → enqueue if any trigger fired
//
// Three properties are load-bearing and each is enforced here rather than at the
// call site, because there are two call sites and they must not drift:
//
//   NEVER TERMINAL.   A failure anywhere in this path — the changed-file fetch,
//                     the queue write, a malformed head SHA — returns an outcome
//                     the caller retries on the next tick. Nothing in here can
//                     write a terminal row, so no code path through it can
//                     reproduce the drop it exists to fix.
//
//   HEAD-SCOPED.      The job identity is (repo, prNumber, headSha), so a
//                     re-poll on the same head is a no-op and a NEW head
//                     enqueues again. `lastClassifiedHeadSha` is the caller's
//                     memo of the last head this ran to completion for; it
//                     exists so a steady-state tick costs zero GitHub calls, not
//                     to weaken the re-enqueue.
//
//   ADDITIVE.         Returning a result never diverts a review. A routable PR
//                     that touches a manifest gets an Argus job AND its normal
//                     adversarial review — the caller ignores the return value.
//
// Severity is not decided here and must not be: ASR-02 returns triggers, this
// module routes them, ASR-05 judges them, ASR-06 gates on the judgment.

import {
  enqueueArgusSecurityReview as defaultEnqueue,
  findArgusJob as defaultFindArgusJob,
} from './argus-security-queue.mjs';
import { classifySecuritySurface } from './security-surface-classifier.mjs';

// The status a routed PR carries while Argus owns it. NOT terminal: the dispatch
// loop keeps visiting the row so a new head re-enqueues, and the gate reports
// `pending` (never `success`) so an unanswered security question is not an
// approval.
export const ARGUS_SECURITY_QUEUED_STATUS = 'argus-security-queued';

// The status this ticket retires. It is still read — by rows written before this
// deployed, by rows a reopened PR carries back into the open set, and by the
// kill switch below — but it is no longer the normal disposition for a bot PR.
// `recoverLegacyUnroutableBotRow` is what turns one back into live work.
export const LEGACY_UNROUTABLE_BOT_STATUS = 'unroutable-bot-author';

// The reviewer field a routed row carries, so `reviewer` keeps answering "who
// owns this PR" for an operator reading the table directly.
export const ARGUS_SECURITY_REVIEWER = 'argus-security';

/**
 * The single rollback lever, default ON.
 *
 * Disabling it restores the pre-ASR-04 behaviour exactly — bot PRs go back to
 * terminal `unroutable-bot-author` — which is the whole point of a lever: the
 * fallback is a state the fleet has already run for months, not an untested
 * third path. The terminal write logs `ARGUS_ROUTE_DISABLED` every time it
 * fires, so a lever left flipped cannot quietly become the 14-hour drop again.
 */
export function isArgusSecurityRouteEnabled(env = process.env) {
  return !/^(0|false|no|off)$/i.test(String(env?.ADVERSARIAL_ARGUS_SECURITY_ROUTE ?? '').trim());
}

const FULL_HEAD_SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu;

function normalizeHead(headSha) {
  const normalized = String(headSha ?? '').trim().toLowerCase();
  return FULL_HEAD_SHA_PATTERN.test(normalized) ? normalized : '';
}

/**
 * A one-line summary of why Argus was called, for the row's operator-visible
 * note and the watcher log. Triggers only — no severity, no verdict.
 */
export function summarizeSecurityReasons(reasons) {
  if (!Array.isArray(reasons) || reasons.length === 0) return 'no trigger';
  return reasons.map((reason) => reason?.trigger || 'unknown').join(', ');
}

/**
 * Classify one PR head and enqueue an Argus security review if any trigger
 * fired.
 *
 * @param {object}   opts
 * @param {string}   opts.rootDir              repo root that owns `data/`.
 * @param {string}   opts.repoPath             `owner/repo`.
 * @param {number}   opts.prNumber
 * @param {string}   opts.headSha              full 40/64-hex head SHA.
 * @param {string}   [opts.authorRef]          PR author login.
 * @param {string}   [opts.lastClassifiedHeadSha]  head this last completed for.
 * @param {Function} [opts.fetchChangedFiles]  async () => Array|null. `null`
 *   means the fetch failed, which is NOT the same as "no files changed" and is
 *   never treated as one.
 * @returns {Promise<{outcome: string, queued: boolean, reasons: Array,
 *   classificationComplete: boolean, recordClassifiedHead: boolean,
 *   bucket: string|null, jobPath: string|null, error: Error|null,
 *   summary: string}>}
 *   `queued` is the only field a caller may key a row write on: it means a job
 *   for THIS head is in the queue right now (freshly created or already there).
 */
export async function routeSecuritySurfaceToArgus({
  rootDir,
  repoPath,
  prNumber,
  headSha,
  authorRef = null,
  lastClassifiedHeadSha = null,
  fetchChangedFiles = null,
  enqueuedAt = null,
  source = 'watcher-pollonce',
  enqueue = defaultEnqueue,
  findJob = defaultFindArgusJob,
  logger = console,
} = {}) {
  const result = {
    outcome: 'skipped',
    queued: false,
    reasons: [],
    classificationComplete: false,
    recordClassifiedHead: false,
    bucket: null,
    jobPath: null,
    error: null,
    summary: 'no trigger',
    headSha: null,
  };

  const head = normalizeHead(headSha);
  if (!head) {
    // No usable head means no job identity, and a job identity guessed from an
    // abbreviated or missing SHA would bind a review to a tree nobody read.
    // Refuse, stay non-terminal, and retry on the next tick when the subject
    // adapter has a head. Loud, because a PR that never grows one would
    // otherwise be an invisible hole in the route.
    result.outcome = 'no-head';
    logger.warn?.(
      `[argus-route] ${repoPath}#${prNumber} has no full head SHA yet ` +
        `(got ${JSON.stringify(headSha)}); deferring the security-surface classification to a later tick`
    );
    return result;
  }
  result.headSha = head;

  if (lastClassifiedHeadSha && normalizeHead(lastClassifiedHeadSha) === head) {
    // Steady state. The head has already been classified to completion, and the
    // queue is idempotent per head, so there is nothing left to do and no
    // GitHub call worth spending. A NEW head does not reach this branch.
    //
    // `queued` is still answered from the queue itself rather than assumed from
    // the memo. Four `existsSync` calls against a deterministic filename is a
    // rounding error next to the API call this branch skips, and it means the
    // caller's row write is keyed on the job that is actually on disk — never on
    // a cache that could disagree with it.
    result.outcome = 'already-classified';
    try {
      const existing = findJob(rootDir, { repo: repoPath, prNumber, headSha: head });
      if (existing) {
        result.queued = true;
        result.bucket = existing.bucket;
        result.jobPath = existing.jobPath;
        result.reasons = Array.isArray(existing.job?.reasons) ? existing.job.reasons : [];
        result.summary = summarizeSecurityReasons(result.reasons);
      }
    } catch (err) {
      logger.warn?.(
        `[argus-route] queue lookup failed for ${repoPath}#${prNumber}@${head.slice(0, 12)}: ${err?.message || err}`
      );
    }
    return result;
  }

  // A `null` fetch is a FAILURE, an empty array is a genuinely empty diff. The
  // difference decides whether the classification may be memoized below, so the
  // two are kept apart all the way down rather than collapsed to `[]`.
  let changedFiles = null;
  let fetchFailed = false;
  if (typeof fetchChangedFiles === 'function') {
    try {
      changedFiles = await fetchChangedFiles();
    } catch (err) {
      changedFiles = null;
      logger.warn?.(
        `[argus-route] changed-file fetch threw for ${repoPath}#${prNumber}: ${err?.message || err}`
      );
    }
    fetchFailed = !Array.isArray(changedFiles);
    if (fetchFailed) {
      logger.warn?.(
        `[argus-route] changed-file list unavailable for ${repoPath}#${prNumber}@${head.slice(0, 12)}; ` +
          'classifying on the author trigger alone and re-classifying next tick'
      );
    }
  }

  const classification = classifySecuritySurface({
    author: authorRef,
    changedFiles: Array.isArray(changedFiles) ? changedFiles : [],
  });
  result.reasons = classification.reasons;
  result.summary = summarizeSecurityReasons(classification.reasons);
  // Complete means every input the classifier reads was available. With a failed
  // fetch, the author trigger still answers but the path triggers cannot, so the
  // negative result is not evidence and must not be memoized.
  result.classificationComplete = !fetchFailed;

  if (!classification.needsReview) {
    result.outcome = fetchFailed ? 'classification-incomplete' : 'no-trigger';
    // Memoize only a complete negative. An incomplete one re-runs next tick,
    // which is the fail-open direction: retrying a fetch costs an API call,
    // caching a false negative costs the review.
    result.recordClassifiedHead = !fetchFailed;
    return result;
  }

  const identity = { repo: repoPath, prNumber, headSha: head };
  try {
    const enqueued = enqueue({
      rootDir,
      repo: repoPath,
      prNumber,
      headSha: head,
      reasons: classification.reasons,
      enqueuedAt: enqueuedAt || new Date().toISOString(),
      source,
    });
    result.outcome = enqueued?.outcome === 'created' ? 'enqueued' : 'duplicate';
    result.queued = true;
    result.bucket = enqueued?.bucket || null;
    result.jobPath = enqueued?.jobPath || null;
    // A queued job is the durable record. Memoize on it even when the fetch
    // failed: the PR is IN the queue, and re-fetching every tick to enrich a
    // reason list the reviewer will rebuild from the diff anyway buys nothing.
    result.recordClassifiedHead = true;
    if (result.outcome === 'enqueued') {
      logger.log?.(
        `[argus-route] ${repoPath}#${prNumber}@${head.slice(0, 12)} → argus security queue ` +
          `(${result.summary})`
      );
    }
    return result;
  } catch (err) {
    result.outcome = 'error';
    result.error = err;
    // Never terminal. The row keeps whatever non-terminal status it has and the
    // next tick retries the enqueue; a queue that cannot be written is an
    // operator problem, not a reason to drop the PR.
    logger.error?.(
      `[argus-route] enqueue failed for ${repoPath}#${prNumber}@${head.slice(0, 12)} ` +
        `(${result.summary}): ${err?.message || err}; leaving the row non-terminal for retry`
    );
    // Best effort: if a job for this head already exists, the enqueue failure was
    // incidental and the PR is covered.
    try {
      const existing = findJob(rootDir, identity);
      if (existing) {
        result.queued = true;
        result.bucket = existing.bucket;
        result.jobPath = existing.jobPath;
      }
    } catch {}
    return result;
  }
}
