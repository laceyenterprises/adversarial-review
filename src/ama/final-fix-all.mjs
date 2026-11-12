import { createFollowUpJob, listFollowUpJobsInDir } from '../follow-up-jobs.mjs';
import { pendingRepairEpoch } from '../repair-epochs.mjs';
import { tryAcquireCloserIntentLock } from './pre-receipt-intent.mjs';
import { findLiveAmaCloserLease } from './closer-lease.mjs';
import { listActiveAmaCloserDispatches } from './dispatch-closer.mjs';

export const FINAL_FIX_ALL = 'final-fix-all';
const sameHead = (a, b) => Boolean(a && b && a.toLowerCase() === b.toLowerCase());

// Queue custody lasts until terminal settlement, including admission delays.
export function finalFixAllQueueOwner(rootDir, { repo, prNumber }) {
  return ['pending', 'inProgress'].flatMap(status =>
    listFollowUpJobsInDir(rootDir, status, { repo, prNumber, caseInsensitiveRepo: true }))
    .map(entry => entry.job).find(job => job.closureHandoff?.reason === FINAL_FIX_ALL
      && job.repo.toLowerCase() === repo.toLowerCase() && Number(job.prNumber) === Number(prNumber)) || null;
}

export async function handoffFinalFixAll({ rootDir, repo, prNumber, headSha, reviewBody, now, createJobImpl = createFollowUpJob, ...options }) {
  const { handoffConflictPrimary, existingJob } = await import('./conflict-primary-handoff.mjs');
  const { findFollowUpForJob } = await import('../follow-up-review-claim.mjs');
  const { scanPrFollowUpJobs, scanArchivedStoppedFollowUpJobs } = await import('../comment-only-final-round.mjs');
  if (!String(reviewBody || '').trim()) throw new Error('final-fix-all-review-unavailable');
  const identity = { repo, prNumber, revisionRef: headSha.toLowerCase(),
    closureHandoff: { reason: FINAL_FIX_ALL, headSha: headSha.toLowerCase() } };
  const release = tryAcquireCloserIntentLock(rootDir, identity);
  if (!release) return { action: 'hold', reason: 'final-fix-all-owner-busy' };
  try {
    if (pendingRepairEpoch(rootDir, { repo, prNumber })) {
      return { action: 'hold', reason: 'repair-in-place-owned' };
    }
    const duplicate = findFollowUpForJob(rootDir, identity);
    if (duplicate) {
      const job = existingJob(rootDir, duplicate);
      if (!['pending', 'in_progress'].includes(job.status)) return { action: 'fallback' };
      return handoffConflictPrimary({ rootDir, repo, prNumber, headSha, reviewBody, now,
        reason: FINAL_FIX_ALL, ...options });
    }
    const history = ['completed', 'failed', 'stopped'].flatMap(status =>
      scanPrFollowUpJobs(rootDir, status, repo, prNumber));
    history.push(...scanArchivedStoppedFollowUpJobs(rootDir, repo, prNumber));
    // A re-review of this round's publication gets today's hammer/operator
    // fallback if it still has findings. Never start a builder/reviewer loop.
    if (history.some(job => job.closureHandoff?.reason === FINAL_FIX_ALL
      && [job.completion?.workerPushedHeadSha, job.reReview?.revisionRef,
        job.reReview?.headSha].some(head => sameHead(head, headSha)))) return { action: 'fallback' };
    const active = ['pending', 'inProgress'].flatMap(status =>
      listFollowUpJobsInDir(rootDir, status, { repo, prNumber, caseInsensitiveRepo: true }));
    if (active.length || findLiveAmaCloserLease(rootDir, identity)
      || listActiveAmaCloserDispatches(rootDir).some(record =>
        record.repo.toLowerCase() === repo.toLowerCase() && Number(record.prNumber) === Number(prNumber))) {
      return { action: 'hold', reason: 'final-fix-all-existing-owner' };
    }
    try {
      return await handoffConflictPrimary({ rootDir, repo, prNumber, headSha, reviewBody, now,
        reason: FINAL_FIX_ALL, ...options,
        createJobImpl: input => {
          // Metadata/context reads above yield. Recheck queue custody before
          // the synchronous enqueue, so a newly appeared owner wins this tick.
          if (['pending', 'inProgress'].some(status => listFollowUpJobsInDir(rootDir, status,
            { repo, prNumber, caseInsensitiveRepo: true }).length)) {
            throw Object.assign(new Error('final-fix-all-existing-owner'), { code: 'FINAL_FIX_ALL_OWNER_CHANGED' });
          }
          return createJobImpl(input);
        },
      });
    } catch (error) {
      if (error.code === 'FINAL_FIX_ALL_OWNER_CHANGED') return { action: 'hold', reason: 'final-fix-all-existing-owner' };
      throw error;
    }
  } finally { release(); }
}
