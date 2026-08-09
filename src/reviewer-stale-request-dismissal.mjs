import { amaAuthoritativeReviewerLoginsForModel } from './ama/reviewer-authority.mjs';
import { dismissStandingChangesRequestedReviewsForHead } from './github-api.mjs';
import { isDismissStaleRequestChangesOnResolvedEnabled } from './merge-agent-dispatch-decision.mjs';

export async function dismissStaleRequestChangesAfterCleanReview({
  repo,
  prNumber,
  headSha,
  reviewerModel,
  verdict,
  botTokenEnv,
  token,
  execFileImpl,
  env = process.env,
  log = console,
} = {}) {
  if (!headSha || verdict !== 'comment-only') return { skipped: 'not-clean-exact-head' };
  if (!isDismissStaleRequestChangesOnResolvedEnabled({ env, logger: log })) {
    return { skipped: 'disabled' };
  }
  const authoritativeReviewerLogins = amaAuthoritativeReviewerLoginsForModel(reviewerModel);
  if (authoritativeReviewerLogins.length === 0) {
    log?.warn?.(
      `[reviewer] stale Request changes dismissal skipped for ${repo}#${prNumber}` +
        `@${String(headSha).slice(0, 12)}: authoritative reviewer login set unresolved`,
    );
    return { skipped: 'authoritative-reviewer-logins-unresolved' };
  }
  try {
    const dismissal = await dismissStandingChangesRequestedReviewsForHead(
      execFileImpl,
      repo,
      prNumber,
      headSha,
      {
        authoritativeReviewerLogins,
        message:
          `Reviewer posted a clean comment-only re-review on ${headSha}; ` +
          `dismissing prior stale Request changes for this head.`,
        env: {
          ...env,
          GH_TOKEN: token,
          ...(botTokenEnv ? { [botTokenEnv]: token } : {}),
        },
      },
    );
    log?.log?.(JSON.stringify({
      schemaVersion: 1,
      event: 'reviewer.stale_request_changes.dismissal',
      repo,
      pr: prNumber,
      headSha,
      reviewerModel: reviewerModel || null,
      attempted: Number(dismissal?.attempted || 0),
      dismissed: Array.isArray(dismissal?.dismissed)
        ? dismissal.dismissed.map((review) => review.id).filter(Boolean)
        : [],
      ok: true,
    }));
    return { ok: true, dismissal };
  } catch (err) {
    log?.warn?.(
      `[reviewer] stale Request changes dismissal failed for ` +
        `${repo}#${prNumber}@${String(headSha).slice(0, 12)} after clean re-review; ` +
        `continuing: ${err?.message || err}`,
    );
    log?.log?.(JSON.stringify({
      schemaVersion: 1,
      event: 'reviewer.stale_request_changes.dismissal',
      repo,
      pr: prNumber,
      headSha,
      reviewerModel: reviewerModel || null,
      ok: false,
      error: String(err?.message || err),
      reviewId: err?.review?.id || null,
      failOpenForReviewPost: true,
    }));
    return { ok: false, error: err };
  }
}
