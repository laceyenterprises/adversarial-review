// reviewer-broker-refresh.mjs — keep the long-lived watcher's reviewer-bot
// GitHub App installation tokens fresh.
//
// THE BUG THIS FIXES (2026-06-13 SEV: pipeline-wide review outage):
// The watcher resolves GH_{CLAUDE,CODEX,GEMINI}_REVIEWER_TOKEN ONCE at startup
// (scripts/adversarial-watcher-start.sh → scripts/lib/reviewer-broker.sh) and
// then reuses the value for its entire process lifetime — it is inherited by
// every reviewer subprocess via process.env. But GitHub App INSTALLATION tokens
// expire ~1h after issuance, so first-pass reviews start failing the GitHub POST
// with HTTP 401 about an hour after each watcher (re)start, with no self-healing.
// (The follow-up/remediation path already re-resolves per tick because each tick
// is a fresh bash process; the watcher is a single long-lived node process and
// never refreshed.)
//
// THE FIX: re-resolve the broker token on a TTL well under the ~1h expiry and
// write it back into process.env[botTokenEnv] so subsequently-spawned reviewers
// inherit a fresh token. This is a JS-native mirror of the bash
// resolve_reviewer_token_via_broker contract (same /token?provider endpoint,
// same shared-secret bearer, same provider + app_id + installation_id
// verification). Called at the top of every watcher pollOnce tick.
//
// FAIL-SAFE: a transient broker blip must NEVER blank a still-valid token. On
// any error (broker down, non-200, missing/invalid field, metadata mismatch)
// we log and LEAVE process.env[botTokenEnv] untouched, so the existing token
// keeps working until the broker recovers.

import { readFileSync } from 'node:fs';

const DEFAULT_OAUTH_BROKER_URL = 'http://127.0.0.1:4099';

// Refresh when the current token is within this much of its real expiry.
// We key off the broker response's `expires_at` rather than a blind
// since-last-fetch TTL because the broker hands out CACHED installation
// tokens (`"cached": true`) that may already be partway through their ~60 min
// life — observed 2026-06-13: a freshly-fetched token had only ~40 min left.
// A blind TTL would happily hold such a token past its expiry. 15 min of skew
// keeps us comfortably ahead; during the last 15 min we re-check each tick and
// pick up the broker's re-minted token as soon as it rotates.
export const REVIEWER_TOKEN_REFRESH_SKEW_MS = 15 * 60 * 1000;

// Fallback cadence used only when the broker response omits / malforms
// `expires_at` so we can't compute a real expiry. Refresh at least this often.
export const REVIEWER_TOKEN_FALLBACK_TTL_MS = 20 * 60 * 1000;

// Bound the broker fetch so the per-tick refresh can never hang the watcher
// poll loop on a wedged broker. On timeout we fail-safe (keep the old token).
export const REVIEWER_TOKEN_FETCH_TIMEOUT_MS = 5_000;

// The reviewer roles that can be broker-backed. Mirrors the routes in
// watcher.mjs + scripts/adversarial-watcher-start.sh. `envVar` is the
// destination process.env key the reviewer subprocess reads (botTokenEnv);
// `flag` gates broker mode per role.
export const BROKER_REVIEWER_ROLES = Object.freeze([
  { role: 'claude-reviewer', envVar: 'GH_CLAUDE_REVIEWER_TOKEN', flag: 'CLAUDE_REVIEWER_AUTH_VIA_BROKER' },
  { role: 'codex-reviewer', envVar: 'GH_CODEX_REVIEWER_TOKEN', flag: 'CODEX_REVIEWER_AUTH_VIA_BROKER' },
  { role: 'gemini-reviewer', envVar: 'GH_GEMINI_REVIEWER_TOKEN', flag: 'GEMINI_REVIEWER_AUTH_VIA_BROKER' },
]);

function roleUpper(role) {
  return String(role).replace(/-/g, '_').toUpperCase();
}

// Module-level schedule clock, keyed by envVar → the ms timestamp at/after
// which the token should be re-fetched (derived from the broker's expires_at
// minus skew, or a fallback TTL). Exported reset for tests.
const nextRefreshAtMs = new Map();
export function _resetReviewerTokenRefreshClockForTest() {
  nextRefreshAtMs.clear();
}

// Resolve one role's token from the broker. Returns { token, expiresAtMs }
// on success (expiresAtMs is null when the broker omits a parseable
// expires_at), or throws on any failure (caller keeps the old token on throw).
async function fetchReviewerTokenFromBroker({ role, env, fetchImpl, readFileImpl, timeoutMs }) {
  const upper = roleUpper(role);
  const brokerUrl = (env.OAUTH_BROKER_URL || DEFAULT_OAUTH_BROKER_URL).replace(/\/+$/, '');
  const provider = env[`OAUTH_BROKER_${upper}_PROVIDER`] || `github-app-${role}`;
  const expectedAppId = env[`OAUTH_BROKER_${upper}_EXPECTED_APP_ID`] || '';
  const expectedInstallationId = env[`OAUTH_BROKER_${upper}_EXPECTED_INSTALLATION_ID`] || '';
  const secretFile = env.OAUTH_BROKER_SHARED_SECRET_FILE || '';

  if (!secretFile) {
    throw new Error('OAUTH_BROKER_SHARED_SECRET_FILE is empty');
  }
  const secret = String(readFileImpl(secretFile, 'utf8') || '').trim();
  if (!secret) {
    throw new Error(`OAUTH_BROKER_SHARED_SECRET_FILE '${secretFile}' is empty`);
  }

  // Bound the network call so a wedged broker can't hang the watcher tick.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetchImpl(`${brokerUrl}/token?provider=${encodeURIComponent(provider)}`, {
      headers: { Authorization: `Bearer ${secret}`, Accept: 'application/json' },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    throw new Error(`broker returned HTTP ${res.status}`);
  }
  const body = await res.json();
  const accessToken = body?.access_token;
  if (!accessToken || typeof accessToken !== 'string') {
    throw new Error('broker response missing access_token');
  }
  // Same metadata verification as scripts/lib/reviewer-broker.sh: never accept a
  // token minted for the wrong App/installation just because the call returned
  // 200. The bash contract compares provider UNCONDITIONALLY, so a missing /
  // empty provider is a rejection here too (do not guard the check on presence).
  if (String(body?.provider || '') !== provider) {
    throw new Error(`response.provider='${body?.provider ?? ''}' != expected '${provider}'`);
  }
  const actualAppId = body?.metadata?.app_id != null ? String(body.metadata.app_id) : '';
  const actualInstallationId =
    body?.metadata?.installation_id != null ? String(body.metadata.installation_id) : '';
  if (expectedAppId && actualAppId !== expectedAppId) {
    throw new Error(`response.metadata.app_id='${actualAppId}' != expected '${expectedAppId}'`);
  }
  if (expectedInstallationId && actualInstallationId !== expectedInstallationId) {
    throw new Error(
      `response.metadata.installation_id='${actualInstallationId}' != expected '${expectedInstallationId}'`
    );
  }
  const expiresAtMs = body?.expires_at ? Date.parse(body.expires_at) : NaN;
  return { token: accessToken, expiresAtMs: Number.isFinite(expiresAtMs) ? expiresAtMs : null };
}

// Refresh every broker-enabled reviewer token whose cached value is older than
// the TTL, writing fresh tokens back into env (default process.env). Returns a
// small summary for logging/tests. NEVER throws — per-role failures are isolated
// and leave the prior token in place.
export async function refreshReviewerBrokerTokens({
  env = process.env,
  now = Date.now(),
  fetchImpl = globalThis.fetch,
  readFileImpl = readFileSync,
  log = console,
  skewMs = REVIEWER_TOKEN_REFRESH_SKEW_MS,
  fallbackTtlMs = REVIEWER_TOKEN_FALLBACK_TTL_MS,
  timeoutMs = REVIEWER_TOKEN_FETCH_TIMEOUT_MS,
  force = false,
} = {}) {
  const summary = { refreshed: [], skipped: [], failed: [] };
  for (const { role, envVar, flag } of BROKER_REVIEWER_ROLES) {
    if (String(env[flag] || '').trim() !== 'true') {
      summary.skipped.push({ role, reason: 'broker-mode-disabled' });
      continue;
    }
    // Skip only while the token WE last fetched is still comfortably valid.
    // `nextRefreshAtMs` is derived from the broker's expires_at (minus skew),
    // or a fallback TTL when expires_at is absent. The startup token's expiry
    // is unknown to us (no record), so the first sight of a role always
    // re-fetches even though env already holds a value.
    const scheduled = nextRefreshAtMs.get(envVar);
    if (!force && scheduled !== undefined && now < scheduled) {
      summary.skipped.push({ role, reason: 'token-still-valid' });
      continue;
    }
    try {
      const { token, expiresAtMs } = await fetchReviewerTokenFromBroker({
        role,
        env,
        fetchImpl,
        readFileImpl,
        timeoutMs,
      });
      env[envVar] = token;
      // Re-check at (expiry - skew) when we know the real expiry; otherwise fall
      // back to a fixed cadence. Clamp to > now so we always make forward
      // progress even if the token is already inside the skew window.
      const byExpiry = expiresAtMs != null ? expiresAtMs - skewMs : null;
      const byFallback = now + fallbackTtlMs;
      const next = byExpiry != null ? Math.max(byExpiry, now + 1) : byFallback;
      nextRefreshAtMs.set(envVar, next);
      summary.refreshed.push({ role, envVar, expiresAtMs: expiresAtMs ?? null });
    } catch (err) {
      // Fail-safe: keep whatever token env already holds. Do NOT clear it, and
      // do NOT advance the schedule — retry on the next tick.
      summary.failed.push({ role, reason: err?.message || String(err) });
      log?.warn?.(
        `[reviewer-broker-refresh] keeping existing ${envVar}; broker refresh for ${role} failed: ${err?.message || err}`
      );
    }
  }
  return summary;
}
