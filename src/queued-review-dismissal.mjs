import { amaAllAuthoritativeReviewerLogins } from './ama/reviewer-authority.mjs';
import {
  dismissStandingChangesRequestedReviewsForHead, fetchPullRequestHeadAndState,
} from './github-api.mjs';

// This changes GitHub's standing review display, never the local verdict or
// merge authority. Missing/current judged commits are retained by SVD-02.
export async function dismissSupersededReviewsForQueuedRereview(db, {
  repo, prNumber, headSha, terminal = false, execFileImpl, env = process.env,
  logger = console, dismissImpl = dismissStandingChangesRequestedReviewsForHead,
  fetchHeadImpl = fetchPullRequestHeadAndState, onLiveHead = async () => {},
}) {
  if (terminal || !headSha) return { skipped: 'no-open-head' };
  const activeIntent = currentHead => db.prepare(`SELECT intent.* FROM explicit_review_intents AS intent
    WHERE intent.repo = ? AND intent.pr_number = ? AND (? IS NULL OR intent.head_sha = ?)
      AND (intent.state = 'pending' OR (intent.state = 'consumed' AND EXISTS (
        SELECT 1 FROM reviewed_prs AS review WHERE review.repo = intent.repo
          AND review.pr_number = intent.pr_number AND review.review_status = 'reviewing'
          AND review.reviewer_head_sha = intent.head_sha
          AND review.reviewer_session_uuid = intent.reviewer_session_uuid)))
    ORDER BY intent.requested_at DESC LIMIT 1`).get(repo, prNumber, currentHead, currentHead);
  if (!activeIntent(null)) return { skipped: 'no-queued-rereview' };
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
    return await dismissImpl(execFileImpl, repo, prNumber, currentHead, {
      authoritativeReviewerLogins: amaAllAuthoritativeReviewerLogins(),
      requireSupersededCommitId: currentHead,
      message: review => `Request changes judged commit ${review.commitId || review.commit_id}; `
        + `current head is ${currentHead}. Re-review requested at ${intent.requested_at} `
        + 'is queued or running for the current head; dismissing the superseded review.',
      env,
    });
  } catch (error) {
    logger.warn?.(`[watcher] queued re-review dismissal deferred for ${repo}#${prNumber}: ${error.message}`);
    return { deferred: true };
  }
}
