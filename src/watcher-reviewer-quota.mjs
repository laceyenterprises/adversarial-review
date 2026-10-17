import { createAfhReviewerGroundingCache, readFleetQuotaStatusStdoutWithRetry } from './afh-reviewer-fallback.mjs';
import { FLEET_QUOTA_STATUS_TIMEOUT_MS } from './review-worker-class-fallback.mjs';

// Retain AFH's bounded stale-if-error evidence across polls, including its
// fail-closed managed-account hold. Poll-local promises never expire mid-poll.
export function createWatcherReviewerQuotaPollFactory(options = {}) {
  const { logger = console } = options;
  const readGrounding = createAfhReviewerGroundingCache({ ...options, ttlMs: 0 });
  let pollId = 0;
  return function beginPoll(execFileImpl) {
    const id = ++pollId;
    const groundings = new Map();
    let quotaRead, firstGrounding, reads = 0;
    function execQuotaOnce(command, args, execOptions) {
      if (args?.join(' ') !== 'fleet quota status --json') return execFileImpl(command, args, execOptions);
      if (!quotaRead) {
        // One shared retry sequence, including for AFH rollback. Count actual
        // subprocess attempts; candidates cannot multiply transient retries.
        quotaRead = readFleetQuotaStatusStdoutWithRetry({
          resolvedHqPath: command, hqCwd: execOptions?.cwd, env: execOptions?.env,
          timeoutMs: execOptions?.timeout, retryDelaysMs: [250], sleepImpl: options.sleepImpl,
          execFileImpl: (...callArgs) => { reads++; return execFileImpl(...callArgs); },
        }).then(stdout => ({ stdout, stderr: '' }));
      }
      return quotaRead;
    }
    function getGrounding({ claudeRuntimeProbeUid = null } = {}) {
      const key = claudeRuntimeProbeUid ?? 'quota-only';
      if (!groundings.has(key)) groundings.set(key, readGrounding({
        claudeRuntimeProbeUid,
        readOptions: { fleetQuotaExecFileImpl: execQuotaOnce, includeFleetQuotaStatus: true,
          // Keep the existing worker-class reader's bound: loaded reads can
          // exceed AFH's shorter standalone timeout without being wedged.
          timeoutMs: FLEET_QUOTA_STATUS_TIMEOUT_MS, retryDelaysMs: [] },
      }));
      firstGrounding ||= groundings.get(key);
      return groundings.get(key);
    }
    return {
      async execFile(command, args, execOptions) {
        if (args?.join(' ') !== 'fleet quota status --json') return execFileImpl(command, args, execOptions);
        const snapshot = await (firstGrounding || getGrounding());
        const status = snapshot.fleetQuotaStatus;
        if (status?.error || status?.stale || snapshot.staleIfError) {
          throw status?.cause || new Error(status?.errorMessage || 'fleet-quota-status-unavailable');
        }
        if (typeof status?.stdout === 'string') return { stdout: status.stdout, stderr: '' };
        // AFH rollback leaves the worker-class fallback reader in charge.
        return execQuotaOnce(command, args, execOptions);
      },
      getGrounding,
      logReads() { logger.log?.(`[watcher] quota-status reads per poll: poll=${id} reads=${reads}`); },
    };
  };
}
