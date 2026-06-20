import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  ANTIGRAVITY_REDIRECT_URI,
  ANTIGRAVITY_SCOPES,
  ANTIGRAVITY_TOKEN_URL,
  AntigravityAuthError,
  buildAuthorizationUrl,
  clearAntigravityAccessTokenCache,
  generatePkcePair,
  getAccessToken,
  readCredentials,
  resolveCredentialPath,
  writeCredentials,
} from '../src/auth/antigravity-bridge.mjs';

const FIXTURE_CLIENT_ID = 'fixture-client-id';
const FIXTURE_CLIENT_SECRET = 'fixture-client-secret';

function tempBridgeDir() {
  return mkdtempSync(join(tmpdir(), 'agr-bridge-'));
}

function mode(path) {
  return statSync(path).mode & 0o777;
}

function jsonResponse(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status || 200,
    statusText: init.statusText || 'OK',
    headers: { 'Content-Type': 'application/json' },
  });
}

test('PKCE verifier/challenge construction and authorization URL shape', () => {
  const pkce = generatePkcePair();
  assert.match(pkce.verifier, /^[A-Za-z0-9_-]{43}$/);
  assert.match(pkce.challenge, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(pkce.method, 'S256');

  const authorization = buildAuthorizationUrl({
    pkce,
    state: 'state-fixture',
    clientId: FIXTURE_CLIENT_ID,
    clientSecret: FIXTURE_CLIENT_SECRET,
  });
  const url = new URL(authorization.url);
  assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(url.searchParams.get('client_id'), FIXTURE_CLIENT_ID);
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('redirect_uri'), ANTIGRAVITY_REDIRECT_URI);
  assert.equal(url.searchParams.get('code_challenge'), pkce.challenge);
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('access_type'), 'offline');
  assert.equal(url.searchParams.get('prompt'), 'consent');
  assert.equal(url.searchParams.get('state'), 'state-fixture');
  assert.deepEqual(url.searchParams.get('scope').split(' '), [...ANTIGRAVITY_SCOPES]);
});

test('credential-file write enforces file mode 0600 and directory mode 0700', () => {
  const bridgeDir = join(tempBridgeDir(), 'nested');
  const path = writeCredentials('acct-0', {
    email: 'account@example.test',
    refreshToken: 'refresh-token-fixture',
    projectId: 'project-fixture',
  }, { bridgeDir });

  assert.equal(mode(bridgeDir), 0o700);
  assert.equal(mode(path), 0o600);
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), {
    email: 'account@example.test',
    refreshToken: 'refresh-token-fixture',
    projectId: 'project-fixture',
  });
});

test('getAccessToken refreshes with stored refresh token and caches until near expiry', async () => {
  clearAntigravityAccessTokenCache();
  const bridgeDir = tempBridgeDir();
  writeCredentials('acct-0', {
    email: 'account@example.test',
    refreshToken: 'refresh-token-fixture',
  }, { bridgeDir });

  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return jsonResponse({ access_token: 'access-token-fixture', expires_in: 3600 });
  };
  const now = () => 1000;

  const first = await getAccessToken('acct-0', {
    bridgeDir,
    clientId: FIXTURE_CLIENT_ID,
    clientSecret: FIXTURE_CLIENT_SECRET,
    fetchImpl,
    now,
  });
  const second = await getAccessToken('acct-0', {
    bridgeDir,
    clientId: FIXTURE_CLIENT_ID,
    clientSecret: FIXTURE_CLIENT_SECRET,
    fetchImpl,
    now,
  });

  assert.equal(first.accessToken, 'access-token-fixture');
  assert.equal(second.accessToken, 'access-token-fixture');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, ANTIGRAVITY_TOKEN_URL);
  assert.equal(calls[0].options.method, 'POST');
  const params = new URLSearchParams(calls[0].options.body);
  assert.equal(params.get('grant_type'), 'refresh_token');
  assert.equal(params.get('refresh_token'), 'refresh-token-fixture');
  assert.equal(params.get('client_id'), FIXTURE_CLIENT_ID);
  assert.equal(params.get('client_secret'), FIXTURE_CLIENT_SECRET);
});

test('getAccessToken surfaces expired refresh token with stable error shape', async () => {
  clearAntigravityAccessTokenCache();
  const bridgeDir = tempBridgeDir();
  writeCredentials('acct-0', {
    email: 'account@example.test',
    refreshToken: 'expired-refresh-token-fixture',
  }, { bridgeDir });

  const fetchImpl = async () => jsonResponse({
    error: 'invalid_grant',
    error_description: 'Token has been expired or revoked.',
  }, { status: 400, statusText: 'Bad Request' });

  await assert.rejects(
    () => getAccessToken('acct-0', {
      bridgeDir,
      clientId: FIXTURE_CLIENT_ID,
      clientSecret: FIXTURE_CLIENT_SECRET,
      fetchImpl,
    }),
    (err) => {
      assert.ok(err instanceof AntigravityAuthError);
      assert.equal(err.code, 'refresh-token-expired');
      assert.equal(err.status, 400);
      assert.equal(err.oauthError, 'invalid_grant');
      assert.match(err.message, /Antigravity token refresh failed/);
      assert.match(err.message, /invalid_grant/);
      return true;
    }
  );
});

test('missing and corrupt credential files have stable error shapes', () => {
  const bridgeDir = tempBridgeDir();

  assert.throws(
    () => readCredentials('missing-account', { bridgeDir }),
    (err) => {
      assert.ok(err instanceof AntigravityAuthError);
      assert.equal(err.code, 'missing-credentials');
      assert.match(err.message, /credential file missing/);
      return true;
    }
  );

  const corruptPath = resolveCredentialPath('corrupt-account', { bridgeDir });
  writeFileSync(corruptPath, '{not-json', { mode: 0o600 });

  assert.throws(
    () => readCredentials('corrupt-account', { bridgeDir }),
    (err) => {
      assert.ok(err instanceof AntigravityAuthError);
      assert.equal(err.code, 'corrupt-credentials');
      assert.match(err.message, /invalid Antigravity credential JSON/);
      return true;
    }
  );
});
