import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';

const ANTIGRAVITY_CLIENT_ID_ENV = 'GEMINI_ANTIGRAVITY_CLIENT_ID';
const ANTIGRAVITY_CLIENT_SECRET_ENV = 'GEMINI_ANTIGRAVITY_CLIENT_SECRET';
const ANTIGRAVITY_REDIRECT_URI = 'http://localhost:51121/oauth-callback';
const ANTIGRAVITY_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const ANTIGRAVITY_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_ENDPOINT = 'https://www.googleapis.com/oauth2/v1/userinfo?alt=json';
const ANTIGRAVITY_SCOPES = Object.freeze([
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/cclog',
  'https://www.googleapis.com/auth/experimentsandconfigs',
]);
const ACCESS_TOKEN_EXPIRY_BUFFER_MS = 60_000;
const CALLBACK_TIMEOUT_MS = 180_000;

const accessTokenCache = new Map();

class AntigravityBridgeError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'AntigravityBridgeError';
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

function encodeState(payload) {
  return base64Url(Buffer.from(JSON.stringify(payload), 'utf8'));
}

function decodeState(state) {
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(state, 'base64url').toString('utf8'));
  } catch (err) {
    throw new AntigravityBridgeError('AUTH_STATE_INVALID', `invalid OAuth state: ${err.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || typeof parsed.nonce !== 'string') {
    throw new AntigravityBridgeError('AUTH_STATE_INVALID', 'invalid OAuth state: missing nonce');
  }
  return parsed;
}

function buildAuthorizationUrl({
  pkce = generatePkcePair(),
  state = encodeState({ nonce: base64Url(randomBytes(18)), projectId: '' }),
  projectId = '',
  authEndpoint = ANTIGRAVITY_AUTH_ENDPOINT,
  redirectUri = ANTIGRAVITY_REDIRECT_URI,
  clientId = process.env[ANTIGRAVITY_CLIENT_ID_ENV],
  scopes = ANTIGRAVITY_SCOPES,
} = {}) {
  if (!clientId) {
    throw new AntigravityBridgeError('OAUTH_CLIENT_CONFIG_MISSING', `${ANTIGRAVITY_CLIENT_ID_ENV} is required`);
  }
  const statePayload = typeof state === 'string' ? state : encodeState({
    nonce: state.nonce,
    projectId: projectId || state.projectId || '',
  });
  const url = new URL(authEndpoint);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', scopes.join(' '));
  url.searchParams.set('code_challenge', pkce.challenge);
  url.searchParams.set('code_challenge_method', pkce.method || 'S256');
  url.searchParams.set('state', statePayload);
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  return {
    url: url.toString(),
    verifier: pkce.verifier,
    state: statePayload,
    projectId: projectId || '',
  };
}

function resolveBridgeDir(env = process.env) {
  if (env.GEMINI_ANTIGRAVITY_BRIDGE_DIR) return env.GEMINI_ANTIGRAVITY_BRIDGE_DIR;
  const geminiHome = env.GEMINI_HOME || join(env.HOME || homedir(), '.gemini');
  return join(geminiHome, 'antigravity-bridge');
}

function validateAccountId(accountId) {
  if (typeof accountId !== 'string' || !/^[A-Za-z0-9._@-]+$/.test(accountId) || accountId.includes('..')) {
    throw new AntigravityBridgeError('ACCOUNT_ID_INVALID', `invalid Antigravity account id: ${accountId}`);
  }
}

function resolveCredentialPath(accountId, { env = process.env, bridgeDir } = {}) {
  validateAccountId(accountId);
  return join(bridgeDir || resolveBridgeDir(env), `${accountId}.json`);
}

function ensurePrivateBridgeDir(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}

function writePrivateJsonFile(filePath, value) {
  ensurePrivateBridgeDir(dirname(filePath));
  const tempPath = join(dirname(filePath), `.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`);
  const fd = openSync(tempPath, 'wx', 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  } finally {
    closeSync(fd);
  }
  chmodSync(tempPath, 0o600);
  renameSync(tempPath, filePath);
  chmodSync(filePath, 0o600);
}

function readCredentialFile(accountId, { env = process.env, bridgeDir, filePath } = {}) {
  const credentialPath = filePath || resolveCredentialPath(accountId, { env, bridgeDir });
  if (!existsSync(credentialPath)) {
    throw new AntigravityBridgeError('CREDS_MISSING', `Antigravity credential file missing: ${credentialPath}`, {
      accountId,
      path: credentialPath,
    });
  }

  let raw;
  try {
    raw = readFileSync(credentialPath, 'utf8');
  } catch (err) {
    throw new AntigravityBridgeError('CREDS_UNREADABLE', `cannot read ${credentialPath}: ${err.message}`, {
      accountId,
      path: credentialPath,
    });
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new AntigravityBridgeError('CREDS_CORRUPT', `invalid Antigravity credential JSON at ${credentialPath}: ${err.message}`, {
      accountId,
      path: credentialPath,
    });
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new AntigravityBridgeError('CREDS_CORRUPT', `invalid Antigravity credential JSON at ${credentialPath}: expected object`, {
      accountId,
      path: credentialPath,
    });
  }
  if (typeof parsed.email !== 'string' || parsed.email.length === 0) {
    throw new AntigravityBridgeError('CREDS_INVALID', `Antigravity credential file missing email: ${credentialPath}`, {
      accountId,
      path: credentialPath,
    });
  }
  if (typeof parsed.refreshToken !== 'string' || parsed.refreshToken.length === 0) {
    throw new AntigravityBridgeError('CREDS_INVALID', `Antigravity credential file missing refreshToken: ${credentialPath}`, {
      accountId,
      path: credentialPath,
    });
  }
  if (parsed.projectId !== undefined && typeof parsed.projectId !== 'string') {
    throw new AntigravityBridgeError('CREDS_INVALID', `Antigravity credential file has invalid projectId: ${credentialPath}`, {
      accountId,
      path: credentialPath,
    });
  }

  return { creds: parsed, path: credentialPath };
}

function assertAntigravityOAuth(accountId, options = {}) {
  return readCredentialFile(accountId, options).path;
}

function writeCredentialFile(accountId, { email, refreshToken, projectId }, { env = process.env, bridgeDir } = {}) {
  validateAccountId(accountId);
  if (typeof email !== 'string' || email.length === 0) {
    throw new AntigravityBridgeError('CREDS_INVALID', 'cannot write Antigravity credentials without email');
  }
  if (typeof refreshToken !== 'string' || refreshToken.length === 0) {
    throw new AntigravityBridgeError('CREDS_INVALID', 'cannot write Antigravity credentials without refreshToken');
  }
  const credentialPath = resolveCredentialPath(accountId, { env, bridgeDir });
  const body = {
    email,
    refreshToken,
    ...(projectId ? { projectId } : {}),
  };
  writePrivateJsonFile(credentialPath, body);
  return credentialPath;
}

function parseOAuthErrorPayload(text) {
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed?.error === 'string') {
      return { oauthError: parsed.error, oauthDescription: parsed.error_description };
    }
    if (parsed?.error && typeof parsed.error === 'object') {
      return {
        oauthError: parsed.error.status || parsed.error.code,
        oauthDescription: parsed.error.message || parsed.error_description,
      };
    }
  } catch {
    return { oauthDescription: text };
  }
  return {};
}

async function refreshAccessToken(refreshToken, {
  fetchImpl = fetch,
  tokenEndpoint = ANTIGRAVITY_TOKEN_ENDPOINT,
  clientId = process.env[ANTIGRAVITY_CLIENT_ID_ENV],
  clientSecret = process.env[ANTIGRAVITY_CLIENT_SECRET_ENV],
  now = () => Date.now(),
} = {}) {
  if (!clientId || !clientSecret) {
    throw new AntigravityBridgeError('OAUTH_CLIENT_CONFIG_MISSING', `${ANTIGRAVITY_CLIENT_ID_ENV} and ${ANTIGRAVITY_CLIENT_SECRET_ENV} are required`);
  }
  const startTime = now();
  const response = await fetchImpl(tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    const parsed = parseOAuthErrorPayload(text);
    const errorCode = parsed.oauthError === 'invalid_grant' ? 'REFRESH_TOKEN_EXPIRED' : 'TOKEN_REFRESH_FAILED';
    throw new AntigravityBridgeError(errorCode, `Antigravity token refresh failed (${response.status} ${response.statusText})`, {
      status: response.status,
      statusText: response.statusText,
      ...parsed,
    });
  }

  const payload = await response.json();
  if (typeof payload?.access_token !== 'string' || payload.access_token.length === 0) {
    throw new AntigravityBridgeError('TOKEN_RESPONSE_INVALID', 'Antigravity token endpoint did not return an access token');
  }
  const expiresInSeconds = Number.isFinite(payload.expires_in) && payload.expires_in > 0 ? payload.expires_in : 3600;
  return {
    accessToken: payload.access_token,
    refreshToken: typeof payload.refresh_token === 'string' && payload.refresh_token.length > 0 ? payload.refresh_token : refreshToken,
    expiresAt: startTime + expiresInSeconds * 1000,
  };
}

async function getAccessToken(accountId, options = {}) {
  const now = options.now || (() => Date.now());
  const credentialPath = options.filePath || resolveCredentialPath(accountId, options);
  const cacheKey = credentialPath;
  const cached = accessTokenCache.get(cacheKey);
  if (cached?.accessToken && cached.expiresAt > now() + ACCESS_TOKEN_EXPIRY_BUFFER_MS) {
    return cached.accessToken;
  }

  const { creds } = readCredentialFile(accountId, { ...options, filePath: credentialPath });
  try {
    const refreshed = await refreshAccessToken(creds.refreshToken, options);
    accessTokenCache.set(cacheKey, {
      accessToken: refreshed.accessToken,
      expiresAt: refreshed.expiresAt,
    });
    if (refreshed.refreshToken !== creds.refreshToken) {
      writeCredentialFile(accountId, {
        email: creds.email,
        refreshToken: refreshed.refreshToken,
        projectId: creds.projectId,
      }, options);
    }
    return refreshed.accessToken;
  } catch (err) {
    if (err instanceof AntigravityBridgeError) {
      err.accountId = accountId;
      err.path = credentialPath;
    }
    throw err;
  }
}

function clearAccessTokenCache() {
  accessTokenCache.clear();
}

function constantTimeEquals(a, b) {
  const left = Buffer.from(a || '');
  const right = Buffer.from(b || '');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function startCallbackServer({ expectedState, port = 51121, timeoutMs = CALLBACK_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const server = createServer((req, res) => {
      const url = new URL(req.url, `http://${req.headers.host || `localhost:${port}`}`);
      if (url.pathname !== '/oauth-callback') {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
        return;
      }
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      const error = url.searchParams.get('error');
      if (error) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Authentication failed. You can close this tab.');
        finish(reject, new AntigravityBridgeError('LOGIN_DENIED', `OAuth login denied: ${error}`));
        return;
      }
      if (!code || !state || !constantTimeEquals(state, expectedState)) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Authentication failed. You can close this tab.');
        finish(reject, new AntigravityBridgeError('CALLBACK_INVALID', 'OAuth callback missing code or has invalid state'));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('Authentication complete. You can close this tab.');
      finish(resolve, { code, state });
    });
    const timer = setTimeout(() => {
      finish(reject, new AntigravityBridgeError('CALLBACK_TIMEOUT', 'timed out waiting for OAuth callback'));
    }, timeoutMs);

    function finish(fn, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.close(() => fn(value));
    }

    server.on('error', (err) => {
      finish(reject, new AntigravityBridgeError('CALLBACK_SERVER_FAILED', `cannot start OAuth callback server: ${err.message}`));
    });
    server.listen(port, '127.0.0.1');
  });
}

function openBrowser(url) {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  const child = spawn(command, args, { stdio: 'ignore', detached: true });
  child.on('error', () => {});
  child.unref();
}

async function exchangeAuthorizationCode(code, verifier, {
  fetchImpl = fetch,
  tokenEndpoint = ANTIGRAVITY_TOKEN_ENDPOINT,
  userInfoEndpoint = GOOGLE_USERINFO_ENDPOINT,
  redirectUri = ANTIGRAVITY_REDIRECT_URI,
  clientId = process.env[ANTIGRAVITY_CLIENT_ID_ENV],
  clientSecret = process.env[ANTIGRAVITY_CLIENT_SECRET_ENV],
  now = () => Date.now(),
} = {}) {
  if (!clientId || !clientSecret) {
    throw new AntigravityBridgeError('OAUTH_CLIENT_CONFIG_MISSING', `${ANTIGRAVITY_CLIENT_ID_ENV} and ${ANTIGRAVITY_CLIENT_SECRET_ENV} are required`);
  }
  const startTime = now();
  const response = await fetchImpl(tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8', Accept: '*/*' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
      code_verifier: verifier,
    }),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new AntigravityBridgeError('CODE_EXCHANGE_FAILED', `Antigravity code exchange failed (${response.status} ${response.statusText})`, {
      status: response.status,
      statusText: response.statusText,
      ...parseOAuthErrorPayload(text),
    });
  }
  const payload = await response.json();
  if (typeof payload?.refresh_token !== 'string' || payload.refresh_token.length === 0) {
    throw new AntigravityBridgeError('TOKEN_RESPONSE_INVALID', 'Antigravity token endpoint did not return a refresh token');
  }
  if (typeof payload?.access_token !== 'string' || payload.access_token.length === 0) {
    throw new AntigravityBridgeError('TOKEN_RESPONSE_INVALID', 'Antigravity token endpoint did not return an access token');
  }

  let email = '';
  const userInfo = await fetchImpl(userInfoEndpoint, {
    headers: { Authorization: `Bearer ${payload.access_token}` },
  }).catch(() => null);
  if (userInfo?.ok) {
    const info = await userInfo.json().catch(() => ({}));
    email = typeof info.email === 'string' ? info.email : '';
  }

  return {
    email,
    refreshToken: payload.refresh_token,
    accessToken: payload.access_token,
    expiresAt: startTime + ((Number.isFinite(payload.expires_in) && payload.expires_in > 0 ? payload.expires_in : 3600) * 1000),
  };
}

async function login(accountId, {
  projectId = '',
  openBrowserImpl = openBrowser,
  startCallbackServerImpl = startCallbackServer,
  exchangeAuthorizationCodeImpl = exchangeAuthorizationCode,
  env = process.env,
  bridgeDir,
  ...options
} = {}) {
  const pkce = generatePkcePair();
  const state = encodeState({ nonce: base64Url(randomBytes(18)), projectId });
  decodeState(state);
  const authorization = buildAuthorizationUrl({ pkce, state, projectId, ...options });
  const callbackPromise = startCallbackServerImpl({ expectedState: authorization.state, ...options });
  openBrowserImpl(authorization.url);
  const { code } = await callbackPromise;
  const tokens = await exchangeAuthorizationCodeImpl(code, authorization.verifier, options);
  const email = tokens.email || `${accountId}@unknown.local`;
  const credentialPath = writeCredentialFile(accountId, {
    email,
    refreshToken: tokens.refreshToken,
    projectId: projectId || undefined,
  }, { env, bridgeDir, ...options });
  accessTokenCache.set(credentialPath, {
    accessToken: tokens.accessToken,
    expiresAt: tokens.expiresAt,
  });
  return {
    accountId,
    email,
    projectId: projectId || undefined,
    path: credentialPath,
  };
}

function credentialStatus(accountId, options = {}) {
  try {
    const { creds, path } = readCredentialFile(accountId, options);
    return {
      accountId,
      email: creds.email,
      projectId: creds.projectId,
      path,
      refresh: 'ok',
    };
  } catch (err) {
    if (err instanceof AntigravityBridgeError) {
      return {
        accountId,
        path: err.path || resolveCredentialPath(accountId, options),
        refresh: 'missing',
        errorCode: err.code,
        error: err.message,
      };
    }
    throw err;
  }
}

async function removeCredentialFile(accountId, options = {}) {
  const credentialPath = resolveCredentialPath(accountId, options);
  await rm(credentialPath, { force: true });
  accessTokenCache.delete(credentialPath);
}

function credentialFileMode(accountId, options = {}) {
  const dir = options.bridgeDir || resolveBridgeDir(options.env || process.env);
  const credentialPath = resolveCredentialPath(accountId, options);
  return {
    dirMode: existsSync(dir) ? statSync(dir).mode & 0o777 : null,
    fileMode: existsSync(credentialPath) ? statSync(credentialPath).mode & 0o777 : null,
  };
}

export {
  ACCESS_TOKEN_EXPIRY_BUFFER_MS,
  ANTIGRAVITY_AUTH_ENDPOINT,
  ANTIGRAVITY_CLIENT_ID_ENV,
  ANTIGRAVITY_CLIENT_SECRET_ENV,
  ANTIGRAVITY_REDIRECT_URI,
  ANTIGRAVITY_SCOPES,
  ANTIGRAVITY_TOKEN_ENDPOINT,
  AntigravityBridgeError,
  assertAntigravityOAuth,
  buildAuthorizationUrl,
  clearAccessTokenCache,
  credentialFileMode,
  credentialStatus,
  exchangeAuthorizationCode,
  generatePkcePair,
  getAccessToken,
  login,
  readCredentialFile,
  refreshAccessToken,
  removeCredentialFile,
  resolveBridgeDir,
  resolveCredentialPath,
  startCallbackServer,
  writeCredentialFile,
};
