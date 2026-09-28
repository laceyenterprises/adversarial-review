// token-refresh-hold.mjs — a `token-refresh-pending` refusal is a HOLD, not a
// failed review attempt (TOKDZ-01).
//
// THE BUG THIS FIXES (SEV3 2026-09-28, agent-os #7309): the Claude reviewer
// refuses to hand a broker token to its subprocess when the token will not
// outlive the reviewer's maximum timeout. That refusal says nothing about the
// PR -- it only means the keychain bridge has not rotated the grant yet -- but
// the watcher settled it like any other transient failure:
//
//   - every refusal charged `infra_auto_recover_attempts`, and the fourth one
//     wrote the row to terminal `failed` (#7286 sat at 2/3 on the day of the
//     SEV, one refusal from being stranded);
//   - the per-model exec fallback re-routed the PR away from Claude after two
//     refusals, about three minutes in, long before any rotation could land.
//
// A hold instead:
//
//   - never charges `review_attempts` or `infra_auto_recover_attempts`, and
//     never goes terminal;
//   - parks the PR until the next expected rotation. The refusal carries the
//     token's remaining life, and the bridge rotates when fewer than
//     `refresh_window_seconds` remain, so the rotation instant is computable;
//   - is bounded. A hold that outlives `maxHoldMs` (the bridge is late or the
//     rotation is further out than the bound) re-routes the PR to another
//     reviewer through the normal model-fallback path.
//
// Pure helpers only: the settle path and route selection own the writes.

export const TOKEN_REFRESH_HOLD_MAX_MINUTES_ENV = 'ADVERSARIAL_REVIEW_TOKEN_REFRESH_HOLD_MAX_MINUTES';
export const CLAUDE_BRIDGE_REFRESH_WINDOW_SECONDS_ENV = 'ADVERSARIAL_REVIEW_CLAUDE_BRIDGE_REFRESH_WINDOW_SECONDS';

// One full bridge refresh window. If a rotation has not landed within the
// window the bridge itself is supposed to refresh in, it is late, and the PR is
// better served by another reviewer than by waiting on it.
export const DEFAULT_TOKEN_REFRESH_HOLD_MAX_MINUTES = 30;
// Mirrors the keychain bridge's `/statusz` `refresh_window_seconds` (1800 when
// TOKDZ-01 landed). Operator-tunable so a bridge reconfiguration does not need a
// code change here; nothing in this module ever talks to the bridge.
export const DEFAULT_CLAUDE_BRIDGE_REFRESH_WINDOW_SECONDS = 1800;
// Wait this long past the expected rotation before retrying, so the retry lands
// on the new grant instead of racing the bridge's refresh.
export const TOKEN_REFRESH_ROTATION_GRACE_MS = 60 * 1000;
// A hold whose last refusal is older than `maxHoldMs` plus this slack no longer
// describes the token. The slack must exceed the longest gap between two
// refusals of one live hold -- the hold itself (<= maxHoldMs), or the 15-minute
// cascade backoff plateau, plus watcher tick latency -- or a hold would expire
// between its own retries and restart instead of reaching its bound.
export const TOKEN_REFRESH_HOLD_STALE_SLACK_MS = 60 * 60 * 1000;

function positiveNumber(raw, fallback) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function resolveTokenRefreshHoldConfig(env = process.env) {
  return {
    maxHoldMs: positiveNumber(env?.[TOKEN_REFRESH_HOLD_MAX_MINUTES_ENV], DEFAULT_TOKEN_REFRESH_HOLD_MAX_MINUTES) * 60_000,
    bridgeRefreshWindowMs: positiveNumber(
      env?.[CLAUDE_BRIDGE_REFRESH_WINDOW_SECONDS_ENV],
      DEFAULT_CLAUDE_BRIDGE_REFRESH_WINDOW_SECONDS,
    ) * 1000,
  };
}

// Read the refusal the reviewer printed:
//   [token-refresh-pending] broker Claude reviewer token expires too soon for
//   subprocess handoff: remaining=4994933ms minimum=10919571ms
//   expires_at=2026-09-28T20:54:30Z
// `expires_at` is absolute and preferred; `remaining` is relative to the
// refusal, which happened moments before settle. Returns null when the text
// carries neither, so an unparseable refusal still holds on the backoff floor.
export function parseTokenRefreshRefusal(text) {
  const raw = String(text || '');
  const remainingMatch = raw.match(/\bremaining=(-?\d+)ms\b/);
  const minimumMatch = raw.match(/\bminimum=(\d+)ms\b/);
  const expiresMatch = raw.match(/\bexpires_at=(\S+?)(?=[\s)]|$)/);
  const expiresAtMs = expiresMatch ? Date.parse(expiresMatch[1]) : NaN;
  const remainingMs = remainingMatch ? Number(remainingMatch[1]) : null;
  if (!Number.isFinite(expiresAtMs) && remainingMs === null) return null;
  return {
    remainingMs,
    minimumMs: minimumMatch ? Number(minimumMatch[1]) : null,
    expiresAtMs: Number.isFinite(expiresAtMs) ? expiresAtMs : null,
  };
}

function toIso(ms) {
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

// The next hold, carried forward from `previousHold` when it belongs to the
// same reviewer model and is still live. `floorMs` is the ordinary cascade
// backoff expiry: the hold never re-checks faster than that, even when the
// rotation is already overdue, so a late bridge cannot turn into a tight loop.
export function computeTokenRefreshHold({
  previousHold = null,
  failureAtMs,
  floorMs,
  refusal = null,
  reviewerModel = 'claude',
  config = resolveTokenRefreshHoldConfig(),
} = {}) {
  const model = String(reviewerModel || 'claude').trim().toLowerCase();
  const previousStartMs = Date.parse(previousHold?.startedAt || '');
  const previousLastMs = Date.parse(previousHold?.lastRefusalAt || '');
  const continuing = previousHold
    && String(previousHold.reviewerModel || '').toLowerCase() === model
    && Number.isFinite(previousStartMs)
    && Number.isFinite(previousLastMs)
    && failureAtMs - previousLastMs <= config.maxHoldMs + TOKEN_REFRESH_HOLD_STALE_SLACK_MS;
  const startedAtMs = continuing ? previousStartMs : failureAtMs;
  const maxHoldUntilMs = startedAtMs + config.maxHoldMs;
  let expectedRotationMs = null;
  if (refusal?.expiresAtMs != null) {
    expectedRotationMs = refusal.expiresAtMs - config.bridgeRefreshWindowMs;
  } else if (refusal?.remainingMs != null) {
    expectedRotationMs = failureAtMs + refusal.remainingMs - config.bridgeRefreshWindowMs;
  }
  const target = expectedRotationMs === null
    ? floorMs
    : Math.min(expectedRotationMs + TOKEN_REFRESH_ROTATION_GRACE_MS, maxHoldUntilMs);
  const holdUntilMs = Math.max(floorMs, target);
  return {
    reviewerModel: model,
    startedAt: toIso(startedAtMs),
    lastRefusalAt: toIso(failureAtMs),
    refusals: (continuing ? Number(previousHold.refusals || 0) : 0) + 1,
    expectedRotationAt: toIso(expectedRotationMs),
    holdUntil: toIso(holdUntilMs),
    maxHoldUntil: toIso(maxHoldUntilMs),
    maxHoldMs: config.maxHoldMs,
  };
}

// Whether route selection should stop waiting on `reviewerModel` and re-route.
// A stale hold (see TOKEN_REFRESH_HOLD_STALE_SLACK_MS: the PR sat idle for some
// other reason) no longer says anything about the token, so it never forces a
// re-route on its own.
export function tokenRefreshHoldExhausted(hold, {
  reviewerModel,
  nowMs = Date.now(),
  config = resolveTokenRefreshHoldConfig(),
} = {}) {
  if (!hold || typeof hold !== 'object') return false;
  const model = String(reviewerModel || '').trim().toLowerCase();
  if (!model || String(hold.reviewerModel || '').toLowerCase() !== model) return false;
  const maxHoldUntilMs = Date.parse(hold.maxHoldUntil || '');
  const lastRefusalMs = Date.parse(hold.lastRefusalAt || '');
  if (!Number.isFinite(maxHoldUntilMs) || !Number.isFinite(lastRefusalMs)) return false;
  if (nowMs - lastRefusalMs > config.maxHoldMs + TOKEN_REFRESH_HOLD_STALE_SLACK_MS) return false;
  return nowMs >= maxHoldUntilMs;
}
