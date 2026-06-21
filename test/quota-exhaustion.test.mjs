// quota-exhaustion.test.mjs — proves the adversarial-review reviewer path
// recognizes a HARD provider usage cap (HRR's domain) for both harnesses we
// know the shape for (codex / OpenAI and claude-code / Anthropic) and routes it
// to the 'quota-exhausted' failure class so the watcher holds-until-reset
// instead of abandoning the review or burning the infra auto-recover budget.
//
// Why this regression exists: HRR (harness rate-limit resilience) implements
// graceful degradation — suspend on a usage cap, resume when it clears — in the
// DISPATCH lane (the Python daemon). But the reviewer spawns the codex/claude
// CLI directly, outside dispatch, so a hard cap surfaced as a bare
// "Command failed with code 1" without a quota marker was previously classified
// 'unknown' and abandoned with no retry. LAC-1359 now recovers that bare
// command-failed shape through the bounded reviewer-command-failed path, while
// real quota evidence still routes to quota-exhausted so the watcher can hold
// until reset instead of burning the infra auto-recover budget.
// The 2026-06-16 codex weekly-cap outage abandoned every [claude-code] PR review
// this way.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  detectQuotaExhaustion,
  parseQuotaResetAt,
  quotaHoldDecision,
  QUOTA_EXHAUSTED_FAILURE_CLASS,
} from '../src/quota-exhaustion.mjs';
import { classifyReviewerFailure } from '../src/adapters/reviewer-runtime/cli-direct/classification.mjs';
import {
  infraRecoverableFailureClass,
  reviewerFailureClassFromStoredRow,
} from '../src/reviewer-failure-classification.mjs';

// ---------------------------------------------------------------------------
// detectQuotaExhaustion — both harness shapes
// ---------------------------------------------------------------------------

test('codex hard usage cap is detected with harness=codex', () => {
  const stderr = `[reviewer] AI review failed: Command failed with code 1
{"type":"error","message":"You've hit your usage limit. Try again at Jun 17th, 2026 5:39 PM or purchase more credits."}`;
  const result = detectQuotaExhaustion(stderr);
  assert.equal(result.isQuotaExhausted, true);
  assert.equal(result.harness, 'codex');
  assert.ok(result.resetAt, 'expected a parsed reset time');
});

test('claude hard usage cap is detected with harness=claude', () => {
  const stderr = 'Claude usage limit reached. Your 5-hour limit reached; resets at 2026-06-17T17:39:00Z';
  const result = detectQuotaExhaustion(stderr);
  assert.equal(result.isQuotaExhausted, true);
  assert.equal(result.harness, 'claude');
  assert.equal(result.resetAt, '2026-06-17T17:39:00.000Z');
});

test('generic resource_exhausted is detected as a hard cap (harness unknown)', () => {
  const result = detectQuotaExhaustion('Error: RESOURCE_EXHAUSTED: quota exceeded');
  assert.equal(result.isQuotaExhausted, true);
  assert.equal(result.harness, 'unknown');
});

test('transient HTTP-429 throttle is NOT a hard cap (stays on cascade path)', () => {
  // A bare 429 / rate_limit_exceeded must keep riding the cascade short-backoff
  // path, NOT the quota-hold path. detectQuotaExhaustion must ignore it.
  assert.equal(detectQuotaExhaustion('HTTP 429 Too Many Requests').isQuotaExhausted, false);
  assert.equal(detectQuotaExhaustion('rate_limit_exceeded: slow down').isQuotaExhausted, false);
});

test('benign output with no cap marker is not a false positive', () => {
  assert.equal(detectQuotaExhaustion('Review posted successfully').isQuotaExhausted, false);
  assert.equal(detectQuotaExhaustion('').isQuotaExhausted, false);
  assert.equal(detectQuotaExhaustion(null).isQuotaExhausted, false);
});

// ---------------------------------------------------------------------------
// parseQuotaResetAt — both phrasings
// ---------------------------------------------------------------------------

test('parseQuotaResetAt handles the codex human "try again at <Month Day>, <Year> <time>" shape', () => {
  // The provider prints the reset clock-time WITHOUT a timezone, so it denotes
  // the host's local time (that is how the codex CLI renders it). The parser
  // therefore resolves it to the same absolute instant that local-time Date
  // construction yields — verify it round-trips to that instant, rather than
  // asserting a UTC calendar field that flips across the local→UTC offset.
  const iso = parseQuotaResetAt('try again at Jun 17th, 2026 5:39 PM');
  assert.ok(iso, 'expected a parsed ISO string');
  assert.equal(iso, new Date('Jun 17 2026 5:39 PM').toISOString());
  // And the local calendar date is the 17th as the provider stated.
  const d = new Date(iso);
  assert.equal(d.getFullYear(), 2026);
  assert.equal(d.getMonth(), 5); // June (0-indexed), local
  assert.equal(d.getDate(), 17); // local day
});

test('parseQuotaResetAt handles an explicit ISO reset timestamp', () => {
  assert.equal(
    parseQuotaResetAt('resets at 2026-06-17T17:39:00Z'),
    '2026-06-17T17:39:00.000Z'
  );
});

test('parseQuotaResetAt infers the year from nowMs when the provider omits it', () => {
  const nowMs = Date.parse('2026-06-16T12:00:00Z');
  const iso = parseQuotaResetAt('try again at Jun 17th 5:39 PM', { nowMs });
  assert.ok(iso);
  assert.equal(new Date(iso).getUTCFullYear(), 2026);
});

test('parseQuotaResetAt handles Claude clock-only reset times before the local reset', () => {
  const base = new Date(2026, 5, 17, 12, 0, 0, 0);
  const iso = parseQuotaResetAt('Claude usage limit reached; resets at 5:39 PM', {
    nowMs: base.getTime(),
  });
  assert.equal(iso, new Date(2026, 5, 17, 17, 39, 0, 0).toISOString());
});

test('parseQuotaResetAt rolls Claude clock-only reset times to tomorrow when already elapsed', () => {
  const base = new Date(2026, 5, 17, 18, 0, 0, 0);
  const iso = parseQuotaResetAt('Claude usage limit reached; resets at 5:39 PM', {
    nowMs: base.getTime(),
  });
  assert.equal(iso, new Date(2026, 5, 18, 17, 39, 0, 0).toISOString());
});

test('parseQuotaResetAt treats Claude clock-only reset times as host-local wall time', () => {
  const base = new Date(2026, 5, 17, 16, 0, 0, 0);
  const iso = parseQuotaResetAt('Your 5-hour limit reached; resets at 5:39 PM', {
    nowMs: base.getTime(),
  });
  assert.ok(iso);
  const d = new Date(iso);
  assert.equal(d.getFullYear(), 2026);
  assert.equal(d.getMonth(), 5);
  assert.equal(d.getDate(), 17);
  assert.equal(d.getHours(), 17);
  assert.equal(d.getMinutes(), 39);
});

test('parseQuotaResetAt returns null when there is no reset hint', () => {
  assert.equal(parseQuotaResetAt('you are out of credits'), null);
  assert.equal(parseQuotaResetAt(''), null);
});

test('parseQuotaResetAt accepts ISO timestamps with a +HH:MM / -HH:MM offset', () => {
  // Providers commonly emit offset-bearing timestamps; these must parse to the
  // same instant rather than silently falling back to the fixed window.
  assert.equal(parseQuotaResetAt('resets at 2026-06-17T17:39:00-07:00'), '2026-06-18T00:39:00.000Z');
  assert.equal(parseQuotaResetAt('try again at 2026-06-17T17:39:00.000+00:00'), '2026-06-17T17:39:00.000Z');
});

test('quotaHoldDecision does NOT hold forever when the row has no durable anchor', () => {
  // Regression: no reset, no failed_at, no last_attempted_at. Anchoring on `now`
  // each poll would suspend the row forever. It must release to bounded recovery.
  const row = { failure_message: '[quota-exhausted] out of credits' };
  const poll1 = quotaHoldDecision(row, { nowMs: Date.parse('2026-06-17T12:00:00Z') });
  assert.equal(poll1.hold, false);
  assert.equal(poll1.source, 'no-anchor');
  const poll2 = quotaHoldDecision(row, { nowMs: Date.parse('2026-06-17T12:30:00Z') });
  assert.equal(poll2.hold, false);
});

test('quotaHoldDecision releases after the fixed window when anchored on failed_at (two polls)', () => {
  const row = { failure_message: '[quota-exhausted] out of credits', failed_at: '2026-06-17T12:00:00Z' };
  const backoff = 15 * 60 * 1000;
  const during = quotaHoldDecision(row, { nowMs: Date.parse('2026-06-17T12:10:00Z'), fallbackBackoffMs: backoff });
  assert.equal(during.hold, true);
  assert.equal(during.source, 'fallback-window');
  // 20 min after the SAME durable anchor → window cleared → release (anchor does
  // not drift with now).
  const after = quotaHoldDecision(row, { nowMs: Date.parse('2026-06-17T12:20:00Z'), fallbackBackoffMs: backoff });
  assert.equal(after.hold, false);
  assert.equal(after.waitUntilMs, Date.parse('2026-06-17T12:15:00Z'));
});

// ---------------------------------------------------------------------------
// classifier wiring — quota wins over oauth/cascade, transient 429 does not
// ---------------------------------------------------------------------------

test('classifyReviewerFailure routes a codex hard cap to quota-exhausted', () => {
  const stderr = `[reviewer] AI review failed: Command failed with code 1
{"type":"error","message":"You've hit your usage limit. Try again at Jun 17th, 2026 5:39 PM"}`;
  assert.equal(classifyReviewerFailure(stderr, 1), QUOTA_EXHAUSTED_FAILURE_CLASS);
});

test('classifyReviewerFailure routes a claude hard cap to quota-exhausted', () => {
  assert.equal(
    classifyReviewerFailure('Claude usage limit reached; resets at 2026-06-17T17:39:00Z', 1),
    QUOTA_EXHAUSTED_FAILURE_CLASS
  );
});

test('a transient 429 is still classified cascade, not quota-exhausted', () => {
  // mentionsRateLimit && !mentionsReal429 is false here (429 present), so the
  // legacy path treats it as cascade — the important property is that it is NOT
  // quota-exhausted (which would wrongly trigger a long hold).
  const cls = classifyReviewerFailure('API Error 429: rate_limit_exceeded, too many requests', 1);
  assert.notEqual(cls, QUOTA_EXHAUSTED_FAILURE_CLASS);
});

// ---------------------------------------------------------------------------
// recoverability mapping — quota-exhausted is infra-recoverable (bounded)
// ---------------------------------------------------------------------------

test('a stored [quota-exhausted] row is classified recoverable by tag', () => {
  const row = { failure_message: "[quota-exhausted] You've hit your usage limit. Try again at Jun 17th, 2026 5:39 PM" };
  assert.equal(reviewerFailureClassFromStoredRow(row), QUOTA_EXHAUSTED_FAILURE_CLASS);
  assert.equal(infraRecoverableFailureClass(row), QUOTA_EXHAUSTED_FAILURE_CLASS);
});

test('an untagged stored quota row is still recovered via the legacy classifier fallback', () => {
  const row = { failure_message: "You've hit your usage limit. Try again at Jun 17th, 2026 5:39 PM" };
  assert.equal(reviewerFailureClassFromStoredRow(row), QUOTA_EXHAUSTED_FAILURE_CLASS);
});

test('a plain non-command unknown failure is NOT infra-recoverable', () => {
  const row = { failure_message: '[unknown] reviewer emitted an unsupported terminal error' };
  assert.equal(infraRecoverableFailureClass(row), null);
});

// ---------------------------------------------------------------------------
// quotaHoldDecision — the watcher's hold-until-reset gate (pure)
// ---------------------------------------------------------------------------

test('quotaHoldDecision HOLDS before the provider-reported reset elapses', () => {
  const row = {
    failure_message: '[quota-exhausted] try again at 2026-06-17T17:39:00Z',
  };
  const nowMs = Date.parse('2026-06-16T12:00:00Z'); // well before reset
  const d = quotaHoldDecision(row, { nowMs });
  assert.equal(d.hold, true);
  assert.equal(d.source, 'provider-reported');
  assert.equal(d.waitUntilMs, Date.parse('2026-06-17T17:39:00Z'));
});

test('quotaHoldDecision uses Claude clock-only 5-hour caps instead of the fallback window', () => {
  const now = new Date(2026, 5, 17, 12, 39, 0, 0);
  const row = {
    failure_message: '[quota-exhausted] Claude usage limit reached. Your 5-hour limit reached; resets at 5:39 PM',
    failed_at: now.toISOString(),
  };
  const d = quotaHoldDecision(row, {
    nowMs: now.getTime(),
    fallbackBackoffMs: 15 * 60 * 1000,
  });
  assert.equal(d.hold, true);
  assert.equal(d.source, 'provider-reported');
  assert.equal(d.waitUntilMs, new Date(2026, 5, 17, 17, 39, 0, 0).getTime());
});

test('quotaHoldDecision RELEASES once the provider-reported reset has passed', () => {
  const row = {
    failure_message: '[quota-exhausted] try again at 2026-06-17T17:39:00Z',
  };
  const nowMs = Date.parse('2026-06-17T18:00:00Z'); // after reset
  const d = quotaHoldDecision(row, { nowMs });
  assert.equal(d.hold, false);
  assert.equal(d.source, 'provider-reported');
});

test('quotaHoldDecision RELEASES Claude clock-only caps after the observed reset time passes', () => {
  const failedAt = new Date(2026, 5, 17, 12, 39, 0, 0);
  const now = new Date(2026, 5, 17, 18, 0, 0, 0);
  const row = {
    failure_message: '[quota-exhausted] Claude usage limit reached. Your 5-hour limit reached; resets at 5:39 PM',
    failed_at: failedAt.toISOString(),
    last_attempted_at: new Date(2026, 5, 17, 12, 30, 0, 0).toISOString(),
  };
  const d = quotaHoldDecision(row, { nowMs: now.getTime() });
  assert.equal(d.hold, false);
  assert.equal(d.source, 'provider-reported');
  assert.equal(d.waitUntilMs, new Date(2026, 5, 17, 17, 39, 0, 0).getTime());
});

test('quotaHoldDecision anchors Claude clock-only caps to last_attempted_at when failed_at is absent', () => {
  const lastAttemptedAt = new Date(2026, 5, 17, 12, 39, 0, 0);
  const now = new Date(2026, 5, 17, 18, 0, 0, 0);
  const row = {
    failure_message: '[quota-exhausted] Claude usage limit reached. Your 5-hour limit reached; resets at 5:39 PM',
    last_attempted_at: lastAttemptedAt.toISOString(),
  };
  const d = quotaHoldDecision(row, { nowMs: now.getTime() });
  assert.equal(d.hold, false);
  assert.equal(d.source, 'provider-reported');
  assert.equal(d.waitUntilMs, new Date(2026, 5, 17, 17, 39, 0, 0).getTime());
});

test('quotaHoldDecision falls back to a fixed window when no reset is parseable', () => {
  const row = {
    failure_message: '[quota-exhausted] you are out of credits', // no reset hint
    failed_at: '2026-06-16T12:00:00Z',
  };
  const fallbackBackoffMs = 15 * 60 * 1000;
  // 10 minutes after failure → still inside the 15-minute fallback window.
  const holdNow = quotaHoldDecision(row, {
    nowMs: Date.parse('2026-06-16T12:10:00Z'),
    fallbackBackoffMs,
  });
  assert.equal(holdNow.hold, true);
  assert.equal(holdNow.source, 'fallback-window');
  assert.equal(holdNow.waitUntilMs, Date.parse('2026-06-16T12:15:00Z'));
  // 20 minutes after failure → window cleared, recovery may proceed.
  const releaseNow = quotaHoldDecision(row, {
    nowMs: Date.parse('2026-06-16T12:20:00Z'),
    fallbackBackoffMs,
  });
  assert.equal(releaseNow.hold, false);
});

test('quotaHoldDecision does NOT hold when no durable timestamp anchor exists', () => {
  // With no reset and no failed_at/last_attempted_at there is no durable anchor.
  // Anchoring on `now` would recompute now+window every poll and suspend the row
  // forever (the reviewer-flagged bug), so the decision releases to bounded
  // recovery instead of holding.
  const row = { failure_message: '[quota-exhausted] out of credits' };
  const nowMs = Date.parse('2026-06-16T12:00:00Z');
  const d = quotaHoldDecision(row, { nowMs, fallbackBackoffMs: 15 * 60 * 1000 });
  assert.equal(d.hold, false);
  assert.equal(d.source, 'no-anchor');
});
