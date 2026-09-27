// Resume decisions for a remediation worker that died with preserved work in its workspace.
// Extracted from follow-up-remediation.mjs (ARC-19 R3 ratchet): the reconcile paths decide
// whether to requeue the job onto the same workspace or record why a resume is impossible.
import { requeueInProgressFollowUpJobForRetry } from './follow-up-jobs.mjs';
import { resolveMaxTransientRemediationRetries } from './remediation-admission.mjs';
import { inspectLostRemediationWorkspace } from './remediation-git-pr-io.mjs';

// Requeue an in-progress job to resume its preserved workspace while the transient-retry
// budget allows. Returns the reconcile result, or null once the budget is spent.
function requeueForWorkspaceResume({ rootDir, jobPath, job, requeuedAt, retryReason, retryMetadata }) {
  if (Number(job?.remediationPlan?.transientRetries || 0) >= resolveMaxTransientRemediationRetries()) return null;
  const requeued = requeueInProgressFollowUpJobForRetry({
    rootDir, jobPath, requeuedAt, allowDirectWorkerRetry: true, retryReason,
    retryMetadata: { code: 'worker-killed-resume', ...retryMetadata },
  });
  return { action: 'requeued', reason: 'worker-killed-resume', job: requeued.job, jobPath: requeued.jobPath };
}

// A worker that vanished without a reply: resume its workspace when it holds commits or edits
// and the retry budget remains. Returns { requeued } or { resumeImpossible }.
async function resumeLostRemediationWorker({ rootDir, jobPath, job, worker, workspaceDir, requeuedAt, execFileImpl }) {
  const resume = worker?.dispatchMode === 'hq'
    ? { resumeImpossible: 'worker-pool-workspace-not-reusable' }
    : await inspectLostRemediationWorkspace({ workspaceDir, job, execFileImpl });
  if (resume.resumeImpossible) return { resumeImpossible: resume.resumeImpossible };
  const requeued = requeueForWorkspaceResume({
    rootDir, jobPath, job, requeuedAt, retryMetadata: resume,
    retryReason: 'Lost remediation worker left commits or edits; resume its preserved workspace.',
  });
  return requeued ? { requeued } : { resumeImpossible: 'retry-budget-exhausted' };
}

export { requeueForWorkspaceResume, resumeLostRemediationWorker };
