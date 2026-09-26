import { stopPendingNoRemediationJobs } from './follow-up-jobs.mjs';
import { requestHammerWakeForSettledReviewStop } from './hammer-wake.mjs';

function drainPendingNoRemediationJobs({
  rootDir,
  now,
  requestWatcherWakeImpl,
  log,
  results,
}) {
  const stopped = stopPendingNoRemediationJobs({ rootDir, stoppedAt: now() });
  for (const result of stopped) {
    requestHammerWakeForSettledReviewStop({
      rootDir,
      job: result.job,
      jobPath: result.jobPath,
      stoppedAt: result.job?.stoppedAt || now(),
      requestWatcherWakeImpl,
      log,
    });
  }
  results.push(...stopped);
  return stopped.length;
}

export { drainPendingNoRemediationJobs };
