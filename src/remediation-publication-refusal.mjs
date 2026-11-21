import { realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { markFollowUpJobStopped, readFollowUpJob } from './follow-up-jobs.mjs';
import { withFollowUpJobLock } from './follow-up-job-write.mjs';
import { CREDENTIAL_REFRESH_UNAVAILABLE } from './remediation-credential-broker.mjs';
import { OWNER_AUTH_HOLD } from './remediation-owner-auth.mjs';
import { publicationBlocker, PUBLICATION_AUTH_REJECTED, PUBLICATION_STALE_LEASE } from './remediation-publication.mjs';
import { resolvePublicationWorkspace } from './remediation-publication-workspace.mjs';
import { preserveUnpushedCommit } from './github-auth-recovery.mjs';

const SHA = /^[a-f0-9]{40}$/u;
const ownedByCurrentUid = path => typeof process.getuid !== 'function' || statSync(path).uid === process.getuid();

const HANDOFF_CODES = new Set([PUBLICATION_AUTH_REJECTED, OWNER_AUTH_HOLD,
  PUBLICATION_STALE_LEASE, CREDENTIAL_REFRESH_UNAVAILABLE]);

export function matchesPublicationFailureAttempt(failure, job, worker, now) {
  return failure?.jobId === job.jobId
    && failure.repo === job.repo && failure.prNumber === job.prNumber
    && SHA.test(failure.previousHead || '') && failure.previousHead === job.revisionRef
    && SHA.test(failure.expectedRemoteSha || '')
    && (failure.localCommit === null || SHA.test(failure.localCommit || ''))
    && Date.parse(failure.refusedAt) >= Date.parse(worker.spawnedAt)
    && Date.parse(failure.refusedAt) <= Date.parse(now);
}

export function isPublicationHandoffCode(code) {
  return HANDOFF_CODES.has(code);
}

async function inspectRetainedSource({ job, workspaceDir, commitSha, execFileImpl, log }) {
  if (!commitSha) return null;
  try {
    const selected = await resolvePublicationWorkspace({ job, workspaceDir, execFileImpl, log, canInspect: ownedByCurrentUid });
    if (!selected || !ownedByCurrentUid(selected)) return null;
    const git = async args => (await execFileImpl('git', ['--no-replace-objects', '-C', selected, ...args],
      { encoding: 'utf8', timeout: 5000, maxBuffer: 64 * 1024 })).stdout.trim();
    if (realpathSync(await git(['rev-parse', '--show-toplevel'])) !== realpathSync(selected)) return null;
    return await git(['rev-parse', '--verify', 'HEAD^{commit}']) === commitSha ? selected : null;
  } catch { return null; }
}

// The sidecar documents a refusal. Recovery stays with the original owner and
// guarded publisher. This path does not acquire credentials or change a branch.
export async function settlePublicationHandoff({
  rootDir, job, jobPath, worker, hqRoot, failure, lifecycle, lifecycleStop, workspaceDir, replyPath,
  reply, stoppedAt, execFileImpl, log,
}) {
  const { code, localCommit, previousHead, expectedRemoteSha, refusedAt } = failure;
  const unpublishedCommit = localCommit !== expectedRemoteSha && localCommit !== previousHead ? localCommit : null;
  const selected = await inspectRetainedSource({ job, workspaceDir, commitSha: unpublishedCommit, execFileImpl, log });
  let rescue = null;
  if (selected) {
    try {
      if (typeof process.getuid === 'function' && statSync(selected).uid === process.getuid()) {
        rescue = await preserveUnpushedCommit({ hqRoot, workspaceDir: selected, repo: job.repo, prNumber: job.prNumber,
          jobId: job.jobId, commitSha: localCommit, observedAt: stoppedAt, checkoutTipOnly: true,
          expectedRemoteSha, execFileImpl });
      }
    } catch { log.warn?.(`[follow-up-remediation] Could not bundle retained publication for ${job.jobId}; keeping checkout evidence.`); }
  }
  const liveHeadSha = lifecycle?.source === 'live' && SHA.test(lifecycle.headSha || '') ? lifecycle.headSha : null;
  const reason = code === PUBLICATION_STALE_LEASE || (liveHeadSha && liveHeadSha !== expectedRemoteSha)
    ? 'stale-head' : !selected ? 'local-source-unverified'
      : code === CREDENTIAL_REFRESH_UNAVAILABLE ? 'credential-broker-deferred' : 'owner-recovery-required';
  const driftStop = lifecycleStop?.stopCode === 'stale-drift' ? lifecycleStop : null;
  const stopCode = driftStop?.stopCode ?? (reason === 'stale-head' ? PUBLICATION_STALE_LEASE : OWNER_AUTH_HOLD);
  const blocker = publicationBlocker(failure);
  const stopReason = driftStop?.stopReason ?? `${blocker.finding} Publication recovery is held (${reason}).`;
  const validRefusalReply = reply?.reReview?.requested === false && ['blocked', 'partial'].includes(reply.outcome)
    && reply.operationalBlockers?.some(entry => entry.code === code && entry.commitSha === blocker.commitSha
      && entry.expectedRemoteSha === expectedRemoteSha);
  const publicationFailure = { code, localCommit, previousHead, expectedRemoteSha, refusedAt, reason, liveHeadSha,
    ...(code === OWNER_AUTH_HOLD && { owner: failure.owner, capability: failure.capability, routeReason: failure.reason }) };
  try {
    return withFollowUpJobLock(join(rootDir, 'data', 'follow-up-jobs'), () => {
      const current = readFollowUpJob(jobPath);
      if (current.status !== 'in_progress' || current.jobId !== job.jobId || current.revisionRef !== previousHead
        || current.workspaceDir !== job.workspaceDir
        || current.remediationPlan?.currentRound !== job.remediationPlan?.currentRound
        || ['state', 'dispatchMode', 'dispatchId', 'launchRequestId', 'processId', 'spawnedAt', 'replyPath', 'workspaceDir']
          .some(key => current.remediationWorker?.[key] !== worker[key])) {
        return { action: 'skipped', reason: 'publication-handoff-custody-changed', job: current, jobPath };
      }
      const stopped = markFollowUpJobStopped({
        rootDir, jobPath, stoppedAt, sourceStatus: 'in_progress', stopCode, stopReason,
        commentDeliveryExemption: 'interrupted-without-reconciled-reply',
        remediationWorker: { ...current.remediationWorker, state: driftStop?.workerState ?? 'completed', reconciledAt: stoppedAt },
        remediationReply: { path: replyPath, reconciledAt: stoppedAt,
          ...(validRefusalReply ? { state: 'worker-wrote-reply', payload: reply }
            : { state: 'publication-refusal-reply-unverified' }) },
        jobUpdates: {
          publicationFailure,
          ...(code === OWNER_AUTH_HOLD && { ownerAuthHold: { code, owner: failure.owner,
            capability: failure.capability, reason: failure.reason, recordedAt: stoppedAt } }),
          ...(validRefusalReply && { parsedReply: reply }),
          ...(unpublishedCommit && { unpublishedWork: { jobId: job.jobId,
            commitSha: unpublishedCommit, expectedRemoteSha, workspaceDir: selected, reported: true,
            liveHeadSha, publicationReason: reason, ...(rescue?.preserved && { rescue }) } }),
        },
      });
      return { action: 'stopped', reason: stopCode, job: stopped.job, jobPath: stopped.jobPath };
    });
  } catch (error) {
    if (!['ENOENT', 'EWOULDBLOCK', 'EAGAIN'].includes(error.code)) throw error;
    return { action: 'skipped', reason: 'publication-handoff-custody-changed', job, jobPath };
  }
}
