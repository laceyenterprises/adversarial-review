import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  refreshReviewerBrokerTokens,
  _resetReviewerTokenRefreshClockForTest,
  REVIEWER_TOKEN_REFRESH_SKEW_MS,
  REVIEWER_TOKEN_FALLBACK_TTL_MS,
  REVIEWER_TOKEN_POST_SLACK_MS,
  BROKER_REVIEWER_ROLES,
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
});

test('keys the refresh schedule off the broker expires_at minus skew', async () => {
  _resetReviewerTokenRefreshClockForTest();
  const env = makeEnv();
  let calls = 0;
  const t0 = 5_000_000;
  // First token expires in exactly 1h.
  const fetchImpl = async () => {
    calls += 1;
    const issuedAt = calls === 1 ? t0 : t0 + HOUR_MS - REVIEWER_TOKEN_REFRESH_SKEW_MS + 1;
    return brokerOk('github-app-claude-reviewer', `ghs_token_${calls}`, {
      expiresAt: new Date(issuedAt + HOUR_MS).toISOString(),
    });
  };
  await refreshReviewerBrokerTokens({ env, now: t0, fetchImpl, readFileImpl: readSecret, log: silentLog });
  assert.equal(env.GH_CLAUDE_REVIEWER_TOKEN, 'ghs_token_1');
  // Comfortably before (expiry - skew): no re-fetch.
  await refreshReviewerBrokerTokens({
    env, now: t0 + HOUR_MS - REVIEWER_TOKEN_REFRESH_SKEW_MS - 1,
    fetchImpl, readFileImpl: readSecret, log: silentLog,
  });
  assert.equal(calls, 1);
  assert.equal(env.GH_CLAUDE_REVIEWER_TOKEN, 'ghs_token_1');
  // Inside the skew window (token nearly expired): re-fetch.
  await refreshReviewerBrokerTokens({
    env, now: t0 + HOUR_MS - REVIEWER_TOKEN_REFRESH_SKEW_MS + 1,
    fetchImpl, readFileImpl: readSecret, log: silentLog,
  });
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

test('role table covers the three reviewer families', () => {
  const roles = BROKER_REVIEWER_ROLES.map((r) => r.role).sort();
  assert.deepEqual(roles, ['claude-reviewer', 'codex-reviewer', 'gemini-reviewer']);
});
