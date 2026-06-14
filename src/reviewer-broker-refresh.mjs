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
import { resolveReviewerTimeoutMs } from './reviewer-timeout.mjs';

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

// A reviewer subprocess snapshots process.env at spawn and may run until the
// hard reviewer timeout before posting to GitHub. Only hand off tokens that can
// survive that runtime plus a little post slack.
export const REVIEWER_TOKEN_POST_SLACK_MS = 2 * 60 * 1000;

// When the broker returns a cached token that is too short-lived for reviewer
// handoff, do not hammer the broker on every watcher tick while the prior token
// remains usable. Retry soon, but bounded.
export const REVIEWER_TOKEN_FAILURE_RETRY_MS = 60 * 1000;

// The reviewer roles that can be broker-backed. Mirrors the routes in
// watcher.mjs + scripts/adversarial-watcher-start.sh. `envVar` is the
// destination process.env key the reviewer subprocess reads (botTokenEnv);
// `flag` gates broker mode per role.
export const BROKER_REVIEWER_ROLES = Object.freeze([
  { role: 'claude-reviewer', envVar: 'GH_CLAUDE_REVIEWER_TOKEN', flag: 'CLAUDE_REVIEWER_AUTH_VIA_BROKER' },
  { role: 'codex-reviewer', envVar: 'GH_CODEX_REVIEWER_TOKEN', flag: 'CODEX_REVIEWER_AUTH_VIA_BROKER' },
  { role: 'gemini-reviewer', envVar: 'GH_GEMINI_REVIEWER_TOKEN', flag: 'GEMINI_REVIEWER_AUTH_VIA_BROKER' },
]);

const REVIEWER_ROLE_BY_IDENTITY = Object.freeze({
  'claude-reviewer': 'claude-reviewer',
  'claude-reviewer-lacey': 'claude-reviewer',
  'codex-reviewer': 'codex-reviewer',
  'codex-reviewer-lacey': 'codex-reviewer',
  'gemini-reviewer': 'gemini-reviewer',
  'gemini-reviewer-lacey': 'gemini-reviewer',
  GH_CLAUDE_REVIEWER_TOKEN: 'claude-reviewer',
  GH_CODEX_REVIEWER_TOKEN: 'codex-reviewer',
  GH_GEMINI_REVIEWER_TOKEN: 'gemini-reviewer',
});

function roleUpper(role) {
  return String(role).replace(/-/g, '_').toUpperCase();
}

function resolveReviewerBrokerRole(identity) {
  const raw = String(identity || '').trim();
  if (!raw) return null;
  return REVIEWER_ROLE_BY_IDENTITY[raw] || REVIEWER_ROLE_BY_IDENTITY[raw.toLowerCase()] || null;
}

function brokerRoleConfig(role) {
  return BROKER_REVIEWER_ROLES.find((entry) => entry.role === role) || null;
}

// Resolve an operator-tunable millisecond knob from env. A present value must
// parse to a finite, strictly-positive number; anything else (missing, blank,
// non-numeric, <= 0) falls back to the built-in default so a typo can never
// disable the bound or hand out a zero-lifetime token.
function resolvePositiveMsEnv(rawValue, fallbackMs) {
  if (rawValue === undefined || rawValue === null || String(rawValue).trim() === '') {
    return fallbackMs;
  }
  const parsed = Number(rawValue);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallbackMs;
}

// Module-level schedule clock, keyed by envVar → { nextRefreshAtMs,
// configFingerprint, expiresAtMs, failureRetryUntilMs? }. nextRefreshAtMs is
// derived from the broker's expires_at minus skew, or a fallback TTL. The
// fingerprint forces an immediate re-fetch when operator-controlled broker
// routing/identity settings rotate. Exported reset for tests.
const refreshClock = new Map();
export function _resetReviewerTokenRefreshClockForTest() {
  refreshClock.clear();
}

class ReviewerTokenTooShortError extends Error {}

function reviewerTokenHandoffState({ role, envVar, env, now, requiredLifetimeMs }) {
  const base = { role, envVar };
  if (!env?.[envVar]) {
    return { ...base, safe: false, reason: 'token-missing' };
  }
  const scheduled = refreshClock.get(envVar);
  if (scheduled === undefined) {
    return { ...base, safe: false, reason: 'token-expiry-untracked' };
  }
  const expiresAtMs = scheduled.expiresAtMs ?? null;
  if (expiresAtMs == null) {
    return { ...base, safe: false, reason: 'token-expiry-unknown' };
  }
  const remainingMs = expiresAtMs - now;
  if (remainingMs > requiredLifetimeMs) {
    return {
      ...base,
      safe: true,
      reason: 'token-handoff-safe',
      expiresAtMs,
      remainingMs,
      requiredLifetimeMs,
    };
  }
  return {
    ...base,
    safe: false,
    reason: 'token-below-handoff-floor',
    expiresAtMs,
    remainingMs,
    requiredLifetimeMs,
  };
}

function recordReviewerTokenHandoffState(summary, opts) {
  const state = reviewerTokenHandoffState(opts);
  summary.handoffSafe.push(state);
  return state;
}

function brokerConfigForRole({ role, env, flag }) {
  const upper = roleUpper(role);
  const brokerUrl = (env.OAUTH_BROKER_URL || DEFAULT_OAUTH_BROKER_URL).replace(/\/+$/, '');
  const provider = env[`OAUTH_BROKER_${upper}_PROVIDER`] || `github-app-${role}`;
  const expectedAppId = env[`OAUTH_BROKER_${upper}_EXPECTED_APP_ID`] || '';
  const expectedInstallationId = env[`OAUTH_BROKER_${upper}_EXPECTED_INSTALLATION_ID`] || '';
  const secretFile = env.OAUTH_BROKER_SHARED_SECRET_FILE || '';
  return {
    brokerUrl,
    provider,
    expectedAppId,
    expectedInstallationId,
    secretFile,
    flagValue: flag ? String(env[flag] || '').trim() : '',
  };
}

function brokerConfigFingerprint(config) {
  return JSON.stringify([
    config.brokerUrl,
    config.provider,
    config.expectedAppId,
    config.expectedInstallationId,
    config.secretFile,
    config.flagValue,
  ]);
}

// Resolve one role's token from the broker. Returns { token, expiresAtMs }
// on success (expiresAtMs is null when the broker omits a parseable
// expires_at), or throws on any failure (caller keeps the old token on throw).
async function fetchReviewerTokenFromBroker({ role, env, fetchImpl, readFileImpl, timeoutMs }) {
  const config = brokerConfigForRole({ role, env, flag: '' });
  const { brokerUrl, provider, expectedAppId, expectedInstallationId, secretFile } = config;

  if (!secretFile) {
    throw new Error('OAUTH_BROKER_SHARED_SECRET_FILE is empty');
  }
  const secret = String(readFileImpl(secretFile, 'utf8') || '').trim();
  if (!secret) {
    throw new Error(`OAUTH_BROKER_SHARED_SECRET_FILE '${secretFile}' is empty`);
  }

  // Bound the WHOLE network exchange so a wedged broker can't hang the watcher
  // tick. The timeout/abort must cover both the headers (fetchImpl) AND the body
  // read (res.json()): in Fetch, the response promise resolves once headers
  // arrive while the body may still be streaming, so a broker that sends `200`
  // headers and then stalls the JSON body would otherwise hang inside res.json()
  // — past clearTimeout — and wedge the long-lived daemon. We keep the abort
  // timer armed until AFTER the body is fully parsed; the shared AbortSignal
  // makes the timer abort a stalled body read too.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${brokerUrl}/token?provider=${encodeURIComponent(provider)}`, {
      headers: { Authorization: `Bearer ${secret}`, Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`broker returned HTTP ${res.status}`);
    }
    const body = await res.json();
    const accessToken = body?.access_token;
    if (!accessToken || typeof accessToken !== 'string') {
      throw new Error('broker response missing access_token');
    }
    // Same metadata verification as scripts/lib/reviewer-broker.sh: never accept
    // a token minted for the wrong App/installation just because the call
    // returned 200. The bash contract compares provider UNCONDITIONALLY, so a
    // missing / empty provider is a rejection here too (don't guard on presence).
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
  } finally {
    clearTimeout(timer);
  }
}

export async function resolveReviewerAppToken(identity, {
  env = process.env,
  fetchImpl = globalThis.fetch,
  readFileImpl = readFileSync,
  timeoutMs = REVIEWER_TOKEN_FETCH_TIMEOUT_MS,
} = {}) {
  const role = resolveReviewerBrokerRole(identity);
  if (!role) {
    throw new Error(`Unknown reviewer identity '${identity ?? ''}'`);
  }
  const roleConfig = brokerRoleConfig(role);
  if (!roleConfig) {
    throw new Error(`Reviewer broker role '${role}' is not configured`);
  }
  const { token, expiresAtMs } = await fetchReviewerTokenFromBroker({
    role,
    env,
    fetchImpl,
    readFileImpl,
    timeoutMs,
  });
  env[roleConfig.envVar] = token;
  return {
    role,
    envVar: roleConfig.envVar,
    token,
    expiresAtMs,
  };
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
  timeoutMs = null,
  postSlackMs = null,
  minTokenLifetimeMs = null,
  failureRetryMs = null,
  force = false,
} = {}) {
  // Operator-tunable knobs (documented in
  // docs/SPEC-adversarial-review-auto-remediation.md). Explicit function args
  // win (tests); otherwise resolve + validate from env so the documented
  // process.env contract is actually honored, falling back to the constants.
  const effectiveTimeoutMs =
    timeoutMs ?? resolvePositiveMsEnv(env.REVIEWER_TOKEN_FETCH_TIMEOUT_MS, REVIEWER_TOKEN_FETCH_TIMEOUT_MS);
  const effectivePostSlackMs =
    postSlackMs ?? resolvePositiveMsEnv(env.REVIEWER_TOKEN_POST_SLACK_MS, REVIEWER_TOKEN_POST_SLACK_MS);
  const effectiveFailureRetryMs =
    failureRetryMs ?? resolvePositiveMsEnv(env.REVIEWER_TOKEN_FAILURE_RETRY_MS, REVIEWER_TOKEN_FAILURE_RETRY_MS);
  const summary = { refreshed: [], skipped: [], failed: [], handoffSafe: [] };
  for (const { role, envVar, flag } of BROKER_REVIEWER_ROLES) {
    const configFingerprint = brokerConfigFingerprint(brokerConfigForRole({ role, env, flag }));
    if (String(env[flag] || '').trim() !== 'true') {
      summary.skipped.push({ role, reason: 'broker-mode-disabled' });
      continue;
    }
    let requiredLifetimeMs;
    try {
      requiredLifetimeMs =
        minTokenLifetimeMs ?? resolveReviewerTimeoutMs(env) + effectivePostSlackMs;
    } catch (err) {
      summary.failed.push({ role, reason: err?.message || String(err) });
      summary.handoffSafe.push({
        role,
        envVar,
        safe: false,
        reason: 'handoff-floor-config-invalid',
      });
      log?.warn?.(
        `[reviewer-broker-refresh] keeping existing ${envVar}; reviewer lifetime config for ${role} failed: ${err?.message || err}`
      );
      continue;
    }
    // Skip only while the token WE last fetched is still comfortably valid.
    // `nextRefreshAtMs` is derived from the broker's expires_at (minus skew),
    // or a fallback TTL when expires_at is absent. The startup token's expiry
    // is unknown to us (no record), so the first sight of a role always
    // re-fetches even though env already holds a value.
    const scheduled = refreshClock.get(envVar);
    if (
      !force
      && scheduled !== undefined
      && scheduled.configFingerprint === configFingerprint
    ) {
      if (scheduled.failureRetryUntilMs != null && now < scheduled.failureRetryUntilMs) {
        const existingExpiresAtMs = scheduled.expiresAtMs ?? null;
        if (existingExpiresAtMs == null || existingExpiresAtMs - now > requiredLifetimeMs) {
          summary.skipped.push({ role, reason: 'broker-refresh-backoff' });
          recordReviewerTokenHandoffState(summary, { role, envVar, env, now, requiredLifetimeMs });
          continue;
        }
      }
      if (now < scheduled.nextRefreshAtMs) {
        summary.skipped.push({ role, reason: 'token-still-valid' });
        recordReviewerTokenHandoffState(summary, { role, envVar, env, now, requiredLifetimeMs });
        continue;
      }
    }
    try {
      const { token, expiresAtMs } = await fetchReviewerTokenFromBroker({
        role,
        env,
        fetchImpl,
        readFileImpl,
        timeoutMs: effectiveTimeoutMs,
      });
      if (expiresAtMs != null && expiresAtMs - now <= requiredLifetimeMs) {
        throw new ReviewerTokenTooShortError(
          `broker token expires too soon for subprocess handoff: remaining=${expiresAtMs - now}ms minimum=${requiredLifetimeMs}ms`
        );
      }
      env[envVar] = token;
      // Re-fetch before the token crosses EITHER the refresh skew OR the
      // subprocess-handoff minimum lifetime — whichever comes first. Using only
      // (expiry - skew) left a window where now < expiry - skew (treated as
      // "token-still-valid") but expiry - now <= requiredLifetimeMs, during which
      // a newly-spawned reviewer could inherit a token too short to survive its
      // run and post — the very HTTP 401 this module prevents. With the defaults
      // (skew 15m, required ~22m) the required-lifetime bound is the earlier one.
      // Clamp to > now so we always make forward progress.
      const refreshLeadMs = Math.max(skewMs, requiredLifetimeMs);
      const byExpiry = expiresAtMs != null ? expiresAtMs - refreshLeadMs : null;
      const byFallback = now + fallbackTtlMs;
      const next = byExpiry != null ? Math.max(byExpiry, now + 1) : byFallback;
      refreshClock.set(envVar, {
        nextRefreshAtMs: next,
        configFingerprint,
        expiresAtMs: expiresAtMs ?? null,
      });
      summary.refreshed.push({ role, envVar, expiresAtMs: expiresAtMs ?? null });
      recordReviewerTokenHandoffState(summary, { role, envVar, env, now, requiredLifetimeMs });
    } catch (err) {
      // Fail-safe: keep whatever token env already holds. Do NOT clear it, and
      // only apply a short backoff for too-short broker tokens while the prior
      // token remains outside the hard handoff floor. Other broker failures
      // still retry next tick.
      if (err instanceof ReviewerTokenTooShortError) {
        const current = refreshClock.get(envVar);
        const currentExpiresAtMs = current?.expiresAtMs ?? null;
        const currentTooClose =
          currentExpiresAtMs != null && currentExpiresAtMs - now <= requiredLifetimeMs;
        if (!force && !currentTooClose) {
          const retryAt = now + effectiveFailureRetryMs;
          refreshClock.set(envVar, {
            nextRefreshAtMs: retryAt,
            configFingerprint,
            expiresAtMs: currentExpiresAtMs,
            failureRetryUntilMs: retryAt,
          });
        }
      }
      summary.failed.push({ role, reason: err?.message || String(err) });
      recordReviewerTokenHandoffState(summary, { role, envVar, env, now, requiredLifetimeMs });
      log?.warn?.(
        `[reviewer-broker-refresh] keeping existing ${envVar}; broker refresh for ${role} failed: ${err?.message || err}`
      );
    }
  }
  return summary;
}

// ── Watcher's OWN GitHub token ───────────────────────────────────────────────
//
// The watcher's poll-loop octokit AND its AMA-eligibility `gh` CLI calls
// historically authenticated as the operator PAT (`gh auth token` →
// clio-airlock), a single shared 5000/hr REST budget. Under a PR surge that
// exhausts, the poll loop logs `API rate limit already exceeded` and PRs sit
// unreviewed. A GitHub App installation token has its own ~15000/hr budget,
// isolated from the operator PAT — so route the watcher's token through the same
// broker the reviewers use, refreshed per-tick. FAIL-SAFE: a broker blip leaves
// the existing token (PAT or still-valid App token) untouched.
//
// Both env vars are set: GITHUB_TOKEN (the poll octokit) and GH_TOKEN (the `gh`
// CLI, which prefers GH_TOKEN). The role is operator-tunable; default reuses the
// existing merge-agent App. A dedicated `github-app-adversarial-watcher` App is
// the cleaner long-term (operator out-of-band: create App + install + broker
// PEM + provider) — point WATCHER_GH_BROKER_ROLE at it once provisioned.
export const WATCHER_GH_TOKEN_ENV_VARS = Object.freeze(['GITHUB_TOKEN', 'GH_TOKEN']);
export const WATCHER_GH_AUTH_FLAG = 'WATCHER_GH_AUTH_VIA_BROKER';
export const DEFAULT_WATCHER_GH_BROKER_ROLE = 'merge-agent';

export function resolveWatcherGhBrokerRole(env = process.env) {
  const raw = String(env.WATCHER_GH_BROKER_ROLE || '').trim();
  return raw || DEFAULT_WATCHER_GH_BROKER_ROLE;
}

export async function refreshWatcherGithubToken({
  env = process.env,
  now = Date.now(),
  fetchImpl = globalThis.fetch,
  readFileImpl = readFileSync,
  log = console,
  skewMs = REVIEWER_TOKEN_REFRESH_SKEW_MS,
  fallbackTtlMs = REVIEWER_TOKEN_FALLBACK_TTL_MS,
  timeoutMs = null,
  force = false,
} = {}) {
  const summary = { refreshed: false, skipped: null, failed: null, role: null };
  // Default-OFF at the flag layer so enabling is an explicit, auditable switch;
  // the start script sets the flag true with a PAT fallback, so the live watcher
  // gets the fix while a disabled/rolled-back deployment keeps the prior behavior.
  if (String(env[WATCHER_GH_AUTH_FLAG] || '').trim() !== 'true') {
    summary.skipped = 'broker-mode-disabled';
    return summary;
  }
  const role = resolveWatcherGhBrokerRole(env);
  summary.role = role;
  // Distinct clock key namespace so the watcher token's schedule never collides
  // with a reviewer role that happens to share the same App role string.
  const clockKey = `__watcher_gh__:${role}`;
  const configFingerprint = brokerConfigFingerprint(
    brokerConfigForRole({ role, env, flag: WATCHER_GH_AUTH_FLAG })
  );
  const scheduled = refreshClock.get(clockKey);
  if (
    !force
    && scheduled !== undefined
    && scheduled.configFingerprint === configFingerprint
    && now < scheduled.nextRefreshAtMs
  ) {
    summary.skipped = 'token-still-valid';
    return summary;
  }
  const effectiveTimeoutMs =
    timeoutMs ?? resolvePositiveMsEnv(env.REVIEWER_TOKEN_FETCH_TIMEOUT_MS, REVIEWER_TOKEN_FETCH_TIMEOUT_MS);
  try {
    const { token, expiresAtMs } = await fetchReviewerTokenFromBroker({
      role,
      env,
      fetchImpl,
      readFileImpl,
      timeoutMs: effectiveTimeoutMs,
    });
    // No subprocess-handoff floor here: unlike reviewer tokens (inherited by a
    // spawned subprocess that must survive its whole run), the watcher consumes
    // its own token directly and re-checks every tick, so a short token is fine.
    for (const envVar of WATCHER_GH_TOKEN_ENV_VARS) {
      env[envVar] = token;
    }
    const byExpiry = expiresAtMs != null ? expiresAtMs - skewMs : null;
    const next = byExpiry != null ? Math.max(byExpiry, now + 1) : now + fallbackTtlMs;
    refreshClock.set(clockKey, {
      nextRefreshAtMs: next,
      configFingerprint,
      expiresAtMs: expiresAtMs ?? null,
    });
    summary.refreshed = true;
    log?.log?.(
      `[reviewer-broker-refresh] watcher GITHUB_TOKEN/GH_TOKEN refreshed via broker (role=${role}; expires_at=${expiresAtMs ? new Date(expiresAtMs).toISOString() : 'unknown'})`
    );
  } catch (err) {
    // FAIL-SAFE: keep whatever token env already holds (the PAT, or a still-valid
    // App token). Short backoff so a wedged broker doesn't hammer every tick.
    summary.failed = err?.message || String(err);
    const retryAt = now + resolvePositiveMsEnv(env.REVIEWER_TOKEN_FAILURE_RETRY_MS, REVIEWER_TOKEN_FAILURE_RETRY_MS);
    refreshClock.set(clockKey, {
      nextRefreshAtMs: retryAt,
      configFingerprint,
      expiresAtMs: scheduled?.expiresAtMs ?? null,
    });
    log?.warn?.(
      `[reviewer-broker-refresh] keeping existing watcher GITHUB_TOKEN; broker fetch for role ${role} failed: ${summary.failed}`
    );
  }
  return summary;
}
