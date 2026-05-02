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
//      gone. The loop computes a fixed-rate `nextStart = lastStart +
//      intervalMs` and sleeps the remaining delay (clamped at zero).
//      By construction no two polls overlap, so the in-flight flag is
//      no longer load-bearing and is removed.
//
//   2. Watchdog deadline in this file — every `safePollOnce`
//      invocation races the underlying `pollOnceImpl(octokit)` against
//      a `setTimeout(deadlineMs)`. If the deadline fires first we log
//      loudly, abandon the hung promise, and call the supplied
//      `onTimeout` hook. The watcher wires that hook to abort all
//      in-flight reviewer subprocesses and then `process.exit` so
//      launchd KeepAlive respawns the watcher with a fresh event
//      loop. The abandoned `pollOnce` continuation is still alive in
//      memory and may still attempt side effects, so the only durable
//      way to drop that risk is to drop the whole node process.
//
// Two important design notes captured from PR #24 review feedback:
//
//   a. The watchdog timer is NOT `unref()`'d. If `pollOnceImpl`
//      wedges on a never-resolved promise with no active I/O handles,
//      Node would otherwise exit before the deadline fires, the
//      `onTimeout` hook would never run, and the distinct
//      `POLL_DEADLINE_EXCEEDED` classification (exit code 86) would
//      be lost. Keeping the timer ref'd preserves that signal.
//
//   b. `deadlineMs` accepts either a number or a `(source) => number`
//      function. The watcher path passes a function so the deadline
//      can be derived per-call from the current workload size: an
//      org-wide scan with N reviewable PRs needs a deadline larger
//      than `N * reviewer timeout + API slack`, not a fixed 10m
//      that's smaller than legitimate work.
//
// Error semantics are preserved at the wrapper boundary. The wrapper
// returns a typed `{ ok, skipped, error, timedOut }` result so callers
// can distinguish clean success, a rejected poll, and a timeout. The
// previous shape resolved success-looking objects on every path,
// which made health checks, metrics, and tests easy to write
// incorrectly.

const DEFAULT_POLL_DEADLINE_MS = 60 * 60 * 1000;

// Floor for the workload-aware deadline. Exported as the canonical
// constant so the watcher's startup log reports the same number the
// runtime actually uses — a previous version logged
// `DEFAULT_POLL_DEADLINE_MS / 1000` (3600s) while the floor here was
// 30 minutes (1800s), which made the watchdog appear twice as
// generous in operator logs as it actually was.
const DEFAULT_POLL_DEADLINE_FLOOR_MS = 30 * 60 * 1000;

// Conservative ceiling for "how many PRs could a single repo poll
// realistically process this pass." The watcher's `pollOnce` calls
// `octokit.rest.pulls.list({ per_page: 50, ... })`, so 50 is the hard
// upper bound on PRs handed back per repo per poll. Using 50 (instead
// of the previous 5) keeps the watchdog deadline above the worst case
// the GitHub query can actually produce, even though most listed PRs
// will be in `posted` / `malformed` / `failed-orphan` and skipped
// without spawning a reviewer. The deadline is a safety bound, not an
// SLA — pessimistic is correct here.
const DEFAULT_MAX_PRS_PER_REPO = 50;

function resolveDeadlineMs(deadlineMs, source) {
  const value = typeof deadlineMs === 'function' ? deadlineMs(source) : deadlineMs;
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError(
      `safePollOnce deadlineMs must resolve to a positive finite number (got: ${value})`
    );
  }
  return value;
}

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
  if (typeof deadlineMs !== 'function') {
    if (!Number.isFinite(deadlineMs) || deadlineMs <= 0) {
      throw new TypeError('buildSafePollOnce requires a positive numeric deadlineMs');
    }
  }

  return function safePollOnce(source = 'scheduled pollOnce') {
    let timeoutHandle;
    const effectiveDeadlineMs = resolveDeadlineMs(deadlineMs, source);

    const watchdog = new Promise((resolve) => {
      timeoutHandle = setTimeout(() => {
        const err = new Error(
          `pollOnce exceeded deadline of ${effectiveDeadlineMs}ms (source=${source}). ` +
          'Abandoning the hung promise so the watcher can recover.'
        );
        err.code = 'POLL_DEADLINE_EXCEEDED';
        log.error?.(`[watcher] ${err.message}`);
        resolve({ ok: false, skipped: false, error: err, timedOut: true });
      }, effectiveDeadlineMs);
      // Intentionally NOT unref()'d: if pollOnceImpl wedges on a
      // never-resolved promise with no active I/O handles, the event
      // loop would otherwise drain and Node would exit silently
      // before the deadline fires. Keeping the timer ref'd guarantees
      // the POLL_DEADLINE_EXCEEDED classification reaches onTimeout.
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

// Workload-aware default: an org-wide scan with N reviewable PRs in
// one pass needs at least `N * reviewer timeout + API slack`. A fixed
// 10m default trips on legitimate work the moment two or three slow
// reviews land in the same poll. This helper is the canonical formula
// the watcher uses; it's exported for reuse and for tests.
//
// `reviewerTimeoutMs` defaults to 5m to match `spawnReviewer()`'s
// internal `execFileAsync` timeout. `apiSlackMs` covers Linear/octokit
// calls between PRs. `floorMs` keeps tiny configurations (no repos
// configured yet, single-repo scans) from getting an unhelpfully short
// deadline that fails on a single slow review.
//
// `maxPrsPerRepo` defaults to `DEFAULT_MAX_PRS_PER_REPO` (50), which
// matches `octokit.rest.pulls.list({ per_page: 50, ... })` in
// `pollOnce`. Earlier versions defaulted to 5, which under-budgeted
// the watchdog by up to 10x on any repo that returned more than 5
// open PRs in a single poll — legitimate work would trip the deadline
// and exit code 86 would mark surviving `reviewing` rows as
// `failed-orphan` on restart, which is a false-failure path under
// normal load. Callers may override `maxPrsPerRepo` with the actual
// candidate count when they have it; the default here is the
// conservative ceiling.
function computeWorkloadAwarePollDeadlineMs({
  activeRepoCount,
  maxPrsPerRepo = DEFAULT_MAX_PRS_PER_REPO,
  reviewerTimeoutMs = 5 * 60 * 1000,
  apiSlackMs = 5 * 60 * 1000,
  floorMs = DEFAULT_POLL_DEADLINE_FLOOR_MS,
} = {}) {
  const repos = Math.max(1, Number(activeRepoCount) || 1);
  const prs = Math.max(1, Number(maxPrsPerRepo) || 1);
  const dynamic = repos * prs * reviewerTimeoutMs + apiSlackMs;
  return Math.max(floorMs, dynamic);
}

export {
  buildSafePollOnce,
  computeWorkloadAwarePollDeadlineMs,
  DEFAULT_POLL_DEADLINE_MS,
  DEFAULT_POLL_DEADLINE_FLOOR_MS,
  DEFAULT_MAX_PRS_PER_REPO,
};
