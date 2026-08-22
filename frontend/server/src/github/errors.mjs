/**
 * GitHub-side error taxonomy (ARF-02).
 *
 * These exist as distinct classes because the *caller* has to treat them
 * differently, and the difference is the ticket's fail-loud requirement:
 *
 *   ArfGithubAuthError      — the configured token is missing, unreadable,
 *                             unresolved, rejected, or lacks the access this
 *                             read needs. Never absorbed, never cached over,
 *                             never degraded to a placeholder. This is the class
 *                             the 2026-07-23 ambient-identity RCA is about: a
 *                             misconfigured identity that reads as "no data" is
 *                             indistinguishable from an empty pipeline.
 *   ArfGithubNotFoundError  — the PR does not exist (or is not visible). A real
 *                             answer about that PR, not a failure of ARF.
 *   ArfGithubRateLimitError — GitHub is asking us to back off. Retryable, and a
 *                             stale cached mirror is a defensible interim answer
 *                             as long as it is labelled stale. This covers both
 *                             the primary hourly budget and the *secondary*
 *                             (burst/concurrency) limit, which arrives as a 403
 *                             with the primary budget untouched and is therefore
 *                             indistinguishable from a permissions failure until
 *                             `retry-after` / the body message is read.
 *   ArfGithubError          — everything else (5xx, network, bad JSON).
 *
 * `code` is the string the HTTP surface reports, so a UI can branch without
 * pattern-matching prose.
 */

export class ArfGithubError extends Error {
  constructor(message, { status = null, code = 'github_error', cause = undefined } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'ArfGithubError';
    this.status = status;
    this.code = code;
  }
}

export class ArfGithubAuthError extends ArfGithubError {
  constructor(message, { status = null, cause = undefined } = {}) {
    super(message, { status, code: 'github_auth', cause });
    this.name = 'ArfGithubAuthError';
  }
}

export class ArfGithubNotFoundError extends ArfGithubError {
  constructor(message, { status = 404 } = {}) {
    super(message, { status, code: 'github_not_found' });
    this.name = 'ArfGithubNotFoundError';
  }
}

export class ArfGithubRateLimitError extends ArfGithubError {
  /**
   * @param {string} message
   * @param {object} [options]
   * @param {number} [options.status] 403 (primary and secondary) or 429.
   * @param {string|null} [options.resetAt] ISO time the budget frees up.
   * @param {number|null} [options.retryAfterMs] `retry-after`, in ms. Present on
   *   secondary limits, which do not publish an `x-ratelimit-reset`.
   * @param {'primary'|'secondary'} [options.scope]
   */
  constructor(message, { status = 403, resetAt = null, retryAfterMs = null, scope = 'primary' } = {}) {
    super(message, { status, code: 'github_rate_limited' });
    this.name = 'ArfGithubRateLimitError';
    this.resetAt = resetAt;
    this.retryAfterMs = retryAfterMs;
    this.scope = scope;
  }
}

/** True when an error must never be swallowed in favour of cached/empty data. */
export function isFailLoud(err) {
  return err instanceof ArfGithubAuthError;
}
