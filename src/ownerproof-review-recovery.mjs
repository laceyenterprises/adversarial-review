import { recoverOrphan } from './ama/orphan-watchdog.mjs';
const fetchMergeAgentCandidate = async (...args) => (await import('./merge-agent-candidate.mjs')).fetchMergeAgentCandidate(...args);
import { normalizeEffectiveReviewVerdict } from './review-verdict.mjs';
import { amaAuthoritativeReviewerLoginsForModel } from './ama/reviewer-authority.mjs';
const fetchReviews = async (...args) => (await import('./github-api.mjs')).fetchReviewBodiesForHead(...args);
const maybeDispatchAmaClosureFor = async (...args) => (await import('./ama-closure-orchestration.mjs')).maybeDispatchAmaClosureFor(...args);

// Posted rows already visit the closure watchdog. Visit the other routable
// review rows before their retry/backoff/cap returns can hide an ownerless PR.
export async function recoverOwnerlessReview({ rootDir, repo, prNumber, reviewStateRow,
  domainId, enabled, logger = console, execFileImpl,
  fetchCandidateImpl = fetchMergeAgentCandidate, fetchReviewsImpl = fetchReviews,
  recoverImpl = recoverOrphan, dispatchImpl = maybeDispatchAmaClosureFor }) {
  if (!enabled || !['pending', 'pending-upstream', 'failed', 'ci-blocked', 'reviewing'].includes(reviewStateRow?.review_status)) return null;
  const candidate = await fetchCandidateImpl(repo, prNumber, { rootDir, execFileImpl });
  if (!candidate?.headSha || candidate.merged || String(candidate.prState).toLowerCase() !== 'open') return null;
  const bodies = await fetchReviewsImpl(execFileImpl, repo, prNumber, candidate.headSha, {
    authoritativeReviewerLogins: amaAuthoritativeReviewerLoginsForModel(reviewStateRow.reviewer),
  });
  const verdict = bodies.map(normalizeEffectiveReviewVerdict).find(Boolean) || null;
  return recoverImpl({ rootDir, repo, prNumber, headSha: candidate.headSha,
    candidate, labels: candidate.labels, reviewStateRow, logger,
    result: { amaEnabled: true, reason: reviewStateRow.failure_message || reviewStateRow.review_status,
      ownerProofFacts: { headSha: candidate.headSha, reviewedHeadSha: verdict ? candidate.headSha : null,
        verdict, checks: candidate.statusCheckRollup,
        mergeable: candidate.mergeable } },
    dispatchHammer: orphanRecovery => dispatchImpl({ rootDir, repoPath: repo, prNumber,
      candidate, labelNames: candidate.labels, currentRevisionRef: candidate.headSha,
      reviewStateRow, domainId, orphanRecovery, logger }),
  });
}
