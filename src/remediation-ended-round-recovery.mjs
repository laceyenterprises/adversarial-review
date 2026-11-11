import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { statSync } from 'node:fs';
import * as jobs from './follow-up-jobs.mjs';
import { withFollowUpJobLock } from './follow-up-job-write.mjs';
import { findLatestFollowUpJob } from './operator-retrigger-helpers.mjs';
import { recreateMissingRemediationJob } from './remediation-job-missing-recovery.mjs';
import { isEndedRemediationRound } from './remediation-round-recovery.mjs';
import { recoveryDigest } from './comment-only-recovery-record.mjs';
import { hasWorkerJobTrailer } from './comment-only-final-round.mjs';
import { publishRemediation } from './remediation-publication.mjs';
import { proveStoppedPublication } from './remediation-publication-recovery.mjs';
import { tryAcquireDeliveryClaim, releaseDeliveryClaim } from './adapters/comms/github-pr-comments/comment-delivery.mjs';
import { findLiveAmaCloserLease } from './ama/closer-lease.mjs';
import { completeWorkerPublishedHead } from './remediation-published-head.mjs';

const execAsync = promisify(execFile);

// Attempt the retained commit before spending another ordinary round. The
// publisher still owns diff validation, attestation hooks and the remote lease.
// Network work never holds the queue's synchronous flock.
export async function recoverEndedRemediationRound({ execFileImpl = execAsync,
  publishImpl = publishRemediation, proveImpl = proveStoppedPublication,
  completeImpl = completeWorkerPublishedHead, publicationEnv = null,
  statImpl = statSync, ...options }) {
  const { rootDir, repo, prNumber, headSha, now = new Date().toISOString() } = options;
  if (!rootDir || !repo || !/^[a-f0-9]{40}$/i.test(headSha || '')) {
    return { recreated: false, reason: 'recovery-input-incomplete', jobId: null };
  }
  const latest = withFollowUpJobLock(join(rootDir, 'data', 'follow-up-jobs'), () => {
    if (findLiveAmaCloserLease(rootDir, { repo, prNumber })) return null;
    if (['pending', 'inProgress'].some(key => jobs.listFollowUpJobsInDir(rootDir, key,
      { repo, prNumber, caseInsensitiveRepo: true }).some(({ job }) =>
      String(job.repo).toLowerCase() === String(repo).toLowerCase()
      && Number(job.prNumber) === Number(prNumber)))) return null;
    return findLatestFollowUpJob(rootDir, { repo, prNumber });
  });
  const job = latest?.job;
  if (!job || !isEndedRemediationRound(job) || job.revisionRef !== headSha) {
    return recreateMissingRemediationJob(options);
  }
  if (!String(job.reviewBody ?? '').trim()) {
    return { recreated: false, reason: 'review-body-missing', jobId: job.jobId };
  }
  if (jobs.isSettledCleanClassification(jobs.classifyFollowUpCriticality(job.reviewBody),
    { strictMode: options.strictMode !== false })) {
    return { recreated: false, reason: 'review-settled-clean', jobId: job.jobId };
  }
  const due = Date.parse(job.remediationPlan?.retryAfter || '');
  if (Number.isFinite(due) && due > Date.parse(now)) return { recreated: false, reason: 'retry-backoff', jobId: job.jobId };
  // Watcher discovery owns queue recovery, not worker authentication or network
  // publication. Without an explicitly supplied worker environment, leave the
  // retained checkout untouched and let the next bounded worker own repair.
  if (!publicationEnv) return recreateMissingRemediationJob(options);
  const claimPath = `${latest.jobPath}.round-recovery`;
  if (!tryAcquireDeliveryClaim(claimPath, `round-recovery:${process.pid}`).acquired) {
    return { recreated: false, reason: 'round-recovery-owned', jobId: job.jobId };
  }
  const digest = recoveryDigest(job);
  try {
    // Stay inside the existing five-minute claim window across all subprocess
    // calls, including publisher checks and the final live-head proof.
    const deadline = Date.now() + 120_000;
    const boundedExec = (command, args, settings = {}) => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error('retained-publication-deadline');
      return execFileImpl(command, args, { ...settings,
        env: publicationEnv,
        timeout: Math.min(settings.timeout || remaining, remaining) });
    };
    let publicationRecovery = null;
    let revisionRef = headSha;
    const retained = job.unpublishedWork;
    if (retained?.workspaceDir && retained.commitSha && job.branch && job.baseBranch) {
      const git = async args => String((await boundedExec('git',
        ['--no-replace-objects', '-C', retained.workspaceDir, ...args],
        { timeout: 15_000, maxBuffer: 4 * 1024 * 1024 })).stdout || '').trim();
      let verified = false;
      try {
        // Refuse cross-user checkout mutation before the first git call.
        if (typeof process.getuid !== 'function'
          || statImpl(retained.workspaceDir).uid !== process.getuid()) {
          return recreateMissingRemediationJob(options);
        }
        // Retained workspaces may lack the remote base ref. Refresh the same
        // superproject-only ref used by the publisher before ancestry checks.
        await git(['fetch', '--no-recurse-submodules', '--no-tags', 'origin',
          `+refs/heads/${job.baseBranch}:refs/remotes/origin/${job.baseBranch}`]);
        // A model-reported hash is only a hint. Verify the actual checkout,
        // every added commit's provenance and preservation of reviewed patches.
        const tip = await git(['rev-parse', '--verify', 'HEAD^{commit}']);
        const additions = (await git(['cherry', headSha, tip, `origin/${job.baseBranch}`]))
          .split('\n').filter(line => line.startsWith('+ ')).map(line => line.slice(2));
        const missing = (await git(['cherry', tip, headSha])).split('\n').some(line => line.startsWith('+ '));
        verified = tip === retained.commitSha && /^[a-f0-9]{40}$/i.test(tip)
          && !await git(['status', '--porcelain', '--untracked-files=no'])
          && !missing
          && !await git(['rev-list', '--merges', tip, `^${headSha}`, `^origin/${job.baseBranch}`])
          && additions.length > 0;
        for (const sha of additions) {
          if (!hasWorkerJobTrailer(await git(['show', '-s', '--format=%B', sha]), job.jobId)) verified = false;
        }
      } catch { /* Unavailable or unverifiable work uses the next bounded round. */ }
      if (verified) {
        const unchanged = withFollowUpJobLock(join(rootDir, 'data', 'follow-up-jobs'), () => {
          try {
            return recoveryDigest(jobs.readFollowUpJob(latest.jobPath)) === digest
              && !findLiveAmaCloserLease(rootDir, { repo, prNumber })
              && !['pending', 'inProgress'].some(key => jobs.listFollowUpJobsInDir(rootDir, key,
                { repo, prNumber, caseInsensitiveRepo: true }).some(({ job: active }) =>
                String(active.repo).toLowerCase() === String(repo).toLowerCase()
                && Number(active.prNumber) === Number(prNumber)));
          } catch (error) {
            if (error.code === 'ENOENT') return false;
            throw error;
          }
        });
        if (!unchanged) return { recreated: false, reason: 'job-evidence-changed', jobId: job.jobId };
        try {
          const result = await publishImpl({ workspaceDir: retained.workspaceDir,
            baseBranch: job.baseBranch, previousHead: headSha, expectedRemoteSha: headSha,
            branch: job.branch, repo, prNumber, execFileImpl: boundedExec,
            env: publicationEnv });
          revisionRef = result.headSha;
        } catch { /* A refused publication never relaxes the ordinary round budget. */ }
        if (revisionRef !== headSha) {
          publicationRecovery = await proveImpl({ job, jobPath: latest.jobPath,
            headSha: revisionRef, execFileImpl: boundedExec });
          if (!publicationRecovery) return { recreated: false, reason: 'publication-awaiting-proof', jobId: job.jobId };
          const completed = completeImpl({ rootDir, jobPath: latest.jobPath,
            headSha: revisionRef, completedAt: now, publicationRecovery,
            snapshot: options.snapshot });
          if (completed?.job?.status === 'completed') return { recreated: false, completed: true,
            reason: 'retained-publication-completed', jobId: job.jobId, jobPath: completed.jobPath,
            nextAction: completed.job.reReview?.nextAction };
        }
      }
    }
    return recreateMissingRemediationJob({ ...options, headSha: revisionRef,
      expectedDigest: digest, publicationRecovery });
  } finally {
    releaseDeliveryClaim(claimPath);
  }
}
