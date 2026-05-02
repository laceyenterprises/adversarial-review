// Bounded watchdog around pollOnce.
//
// Background: the previous design (PR #24, before review feedback)
// serialized polling behind a single in-memory flag. That removed the
// duplicate-reviewer-spawn failure mode triggered by overlapping
// `setInterval` ticks, but introduced a worse one: any awaited step
// inside `pollOnce` that hung instead of rejecting (octokit calls in
// `syncPRLifecycle` / `pulls.list`, Linear API calls in
// `setLinearState`) would leave the in-flight flag stuck forever, and
// every future tick would be skipped until a human restarted the
// process.
//
// The current design has two parts that work together:
//
//   1. Self-scheduling loop in `src/watcher.mjs` — `setInterval` is
//      gone. `main()` awaits `safePollOnce()` then sleeps
//      `intervalMs`. By construction no two polls overlap, so the
//      in-flight flag is no longer load-bearing and is removed.
//
//   2. Watchdog deadline in this file — every `safePollOnce`
//      invocation races the underlying `pollOnceImpl(octokit)` against
//      a `setTimeout(deadlineMs)`. If the deadline fires first we log
//      loudly, abandon the hung promise, and call the supplied
//      `onTimeout` hook. The watcher wires that hook to a clean
//      `process.exit` so launchd KeepAlive respawns the watcher with a
//      fresh event loop — the abandoned `pollOnce` continuation is
//      still alive in memory and may still attempt side effects, so
//      the only durable way to drop that risk is to drop the whole
//      node process.
//
// Error semantics are preserved at the wrapper boundary. The wrapper
// returns a typed `{ ok, skipped, error, timedOut }` result so callers
// can distinguish clean success, a rejected poll, and a timeout. The
// previous shape resolved success-looking objects on every path,
// which made health checks, metrics, and tests easy to write
// incorrectly.

const DEFAULT_POLL_DEADLINE_MS = 10 * 60 * 1000;

function buildSafePollOnce({
  pollOnceImpl,
  octokit,
  errorHandler,
  log = console,
  deadlineMs = DEFAULT_POLL_DEADLINE_MS,
  onTimeout,
} = {}) {
  if (typeof pollOnceImpl !== 'function') {
    throw new TypeError('buildSafePollOnce requires a pollOnceImpl function');
  }
  if (!Number.isFinite(deadlineMs) || deadlineMs <= 0) {
    throw new TypeError('buildSafePollOnce requires a positive numeric deadlineMs');
  }

  return function safePollOnce(source = 'scheduled pollOnce') {
    let timeoutHandle;

    const watchdog = new Promise((resolve) => {
      timeoutHandle = setTimeout(() => {
        const err = new Error(
          `pollOnce exceeded deadline of ${deadlineMs}ms (source=${source}). ` +
          'Abandoning the hung promise so the watcher can recover.'
        );
        err.code = 'POLL_DEADLINE_EXCEEDED';
        log.error?.(`[watcher] ${err.message}`);
        resolve({ ok: false, skipped: false, error: err, timedOut: true });
      }, deadlineMs);
      // The watchdog timer should not keep the event loop alive on
      // its own; the poll loop already does.
      timeoutHandle.unref?.();
    });

    const work = Promise.resolve()
      .then(() => pollOnceImpl(octokit))
      .then(() => ({ ok: true, skipped: false, timedOut: false }))
      .catch((err) => ({ ok: false, skipped: false, error: err, timedOut: false }));

    return Promise.race([work, watchdog]).then((result) => {
      clearTimeout(timeoutHandle);

      if (!result.ok && result.error && errorHandler) {
        try {
          errorHandler(result.error, source);
        } catch (handlerErr) {
          log.error?.('[watcher] errorHandler threw while handling poll failure:', handlerErr);
        }
      }

      if (result.timedOut && onTimeout) {
        try {
          onTimeout(result.error, source);
        } catch (timeoutHandlerErr) {
          log.error?.('[watcher] onTimeout handler threw:', timeoutHandlerErr);
        }
      }

      return result;
    });
  };
}

export { buildSafePollOnce, DEFAULT_POLL_DEADLINE_MS };
