// REMLINK-01: recovery requires worker/service evidence, never just a moved head.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { markFollowUpJobCompleted, readFollowUpJob, writeFollowUpJob, readRemediationReplyArtifact } from './follow-up-jobs.mjs';
import { withFollowUpJobLock } from './follow-up-job-write.mjs';
import { requestReviewRereview } from './review-state.mjs';
import { requestWatcherWake } from './watcher-wake.mjs';
import { requestRereviewWake, REREVIEW_WAKE_REASONS } from './rereview-wake.mjs';
import { resolveRemediationReplyTarget, resolveReplyStorageKey } from './remediation-reply-paths.mjs';

export function findWorkerPublishedHead({ rootDir, job, headSha, execFileSyncImpl = execFileSync }) {
  const plan = job?.remediationPlan;
  // Pending retries decrement currentRound; their retained attempt is nextRound.
  const roundNumber = job?.status === 'pending' ? Number(plan?.currentRound || 0) + 1 : plan?.currentRound;
  const round = plan?.rounds?.find(entry => entry.round === roundNumber);
  const worker = job?.remediationWorker || round?.worker || {};
  const startHead = round?.startHeadSha || job?.revisionRef;
  if (!round || !headSha || !startHead || headSha === startHead
    || (!round.spawnedAt && !worker.spawnedAt && !round.publishedHeadSha)) return null;

  let reply = null;
  let replyPath = null;
  try {
    const target = resolveRemediationReplyTarget(process.env, { requireExists: false });
    replyPath = worker.replyPath || job?.remediationReply?.path
      || target.resolvePath({ launchRequestId: resolveReplyStorageKey(job) }).replyPath;
    replyPath = resolve(rootDir, replyPath);
    if (existsSync(replyPath)) reply = readRemediationReplyArtifact(replyPath, { expectedJob: job });
  } catch {
    // A missing/invalid reply cannot supply publish evidence.
  }
  const result = source => ({ round, worker, headSha, startHead, source, reply, replyPath });
  if (round.publishedHeadSha === headSha) return result('round.publishedHeadSha');
  // The reply contract names a push in its summary/validation, not a local commit.
  if (reply && [reply.summary, ...(reply.validation || [])].some(text =>
    [...String(text).matchAll(/\bpushed (?:commit |PR head (?:is )?)?([a-f0-9]{7,40})\b/gi)]
      .some(match => match[1].toLowerCase() === headSha.toLowerCase()))) return result('worker-reply');

  const storedWorkspace = job.workspaceDir || worker.workspaceDir;
  const workspaceDir = storedWorkspace ? resolve(rootDir, storedWorkspace)
    : join(rootDir, 'data', 'follow-up-jobs', 'workspaces', job.jobId);
  if (!existsSync(join(workspaceDir, '.git'))) return null;
  try {
    const branch = String(execFileSyncImpl('git', ['-C', workspaceDir, 'symbolic-ref', '--quiet', 'HEAD'],
      { encoding: 'utf8', timeout: 5000 })).trim();
    if (!branch.startsWith('refs/heads/')) return null;
    const tip = String(execFileSyncImpl('git', ['-C', workspaceDir, 'rev-parse', '--verify', `${branch}^{commit}`],
      { encoding: 'utf8', timeout: 5000 })).trim();
    return tip === headSha ? result('workspace-branch-tip') : null;
  } catch {
    return null;
  }
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
      const remediationReply = reply ? { path: replyPath, state: 'reconciled', payload: reply, reconciledAt: completedAt } : job.remediationReply;
      writeFollowUpJob(jobPath, job);
      const completed = markFollowUpJobCompleted({ rootDir, jobPath, completedAt,
        resultingHeadSha: headSha,
        remediationWorker: { ...worker, state: 'completed', reconciledAt: completedAt },
        remediationReply,
        completion: { ...job.completion, source: 'worker-published-head-recovery', publishEvidence: evidence.source },
      });
      if (completed.alreadyTerminal) return completed;
      // Final comment-only rounds hand off to the ordinary watcher cap/closure lane.
      // Other rounds request the existing rereview transition, which retains its caps
      // and authoritative terminal-PR guards. No merge decision is made here.
      let reReview;
      if (job.finalRound === 'comment-only') {
        reReview = { requested: false, status: 'suppressed', suppressed: 'comment-only-final-round' };
        requestWatcherWakeImpl({ rootDir, reason: 'comment-only-final-round-completed',
          repo: job.repo, prNumber: job.prNumber, requestedAt: completedAt });
      } else {
        const outcome = requestReviewRereviewImpl({ rootDir, repo: job.repo, prNumber: job.prNumber,
          requestedAt: completedAt, reason: reply?.reReview?.reason || null, targetRevisionRef: headSha });
        reReview = { ...outcome, requested: true, requestedAt: completedAt, reason: reply?.reReview?.reason || null };
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
      const completedRound = completed.job.remediationPlan.rounds.find(entry => entry.round === round.round);
      completedRound.reReview = reReview;
      writeFollowUpJob(completed.jobPath, completed.job);
      return completed;
    });
  } catch (error) {
    if (['ENOENT', 'EWOULDBLOCK', 'EAGAIN'].includes(error.code)) return null;
    throw error;
  }
}

export function hasWorkerPublishArtifacts({ rootDir, job }) {
  const rounds = job?.remediationPlan?.rounds || [];
  const worker = job?.remediationWorker || rounds.at(-1)?.worker || {};
  if (rounds.some(round => round.publishedHeadSha)) return true;
  const workspace = job?.workspaceDir || worker.workspaceDir;
  if (workspace && existsSync(join(resolve(rootDir, workspace), '.git'))) return true;
  try {
    const replyPath = worker.replyPath || job?.remediationReply?.path
      || resolveRemediationReplyTarget(process.env, { requireExists: false })
        .resolvePath({ launchRequestId: resolveReplyStorageKey(job) }).replyPath;
    return existsSync(resolve(rootDir, replyPath));
  } catch { return false; }
}
