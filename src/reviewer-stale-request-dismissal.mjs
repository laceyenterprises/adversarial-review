import {
  amaAllAuthoritativeReviewerLogins,
  amaAuthoritativeReviewerLoginsForModel,
} from './ama/reviewer-authority.mjs';
import { dismissStandingChangesRequestedReviewsForHead } from './github-api.mjs';
import { isDismissStaleRequestChangesOnResolvedEnabled } from './merge-agent-dispatch-decision.mjs';

function normalizeReviewerLogin(login) {
  return String(login || '').trim().toLowerCase().replace(/\[bot\]$/u, '');
}

function dismissalReviewIds(reviews) {
  return (Array.isArray(reviews) ? reviews : [])
    .map((review) => review?.id)
    .filter(Boolean);
}

function dismissalAttemptCount(resultOrError) {
  const attempted = Number(resultOrError?.attempted);
  if (Number.isFinite(attempted) && attempted >= 0) return attempted;
  if (Array.isArray(resultOrError?.standing)) return resultOrError.standing.length;
  return 0;
}

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
  let dismissalPhase = 'primary';
  let dismissal = null;
  try {
    dismissal = await dismissStandingChangesRequestedReviewsForHead(
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
    dismissalPhase = 'cross-family';
    const primaryReviewerLogins = new Set(
      authoritativeReviewerLogins.map((login) => normalizeReviewerLogin(login)),
    );
    const supersededCrossFamilyReviewerLogins = amaAllAuthoritativeReviewerLogins()
      .filter((login) => !primaryReviewerLogins.has(normalizeReviewerLogin(login)));
    const supersededCrossFamilyDismissal = supersededCrossFamilyReviewerLogins.length > 0
      ? await dismissStandingChangesRequestedReviewsForHead(
        execFileImpl,
        repo,
        prNumber,
        headSha,
        {
          authoritativeReviewerLogins: supersededCrossFamilyReviewerLogins,
          requireSupersededCommitId: headSha,
          message: (review) => (
            `Reviewer posted a clean comment-only re-review on ${headSha}; ` +
            `dismissing superseded stale Request changes from ${review?.commitId || review?.commit_id || 'an older head'}.`
          ),
          env: {
            ...env,
            GH_TOKEN: token,
            ...(botTokenEnv ? { [botTokenEnv]: token } : {}),
          },
        },
      )
      : { attempted: 0, dismissed: [] };
    log?.log?.(JSON.stringify({
      schemaVersion: 1,
      event: 'reviewer.stale_request_changes.dismissal',
      repo,
      pr: prNumber,
      headSha,
      reviewerModel: reviewerModel || null,
      attempted: dismissalAttemptCount(dismissal)
        + dismissalAttemptCount(supersededCrossFamilyDismissal),
      dismissed: [
        ...dismissalReviewIds(dismissal?.dismissed),
        ...dismissalReviewIds(supersededCrossFamilyDismissal?.dismissed),
      ],
      crossFamilyAttempted: dismissalAttemptCount(supersededCrossFamilyDismissal),
      crossFamilyDismissed: dismissalReviewIds(supersededCrossFamilyDismissal?.dismissed),
      ok: true,
    }));
    return { ok: true, dismissal, supersededCrossFamilyDismissal };
  } catch (err) {
    const primaryAttempted = dismissalPhase === 'primary'
      ? dismissalAttemptCount(err)
      : dismissalAttemptCount(dismissal);
    const primaryDismissed = dismissalPhase === 'primary'
      ? dismissalReviewIds(err?.dismissed)
      : dismissalReviewIds(dismissal?.dismissed);
    const crossFamilyAttempted = dismissalPhase === 'cross-family'
      ? dismissalAttemptCount(err)
      : 0;
    const crossFamilyDismissed = dismissalPhase === 'cross-family'
      ? dismissalReviewIds(err?.dismissed)
      : [];
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
      dismissalPhase,
      attempted: primaryAttempted + crossFamilyAttempted,
      dismissed: [
        ...primaryDismissed,
        ...crossFamilyDismissed,
      ],
      crossFamilyAttempted,
      crossFamilyDismissed,
      error: String(err?.message || err),
      reviewId: err?.review?.id || null,
      failOpenForReviewPost: true,
    }));
    return { ok: false, error: err };
  }
}
