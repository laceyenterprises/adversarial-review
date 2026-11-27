import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { fixtureAdapterBin, legacyTokenFixture, tokenFixture } from './helpers/github-adapter-token-fixture.mjs';
import { githubOwnerTokens } from '../src/github-owner-token.mjs';
import { githubCredential } from '../src/rate-limit-throttle.mjs';

import {
  refreshFollowUpGithubToken as refreshFollowUp,
  refreshReviewerBrokerTokens as refreshReviewers,
  refreshWatcherGithubToken as refreshWatcher,
  resolveReviewerAppToken as resolveReviewer,
  _resetReviewerTokenRefreshClockForTest,
  REVIEWER_TOKEN_REFRESH_SKEW_MS,
  REVIEWER_TOKEN_FALLBACK_TTL_MS,
  REVIEWER_TOKEN_POST_SLACK_MS,
  REVIEWER_TOKEN_FAILURE_RETRY_MS,
  BROKER_REVIEWER_ROLES,
  WATCHER_GH_TOKEN_ENV_VARS,
  DEFAULT_WATCHER_GH_BROKER_ROLE,
  DEFAULT_FOLLOW_UP_GH_BROKER_ROLE,
  fetchReviewerTokenFromBroker,
  fetchReviewerTokenFromBrokerSync,
  brokerTokenTimeoutMs,
  SYNC_TOKEN_TIMEOUT_MS,
} from '../src/reviewer-broker-refresh.mjs';

function adapterOptions({ fetchImpl, env = {}, ...options }) {
  env.GHA_ADAPTER_BIN = fixtureAdapterBin;
  return { repo: `${(JSON.parse(readFileSync(new URL('../config.json', import.meta.url))).org || 'fixture-org')}/adversarial-review`, ...options, env, execFileImpl: options.execFileImpl || legacyTokenFixture((url, request) => {
    const route = new URL(url);
    route.searchParams.delete('repo');
    return fetchImpl(route.toString(), { ...request, headers: { Authorization: 'Bearer broker-shared-secret' } });
  }) };
}
const refreshFollowUpGithubToken = options => refreshFollowUp(adapterOptions(options));
const refreshReviewerBrokerTokens = options => refreshReviewers(adapterOptions(options));
const refreshWatcherGithubToken = options => refreshWatcher(adapterOptions(options));
const resolveReviewerAppToken = (role, options) => resolveReviewer(role, { now: 0, ...adapterOptions(options) });

const SECRET_FILE = '/secret/oauth-broker-shared-secret';
const HOUR_MS = 60 * 60 * 1000;

function makeFollowUpEnv(overrides = {}) {
  return {
    FOLLOW_UP_GH_AUTH_VIA_BROKER: 'true',
    OAUTH_BROKER_URL: 'http://127.0.0.1:4099',
    OAUTH_BROKER_SHARED_SECRET_FILE: SECRET_FILE,
    GITHUB_TOKEN: 'ghp_OLD_operator_pat',
    GH_TOKEN: 'ghp_OLD_operator_pat',
    ...overrides,
  };
}

function makeEnv(overrides = {}) {
  return {
    CLAUDE_REVIEWER_AUTH_VIA_BROKER: 'true',
    OAUTH_BROKER_URL: 'http://127.0.0.1:4099',
    OAUTH_BROKER_SHARED_SECRET_FILE: SECRET_FILE,
    GH_CLAUDE_REVIEWER_TOKEN: 'ghs_OLD_token',
    ...overrides,
  };
}

// `expiresAt` is an ISO string (or null to omit the field). `metadata` lets
// tests exercise app_id / installation_id verification.
function brokerOk(provider, accessToken, { expiresAt = null, metadata = {} } = {}) {
  const body = { access_token: accessToken, provider, metadata };
  if (expiresAt !== null) body.expires_at = expiresAt;
  return { ok: true, status: 200, async json() { return body; } };
}

const readSecret = () => 'broker-shared-secret';
const silentLog = { warn: () => {} };

test('Grok lane off skips its broker role and logs once per process', async () => {
  _resetReviewerTokenRefreshClockForTest();
  const warnings = [];
  const opts = {
    env: { GROK_REVIEWER_AUTH_VIA_BROKER: 'true' },
    laneEnabledImpl: () => false,
    log: { warn: (message) => warnings.push(message) },
    fetchImpl: async () => { assert.fail('disabled lane must not fetch'); },
  };
  for (let tick = 0; tick < 2; tick += 1) {
    const summary = await refreshReviewerBrokerTokens(opts);
    assert.ok(summary.skipped.some((entry) => entry.role === 'grok-reviewer'
      && entry.reason === 'grok-reviewer-lane-disabled'));
  }
  assert.equal(warnings.filter((message) => message.includes('grok-reviewer-lane-disabled')).length, 1);
});

test('test reset restores disabled-lane and disabled-broker warnings without changing tick deduplication', async () => {
  for (let episode = 0; episode < 2; episode += 1) {
    _resetReviewerTokenRefreshClockForTest();
    const warnings = [];
    const opts = {
      env: {},
      laneEnabledImpl: () => false,
      log: { warn: (message) => warnings.push(message) },
      fetchImpl: async () => { assert.fail('disabled roles must not fetch'); },
    };
    await refreshReviewerBrokerTokens(opts);
    await refreshReviewerBrokerTokens(opts);
    assert.equal(warnings.filter((message) => message.includes('grok-reviewer-lane-disabled')).length, 1);
    for (const { role, flag } of BROKER_REVIEWER_ROLES) {
      if (role === 'grok-reviewer') continue;
      assert.equal(warnings.filter((message) => message.includes(flag)).length, 1, role);
    }
  }
});

test('Grok lane on refreshes and renews its token; failures preserve other reviewer refreshes', async () => {
  for (const fail of [false, true]) {
    _resetReviewerTokenRefreshClockForTest();
    const env = { OAUTH_BROKER_SHARED_SECRET_FILE: SECRET_FILE };
    for (const { flag } of BROKER_REVIEWER_ROLES) env[flag] = 'true';
    const providers = [];
    let generation = 0;
    const opts = {
      env, laneEnabledImpl: () => true, readFileImpl: readSecret, log: silentLog,
      minTokenLifetimeMs: 1,
      fetchImpl: async (url) => {
        const provider = new URL(url).searchParams.get('provider');
        providers.push(provider);
        if (fail && provider === 'github-app-grok-reviewer') {
          return { ok: false, status: 403 };
        }
        return brokerOk(provider, `synthetic-${provider}-${generation}`, {
          expiresAt: new Date((generation + 1) * HOUR_MS).toISOString(),
        });
      },
    };
    const first = await refreshReviewerBrokerTokens({ ...opts, now: 0 });
    assert.equal(first.refreshed.length, fail ? 3 : 4);
    assert.deepEqual(first.failed.map((entry) => entry.role), fail ? ['grok-reviewer'] : []);
    assert.equal(providers.filter((provider) => provider === 'github-app-grok-reviewer').length, 1);
    for (const role of ['CLAUDE', 'CODEX', 'GEMINI']) {
      assert.ok(env[`GH_${role}_REVIEWER_TOKEN`]);
    }
    if (fail) assert.equal(env.GH_GROK_REVIEWER_TOKEN, undefined);
    else {
      generation = 1;
      await refreshReviewerBrokerTokens({ ...opts, now: HOUR_MS });
      assert.equal(env.GH_GROK_REVIEWER_TOKEN, 'synthetic-github-app-grok-reviewer-1');
    }
  }
});

test('Grok reviewer identity aliases resolve to the broker role', async () => {
  for (const identity of ['grok-reviewer', 'grok-reviewer-lacey', 'lacey-grok-reviewer', 'GH_GROK_REVIEWER_TOKEN']) {
    const env = { OAUTH_BROKER_SHARED_SECRET_FILE: SECRET_FILE };
    const result = await resolveReviewerAppToken(identity, {
      env, readFileImpl: readSecret,
      fetchImpl: async (url) => {
        assert.equal(new URL(url).searchParams.get('provider'), 'github-app-grok-reviewer');
        return brokerOk('github-app-grok-reviewer', 'synthetic-grok-token');
      },
    });
    assert.equal(result.role, 'grok-reviewer');
    assert.equal(env.GH_GROK_REVIEWER_TOKEN, 'synthetic-grok-token');
  }
});


test('refreshes a broker-enabled reviewer token and writes it back to env', async () => {
  _resetReviewerTokenRefreshClockForTest();
  const env = makeEnv();
  let calledUrl = null;
  let calledAuth = null;
  const fetchImpl = async (url, opts) => {
    calledUrl = url;
    calledAuth = opts.headers.Authorization;
    return brokerOk('github-app-claude-reviewer', 'ghs_FRESH_token', {
      expiresAt: new Date(1_000_000 + HOUR_MS).toISOString(),
    });
  };
  const summary = await refreshReviewerBrokerTokens({
    env, now: 1_000_000, fetchImpl, readFileImpl: readSecret, log: silentLog,
  });
  assert.equal(env.GH_CLAUDE_REVIEWER_TOKEN, 'ghs_FRESH_token');
  assert.match(calledUrl, /\/token\?provider=github-app-claude-reviewer$/);
  assert.equal(calledAuth, 'Bearer broker-shared-secret');
  assert.equal(summary.refreshed.length, 1);
  assert.equal(summary.refreshed[0].role, 'claude-reviewer');
  assert.equal(summary.handoffSafe.length, 1);
  assert.equal(summary.handoffSafe[0].safe, true);
});

test('resolveReviewerAppToken builds the expected broker request for each reviewer identity', async () => {
  const cases = [
    {
      identity: 'claude-reviewer-lacey',
      envVar: 'GH_CLAUDE_REVIEWER_TOKEN',
      provider: 'github-app-claude-reviewer',
      token: 'ghs_claude_fresh',
    },
    {
      identity: 'codex-reviewer-lacey',
      envVar: 'GH_CODEX_REVIEWER_TOKEN',
      provider: 'github-app-codex-reviewer',
      token: 'ghs_codex_fresh',
    },
  ];

  for (const testCase of cases) {
    const env = makeEnv({ GH_CLAUDE_REVIEWER_TOKEN: 'ghs_old_claude', GH_CODEX_REVIEWER_TOKEN: 'ghs_old_codex' });
    let calledUrl = null;
    let calledAuth = null;
    const resolved = await resolveReviewerAppToken(testCase.identity, {
      env,
      readFileImpl: readSecret,
      fetchImpl: async (url, opts) => {
        calledUrl = url;
        calledAuth = opts.headers.Authorization;
        return brokerOk(testCase.provider, testCase.token, {
          expiresAt: new Date(1_000_000 + HOUR_MS).toISOString(),
        });
      },
    });
    assert.equal(calledUrl, `http://127.0.0.1:4099/token?provider=${testCase.provider}`);
    assert.equal(calledAuth, 'Bearer broker-shared-secret');
    assert.equal(resolved.role, testCase.provider.replace('github-app-', ''));
    assert.equal(resolved.envVar, testCase.envVar);
    assert.equal(resolved.token, testCase.token);
    assert.equal(env[testCase.envVar], testCase.token);
  }
});


test('keys the refresh schedule off the broker expires_at minus skew (when skew is the dominant lead)', async () => {
  _resetReviewerTokenRefreshClockForTest();
  const env = makeEnv();
  let calls = 0;
  const t0 = 5_000_000;
  // Pin the handoff minimum BELOW the skew so the skew is the dominant refresh
  // lead (max(skew, required) === skew); the dedicated required-lifetime test
  // covers the other ordering.
  const minTokenLifetimeMs = 5 * 60 * 1000;
  const opts = { env, fetchImpl: undefined, readFileImpl: readSecret, log: silentLog, minTokenLifetimeMs };
  const fetchImpl = async () => {
    calls += 1;
    const issuedAt = calls === 1 ? t0 : t0 + HOUR_MS - REVIEWER_TOKEN_REFRESH_SKEW_MS + 1;
    return brokerOk('github-app-claude-reviewer', `ghs_token_${calls}`, {
      expiresAt: new Date(issuedAt + HOUR_MS).toISOString(),
    });
  };
  opts.fetchImpl = fetchImpl;
  await refreshReviewerBrokerTokens({ ...opts, now: t0 });
  assert.equal(env.GH_CLAUDE_REVIEWER_TOKEN, 'ghs_token_1');
  // Comfortably before (expiry - skew): no re-fetch.
  await refreshReviewerBrokerTokens({ ...opts, now: t0 + HOUR_MS - REVIEWER_TOKEN_REFRESH_SKEW_MS - 1 });
  assert.equal(calls, 1);
  assert.equal(env.GH_CLAUDE_REVIEWER_TOKEN, 'ghs_token_1');
  // Inside the skew window (token nearly expired): re-fetch.
  await refreshReviewerBrokerTokens({ ...opts, now: t0 + HOUR_MS - REVIEWER_TOKEN_REFRESH_SKEW_MS + 1 });
  assert.equal(calls, 2);
  assert.equal(env.GH_CLAUDE_REVIEWER_TOKEN, 'ghs_token_2');
});

test('re-fetches before the required-lifetime floor, not only before the skew window', async () => {
  // Guards the handoff window: with skew (15m) < required lifetime (22m here),
  // scheduling only at expiry-skew left ~7m where the token reads
  // "token-still-valid" yet is already too short for a freshly-spawned reviewer.
  // The schedule must re-fetch at the EARLIER of (expiry-skew, expiry-required).
  _resetReviewerTokenRefreshClockForTest();
  const env = makeEnv();
  let calls = 0;
  let curNow = 0;
  const t0 = 7_000_000;
  const skewMs = 15 * 60 * 1000;
  const minTokenLifetimeMs = 22 * 60 * 1000;
  // Each fetch returns a FRESH token expiring 1h from the fetch time (the broker
  // re-mints on refresh), so the re-fetched token comfortably clears the floor.
  const fetchImpl = async () => {
    calls += 1;
    return brokerOk('github-app-claude-reviewer', `ghs_token_${calls}`, {
      expiresAt: new Date(curNow + HOUR_MS).toISOString(),
    });
  };
  const opts = { env, fetchImpl, readFileImpl: readSecret, log: silentLog, skewMs, minTokenLifetimeMs };
  curNow = t0;
  await refreshReviewerBrokerTokens({ ...opts, now: curNow });
  assert.equal(calls, 1); // schedule next at expiry - max(skew,required) = t0 + 60 - 22 = t0+38m
  // Just BEFORE expiry - required (22m): still valid, no re-fetch.
  curNow = t0 + HOUR_MS - minTokenLifetimeMs - 1;
  await refreshReviewerBrokerTokens({ ...opts, now: curNow });
  assert.equal(calls, 1);
  // Just AFTER expiry - required (22m) but still before expiry - skew (15m):
  // the OLD formula would say "token-still-valid"; the fix must re-fetch.
  curNow = t0 + HOUR_MS - minTokenLifetimeMs + 1;
  await refreshReviewerBrokerTokens({ ...opts, now: curNow });
  assert.equal(calls, 2);
  assert.equal(env.GH_CLAUDE_REVIEWER_TOKEN, 'ghs_token_2');
});

test('installs a short cached token over a startup token of unknown expiry and reports it unsafe', async () => {
  // REVTOKENFLOOR-01: the broker's cached token has only a few minutes left,
  // but the startup token's expiry is unknown and it came from the same broker
  // earlier, so it is no fresher. Install the freshest token; the handoff
  // floor still reports it unsafe and records the shortfall.
  _resetReviewerTokenRefreshClockForTest();
  const env = makeEnv();
  const t0 = 9_000_000;
  const fetchImpl = async () =>
    brokerOk('github-app-claude-reviewer', 'ghs_too_close', {
      expiresAt: new Date(t0 + 5 * 60 * 1000).toISOString(),
    });
  const summary = await refreshReviewerBrokerTokens({
    env,
    now: t0,
    fetchImpl,
    readFileImpl: readSecret,
    log: silentLog,
    reviewerRunTimeoutMs: 20 * 60 * 1000,
  });
  assert.equal(env.GH_CLAUDE_REVIEWER_TOKEN, 'ghs_too_close');
  assert.equal(summary.failed.length, 0);
  assert.equal(summary.refreshed[0].handoffShortfallMs, 17 * 60 * 1000);
  assert.equal(summary.handoffSafe[0].safe, false);
  assert.equal(summary.handoffSafe[0].reason, 'token-below-handoff-floor');
  assert.equal(summary.handoffSafe[0].handoffShortfallMs, 17 * 60 * 1000);
});

test('installs a cached token below a fixed remediation floor and reports it unsafe', async () => {
  // A 30m cached installation token is long enough for the default reviewer
  // floor (~22m), but too short for a detached remediation worker handoff. A
  // fixed floor is not load-scaled, so the provider cap does not lower it.
  _resetReviewerTokenRefreshClockForTest();
  const env = makeEnv();
  const t0 = 9_250_000;
  const fetchImpl = async () =>
    brokerOk('github-app-claude-reviewer', 'ghs_reviewer_only_lifetime', {
      expiresAt: new Date(t0 + 30 * 60 * 1000).toISOString(),
    });
  const summary = await refreshReviewerBrokerTokens({
    env,
    now: t0,
    fetchImpl,
    readFileImpl: readSecret,
    log: silentLog,
    minTokenLifetimeMs: 50 * 60 * 1000,
  });
  assert.equal(env.GH_CLAUDE_REVIEWER_TOKEN, 'ghs_reviewer_only_lifetime');
  assert.equal(summary.failed.length, 0);
  assert.equal(summary.handoffSafe.length, 1);
  assert.equal(summary.handoffSafe[0].safe, false);
  assert.equal(summary.handoffSafe[0].reason, 'token-below-handoff-floor');
  assert.equal(summary.handoffSafe[0].requiredLifetimeMs, 50 * 60 * 1000);
  assert.equal(summary.handoffSafe[0].handoffShortfallMs, 20 * 60 * 1000);
});

test('marks an aged prior token unsafe when the broker re-serves the same cached token', async () => {
  _resetReviewerTokenRefreshClockForTest();
  const env = makeEnv();
  const t0 = 9_300_000;
  const minTokenLifetimeMs = 50 * 60 * 1000;
  let calls = 0;
  let curNow = t0;
  const fetchImpl = async () => {
    calls += 1;
    return brokerOk('github-app-claude-reviewer', 'ghs_cached_installation_token', {
      expiresAt: new Date(t0 + HOUR_MS).toISOString(),
    });
  };

  const first = await refreshReviewerBrokerTokens({
    env,
    now: curNow,
    fetchImpl,
    readFileImpl: readSecret,
    log: silentLog,
    minTokenLifetimeMs,
  });
  assert.equal(calls, 1);
  assert.equal(env.GH_CLAUDE_REVIEWER_TOKEN, 'ghs_cached_installation_token');
  assert.equal(first.handoffSafe[0].safe, true);

  curNow = t0 + 10 * 60 * 1000 + 1;
  const second = await refreshReviewerBrokerTokens({
    env,
    now: curNow,
    fetchImpl,
    readFileImpl: readSecret,
    log: silentLog,
    minTokenLifetimeMs,
  });
  assert.equal(calls, 2);
  assert.equal(env.GH_CLAUDE_REVIEWER_TOKEN, 'ghs_cached_installation_token');
  assert.equal(second.failed.length, 0);
  assert.equal(second.handoffSafe.length, 1);
  assert.deepEqual(
    {
      role: second.handoffSafe[0].role,
      envVar: second.handoffSafe[0].envVar,
      safe: second.handoffSafe[0].safe,
      reason: second.handoffSafe[0].reason,
      remainingMs: second.handoffSafe[0].remainingMs,
      requiredLifetimeMs: second.handoffSafe[0].requiredLifetimeMs,
    },
    {
      role: 'claude-reviewer',
      envVar: 'GH_CLAUDE_REVIEWER_TOKEN',
      safe: false,
      reason: 'token-below-handoff-floor',
      remainingMs: minTokenLifetimeMs - 1,
      requiredLifetimeMs: minTokenLifetimeMs,
    },
  );
});

// Hold a 1h token under a 5m floor; it is next due at expiry - skew (45m),
// while it is still outside its handoff floor.
async function holdTokenUntilDue(env, t0, opts) {
  await refreshReviewerBrokerTokens({
    ...opts,
    env,
    now: t0,
    fetchImpl: async () => brokerOk('github-app-claude-reviewer', 'ghs_held', {
      expiresAt: new Date(t0 + HOUR_MS).toISOString(),
    }),
  });
  assert.equal(env.GH_CLAUDE_REVIEWER_TOKEN, 'ghs_held');
  return t0 + HOUR_MS - REVIEWER_TOKEN_REFRESH_SKEW_MS + 1;
}

test('backs off briefly after the broker serves a token older than the held one', async () => {
  _resetReviewerTokenRefreshClockForTest();
  const env = makeEnv();
  const t0 = 9_500_000;
  const opts = { readFileImpl: readSecret, log: silentLog, minTokenLifetimeMs: 5 * 60 * 1000, failureRetryMs: 30_000 };
  const due = await holdTokenUntilDue(env, t0, opts);
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    const token = calls === 1 ? 'ghs_older' : 'ghs_newer';
    const expiresAtMs = calls === 1 ? t0 + HOUR_MS - 1 : due + HOUR_MS;
    return brokerOk('github-app-claude-reviewer', token, {
      expiresAt: new Date(expiresAtMs).toISOString(),
    });
  };

  const first = await refreshReviewerBrokerTokens({ ...opts, env, now: due, fetchImpl });
  assert.equal(env.GH_CLAUDE_REVIEWER_TOKEN, 'ghs_held');
  assert.equal(first.failed.length, 1);
  assert.match(first.failed[0].reason, /expires before the held GH_CLAUDE_REVIEWER_TOKEN/);
  assert.equal(calls, 1);

  const skipped = await refreshReviewerBrokerTokens({ ...opts, env, now: due + 1_000, fetchImpl });
  assert.equal(calls, 1);
  assert.ok(skipped.skipped.some((s) => s.reason === 'broker-refresh-backoff'));
  assert.equal(env.GH_CLAUDE_REVIEWER_TOKEN, 'ghs_held');

  await refreshReviewerBrokerTokens({ ...opts, env, now: due + 30_001, fetchImpl });
  assert.equal(calls, 2);
  assert.equal(env.GH_CLAUDE_REVIEWER_TOKEN, 'ghs_newer');
});

test('broker config rotation bypasses the stale-token backoff and the held-token comparison', async () => {
  _resetReviewerTokenRefreshClockForTest();
  const env = makeEnv();
  const t0 = 9_700_000;
  const opts = { readFileImpl: readSecret, log: silentLog, minTokenLifetimeMs: 5 * 60 * 1000, failureRetryMs: 60_000 };
  const due = await holdTokenUntilDue(env, t0, opts);
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return brokerOk('github-app-claude-reviewer', `ghs_older_${calls}`, {
      expiresAt: new Date(t0 + HOUR_MS - 1).toISOString(),
    });
  };

  await refreshReviewerBrokerTokens({ ...opts, env, now: due, fetchImpl });
  assert.equal(env.GH_CLAUDE_REVIEWER_TOKEN, 'ghs_held');
  // The held token belongs to the old broker config, so it cannot outrank
  // the rotated config's token.
  env.OAUTH_BROKER_URL = 'http://127.0.0.1:4199';
  await refreshReviewerBrokerTokens({ ...opts, env, now: due + 1_000, fetchImpl });

  assert.equal(calls, 2);
  assert.equal(env.GH_CLAUDE_REVIEWER_TOKEN, 'ghs_older_2');
});

test('stale-token backoff does not defer once the known existing token is near hard expiry', async () => {
  _resetReviewerTokenRefreshClockForTest();
  const env = makeEnv();
  const t0 = 10_000_000;
  const minTokenLifetimeMs = 20 * 60 * 1000;
  let calls = 0;
  let curNow = t0;
  const fetchImpl = async () => {
    calls += 1;
    if (calls === 1) {
      return brokerOk('github-app-claude-reviewer', 'ghs_initial_good', {
        expiresAt: new Date(t0 + 30 * 60 * 1000).toISOString(),
      });
    }
    return brokerOk('github-app-claude-reviewer', `ghs_too_close_${calls}`, {
      expiresAt: new Date(curNow + 5 * 60 * 1000).toISOString(),
    });
  };

  await refreshReviewerBrokerTokens({
    env,
    now: curNow,
    fetchImpl,
    readFileImpl: readSecret,
    log: silentLog,
    minTokenLifetimeMs,
    failureRetryMs: REVIEWER_TOKEN_FAILURE_RETRY_MS,
  });
  assert.equal(env.GH_CLAUDE_REVIEWER_TOKEN, 'ghs_initial_good');

  curNow = t0 + 10 * 60 * 1000 + 1;
  await refreshReviewerBrokerTokens({
    env,
    now: curNow,
    fetchImpl,
    readFileImpl: readSecret,
    log: silentLog,
    minTokenLifetimeMs,
    failureRetryMs: REVIEWER_TOKEN_FAILURE_RETRY_MS,
  });
  assert.equal(calls, 2);
  assert.equal(env.GH_CLAUDE_REVIEWER_TOKEN, 'ghs_initial_good');

  curNow += 1_000;
  await refreshReviewerBrokerTokens({
    env,
    now: curNow,
    fetchImpl,
    readFileImpl: readSecret,
    log: silentLog,
    minTokenLifetimeMs,
    failureRetryMs: REVIEWER_TOKEN_FAILURE_RETRY_MS,
  });
  assert.equal(calls, 3);
  assert.equal(env.GH_CLAUDE_REVIEWER_TOKEN, 'ghs_initial_good');
});

test('accepts a token that exceeds reviewer timeout plus post slack', async () => {
  _resetReviewerTokenRefreshClockForTest();
  const env = makeEnv();
  const t0 = 9_000_000;
  const minimum = 20 * 60 * 1000 + REVIEWER_TOKEN_POST_SLACK_MS;
  const fetchImpl = async () =>
    brokerOk('github-app-claude-reviewer', 'ghs_long_enough', {
      expiresAt: new Date(t0 + minimum + 1).toISOString(),
    });
  await refreshReviewerBrokerTokens({ env, now: t0, fetchImpl, readFileImpl: readSecret, log: silentLog });
  assert.equal(env.GH_CLAUDE_REVIEWER_TOKEN, 'ghs_long_enough');
});

test('falls back to a fixed TTL when the broker omits expires_at', async () => {
  _resetReviewerTokenRefreshClockForTest();
  const env = makeEnv();
  let calls = 0;
  const t0 = 2_000_000;
  const fetchImpl = async () => { calls += 1; return brokerOk('github-app-claude-reviewer', `ghs_${calls}`); };
  await refreshReviewerBrokerTokens({ env, now: t0, fetchImpl, readFileImpl: readSecret, log: silentLog });
  await refreshReviewerBrokerTokens({ env, now: t0 + REVIEWER_TOKEN_FALLBACK_TTL_MS - 1, fetchImpl, readFileImpl: readSecret, log: silentLog });
  assert.equal(calls, 1); // within fallback TTL
  await refreshReviewerBrokerTokens({ env, now: t0 + REVIEWER_TOKEN_FALLBACK_TTL_MS + 1, fetchImpl, readFileImpl: readSecret, log: silentLog });
  assert.equal(calls, 2); // past fallback TTL
});

test('FAIL-SAFE: broker non-200 keeps the existing token (never blanks it)', async () => {
  _resetReviewerTokenRefreshClockForTest();
  const env = makeEnv();
  const fetchImpl = async () => ({ ok: false, status: 503, async json() { return {}; } });
  const summary = await refreshReviewerBrokerTokens({
    env, now: 1, fetchImpl, readFileImpl: readSecret, log: silentLog,
  });
  assert.equal(env.GH_CLAUDE_REVIEWER_TOKEN, 'ghs_OLD_token');
  assert.equal(summary.failed.length, 1);
  assert.match(summary.failed[0].reason, /broker-unreachable/);
});



test('FAIL-SAFE: broker unreachable (fetch throws) keeps the existing token', async () => {
  _resetReviewerTokenRefreshClockForTest();
  const env = makeEnv();
  const fetchImpl = async () => { throw new Error('ECONNREFUSED'); };
  await refreshReviewerBrokerTokens({ env, now: 1, fetchImpl, readFileImpl: readSecret, log: silentLog });
  assert.equal(env.GH_CLAUDE_REVIEWER_TOKEN, 'ghs_OLD_token');
});

test('FAIL-SAFE: invalid reviewer timeout config keeps the existing token', async () => {
  _resetReviewerTokenRefreshClockForTest();
  const env = makeEnv({ ADVERSARIAL_REVIEWER_TIMEOUT_MS: 'not-a-number' });
  const fetchImpl = async () =>
    brokerOk('github-app-claude-reviewer', 'ghs_FRESH_token', {
      expiresAt: new Date(1 + HOUR_MS).toISOString(),
    });
  const summary = await refreshReviewerBrokerTokens({
    env,
    now: 1,
    fetchImpl,
    readFileImpl: readSecret,
    log: silentLog,
  });
  assert.equal(env.GH_CLAUDE_REVIEWER_TOKEN, 'ghs_OLD_token');
  assert.equal(summary.failed.length, 1);
  assert.match(summary.failed[0].reason, /reviewer\.timeout_ms/);
});







test('does NOT fetch for a reviewer role whose broker flag is not "true"', async () => {
  _resetReviewerTokenRefreshClockForTest();
  const env = makeEnv({ CLAUDE_REVIEWER_AUTH_VIA_BROKER: 'false' });
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return brokerOk('github-app-claude-reviewer', 'x'); };
  const summary = await refreshReviewerBrokerTokens({
    env, now: 1, fetchImpl, readFileImpl: readSecret, log: silentLog,
  });
  assert.equal(calls, 0);
  assert.equal(env.GH_CLAUDE_REVIEWER_TOKEN, 'ghs_OLD_token');
  assert.ok(summary.skipped.some((s) => s.role === 'claude-reviewer' && s.reason === 'broker-mode-disabled'));
});

test('refreshes multiple enabled roles independently; one failing does not block the other', async () => {
  _resetReviewerTokenRefreshClockForTest();
  const env = makeEnv({
    CODEX_REVIEWER_AUTH_VIA_BROKER: 'true',
    GH_CODEX_REVIEWER_TOKEN: 'ghs_OLD_codex',
  });
  const fetchImpl = async (url) => {
    if (url.includes('github-app-codex-reviewer')) throw new Error('broker hiccup');
    return brokerOk('github-app-claude-reviewer', 'ghs_FRESH_claude', {
      expiresAt: new Date(Date.now() + HOUR_MS).toISOString(),
    });
  };
  const summary = await refreshReviewerBrokerTokens({
    env, now: 1, fetchImpl, readFileImpl: readSecret, log: silentLog,
  });
  assert.equal(env.GH_CLAUDE_REVIEWER_TOKEN, 'ghs_FRESH_claude'); // succeeded
  assert.equal(env.GH_CODEX_REVIEWER_TOKEN, 'ghs_OLD_codex'); // failed → unchanged
  assert.equal(summary.refreshed.length, 1);
  assert.equal(summary.failed.length, 1);
});


test('honors process.env.REVIEWER_TOKEN_POST_SLACK_MS in the min-lifetime calculation', async () => {
  _resetReviewerTokenRefreshClockForTest();
  // resolveReviewerTimeoutMs default is 20m. With a large post-slack the
  // required lifetime exceeds a 25-min token, so the handoff is unsafe; the
  // built-in 2-min slack would have cleared it.
  const env = makeEnv({ REVIEWER_TOKEN_POST_SLACK_MS: String(10 * 60 * 1000) }); // 10m → required 30m
  const t0 = 4_000_000;
  const fetchImpl = async () =>
    brokerOk('github-app-claude-reviewer', 'ghs_25m', {
      expiresAt: new Date(t0 + 25 * 60 * 1000).toISOString(), // 25m < 30m required
    });
  const summary = await refreshReviewerBrokerTokens({
    env, now: t0, fetchImpl, readFileImpl: readSecret, log: silentLog, // no explicit postSlackMs → env wins
  });
  // Still the freshest token: installed, but below the 30m floor.
  assert.equal(env.GH_CLAUDE_REVIEWER_TOKEN, 'ghs_25m');
  assert.equal(summary.handoffSafe[0].safe, false);
  assert.equal(summary.handoffSafe[0].requiredLifetimeMs, 30 * 60 * 1000);
});

test('an invalid env knob falls back to the built-in default (does not disable the bound)', async () => {
  _resetReviewerTokenRefreshClockForTest();
  const env = makeEnv({ REVIEWER_TOKEN_POST_SLACK_MS: 'not-a-number' });
  const t0 = 4_000_000;
  // 25m token: with the DEFAULT 2-min slack, required ~22m, so 25m is accepted.
  const fetchImpl = async () =>
    brokerOk('github-app-claude-reviewer', 'ghs_25m', {
      expiresAt: new Date(t0 + 25 * 60 * 1000).toISOString(),
    });
  await refreshReviewerBrokerTokens({ env, now: t0, fetchImpl, readFileImpl: readSecret, log: silentLog });
  assert.equal(env.GH_CLAUDE_REVIEWER_TOKEN, 'ghs_25m'); // accepted under the fallback default
});

test('role table covers the four reviewer families', () => {
  const roles = BROKER_REVIEWER_ROLES.map((r) => r.role).sort();
  assert.deepEqual(roles, ['claude-reviewer', 'codex-reviewer', 'gemini-reviewer', 'grok-reviewer']);
});

test('gemini-reviewer role registers the canonical GH_GEMINI_REVIEWER_TOKEN env var and flag', () => {
  const gemini = BROKER_REVIEWER_ROLES.find((r) => r.role === 'gemini-reviewer');
  assert.ok(gemini, 'gemini-reviewer role must be registered');
  assert.equal(gemini.envVar, 'GH_GEMINI_REVIEWER_TOKEN');
  assert.equal(gemini.flag, 'GEMINI_REVIEWER_AUTH_VIA_BROKER');
});

test('broker activation reads GEMINI_REVIEWER_AUTH_VIA_BROKER and resolves the gemini-reviewer role', async () => {
  _resetReviewerTokenRefreshClockForTest();
  const env = makeEnv({
    // Only the gemini flag is on; claude defaults to true in makeEnv so disable it
    // to prove the gemini role activates independently off its own flag.
    CLAUDE_REVIEWER_AUTH_VIA_BROKER: 'false',
    GEMINI_REVIEWER_AUTH_VIA_BROKER: 'true',
    GH_GEMINI_REVIEWER_TOKEN: 'ghs_OLD_gemini',
  });
  let calledUrl = null;
  const fetchImpl = async (url) => {
    calledUrl = url;
    return brokerOk('github-app-gemini-reviewer', 'ghs_FRESH_gemini', {
      expiresAt: new Date(1_000_000 + HOUR_MS).toISOString(),
    });
  };
  const summary = await refreshReviewerBrokerTokens({
    env, now: 1_000_000, fetchImpl, readFileImpl: readSecret, log: silentLog,
  });
  assert.match(calledUrl, /\/token\?provider=github-app-gemini-reviewer$/);
  assert.equal(env.GH_GEMINI_REVIEWER_TOKEN, 'ghs_FRESH_gemini');
  assert.ok(summary.refreshed.some((r) => r.role === 'gemini-reviewer' && r.envVar === 'GH_GEMINI_REVIEWER_TOKEN'));
  // claude is flag-disabled → skipped, token untouched.
  assert.ok(summary.skipped.some((s) => s.role === 'claude-reviewer' && s.reason === 'broker-mode-disabled'));
  assert.equal(env.GH_CLAUDE_REVIEWER_TOKEN, 'ghs_OLD_token');
});

test('resolveReviewerAppToken resolves the gemini-reviewer-lacey identity to GH_GEMINI_REVIEWER_TOKEN', async () => {
  const env = makeEnv({ GH_GEMINI_REVIEWER_TOKEN: 'ghs_old_gemini' });
  let calledUrl = null;
  const resolved = await resolveReviewerAppToken('gemini-reviewer-lacey', {
    env,
    readFileImpl: readSecret,
    fetchImpl: async (url) => {
      calledUrl = url;
      return brokerOk('github-app-gemini-reviewer', 'ghs_gemini_fresh');
    },
  });
  assert.equal(resolved.role, 'gemini-reviewer');
  assert.equal(resolved.envVar, 'GH_GEMINI_REVIEWER_TOKEN');
  assert.equal(resolved.token, 'ghs_gemini_fresh');
  assert.match(calledUrl, /\/token\?provider=github-app-gemini-reviewer$/);
  assert.equal(env.GH_GEMINI_REVIEWER_TOKEN, 'ghs_gemini_fresh');
});

// ── Watcher's OWN GitHub token (rate-limit isolation) ────────────────────────

function makeWatcherEnv(overrides = {}) {
  return {
    WATCHER_GH_AUTH_VIA_BROKER: 'true',
    OAUTH_BROKER_URL: 'http://127.0.0.1:4099',
    OAUTH_BROKER_SHARED_SECRET_FILE: SECRET_FILE,
    GITHUB_TOKEN: 'ghp_OLD_operator_pat',
    GH_TOKEN: 'ghp_OLD_operator_pat',
    ...overrides,
  };
}

test('refreshFollowUpGithubToken: refreshes both GitHub env vars from merge-agent broker', async () => {
  _resetReviewerTokenRefreshClockForTest();
  const env = makeFollowUpEnv();
  let calledUrl = null;
  const summary = await refreshFollowUpGithubToken({
    env,
    now: 1_000_000,
    fetchImpl: async (url) => {
      calledUrl = url;
      return brokerOk(`github-app-${DEFAULT_FOLLOW_UP_GH_BROKER_ROLE}`, 'ghs_FOLLOW_UP', {
        expiresAt: new Date(1_000_000 + HOUR_MS).toISOString(),
      });
    },
    readFileImpl: readSecret,
    log: silentLog,
  });
  assert.equal(summary.refreshed, true);
  assert.equal(summary.role, DEFAULT_FOLLOW_UP_GH_BROKER_ROLE);
  assert.equal(env.GITHUB_TOKEN, 'ghs_FOLLOW_UP');
  assert.equal(env.GH_TOKEN, 'ghs_FOLLOW_UP');
  assert.match(calledUrl, /provider=github-app-merge-agent$/);
});

test('refreshFollowUpGithubToken: broker failure preserves the current token', async () => {
  _resetReviewerTokenRefreshClockForTest();
  const env = makeFollowUpEnv({ GITHUB_TOKEN: 'ghs_STILL_VALID', GH_TOKEN: 'ghs_STILL_VALID' });
  const summary = await refreshFollowUpGithubToken({
    env,
    now: 1_000_000,
    fetchImpl: async () => { throw new Error('broker unreachable'); },
    readFileImpl: readSecret,
    log: silentLog,
  });
  assert.match(summary.failed, /adapter-token-refused/);
  assert.equal(env.GITHUB_TOKEN, 'ghs_STILL_VALID');
  assert.equal(env.GH_TOKEN, 'ghs_STILL_VALID');
});

test('refreshWatcherGithubToken: sets GITHUB_TOKEN + GH_TOKEN from the broker App token (default role)', async () => {
  _resetReviewerTokenRefreshClockForTest();
  const env = makeWatcherEnv();
  let calledUrl = null;
  const fetchImpl = async (url) => {
    calledUrl = url;
    return brokerOk(`github-app-${DEFAULT_WATCHER_GH_BROKER_ROLE}`, 'ghs_APP_token', {
      expiresAt: new Date(1_000_000 + HOUR_MS).toISOString(),
    });
  };
  const summary = await refreshWatcherGithubToken({
    env, now: 1_000_000, fetchImpl, readFileImpl: readSecret, log: silentLog,
  });
  assert.equal(summary.refreshed, true);
  assert.equal(summary.role, DEFAULT_WATCHER_GH_BROKER_ROLE);
  // BOTH env vars flip to the App token (octokit reads GITHUB_TOKEN, gh CLI GH_TOKEN).
  for (const envVar of WATCHER_GH_TOKEN_ENV_VARS) {
    assert.equal(env[envVar], 'ghs_APP_token', `${envVar} should be the App token`);
  }
  assert.match(calledUrl, new RegExp(`/token\\?provider=github-app-${DEFAULT_WATCHER_GH_BROKER_ROLE}$`));
});


test('refreshWatcherGithubToken: no-op (skipped) when the flag is not true — keeps the PAT', async () => {
  _resetReviewerTokenRefreshClockForTest();
  const env = makeWatcherEnv({ WATCHER_GH_AUTH_VIA_BROKER: '' });
  let fetched = false;
  const summary = await refreshWatcherGithubToken({
    env, now: 1_000_000, fetchImpl: async () => { fetched = true; return brokerOk('x', 'y'); },
    readFileImpl: readSecret, log: silentLog,
  });
  assert.equal(summary.skipped, 'broker-mode-disabled');
  assert.equal(fetched, false, 'must not touch the broker when disabled');
  assert.equal(env.GITHUB_TOKEN, 'ghp_OLD_operator_pat', 'PAT left intact');
});

test('refreshWatcherGithubToken: FAIL-SAFE — broker error keeps the existing token', async () => {
  _resetReviewerTokenRefreshClockForTest();
  const env = makeWatcherEnv({ GITHUB_TOKEN: 'ghs_STILL_VALID', GH_TOKEN: 'ghs_STILL_VALID' });
  const fetchImpl = async () => { throw new Error('broker unreachable'); };
  const summary = await refreshWatcherGithubToken({
    env, now: 1_000_000, fetchImpl, readFileImpl: readSecret, log: silentLog,
  });
  assert.equal(summary.refreshed, false);
  assert.ok(summary.failed && /adapter-token-refused/.test(summary.failed));
  // The whole point: a broker blip NEVER blanks a working token.
  assert.equal(env.GITHUB_TOKEN, 'ghs_STILL_VALID');
  assert.equal(env.GH_TOKEN, 'ghs_STILL_VALID');
});


// REVTOKENFLOOR-01: under host load the reviewer run time scales past the
// provider's 60-minute token lifetime. These pin the load-scaled run time via
// reviewerRunTimeoutMs so the host's real load cannot move them.
const MINUTE_MS = 60 * 1000;
const HIGH_LOAD_RUN_MS = 120 * MINUTE_MS; // 6x a 20-minute reviewer timeout
const NORMAL_LOAD_RUN_MS = 20 * MINUTE_MS;

function freshHourToken(token) {
  return (now) => brokerOk('github-app-claude-reviewer', token, {
    expiresAt: new Date(now + HOUR_MS).toISOString(),
  });
}

test('REVTOKENFLOOR-01: under a high load multiplier a fresh 60-minute token is installed and the shortfall recorded once', async () => {
  _resetReviewerTokenRefreshClockForTest();
  const env = makeEnv();
  const t0 = 20_000_000;
  const warnings = [];
  // Other roles emit their own disabled warnings after each test reset.
  const log = { warn: (message) => {
    if (message.includes('GH_CLAUDE_REVIEWER_TOKEN')) warnings.push(message);
  } };
  let curNow = t0;
  let calls = 0;
  const mint = freshHourToken('ghs_fresh_hour');
  const fetchImpl = async () => { calls += 1; return mint(curNow); };
  const opts = { env, fetchImpl, readFileImpl: readSecret, log, reviewerRunTimeoutMs: HIGH_LOAD_RUN_MS };

  const summary = await refreshReviewerBrokerTokens({ ...opts, now: curNow });
  assert.equal(env.GH_CLAUDE_REVIEWER_TOKEN, 'ghs_fresh_hour');
  assert.equal(summary.failed.length, 0);
  const loadScaledLifetimeMs = HIGH_LOAD_RUN_MS + REVIEWER_TOKEN_POST_SLACK_MS;
  assert.deepEqual(
    {
      requiredLifetimeMs: summary.refreshed[0].requiredLifetimeMs,
      loadScaledLifetimeMs: summary.refreshed[0].loadScaledLifetimeMs,
      handoffShortfallMs: summary.refreshed[0].handoffShortfallMs,
    },
    {
      requiredLifetimeMs: HOUR_MS - REVIEWER_TOKEN_REFRESH_SKEW_MS,
      loadScaledLifetimeMs,
      handoffShortfallMs: loadScaledLifetimeMs - HOUR_MS,
    },
  );
  assert.equal(summary.handoffSafe[0].safe, true);
  assert.equal(summary.handoffSafe[0].handoffShortfallMs, loadScaledLifetimeMs - HOUR_MS);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /installed the freshest GH_CLAUDE_REVIEWER_TOKEN/);
  assert.doesNotMatch(warnings[0], /ghs_fresh_hour/);

  // The next refresh in the same short episode does not log again.
  curNow = t0 + REVIEWER_TOKEN_REFRESH_SKEW_MS + 1;
  await refreshReviewerBrokerTokens({ ...opts, now: curNow });
  assert.equal(calls, 2);
  assert.equal(warnings.length, 1);
  // A token that covers the run ends the episode; the next shortfall logs.
  curNow += REVIEWER_TOKEN_REFRESH_SKEW_MS + 1;
  await refreshReviewerBrokerTokens({ ...opts, now: curNow, reviewerRunTimeoutMs: NORMAL_LOAD_RUN_MS });
  assert.equal(calls, 3);
  curNow += HOUR_MS;
  await refreshReviewerBrokerTokens({ ...opts, now: curNow });
  assert.equal(calls, 4);
  assert.equal(warnings.length, 2);
});

test('REVTOKENFLOOR-01: a fetched token that expires sooner than the held one is not installed', async () => {
  _resetReviewerTokenRefreshClockForTest();
  const env = makeEnv();
  const t0 = 21_000_000;
  const opts = { env, readFileImpl: readSecret, log: silentLog, reviewerRunTimeoutMs: HIGH_LOAD_RUN_MS };
  await refreshReviewerBrokerTokens({ ...opts, now: t0, fetchImpl: async () => freshHourToken('ghs_held')(t0) });
  assert.equal(env.GH_CLAUDE_REVIEWER_TOKEN, 'ghs_held');

  const summary = await refreshReviewerBrokerTokens({
    ...opts,
    now: t0 + MINUTE_MS,
    force: true,
    fetchImpl: async () => brokerOk('github-app-claude-reviewer', 'ghs_older', {
      expiresAt: new Date(t0 + HOUR_MS - MINUTE_MS).toISOString(),
    }),
  });
  assert.equal(env.GH_CLAUDE_REVIEWER_TOKEN, 'ghs_held');
  assert.equal(summary.refreshed.length, 0);
  assert.match(summary.failed[0].reason, /expires before the held GH_CLAUDE_REVIEWER_TOKEN/);
  assert.equal(summary.handoffSafe[0].expiresAtMs, t0 + HOUR_MS);
});

test('REVTOKENFLOOR-01: a fetched token that has already expired is not installed', async () => {
  _resetReviewerTokenRefreshClockForTest();
  const env = makeEnv();
  const t0 = 21_500_000;
  const summary = await refreshReviewerBrokerTokens({
    env,
    now: t0,
    readFileImpl: readSecret,
    log: silentLog,
    fetchImpl: async () => brokerOk('github-app-claude-reviewer', 'ghs_expired', {
      expiresAt: new Date(t0).toISOString(),
    }),
  });
  assert.equal(env.GH_CLAUDE_REVIEWER_TOKEN, 'ghs_OLD_token');
  assert.match(summary.failed[0].reason, /adapter-token-expired/);
});

test('REVTOKENFLOOR-01: the floor is capped below the token lifetime and the refresh is scheduled from it, not every tick', async () => {
  _resetReviewerTokenRefreshClockForTest();
  const env = makeEnv();
  const t0 = 22_000_000;
  let calls = 0;
  let curNow = t0;
  const mint = freshHourToken('ghs_fresh_hour');
  const fetchImpl = async () => { calls += 1; return mint(curNow); };
  const opts = { env, fetchImpl, readFileImpl: readSecret, log: silentLog, reviewerRunTimeoutMs: HIGH_LOAD_RUN_MS };
  const cappedFloorMs = HOUR_MS - REVIEWER_TOKEN_REFRESH_SKEW_MS;

  await refreshReviewerBrokerTokens({ ...opts, now: curNow });
  assert.equal(calls, 1);
  // Watcher ticks before expiry - capped floor: no re-fetch, handoff safe.
  for (const offsetMs of [1, MINUTE_MS, 5 * MINUTE_MS, HOUR_MS - cappedFloorMs - 1]) {
    curNow = t0 + offsetMs;
    const tick = await refreshReviewerBrokerTokens({ ...opts, now: curNow });
    assert.deepEqual(tick.skipped[0], { role: 'claude-reviewer', reason: 'token-still-valid' });
    assert.equal(tick.handoffSafe[0].safe, true);
    assert.equal(tick.handoffSafe[0].requiredLifetimeMs, cappedFloorMs);
  }
  assert.equal(calls, 1);
  curNow = t0 + HOUR_MS - cappedFloorMs + 1;
  await refreshReviewerBrokerTokens({ ...opts, now: curNow });
  assert.equal(calls, 2);
});

test('REVTOKENFLOOR-01: a re-served cached token caps its floor at its remaining lifetime', async () => {
  // The broker keeps serving one cached token until it re-mints near expiry.
  // Each re-fetch lowers the cap with the token's remaining lifetime, so the
  // loop still waits between fetches instead of re-fetching every tick.
  _resetReviewerTokenRefreshClockForTest();
  const env = makeEnv();
  const t0 = 23_000_000;
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return brokerOk('github-app-claude-reviewer', 'ghs_cached', {
      expiresAt: new Date(t0 + HOUR_MS).toISOString(),
    });
  };
  const opts = { env, fetchImpl, readFileImpl: readSecret, log: silentLog, reviewerRunTimeoutMs: HIGH_LOAD_RUN_MS };
  await refreshReviewerBrokerTokens({ ...opts, now: t0 });
  const second = await refreshReviewerBrokerTokens({ ...opts, now: t0 + REVIEWER_TOKEN_REFRESH_SKEW_MS });
  assert.equal(calls, 2);
  assert.equal(second.refreshed[0].requiredLifetimeMs, HOUR_MS - 2 * REVIEWER_TOKEN_REFRESH_SKEW_MS);
  await refreshReviewerBrokerTokens({ ...opts, now: t0 + REVIEWER_TOKEN_REFRESH_SKEW_MS + 1 });
  assert.equal(calls, 2);
});

for (const minTokenLifetimeMs of [null, 50 * MINUTE_MS]) {
  test(`REVTOKENFLOOR-01: cached tokens below the ${minTokenLifetimeMs == null ? 'nominal reviewer' : 'fixed remediation'} floor wait before fetching again`, async () => {
    _resetReviewerTokenRefreshClockForTest();
    const env = makeEnv();
    const t0 = 23_500_000;
    const floorMs = minTokenLifetimeMs ?? NORMAL_LOAD_RUN_MS + REVIEWER_TOKEN_POST_SLACK_MS;
    const retryMs = 30_000;
    const due = t0 + HOUR_MS - floorMs;
    let calls = 0;
    const opts = {
      env, minTokenLifetimeMs, reviewerRunTimeoutMs: NORMAL_LOAD_RUN_MS,
      nominalReviewerRunTimeoutMs: NORMAL_LOAD_RUN_MS, failureRetryMs: retryMs,
      readFileImpl: readSecret, log: silentLog,
      fetchImpl: async () => {
        calls += 1;
        return brokerOk('github-app-claude-reviewer', calls < 3 ? 'ghs_cached' : 'ghs_rotated', {
          expiresAt: new Date(calls < 3 ? t0 + HOUR_MS : due + retryMs + HOUR_MS).toISOString(),
        });
      },
    };
    await refreshReviewerBrokerTokens({ ...opts, now: t0 });
    const cached = await refreshReviewerBrokerTokens({ ...opts, now: due });
    assert.equal(calls, 2);
    assert.equal(cached.handoffSafe[0].safe, false);
    assert.equal(env.GH_CLAUDE_REVIEWER_TOKEN, 'ghs_cached');
    for (const offset of [1, 1_000, retryMs - 1]) {
      const waiting = await refreshReviewerBrokerTokens({ ...opts, now: due + offset });
      assert.equal(calls, 2, 'cached response must not cause per-tick broker polling');
      assert.equal(waiting.handoffSafe[0].safe, false, 'waiting cannot admit an unsafe handoff');
    }
    const rotated = await refreshReviewerBrokerTokens({ ...opts, now: due + retryMs });
    assert.equal(calls, 3, 'retry at the configured boundary discovers rotation');
    assert.equal(env.GH_CLAUDE_REVIEWER_TOKEN, 'ghs_rotated');
    assert.equal(rotated.handoffSafe[0].safe, true);
  });
}

test('REVTOKENFLOOR-01: a startup token inside the refresh skew waits the default retry interval', async () => {
  _resetReviewerTokenRefreshClockForTest();
  const env = makeEnv();
  const t0 = 23_750_000;
  let calls = 0;
  const opts = {
    env, minTokenLifetimeMs: 5 * MINUTE_MS, readFileImpl: readSecret, log: silentLog,
    fetchImpl: async () => {
      calls += 1;
      return brokerOk('github-app-claude-reviewer', 'ghs_short', {
        expiresAt: new Date(t0 + 10 * MINUTE_MS).toISOString(),
      });
    },
  };
  const first = await refreshReviewerBrokerTokens({ ...opts, now: t0 });
  assert.equal(first.handoffSafe[0].safe, true);
  assert.equal(env.GH_CLAUDE_REVIEWER_TOKEN, 'ghs_short');
  await refreshReviewerBrokerTokens({ ...opts, now: t0 + REVIEWER_TOKEN_FAILURE_RETRY_MS - 1 });
  assert.equal(calls, 1);
  await refreshReviewerBrokerTokens({ ...opts, now: t0 + REVIEWER_TOKEN_FAILURE_RETRY_MS });
  assert.equal(calls, 2);
});

test('REVTOKENFLOOR-01: under normal load the floor and schedule are unchanged', async () => {
  _resetReviewerTokenRefreshClockForTest();
  const env = makeEnv();
  const t0 = 24_000_000;
  const warnings = [];
  let calls = 0;
  let curNow = t0;
  const mint = freshHourToken('ghs_fresh_hour');
  const fetchImpl = async () => { calls += 1; return mint(curNow); };
  const opts = {
    env, fetchImpl, readFileImpl: readSecret, log: { warn: (message) => {
      if (message.includes('GH_CLAUDE_REVIEWER_TOKEN')) warnings.push(message);
    } }, reviewerRunTimeoutMs: NORMAL_LOAD_RUN_MS,
  };
  const floorMs = NORMAL_LOAD_RUN_MS + REVIEWER_TOKEN_POST_SLACK_MS;

  const summary = await refreshReviewerBrokerTokens({ ...opts, now: curNow });
  assert.equal(summary.refreshed[0].requiredLifetimeMs, floorMs);
  assert.equal(summary.refreshed[0].handoffShortfallMs, 0);
  assert.equal(summary.handoffSafe[0].safe, true);
  curNow = t0 + HOUR_MS - floorMs - 1;
  await refreshReviewerBrokerTokens({ ...opts, now: curNow });
  assert.equal(calls, 1);
  curNow = t0 + HOUR_MS - floorMs + 1;
  await refreshReviewerBrokerTokens({ ...opts, now: curNow });
  assert.equal(calls, 2);
  assert.deepEqual(warnings, []);
});

test('REVTOKENFLOOR-01: at maximum real host load the configured floor is capped and a fresh token is installed', async (t) => {
  // No injected run time: the floor goes through the load-aware reviewer
  // timeout, as in production.
  const { underMaxLoad } = await import('./helpers/load-time-kit.mjs');
  const multiplier = underMaxLoad(t);
  _resetReviewerTokenRefreshClockForTest();
  const env = makeEnv();
  const t0 = 25_000_000;
  const summary = await refreshReviewerBrokerTokens({
    env, now: t0, readFileImpl: readSecret, log: silentLog, fetchImpl: async () => freshHourToken('ghs_fresh_hour')(t0),
  });
  assert.equal(env.GH_CLAUDE_REVIEWER_TOKEN, 'ghs_fresh_hour');
  assert.equal(summary.refreshed[0].loadScaledLifetimeMs, 20 * MINUTE_MS * multiplier + REVIEWER_TOKEN_POST_SLACK_MS);
  assert.equal(summary.refreshed[0].requiredLifetimeMs, HOUR_MS - REVIEWER_TOKEN_REFRESH_SKEW_MS);
  assert.equal(summary.handoffSafe[0].safe, true);
});

test('adapter bind uses verified installation metadata and passes the timeout', async () => {
  _resetReviewerTokenRefreshClockForTest();
  const env = makeWatcherEnv({ REVIEWER_TOKEN_FETCH_TIMEOUT_MS: '250' });
  const result = await refreshWatcherGithubToken({ env, log: silentLog,
    execFileImpl: tokenFixture(({ role, repo, timeout }) => {
      assert.equal(role, 'merge-agent');
      assert.match(repo, /\/adversarial-review$/);
      assert.ok(timeout >= 250);
      return { access_token: 'fixture-installation-token', provider: 'github-app-merge-agent',
        metadata: { app_id: 123, installation_id: 456, credential_source: 'github_app_installation' } };
    }),
  });
  assert.equal(result.refreshed, true);
  assert.equal(githubCredential({ token: env.GH_TOKEN }), 'installation-123-456');
});

for (const refresh of [refreshWatcherGithubToken, refreshFollowUpGithubToken]) {
  test(`${refresh.name} refuses routed service refresh without changing env or clock`, async t => {
    t.mock.method(githubOwnerTokens, 'routedOwner', repo => repo?.startsWith('alternate-fixture/') ? 'alternate-fixture' : null);
    _resetReviewerTokenRefreshClockForTest();
    const env = { ...makeFollowUpEnv(), WATCHER_GH_AUTH_VIA_BROKER: 'true' };
    const before = { ...env, GHA_ADAPTER_BIN: fixtureAdapterBin };
    const skipped = await refresh({ env, repo: 'alternate-fixture/project', now: 1000,
      execFileImpl: () => assert.fail('routed repo must not mint a shared service token') });
    assert.equal(skipped.skipped, 'owner-routed-repository');
    assert.deepEqual(env, before);
    const home = await refresh({ env, now: 1000, log: silentLog,
      execFileImpl: tokenFixture(() => ({ access_token: 'home-only', provider: 'github-app-merge-agent' })) });
    assert.equal(home.refreshed, true, `refused route must not advance the home refresh clock: ${JSON.stringify(home)}`);
    assert.equal(env.GH_TOKEN, 'home-only');
  });
}

for (const code of ['github-app-token-unavailable', 'broker-unreachable', 'github-rate-limited', 'rate-limit-exceeded']) {
  test(`structured ${code} is transient even with adapter exit 1`, async () => {
    await assert.rejects(fetchReviewerTokenFromBroker({
      role: 'merge-agent', repo: 'fixture/repo', env: { GHA_ADAPTER_BIN: fixtureAdapterBin },
      execFileImpl: async () => { throw Object.assign(new Error('private adapter detail'), {
        code: 1, stdout: JSON.stringify({ ok: false, code }),
      }); },
    }), err => err.transient === true && !err.message.includes('private adapter detail'));
  });
}

for (const source of [undefined, 'unknown', 'github_app_installation', 'github_pat_fallback']) {
  test(`installation budget requires positive credential source: ${source}`, async () => {
    const token = `source-fixture-${source}`;
    const request = {
      role: 'merge-agent', repo: 'fixture/repo', env: { GHA_ADAPTER_BIN: fixtureAdapterBin },
      execFileImpl: tokenFixture(() => ({ access_token: token, provider: 'github-app-merge-agent',
        metadata: { app_id: 789, installation_id: 987, credential_source: source } })),
    };
    if (source === 'github_pat_fallback') {
      await assert.rejects(fetchReviewerTokenFromBroker(request), /pat-fallback/);
    } else {
      await fetchReviewerTokenFromBroker(request);
      assert.equal(githubCredential({ token }) === 'installation-789-987', source === 'github_app_installation');
    }
  });
}

test('cold sync mint has a fixed heartbeat-safe bound even under a large caller budget', () => {
  const token = fetchReviewerTokenFromBrokerSync({
    role: 'merge-agent', repo: 'fixture/repo', env: { GHA_ADAPTER_BIN: fixtureAdapterBin }, timeoutMs: 120_000,
    execFileSyncImpl: (_bin, _args, options) => {
      assert.equal(options.timeout, SYNC_TOKEN_TIMEOUT_MS);
      assert.equal(options.env.AGENT_OS_GITHUB_ADAPTER_RETRY_MAX_ATTEMPTS, '1');
      return JSON.stringify({ ok: true, provider: 'github-app-merge-agent', access_token: 'sync-fixture' });
    },
  });
  assert.equal(token.token, 'sync-fixture');
});

test('CLI seam permits standby success without a wall-clock primary sleep', async t => {
  const root = mkdtempSync(join(tmpdir(), 'broker-standby-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, 'adapter');
  writeFileSync(bin, `#!${process.execPath}
if (process.env.AGENT_OS_GITHUB_ADAPTER_RETRY_MAX_ATTEMPTS !== '1') process.exit(1);
if (!process.env.OAUTH_BROKER_URL_FALLBACK) process.exit(1);
console.log(JSON.stringify({
  ok: true, provider: 'github-app-merge-agent', access_token: 'standby-fixture'
}));
`, { mode: 0o755 });
  const env = { GHA_ADAPTER_BIN: bin, OAUTH_BROKER_URL: 'http://primary.fixture',
    OAUTH_BROKER_URL_FALLBACK: 'http://standby.fixture' };
  assert.equal(brokerTokenTimeoutMs(env), 21_000);
  assert.equal(brokerTokenTimeoutMs({ ...env, OAUTH_BROKER_URL_FALLBACK: env.OAUTH_BROKER_URL }), 11_000);
  const result = await fetchReviewerTokenFromBroker({
    role: 'merge-agent', repo: 'fixture/repo', env, execFileImpl: promisify(execFile),
  });
  assert.equal(result.token, 'standby-fixture');
});

test('adapter invocation reserves the full primary and standby timeout budget', async () => {
  let calls = 0;
  await fetchReviewerTokenFromBroker({
    role: 'merge-agent', repo: 'fixture/repo',
    env: { GHA_ADAPTER_BIN: fixtureAdapterBin, OAUTH_BROKER_URL: 'http://primary.fixture',
      OAUTH_BROKER_URL_FALLBACK: 'http://standby.fixture' },
    execFileImpl: async (_bin, _args, options) => {
      calls++;
      assert.equal(options.timeout, 21_000);
      assert.equal(options.env.AGENT_OS_GITHUB_ADAPTER_RETRY_MAX_ATTEMPTS, '1');
      return { stdout: JSON.stringify({ ok: true, provider: 'github-app-merge-agent', access_token: 'standby-fixture' }) };
    },
  });
  assert.equal(calls, 1);
});
