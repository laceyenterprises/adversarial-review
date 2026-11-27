import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { buildBrokerAdapterEnv, resolveGitHubAdapterBin } from './github-adapter-client.mjs';
import { githubOwnerTokens, recordGithubToken } from './github-owner-token.mjs';
import { loadAwareTimeoutMs } from './load-aware-timeout.mjs';
import { registerGitHubInstallationToken } from './rate-limit-throttle.mjs';
import { grokReviewerLaneEnabled } from './grok-reviewer-lane.mjs';
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
// Both watcher and follow-up are long-lived Node processes. Their startup
// wrappers seed broker tokens once; this module refreshes those credentials in
// process before later ticks spawn workers or make GitHub calls.
//
// THE FIX: re-resolve the broker token on a TTL well under the ~1h expiry and
// write it back into process.env[botTokenEnv] so subsequently-spawned reviewers
// inherit a fresh token. The GitHub adapter verifies the role and repository.
//
// FAIL-SAFE: a transient broker blip must NEVER blank a still-valid token. On
// any error (broker down, non-200, missing/invalid field, metadata mismatch)
// we log and LEAVE process.env[botTokenEnv] untouched, so the existing token
// keeps working until the broker recovers.
//
// FRESHEST WINS (REVTOKENFLOOR-01): a reviewer subprocess receives the freshest
// valid token the broker can give. The handoff floor decides when to refresh
// early and whether a handoff is safe. It never keeps an older held token in
// place of a fetched one that expires later.

import { readFileSync } from 'node:fs';
import { resolveNominalReviewerTimeoutMs, resolveReviewerTimeoutMs } from './reviewer-timeout.mjs';

const exec = promisify(execFile);
function configuredServiceRepo() {
  const { org, repos } = JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
  return org ? `${org}/adversarial-review` : repos?.[0];
}

// Refresh when the current token is within this much of its real expiry.
// We key off the broker response's `expires_at` rather than a blind
// since-last-fetch TTL because the broker hands out CACHED installation
// tokens (`"cached": true`) that may already be partway through their ~60 min
// life — observed 2026-06-13: a freshly-fetched token had only ~40 min left.
// A blind TTL would happily hold such a token past its expiry. 15 min of skew
// keeps us comfortably ahead; inside the refresh window a short retry interval
// bounds how often we check for the broker's re-minted token.
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

// GitHub App installation tokens live at most 60 minutes. The handoff floor
// assumes a full-lifetime token when the broker omits expires_at.
export const REVIEWER_TOKEN_PROVIDER_LIFETIME_MS = 60 * 60 * 1000;

export const FOLLOW_UP_GH_TOKEN_ENV_VARS = Object.freeze(['GITHUB_TOKEN', 'GH_TOKEN']);
export const DEFAULT_FOLLOW_UP_GH_BROKER_ROLE = 'merge-agent';

// The reviewer roles that can be broker-backed. Mirrors the routes in
// watcher.mjs + scripts/adversarial-watcher-start.sh. `envVar` is the
// destination process.env key the reviewer subprocess reads (botTokenEnv);
// `flag` gates broker mode per role.
export const BROKER_REVIEWER_ROLES = Object.freeze([
  { role: 'claude-reviewer', envVar: 'GH_CLAUDE_REVIEWER_TOKEN', flag: 'CLAUDE_REVIEWER_AUTH_VIA_BROKER' },
  { role: 'codex-reviewer', envVar: 'GH_CODEX_REVIEWER_TOKEN', flag: 'CODEX_REVIEWER_AUTH_VIA_BROKER' },
  { role: 'gemini-reviewer', envVar: 'GH_GEMINI_REVIEWER_TOKEN', flag: 'GEMINI_REVIEWER_AUTH_VIA_BROKER' },
  { role: 'grok-reviewer', envVar: 'GH_GROK_REVIEWER_TOKEN', flag: 'GROK_REVIEWER_AUTH_VIA_BROKER' },
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
  'grok-reviewer': 'grok-reviewer',
  'grok-reviewer-lacey': 'grok-reviewer',
  'lacey-grok-reviewer': 'grok-reviewer',
  GH_GROK_REVIEWER_TOKEN: 'grok-reviewer',
});

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
// Roles already warned about broker-mode-disabled, so the warning is loud once
// per process instead of once per tick.
const warnedBrokerModeDisabled = new Set();
const warnedLaneDisabled = new Set();
// envVars whose installed token is shorter than a load-scaled reviewer run.
// Logged once per episode; the entry clears when a token covers the run again.
const warnedHandoffShortfall = new Set();
export function _resetReviewerTokenRefreshClockForTest() {
  refreshClock.clear();
  warnedBrokerModeDisabled.clear();
  warnedLaneDisabled.clear();
  warnedHandoffShortfall.clear();
}

class ReviewerTokenNotFresherError extends Error {}
class BrokerTokenFetchError extends Error {
  // `check` names the failed client-side check without token material.
  constructor(message, { transient = false, check = 'mint' } = {}) {
    super(message);
    this.name = 'BrokerTokenFetchError';
    this.transient = transient;
    this.check = check;
  }
}

// REVTOKENFLOOR-01. The floor is the reviewer run time plus post slack. Under
// host load that run time scales past anything the provider can mint: a 6x
// multiplier on a 20 min timeout asks for a 122 min token from a 60 min
// provider. Every fresh token then read as too short and the older held token
// was kept until it expired. Cap the load-scaled excess at what the provider
// delivered: the fetched token's lifetime minus the refresh skew. The nominal
// floor is never lowered, so an idle host keeps its existing floor.
function cappedHandoffFloorMs({ nominalMs, loadScaledMs }, observedLifetimeMs, skewMs) {
  const deliverableMs = (observedLifetimeMs ?? REVIEWER_TOKEN_PROVIDER_LIFETIME_MS) - skewMs;
  return Math.min(loadScaledMs, Math.max(nominalMs, deliverableMs));
}

function reviewerTokenHandoffState({
  role,
  envVar,
  env,
  now,
  requiredLifetimeMs,
  loadScaledLifetimeMs = requiredLifetimeMs,
}) {
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
  const lifetimes = {
    expiresAtMs,
    remainingMs,
    requiredLifetimeMs,
    loadScaledLifetimeMs,
    // How far a load-scaled reviewer run may outlive this token. The reviewer
    // re-resolves its token from the broker before its GitHub side calls.
    handoffShortfallMs: Math.max(0, loadScaledLifetimeMs - remainingMs),
  };
  if (remainingMs > requiredLifetimeMs) {
    return { ...base, safe: true, reason: 'token-handoff-safe', ...lifetimes };
  }
  return { ...base, safe: false, reason: 'token-below-handoff-floor', ...lifetimes };
}

function recordReviewerTokenHandoffState(summary, opts) {
  const state = reviewerTokenHandoffState(opts);
  summary.handoffSafe.push(state);
  return state;
}

function brokerConfigFingerprint(env, flag) {
  return JSON.stringify([resolveGitHubAdapterBin({ env }), env.AGENT_OS_CONFIG_PATH,
    env.OAUTH_BROKER_URL, env.OAUTH_BROKER_URL_FALLBACK,
    env.OAUTH_BROKER_SHARED_SECRET_FILE, env[flag]]);
}

// The adapter allows 10s per HTTP attempt. One attempt per URL reserves time
// for the standby instead of spending the parent budget retrying the primary.
export function brokerTokenTimeoutMs(env, perUrlMs = REVIEWER_TOKEN_FETCH_TIMEOUT_MS) {
  const urls = new Set([
    env.AGENT_OS_GITHUB_ADAPTER_BROKER_URL || env.OAUTH_BROKER_URL || 'http://127.0.0.1:4099',
    env.AGENT_OS_GITHUB_ADAPTER_BROKER_URL_FALLBACK || env.OAUTH_BROKER_URL_FALLBACK || 'http://127.0.0.1:4097',
  ]);
  return 1_000 + Math.max(10_000, perUrlMs) * urls.size;
}
export const SYNC_TOKEN_TIMEOUT_MS = 2_000;

function brokerTokenCommand({ role, env, repo, owner, timeoutMs, force, synchronous = false }) {
  const bin = resolveGitHubAdapterBin({ env });
  if (!bin) throw new BrokerTokenFetchError('github-adapter-unavailable');
  const target = owner && !repo ? ['--owner', owner] : ['--repo', repo || configuredServiceRepo()];
  if (!target[1]) throw new BrokerTokenFetchError('github-adapter-repo-required');
  return [bin, ['token', '--role', role, ...target, ...(force ? ['--force'] : [])], {
    env: { ...buildBrokerAdapterEnv(env), AGENT_OS_GITHUB_ADAPTER_RETRY_MAX_ATTEMPTS: '1' },
    timeout: synchronous ? Math.min(SYNC_TOKEN_TIMEOUT_MS, timeoutMs) : brokerTokenTimeoutMs(env, timeoutMs),
    maxBuffer: 64 * 1024,
  }];
}

function brokerInvocationError(err) {
  const exit = err?.status ?? err?.code;
  let code;
  try { code = JSON.parse(err?.stdout)?.code; } catch { /* No structured diagnostic. */ }
  const transient = ['broker-unreachable', 'github-app-token-unavailable', 'github-rate-limited',
    'rate-limit-exceeded', 'rate-limited'].includes(code)
    || exit === 75 || err?.killed === true || err?.signal === 'SIGTERM'
    || ['ETIMEDOUT', 'EAGAIN', 'EMFILE', 'ENFILE', 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'].includes(exit);
  const check = transient ? 'broker-unreachable' : 'adapter-token-refused';
  const detail = [
    'broker-unreachable', 'github-app-token-unavailable', 'github-app-owner-not-configured',
    'github-app-id-not-configured', 'github-app-id-mismatch', 'github-installation-owner-mismatch',
    'github-installation-id-mismatch',
  ].includes(code) ? code : check;
  const status = Number.isSafeInteger(exit) || /^[A-Z][A-Z_0-9]{0,63}$/.test(exit ?? '') ? ` (exit=${exit})` : '';
  return new BrokerTokenFetchError(`${detail}${status}`, { transient, check });
}

function verifiedBrokerToken(stdout, { role, env, owner, now }) {
  let result;
  try { result = JSON.parse(stdout); }
  catch { throw new BrokerTokenFetchError('adapter-token-malformed-response'); }
  const token = result?.access_token;
  if (result?.ok !== true || typeof token !== 'string' || !token) {
    throw new BrokerTokenFetchError('adapter-token-unavailable');
  }
  if (result.metadata?.credential_source === 'github_pat_fallback') {
    throw new BrokerTokenFetchError('adapter-token-pat-fallback');
  }
  if ((brokerRoleConfig(role) || role === 'merge-agent')
      && result.provider !== `github-app-${role}`) {
    throw new BrokerTokenFetchError('adapter-token-provider-mismatch');
  }
  const { app_id: appId, installation_id: installationId } = result.metadata || {};
  const expiry = Date.parse(result.expires_at);
  const expiresAtMs = Number.isFinite(expiry) ? expiry : null;
  if (expiresAtMs != null && expiresAtMs <= now) throw new BrokerTokenFetchError('adapter-token-expired');
  if (result.metadata?.credential_source === 'github_app_installation') {
    registerGitHubInstallationToken(token, appId, installationId, { env, expiresAtMs });
  }
  recordGithubToken(token, { role, owner });
  return { token, expiresAtMs, permissions: result.metadata?.permissions ?? null, provider: result.provider };
}

export async function fetchReviewerTokenFromBroker({ execFileImpl = exec, ...options }) {
  const request = { env: process.env, timeoutMs: loadAwareTimeoutMs(REVIEWER_TOKEN_FETCH_TIMEOUT_MS),
    now: Date.now(), ...options };
  const command = brokerTokenCommand(request);
  let output;
  try { output = await execFileImpl(...command); }
  catch (err) { throw brokerInvocationError(err); }
  return verifiedBrokerToken(output.stdout, request);
}

export function fetchReviewerTokenFromBrokerSync({ execFileSyncImpl = execFileSync, ...options }) {
  const request = { env: process.env, timeoutMs: loadAwareTimeoutMs(REVIEWER_TOKEN_FETCH_TIMEOUT_MS),
    now: Date.now(), ...options };
  const command = brokerTokenCommand({ ...request, synchronous: true });
  let output;
  try { output = execFileSyncImpl(...command); }
  catch (err) { throw brokerInvocationError(err); }
  return verifiedBrokerToken(output, request);
}

export async function resolveReviewerAppToken(identity, {
  env = process.env,
  execFileImpl,
  mint = fetchReviewerTokenFromBroker,
  timeoutMs = loadAwareTimeoutMs(REVIEWER_TOKEN_FETCH_TIMEOUT_MS),
  force = false,
  repo,
  owner = null,
  now = Date.now(),
} = {}) {
  const role = resolveReviewerBrokerRole(identity);
  if (!role) {
    throw new Error(`Unknown reviewer identity '${identity ?? ''}'`);
  }
  const roleConfig = brokerRoleConfig(role);
  if (!roleConfig) {
    throw new Error(`Reviewer broker role '${role}' is not configured`);
  }
  const { token, expiresAtMs } = await mint({
    role,
    env,
    execFileImpl,
    repo,
    timeoutMs,
    force,
    owner,
    now,
  });
  if (!owner && !githubOwnerTokens.routedOwner(repo)) env[roleConfig.envVar] = token;
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
  laneEnabledImpl = grokReviewerLaneEnabled,
  now = Date.now(),
  execFileImpl,
  repo,
  log = console,
  skewMs = REVIEWER_TOKEN_REFRESH_SKEW_MS,
  fallbackTtlMs = REVIEWER_TOKEN_FALLBACK_TTL_MS,
  timeoutMs = null,
  postSlackMs = null,
  minTokenLifetimeMs = null,
  reviewerRunTimeoutMs = null,
  nominalReviewerRunTimeoutMs = null,
  failureRetryMs = null,
  force = false,
} = {}) {
  // Operator-tunable knobs (documented in
  // docs/SPEC-adversarial-review-auto-remediation.md). Explicit function args
  // win (tests); otherwise resolve + validate from env so the documented
  // process.env contract is actually honored, falling back to the constants.
  const effectiveTimeoutMs =
    timeoutMs ?? loadAwareTimeoutMs(resolvePositiveMsEnv(env.REVIEWER_TOKEN_FETCH_TIMEOUT_MS, REVIEWER_TOKEN_FETCH_TIMEOUT_MS));
  const effectivePostSlackMs =
    postSlackMs ?? resolvePositiveMsEnv(env.REVIEWER_TOKEN_POST_SLACK_MS, REVIEWER_TOKEN_POST_SLACK_MS);
  const effectiveFailureRetryMs =
    failureRetryMs ?? resolvePositiveMsEnv(env.REVIEWER_TOKEN_FAILURE_RETRY_MS, REVIEWER_TOKEN_FAILURE_RETRY_MS);
  const summary = { refreshed: [], skipped: [], failed: [], handoffSafe: [] };
  for (const { role, envVar, flag } of BROKER_REVIEWER_ROLES) {
    if (role === 'grok-reviewer' && !laneEnabledImpl({ env })) {
      summary.skipped.push({ role, reason: 'grok-reviewer-lane-disabled' });
      if (!warnedLaneDisabled.has(role)) {
        warnedLaneDisabled.add(role);
        log?.warn?.('[reviewer-broker-refresh] grok-reviewer-lane-disabled; skipping Grok token refresh');
      }
      continue;
    }
    const configFingerprint = brokerConfigFingerprint(env, flag);
    if (String(env[flag] || '').trim() !== 'true') {
      summary.skipped.push({ role, reason: 'broker-mode-disabled' });
      // Say it out loud, once per role per process.
      //
      // SEV0 2026-09-07: this branch was a silent `continue`. The three reviewer
      // flags were set only in the launchd plist, and the watcher had moved to
      // the start-script path, so every role skipped here on every tick and
      // NOTHING was logged. Reviewer-bot installation tokens (~1h) were seeded
      // once at boot and never refreshed; about an hour into each boot every
      // review POST failed 403 "Resource not accessible by integration". The
      // review text was produced fine — only publication failed — and the
      // reviewer scored that as failure-class=unknown, which burns the infra
      // auto-recovery budget until the PR goes terminal at the 4/3 cap.
      //
      // A refresh loop that silently refreshes nothing is indistinguishable from
      // a healthy one. The whole outage was invisible for want of this line.
      if (!warnedBrokerModeDisabled.has(role)) {
        warnedBrokerModeDisabled.add(role);
        log?.warn?.(
          `[reviewer-broker-refresh] ${flag} is not "true" — ${envVar} will NOT be `
          + `refreshed for role=${role}. Its GitHub App installation token expires ~1h `
          + 'after it was seeded and every review POST then fails 403 "Resource not '
          + 'accessible by integration". Set the flag on the path that actually starts '
          + 'the watcher (scripts/adversarial-watcher-start.sh), not only in the plist.'
        );
      }
      continue;
    }
    // An explicit minTokenLifetimeMs is a fixed floor with no load scaling.
    let handoffLifetimes;
    try {
      handoffLifetimes = minTokenLifetimeMs != null
        ? { nominalMs: minTokenLifetimeMs, loadScaledMs: minTokenLifetimeMs }
        : {
          nominalMs: (nominalReviewerRunTimeoutMs ?? resolveNominalReviewerTimeoutMs(env)) + effectivePostSlackMs,
          loadScaledMs: (reviewerRunTimeoutMs ?? resolveReviewerTimeoutMs(env)) + effectivePostSlackMs,
        };
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
    const loadScaledLifetimeMs = handoffLifetimes.loadScaledMs;
    // Skip only while the token WE last fetched is still comfortably valid.
    // `nextRefreshAtMs` is derived from the broker's expires_at (minus skew),
    // or a fallback TTL when expires_at is absent. The startup token's expiry
    // is unknown to us (no record), so the first sight of a role always
    // re-fetches even though env already holds a value.
    const scheduled = refreshClock.get(envVar);
    // The held token's floor, capped by the lifetime it had when fetched.
    const heldLifetimeMs = cappedHandoffFloorMs(handoffLifetimes, scheduled?.observedLifetimeMs, skewMs);
    const heldHandoff = { role, envVar, env, now, requiredLifetimeMs: heldLifetimeMs, loadScaledLifetimeMs };
    if (
      !force
      && scheduled !== undefined
      && scheduled.configFingerprint === configFingerprint
    ) {
      if (scheduled.failureRetryUntilMs != null && now < scheduled.failureRetryUntilMs) {
        const existingExpiresAtMs = scheduled.expiresAtMs ?? null;
        if (existingExpiresAtMs == null || existingExpiresAtMs - now > heldLifetimeMs) {
          summary.skipped.push({ role, reason: 'broker-refresh-backoff' });
          recordReviewerTokenHandoffState(summary, heldHandoff);
          continue;
        }
      }
      if (now < scheduled.nextRefreshAtMs) {
        summary.skipped.push({ role, reason: 'token-still-valid' });
        recordReviewerTokenHandoffState(summary, heldHandoff);
        continue;
      }
    }
    try {
      const { token, expiresAtMs } = await fetchReviewerTokenFromBroker({
        role,
        env,
        execFileImpl,
        repo,
        timeoutMs: effectiveTimeoutMs,
        now,
      });
      // Only a held token from the current broker config, still in env, can be
      // compared. Its expiry is unknown at startup and after a config rotation.
      const heldExpiresAtMs = scheduled?.configFingerprint === configFingerprint && env[envVar]
        ? scheduled.expiresAtMs ?? null
        : null;
      if (expiresAtMs != null && expiresAtMs <= now) {
        throw new ReviewerTokenNotFresherError(
          `broker token already expired: expires_at=${new Date(expiresAtMs).toISOString()}`
        );
      }
      if (expiresAtMs != null && heldExpiresAtMs != null && expiresAtMs < heldExpiresAtMs) {
        throw new ReviewerTokenNotFresherError(
          `broker token expires before the held ${envVar}: remaining=${expiresAtMs - now}ms held=${heldExpiresAtMs - now}ms`
        );
      }
      // Freshest wins, even below the handoff floor: the alternative is a held
      // token that expires sooner still.
      env[envVar] = token;
      const observedLifetimeMs = expiresAtMs != null ? expiresAtMs - now : null;
      const requiredLifetimeMs = cappedHandoffFloorMs(handoffLifetimes, observedLifetimeMs, skewMs);
      // Re-fetch before the token crosses EITHER the refresh skew OR the
      // subprocess-handoff minimum lifetime — whichever comes first. Using only
      // (expiry - skew) left a window where now < expiry - skew (treated as
      // "token-still-valid") but expiry - now <= requiredLifetimeMs, during which
      // a newly-spawned reviewer could inherit a token too short to survive its
      // run and post — the very HTTP 401 this module prevents. With the defaults
      // (skew 15m, required ~22m) the required-lifetime bound is the earlier one.
      // A cached or short-lived token can already be inside this window. Keep
      // the freshest token, but wait the bounded retry interval before asking
      // again; a 1ms schedule would fetch on every daemon tick.
      const refreshLeadMs = Math.max(skewMs, requiredLifetimeMs);
      const byExpiry = expiresAtMs != null ? expiresAtMs - refreshLeadMs : null;
      const byFallback = now + fallbackTtlMs;
      const next = byExpiry == null ? byFallback
        : byExpiry <= now ? now + effectiveFailureRetryMs : byExpiry;
      refreshClock.set(envVar, {
        nextRefreshAtMs: next,
        configFingerprint,
        expiresAtMs: expiresAtMs ?? null,
        observedLifetimeMs,
      });
      const handoffShortfallMs = observedLifetimeMs != null
        ? Math.max(0, loadScaledLifetimeMs - observedLifetimeMs)
        : 0;
      summary.refreshed.push({
        role,
        envVar,
        expiresAtMs: expiresAtMs ?? null,
            requiredLifetimeMs,
        loadScaledLifetimeMs,
        handoffShortfallMs,
      });
      if (handoffShortfallMs === 0) {
        warnedHandoffShortfall.delete(envVar);
      } else if (!warnedHandoffShortfall.has(envVar)) {
        warnedHandoffShortfall.add(envVar);
        log?.warn?.(
          `[reviewer-broker-refresh] installed the freshest ${envVar} for ${role}; a load-scaled reviewer run `
          + `plus post slack (${loadScaledLifetimeMs}ms) can outlive it by ${handoffShortfallMs}ms. `
          + 'Reviewers re-resolve the token from the broker before their GitHub side calls.'
        );
      }
      recordReviewerTokenHandoffState(summary, {
        role, envVar, env, now, requiredLifetimeMs, loadScaledLifetimeMs,
      });
    } catch (err) {
      // Fail-safe: keep whatever token env already holds. Do NOT clear it, and
      // only apply a short backoff for a stale broker token while the held
      // token remains outside its handoff floor. Other broker failures still
      // retry next tick.
      if (err instanceof ReviewerTokenNotFresherError) {
        const current = refreshClock.get(envVar);
        const currentExpiresAtMs = current?.expiresAtMs ?? null;
        const currentTooClose =
          currentExpiresAtMs != null && currentExpiresAtMs - now <= heldLifetimeMs;
        if (!force && !currentTooClose) {
          const retryAt = now + effectiveFailureRetryMs;
          refreshClock.set(envVar, {
            nextRefreshAtMs: retryAt,
            configFingerprint,
            expiresAtMs: currentExpiresAtMs,
            observedLifetimeMs: current?.observedLifetimeMs ?? null,
            failureRetryUntilMs: retryAt,
          });
        }
      }
      summary.failed.push({ role, reason: err?.message || String(err) });
      recordReviewerTokenHandoffState(summary, heldHandoff);
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
// CLI, which prefers GH_TOKEN). Both services use the merge-agent role.
export const WATCHER_GH_TOKEN_ENV_VARS = Object.freeze(['GITHUB_TOKEN', 'GH_TOKEN']);
export const WATCHER_GH_AUTH_FLAG = 'WATCHER_GH_AUTH_VIA_BROKER';
export const DEFAULT_WATCHER_GH_BROKER_ROLE = 'merge-agent';

export function resolveWatcherGhBrokerRole() {
  return DEFAULT_WATCHER_GH_BROKER_ROLE;
}

export function resolveFollowUpGhBrokerRole() {
  return DEFAULT_FOLLOW_UP_GH_BROKER_ROLE;
}

export async function refreshFollowUpGithubToken({
  env = process.env,
  repo,
  now = Date.now(),
  execFileImpl,
  log = console,
  skewMs = REVIEWER_TOKEN_REFRESH_SKEW_MS,
  fallbackTtlMs = REVIEWER_TOKEN_FALLBACK_TTL_MS,
  timeoutMs = null,
  force = false,
} = {}) {
  const summary = { refreshed: false, skipped: null, failed: null, role: null };
  const flag = 'FOLLOW_UP_GH_AUTH_VIA_BROKER';
  if (String(env[flag] || '').trim() !== 'true') {
    summary.skipped = 'broker-mode-disabled';
    return summary;
  }
  if (repo && githubOwnerTokens.routedOwner(repo)) {
    summary.skipped = 'owner-routed-repository';
    return summary;
  }
  const role = resolveFollowUpGhBrokerRole();
  summary.role = role;
  const clockKey = `__follow_up_gh__:${role}`;
  const configFingerprint = brokerConfigFingerprint(env, flag);
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
    timeoutMs ?? loadAwareTimeoutMs(resolvePositiveMsEnv(env.REVIEWER_TOKEN_FETCH_TIMEOUT_MS, REVIEWER_TOKEN_FETCH_TIMEOUT_MS));
  try {
    const { token, expiresAtMs } = await fetchReviewerTokenFromBroker({
      role,
      env,
      execFileImpl,
      timeoutMs: effectiveTimeoutMs,
      repo,
      now,
      force,
    });
    for (const envVar of FOLLOW_UP_GH_TOKEN_ENV_VARS) {
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
      `[reviewer-broker-refresh] follow-up GITHUB_TOKEN/GH_TOKEN refreshed via the GitHub adapter (role=${role}; expires_at=${expiresAtMs ? new Date(expiresAtMs).toISOString() : 'unknown'})`
    );
  } catch (err) {
    summary.failed = err?.message || String(err);
    const retryAt = now + resolvePositiveMsEnv(env.REVIEWER_TOKEN_FAILURE_RETRY_MS, REVIEWER_TOKEN_FAILURE_RETRY_MS);
    refreshClock.set(clockKey, {
      nextRefreshAtMs: retryAt,
      configFingerprint,
      expiresAtMs: scheduled?.expiresAtMs ?? null,
    });
    log?.warn?.(
      `[reviewer-broker-refresh] keeping existing follow-up GITHUB_TOKEN; broker fetch for role ${role} failed: ${summary.failed}`
    );
  }
  return summary;
}

export async function refreshWatcherGithubToken({
  env = process.env,
  repo,
  now = Date.now(),
  execFileImpl,
  log = console,
  skewMs = REVIEWER_TOKEN_REFRESH_SKEW_MS,
  fallbackTtlMs = REVIEWER_TOKEN_FALLBACK_TTL_MS,
  timeoutMs = null,
  force = false,
} = {}) {
  const summary = { refreshed: false, skipped: null, failed: null, role: null };
  if (String(env[WATCHER_GH_AUTH_FLAG] || '').trim() !== 'true') {
    summary.skipped = 'broker-mode-disabled';
    return summary;
  }
  if (repo && githubOwnerTokens.routedOwner(repo)) {
    summary.skipped = 'owner-routed-repository';
    return summary;
  }
  const role = resolveWatcherGhBrokerRole();
  summary.role = role;
  // Distinct clock key namespace so the watcher token's schedule never collides
  // with a reviewer role that happens to share the same App role string.
  const clockKey = `__watcher_gh__:${role}`;
  const configFingerprint = brokerConfigFingerprint(env, WATCHER_GH_AUTH_FLAG);
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
    timeoutMs ?? loadAwareTimeoutMs(resolvePositiveMsEnv(env.REVIEWER_TOKEN_FETCH_TIMEOUT_MS, REVIEWER_TOKEN_FETCH_TIMEOUT_MS));
  try {
    const { token, expiresAtMs } = await fetchReviewerTokenFromBroker({
      role,
      env,
      execFileImpl,
      timeoutMs: effectiveTimeoutMs,
      repo,
      now,
      force,
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
      `[reviewer-broker-refresh] watcher GITHUB_TOKEN/GH_TOKEN refreshed via the GitHub adapter (role=${role}; expires_at=${expiresAtMs ? new Date(expiresAtMs).toISOString() : 'unknown'})`
    );
  } catch (err) {
    // Keep the prior credential and retry on the bounded refresh cadence.
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
