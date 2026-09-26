import { checkHcpHealthz } from './hcp-health.mjs';
import { refreshReviewerBrokerTokens, refreshWatcherGithubToken } from './reviewer-broker-refresh.mjs';
import { retryPendingReviewedAttestations } from './reviewed-attestation.mjs';

let watcherAuthenticationRefreshInFlight = false;

async function refreshWatcherAuthenticationForTick({
  log = console,
  refreshReviewerBrokerTokensImpl = refreshReviewerBrokerTokens,
  refreshWatcherGithubTokenImpl = refreshWatcherGithubToken,
} = {}) {
  if (watcherAuthenticationRefreshInFlight) {
    return { skipped: true, reason: 'in-flight' };
  }
  watcherAuthenticationRefreshInFlight = true;
  try {
    // Reviewer-bot GitHub App installation tokens expire while the watcher lives;
    // this TTL-gated refresh is fail-safe and never clears a still-valid token.
    await refreshReviewerBrokerTokensImpl({ log });
    // Same fail-safe refresh for the watcher's own GitHub token. It is a no-op
    // unless WATCHER_GH_AUTH_VIA_BROKER=true.
    await refreshWatcherGithubTokenImpl({ log });
    return { refreshed: true };
  } finally {
    watcherAuthenticationRefreshInFlight = false;
  }
}


// Wall-clock authentication refresh.
//
// SEV0 2026-09-06: refreshWatcherAuthenticationForTick is called at the top of
// pollOnce, so it runs once PER TICK. A tick is not bounded anywhere near the
// token lifetime -- two consecutive dispatch drains of 28.4 and 25.8 minutes put
// 54 minutes inside a single tick against a ~55 minute App installation token.
// The token expired mid-tick and every remaining `gh` call failed 401 until the
// tick ended:
//
//     refresh -> expires_at = 18:54:06Z          <- exactly ONE refresh
//     drain exceeded SLA: elapsed_ms=1705575       (28.4 min)
//     drain exceeded SLA: elapsed_ms=1546663       (25.8 min)
//     gh: Bad credentials (HTTP 401) x29
//
// The refresh itself was never broken -- it is TTL-gated, fail-safe and logs a
// correct future expires_at. It was on the wrong clock. This drives the SAME
// function from a timer so refresh cadence no longer depends on how long a tick
// takes. The underlying refresh is idempotent and TTL-gated (20 min), so calling
// it every few minutes is cheap: it only re-fetches when the token is actually
// near expiry.
const WATCHER_AUTH_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
// One retry per tick cannot keep up with the arrival rate of failed signings:
// the queue was observed oscillating between 9 and 29 entries for hours while
// draining at attempted=1 per tick, so reviewed verdicts sat unattested and
// merge authority saw no verdict at all. Drain a batch in a single-flight
// background task so slow local signing never extends the poll's critical path.
const WATCHER_REVIEWED_ATTESTATION_RETRY_MAX_ENTRIES_PER_TICK = 25;
const WATCHER_REVIEWED_ATTESTATION_RETRY_MAX_CONCURRENT_TASKS = 1;
let reviewedAttestationRetryInFlight = null;

function startWatcherAuthenticationRefreshTimer({
  log = console,
  intervalMs = WATCHER_AUTH_REFRESH_INTERVAL_MS,
  refreshImpl = refreshWatcherAuthenticationForTick,
  setIntervalImpl = setInterval,
} = {}) {
  let inFlight = false;
  const timer = setIntervalImpl(() => {
    // Never overlap timer-initiated refreshes. The default refresh function also
    // carries a shared tick/timer guard; injected test doubles rely on this one.
    if (inFlight) return;
    inFlight = true;
    Promise.resolve()
      .then(() => refreshImpl({ log }))
      .catch((err) => {
        // Never throw from a timer: an unhandled rejection here would take down
        // the watcher, which is strictly worse than a stale token.
        log.warn?.(`[watcher] wall-clock auth refresh failed: ${err?.message || err}`);
      })
      .finally(() => {
        inFlight = false;
      });
  }, intervalMs);
  // Do not hold the event loop open on our own account; the poll-interval timer
  // is what keeps the watcher alive between polls.
  timer.unref?.();
  return timer;
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
  maxEntriesPerTick = WATCHER_REVIEWED_ATTESTATION_RETRY_MAX_ENTRIES_PER_TICK,
  maxMillisPerTick = Number.POSITIVE_INFINITY,
} = {}) {
  try {
    const retryResult = await retryPendingReviewedAttestationsImpl({
      rootDir,
      hqPath,
      execFileImpl,
      env,
      log,
      maxEntriesPerRun: maxEntriesPerTick,
      maxMillisPerRun: maxMillisPerTick,
    });
    if (retryResult.attempted > 0 || retryResult.terminal > 0) {
      const terminalSuffix = retryResult.terminal > 0 ? ` terminal=${retryResult.terminal}` : '';
      log.log?.(
        `[watcher] reviewed-attestation queue retry attempted=${retryResult.attempted} ` +
          `consumed=${retryResult.consumed} remaining=${retryResult.remaining}${terminalSuffix}`
      );
    }
    return retryResult;
  } catch (err) {
    log.warn?.(`[watcher] reviewed-attestation queue retry skipped: ${err?.message || err}`);
    return { attempted: 0, consumed: 0, remaining: null, skipped: true };
  }
}

function startPendingReviewedAttestationRetryForWatcher(options = {}) {
  if (reviewedAttestationRetryInFlight) {
    return { started: false, reason: 'in-flight', promise: reviewedAttestationRetryInFlight };
  }
  reviewedAttestationRetryInFlight = Promise.resolve()
    .then(() => retryPendingReviewedAttestationQueueForWatcher(options))
    .finally(() => {
      reviewedAttestationRetryInFlight = null;
    });
  // Attach a rejection consumer even though the helper normally converts
  // failures to results. An injected implementation must not crash the daemon.
  reviewedAttestationRetryInFlight.catch(() => {});
  return { started: true, promise: reviewedAttestationRetryInFlight };
}

async function drainPendingReviewedAttestationRetryForTests() {
  await reviewedAttestationRetryInFlight;
}

export {
  WATCHER_AUTH_REFRESH_INTERVAL_MS,
  WATCHER_REVIEWED_ATTESTATION_RETRY_MAX_ENTRIES_PER_TICK,
  WATCHER_REVIEWED_ATTESTATION_RETRY_MAX_CONCURRENT_TASKS,
  createTickHcpHealthzProbe,
  startWatcherAuthenticationRefreshTimer,
  refreshWatcherAuthenticationForTick,
  retryPendingReviewedAttestationQueueForWatcher,
  startPendingReviewedAttestationRetryForWatcher,
  drainPendingReviewedAttestationRetryForTests,
};
