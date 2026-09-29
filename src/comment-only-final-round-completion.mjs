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
import { writeFileAtomic } from './atomic-write.mjs';
import { isTransientGitFailure, proveFinalRoundWorkerPush } from './comment-only-final-round.mjs';
import {
  OPERATIONAL_BLOCKER_KIND_PENDING_CI,
  isDeclaredOperationalBlockerCode,
} from './kernel/remediation-reply.mjs';
import { ensureJobBaseBranch } from './remediation-git-pr-io.mjs';
import { parseHqWorkerWorkspaceFromPayload, resolveHqWorkerWorkspace } from './remediation-hq-dispatch.mjs';

const CI_STATES_WITHOUT_FAILURE = new Set(['pending', 'green']);
// A transient git failure (network, lock) in the contamination audit or the push
// proof is retried in-process with this backoff, then across reconcile ticks for
// the window below, before it may become a withheld (held, alerted) head.
export const FINAL_ROUND_PROOF_RETRY_DELAYS_MS = [2000, 5000];
export const FINAL_ROUND_PROOF_TRANSIENT_WINDOW_MS = 60 * 60 * 1000;

function transientProofFailure(audit, push) {
  if (audit.suspect?.length) return null;
  if (audit.error) return isTransientGitFailure(audit.error) ? `audit: ${audit.error}` : null;
  return push.transient ? push.reason : null;
}

function writeJob(jobPath, job) {
  writeFileAtomic(jobPath, `${JSON.stringify(job, null, 2)}\n`);
}

/**
 * Are these operational blockers nothing more than PR-head CI still running?
 *
 * Requires a proven worker push and a CI probe of that exact head showing no
 * failed check. Every entry must then be tagged `kind: 'pending-ci'`. One legacy
 * shape is also accepted, for workers that predate the tag: exactly ONE untagged
 * entry, while the probe shows CI still running (not green: a finished CI cannot
 * be what that entry waits on), in a reply that is not `outcome: 'blocked'`. Any
 * entry asking for human input fails closed, tagged or not. So do two or more
 * untagged entries, and any entry carrying a declared non-CI operational code
 * (for example `stale-pr-head`). The declared-code set only ever EXCLUDES an
 * entry; no title can make an entry count as pending CI.
 */
export function classifyFinalRoundOperationalBlockers(operationalBlockers, {
  ciGate = null, pushedHead = null, outcome = null,
} = {}) {
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
  if (entries.some((entry) => String(entry?.needsHumanInput || '').trim())) {
    return { pendingCiOnly: false, reason: 'operational-blocker-needs-human-input' };
  }
  const untagged = entries.filter((entry) => entry?.kind !== OPERATIONAL_BLOCKER_KIND_PENDING_CI);
  if (untagged.length === 0) return { pendingCiOnly: true, reason: 'kind-pending-ci' };
  if (untagged.length > 1) return { pendingCiOnly: false, reason: 'ambiguous-untagged-operational-blockers' };
  if (ciGate.state !== 'pending') return { pendingCiOnly: false, reason: 'untagged-blocker-ci-not-pending' };
  if (outcome === 'blocked') return { pendingCiOnly: false, reason: 'untagged-blocker-outcome-blocked' };
  return { pendingCiOnly: true, reason: 'ci-probe-pending-ci' };
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
 *
 * A transient git failure is not a verdict: it is retried, and while it lasts
 * this returns `{ retryLater: true, job }` with the attempt recorded on the job,
 * so the caller leaves the job in progress instead of terminating it.
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
  retryDelaysMs = FINAL_ROUND_PROOF_RETRY_DELAYS_MS,
  sleepImpl = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)),
  now = Date.now,
  writeJobImpl = writeJob,
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
  let audit;
  let push;
  for (let attempt = 0; ; attempt += 1) {
    audit = await auditWorkspaceForContaminationImpl({ workspaceDir: proofWorkspaceDir, baseBranch, execFileImpl });
    push = await proveFinalRoundWorkerPush({
      repo: job.repo, prNumber: job.prNumber, jobId: job.jobId, reviewedHead: job.revisionRef, baseBranch,
      workspaceDir: proofWorkspaceDir, execFileImpl, log,
      withheldBecause: audit.error || audit.suspect?.length ? 'branch-contamination-audit-failed' : null,
    });
    const transient = transientProofFailure(audit, push);
    if (!transient) break;
    if (attempt < retryDelaysMs.length) {
      log.warn?.(`[follow-up-remediation] Retrying final-round push proof for ${job.repo}#${job.prNumber} after a transient git failure: ${transient}`);
      await sleepImpl(retryDelaysMs[attempt]);
      continue;
    }
    // Keep the job in progress so the next reconcile proves it again; only a
    // failure that outlasts the window is withheld (and so held and alerted).
    const nowMs = now();
    const since = job.finalRoundProofTransient?.since || new Date(nowMs).toISOString();
    if (nowMs - Date.parse(since) >= FINAL_ROUND_PROOF_TRANSIENT_WINDOW_MS) {
      log.error?.(`[follow-up-remediation] Final-round push proof for ${job.repo}#${job.prNumber} kept failing transiently since ${since}; withholding it: ${transient}`);
      break;
    }
    const retryJob = {
      ...job,
      finalRoundProofTransient: {
        since, lastAttemptAt: new Date(nowMs).toISOString(),
        attempts: (job.finalRoundProofTransient?.attempts || 0) + attempt + 1, error: transient,
      },
    };
    writeJobImpl(jobPath, retryJob);
    log.warn?.(`[follow-up-remediation] Final-round push proof for ${job.repo}#${job.prNumber} failed transiently; leaving the job in progress for the next reconcile: ${transient}`);
    return { retryLater: true, completed: false, workerPushedHeadSha: null, completionFields: {}, job: retryJob };
  }
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
    classification = classifyFinalRoundOperationalBlockers(operationalBlockers, {
      ciGate, pushedHead: workerPushedHeadSha, outcome: reply.outcome,
    });
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
