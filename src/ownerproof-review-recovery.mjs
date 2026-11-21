import { recoverOrphan, overdueNextAction, isOrphanRecoveryWait } from './ama/orphan-watchdog.mjs';
import { clearNoProgressLane, readNoProgressLane } from './watcher-no-progress-lane.mjs';
import { deriveNextActionSnapshot, nextAction } from './pr-next-action.mjs';
import { isOperatorHeld } from './operator-hold-labels.mjs';
const fetchMergeAgentCandidate = async (...args) => (await import('./merge-agent-candidate.mjs')).fetchMergeAgentCandidate(...args);
import { normalizeEffectiveReviewVerdict } from './review-verdict.mjs';
import { redactPublicSafeText } from './adapters/comms/github-pr-comments/redaction.mjs';
import { amaAuthoritativeReviewerLoginsForModel } from './ama/reviewer-authority.mjs';
const fetchReviews = async (...args) => (await import('./github-api.mjs')).fetchReviewBodiesForHead(...args);
const maybeDispatchAmaClosureFor = async (...args) => (await import('./ama-closure-orchestration.mjs')).maybeDispatchAmaClosureFor(...args);

// Keep the direct dispatch routes in step with canDispatch in the watchdog.
function recoveryRunsSelected(selected, headSha) {
  return selected?.head === headSha && selected.queue?.intent === 'dispatch' && !selected.queue.deferredBy
    && ((selected.action === 'review' && selected.actor === 'reviewer')
      || (selected.action === 'hammer' && selected.actor === 'hammer'));
}

// Outcomes recoverOrphan returns when it changed nothing but its own page and
// bookkeeping. A review request or a dispatch always names itself elsewhere.
const NO_EFFECT_OUTCOMES = new Set(['ama-pending', 'recovery-exhausted']);
const reasonCode = value => typeof value === 'string' && /^[a-z][a-z0-9-]{0,79}$/.test(value)
  ? value : 'redacted';
const discoveryHeld = labels => isOperatorHeld(labels || []) || (labels || []).some(
  label => (typeof label === 'string' ? label : label.name) === 'adversarial-merge-blocked');

// Every discovered open PR visits this local check before admission/backoff.
// Only actual recovery enters the normal executor and its fresh candidate read.
export async function recoverOverdueOwnership({ rootDir, repo, prNumber, subject, reviewStateRow,
  domainId, enabled, now = new Date().toISOString(), env = process.env, logger = console, execFileImpl,
  allowCloserReconciliation = true,
  readLaneImpl = readNoProgressLane, recoverImpl = recoverOrphan,
  fetchCandidateImpl = fetchMergeAgentCandidate, dispatchImpl = maybeDispatchAmaClosureFor }) {
  if (!enabled || subject?.terminal || subject?.isDraft || subject?.draft || !subject?.headSha
    || discoveryHeld(subject.labels)) return null;
  const identity = { repo, prNumber };
  const lane = readLaneImpl(rootDir, identity, { logger });
  if (lane?.headSha && lane.headSha !== subject.headSha) {
    if (clearNoProgressLane(rootDir, identity, { logger })) {
      logger?.log?.(`[watcher] review-head-superseded repo=${repo} pr=${prNumber} `
        + `previous_head=${lane.headSha} head=${subject.headSha} state=parked-ownership-and-deadline`);
    }
    return null;
  }
  // Pre-contract lane records may have no selected action. Missing evidence
  // selects the shared refresh row, anchored to durable lack of progress.
  const selected = lane?.headSha === subject.headSha ? lane.nextAction || nextAction(deriveNextActionSnapshot({
    subjectKey: `${repo}#${prNumber}`, head: subject.headSha, observedAt: now,
    anchors: { firstActionableAt: lane.firstNoProgressAt || lane.lastRunAt },
    observations: { pr: { state: 'OPEN', headSha: subject.headSha, labels: subject.labels } },
  })) : null;
  if (!overdueNextAction(selected, subject.headSha, now, env)) return null;
  const labels = (subject.labels || []).map(label => typeof label === 'string' ? label : label.name);
  const dispatch = async (orphanRecovery, options = {}) => {
    const candidate = await fetchCandidateImpl(repo, prNumber, { rootDir, execFileImpl });
    if (discoveryHeld(candidate?.labels)) {
      return { dispatched: false, recoveryWait: true, reason: 'recovery-candidate-held' };
    }
    if (candidate?.headSha !== subject.headSha || candidate.merged || candidate.isDraft
      || String(candidate.prState).toLowerCase() !== 'open') {
      return { dispatched: false, reason: 'recovery-candidate-no-longer-actionable' };
    }
    return dispatchImpl({ rootDir, repoPath: repo, prNumber, candidate,
      labelNames: (candidate.labels || []).map(label => typeof label === 'string' ? label : label.name),
      currentRevisionRef: candidate.headSha, reviewStateRow, domainId, orphanRecovery, logger,
      operatorApprovalEvent: candidate.operatorApprovalEvent,
      mergeAgentRequestEvent: candidate.mergeAgentRequestEvent, ...options });
  };
  const reconcileCloser = async () => {
    // Same dispatch-only entry as rescue. Recompute from live evidence without
    // setting ownerProof, so normal custody, review and retry fences still run.
    const amaClosureResult = await dispatch({ closerHead: true, fromDiscovery: true }, {
      runDaemonCleanMergeAttemptImpl: async () => ({ disposition: 'not-taken', reason: 'rescue-dispatch-only' }),
    }).catch(error => {
      logger?.warn?.(`[watcher] CLOSERPARKOWNER-02: closer reconciliation failed: ${redactPublicSafeText(error?.message || error, 200).replace(/[\r\n]+/g, ' ')}`);
      return { reason: 'closer-reconciliation-failed' };
    });
    const outcome = amaClosureResult?.dispatched ? 'ama-dispatched'
      : amaClosureResult?.needsOperator ? 'recovery-exhausted' : 'ama-pending';
    if (outcome === 'ama-pending' || amaClosureResult?.boundedWait?.notify
      || amaClosureResult?.closureRecovery?.paged) {
      logger?.log?.(`[watcher] CLOSERPARKOWNER-02: ${repo}#${prNumber}@${subject.headSha.slice(0, 12)} ` +
        `outcome=${outcome} reason=${reasonCode(amaClosureResult?.operatorReason || amaClosureResult?.reason)}`);
    }
    const successor = ['review', 'remediate', 'daemon-merge'].includes(amaClosureResult?.nextAction?.action)
      || amaClosureResult?.exactHeadReview;
    const waiting = isOrphanRecoveryWait(amaClosureResult) || amaClosureResult?.boundedWait
      || amaClosureResult?.nextAction?.queue?.intent === 'owned';
    if (outcome === 'ama-pending' && (successor || !waiting)) {
      return { continueWalk: true, missingTransition: !successor && !waiting };
    }
    return { outcome, amaClosureResult };
  };
  const recovered = await recoverImpl({ rootDir, repo, prNumber, headSha: subject.headSha, reviewStateRow, labels, now, env, logger,
    candidate: { prState: 'open', headSha: subject.headSha },
    result: { amaEnabled: true, nextAction: selected, reason: 'next-action-deadline-expired' },
    dispatchHammer: dispatch,
    reconcileCloser: allowCloserReconciliation && selected.action === 'hammer'
      && reviewStateRow?.review_status === 'posted' && reviewStateRow.reviewer_head_sha && !selected.queue?.deferredBy
      ? reconcileCloser : null,
  });
  if (recovered?.closerReconciled) return recovered.continueWalk ? null : recovered;
  if (NO_EFFECT_OUTCOMES.has(recovered?.outcome) && !recovered.amaClosureResult?.reviewRequest
    && !recoveryRunsSelected(selected, subject.headSha)) {
    logger?.log?.(`[watcher] CLOSERPARKOWNER-02: ${repo}#${prNumber}@${subject.headSha.slice(0, 12)} ` +
      `outcome=${recovered.outcome} reason=${reasonCode(recovered.amaClosureResult?.reason)} ` +
      `row=${reasonCode(String(selected.row || '').toLowerCase())}; continuing ordinary discovery`);
    return null;
  }
  return recovered;
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
