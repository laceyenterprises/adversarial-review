// Poll-starvation signal — the watcher's own page for "one tick is frozen".
//
// WPS-01. `createWatcherStallWatchdog` owns DETECTING the condition (a poll in
// flight past its SLA with no `poll_counter` advance, across N consecutive
// checks); this leaf owns what happens next. Split out of watcher.mjs to keep
// that file under its ARC-18 line ratchet, and because the delivery decision —
// which file to write, which event name to page on — is exactly the kind of
// policy leaf that should be unit-testable without booting a watcher.
//
// See `watcher-heartbeat.mjs` for why this signals rather than exits.

import {
  DEFAULT_WATCHER_POLL_STARVATION_CHECKS,
  DEFAULT_WATCHER_POLL_STARVATION_MS,
} from './watcher-heartbeat.mjs';

const DEFAULT_STARVATION_MS_FLOOR_INTERVAL_MULTIPLIER = 3;

function positiveNumberOr(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
}

/**
 * Resolve the starvation thresholds for this process.
 *
 * The default is the larger of the shipped floor and three poll intervals, so a
 * legitimately long tick on a slow configuration is not paged while a frozen one
 * always is. An explicit env value always wins.
 */
export function resolvePollStarvationConfig({
  env = process.env,
  intervalMs = 0,
  defaultStarvationMs = DEFAULT_WATCHER_POLL_STARVATION_MS,
  defaultChecks = DEFAULT_WATCHER_POLL_STARVATION_CHECKS,
} = {}) {
  const configured = Number(env?.ADVERSARIAL_WATCHER_POLL_STARVATION_MS);
  const starvationMs = Number.isFinite(configured) && configured > 0
    ? configured
    : Math.max(
      positiveNumberOr(defaultStarvationMs, DEFAULT_WATCHER_POLL_STARVATION_MS),
      positiveNumberOr(intervalMs, 0) * DEFAULT_STARVATION_MS_FLOOR_INTERVAL_MULTIPLIER,
    );
  const configuredChecks = Number(env?.ADVERSARIAL_WATCHER_POLL_STARVATION_CHECKS);
  const checksRequired = Number.isFinite(configuredChecks) && configuredChecks > 0
    ? Math.trunc(configuredChecks)
    : Math.max(1, Math.trunc(positiveNumberOr(defaultChecks, DEFAULT_WATCHER_POLL_STARVATION_CHECKS)));
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
  logger = console,
} = {}) {
  return function onStarvation({ inFlightMs, starvationMs, checks, heartbeat } = {}) {
    const roundedMs = Math.round(inFlightMs || 0);
    try {
      getHeartbeat?.()?.persist?.('poll-starvation', {
        poll_starvation: {
          in_flight_ms: roundedMs,
          starvation_ms: starvationMs,
          consecutive_checks: checks,
        },
      });
    } catch (err) {
      logger?.error?.(`[watcher] poll-starvation heartbeat write failed: ${err?.message || err}`);
    }
    if (typeof deliverAlertFn !== 'function') return;
    Promise.resolve()
      .then(() => deliverAlertFn(
        `Adversarial watcher poll starved: one tick has been in flight for ` +
        `${Math.round(roundedMs / 60000)}m with no poll_counter advance. ` +
        'New PRs are not being discovered.',
        {
          event: 'adversarial_review.poll_starved',
          payload: {
            reason: 'poll-in-flight-past-sla-with-frozen-poll-counter',
            in_flight_ms: roundedMs,
            starvation_ms: starvationMs,
            consecutive_checks: checks,
            poll_counter: heartbeat?.poll_counter ?? null,
            last_poll_at: heartbeat?.last_poll_at ?? null,
          },
        },
      ))
      .catch((err) => {
        logger?.error?.(`[watcher] poll-starvation alert delivery failed: ${err?.message || err}`);
      });
  };
}
