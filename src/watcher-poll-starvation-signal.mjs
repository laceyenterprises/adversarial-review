// Poll-starvation signal — the watcher's own page for "one tick is frozen".
//
// WPS-01. `createWatcherStallWatchdog` owns DETECTING the condition (a poll in
// flight with no completed work for its deadline-safe threshold, across N
// consecutive checks); this leaf owns what happens next. Split out of watcher.mjs to keep
// that file under its ARC-18 line ratchet, and because the delivery decision —
// which file to write, which event name to page on — is exactly the kind of
// policy leaf that should be unit-testable without booting a watcher.
//
// See `watcher-heartbeat.mjs` for why the detector delegates recovery policy to
// this hook rather than exiting inline.

import {
  DEFAULT_WATCHER_POLL_STARVATION_CHECKS,
  DEFAULT_WATCHER_POLL_STARVATION_MS,
} from './watcher-heartbeat.mjs';

const DEFAULT_STARVATION_MS_FLOOR_INTERVAL_MULTIPLIER = 3;
const POLL_STARVATION_DEADLINE_MARGIN_MS = 60_000;

function positiveNumberOr(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
}

/**
 * Resolve the starvation thresholds for this process.
 *
 * The default is the larger of the shipped floor and three poll intervals, so a
 * legitimately long tick on a slow configuration is not paged while a frozen one
 * always is. The existing override can raise this threshold, but cannot lower it
 * below the current poll deadline plus one minute of scheduling slack.
 */
export function resolvePollStarvationConfig({
  env = process.env,
  intervalMs = 0,
  pollDeadlineMs = 0,
  defaultStarvationMs = DEFAULT_WATCHER_POLL_STARVATION_MS,
  defaultChecks = DEFAULT_WATCHER_POLL_STARVATION_CHECKS,
} = {}) {
  const configured = Number(env?.ADVERSARIAL_WATCHER_POLL_STARVATION_MS);
  const requestedStarvationMs = Number.isFinite(configured) && configured > 0
    ? configured
    : Math.max(
      positiveNumberOr(defaultStarvationMs, DEFAULT_WATCHER_POLL_STARVATION_MS),
      positiveNumberOr(intervalMs, 0) * DEFAULT_STARVATION_MS_FLOOR_INTERVAL_MULTIPLIER,
    );
  const configuredChecks = Number(env?.ADVERSARIAL_WATCHER_POLL_STARVATION_CHECKS);
  const checksRequired = Number.isFinite(configuredChecks) && configuredChecks > 0
    ? Math.trunc(configuredChecks)
    : Math.max(1, Math.trunc(positiveNumberOr(defaultChecks, DEFAULT_WATCHER_POLL_STARVATION_CHECKS)));
  const starvationMs = Math.max(requestedStarvationMs,
    positiveNumberOr(pollDeadlineMs, 0) + POLL_STARVATION_DEADLINE_MARGIN_MS);
  return { starvationMs, checksRequired };
}

/**
 * Build the `onStarvation` hook for `createWatcherStallWatchdog`.
 *
 * `getHeartbeat` is a thunk because the watcher's heartbeat handle is assigned
 * after the watchdog is constructed.
 *
 * The heartbeat write uses `persist`, which refreshes `updated_at` but NOT
 * `last_poll_at` — the field the external adversarial-watcher-watchdog prefers
 * for freshness. So this makes the starvation legible WITHOUT masking the
 * staleness that proves it. Every step is individually fail-safe: a heartbeat
 * write fault or an alert-delivery fault is logged and swallowed, because a
 * reporting failure must never become a second outage.
 */
export function createPollStarvationHandler({
  getHeartbeat,
  deliverAlertFn,
  requestRestartFn,
  logger = console,
} = {}) {
  return function onStarvation({ inFlightMs, noProgressMs, starvationMs, checks, heartbeat } = {}) {
    const roundedMs = Math.round(inFlightMs || 0);
    let restartState = null;
    try {
      if (typeof requestRestartFn === 'function') {
        restartState = getHeartbeat?.()?.recordStarvationRestart?.({ inFlightMs: roundedMs, noProgressMs });
      }
    } catch (err) {
      logger?.error?.(`[watcher] poll-starvation restart history write failed: ${err?.message || err}`);
    }
    const loopDurations = restartState?.restartLoop
      ? restartState.restarts.slice(-2).map(entry => entry.in_flight_ms) : null;
    if (loopDurations && restartState.shouldPage) {
      logger?.error?.(`[watcher] poll-starvation restart loop: durations_ms=${loopDurations.join(',')}`);
    }
    try {
      getHeartbeat?.()?.persist?.('poll-starvation', {
        poll_starvation: {
          in_flight_ms: roundedMs,
          no_progress_ms: noProgressMs,
          starvation_ms: starvationMs,
          consecutive_checks: checks,
        },
      });
    } catch (err) {
      logger?.error?.(`[watcher] poll-starvation heartbeat write failed: ${err?.message || err}`);
    }
    if (typeof deliverAlertFn === 'function' && restartState?.shouldPage !== false) {
      Promise.resolve()
        .then(() => deliverAlertFn(
          loopDurations
            ? `Adversarial watcher watchdog restarted twice within one hour: polls ran for ${loopDurations.map(ms => `${Math.round(ms / 60000)}m`).join(' and ')}. Review discovery is repeatedly interrupted.`
            : `Adversarial watcher poll starved: one tick has been in flight for ` +
          `${Math.round(roundedMs / 60000)}m with no poll_counter or in-poll heartbeat progress. ` +
          'New PRs are not being discovered.',
          {
            event: loopDurations ? 'adversarial_review.poll_starvation_restart_loop' : 'adversarial_review.poll_starved',
            payload: {
              ...(loopDurations ? { restart_durations_ms: loopDurations } : {}),
              reason: 'poll-in-flight-past-sla-without-heartbeat-progress',
              in_flight_ms: roundedMs,
              no_progress_ms: noProgressMs,
              starvation_ms: starvationMs,
              consecutive_checks: checks,
              poll_counter: heartbeat?.poll_counter ?? null,
              completed_poll_counter: heartbeat?.completed_poll_counter ?? null,
              last_poll_at: heartbeat?.last_poll_at ?? null,
              last_review_at: heartbeat?.last_review_at ?? null,
              last_spawn_decision_at: heartbeat?.last_spawn_decision_at ?? null,
            },
          },
        ))
        .catch((err) => {
          logger?.error?.(`[watcher] poll-starvation alert delivery failed: ${err?.message || err}`);
        });
    }
    if (typeof requestRestartFn !== 'function') return;
    try {
      requestRestartFn({
        reason: 'poll-in-flight-past-sla-without-heartbeat-progress',
        inFlightMs: roundedMs,
        noProgressMs,
        starvationMs,
        checks,
        heartbeat,
      });
    } catch (err) {
      logger?.error?.(`[watcher] poll-starvation restart request failed: ${err?.message || err}`);
    }
  };
}

export function createPollStarvationRestartRequester({
  exitAfterReviewerCleanup,
  exitCode,
} = {}) {
  if (typeof exitAfterReviewerCleanup !== 'function') return null;
  return function requestPollStarvationRestart({ inFlightMs, heartbeat } = {}) {
    exitAfterReviewerCleanup({
      code: exitCode,
      reason: 'watcher poll-starvation watchdog',
      source: 'watcher poll-starvation watchdog',
      err: new Error(
        `watcher poll starved for ${inFlightMs}ms ` +
        `(poll_counter=${heartbeat?.poll_counter ?? 'null'}, last_poll_at=${heartbeat?.last_poll_at || 'null'})`
      ),
      message:
        'FATAL: watcher poll starved while in flight; preserving in-flight reviewer runtime sessions so launchd can respawn',
    });
  };
}

// Only completed work advances this marker; starting work or timer ticks do not.
export function trackPollHandlerProgress(handler, heartbeat) {
  return { ...handler, async run(...args) {
    try { return await handler.run(...args); }
    finally { heartbeat?.markPollProgress?.({ phase: 'handler-completed' }); }
  } };
}

// Capture one deadline for both guards. Recompute between polls as workload
// changes, so neither guard can read a different budget for the same poll.
export function createPollWatchdogBudget({ getDeadlineMs, env, intervalMs, logger = console }) {
  let deadlineMs = getDeadlineMs();
  let config = resolvePollStarvationConfig({ env, intervalMs, pollDeadlineMs: deadlineMs });
  return {
    get deadlineMs() { return deadlineMs; },
    get starvationMs() { return config.starvationMs; },
    get checksRequired() { return config.checksRequired; },
    refresh() {
      const next = getDeadlineMs();
      if (next === deadlineMs) return;
      deadlineMs = next;
      config = resolvePollStarvationConfig({ env, intervalMs, pollDeadlineMs: deadlineMs });
      logger.log(`[watcher] poll deadline changed: ${deadlineMs / 1000}s | poll-starvation respawn: ${config.starvationMs / 1000}s × ${config.checksRequired} checks`);
    },
  };
}
