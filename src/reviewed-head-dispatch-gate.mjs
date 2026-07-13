// REVIEW-DEDUP — reviewed-head dispatch dedup gate.
//
// Root cause (live evidence 2026-07-13): agent-os PR #3655 received FOUR full
// adversarial reviews from the same reviewer against the SAME commit at the
// watcher poll cadence. The watcher's dedup relied solely on the SQLite
// `reviewed_prs.reviewer_head_sha` memo; when that memo failed to settle (a
// review posted to GitHub but the row never reached `posted` — e.g. an
// attestation-emit failure classified the pass as failed and re-armed it), the
// watcher re-dispatched a reviewer for a head GitHub had already reviewed.
//
// The authoritative signal is GitHub's per-review `commit_id`: a head is
// ALREADY-REVIEWED iff a completed review from a trusted reviewer login exists
// whose `commit_id` equals the current head SHA. This module turns that signal
// into a hard gate that runs BEFORE any reviewer is claimed/spawned, composing
// WITH (never replaced by) attestation consumption. It also provides an
// in-process (pr, head_sha) lease so concurrent reviewer-pool workers cannot
// double-dispatch the same head inside one poll window.

/**
 * Stable idempotency key for a single (repo, pr, head) dispatch. Two pool
 * workers racing on the same head in one window produce the same key, so the
 * lease below admits exactly one.
 */
export function headDispatchLeaseKey({ repoPath, prNumber, headSha } = {}) {
  const repo = String(repoPath || '').trim();
  const pr = String(prNumber ?? '').trim();
  const head = String(headSha || '').trim();
  return `${repo}#${pr}@${head}`;
}

/**
 * In-process lease keyed by (repo, pr, head). `tryAcquire` returns false when
 * the key is already held so the caller skips rather than double-dispatches.
 * A key with no head SHA is never leased (returns true, `has` false) because a
 * missing head can't be deduped and must fall through to existing behavior.
 */
export function createHeadDispatchLease() {
  const held = new Set();
  const isLeasable = (key) => {
    const value = String(key || '');
    // Refuse to lease a key whose head component is empty (`...@`).
    return value.length > 0 && !value.endsWith('@');
  };
  return {
    tryAcquire(key) {
      if (!isLeasable(key)) return true;
      if (held.has(key)) return false;
      held.add(key);
      return true;
    },
    release(key) {
      if (!isLeasable(key)) return;
      held.delete(key);
    },
    has(key) {
      return held.has(key);
    },
    get size() {
      return held.size;
    },
  };
}

/**
 * The skip-audit line emitted when a review is NOT dispatched because the head
 * already has a completed review. Carries (pr, sha, existing review id) so the
 * duplicate suppression is observable in the watcher log.
 */
export function buildDuplicateReviewSkipAudit({
  repoPath,
  prNumber,
  headSha,
  reviewId,
} = {}) {
  const shortSha = String(headSha || '').slice(0, 12) || 'unknown';
  const id = reviewId == null || reviewId === '' ? 'unknown' : String(reviewId);
  return (
    `[watcher] reviewer dispatch SKIPPED as duplicate for ${repoPath}#${prNumber}: ` +
    `head ${shortSha} already has a completed review (commit_id match, review id=${id}); ` +
    `not re-dispatching and not consuming the re-review ceiling`
  );
}

/**
 * Authoritative reviewed-head predicate. Given already-fetched review
 * descriptors (each `{ id, commitId, state, ... }` pre-filtered to the head +
 * trusted logins by `fetchSubmittedReviewsForHead`), return the newest matching
 * review's id, or null when none matches. Pure so it is unit-testable without
 * the network.
 */
export function selectExistingReviewIdForHead(reviews) {
  if (!Array.isArray(reviews) || reviews.length === 0) return null;
  const withId = reviews.find((review) => review && review.id != null && review.id !== '');
  // A matching review with no id still proves the head is reviewed (the caller
  // treats a non-empty array as already-reviewed); we just can't name its id.
  return withId ? String(withId.id) : null;
}

/**
 * Resolve whether the current head already has a completed review from a
 * trusted reviewer login. Fails OPEN (allows dispatch) on any fetch error or a
 * missing head SHA — a transient GitHub blip must never permanently wedge
 * review dispatch; the SQLite memo and the other spawn gates still apply. When
 * `reviewerLogins` is a non-empty set the fetch is anti-spoof filtered; an
 * empty/unresolvable set fails closed inside the fetch (treated as "no proof",
 * so we allow dispatch rather than block on unknowable authorship).
 *
 * @returns {Promise<{alreadyReviewed: boolean, reviewId: string|null, reason: string|null}>}
 */
export async function resolveAlreadyReviewedHeadDedup({
  repoPath,
  prNumber,
  headSha,
  reviewerLogins = null,
  fetchReviewsForHeadImpl,
  logger = console,
} = {}) {
  const head = String(headSha || '').trim();
  if (!head) {
    return { alreadyReviewed: false, reviewId: null, reason: 'missing-head-sha' };
  }
  if (typeof fetchReviewsForHeadImpl !== 'function') {
    return { alreadyReviewed: false, reviewId: null, reason: 'no-fetch-impl' };
  }
  let reviews;
  try {
    reviews = await fetchReviewsForHeadImpl({
      repoPath,
      prNumber,
      headSha: head,
      reviewerLogins,
    });
  } catch (err) {
    logger?.warn?.(
      `[watcher] reviewed-head dedup probe failed for ${repoPath}#${prNumber}@${head.slice(0, 12)}; ` +
        `allowing dispatch (fail-open): ${err?.message || err}`
    );
    return { alreadyReviewed: false, reviewId: null, reason: 'probe-error' };
  }
  if (!Array.isArray(reviews) || reviews.length === 0) {
    return { alreadyReviewed: false, reviewId: null, reason: null };
  }
  return {
    alreadyReviewed: true,
    reviewId: selectExistingReviewIdForHead(reviews),
    reason: 'commit-id-match',
  };
}
