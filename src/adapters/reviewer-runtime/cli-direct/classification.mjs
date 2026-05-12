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
  const oauthWindow = lower.split(/\r?\n/).slice(-6).join('\n');
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
  const mentionsOauthBroken =
    /\boauth\b/.test(oauthWindow) ||
    /\bnot logged in\b|login required/.test(oauthWindow) ||
    /auth(?:entication|orization)?\s+(?:expired|invalid|failed)/.test(oauthWindow) ||
    /unauthorized.*oauth|oauth.*unauthorized/.test(oauthWindow) ||
    /credentials unavailable/.test(oauthWindow);

  if (launchctlBootstrap) {
    return 'launchctl-bootstrap';
  }

  if (/forbidden fallback|env-strip violation|oauth strip.*violation|api[-_ ]?key fallback/.test(lower)) {
    return 'forbidden-fallback';
  }

  if (CASCADE_ERROR_CODES.has(normalizedErrorCode) || (mentionsRateLimit && !mentionsReal429) || mentionsCascade) {
    return 'cascade';
  }

  if (mentionsOauthBroken) {
    return 'oauth-broken';
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
