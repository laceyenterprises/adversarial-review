// COMMENTCLOSE-01: decide whether a comment-only final round is finished.
//
// Operator contract: "Comment only gets one remediation and a close." The final
// round is finished when its worker pushed a fix (or completed cleanly with
// nothing to push) and nothing real blocks it. PR-head CI that is still running
// is not a blocker: the hammer's terminal validation waits for, and fixes, CI on
// the exact head before any merge. Before this module a single pending-CI
// operational blocker demoted the round to `stopped/max-rounds-reached`, so the
// suppression marker was never read and the pushed head was reviewed again
// (SEV2 2026-09-28, agent-os#7284/#7294/#7297/#7311).
//
// Pending CI is classified structurally: the reply's `kind: 'pending-ci'` field,
// corroborated by this reconciler's own CI probe of the proven pushed head. The
// worker's free-text title is never read to decide that CI is merely pending.
import { deliverAlert } from './alert-delivery.mjs';
import { proveFinalRoundWorkerPush } from './comment-only-final-round.mjs';
import {
  OPERATIONAL_BLOCKER_KIND_PENDING_CI,
  isDeclaredOperationalBlockerCode,
} from './kernel/remediation-reply.mjs';
import { ensureJobBaseBranch } from './remediation-git-pr-io.mjs';
import { parseHqWorkerWorkspaceFromPayload, resolveHqWorkerWorkspace } from './remediation-hq-dispatch.mjs';

const CI_STATES_WITHOUT_FAILURE = new Set(['pending', 'green']);

/**
 * Are these operational blockers nothing more than PR-head CI still running?
 *
 * Requires a proven worker push and a CI probe of that exact head showing no
 * failed check. Every entry must then be tagged `kind: 'pending-ci'`, except
 * that ONE untagged entry is accepted as the CI wait: current workers predate
 * the tag and write exactly one entry for it, and the probe has independently
 * shown CI is the only open condition on the pushed head. Two or more untagged
 * entries, or any entry carrying a declared non-CI operational code (for example
 * `stale-pr-head`), fail closed. The declared-code set only ever EXCLUDES an
 * entry; no title can make an entry count as pending CI.
 */
export function classifyFinalRoundOperationalBlockers(operationalBlockers, { ciGate = null, pushedHead = null } = {}) {
  const entries = Array.isArray(operationalBlockers) ? operationalBlockers : [];
  if (entries.length === 0) return { pendingCiOnly: true, reason: 'none' };
  if (!pushedHead) return { pendingCiOnly: false, reason: 'no-proven-push' };
  if (!ciGate || ciGate.headSha !== pushedHead) return { pendingCiOnly: false, reason: 'ci-probe-head-mismatch' };
  if (!CI_STATES_WITHOUT_FAILURE.has(ciGate.state)) {
    return { pendingCiOnly: false, reason: `ci-${ciGate.state || 'unknown'}` };
  }
  if (entries.some((entry) => entry?.kind !== undefined && entry.kind !== OPERATIONAL_BLOCKER_KIND_PENDING_CI)) {
    return { pendingCiOnly: false, reason: 'unknown-operational-blocker-kind' };
  }
  if (entries.some((entry) => isDeclaredOperationalBlockerCode(entry))) {
    return { pendingCiOnly: false, reason: 'declared-non-ci-operational-blocker' };
  }
  const untagged = entries.filter((entry) => entry?.kind !== OPERATIONAL_BLOCKER_KIND_PENDING_CI);
  if (untagged.length > 1) return { pendingCiOnly: false, reason: 'ambiguous-untagged-operational-blockers' };
  return { pendingCiOnly: true, reason: untagged.length === 0 ? 'kind-pending-ci' : 'ci-probe-pending-ci' };
}

// A final round whose push could not be proven while the PR head moved is the
// one case this module cannot close on its own. Say so loudly: the head is held
// from re-review (see hasUnprovenCommentOnlyFinalRoundHead) and nothing can
// merge it without a fresh proof, so an operator has to look.
async function alertUnprovenFinalRoundPush({ job, push, deliverAlertImpl, log }) {
  const text =
    `[follow-up-remediation] Comment-only final round for ${job.repo}#${job.prNumber} moved the PR head ` +
    `${String(job.revisionRef || 'unknown').slice(0, 12)} -> ${push.liveHeadSha.slice(0, 12)} but its push ` +
    `could not be proven (${push.reason}). Re-review of that head is held and AMA will not hand it to the ` +
    'hammer. Inspect the head, then apply retrigger-review to review it, or repair and close the PR.';
  log.error?.(text);
  try {
    await deliverAlertImpl(text, {
      event: 'adversarial_review.comment_only_final_round_push_unproven',
      payload: {
        repo: job.repo, prNumber: job.prNumber, jobId: job.jobId,
        reviewedHead: job.revisionRef || null, liveHeadSha: push.liveHeadSha, reason: push.reason,
      },
    });
  } catch (err) {
    log.warn?.(`[follow-up-remediation] Unproven final-round push alert failed for ${job.repo}#${job.prNumber}: ${err?.message || err}`);
  }
}

/**
 * Resolve the final-round outcome for a reconciled worker reply.
 *
 * Every final round that wrote a reply gets one push-proof attempt, whatever its
 * outcome, so a stopped final round still records the head it pushed and keeps
 * suppressing a re-review of it. `completionFields` is spread into the job's
 * completion metadata on every terminal path.
 */
export async function resolveCommentOnlyFinalRoundCompletion({
  job,
  jobPath,
  reply,
  worker = null,
  liveness = null,
  workspaceDir = null,
  auditWorkspaceForContaminationImpl,
  inspectRemediationCiRegressionImpl,
  deliverAlertImpl = deliverAlert,
  execFileImpl,
  env = process.env,
  log = console,
} = {}) {
  if (job?.finalRound !== 'comment-only' || !reply) {
    return { completed: false, workerPushedHeadSha: null, completionFields: {} };
  }
  let proofWorkspaceDir = workspaceDir;
  if (worker?.dispatchMode === 'hq') {
    proofWorkspaceDir = parseHqWorkerWorkspaceFromPayload(liveness?.dispatchStatus || {})
      || await resolveHqWorkerWorkspace({ worker, execFileImpl })
      || workspaceDir;
  }
  const { baseBranch } = await ensureJobBaseBranch({ job, jobPath, execFileImpl });
  const audit = await auditWorkspaceForContaminationImpl({ workspaceDir: proofWorkspaceDir, baseBranch, execFileImpl });
  const push = await proveFinalRoundWorkerPush({
    repo: job.repo, prNumber: job.prNumber, jobId: job.jobId, reviewedHead: job.revisionRef, baseBranch,
    workspaceDir: proofWorkspaceDir, execFileImpl, log,
    withheldBecause: audit.error || audit.suspect?.length ? 'branch-contamination-audit-failed' : null,
  });
  const workerPushedHeadSha = push.workerPushedHeadSha;
  const withheldPushHeadSha = !workerPushedHeadSha && push.liveHeadSha && push.liveHeadSha !== job.revisionRef
    ? push.liveHeadSha
    : null;
  if (withheldPushHeadSha) await alertUnprovenFinalRoundPush({ job, push, deliverAlertImpl, log });

  const blockers = Array.isArray(reply.blockers) ? reply.blockers : [];
  const operationalBlockers = Array.isArray(reply.operationalBlockers) ? reply.operationalBlockers : [];
  let classification;
  let ciState = null;
  if (blockers.length > 0) {
    classification = { pendingCiOnly: false, reason: 'review-blockers' };
  } else if (operationalBlockers.length > 0 && workerPushedHeadSha) {
    const ciGate = await inspectRemediationCiRegressionImpl({
      repo: job.repo, prNumber: job.prNumber, execFileImpl, env, log,
    });
    ciState = ciGate?.state || null;
    classification = classifyFinalRoundOperationalBlockers(operationalBlockers, { ciGate, pushedHead: workerPushedHeadSha });
  } else {
    classification = classifyFinalRoundOperationalBlockers(operationalBlockers, { pushedHead: workerPushedHeadSha });
  }
  // A worker that pushed nothing may still finish cleanly (it disproved the
  // findings); only a proven push can carry a partial/blocked reply over. An
  // unproven moved head does not change the outcome; it is alerted and held.
  const completed = classification.pendingCiOnly && (reply.outcome === 'completed' || Boolean(workerPushedHeadSha));
  const reason = completed || !classification.pendingCiOnly ? classification.reason : 'no-proven-push';
  if (!completed) {
    log.warn?.(
      `[follow-up-remediation] Comment-only final round for ${job.repo}#${job.prNumber} is not complete: ` +
        `outcome=${reply.outcome} reason=${reason} push=${push.reason}`
    );
  }
  return {
    completed,
    workerPushedHeadSha,
    completionFields: {
      ...(workerPushedHeadSha ? { workerPushedHeadSha, workerPushProof: push.proof } : {}),
      ...(withheldPushHeadSha ? { withheldPushHeadSha } : {}),
      finalRoundOutcome: { completed, reason, ciState, push: push.reason },
    },
  };
}
