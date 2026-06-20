import { PROGRESS_TIMEOUT_REASON_PREFIX } from '../../../reviewer-timeout-reason.mjs';
import {
  QUOTA_EXHAUSTED_FAILURE_CLASS,
  detectQuotaExhaustion,
} from '../../../quota-exhaustion.mjs';

const BUG_ERROR_CODES = new Set(['ENOENT', 'EACCES', 'EPERM']);
const CASCADE_ERROR_CODES = new Set(['ETIMEDOUT']);
const REVIEWER_TIMEOUT_MESSAGE_RE = /command timed out after \d+ms/;
const REVIEWER_PROGRESS_TIMEOUT_MESSAGE_RE = new RegExp(
  `command ${escapeRegExp(PROGRESS_TIMEOUT_REASON_PREFIX)} \\d+ms`
);
const LAUNCHCTL_BOOTSTRAP_ERROR_RE =
  /bootstrap failed|could not find domain|input\/output error|not privileged to set domain/;

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isReviewerSubprocessTimeout(error, { killSignal = 'SIGTERM' } = {}) {
  const actualSignal = String(error?.signal || '').toUpperCase();
  const expectedSignal = String(killSignal || 'SIGTERM').toUpperCase();
  return (
    error?.timedOut === true ||
    error?.progressTimedOut === true ||
    (
      error?.killed === true &&
      (actualSignal === expectedSignal || actualSignal === 'SIGKILL') &&
      String(error?.code || '').toUpperCase() !== 'ABORT_ERR'
    )
  );
}

function classifyReviewerFailure(stderr, exitCode, errorCode = null, details = {}) {
  const text = String(stderr || '');
  const lower = text.toLowerCase();
  const normalizedErrorCode = String(errorCode || '').toUpperCase();
  const timeoutKilled = details?.timeoutKilled === true || isReviewerSubprocessTimeout(details);
  const mentionsReviewerTimeout =
    REVIEWER_TIMEOUT_MESSAGE_RE.test(lower) ||
    REVIEWER_PROGRESS_TIMEOUT_MESSAGE_RE.test(lower);
  const launchctlBootstrap = lower.split(/\r?\n/).some((line) => (
    /launchctlsessionerror|claude launchctl session bootstrap failed/.test(line) ||
    (/launchctl/.test(line) && LAUNCHCTL_BOOTSTRAP_ERROR_RE.test(line))
  ));
  const mentionsReal429 =
    /\b429\b|too many requests|http\s*429|rate_limit_exceeded|ratelimiterror|quota/.test(lower);
  const mentionsRateLimit = /rate.?limit/.test(lower);
  // Routing-tier unavailability: the LiteLLM proxy on 127.0.0.1:4000 is the
  // single bottleneck every Claude/Codex CLI reviewer goes through. When the
  // proxy bounces (os-restart, main-catchup classification, post-reboot
  // RunAtLoad, --force-recreate cycle) the CLI emits localized markers that
  // do not contain the word "litellm" or any HTTP status — so the legacy
  // cascade regex misclassifies them as unknown failures and burns the
  // attempt budget. 2026-06-04 data: 18 reviewer failures with
  // "API Error: Unable to connect to API (ConnectionRefused)" against
  // 6 successful reviews in the same 500-log-line window, all attributable
  // to the proxy restart cycle (LaunchDaemon runs=8, last terminating
  // signal=SIGTERM clean) — every one of those 18 burned a real attempt
  // and several PRs ran out of budget mid-restart, posting permanent
  // "FINAL — lenient threshold" verdicts despite the absence of any actual
  // review work. Keep the patterns scoped to the known proxy/API surface so
  // unrelated reviewer-side network/config failures do not get folded into
  // the routing-tier cascade bucket.
  const mentionsApiConnectFailure = /unable to connect to api\b/.test(lower);
  const mentionsProxyAddress = /127\.0\.0\.1:4000|localhost:4000|\[::1\]:4000/.test(lower);
  const mentionsLocalRoutingContext =
    mentionsProxyAddress ||
    /\blitellm\b|\blocal proxy\b|\brouting[- ]tier\b|\breadiness probe\b/.test(lower);
  const mentionsProxyConnectionRefused =
    /\beconnrefused\b/.test(lower) && mentionsLocalRoutingContext
    || /\bconnection refused\b/.test(lower) && mentionsLocalRoutingContext
    || /unable to connect to api\s*\(connectionrefused\)/.test(lower) && mentionsLocalRoutingContext;
  const mentionsApiSocketHangup =
    /\bsocket hang up\b/.test(lower) &&
    mentionsLocalRoutingContext;
  const mentionsRoutingTier5xx =
    /\bapi error\b.*\b50[234]\b/.test(lower) ||
    /(http|status|response)[\s/=:]+50[234]\b.*\b(api|gateway|upstream|litellm)\b/.test(lower) ||
    /\b(api|gateway|upstream|litellm)\b.*(http|status|response)[\s/=:]+50[234]\b/.test(lower);
  const mentionsGithubDiffFetch =
    /failed to fetch diff/.test(lower) ||
    /gh pr diff/.test(lower) ||
    /api\.github\.com\/graphql/.test(lower) ||
    /\bgithub graphql\b/.test(lower);
  const mentionsGithubDiffTransient =
    mentionsGithubDiffFetch &&
    (
      /tls handshake/.test(lower) ||
      /\bnet\/http\b.*\btimeout\b/.test(lower) ||
      /\betimedout\b|\beconnreset\b|\beconnrefused\b|\beai_again\b|\benotfound\b/.test(lower) ||
      /connection (?:reset|refused|timed out|aborted)/.test(lower) ||
      /temporary failure|temporarily unavailable|network is unreachable/.test(lower) ||
      /\bhttp\s*5\d\d\b/.test(lower)
    );
  // These are bucketed into the existing 'cascade' class so they ride the
  // existing backoff path that does NOT consume the per-attempt budget
  // (`row.review_attempts` stays put — see watcher-cascade-resilience.test.mjs
  // "cascade retries must not burn the normal attempt counter").
  const mentionsRoutingTierUnavailable =
    (mentionsApiConnectFailure && mentionsLocalRoutingContext) ||
    mentionsProxyConnectionRefused ||
    mentionsApiSocketHangup ||
    mentionsRoutingTier5xx;
  const mentionsCascade =
    /all upstream attempts failed|upstream[._ -]?failed|cascade/.test(lower) ||
    (/litellm/.test(lower) && /retry|exhaust|timeout|attempts failed|5\d\d\b/.test(lower)) ||
    /timeout.*retries|retries.*timeout/.test(lower) ||
    /(http|status|response)[\s/=:]+5\d\d\b/.test(lower) && /\blitellm\b/.test(lower) ||
    mentionsRoutingTierUnavailable ||
    mentionsGithubDiffTransient;
  const mentionsOauthBroken = lower.split(/\r?\n/).some((line) => (
    /\bnot logged in\b|\blogin required\b/.test(line) ||
    /\boauth token (?:expired|invalid|missing)\b/.test(line) ||
    /\boauth\b.*\b(?:expired|invalid|failed|missing|unauthorized)\b/.test(line) ||
    /\b(?:expired|invalid|failed|missing|unauthorized)\b.*\boauth\b/.test(line) ||
    /\b(?:bearer|refresh|access|auth) token\b.*\b(?:expired|invalid|failed|missing|unauthorized)\b/.test(line) ||
    /\b(?:expired|invalid|failed|missing|unauthorized)\b.*\b(?:bearer|refresh|access|auth) token\b/.test(line) ||
    /\b(?:anthropic|claude|codex|openai)\b.*\bauth(?:entication|orization)?\s+(?:expired|invalid|failed|required)\b/.test(line) ||
    /\bcredentials unavailable\b/.test(line) && /\b(?:oauth|token|anthropic|claude|codex|openai)\b/.test(line)
  ));

  if (launchctlBootstrap) {
    return 'launchctl-bootstrap';
  }

  if (/forbidden fallback|env-strip violation|oauth strip.*violation|api[-_ ]?key fallback/.test(lower)) {
    return 'forbidden-fallback';
  }

  // Provider usage CAP (hard quota) wins over oauth-broken and cascade: a
  // "you've hit your usage limit / try again at <time>" is neither an auth
  // problem (no token to rotate) nor a transient upstream cascade — it is HRR's
  // domain (suspend until the cap clears, then resume), and the operator action
  // is "wait or buy credits", not "rotate the token". Detected for both
  // harnesses (codex / claude). Transient HTTP-429 throttles are intentionally
  // NOT matched here — they keep riding the cascade short-backoff path.
  if (detectQuotaExhaustion(text).isQuotaExhausted) {
    return QUOTA_EXHAUSTED_FAILURE_CLASS;
  }

  // Order matters: OAuth wins over cascade when BOTH match. Cascade is often
  // the symptom of an OAuth failure (LiteLLM retries on 401, declares the
  // pool exhausted) — bucketing as 'cascade' would silence the more
  // actionable oauth-broken alert that prompts an operator to rotate the
  // token. The OAuth regex was tightened in this same PR to require
  // OAuth-adjacent context, so false-positive 'oauth-broken' from benign
  // "Unauthorized" lines is no longer the concern.
  if (mentionsOauthBroken) {
    return 'oauth-broken';
  }

  // Cascade wins over both wall-timeout and progress-timeout markers. Once the
  // run has clear upstream-cascade evidence, operators should treat the timeout
  // text as a symptom of the exhausted upstream path rather than the primary
  // failure bucket.
  if (CASCADE_ERROR_CODES.has(normalizedErrorCode) || (mentionsRateLimit && !mentionsReal429) || mentionsCascade) {
    return 'cascade';
  }

  if (timeoutKilled || mentionsReviewerTimeout) {
    return 'reviewer-timeout';
  }

  if (exitCode === 127 || BUG_ERROR_CODES.has(normalizedErrorCode) || /typeerror|syntaxerror|cannot find/.test(lower)) {
    return 'bug';
  }

  // GitHub's GraphQL mutation refuses to create a second pending review per
  // (user, PR) tuple. A leak from a SIGTERM'd post step earlier makes every
  // subsequent attempt fail with this message. Surface as a distinct class
  // so the watcher's retry path can target the cleanup helper instead of
  // blind-retrying the same broken state. The reviewer.mjs pre-post helper
  // (clearPendingReviewsForSelf) prevents new leaks; this class catches
  // existing-leak recovery on the next attempt.
  if (
    /user can only have one pending review per pull request/.test(lower)
    || /addpullrequestreview.*pending review/.test(lower)
  ) {
    return 'pending-review-leak';
  }

  return 'unknown';
}

export {
  classifyReviewerFailure,
  isReviewerSubprocessTimeout,
};
