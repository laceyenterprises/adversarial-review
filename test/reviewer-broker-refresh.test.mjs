import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  refreshReviewerBrokerTokens,
  refreshWatcherGithubToken,
  resolveReviewerAppToken,
  resolveWatcherGhBrokerRole,
  _resetReviewerTokenRefreshClockForTest,
  REVIEWER_TOKEN_REFRESH_SKEW_MS,
  REVIEWER_TOKEN_FALLBACK_TTL_MS,
  REVIEWER_TOKEN_POST_SLACK_MS,
  REVIEWER_TOKEN_FAILURE_RETRY_MS,
  BROKER_REVIEWER_ROLES,
  WATCHER_GH_TOKEN_ENV_VARS,
  DEFAULT_WATCHER_GH_BROKER_ROLE,
} from '../src/reviewer-broker-refresh.mjs';

const SECRET_FILE = '/secret/oauth-broker-shared-secret';
const HOUR_MS = 60 * 60 * 1000;

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

test('rejects a cached token that cannot survive reviewer timeout plus post slack', async () => {
  // Reproduces the real broker behavior: the first response is a cached token
  // with only a few minutes of life left. A reviewer subprocess snapshots env at
  // spawn and can run until the reviewer timeout before posting, so this token
  // must not be handed to a newly spawned reviewer.
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
  });
  assert.equal(env.GH_CLAUDE_REVIEWER_TOKEN, 'ghs_OLD_token');
  assert.equal(summary.failed.length, 1);
  assert.match(summary.failed[0].reason, /expires too soon/);
});

test('rejects a cached token that clears reviewer timeout but not remediation handoff floor', async () => {
  // A 30m cached installation token is long enough for the default reviewer
  // floor (~22m), but too short for a detached remediation worker handoff.
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
  assert.equal(env.GH_CLAUDE_REVIEWER_TOKEN, 'ghs_OLD_token');
  assert.equal(summary.failed.length, 1);
  assert.match(summary.failed[0].reason, /minimum=3000000ms/);
  assert.equal(summary.handoffSafe.length, 1);
  assert.equal(summary.handoffSafe[0].safe, false);
  assert.equal(summary.handoffSafe[0].reason, 'token-expiry-unknown');
});

test('marks an aged prior token unsafe when the broker returns the same too-short cached token', async () => {
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
  assert.equal(second.failed.length, 1);
  assert.match(second.failed[0].reason, /expires too soon/);
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

test('backs off briefly after a too-short broker token while keeping the existing token', async () => {
  _resetReviewerTokenRefreshClockForTest();
  const env = makeEnv();
  const t0 = 9_500_000;
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    const token = calls === 1 ? 'ghs_too_close' : 'ghs_long_enough';
    const lifetimeMs = calls === 1 ? 5 * 60 * 1000 : HOUR_MS;
    return brokerOk('github-app-claude-reviewer', token, {
      expiresAt: new Date(t0 + lifetimeMs).toISOString(),
    });
  };

  const first = await refreshReviewerBrokerTokens({
    env,
    now: t0,
    fetchImpl,
    readFileImpl: readSecret,
    log: silentLog,
    failureRetryMs: 30_000,
  });
  assert.equal(env.GH_CLAUDE_REVIEWER_TOKEN, 'ghs_OLD_token');
  assert.equal(first.failed.length, 1);
  assert.equal(calls, 1);

  const skipped = await refreshReviewerBrokerTokens({
    env,
    now: t0 + 1_000,
    fetchImpl,
    readFileImpl: readSecret,
    log: silentLog,
    failureRetryMs: 30_000,
  });
  assert.equal(calls, 1);
  assert.ok(skipped.skipped.some((s) => s.reason === 'broker-refresh-backoff'));
  assert.equal(env.GH_CLAUDE_REVIEWER_TOKEN, 'ghs_OLD_token');

  await refreshReviewerBrokerTokens({
    env,
    now: t0 + 30_001,
    fetchImpl,
    readFileImpl: readSecret,
    log: silentLog,
    failureRetryMs: 30_000,
  });
  assert.equal(calls, 2);
  assert.equal(env.GH_CLAUDE_REVIEWER_TOKEN, 'ghs_long_enough');
});

test('broker config rotation bypasses too-short-token backoff', async () => {
  _resetReviewerTokenRefreshClockForTest();
  const env = makeEnv();
  const t0 = 9_700_000;
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return brokerOk('github-app-claude-reviewer', `ghs_too_close_${calls}`, {
      expiresAt: new Date(t0 + 5 * 60 * 1000).toISOString(),
    });
  };

  await refreshReviewerBrokerTokens({
    env,
    now: t0,
    fetchImpl,
    readFileImpl: readSecret,
    log: silentLog,
    failureRetryMs: 60_000,
  });
  env.OAUTH_BROKER_URL = 'http://127.0.0.1:4199';
  await refreshReviewerBrokerTokens({
    env,
    now: t0 + 1_000,
    fetchImpl,
    readFileImpl: readSecret,
    log: silentLog,
    failureRetryMs: 60_000,
  });

  assert.equal(calls, 2);
  assert.equal(env.GH_CLAUDE_REVIEWER_TOKEN, 'ghs_OLD_token');
});

test('too-short-token backoff does not defer once the known existing token is near hard expiry', async () => {
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
  assert.match(summary.failed[0].reason, /HTTP 503/);
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

test('bounds the broker fetch with an abort signal + timeout', async () => {
  _resetReviewerTokenRefreshClockForTest();
  const env = makeEnv();
  let sawSignal = false;
  // A fetch that never resolves unless its abort signal fires → proves the
  // call is bounded (aborts) rather than hanging the poll loop forever.
  const fetchImpl = (url, opts) =>
    new Promise((_resolve, reject) => {
      sawSignal = opts.signal instanceof AbortSignal;
      opts.signal.addEventListener('abort', () => reject(new Error('aborted')));
    });
  const summary = await refreshReviewerBrokerTokens({
    env, now: 1, fetchImpl, readFileImpl: readSecret, log: silentLog, timeoutMs: 10,
  });
  assert.equal(sawSignal, true);
  assert.equal(env.GH_CLAUDE_REVIEWER_TOKEN, 'ghs_OLD_token'); // fail-safe on abort
  assert.equal(summary.failed.length, 1);
});

test('timeout covers a stalled BODY read (headers resolve, json() hangs until abort)', async () => {
  // Regression for the review finding: in Fetch the response promise resolves on
  // headers while the body may still stream. A broker that returns 200 headers
  // then stalls the JSON body must still be bounded by the abort timer — the
  // timer must remain armed through res.json(), and the shared signal must abort
  // the hanging body read.
  _resetReviewerTokenRefreshClockForTest();
  const env = makeEnv();
  let bodyAborted = false;
  const fetchImpl = async (url, opts) => ({
    ok: true,
    status: 200,
    // json() never resolves on its own; it only settles when the abort fires.
    json: () =>
      new Promise((_resolve, reject) => {
        opts.signal.addEventListener('abort', () => {
          bodyAborted = true;
          reject(new Error('aborted body read'));
        });
      }),
  });
  const summary = await refreshReviewerBrokerTokens({
    env, now: 1, fetchImpl, readFileImpl: readSecret, log: silentLog, timeoutMs: 10,
  });
  assert.equal(bodyAborted, true); // the timer aborted the stalled body read
  assert.equal(env.GH_CLAUDE_REVIEWER_TOKEN, 'ghs_OLD_token'); // fail-safe
  assert.equal(summary.failed.length, 1);
});

test('rejects a token minted for the wrong app_id (metadata mismatch), keeps old token', async () => {
  _resetReviewerTokenRefreshClockForTest();
  const env = makeEnv({ OAUTH_BROKER_CLAUDE_REVIEWER_EXPECTED_APP_ID: '111' });
  const fetchImpl = async () =>
    brokerOk('github-app-claude-reviewer', 'ghs_WRONG_app', { metadata: { app_id: '999', installation_id: '42' } });
  const summary = await refreshReviewerBrokerTokens({
    env, now: 1, fetchImpl, readFileImpl: readSecret, log: silentLog,
  });
  assert.equal(env.GH_CLAUDE_REVIEWER_TOKEN, 'ghs_OLD_token');
  assert.match(summary.failed[0].reason, /app_id/);
});

test('rejects a response with MISSING provider (matches the bash unconditional check)', async () => {
  _resetReviewerTokenRefreshClockForTest();
  const env = makeEnv();
  // provider field absent entirely
  const fetchImpl = async () => ({
    ok: true, status: 200,
    async json() { return { access_token: 'ghs_no_provider', metadata: {} }; },
  });
  const summary = await refreshReviewerBrokerTokens({
    env, now: 1, fetchImpl, readFileImpl: readSecret, log: silentLog,
  });
  assert.equal(env.GH_CLAUDE_REVIEWER_TOKEN, 'ghs_OLD_token'); // not accepted
  assert.match(summary.failed[0].reason, /provider/);
});

test('accepts a token whose metadata matches the expected app_id + installation_id', async () => {
  _resetReviewerTokenRefreshClockForTest();
  const env = makeEnv({
    OAUTH_BROKER_CLAUDE_REVIEWER_EXPECTED_APP_ID: '111',
    OAUTH_BROKER_CLAUDE_REVIEWER_EXPECTED_INSTALLATION_ID: '42',
  });
  const fetchImpl = async () =>
    brokerOk('github-app-claude-reviewer', 'ghs_GOOD', { metadata: { app_id: 111, installation_id: 42 } });
  await refreshReviewerBrokerTokens({ env, now: 1, fetchImpl, readFileImpl: readSecret, log: silentLog });
  assert.equal(env.GH_CLAUDE_REVIEWER_TOKEN, 'ghs_GOOD');
});

test('broker config rotation bypasses the old valid schedule and re-verifies metadata', async () => {
  _resetReviewerTokenRefreshClockForTest();
  const t0 = 12_000_000;
  const env = makeEnv({
    OAUTH_BROKER_CLAUDE_REVIEWER_EXPECTED_INSTALLATION_ID: '42',
  });
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return brokerOk('github-app-claude-reviewer', `ghs_token_${calls}`, {
      expiresAt: new Date(t0 + HOUR_MS).toISOString(),
      metadata: { installation_id: '42' },
    });
  };
  await refreshReviewerBrokerTokens({ env, now: t0, fetchImpl, readFileImpl: readSecret, log: silentLog });
  assert.equal(env.GH_CLAUDE_REVIEWER_TOKEN, 'ghs_token_1');

  env.OAUTH_BROKER_CLAUDE_REVIEWER_EXPECTED_INSTALLATION_ID = '99';
  const summary = await refreshReviewerBrokerTokens({
    env,
    now: t0 + 60_000,
    fetchImpl,
    readFileImpl: readSecret,
    log: silentLog,
  });

  assert.equal(calls, 2);
  assert.equal(env.GH_CLAUDE_REVIEWER_TOKEN, 'ghs_token_1');
  assert.equal(summary.failed.length, 1);
  assert.match(summary.failed[0].reason, /installation_id/);
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

test('honors process.env.REVIEWER_TOKEN_FETCH_TIMEOUT_MS (documented operator knob)', async () => {
  _resetReviewerTokenRefreshClockForTest();
  // A custom small timeout must be applied to the broker fetch. We prove it by
  // observing the abort fires (the fetch never resolves on its own).
  const env = makeEnv({ REVIEWER_TOKEN_FETCH_TIMEOUT_MS: '25' });
  let aborted = false;
  const fetchImpl = (url, opts) =>
    new Promise((_resolve, reject) => {
      opts.signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); });
    });
  const summary = await refreshReviewerBrokerTokens({
    env, now: 1, fetchImpl, readFileImpl: readSecret, log: silentLog, // no explicit timeoutMs → env wins
  });
  assert.equal(aborted, true);
  assert.equal(env.GH_CLAUDE_REVIEWER_TOKEN, 'ghs_OLD_token'); // fail-safe
  assert.equal(summary.failed.length, 1);
});

test('honors process.env.REVIEWER_TOKEN_POST_SLACK_MS in the min-lifetime calculation', async () => {
  _resetReviewerTokenRefreshClockForTest();
  // resolveReviewerTimeoutMs default is 20m. With a large post-slack the
  // required lifetime exceeds a 25-min token, so it must be REJECTED; the
  // built-in 2-min slack would have accepted it.
  const env = makeEnv({ REVIEWER_TOKEN_POST_SLACK_MS: String(10 * 60 * 1000) }); // 10m → required 30m
  const t0 = 4_000_000;
  const fetchImpl = async () =>
    brokerOk('github-app-claude-reviewer', 'ghs_25m', {
      expiresAt: new Date(t0 + 25 * 60 * 1000).toISOString(), // 25m < 30m required
    });
  const summary = await refreshReviewerBrokerTokens({
    env, now: t0, fetchImpl, readFileImpl: readSecret, log: silentLog, // no explicit postSlackMs → env wins
  });
  assert.equal(env.GH_CLAUDE_REVIEWER_TOKEN, 'ghs_OLD_token'); // rejected: 25m < 30m
  assert.equal(summary.failed.length, 1);
  assert.match(summary.failed[0].reason, /expires too soon/);
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

test('role table covers the three reviewer families', () => {
  const roles = BROKER_REVIEWER_ROLES.map((r) => r.role).sort();
  assert.deepEqual(roles, ['claude-reviewer', 'codex-reviewer', 'gemini-reviewer']);
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

test('refreshWatcherGithubToken: honors WATCHER_GH_BROKER_ROLE override', async () => {
  _resetReviewerTokenRefreshClockForTest();
  const env = makeWatcherEnv({ WATCHER_GH_BROKER_ROLE: 'adversarial-watcher' });
  assert.equal(resolveWatcherGhBrokerRole(env), 'adversarial-watcher');
  let calledUrl = null;
  const fetchImpl = async (url) => {
    calledUrl = url;
    return brokerOk('github-app-adversarial-watcher', 'ghs_DEDICATED', {
      expiresAt: new Date(1_000_000 + HOUR_MS).toISOString(),
    });
  };
  const summary = await refreshWatcherGithubToken({
    env, now: 1_000_000, fetchImpl, readFileImpl: readSecret, log: silentLog,
  });
  assert.equal(summary.refreshed, true);
  assert.equal(env.GITHUB_TOKEN, 'ghs_DEDICATED');
  assert.match(calledUrl, /provider=github-app-adversarial-watcher$/);
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
  assert.ok(summary.failed && /broker unreachable/.test(summary.failed));
  // The whole point: a broker blip NEVER blanks a working token.
  assert.equal(env.GITHUB_TOKEN, 'ghs_STILL_VALID');
  assert.equal(env.GH_TOKEN, 'ghs_STILL_VALID');
});

test('refreshWatcherGithubToken: rejects a token minted for the WRONG provider (no silent accept)', async () => {
  _resetReviewerTokenRefreshClockForTest();
  const env = makeWatcherEnv({ GITHUB_TOKEN: 'ghs_KEEP', GH_TOKEN: 'ghs_KEEP' });
  // Broker returns 200 but for a different App — must be rejected, token kept.
  const fetchImpl = async () => brokerOk('github-app-claude-reviewer', 'ghs_WRONG_APP', {
    expiresAt: new Date(1_000_000 + HOUR_MS).toISOString(),
  });
  const summary = await refreshWatcherGithubToken({
    env, now: 1_000_000, fetchImpl, readFileImpl: readSecret, log: silentLog,
  });
  assert.equal(summary.refreshed, false);
  assert.equal(env.GITHUB_TOKEN, 'ghs_KEEP');
});
