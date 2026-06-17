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

function _matches(text, patterns) {
  return patterns.some((re) => re.test(text));
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
  const iso = t.match(/(?:try again at|resets? at)\s+(\d{4}-\d{2}-\d{2}T[\d:.]+Z?)/i);
  if (iso) {
    const d = new Date(iso[1]);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  // "try again at Jun 17th, 2026 5:39 PM" — strip the ordinal suffix Date can't parse.
  const human = t.match(/(?:try again at|resets? at)\s+([A-Za-z]{3,9}\s+\d{1,2})(?:st|nd|rd|th)?(,?\s+\d{4})?\s+(\d{1,2}:\d{2}\s*(?:am|pm))/i);
  if (human) {
    const base = nowMs != null ? new Date(nowMs) : null;
    const year = human[2] ? human[2].replace(/[,\s]/g, '') : (base ? String(base.getUTCFullYear()) : '');
    const candidate = `${human[1]} ${year} ${human[3]}`.replace(/\s+/g, ' ').trim();
    const d = new Date(candidate);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
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

// Decide whether a quota-exhausted reviewed_prs row should be HELD (skipped
// without consuming an infra auto-recover attempt) because the provider's cap
// window has not yet elapsed. Pure function over the stored row so the watcher's
// inline gate stays trivially testable.
//
//   row.failure_message  — carries the `[quota-exhausted] …try again at <time>…`
//                          text the reset is parsed from.
//   row.failed_at        — when the cap was last observed (fallback-window base).
//   row.last_attempted_at — secondary fallback base if failed_at is absent.
//
// Returns { hold, waitUntilMs, source } where source is 'provider-reported'
// (reset parsed from the message) or 'fallback-window' (fixed backoff since the
// last failure). When neither a reset nor a usable timestamp is available, the
// window is anchored at nowMs so the first observation always holds once before
// recovery is attempted.
function quotaHoldDecision(row, { nowMs = null, fallbackBackoffMs = DEFAULT_QUOTA_BACKOFF_MS } = {}) {
  const now = nowMs == null ? Date.now() : nowMs;
  const resetIso = parseQuotaResetAt(row?.failure_message, { nowMs: now });
  const resetMs = resetIso ? Date.parse(resetIso) : NaN;
  if (!Number.isNaN(resetMs)) {
    return { hold: now < resetMs, waitUntilMs: resetMs, source: 'provider-reported' };
  }
  const lastFailureMs = Date.parse(row?.failed_at || row?.last_attempted_at || '');
  const base = Number.isNaN(lastFailureMs) ? now : lastFailureMs;
  const waitUntilMs = base + fallbackBackoffMs;
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
  quotaHoldDecision,
};
