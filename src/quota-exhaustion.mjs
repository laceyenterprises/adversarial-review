// Shared provider-quota-exhaustion detection for adversarial-review worker
// classes (reviewers today; reusable by any in-module path that spawns a
// native harness CLI directly and so bypasses the dispatch daemon's HRR
// quota suspend/resume).
//
// Why this exists: HRR (harness rate-limit resilience) implements graceful
// degradation — suspend on a provider usage cap, resume when it clears — in the
// DISPATCH lane (the Python daemon: quota probe + LRQ suspend/resume). But the
// adversarial-review reviewer runs the codex/claude CLI DIRECTLY, outside
// dispatch, so it never saw HRR. When the provider returns a hard usage cap the
// reviewer exited non-zero and the watcher classified it `unknown` →
// "not infrastructure-recoverable" → the review was abandoned with no retry.
//
// This module recognizes the HARD usage-cap shape for the two harnesses we know
// (codex / OpenAI and claude-code / Anthropic) and, when present, parses the
// reset time the provider hands back so callers can suspend until then instead
// of hammering the cap or giving up. It deliberately does NOT match transient
// HTTP-429 throttles (those ride the existing short-backoff rate-limit path);
// only the sustained "you are out of quota until <time>" caps.

// Hard usage-cap markers. Both harnesses surface a human string plus, usually,
// a reset hint. Kept narrow so a transient 429 or an unrelated "limit" mention
// does not fold in.
const CODEX_QUOTA_PATTERNS = [
  /hit your usage limit/i,
  /you'?ve reached your usage limit/i,
  /purchase more credits/i,
  /out of credits/i,
];

const CLAUDE_QUOTA_PATTERNS = [
  /hit your weekly limit/i,
  /weekly limit.*resets/i,
  /usage limit reached/i,
  /reached your usage limit/i,
  /claude usage limit/i,
  /\b\d+\s*-?\s*hour limit reached/i, // claude-code 5-hour rolling cap
  /insufficient credits/i,
];

// Shared / provider-agnostic hard-cap markers.
const GENERIC_QUOTA_PATTERNS = [
  /resource_exhausted/i,
  /\bquota (?:exceeded|exhausted)\b/i,
  /\bplan_limit\b/i,
];

const CODEX_HUMAN_RESET_TIME_ZONE = 'America/Los_Angeles';
const MONTH_INDEX_BY_PREFIX = new Map([
  ['jan', 0],
  ['feb', 1],
  ['mar', 2],
  ['apr', 3],
  ['may', 4],
  ['jun', 5],
  ['jul', 6],
  ['aug', 7],
  ['sep', 8],
  ['oct', 9],
  ['nov', 10],
  ['dec', 11],
]);

function _matches(text, patterns) {
  return patterns.some((re) => re.test(text));
}

function timeZoneOffsetMs(timeZone, utcMs) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(utcMs));
  const values = Object.fromEntries(parts.filter((p) => p.type !== 'literal').map((p) => [p.type, p.value]));
  const wallAsUtcMs = Date.UTC(
    Number(values.year),
    Number(values.month) - 1,
    Number(values.day),
    Number(values.hour),
    Number(values.minute),
    Number(values.second),
    0
  );
  return wallAsUtcMs - utcMs;
}

function wallTimeInZoneToDate({ year, month, day, hour, minute }, timeZone) {
  const wallAsUtcMs = Date.UTC(year, month, day, hour, minute, 0, 0);
  let offsetMs = timeZoneOffsetMs(timeZone, wallAsUtcMs);
  let utcMs = wallAsUtcMs - offsetMs;
  const refinedOffsetMs = timeZoneOffsetMs(timeZone, utcMs);
  if (refinedOffsetMs !== offsetMs) utcMs = wallAsUtcMs - refinedOffsetMs;
  const d = new Date(utcMs);
  return Number.isNaN(d.getTime()) ? null : d;
}

// Parse the reset time the provider returns, if any. Returns an ISO-8601 string
// (UTC) or null. Handles the two known phrasings:
//   codex:  "try again at Jun 17th, 2026 5:39 PM"
//   claude: "resets at 5:39 PM" / "resets at 2026-06-17T17:39:00Z"
// A missing/unparseable reset is not fatal — callers fall back to a fixed
// quota backoff. `nowMs` is injectable for deterministic tests.
function parseQuotaResetAt(text, { nowMs = null } = {}) {
  const t = String(text || '');
  // Prefer an explicit ISO timestamp if the provider gave one.
  const iso = t.match(/(?:try again at\s+|resets?\s+(?:at\s+)?)(\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)/i);
  if (iso) {
    const d = new Date(iso[1]);
    if (d && !Number.isNaN(d.getTime())) return d.toISOString();
  }
  // "try again at Jun 17th, 2026 5:39 PM" — strip the ordinal suffix Date can't parse.
  const human = t.match(/(?:try again at\s+|resets?\s+(?:at\s+)?)([A-Za-z]{3,9}\s+\d{1,2})(?:st|nd|rd|th)?(,?\s+\d{4})?(?:\s+at)?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)(?:\s*\(([A-Za-z_/-]+)\))?/i);
  if (human) {
    const base = nowMs != null ? new Date(nowMs) : null;
    const explicitYear = Boolean(human[2]);
    let year = explicitYear ? human[2].replace(/[,\s]/g, '') : (base ? String(base.getUTCFullYear()) : '');
    const dateParts = human[1].match(/^([A-Za-z]{3,9})\s+(\d{1,2})$/);
    const month = MONTH_INDEX_BY_PREFIX.get(String(dateParts?.[1] || '').slice(0, 3).toLowerCase());
    const day = Number(dateParts?.[2]);
    let hour = Number(human[3]);
    const minute = human[4] == null ? 0 : Number(human[4]);
    const meridiem = String(human[5] || '').toLowerCase();
    const timeZone = human[6] || CODEX_HUMAN_RESET_TIME_ZONE;
    if (hour === 12) hour = 0;
    if (meridiem === 'pm') hour += 12;
    let d = Number.isInteger(month) && year && day >= 1 && day <= 31 && hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59
      ? wallTimeInZoneToDate({
        year: Number(year),
        month,
        day,
        hour,
        minute,
      }, timeZone)
      : null;
    if (d && base && !explicitYear && d.getTime() <= base.getTime()) {
      year = String(Number(year) + 1);
      d = wallTimeInZoneToDate({
        year: Number(year),
        month,
        day,
        hour,
        minute,
      }, timeZone);
    }
    if (d && !Number.isNaN(d.getTime())) return d.toISOString();
  }
  // Claude often prints only a local clock time for rolling caps:
  // "resets at 5:39 PM". Anchor that to today's local date, then roll forward
  // one day if that wall-clock time has already elapsed.
  const clockOnly = t.match(/resets? at\s+(\d{1,2}):(\d{2})\s*(am|pm)\b/i);
  if (clockOnly) {
    const base = nowMs != null ? new Date(nowMs) : new Date();
    let hour = Number(clockOnly[1]);
    const minute = Number(clockOnly[2]);
    const meridiem = clockOnly[3].toLowerCase();
    if (hour >= 1 && hour <= 12 && minute >= 0 && minute <= 59) {
      if (hour === 12) hour = 0;
      if (meridiem === 'pm') hour += 12;
      const d = new Date(
        base.getFullYear(),
        base.getMonth(),
        base.getDate(),
        hour,
        minute,
        0,
        0
      );
      if (d.getTime() <= base.getTime()) d.setDate(d.getDate() + 1);
      return d.toISOString();
    }
  }
  return null;
}

// Detect a hard provider usage cap in arbitrary reviewer/worker output.
// Returns { isQuotaExhausted, harness, resetAt } where harness is
// 'codex' | 'claude' | 'unknown' and resetAt is an ISO string or null.
function detectQuotaExhaustion(text, { nowMs = null } = {}) {
  const t = String(text || '');
  if (!t) return { isQuotaExhausted: false, harness: null, resetAt: null };
  const codex = _matches(t, CODEX_QUOTA_PATTERNS);
  const claude = _matches(t, CLAUDE_QUOTA_PATTERNS);
  const generic = _matches(t, GENERIC_QUOTA_PATTERNS);
  if (!codex && !claude && !generic) {
    return { isQuotaExhausted: false, harness: null, resetAt: null };
  }
  const harness = codex ? 'codex' : claude ? 'claude' : 'unknown';
  return {
    isQuotaExhausted: true,
    harness,
    resetAt: parseQuotaResetAt(t, { nowMs }),
  };
}

// The reviewer failure-class string + the durable failure_message tag used by
// reviewer-failure-classification.mjs and the watcher recovery gate.
const QUOTA_EXHAUSTED_FAILURE_CLASS = 'quota-exhausted';

// Default hold window when the provider gives no parseable reset time.
const DEFAULT_QUOTA_BACKOFF_MS = 15 * 60 * 1000;

// Capture the provider usage-cap reset time at the failure-recording point, for
// durable storage in reviewed_prs.quota_reset_at_utc. Runs `parseQuotaResetAt`
// over the FULL reviewer output (stdout + stderr, before it is truncated into
// the terse failure_message) so the "try again at <time>" line is not lost.
// Returns an ISO-8601 UTC string or null. `nowMs` anchors year/date inference
// for the human/clock-only phrasings; pass the failure timestamp.
function resolveQuotaResetIso(fullOutput, { nowMs = null } = {}) {
  return parseQuotaResetAt(fullOutput, { nowMs });
}

// Decide whether a quota-exhausted reviewed_prs row should be HELD (skipped
// without consuming an infra auto-recover attempt) because the provider's cap
// window has not yet elapsed. Pure function over the stored row so the watcher's
// inline gate stays trivially testable.
//
//   row.quota_reset_at_utc — durably-captured provider reset (PREFERRED source;
//                          set at failure-recording time from the full output,
//                          before failure_message truncation can drop it).
//   row.failure_message  — carries the `[quota-exhausted] …try again at <time>…`
//                          text the reset is RE-derived from as a fallback when
//                          the durable column is absent.
//   row.failed_at        — when the cap was last observed (fallback-window base).
//   row.last_attempted_at — secondary fallback base if failed_at is absent.
//
// Returns { hold, waitUntilMs, source } where source is 'provider-reported-stored'
// (durable column), 'provider-reported' (re-parsed from the message), or
// 'fallback-window' (fixed backoff since the last failure). When neither a reset
// nor a usable timestamp is available, the window is anchored at nowMs so the
// first observation always holds once before recovery is attempted.
function quotaHoldDecision(row, { nowMs = null, fallbackBackoffMs = DEFAULT_QUOTA_BACKOFF_MS } = {}) {
  const now = nowMs == null ? Date.now() : nowMs;
  const lastFailureMs = Date.parse(row?.failed_at || row?.last_attempted_at || '');
  const hasAnchor = !Number.isNaN(lastFailureMs);
  const observationMs = hasAnchor ? lastFailureMs : now;
  // Prefer the durable, captured-at-failure reset over re-parsing the terse
  // failure_message (which may have truncated the "try again at" line away).
  const storedResetMs = Date.parse(row?.quota_reset_at_utc || '');
  if (!Number.isNaN(storedResetMs)) {
    return { hold: now < storedResetMs, waitUntilMs: storedResetMs, source: 'provider-reported-stored' };
  }
  const resetIso = parseQuotaResetAt(row?.failure_message, { nowMs: observationMs });
  const resetMs = resetIso ? Date.parse(resetIso) : NaN;
  if (!Number.isNaN(resetMs)) {
    return { hold: now < resetMs, waitUntilMs: resetMs, source: 'provider-reported' };
  }
  // No parseable provider reset. Fall back to a fixed window anchored on the
  // DURABLE failure timestamp (failed_at / last_attempted_at). When NO durable
  // anchor exists, do NOT hold: anchoring on `now` would recompute now+window on
  // every poll and suspend the row forever (nothing persists `now` before the
  // watcher continues). A `failed` row always carries failed_at in practice, so
  // this guards the pathological no-timestamp case — release it to bounded
  // recovery (capped by INFRA_AUTO_RECOVER_CAP) so a recoverable quota outage
  // resumes and operators see exhaustion rather than a permanent hang.
  if (!hasAnchor) {
    return { hold: false, waitUntilMs: now, source: 'no-anchor' };
  }
  const waitUntilMs = lastFailureMs + fallbackBackoffMs;
  return { hold: now < waitUntilMs, waitUntilMs, source: 'fallback-window' };
}

export {
  CODEX_QUOTA_PATTERNS,
  CLAUDE_QUOTA_PATTERNS,
  GENERIC_QUOTA_PATTERNS,
  QUOTA_EXHAUSTED_FAILURE_CLASS,
  DEFAULT_QUOTA_BACKOFF_MS,
  detectQuotaExhaustion,
  parseQuotaResetAt,
  resolveQuotaResetIso,
  quotaHoldDecision,
};
