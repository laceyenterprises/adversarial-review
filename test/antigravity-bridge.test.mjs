import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import {
  ANTIGRAVITY_REDIRECT_URI,
  ANTIGRAVITY_SCOPES,
  AntigravityBridgeError,
  assertAntigravityOAuth,
  buildAuthorizationUrl,
  clearAccessTokenCache,
  generatePkcePair,
  getAccessToken,
  readCredentialFile,
  writeCredentialFile,
} from '../src/auth/antigravity-bridge.mjs';

function bridgeDir() {
  return mkdtempSync(join(tmpdir(), 'agr-bridge-'));
}

function jsonResponse(body, { status = 200, statusText = 'OK' } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    statusText,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('PKCE verifier, challenge, and authorization URL shape are valid', () => {
  const pkce = generatePkcePair();
  assert.match(pkce.verifier, /^[A-Za-z0-9_-]{43,128}$/);
  const expectedChallenge = createHash('sha256')
    .update(pkce.verifier)
    .digest('base64url');
  assert.equal(pkce.challenge, expectedChallenge);

  const built = buildAuthorizationUrl({
    pkce,
    state: 'state-test',
    projectId: 'project-123',
    clientId: 'mock-client-id.apps.googleusercontent.com',
  });
  const url = new URL(built.url);

  assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(url.searchParams.get('client_id'), 'mock-client-id.apps.googleusercontent.com');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('redirect_uri'), ANTIGRAVITY_REDIRECT_URI);
  assert.equal(url.searchParams.get('code_challenge'), pkce.challenge);
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('access_type'), 'offline');
  assert.equal(url.searchParams.get('prompt'), 'consent');
  assert.equal(url.searchParams.get('state'), 'state-test');
  for (const scope of ANTIGRAVITY_SCOPES) {
    assert.ok(url.searchParams.get('scope').split(' ').includes(scope));
  }
});

test('credential write pins directory 0700 and token file 0600', () => {
  const dir = bridgeDir();
  const filePath = writeCredentialFile('acct-0', {
    email: 'user@example.com',
    refreshToken: 'fake-refresh-token',
    projectId: 'project-123',
  }, { bridgeDir: dir });

  assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.equal(statSync(filePath).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(filePath, 'utf8')), {
    email: 'user@example.com',
    refreshToken: 'fake-refresh-token',
    projectId: 'project-123',
  });
  assert.equal(assertAntigravityOAuth('acct-0', { bridgeDir: dir }), filePath);
});

test('getAccessToken refreshes with mocked token endpoint and caches until near expiry', async () => {
  clearAccessTokenCache();
  const dir = bridgeDir();
  writeCredentialFile('acct-0', {
    email: 'user@example.com',
    refreshToken: 'fake-refresh-token',
  }, { bridgeDir: dir });

  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url, body: init.body.toString() });
    return jsonResponse({ access_token: 'fake-access-token', expires_in: 3600 });
  };

  const token = await getAccessToken('acct-0', {
    bridgeDir: dir,
    fetchImpl,
    tokenEndpoint: 'https://mock.example/token',
    clientId: 'mock-client-id',
    clientSecret: 'mock-client-secret',
    now: () => 1_000,
  });
  const cached = await getAccessToken('acct-0', {
    bridgeDir: dir,
    fetchImpl,
    tokenEndpoint: 'https://mock.example/token',
    clientId: 'mock-client-id',
    clientSecret: 'mock-client-secret',
    now: () => 2_000,
  });

  assert.equal(token, 'fake-access-token');
  assert.equal(cached, 'fake-access-token');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://mock.example/token');
  const body = new URLSearchParams(requests[0].body);
  assert.equal(body.get('grant_type'), 'refresh_token');
  assert.equal(body.get('refresh_token'), 'fake-refresh-token');
});

test('getAccessToken reports expired refresh-token error shape', async () => {
  clearAccessTokenCache();
  const dir = bridgeDir();
  writeCredentialFile('acct-0', {
    email: 'user@example.com',
    refreshToken: 'fake-refresh-token',
  }, { bridgeDir: dir });

  const fetchImpl = async () => jsonResponse({
    error: 'invalid_grant',
    error_description: 'Token has been expired or revoked.',
  }, { status: 400, statusText: 'Bad Request' });

  await assert.rejects(
    getAccessToken('acct-0', {
      bridgeDir: dir,
      fetchImpl,
      tokenEndpoint: 'https://mock.example/token',
      clientId: 'mock-client-id',
      clientSecret: 'mock-client-secret',
    }),
    (err) => {
      assert.ok(err instanceof AntigravityBridgeError);
      assert.equal(err.code, 'REFRESH_TOKEN_EXPIRED');
      assert.equal(err.oauthError, 'invalid_grant');
      assert.equal(err.status, 400);
      assert.equal(err.accountId, 'acct-0');
      assert.match(err.path, /acct-0\.json$/);
      return true;
    },
  );
});

test('missing and corrupt credential files use stable error codes', () => {
  const dir = bridgeDir();
  assert.throws(
    () => readCredentialFile('acct-0', { bridgeDir: dir }),
    (err) => {
      assert.ok(err instanceof AntigravityBridgeError);
      assert.equal(err.code, 'CREDS_MISSING');
      assert.match(err.path, /acct-0\.json$/);
      return true;
    },
  );

  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'acct-1.json'), '{not-json\n', { mode: 0o600 });
  assert.throws(
    () => readCredentialFile('acct-1', { bridgeDir: dir }),
    (err) => {
      assert.ok(err instanceof AntigravityBridgeError);
      assert.equal(err.code, 'CREDS_CORRUPT');
      assert.match(err.path, /acct-1\.json$/);
      return true;
    },
  );
});
