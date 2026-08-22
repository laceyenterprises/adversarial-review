/**
 * Bounded backoff for the transient half of the broker's error split (ARF-07).
 *
 * `errors.mjs` already draws the line that matters: a bad private key is not
 * something a retry fixes, a 503 is. What was missing is that the transient side
 * was *classified* and then escalated on the first occurrence, so every blip the
 * classification exists to describe still became a failed mint.
 *
 * Three failure shapes converge here, and they are the ones the fleet has
 * actually been bitten by:
 *
 *   - **`op` is a subprocess on a machine running launchd jobs.** The 2026-05-16
 *     outage is the recorded case: a transient `EIO`/resource-unavailable at
 *     spawn time, treated as terminal, turned an OS blip into a permanent
 *     token-minting failure. One retry after 200ms would have covered it.
 *   - **GitHub and the external broker are on the other side of a network.** A
 *     5xx, a 429, or a reset connection is the definition of worth-retrying.
 *   - **A PAT fallback is not a retry.** Falling back swaps *which identity*
 *     acts; retrying re-asks the same question with the same identity. Retrying
 *     first means the fallback is reached only for a failure that actually
 *     persists, which keeps the App identity in use whenever it can be.
 *
 * The policy is deliberately small and fully bounded — attempts are capped,
 * delays are exponential with a ceiling, and **only** `broker_transient` errors
 * are retried. A permanent error (401/403/404/422, a malformed key, an
 * unmapped role, a refused ambient identity) propagates from the first attempt,
 * untouched: retrying those would either re-ask a settled question or delay a
 * fail-loud refusal this subsystem exists to make immediate.
 */

import { setTimeout as delay } from 'node:timers/promises';

import { ArfBrokerError } from './errors.mjs';

/**
 * Defaults sized for a standup wizard, where a human is waiting. Three attempts
 * with a 200ms base spends at most ~600ms of backoff before escalating — long
 * enough to ride out a spawn blip or a single bad gateway, short enough that a
 * genuinely-down upstream still fails the step rather than hanging it.
 */
export const DEFAULT_RETRY_ATTEMPTS = 3;
export const DEFAULT_RETRY_DELAY_MS = 200;
export const MAX_RETRY_DELAY_MS = 2000;

/**
 * The transient half of the split, asked once so every call site agrees.
 *
 * Matched on `code` rather than the class so an error that crossed a module
 * boundary (or was constructed by a subclass) is still classified correctly.
 *
 * @param {unknown} err
 * @returns {boolean}
 */
export function isTransientBrokerError(err) {
  return err instanceof ArfBrokerError && err.code === 'broker_transient';
}

/**
 * Backoff for the retry *after* `attempt`, capped so a misconfigured base can
 * never turn into an unbounded wait.
 *
 * @param {number} attempt 1-based
 * @param {number} baseDelayMs
 * @returns {number}
 */
export function backoffDelayMs(attempt, baseDelayMs = DEFAULT_RETRY_DELAY_MS) {
  const base = Number.isFinite(baseDelayMs) && baseDelayMs > 0
    ? baseDelayMs
    : DEFAULT_RETRY_DELAY_MS;
  return Math.min(MAX_RETRY_DELAY_MS, Math.round(base * 2 ** (attempt - 1)));
}

/**
 * Run `operation`, retrying it on transient broker errors with bounded backoff.
 *
 * The last error is rethrown unchanged, so the caller's own handling — the
 * bundled minter's PAT fallback, in particular — still sees the classification
 * it keys on and cannot tell a retried failure from an unretried one except by
 * the audit trail.
 *
 * @param {(attempt: number) => Promise<any>} operation
 * @param {object} [options]
 * @param {number} [options.attempts]     total attempts, including the first
 * @param {number} [options.baseDelayMs]
 * @param {(ms: number) => Promise<any>} [options.sleep] injection point for tests
 * @param {(info: {attempt: number, attempts: number, delayMs: number, error: Error}) => void}
 *   [options.onRetry] called before each backoff; for audit records only
 * @returns {Promise<any>} whatever `operation` resolves to
 */
export async function withTransientRetry(operation, {
  attempts = DEFAULT_RETRY_ATTEMPTS,
  baseDelayMs = DEFAULT_RETRY_DELAY_MS,
  sleep = delay,
  onRetry = null,
} = {}) {
  const total = Number.isFinite(attempts) && attempts >= 1 ? Math.floor(attempts) : 1;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (err) {
      // Escalate immediately on the permanent side, and on the last attempt.
      if (attempt >= total || !isTransientBrokerError(err)) throw err;
      const delayMs = backoffDelayMs(attempt, baseDelayMs);
      if (typeof onRetry === 'function') {
        onRetry({ attempt, attempts: total, delayMs, error: err });
      }
      await sleep(delayMs);
    }
  }
}
