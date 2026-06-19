import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

const CONTRACT_VERSION = '1.0';
const DEFAULT_ENDPOINT_URL = 'http://127.0.0.1:8003';
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const APP_ID_RE = /^[a-z0-9][a-z0-9._-]*$/;

export async function connectAppContract(options = {}) {
  const config = normalizeConnectOptions(options);
  if (config.mode === 'standalone') {
    return new StandaloneSession(config);
  }
  const bootstrapToken = await resolveBootstrapToken(config);
  const response = await requestJson(`${config.endpoint_url}/v1/register`, {
    method: 'POST',
    token: bootstrapToken,
    body: {
      op: 'register',
      contract_version: CONTRACT_VERSION,
      app_id: config.app_id,
      app_version: config.app_version,
      mode: 'agent-os',
      subscribes: config.subscribes,
    },
    timeoutMs: config.request_timeout_ms,
    maxAttempts: config.request_retry_attempts,
  });
  if (!response.session_token) {
    throw new Error('register response did not include session_token');
  }
  return new AppContractSession(config, response.session_token);
}

function normalizeConnectOptions(options) {
  const appId = String(options.app_id ?? options.appId ?? '').trim();
  if (!appId) {
    throw new Error('connect requires app_id');
  }
  if (!APP_ID_RE.test(appId)) {
    throw new Error(`invalid app_id: ${appId}`);
  }
  const mode = options.mode ?? 'agent-os';
  if (mode !== 'agent-os' && mode !== 'standalone') {
    throw new Error("mode must be 'agent-os' or 'standalone'");
  }
  return {
    ...options,
    app_id: appId,
    app_version: options.app_version ?? options.appVersion ?? null,
    mode,
    subscribes: options.subscribes ?? [],
    endpoint_url: trimTrailingSlash(
      options.endpoint_url
        ?? options.endpointUrl
        ?? process.env.APP_CONTRACT_ENDPOINT_URL
        ?? DEFAULT_ENDPOINT_URL,
    ),
    request_timeout_ms: options.request_timeout_ms
      ?? options.requestTimeoutMs
      ?? DEFAULT_REQUEST_TIMEOUT_MS,
    request_retry_attempts: options.request_retry_attempts
      ?? options.requestRetryAttempts
      ?? 3,
  };
}

async function resolveBootstrapToken(config) {
  if (config.bootstrap_token ?? config.bootstrapToken) {
    return config.bootstrap_token ?? config.bootstrapToken;
  }
  const tokenFile = config.bootstrap_token_path
    ?? config.bootstrapTokenPath
    ?? process.env.APP_CONTRACT_BOOTSTRAP_TOKEN_FILE;
  if (tokenFile) {
    return (await readFile(tokenFile, 'utf8')).trim();
  }
  if (process.env.APP_CONTRACT_BOOTSTRAP_TOKEN) {
    return process.env.APP_CONTRACT_BOOTSTRAP_TOKEN;
  }
  const hqRoot = config.hq_root
    ?? config.hqRoot
    ?? process.env.APP_CONTRACT_HQ_ROOT
    ?? process.env.HQ_ROOT;
  if (hqRoot) {
    const bootstrapDir = resolve(String(hqRoot), 'apps', 'bootstrap');
    const tokenPath = resolve(bootstrapDir, `${config.app_id}.bearer`);
    if (!pathInside(tokenPath, bootstrapDir)) {
      throw new Error('bootstrap token path escaped apps/bootstrap');
    }
    return (await readFile(tokenPath, 'utf8')).trim();
  }
  throw new Error('agent-os mode requires a bootstrap token or bootstrap token file');
}

class AppContractSession {
  constructor(config, sessionToken) {
    this.app_id = config.app_id;
    this.mode = 'agent-os';
    this.endpoint_url = config.endpoint_url;
    this.sessionToken = sessionToken;
    this.requestTimeoutMs = config.request_timeout_ms;
    this.requestRetryAttempts = config.request_retry_attempts;
  }

  async dispatch(payload) {
    const body = stripUndefined({ ...payload });
    delete body.app_id;
    return requestJson(`${this.endpoint_url}/v1/dispatch`, {
      method: 'POST',
      token: this.sessionToken,
      body,
      timeoutMs: this.requestTimeoutMs,
      maxAttempts: this.requestRetryAttempts,
    });
  }

  async dispatchStatus(requestId) {
    return requestJson(`${this.endpoint_url}/v1/dispatch_status`, {
      method: 'POST',
      token: this.sessionToken,
      body: { request_id: requestId },
      timeoutMs: this.requestTimeoutMs,
      maxAttempts: this.requestRetryAttempts,
    });
  }
}

class StandaloneSession {
  constructor(config) {
    this.app_id = config.app_id;
    this.mode = 'standalone';
    this.dispatches = new Map();
  }

  async dispatch(payload) {
    const requestId = requireRequestId(payload);
    const existing = this.dispatches.get(requestId);
    if (existing) {
      return existing;
    }
    const launchRequestId = `standalone-${randomUUID()}`;
    const accepted = {
      app_id: this.app_id,
      request_id: requestId,
      launch_request_id: launchRequestId,
      watch_url: `standalone://watch/${launchRequestId}`,
      audit_ref: `standalone://audit/${this.app_id}/${requestId}`,
    };
    this.dispatches.set(requestId, accepted);
    return accepted;
  }

  async dispatchStatus(requestId) {
    const existing = this.dispatches.get(requestId);
    if (!existing) {
      return { status: 'not_found', app_id: this.app_id, request_id: requestId };
    }
    return { status: 'found', ...existing };
  }
}

async function requestJson(url, {
  method,
  token,
  body,
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  maxAttempts = 3,
}) {
  const numericAttempts = Number(maxAttempts);
  const attempts = Number.isInteger(numericAttempts) && numericAttempts > 0 ? numericAttempts : 1;
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await requestJsonOnce(url, { method, token, body, timeoutMs });
    } catch (error) {
      lastError = error;
      if (attempt >= attempts || !isRetryableAppContractError(error)) {
        throw error;
      }
      await delay(Math.min(250, 50 * attempt));
    }
  }
  throw lastError;
}

async function requestJsonOnce(url, { method, token, body, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(stripUndefined(body)),
      signal: controller.signal,
    });
  } catch (error) {
    if (error?.name === 'AbortError') {
      const timeoutError = new Error(`app-contract request timed out after ${timeoutMs}ms`);
      timeoutError.retryable = true;
      throw timeoutError;
    }
    if (isTransientFetchError(error)) {
      error.retryable = true;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
  const text = await response.text();
  const data = parseJsonResponse(text, response.status);
  if (!response.ok) {
    const code = data?.error?.code ?? response.status;
    const message = data?.error?.message ?? response.statusText;
    const error = new Error(`app-contract ${code}: ${message}`);
    error.status = response.status;
    error.retryable = response.status === 429 || response.status >= 500;
    throw error;
  }
  return data;
}

function isRetryableAppContractError(error) {
  return Boolean(error?.retryable || isTransientFetchError(error));
}

function isTransientFetchError(error) {
  const code = String(error?.cause?.code || error?.code || '').toUpperCase();
  const message = String(error?.message || '');
  return ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ENETUNREACH'].includes(code)
    || /fetch failed|network|connection (?:refused|reset|timed out)|timeout/i.test(message);
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function parseJsonResponse(text, status) {
  if (!text) {
    return {};
  }
  try {
    return JSON.parse(text);
  } catch {
    const snippet = text.slice(0, 120);
    throw new Error(`app-contract bad_response: non-JSON response (status ${status}): ${snippet}`);
  }
}

function stripUndefined(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  );
}

function requireRequestId(payload) {
  const requestId = String(payload?.request_id ?? payload?.requestId ?? '').trim();
  if (!requestId) {
    throw new Error('dispatch requires request_id');
  }
  return requestId;
}

function trimTrailingSlash(value) {
  return String(value).replace(/\/+$/, '');
}

function pathInside(candidate, parent) {
  const rel = resolve(candidate).slice(resolve(parent).length);
  return rel === '' || rel.startsWith('/');
}
