// In-process guard against overlapping pollOnce invocations.
//
// `setInterval(pollOnce, intervalMs)` fires regardless of whether the
// previous async callback has resolved. When a single pollOnce takes
// longer than the poll interval (slow Codex review, slow `prlt sync`,
// GitHub API latency), the next interval tick begins while the previous
// is still mid-flight. Both ticks then observe `review_status = 'pending'`
// for the same PR — `stmtMarkAttemptStarted` does not change the status
// field, only `last_attempted_at` — and both spawn a reviewer
// subprocess. Two reviews get posted, two follow-up jobs get queued,
// two remediation workers run, and the PR gets two near-simultaneous
// remediation commits per round.
//
// Smoking gun observed on PR #114 round 2 + round 3: two
//   `[watcher] Spawning reviewer for ...#114 ... attempt=N/4`
// log lines back-to-back from interleaved pollOnce iterations, each
// producing its own GitHub review and its own follow-up job.
//
// Fix shape: serialize pollOnce in-process via a closure-scoped flag.
// If a tick fires while the previous one is still running, log and
// skip — the next tick will pick up any work that arrived during the
// long-running poll. We accept the slight tick-skip latency; the
// alternative is the token-bonfire described above.
//
// This addresses single-process overlap only. A second watcher process
// (e.g. accidentally launched in parallel) would still race. That
// scenario is covered by the SQL-level atomic claim in a separate
// change so duplication has defense in depth.

// How often to repeat the "still in flight" log line during a single
// long-running poll. The first skip always logs (so a wedged poll is
// visible immediately); after that we log every Nth skip to avoid
// flooding the log file when the underlying poll genuinely hangs.
const SKIP_LOG_EVERY_N = 10;

function buildSafePollOnce({ pollOnceImpl, octokit, errorHandler, log = console } = {}) {
  if (typeof pollOnceImpl !== 'function') {
    throw new TypeError('buildSafePollOnce requires a pollOnceImpl function');
  }

  let pollInFlight = false;
  let skipsLogged = 0;

  return function safePollOnce() {
    if (pollInFlight) {
      skipsLogged += 1;
      if (skipsLogged === 1 || skipsLogged % SKIP_LOG_EVERY_N === 0) {
        log.log?.(
          `[watcher] Skipping scheduled poll — previous poll still in flight (skip count: ${skipsLogged}).`
        );
      }
      return Promise.resolve({ skipped: true, skipCount: skipsLogged });
    }

    pollInFlight = true;
    skipsLogged = 0;

    return Promise.resolve()
      .then(() => pollOnceImpl(octokit))
      .catch((err) => {
        if (errorHandler) errorHandler(err, 'scheduled pollOnce');
      })
      .finally(() => {
        pollInFlight = false;
      })
      .then(() => ({ skipped: false, skippedDuringPriorRun: skipsLogged }));
  };
}

export { buildSafePollOnce, SKIP_LOG_EVERY_N };
