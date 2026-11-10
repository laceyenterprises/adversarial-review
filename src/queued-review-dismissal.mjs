import { amaAllAuthoritativeReviewerLogins } from './ama/reviewer-authority.mjs';
import {
  dismissStandingChangesRequestedReviewsForHead, fetchPullRequestHeadAndState,
} from './github-api.mjs';

const observationsByDb = new WeakMap();
const LIVE_REFRESH_MS = 5 * 60_000;
const MAX_OBSERVATIONS = 512;

// This changes GitHub's standing review display, never the local verdict or
// merge authority. Missing/current judged commits are retained by SVD-02.
export async function dismissSupersededReviewsForQueuedRereview(db, {
  repo, prNumber, headSha, terminal = false, execFileImpl, env = process.env,
  logger = console, dismissImpl = dismissStandingChangesRequestedReviewsForHead,
  fetchHeadImpl = fetchPullRequestHeadAndState, onLiveHead = async () => {},
  nowMs = Date.now(),
}) {
  let observations = observationsByDb.get(db);
  if (!observations) observationsByDb.set(db, observations = new Map());
  const key = JSON.stringify([repo, prNumber]);
  if (terminal || !headSha) {
    observations.delete(key);
    return { skipped: 'no-open-head' };
  }
  const activeIntent = currentHead => db.prepare(`SELECT intent.* FROM explicit_review_intents AS intent
    WHERE intent.repo = ? AND intent.pr_number = ? AND (? IS NULL OR intent.head_sha = ?)
      AND (intent.state = 'pending' OR (intent.state = 'consumed' AND EXISTS (
        SELECT 1 FROM reviewed_prs AS review WHERE review.repo = intent.repo
          AND review.pr_number = intent.pr_number AND review.review_status = 'reviewing'
          AND review.reviewer_head_sha = intent.head_sha
          AND review.reviewer_session_uuid = intent.reviewer_session_uuid)))
    ORDER BY intent.requested_at DESC LIMIT 1`).get(repo, prNumber, currentHead, currentHead);
  const queued = activeIntent(null);
  if (!queued) {
    observations.delete(key);
    return { skipped: 'no-queued-rereview' };
  }
  let observation = observations.get(key);
  if (observation?.requestId !== queued.request_id || observation?.intentHead !== queued.head_sha
    || observation?.discoveryHead !== headSha) {
    observation = { requestId: queued.request_id, intentHead: queued.head_sha,
      discoveryHead: headSha, nextRefreshAt: 0, dismissed: false };
  }
  if (nowMs < observation.nextRefreshAt) return { skipped: 'refresh-not-due' };
  // Bound failures too. Successful dismissal is remembered for this request;
  // periodic live reads still settle moved/closed PRs during admission holds.
  observation.nextRefreshAt = nowMs + LIVE_REFRESH_MS;
  observations.delete(key);
  observations.set(key, observation);
  if (observations.size > MAX_OBSERVATIONS) observations.delete(observations.keys().next().value);
  try {
    // Discovery may predate the request or a concurrent push. Never use that
    // cached SHA to decide which GitHub findings are superseded.
    const fresh = await fetchHeadImpl(repo, prNumber, { execFileImpl, env, withLabels: false });
    if (!fresh?.headRefOid || !fresh?.state) return { skipped: 'live-head-unavailable' };
    await onLiveHead(fresh);
    if (fresh.state !== 'open' || fresh.mergedAt) return { skipped: 'pr-terminal' };
    const currentHead = fresh.headRefOid;
    const intent = activeIntent(currentHead);
    if (!intent) return { skipped: 'no-queued-rereview' };
    if (observation.dismissed && intent.request_id === observation.requestId) {
      return { skipped: 'already-checked' };
    }
    const result = await dismissImpl(execFileImpl, repo, prNumber, currentHead, {
      authoritativeReviewerLogins: amaAllAuthoritativeReviewerLogins(),
      requireSupersededCommitId: currentHead,
      message: review => `Request changes judged commit ${review.commitId || review.commit_id}; `
        + `current head is ${currentHead}. Re-review requested at ${intent.requested_at} `
        + 'is queued or running for the current head; dismissing the superseded review.',
      env,
    });
    if (intent.request_id === observation.requestId) observation.dismissed = true;
    return result;
  } catch (error) {
    logger.warn?.(`[watcher] queued re-review dismissal deferred for ${repo}#${prNumber}: ${error.message}`);
    return { deferred: true };
  }
}
