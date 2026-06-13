import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  refreshReviewerBrokerTokens,
  _resetReviewerTokenRefreshClockForTest,
  REVIEWER_TOKEN_REFRESH_TTL_MS,
  BROKER_REVIEWER_ROLES,
} from '../src/reviewer-broker-refresh.mjs';

const SECRET_FILE = '/secret/oauth-broker-shared-secret';

function makeEnv(overrides = {}) {
  return {
    CLAUDE_REVIEWER_AUTH_VIA_BROKER: 'true',
    OAUTH_BROKER_URL: 'http://127.0.0.1:4099',
    OAUTH_BROKER_SHARED_SECRET_FILE: SECRET_FILE,
    GH_CLAUDE_REVIEWER_TOKEN: 'ghs_OLD_token',
    ...overrides,
  };
}

function brokerOk(provider, accessToken, metadata = {}) {
  return {
    ok: true,
    status: 200,
    async json() {
      return { access_token: accessToken, provider, metadata };
    },
  };
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
    return brokerOk('github-app-claude-reviewer', 'ghs_FRESH_token');
  };
  const summary = await refreshReviewerBrokerTokens({
    env,
    now: 1_000_000,
    fetchImpl,
    readFileImpl: readSecret,
    log: silentLog,
  });
  assert.equal(env.GH_CLAUDE_REVIEWER_TOKEN, 'ghs_FRESH_token');
  assert.match(calledUrl, /\/token\?provider=github-app-claude-reviewer$/);
  assert.equal(calledAuth, 'Bearer broker-shared-secret');
  assert.equal(summary.refreshed.length, 1);
  assert.equal(summary.refreshed[0].role, 'claude-reviewer');
});

test('skips re-fetch within the TTL, re-fetches after it elapses', async () => {
  _resetReviewerTokenRefreshClockForTest();
  const env = makeEnv();
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return brokerOk('github-app-claude-reviewer', `ghs_token_${calls}`);
  };
  const t0 = 5_000_000;
  await refreshReviewerBrokerTokens({ env, now: t0, fetchImpl, readFileImpl: readSecret, log: silentLog });
  assert.equal(env.GH_CLAUDE_REVIEWER_TOKEN, 'ghs_token_1');
  // within TTL → no new fetch, token unchanged
  await refreshReviewerBrokerTokens({
    env,
    now: t0 + REVIEWER_TOKEN_REFRESH_TTL_MS - 1,
    fetchImpl,
    readFileImpl: readSecret,
    log: silentLog,
  });
  assert.equal(calls, 1);
  assert.equal(env.GH_CLAUDE_REVIEWER_TOKEN, 'ghs_token_1');
  // past TTL → re-fetch
  await refreshReviewerBrokerTokens({
    env,
    now: t0 + REVIEWER_TOKEN_REFRESH_TTL_MS + 1,
    fetchImpl,
    readFileImpl: readSecret,
    log: silentLog,
  });
  assert.equal(calls, 2);
  assert.equal(env.GH_CLAUDE_REVIEWER_TOKEN, 'ghs_token_2');
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

test('rejects a token minted for the wrong app_id (metadata mismatch), keeps old token', async () => {
  _resetReviewerTokenRefreshClockForTest();
  const env = makeEnv({ OAUTH_BROKER_CLAUDE_REVIEWER_EXPECTED_APP_ID: '111' });
  const fetchImpl = async () =>
    brokerOk('github-app-claude-reviewer', 'ghs_WRONG_app', { app_id: '999', installation_id: '42' });
  const summary = await refreshReviewerBrokerTokens({
    env, now: 1, fetchImpl, readFileImpl: readSecret, log: silentLog,
  });
  assert.equal(env.GH_CLAUDE_REVIEWER_TOKEN, 'ghs_OLD_token');
  assert.match(summary.failed[0].reason, /app_id/);
});

test('accepts a token whose metadata matches the expected app_id + installation_id', async () => {
  _resetReviewerTokenRefreshClockForTest();
  const env = makeEnv({
    OAUTH_BROKER_CLAUDE_REVIEWER_EXPECTED_APP_ID: '111',
    OAUTH_BROKER_CLAUDE_REVIEWER_EXPECTED_INSTALLATION_ID: '42',
  });
  const fetchImpl = async () =>
    brokerOk('github-app-claude-reviewer', 'ghs_GOOD', { app_id: 111, installation_id: 42 });
  await refreshReviewerBrokerTokens({ env, now: 1, fetchImpl, readFileImpl: readSecret, log: silentLog });
  assert.equal(env.GH_CLAUDE_REVIEWER_TOKEN, 'ghs_GOOD');
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
    return brokerOk('github-app-claude-reviewer', 'ghs_FRESH_claude');
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
