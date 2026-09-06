import { checkHcpHealthz } from './hcp-health.mjs';
import { refreshReviewerBrokerTokens, refreshWatcherGithubToken } from './reviewer-broker-refresh.mjs';
import { retryPendingReviewedAttestations } from './reviewed-attestation.mjs';

async function refreshWatcherAuthenticationForTick({ log = console } = {}) {
  // Reviewer-bot GitHub App installation tokens expire while the watcher lives;
  // this TTL-gated refresh is fail-safe and never clears a still-valid token.
  await refreshReviewerBrokerTokens({ log });
  // Same fail-safe refresh for the watcher's own GitHub token. It is a no-op
  // unless WATCHER_GH_AUTH_VIA_BROKER=true.
  await refreshWatcherGithubToken({ log });
}

function createTickHcpHealthzProbe({
  checkHcpHealthzImpl = checkHcpHealthz,
} = {}) {
  let hcpHealthzForTick = null;
  return async () => {
    if (hcpHealthzForTick === null) {
      hcpHealthzForTick = await checkHcpHealthzImpl();
    }
    return hcpHealthzForTick;
  };
}

async function retryPendingReviewedAttestationQueueForWatcher({
  rootDir,
  hqPath,
  execFileImpl,
  env,
  log = console,
  retryPendingReviewedAttestationsImpl = retryPendingReviewedAttestations,
} = {}) {
  try {
    const retryResult = await retryPendingReviewedAttestationsImpl({
      rootDir,
      hqPath,
      execFileImpl,
      env,
      log,
    });
    if (retryResult.attempted > 0) {
      log.log?.(
        `[watcher] reviewed-attestation queue retry attempted=${retryResult.attempted} ` +
          `consumed=${retryResult.consumed} remaining=${retryResult.remaining}`
      );
    }
    return retryResult;
  } catch (err) {
    log.warn?.(`[watcher] reviewed-attestation queue retry skipped: ${err?.message || err}`);
    return { attempted: 0, consumed: 0, remaining: null, skipped: true };
  }
}

export {
  createTickHcpHealthzProbe,
  refreshWatcherAuthenticationForTick,
  retryPendingReviewedAttestationQueueForWatcher,
};
