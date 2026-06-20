import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import {
  ANTIGRAVITY_REDIRECT_URI,
  ANTIGRAVITY_SCOPES,
  AntigravityBridgeError,
  assertAntigravityOAuth,
  buildAuthorizationUrl,
  clearAccessTokenCache,
  generatePkcePair,
  getAccessToken,
  listCredentialAccounts,
  readCredentialFile,
  resolveCredentialPath,
  startCallbackServer,
  writeCredentialFile,
} from '../src/auth/antigravity-bridge.mjs';

const execFileAsync = promisify(execFile);
const AGR_AUTH_BIN = fileURLToPath(new URL('../bin/agr-auth.mjs', import.meta.url));

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

test('concurrent refreshes single-flight and persist rotated refresh token once', async () => {
  clearAccessTokenCache();
  const dir = bridgeDir();
  writeCredentialFile('acct-0', {
    email: 'user@example.com',
    refreshToken: 'fake-refresh-token',
  }, { bridgeDir: dir });

  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url, body: init.body.toString() });
    await new Promise((resolve) => setTimeout(resolve, 25));
    return jsonResponse({
      access_token: 'rotated-access-token',
      refresh_token: 'rotated-refresh-token',
      expires_in: 3600,
    });
  };
  const options = {
    bridgeDir: dir,
    fetchImpl,
    tokenEndpoint: 'https://mock.example/token',
    clientId: 'mock-client-id',
    clientSecret: 'mock-client-secret',
    now: () => 1_000,
  };

  const [first, second] = await Promise.all([
    getAccessToken('acct-0', options),
    getAccessToken('acct-0', options),
  ]);

  assert.equal(first, 'rotated-access-token');
  assert.equal(second, 'rotated-access-token');
  assert.equal(requests.length, 1);
  const { creds } = readCredentialFile('acct-0', { bridgeDir: dir });
  assert.equal(creds.refreshToken, 'rotated-refresh-token');
  assert.equal(statSync(resolveCredentialPath('acct-0', { bridgeDir: dir })).mode & 0o777, 0o600);
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

test('credential reads reject loose permissions before parsing secrets', () => {
  const dir = bridgeDir();
  const filePath = writeCredentialFile('acct-0', {
    email: 'user@example.com',
    refreshToken: 'fake-refresh-token',
  }, { bridgeDir: dir });
  chmodSync(filePath, 0o644);

  assert.throws(
    () => readCredentialFile('acct-0', { bridgeDir: dir }),
    (err) => {
      assert.ok(err instanceof AntigravityBridgeError);
      assert.equal(err.code, 'CREDS_UNSAFE_PERMISSIONS');
      assert.equal(err.path, filePath);
      return true;
    },
  );
});

test('credential account listing ignores non-account files', () => {
  const dir = bridgeDir();
  writeCredentialFile('acct-0', {
    email: 'user@example.com',
    refreshToken: 'fake-refresh-token',
  }, { bridgeDir: dir });
  writeCredentialFile('acct-1', {
    email: 'other@example.com',
    refreshToken: 'other-refresh-token',
  }, { bridgeDir: dir });
  writeFileSync(join(dir, 'not-json.txt'), 'ignored\n');
  writeFileSync(join(dir, 'bad..acct.json'), '{}\n');

  assert.deepEqual(listCredentialAccounts({ bridgeDir: dir }), ['acct-0', 'acct-1']);
});

test('agr-auth status is read-only unless --check-token is explicit', async () => {
  const dir = bridgeDir();
  writeCredentialFile('acct-0', {
    email: 'user@example.com',
    refreshToken: 'fake-refresh-token',
    projectId: 'project-123',
  }, { bridgeDir: dir });
  const env = {
    ...process.env,
    GEMINI_ANTIGRAVITY_BRIDGE_DIR: dir,
    GEMINI_ANTIGRAVITY_CLIENT_ID: '',
    GEMINI_ANTIGRAVITY_CLIENT_SECRET: '',
  };

  const status = await execFileAsync(process.execPath, [AGR_AUTH_BIN, 'status', 'acct-0'], { env });
  assert.match(status.stdout, /not-checked/);
  assert.equal(status.stderr, '');

  await assert.rejects(
    execFileAsync(process.execPath, [AGR_AUTH_BIN, 'status', '--check-token'], { env }),
    (err) => {
      assert.equal(err.code, 2);
      assert.match(err.stdout, /refresh-failed/);
      return true;
    },
  );
});

test('callback server reports busy port before browser launch can race it', async () => {
  const blocker = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('busy');
  });
  await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve));
  const { port } = blocker.address();

  try {
    const callback = startCallbackServer({ expectedState: 'state', host: '127.0.0.1', port, timeoutMs: 100 });
    const callbackFailed = assert.rejects(
      callback,
      (err) => {
        assert.ok(err instanceof AntigravityBridgeError);
        assert.equal(err.code, 'CALLBACK_SERVER_FAILED');
        assert.equal(err.causeCode, 'EADDRINUSE');
        assert.match(err.message, /already in use/);
        return true;
      },
    );
    const readyFailed = assert.rejects(callback.ready, { code: 'CALLBACK_SERVER_FAILED' });
    await readyFailed;
    await callbackFailed;
  } finally {
    await new Promise((resolve) => blocker.close(resolve));
  }
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
