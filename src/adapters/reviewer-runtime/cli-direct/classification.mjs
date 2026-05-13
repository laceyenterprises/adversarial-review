const BUG_ERROR_CODES = new Set(['ENOENT', 'EACCES', 'EPERM']);
const CASCADE_ERROR_CODES = new Set(['ETIMEDOUT']);
const REVIEWER_TIMEOUT_MESSAGE_RE = /command timed out after \d+ms/;
const LAUNCHCTL_BOOTSTRAP_ERROR_RE =
  /bootstrap failed|could not find domain|input\/output error|not privileged to set domain/;

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
  const mentionsReviewerTimeout = REVIEWER_TIMEOUT_MESSAGE_RE.test(lower);
  const launchctlBootstrap = lower.split(/\r?\n/).some((line) => (
    /launchctlsessionerror|claude launchctl session bootstrap failed/.test(line) ||
    (/launchctl/.test(line) && LAUNCHCTL_BOOTSTRAP_ERROR_RE.test(line))
  ));
  const mentionsReal429 =
    /\b429\b|too many requests|http\s*429|rate_limit_exceeded|ratelimiterror|quota/.test(lower);
  const mentionsRateLimit = /rate.?limit/.test(lower);
  const mentionsCascade =
    /all upstream attempts failed|upstream[._ -]?failed|cascade/.test(lower) ||
    (/litellm/.test(lower) && /retry|exhaust|timeout|attempts failed|5\d\d\b/.test(lower)) ||
    /timeout.*retries|retries.*timeout/.test(lower) ||
    /(http|status|response)[\s/=:]+5\d\d\b/.test(lower);
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

  if (CASCADE_ERROR_CODES.has(normalizedErrorCode) || (mentionsRateLimit && !mentionsReal429) || mentionsCascade) {
    return 'cascade';
  }

  if (timeoutKilled || mentionsReviewerTimeout) {
    return 'reviewer-timeout';
  }

  if (exitCode === 127 || BUG_ERROR_CODES.has(normalizedErrorCode) || /typeerror|syntaxerror|cannot find/.test(lower)) {
    return 'bug';
  }

  return 'unknown';
}

export {
  classifyReviewerFailure,
  isReviewerSubprocessTimeout,
};
