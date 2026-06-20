import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { execFile } from 'node:child_process';

const ANTIGRAVITY_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const ANTIGRAVITY_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v1/userinfo?alt=json';
const ANTIGRAVITY_REDIRECT_PORT = 51121;
const ANTIGRAVITY_REDIRECT_PATH = '/oauth-callback';
const ANTIGRAVITY_REDIRECT_URI = `http://localhost:${ANTIGRAVITY_REDIRECT_PORT}${ANTIGRAVITY_REDIRECT_PATH}`;
const ANTIGRAVITY_SCOPES = Object.freeze([
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/cclog',
  'https://www.googleapis.com/auth/experimentsandconfigs',
]);

const ACCESS_TOKEN_REFRESH_SKEW_MS = 5 * 60 * 1000;
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
const accessTokenCache = new Map();

class AntigravityAuthError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'AntigravityAuthError';
    this.code = code;
    Object.assign(this, details);
  }
}

function base64Url(buffer) {
  return Buffer.from(buffer)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function generatePkcePair() {
  const verifier = base64Url(randomBytes(32));
  const challenge = base64Url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge, method: 'S256' };
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
}

function resolveBridgeDir(env = process.env) {
  if (env.GEMINI_ANTIGRAVITY_BRIDGE_DIR) return env.GEMINI_ANTIGRAVITY_BRIDGE_DIR;
  return join(env.HOME || homedir(), '.gemini', 'antigravity-bridge');
}

function resolveOAuthClientConfig({
  env = process.env,
  clientId = env.GEMINI_ANTIGRAVITY_CLIENT_ID,
  clientSecret = env.GEMINI_ANTIGRAVITY_CLIENT_SECRET,
} = {}) {
  if (typeof clientId !== 'string' || clientId.length === 0) {
    throw new AntigravityAuthError('missing-oauth-client-id', 'GEMINI_ANTIGRAVITY_CLIENT_ID is required for Antigravity OAuth');
  }
  if (typeof clientSecret !== 'string' || clientSecret.length === 0) {
    throw new AntigravityAuthError('missing-oauth-client-secret', 'GEMINI_ANTIGRAVITY_CLIENT_SECRET is required for Antigravity OAuth');
  }
  return { clientId, clientSecret };
}

function validateAccountId(accountId) {
  if (typeof accountId !== 'string' || !/^[A-Za-z0-9._@-]+$/.test(accountId)) {
    throw new AntigravityAuthError('invalid-account-id', 'Antigravity account id must contain only letters, numbers, dot, underscore, at, or dash');
  }
  return accountId;
}

function resolveCredentialPath(accountId, { env = process.env, bridgeDir } = {}) {
  const safeAccountId = validateAccountId(accountId);
  return join(bridgeDir || resolveBridgeDir(env), `${safeAccountId}.json`);
}

function ensurePrivateBridgeDir(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}

function assertPrivateMode(path, expectedMode, label) {
  const mode = statSync(path).mode & 0o777;
  if (mode !== expectedMode) {
    throw new AntigravityAuthError('unsafe-permissions', `${label} must be mode ${expectedMode.toString(8)}: ${path}`, {
      path,
      mode,
      expectedMode,
    });
  }
}

function parseCredentialJson(raw, path) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new AntigravityAuthError('corrupt-credentials', `invalid Antigravity credential JSON at ${path}: ${err.message}`, { path });
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new AntigravityAuthError('corrupt-credentials', `Antigravity credential file must contain an object: ${path}`, { path });
  }
  if (typeof parsed.email !== 'string' || parsed.email.length === 0) {
    throw new AntigravityAuthError('invalid-credentials', `Antigravity credential file missing email: ${path}`, { path });
  }
  if (typeof parsed.refreshToken !== 'string' || parsed.refreshToken.length === 0) {
    throw new AntigravityAuthError('invalid-credentials', `Antigravity credential file missing refreshToken: ${path}`, { path });
  }
  if (parsed.projectId !== undefined && typeof parsed.projectId !== 'string') {
    throw new AntigravityAuthError('invalid-credentials', `Antigravity credential file has non-string projectId: ${path}`, { path });
  }

  return {
    email: parsed.email,
    refreshToken: parsed.refreshToken,
    ...(parsed.projectId ? { projectId: parsed.projectId } : {}),
  };
}

function readCredentials(accountId, { env = process.env, bridgeDir } = {}) {
  const path = resolveCredentialPath(accountId, { env, bridgeDir });
  if (!existsSync(path)) {
    throw new AntigravityAuthError('missing-credentials', `Antigravity credential file missing: ${path}`, { path });
  }

  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    throw new AntigravityAuthError('credential-read-failed', `cannot read ${path}: ${err.message}`, { path });
  }

  return { path, credentials: parseCredentialJson(raw, path) };
}

function assertAntigravityCredsReadable(accountId, options = {}) {
  const { path, credentials } = readCredentials(accountId, options);
  assertPrivateMode(path, 0o600, 'Antigravity credential file');
  return { path, email: credentials.email, projectId: credentials.projectId };
}

function writeCredentials(accountId, credentials, { env = process.env, bridgeDir } = {}) {
  validateAccountId(accountId);
  const dir = bridgeDir || resolveBridgeDir(env);
  ensurePrivateBridgeDir(dir);
  assertPrivateMode(dir, 0o700, 'Antigravity credential directory');

  const record = {
    email: credentials.email,
    refreshToken: credentials.refreshToken,
    ...(credentials.projectId ? { projectId: credentials.projectId } : {}),
  };
  parseCredentialJson(JSON.stringify(record), resolveCredentialPath(accountId, { env, bridgeDir: dir }));

  const path = resolveCredentialPath(accountId, { env, bridgeDir: dir });
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  assertPrivateMode(path, 0o600, 'Antigravity credential file');
  return path;
}

function buildAuthorizationUrl({
  pkce = generatePkcePair(),
  state = base64Url(randomBytes(32)),
  redirectUri = ANTIGRAVITY_REDIRECT_URI,
  env = process.env,
  clientId,
  clientSecret,
  projectId,
} = {}) {
  const oauthClient = resolveOAuthClientConfig({ env, clientId, clientSecret });
  const url = new URL(ANTIGRAVITY_AUTH_URL);
  url.searchParams.set('client_id', oauthClient.clientId);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', ANTIGRAVITY_SCOPES.join(' '));
  url.searchParams.set('code_challenge', pkce.challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', state);
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  if (projectId) url.searchParams.set('project_id', projectId);
  return { url: url.toString(), verifier: pkce.verifier, challenge: pkce.challenge, state, redirectUri };
}

async function postForm(url, params, { fetchImpl = fetch } = {}) {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  const text = await response.text();
  let payload = {};
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { raw: text };
    }
  }
  return { response, payload };
}

function oauthErrorMessage(prefix, response, payload) {
  const code = typeof payload?.error === 'string' ? payload.error : undefined;
  const description = typeof payload?.error_description === 'string' ? payload.error_description : undefined;
  const detail = [code, description].filter(Boolean).join(': ');
  return detail ? `${prefix} (${response.status} ${response.statusText}) - ${detail}` : `${prefix} (${response.status} ${response.statusText})`;
}

async function exchangeAuthorizationCode({
  code,
  verifier,
  redirectUri = ANTIGRAVITY_REDIRECT_URI,
  projectId,
  env = process.env,
  clientId,
  clientSecret,
  fetchImpl = fetch,
  now = Date.now,
} = {}) {
  const oauthClient = resolveOAuthClientConfig({ env, clientId, clientSecret });
  const startedAt = now();
  const { response, payload } = await postForm(ANTIGRAVITY_TOKEN_URL, {
    client_id: oauthClient.clientId,
    client_secret: oauthClient.clientSecret,
    code,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri,
    code_verifier: verifier,
  }, { fetchImpl });

  if (!response.ok) {
    throw new AntigravityAuthError('authorization-code-exchange-failed', oauthErrorMessage('Antigravity authorization code exchange failed', response, payload), {
      status: response.status,
      oauthError: payload?.error,
      oauthErrorDescription: payload?.error_description,
    });
  }
  if (typeof payload.access_token !== 'string' || payload.access_token.length === 0) {
    throw new AntigravityAuthError('authorization-code-exchange-failed', 'Antigravity authorization response missing access_token');
  }
  if (typeof payload.refresh_token !== 'string' || payload.refresh_token.length === 0) {
    throw new AntigravityAuthError('authorization-code-exchange-failed', 'Antigravity authorization response missing refresh_token');
  }

  let email = '';
  try {
    const userInfoResponse = await fetchImpl(GOOGLE_USERINFO_URL, {
      headers: { Authorization: `Bearer ${payload.access_token}` },
    });
    if (userInfoResponse.ok) {
      const userInfo = await userInfoResponse.json();
      if (typeof userInfo?.email === 'string') email = userInfo.email;
    }
  } catch {
    email = '';
  }

  return {
    accessToken: payload.access_token,
    expiresAt: startedAt + Number(payload.expires_in || 3600) * 1000,
    credentials: {
      email,
      refreshToken: payload.refresh_token,
      ...(projectId ? { projectId } : {}),
    },
  };
}

async function refreshAccessToken(accountId, {
  env = process.env,
  bridgeDir,
  clientId,
  clientSecret,
  fetchImpl = fetch,
  now = Date.now,
} = {}) {
  const oauthClient = resolveOAuthClientConfig({ env, clientId, clientSecret });
  const { path, credentials } = readCredentials(accountId, { env, bridgeDir });
  assertPrivateMode(path, 0o600, 'Antigravity credential file');
  const startedAt = now();
  const { response, payload } = await postForm(ANTIGRAVITY_TOKEN_URL, {
    grant_type: 'refresh_token',
    refresh_token: credentials.refreshToken,
    client_id: oauthClient.clientId,
    client_secret: oauthClient.clientSecret,
  }, { fetchImpl });

  if (!response.ok) {
    const errorCode = typeof payload?.error === 'string' ? payload.error : undefined;
    throw new AntigravityAuthError(
      errorCode === 'invalid_grant' ? 'refresh-token-expired' : 'access-token-refresh-failed',
      oauthErrorMessage('Antigravity token refresh failed', response, payload),
      {
        accountId,
        status: response.status,
        oauthError: errorCode,
        oauthErrorDescription: payload?.error_description,
      }
    );
  }

  if (typeof payload.access_token !== 'string' || payload.access_token.length === 0) {
    throw new AntigravityAuthError('access-token-refresh-failed', 'Antigravity token refresh response missing access_token', { accountId });
  }

  if (typeof payload.refresh_token === 'string' && payload.refresh_token && payload.refresh_token !== credentials.refreshToken) {
    writeCredentials(accountId, { ...credentials, refreshToken: payload.refresh_token }, { env, bridgeDir });
  }

  const expiresAt = startedAt + Number(payload.expires_in || 3600) * 1000;
  const cached = { accessToken: payload.access_token, expiresAt, email: credentials.email, projectId: credentials.projectId };
  accessTokenCache.set(`${bridgeDir || resolveBridgeDir(env)}:${accountId}`, cached);
  return cached;
}

async function getAccessToken(accountId, options = {}) {
  validateAccountId(accountId);
  const now = options.now || Date.now;
  const bridgeDir = options.bridgeDir || resolveBridgeDir(options.env || process.env);
  const cacheKey = `${bridgeDir}:${accountId}`;
  const cached = accessTokenCache.get(cacheKey);
  if (cached && cached.expiresAt - now() > ACCESS_TOKEN_REFRESH_SKEW_MS) {
    return cached;
  }
  return refreshAccessToken(accountId, { ...options, bridgeDir, now });
}

function listCredentialAccounts({ env = process.env, bridgeDir } = {}) {
  const dir = bridgeDir || resolveBridgeDir(env);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((entry) => entry.endsWith('.json'))
    .map((entry) => basename(entry, '.json'))
    .filter((entry) => {
      try {
        validateAccountId(entry);
        return true;
      } catch {
        return false;
      }
    })
    .sort();
}

function listenForCallback({ expectedState, port = ANTIGRAVITY_REDIRECT_PORT, path = ANTIGRAVITY_REDIRECT_PATH, timeoutMs = LOGIN_TIMEOUT_MS } = {}) {
  let readyResolve;
  let readyReject;
  let listening = false;
  const ready = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });

  const callback = new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const requestUrl = new URL(req.url || '/', `http://localhost:${port}`);
      if (requestUrl.pathname !== path) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('not found');
        return;
      }
      const returnedState = requestUrl.searchParams.get('state') || '';
      if (!safeEqual(returnedState, expectedState)) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('OAuth state mismatch. You can close this tab.');
        cleanup();
        reject(new AntigravityAuthError('oauth-state-mismatch', 'Antigravity OAuth callback state mismatch'));
        return;
      }
      const error = requestUrl.searchParams.get('error');
      if (error) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Antigravity OAuth failed. You can close this tab.');
        cleanup();
        reject(new AntigravityAuthError('oauth-callback-error', `Antigravity OAuth callback returned error: ${error}`));
        return;
      }
      const code = requestUrl.searchParams.get('code');
      if (!code) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Antigravity OAuth callback missing code. You can close this tab.');
        cleanup();
        reject(new AntigravityAuthError('oauth-callback-missing-code', 'Antigravity OAuth callback missing code'));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('Antigravity OAuth complete. You can close this tab.');
      cleanup();
      resolve({ code });
    });

    const timer = setTimeout(() => {
      cleanup();
      reject(new AntigravityAuthError('oauth-callback-timeout', `Timed out waiting for Antigravity OAuth callback on localhost:${port}`));
    }, timeoutMs);

    function cleanup() {
      clearTimeout(timer);
      if (listening) server.close();
    }

    server.on('error', (err) => {
      cleanup();
      const wrapped = new AntigravityAuthError('oauth-callback-server-failed', `Antigravity OAuth callback server failed: ${err.message}`);
      readyReject(wrapped);
      reject(wrapped);
    });
    server.listen(port, '127.0.0.1', () => {
      listening = true;
      readyResolve();
    });
  });
  callback.ready = ready;
  return callback;
}

function openBrowser(url) {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  const child = execFile(command, args, { stdio: 'ignore' }, () => {});
  child.unref();
}

async function login(accountId, {
  env = process.env,
  bridgeDir,
  clientId,
  clientSecret,
  fetchImpl = fetch,
  openBrowserImpl = openBrowser,
  out = process.stdout,
  projectId,
  timeoutMs = LOGIN_TIMEOUT_MS,
  now = Date.now,
} = {}) {
  validateAccountId(accountId);
  const redirectUri = ANTIGRAVITY_REDIRECT_URI;
  const authorization = buildAuthorizationUrl({ env, clientId, clientSecret, redirectUri, projectId });
  const callbackPromise = listenForCallback({ expectedState: authorization.state, timeoutMs });
  await callbackPromise.ready;
  out.write(`Open this URL to authorize Antigravity account ${accountId}:\n${authorization.url}\n`);
  openBrowserImpl(authorization.url);
  const { code } = await callbackPromise;
  const exchanged = await exchangeAuthorizationCode({
    code,
    verifier: authorization.verifier,
    redirectUri,
    projectId,
    env,
    clientId,
    clientSecret,
    fetchImpl,
    now,
  });
  if (!exchanged.credentials.email) {
    throw new AntigravityAuthError('missing-email', 'Antigravity OAuth userinfo did not return an email');
  }
  const path = writeCredentials(accountId, exchanged.credentials, { env, bridgeDir });
  accessTokenCache.set(`${bridgeDir || resolveBridgeDir(env)}:${accountId}`, {
    accessToken: exchanged.accessToken,
    expiresAt: exchanged.expiresAt,
    email: exchanged.credentials.email,
    projectId: exchanged.credentials.projectId,
  });
  return { path, email: exchanged.credentials.email, projectId: exchanged.credentials.projectId };
}

function clearAntigravityAccessTokenCache() {
  accessTokenCache.clear();
}

export {
  ACCESS_TOKEN_REFRESH_SKEW_MS,
  ANTIGRAVITY_AUTH_URL,
  ANTIGRAVITY_REDIRECT_URI,
  ANTIGRAVITY_SCOPES,
  ANTIGRAVITY_TOKEN_URL,
  AntigravityAuthError,
  assertAntigravityCredsReadable,
  buildAuthorizationUrl,
  clearAntigravityAccessTokenCache,
  exchangeAuthorizationCode,
  generatePkcePair,
  getAccessToken,
  listCredentialAccounts,
  login,
  readCredentials,
  refreshAccessToken,
  resolveBridgeDir,
  resolveCredentialPath,
  resolveOAuthClientConfig,
  writeCredentials,
};
