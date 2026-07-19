// ── Reviewer-timeout exhaustion → merge-agent handoff ─────────────────────────
//
// ARC-18: extracted from watcher.mjs as leaf helpers.
// `maybeDispatchReviewerTimeoutExhaustedMergeAgent` is the poll-loop hook that
// hands a PR whose reviewer has exhausted its timeout budget off to the AMA
// hammer / merge-agent coexistence path; `isReviewerTimeoutExhaustedRow` is its
// private predicate (used only here). watcher's pollOnce imports
// `maybeDispatchReviewerTimeoutExhaustedMergeAgent` back and re-exports it.
// ROOT/execFileAsync are re-derived; WATCHER_PRIMARY_DOMAIN_ID stays in watcher
// and is threaded (see the `domainId` default note below).
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MERGE_AGENT_REQUESTED_LABEL,
  OPERATOR_APPROVED_LABEL,
  legacyLabelEventFromControlResult,
} from './adapters/operator/github-pr-label-controls/index.mjs';
import { ADVERSARIAL_MERGE_REQUESTED_LABEL } from './ama/labels.mjs';
import { COEXISTENCE_ACTION } from './ama/coexistence.mjs';
import { resolveMergeAgentCoexistenceForWatcher } from './ama-closure-orchestration.mjs';
import { resolveOrchestrationMode } from './pr-lifecycle-sync.mjs';
import {
  buildMergeAgentDispatchJob,
  dispatchMergeAgentForPR,
  fetchMergeAgentCandidate,
  shouldUseReviewerTimeoutExhaustedMergeGate,
} from './follow-up-merge-agent.mjs';
import { db } from './review-state-db.mjs';
import { CASCADE_FAILURE_CAP, readCascadeState } from './reviewer-cascade.mjs';
import { reviewerFailureClassFromStoredRow } from './reviewer-failure-classification.mjs';

const execFileAsync = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export async function maybeDispatchReviewerTimeoutExhaustedMergeAgent({
  rootDir = ROOT,
  repoPath,
  prNumber,
  existing,
  subjectRef,
  currentRevisionRef,
  labelNames = [],
  execFileImpl = execFileAsync,
  fetchMergeAgentCandidateImpl = fetchMergeAgentCandidate,
  buildMergeAgentDispatchJobImpl = buildMergeAgentDispatchJob,
  dispatchMergeAgentForPRImpl = dispatchMergeAgentForPR,
  operatorSurface = null,
  domainId = null, // ARC-18: WATCHER_PRIMARY_DOMAIN_ID stays in watcher; threaded by callers (pollOnce passes domainId). Default is never read (only used to build a fallback controlSubjectRef when subjectRef is absent, and every such caller passes both subjectRef and domainId).
  logger = console,
} = {}) {
  if (!isReviewerTimeoutExhaustedRow(rootDir, existing, {
    repo: repoPath,
    prNumber,
    headSha: currentRevisionRef,
  })) {
    return { handled: false, reason: 'not-reviewer-timeout-exhausted' };
  }

  try {
    let operatorApprovalEvent;
    let mergeAgentRequestEvent;
    let adversarialMergeRequestedEvent;
    if (operatorSurface) {
      const controlSubjectRef = subjectRef || {
        domainId,
        subjectExternalId: `${repoPath}#${prNumber}`,
        revisionRef: currentRevisionRef || null,
      };
      const revisionRef = currentRevisionRef || controlSubjectRef.revisionRef || null;
      const [operatorApproval, mergeAgentRequest, adversarialMergeRequest] = await Promise.all([
        labelNames.includes(OPERATOR_APPROVED_LABEL)
          ? operatorSurface.observeOperatorApproved(controlSubjectRef, revisionRef)
          : null,
        labelNames.includes(MERGE_AGENT_REQUESTED_LABEL)
          ? operatorSurface.observeMergeAgentOverride(controlSubjectRef, revisionRef)
          : null,
        labelNames.includes(ADVERSARIAL_MERGE_REQUESTED_LABEL) &&
          typeof operatorSurface.observeLabelControl === 'function'
          ? operatorSurface.observeLabelControl(
              controlSubjectRef,
              revisionRef,
              ADVERSARIAL_MERGE_REQUESTED_LABEL,
            )
          : null,
      ]);
      operatorApprovalEvent = legacyLabelEventFromControlResult(operatorApproval, OPERATOR_APPROVED_LABEL);
      mergeAgentRequestEvent = legacyLabelEventFromControlResult(mergeAgentRequest, MERGE_AGENT_REQUESTED_LABEL);
      adversarialMergeRequestedEvent = legacyLabelEventFromControlResult(
        adversarialMergeRequest,
        ADVERSARIAL_MERGE_REQUESTED_LABEL,
      );
    }
    const candidate = await fetchMergeAgentCandidateImpl(repoPath, prNumber, {
      execFileImpl,
      operatorApprovalEvent,
      mergeAgentRequestEvent,
    });
    const dispatchJob = buildMergeAgentDispatchJobImpl(rootDir, candidate, { reviewStateDb: db });
    if (!shouldUseReviewerTimeoutExhaustedMergeGate(dispatchJob)) {
      return { handled: false, dispatchJob };
    }
    const coexistenceDecision = await resolveMergeAgentCoexistenceForWatcher({
      rootDir,
      reviewStateRow: existing,
      dispatchJob,
      candidate,
      labelNames,
      operatorApprovalEvent,
      mergeAgentRequestEvent,
      adversarialMergeRequestedEvent,
      repoPath,
      prNumber,
      currentRevisionRef,
      logger,
    });
    if (coexistenceDecision.outcome === 'ama-dispatched') {
      const { amaClosureResult } = coexistenceDecision;
      logger.log(
        `[watcher] reviewer-timeout exhaustion handed off to AMA hammer for ${repoPath}#${prNumber}: ` +
        `lrq=${amaClosureResult.dispatchId || 'unknown'} workerClass=${amaClosureResult.workerClass || 'unknown'}`
      );
      return { handled: true, dispatchJob, amaClosureResult };
    }
    if (coexistenceDecision.outcome === 'ama-pending') {
      const { amaClosureResult } = coexistenceDecision;
      logger.log(
        `[watcher] reviewer-timeout exhaustion awaiting AMA hammer for ${repoPath}#${prNumber}: ` +
        `${amaClosureResult.reason || 'ama-dispatch-pending'} ` +
        `lrq=${amaClosureResult.launchRequestId || amaClosureResult.dispatchId || 'unknown'} ` +
        `workerClass=${amaClosureResult.workerClass || 'unknown'}`
      );
      return { handled: true, dispatchJob, amaClosureResult };
    }
    if (coexistenceDecision.outcome === 'await-operator') {
      const { amaClosureResult } = coexistenceDecision;
      const reasonsHint = Array.isArray(amaClosureResult?.reasons)
        ? amaClosureResult.reasons.slice(0, 8).join(',')
        : amaClosureResult?.reason || 'unknown';
      logger.log(
        `[watcher] reviewer-timeout exhaustion parked for ${repoPath}#${prNumber}: ` +
        `AMA enabled but not eligible (reasons: ${reasonsHint}); awaiting operator action ` +
        `(apply 'operator-approved'/'adversarial-merge-requested' to make AMA-eligible ` +
        `OR 'merge-agent-requested' for the operator-fallback lane)`
      );
      return { handled: true, dispatchJob, amaClosureResult };
    }
    const orchestrationMode = resolveOrchestrationMode({
      logger,
      context: 'reviewer-timeout merge-agent handoff',
    });
    const { coexistence, dispatchEnv } = coexistenceDecision;
    // AMA-06N: timeout-exhaustion path also honors triggerOverride on
    // the operator-fallback lane, same rationale as the green-path
    // dispatch above — env overlay alone is insufficient.
    const operatorFallbackTriggerOverride =
      coexistence?.action === COEXISTENCE_ACTION.MERGE_AGENT_OPERATOR_FALLBACK
        ? 'merge-agent-requested'
        : null;
    if (coexistence?.action === COEXISTENCE_ACTION.MERGE_AGENT_OPERATOR_FALLBACK) {
      logger.log(
        `[watcher] reviewer-timeout exhaustion using merge-agent operator-fallback lane for ${repoPath}#${prNumber}: ` +
        `setting AMA_OPERATOR_MERGE_AGENT_OVERRIDE=true + trigger=merge-agent-requested (AMA-06N → AMA-06A admit-gate bypass)`
      );
    } else if (coexistence?.action === COEXISTENCE_ACTION.MERGE_AGENT_RECOVERY_FALLBACK) {
      logger.log(
        `[watcher] reviewer-timeout exhaustion recovering via merge-agent for ${repoPath}#${prNumber}: ` +
        `${coexistenceDecision?.amaClosureResult?.reason || 'ama-dispatch-failure'}; ` +
        `setting AMA_OPERATOR_MERGE_AGENT_OVERRIDE=true`
      );
    }
    const dispatched = await dispatchMergeAgentForPRImpl({
      rootDir,
      ...dispatchJob,
      orchestrationMode,
      ...(dispatchEnv ? { env: { ...process.env, ...dispatchEnv } } : {}),
      ...(operatorFallbackTriggerOverride ? { triggerOverride: operatorFallbackTriggerOverride } : {}),
    });
    logger.log(
      `[watcher] reviewer-timeout exhaustion handoff for ${repoPath}#${prNumber}: ${dispatched.decision}`
    );
    return { handled: true, dispatchJob, dispatched };
  } catch (err) {
    const detail = err?.message || String(err);
    logger.error(
      `[watcher] reviewer-timeout exhaustion handoff failed for ${repoPath}#${prNumber}: ${detail}`
    );
    return { handled: false, error: err };
  }
}

export function isReviewerTimeoutExhaustedRow(rootDir, reviewRow, { repo, prNumber, headSha = null } = {}) {
  const status = String(reviewRow?.review_status || '').trim().toLowerCase();
  if (status !== 'failed' && status !== 'pending-upstream') return false;
  if (reviewerFailureClassFromStoredRow(reviewRow) !== 'reviewer-timeout') return false;
  const reviewedHeadSha = String(reviewRow?.reviewer_head_sha || '').trim();
  const currentHeadSha = String(headSha || '').trim();
  if (reviewedHeadSha && currentHeadSha && reviewedHeadSha !== currentHeadSha) return false;
  try {
    const cascadeState = readCascadeState(rootDir, { repo, prNumber });
    const timeoutFailures = Number(cascadeState?.transientFailureBreakdown?.['reviewer-timeout'] || 0);
    return timeoutFailures >= CASCADE_FAILURE_CAP;
  } catch {
    return false;
  }
}
