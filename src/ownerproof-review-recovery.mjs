import { recoverOrphan, overdueNextAction } from './ama/orphan-watchdog.mjs';
import { readNoProgressLane } from './watcher-no-progress-lane.mjs';
import { deriveNextActionSnapshot, nextAction } from './pr-next-action.mjs';
const fetchMergeAgentCandidate = async (...args) => (await import('./merge-agent-candidate.mjs')).fetchMergeAgentCandidate(...args);
import { normalizeEffectiveReviewVerdict } from './review-verdict.mjs';
import { amaAuthoritativeReviewerLoginsForModel } from './ama/reviewer-authority.mjs';
const fetchReviews = async (...args) => (await import('./github-api.mjs')).fetchReviewBodiesForHead(...args);
const maybeDispatchAmaClosureFor = async (...args) => (await import('./ama-closure-orchestration.mjs')).maybeDispatchAmaClosureFor(...args);

// Every discovered open PR visits this local check before admission/backoff.
// Only actual recovery enters the normal executor and its fresh candidate read.
export async function recoverOverdueOwnership({ rootDir, repo, prNumber, subject, reviewStateRow,
  domainId, enabled, now = new Date().toISOString(), env = process.env, logger = console, execFileImpl,
  readLaneImpl = readNoProgressLane, recoverImpl = recoverOrphan,
  fetchCandidateImpl = fetchMergeAgentCandidate, dispatchImpl = maybeDispatchAmaClosureFor }) {
  if (!enabled || subject?.terminal || subject?.isDraft || subject?.draft || !subject?.headSha) return null;
  const lane = readLaneImpl(rootDir, { repo, prNumber }, { logger });
  // Pre-contract lane records may have no selected action. Missing evidence
  // selects the shared refresh row, anchored to durable lack of progress.
  const selected = lane?.headSha === subject.headSha ? lane.nextAction || nextAction(deriveNextActionSnapshot({
    subjectKey: `${repo}#${prNumber}`, head: subject.headSha, observedAt: now,
    anchors: { firstActionableAt: lane.firstNoProgressAt || lane.lastRunAt },
    observations: { pr: { state: 'OPEN', headSha: subject.headSha, labels: subject.labels } },
  })) : null;
  if (!overdueNextAction(selected, subject.headSha, now, env)) return null;
  const labels = (subject.labels || []).map(label => typeof label === 'string' ? label : label.name);
  return recoverImpl({ rootDir, repo, prNumber, headSha: subject.headSha, reviewStateRow, labels, now, env, logger,
    candidate: { prState: 'open', headSha: subject.headSha },
    result: { amaEnabled: true, nextAction: selected, reason: 'next-action-deadline-expired' },
    dispatchHammer: async orphanRecovery => {
      const candidate = await fetchCandidateImpl(repo, prNumber, { rootDir, execFileImpl });
      if (candidate?.headSha !== subject.headSha || candidate.merged || String(candidate.prState).toLowerCase() !== 'open') {
        return { dispatched: false, reason: 'recovery-head-no-longer-open' };
      }
      return dispatchImpl({ rootDir, repoPath: repo, prNumber, candidate, labelNames: candidate.labels,
        currentRevisionRef: candidate.headSha, reviewStateRow, domainId, orphanRecovery, logger });
    },
  });
}

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
