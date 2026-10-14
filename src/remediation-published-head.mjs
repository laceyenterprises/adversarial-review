// REMLINK-01: recovery requires worker/service evidence, never just a moved head.
import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { markFollowUpJobCompleted, readFollowUpJob, writeFollowUpJob, readRemediationReplyArtifact } from './follow-up-jobs.mjs';
import { withFollowUpJobLock } from './follow-up-job-write.mjs';
import { requestReviewRereview } from './review-state.mjs';
import { requestWatcherWake } from './watcher-wake.mjs';
import { requestRereviewWake, REREVIEW_WAKE_REASONS } from './rereview-wake.mjs';
import { resolveRemediationReplyTarget, resolveReplyStorageKey } from './remediation-reply-paths.mjs';
import { hasWorkerJobTrailer } from './comment-only-final-round.mjs';

function isCurrentAttemptReply(replyPath, round, worker) {
  const spawnedMs = Date.parse(worker.spawnedAt || round?.spawnedAt || '');
  try {
    const stat = statSync(replyPath);
    return Number.isFinite(spawnedMs) && stat.isFile() && stat.mtimeMs >= spawnedMs;
  } catch { return false; }
}

function workerWorkspacePath(rootDir, job, worker) {
  const stored = job?.workspaceDir || worker.workspaceDir;
  if (stored) return resolve(rootDir, stored);
  if (!job?.jobId) return null;
  const workspaceRoot = job.workspaceRoot || worker.workspaceRoot
    || process.env.ADVERSARIAL_REMEDIATION_WORKSPACE_ROOT
    || (process.env.HQ_ROOT ? join(process.env.HQ_ROOT, 'adversarial-review', 'follow-up-workspaces')
      : join(rootDir, 'data', 'follow-up-jobs', 'workspaces'));
  return join(resolve(rootDir, workspaceRoot), job.jobId);
}

export function findWorkerPublishedHead({ rootDir, job, headSha, execFileSyncImpl = execFileSync }) {
  const plan = job?.remediationPlan;
  // Pending retries decrement currentRound; their retained attempt is nextRound.
  const roundNumber = job?.status === 'pending' ? Number(plan?.currentRound || 0) + 1 : plan?.currentRound;
  const round = plan?.rounds?.find(entry => entry.round === roundNumber);
  const worker = job?.remediationWorker || round?.worker || {};
  const startHead = round?.startHeadSha || job?.revisionRef;
  if (!round || !/^[a-f0-9]{40}$/i.test(headSha || '') || !startHead
    || [startHead, job?.revisionRef].includes(headSha)
    || (!round.spawnedAt && !worker.spawnedAt)) return null;

  // Movement, a fetched branch tip, and model-written reply text cannot attest
  // authorship. Read the exact tip and the hook's job trailer in one git call.
  const workspaceDir = workerWorkspacePath(rootDir, job, worker);
  if (!workspaceDir || !existsSync(join(workspaceDir, '.git'))) return null;
  try {
    const output = String(execFileSyncImpl('git', ['-C', workspaceDir, 'show', '--no-patch', '--format=%H%n%B', 'HEAD'],
      { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] }));
    const [tip, ...message] = output.split(/\r?\n/u);
    if (tip !== headSha || !hasWorkerJobTrailer(message.join('\n'), job?.jobId)) return null;
  } catch { return null; }

  let reply = null;
  let replyPath = null;
  try {
    const target = resolveRemediationReplyTarget(process.env, { requireExists: false });
    replyPath = worker.replyPath || job?.remediationReply?.path
      || target.resolvePath({ launchRequestId: resolveReplyStorageKey(job) }).replyPath;
    replyPath = resolve(rootDir, replyPath);
    if (isCurrentAttemptReply(replyPath, round, worker)) reply = readRemediationReplyArtifact(replyPath, { expectedJob: job });
  } catch {
    // A missing/invalid reply cannot supply publish evidence.
  }
  return { round, worker, headSha, startHead, source: 'workspace-worker-job-trailer', reply, replyPath };
}

// The same terminal writer as ordinary completion owns the round and job move.
// Serialize the evidence re-read and follow-on with the move, including competing sweeps.
export function completeWorkerPublishedHead({
  rootDir, jobPath, headSha, completedAt = new Date().toISOString(),
  requestReviewRereviewImpl = requestReviewRereview,
  requestRereviewWakeImpl = requestRereviewWake,
  requestWatcherWakeImpl = requestWatcherWake,
  execFileSyncImpl = execFileSync,
}) {
  try {
    return withFollowUpJobLock(join(rootDir, 'data', 'follow-up-jobs'), () => {
      const job = readFollowUpJob(jobPath);
      if (!['pending', 'in_progress'].includes(job.status)) return null;
      const evidence = findWorkerPublishedHead({ rootDir, job, headSha, execFileSyncImpl });
      if (!evidence) return null;
      const { round, worker, reply, replyPath } = evidence;
      round.startHeadSha = evidence.startHead;
      round.publishedHeadSha = headSha;
      job.remediationPlan.currentRound = round.round;
      // Reconcile the durable reply when it exists; absence never erases a proven publish.
      const remediationReply = reply ? { path: replyPath, state: 'worker-wrote-reply', payload: reply, reconciledAt: completedAt } : job.remediationReply;
      writeFollowUpJob(jobPath, job);
      // Final comment-only rounds hand off to the ordinary watcher cap/closure lane.
      // Other rounds request the existing rereview transition, which retains its caps
      // and authoritative terminal-PR guards. No merge decision is made here.
      let reReview = job.finalRound === 'comment-only'
        ? { requested: false, status: 'suppressed', suppressed: 'comment-only-final-round' }
        : { requested: true, status: 'pending', requestedAt: completedAt, reason: reply?.reReview?.reason || null };
      const completed = markFollowUpJobCompleted({ rootDir, jobPath, completedAt,
        resultingHeadSha: headSha,
        remediationWorker: { ...worker, state: 'completed', reconciledAt: completedAt },
        remediationReply, reReview,
        completion: { ...job.completion, source: 'worker-published-head-recovery', publishEvidence: evidence.source },
      });
      if (job.finalRound === 'comment-only') {
        reReview = { requested: false, status: 'suppressed', suppressed: 'comment-only-final-round' };
        requestWatcherWakeImpl({ rootDir, reason: 'comment-only-final-round-completed',
          repo: job.repo, prNumber: job.prNumber, requestedAt: completedAt });
      } else {
        const outcome = requestReviewRereviewImpl({ rootDir, repo: job.repo, prNumber: job.prNumber,
          requestedAt: completedAt, reason: reply?.reReview?.reason || null, targetRevisionRef: headSha });
        reReview = buildRereviewResult({ requested: true, reason: reply?.reReview?.reason || null,
          outcome: { ...outcome, requestedAt: completedAt } });
        if (outcome.triggered || outcome.status === 'already-pending') {
          const wake = requestRereviewWakeImpl({ rootDir, repo: job.repo, prNumber: job.prNumber,
            headSha, reason: REREVIEW_WAKE_REASONS.REMEDIATION_CLOSEOUT,
            source: 'follow-up-remediation', sourceRef: job.jobId,
            domainId: job.domainId || null, subjectExternalId: job.subjectExternalId || null,
            requestedAt: completedAt, requestWatcherWakeImpl });
          reReview.wake = { requested: wake?.requested === true, reason: wake?.wakeReason,
            requestedAt: completedAt, outcome: wake?.outcome, watcherWoken: wake?.watcherWake?.requested === true };
        }
      }
      completed.job.reReview = reReview;
      completed.job.remediationPlan.rounds.find(entry => entry.round === round.round).reReview = reReview;
      writeFollowUpJob(completed.jobPath, completed.job);
      return completed;
    });
  } catch (error) {
    if (['ENOENT', 'EWOULDBLOCK', 'EAGAIN'].includes(error.code)) return null;
    throw error;
  }
}

export function hasWorkerPublishArtifacts({ rootDir, job, includeWorkspace = true }) {
  const plan = job?.remediationPlan;
  const roundNumber = job?.status === 'pending' ? Number(plan?.currentRound || 0) + 1 : plan?.currentRound;
  const round = plan?.rounds?.find(entry => entry.round === roundNumber);
  const worker = job?.remediationWorker || round?.worker || {};
  if (!round?.spawnedAt && !round?.publishedHeadSha && !worker.spawnedAt) return false;
  if (round?.publishedHeadSha) return true;
  const workspace = workerWorkspacePath(rootDir, job, worker);
  if (includeWorkspace && workspace && existsSync(join(workspace, '.git'))) return true;
  try {
    const replyPath = worker.replyPath || job?.remediationReply?.path
      || resolveRemediationReplyTarget(process.env, { requireExists: false })
        .resolvePath({ launchRequestId: resolveReplyStorageKey(job) }).replyPath;
    return isCurrentAttemptReply(resolve(rootDir, replyPath), round, worker);
  } catch { return false; }
}

export function buildRereviewResult({ requested, reason, outcome = null }) {
  return {
    requested,
    requestedAt: outcome?.requestedAt || null,
    reason: reason || null,
    triggered: Boolean(outcome?.triggered),
    status: outcome?.status || (requested ? 'blocked' : 'not-requested'),
    outcomeReason: outcome?.reason || null,
    reviewRow: outcome?.reviewRow
      ? {
          repo: outcome.reviewRow.repo,
          prNumber: outcome.reviewRow.pr_number,
          reviewer: outcome.reviewRow.reviewer,
          prState: outcome.reviewRow.pr_state,
          reviewStatus: outcome.reviewRow.review_status,
          reviewAttempts: outcome.reviewRow.review_attempts,
          lastAttemptedAt: outcome.reviewRow.last_attempted_at,
          postedAt: outcome.reviewRow.posted_at,
          failedAt: outcome.reviewRow.failed_at,
          revisionRef: outcome.reviewRow.revision_ref || null,
          reviewerHeadSha: outcome.reviewRow.reviewer_head_sha || null,
        }
      : null,
  };
}

export function completeLiveWorkerPublishedHead({ lifecycle, ...options }) {
  return lifecycle?.source === 'live' && lifecycle.prState === 'open'
    ? completeWorkerPublishedHead({ ...options, headSha: lifecycle.headSha }) : null;
}

export function completeKnownWorkerPublish({ proof, ...options }) {
  const completed = proof && completeWorkerPublishedHead({ ...options, headSha: proof.headSha });
  return completed ? { action: 'completed', ...completed } : null;
}
