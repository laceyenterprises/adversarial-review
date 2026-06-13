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

// Refresh tokens older than this. GitHub App installation tokens live ~60 min;
// 30 min gives a comfortable margin against clock skew + tick jitter without
// hammering the broker every (sub-minute) tick.
export const REVIEWER_TOKEN_REFRESH_TTL_MS = 30 * 60 * 1000;

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

// Module-level last-refresh clock, keyed by envVar. Exported reset for tests.
const lastRefreshAtMs = new Map();
export function _resetReviewerTokenRefreshClockForTest() {
  lastRefreshAtMs.clear();
}

// Resolve one role's token from the broker. Returns the access token string on
// success, or throws on any failure (caller keeps the old token on throw).
async function fetchReviewerTokenFromBroker({ role, env, fetchImpl, readFileImpl }) {
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

  const res = await fetchImpl(`${brokerUrl}/token?provider=${encodeURIComponent(provider)}`, {
    headers: { Authorization: `Bearer ${secret}`, Accept: 'application/json' },
  });
  if (!res.ok) {
    throw new Error(`broker returned HTTP ${res.status}`);
  }
  const body = await res.json();
  const accessToken = body?.access_token;
  if (!accessToken || typeof accessToken !== 'string') {
    throw new Error('broker response missing access_token');
  }
  // Same metadata verification as scripts/lib/reviewer-broker.sh: never accept a
  // token minted for the wrong App/installation just because the call returned 200.
  if (body?.provider && body.provider !== provider) {
    throw new Error(`response.provider='${body.provider}' != expected '${provider}'`);
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
  return accessToken;
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
  ttlMs = REVIEWER_TOKEN_REFRESH_TTL_MS,
  force = false,
} = {}) {
  const summary = { refreshed: [], skipped: [], failed: [] };
  for (const { role, envVar, flag } of BROKER_REVIEWER_ROLES) {
    if (String(env[flag] || '').trim() !== 'true') {
      summary.skipped.push({ role, reason: 'broker-mode-disabled' });
      continue;
    }
    // Only skip when WE have refreshed this token recently. The startup token's
    // age is unknown (it may already be near its ~1h expiry), so the first sight
    // of a role always re-fetches even though env already holds a value.
    const hasLast = lastRefreshAtMs.has(envVar);
    const last = lastRefreshAtMs.get(envVar) || 0;
    if (!force && hasLast && now - last < ttlMs) {
      summary.skipped.push({ role, reason: 'within-ttl' });
      continue;
    }
    try {
      const token = await fetchReviewerTokenFromBroker({ role, env, fetchImpl, readFileImpl });
      env[envVar] = token;
      lastRefreshAtMs.set(envVar, now);
      summary.refreshed.push({ role, envVar });
    } catch (err) {
      // Fail-safe: keep whatever token env already holds. Do NOT clear it.
      summary.failed.push({ role, reason: err?.message || String(err) });
      log?.warn?.(
        `[reviewer-broker-refresh] keeping existing ${envVar}; broker refresh for ${role} failed: ${err?.message || err}`
      );
    }
  }
  return summary;
}
