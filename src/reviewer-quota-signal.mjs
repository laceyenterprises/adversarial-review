// Reset-aware parsing of reviewer quota-exhaustion harness responses.
//
// Two distinct exhaustion shapes reach the reviewer, and historically BOTH threw
// away the reset time — so the pipeline could neither fall back gracefully nor
// re-enable the reviewer when quota returned (a quota-dead third reviewer just
// exhausted its infra-retry cap and ORPHANED the PR at review_status='failed'):
//
//   1. CQP broker `/checkout` no-credit response (CLI runtime). The broker
//      tracks a weekly window and, when it knows one, returns a reset timestamp
//      (reset_at / retry_at / available_at, sometimes nested under `error`).
//      The old path read only `reason` and threw
//      GeminiCredentialPoolNoCreditError with no reset attached.
//   2. Antigravity (agy) RESOURCE_EXHAUSTED / HTTP 429. The Gemini API attaches
//      a google.rpc.RetryInfo detail with `retryDelay` (e.g. "39s") and/or the
//      reset shows up in the 429 text. The old path used a coarse boolean
//      (looksLikeGeminiQuotaError) and discarded the delay.
//
// This module normalizes both into a single reset-aware signal:
//   { exhausted, resetAt, retryAfterMs, source }
// so callers can (a) fall back to the primary cross-model reviewer instead of
// orphaning, and (b) skip the exhausted reviewer until `resetAt`.

const QUOTA_HTTP_429_TEXT_RE = /\b(?:status|code|error|http)\s*[:=]?\s*429\b/i;
const QUOTA_TEXT_RE = new RegExp(
  String.raw`\b(?:` +
    String.raw`(?:status|code|error|http)\s*[:=]?\s*429` +
    String.raw`|resource[_ -]?exhausted` +
    String.raw`|quota[_ -]?(?:exhausted|exceeded|reached|depleted)` +
    String.raw`|(?:quota|usage)\s+limit\s+(?:exhausted|exceeded|reached)` +
    String.raw`|rate ?limit\s+(?:exceeded|reached)` +
    String.raw`|no[_ -]?credit` +
    String.raw`)\b`,
  'i',
);

const RESET_KEYS = [
  'reset_at',
  'resetAt',
  'retry_at',
  'retryAt',
  'available_at',
  'availableAt',
  'quota_reset_at',
  'quotaResetAt',
  'resetTime',
];

const RETRY_DELAY_KEYS = [
  'retry_delay',
  'retryDelay',
  'retry_after',
  'retryAfter',
];

const RETRY_MS_KEYS = ['retry_after_ms', 'retryAfterMs', 'retryDelayMs'];
const ANSI_ESCAPE_RE = /\u001b\[[0-?]*[ -/]*[@-~]/g;

function stripAnsi(text) {
  return String(text || '').replace(ANSI_ESCAPE_RE, '');
}

function isRetryScalar(value) {
  return typeof value === 'string' || typeof value === 'number';
}

// Parse a duration into milliseconds. Accepts Google/HTTP shapes:
//   "39s" -> 39000, "500ms" -> 500, "2m" -> 120000, "1.5s" -> 1500,
//   bare number -> SECONDS (HTTP Retry-After / RetryInfo convention).
const DURATION_UNIT_RE = '(?:milliseconds?|ms|seconds?|s|minutes?|m|hours?|h)';

export function parseDurationToMs(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 0 ? Math.round(value * 1000) : null; // bare number = seconds
  }
  if (typeof value !== 'string') return null;
  const raw = String(value).trim();
  if (!raw) return null;
  const m = raw.match(new RegExp(`^([0-9]*\\.?[0-9]+)\\s*(${DURATION_UNIT_RE})?$`, 'i'));
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = (m[2] || 's').toLowerCase();
  const mult = unit === 'ms' || unit.startsWith('millisecond')
    ? 1
    : unit === 's' || unit.startsWith('second')
      ? 1000
      : unit === 'm' || unit.startsWith('minute')
        ? 60000
        : 3600000;
  return Math.round(n * mult);
}

function toIsoTimestamp(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Heuristic: seconds vs milliseconds since epoch.
    const ms = value < 1e12 ? value * 1000 : value;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  const raw = String(value).trim();
  if (!raw) return null;
  if (/^\d+$/.test(raw)) {
    const n = Number(raw);
    if (Number.isFinite(n)) {
      const ms = n < 1e12 ? n * 1000 : n;
      const d = new Date(ms);
      return Number.isNaN(d.getTime()) ? null : d.toISOString();
    }
  }
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function timestampFromDelay(nowMs, retryAfterMs) {
  const resetMs = nowMs + retryAfterMs;
  if (!Number.isFinite(resetMs)) return null;
  const d = new Date(resetMs);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function candidateObjects(inputs) {
  const out = [];
  const seen = new Set();
  const push = (obj) => {
    if (obj && typeof obj === 'object' && !seen.has(obj)) {
      seen.add(obj);
      out.push(obj);
      return true;
    }
    return false;
  };
  const visit = (obj, depth = 0) => {
    if (!push(obj) || depth >= 4) return;
    for (const key of ['error', 'body', 'data', 'response']) {
      visit(obj?.[key], depth + 1);
    }
    // Google RPC status details array (RetryInfo lives here).
    if (Array.isArray(obj?.details)) obj.details.forEach((detail) => visit(detail, depth + 1));
  };
  for (const obj of inputs) {
    visit(obj);
  }
  return out;
}

function firstResetTimestamp(inputs) {
  for (const obj of candidateObjects(inputs)) {
    for (const key of RESET_KEYS) {
      if (obj[key] !== undefined && obj[key] !== null && obj[key] !== '') {
        const iso = toIsoTimestamp(obj[key]);
        if (iso) return iso;
      }
    }
  }
  return null;
}

function firstRetryDelayMs(inputs) {
  for (const obj of candidateObjects(inputs)) {
    for (const key of RETRY_MS_KEYS) {
      if (obj[key] !== undefined && obj[key] !== null && obj[key] !== '') {
        if (!isRetryScalar(obj[key])) continue;
        const n = Number(obj[key]);
        if (Number.isFinite(n) && n > 0) return Math.round(n);
      }
    }
    for (const key of RETRY_DELAY_KEYS) {
      if (obj[key] !== undefined && obj[key] !== null && obj[key] !== '') {
        if (!isRetryScalar(obj[key])) continue;
        const ms = parseDurationToMs(obj[key]);
        if (ms !== null) return ms;
      }
    }
  }
  return null;
}

// Pull a retryDelay out of raw 429 text, e.g. `"retryDelay": "39s"` or
// `Retry-After: 42`. Text is the last resort when structured fields are absent.
function retryDelayMsFromText(text, nowMs = Date.now()) {
  if (!text) return null;
  const normalized = stripAnsi(text);
  const jsonish = normalized.match(
    new RegExp(
      `retry[_-]?delay["'\\s:]+["']?([0-9]*\\.?[0-9]+\\s*(?:${DURATION_UNIT_RE}\\b)?)(?![a-z])`,
      'i',
    ),
  );
  if (jsonish) {
    const ms = parseDurationToMs(jsonish[1]);
    if (ms !== null) return ms;
  }
  const header = normalized.match(/retry[- ]?after["'\s:]+["']?([^\r\n]+)/i);
  if (header) {
    const raw = String(header[1] || '').trim().replace(/^['"]|['"]$/g, '');
    const ms = parseDurationToMs(raw);
    if (ms !== null) return ms;
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) {
      const delta = parsed - nowMs;
      if (Number.isFinite(delta) && delta > 0) return delta;
    }
  }
  return null;
}

function bodyLooksNoCredit(body) {
  const values = [
    body?.type,
    body?.status,
    body?.code,
    body?.reason,
    body?.message,
    body?.error,
    body?.error?.type,
    body?.error?.code,
    body?.error?.reason,
    body?.error?.status,
    body?.error?.message,
  ].map((value) => String(value ?? '').trim().toLowerCase());
  return values.some(
    (v) =>
      v === 'no-credit' ||
      v === 'no_credit' ||
      v === 'quota-exhausted' ||
      v === 'resource_exhausted' ||
      v === '429' ||
      v.includes('no-credit') ||
      v.includes('quota'),
  );
}

/**
 * Normalize a reviewer quota-exhaustion signal from any of the harness shapes.
 *
 * @returns {{exhausted: boolean, resetAt: string|null, retryAfterMs: number|null, source: string|null}}
 *   `resetAt` is an ISO-8601 UTC timestamp when known (explicit broker/API reset,
 *   or now + retryAfterMs). `source` is 'cqp-broker' | 'antigravity-429' | 'text'.
 */
export function parseReviewerQuotaExhaustion({
  error = null,
  stdout: _stdout = '',
  stderr = '',
  brokerBody = null,
  nowMs = Date.now(),
} = {}) {
  const diagnosticText = stripAnsi([
    typeof error === 'string' ? error : null,
    error?.message,
    error?.stderr,
    stderr,
  ]
    .filter(Boolean)
    .join('\n'));
  const hasBrokerBody = brokerBody && typeof brokerBody === 'object';
  const inputs = [brokerBody, error].filter(Boolean);
  const structuredQuota = candidateObjects(inputs).some(bodyLooksNoCredit);

  const exhausted = Boolean(
    error?.isGeminiCredentialPoolNoCredit ||
      structuredQuota ||
      QUOTA_TEXT_RE.test(diagnosticText),
  );
  if (!exhausted) {
    return { exhausted: false, resetAt: null, retryAfterMs: null, source: null };
  }

  let resetAt = firstResetTimestamp(inputs);
  let retryAfterMs = firstRetryDelayMs(inputs);

  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  if (retryAfterMs === null) retryAfterMs = retryDelayMsFromText(diagnosticText, now);
  if (resetAt === null && retryAfterMs !== null) {
    resetAt = timestampFromDelay(now, retryAfterMs);
  }
  if (retryAfterMs === null && resetAt !== null) {
    const delta = Date.parse(resetAt) - now;
    if (Number.isFinite(delta) && delta > 0) retryAfterMs = delta;
  }

  let source;
  if (hasBrokerBody && bodyLooksNoCredit(brokerBody)) source = 'cqp-broker';
  else if (/resource[_ -]?exhausted|retry[_-]?delay/i.test(diagnosticText) || QUOTA_HTTP_429_TEXT_RE.test(diagnosticText))
    source = 'antigravity-429';
  else source = 'text';

  return { exhausted: true, resetAt, retryAfterMs, source };
}

/**
 * Decide how to handle a quota-exhausted reviewer. The core resilience rule:
 * NEVER orphan a PR because a (third / assigned) reviewer is quota-dead — fall
 * back to the primary cross-model reviewer, and remember to skip the exhausted
 * reviewer until `resetAt`.
 *
 * @returns {{fallbackToPrimary: boolean, skipReviewerUntil: string|null, reason: string}}
 */
export function quotaFallbackDecision({
  signal = null,
  primaryReviewerAvailable = true,
} = {}) {
  if (!signal?.exhausted) {
    return {
      fallbackToPrimary: false,
      skipReviewerUntil: null,
      reason: 'not-exhausted',
    };
  }
  const skipReviewerUntil = signal.resetAt || null;
  if (primaryReviewerAvailable) {
    return {
      fallbackToPrimary: true,
      skipReviewerUntil,
      reason: 'reviewer-quota-exhausted-fallback-to-primary',
    };
  }
  return {
    fallbackToPrimary: false,
    skipReviewerUntil,
    reason: 'reviewer-quota-exhausted-no-primary-available',
  };
}
