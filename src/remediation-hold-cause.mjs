// REMLANEACCOUNT-01: name why a remediation job that exists is not running.
//
// A job the follow-up daemon holds (no runnable remediation lane) sits in
// pending with no worker. Once its pending grace lapses the watcher reads it as
// not live and the closer reports `remediation-job-missing`, which says nothing
// about the real cause. This reads the hold the daemon already recorded on the
// latest job (never a new probe) so the blocker line can carry lane and reason.
import { findLatestFollowUpJob } from './operator-retrigger-helpers.mjs';

const HOLD_SOURCE = 'remediator-fallback-resolution';

export function remediationHoldCause(job) {
  if (job?.status !== 'pending') return null;
  const history = Array.isArray(job.remediationPlan?.retryHistory) ? job.remediationPlan.retryHistory : [];
  const metadata = history.at(-1)?.retryMetadata;
  if (!metadata || metadata.source !== HOLD_SOURCE || metadata.noRespawn !== true) return null;
  const modeRefusals = Array.isArray(metadata.modeRefusals) ? metadata.modeRefusals : [];
  return {
    lane: metadata.workerClass || null,
    reason: metadata.fallbackReason || metadata.capSource || null,
    capSource: metadata.capSource || null,
    ...(modeRefusals.length ? { modeRefusals: modeRefusals.map(({ workerClass, mode, reason }) => ({ workerClass, mode, reason })) } : {}),
    holdUntil: job.remediationPlan?.retryAfter || history.at(-1)?.retryAfter || null,
  };
}

// The detail the `remediation-job-missing` blocker carries. Diagnostic only:
// an unreadable store yields no detail, never a different blocker.
export function remediationJobMissingDetail({ rootDir, repo, prNumber, findLatestImpl = findLatestFollowUpJob } = {}) {
  try {
    const latest = findLatestImpl(rootDir, { repo, prNumber });
    const hold = remediationHoldCause(latest?.job);
    return hold ? { remediationHold: hold } : {};
  } catch {
    return {};
  }
}
