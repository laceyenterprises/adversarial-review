import { writeFollowUpJob } from './follow-up-jobs.mjs';
import { hqLaunchObservation } from './remediation-job-ownership.mjs';

const HQ_LAUNCH_OBSERVATION_REFRESH_MS = 60 * 1000;

// CLOSERREVIVE-01: persist the HQ launch status the reconcile pass just read,
// so closure reads the launch state, not an expired local timestamp. A launch
// the pass reads as exited (succeeded, failed, canceled, not found) is recorded
// as terminal at once, so it stops owning the job. An unchanged running status
// is rewritten at most once a minute.
export function recordHqLaunchObservation({ job, jobPath, liveness, observedAt }) {
  const read = hqLaunchObservation(liveness?.dispatchStatus, observedAt);
  const exited = liveness?.state === 'exited';
  if (!read.status && !exited) return job;
  const observation = exited
    ? { ...read, status: read.status || String(liveness?.dispatchStatus?.status || 'exited'), terminal: true }
    : read;
  const previous = job?.remediationWorker?.hqLaunch;
  if (previous?.status === observation.status && previous?.terminal === observation.terminal) {
    if (observation.terminal) return job;
    const previousAt = Date.parse(previous.observedAt || '');
    const nowMs = Date.parse(observedAt);
    if (Number.isFinite(previousAt) && Number.isFinite(nowMs)
      && nowMs - previousAt < HQ_LAUNCH_OBSERVATION_REFRESH_MS) return job;
  }
  const updated = { ...job, remediationWorker: { ...job.remediationWorker, hqLaunch: observation } };
  try {
    writeFollowUpJob(jobPath, updated);
    return updated;
  } catch {
    return job; // The next reconcile pass observes again.
  }
}
