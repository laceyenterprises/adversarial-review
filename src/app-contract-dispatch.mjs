import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';

const CONTRACT_VERSION = '1.0';
const DEFAULT_ENDPOINT_URL = 'http://127.0.0.1:8003';
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_STANDALONE_DISPATCH_CACHE_MAX_ENTRIES = 1_000;
const DEFAULT_DISPATCH_COMMAND_OUTPUT_MAX_BYTES = 4 * 1024 * 1024;
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
    standalone_dispatch_cache_max_entries: options.standalone_dispatch_cache_max_entries
      ?? options.standaloneDispatchCacheMaxEntries
      ?? DEFAULT_STANDALONE_DISPATCH_CACHE_MAX_ENTRIES,
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
    this.listeners = new Map();
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

  on(topic, callback) {
    return registerTopicListener(this.listeners, topic, callback);
  }

  emitTopic(topic, event) {
    return emitTopic(this.listeners, topic, event);
  }
}

class StandaloneSession {
  constructor(config) {
    this.app_id = config.app_id;
    this.mode = 'standalone';
    this.config = config;
    this.dispatches = new Map();
    this.pendingDispatches = new Map();
    this.listeners = new Map();
    this.dispatchCacheMaxEntries = normalizePositiveInteger(
      config.standalone_dispatch_cache_max_entries,
      DEFAULT_STANDALONE_DISPATCH_CACHE_MAX_ENTRIES,
    );
  }

  async dispatch(payload) {
    const requestId = requireRequestId(payload);
    const existing = this.dispatches.get(requestId);
    if (existing) {
      return existing;
    }
    const inFlight = this.pendingDispatches.get(requestId);
    if (inFlight) {
      return await inFlight;
    }
    const pending = this.acceptDispatch(payload, requestId);
    this.pendingDispatches.set(requestId, pending);
    try {
      const accepted = await pending;
      this.recordAcceptedDispatch(requestId, accepted);
      return accepted;
    } catch (error) {
      if (this.pendingDispatches.get(requestId) === pending) {
        this.pendingDispatches.delete(requestId);
      }
      throw error;
    }
  }

  async acceptDispatch(payload, requestId) {
    const launchRequestId = await this.launch(payload);
    const accepted = {
      app_id: this.app_id,
      request_id: requestId,
      launch_request_id: launchRequestId,
      watch_url: `standalone://watch/${launchRequestId}`,
      audit_ref: `standalone://audit/${this.app_id}/${requestId}`,
    };
    return accepted;
  }

  async launch(payload) {
    if (typeof this.config.standalone_dispatcher === 'function') {
      const result = await this.config.standalone_dispatcher(payload);
      return normalizeLaunchRequestId(result);
    }
    const command = this.config.dispatch_command ?? this.config.dispatchCommand;
    if (command) {
      const result = await runDispatchCommand(command, payload, {
        timeoutMs: this.config.request_timeout_ms,
      });
      return normalizeLaunchRequestId(result);
    }
    return `standalone-${randomUUID()}`;
  }

  async dispatchStatus(requestId) {
    const existing = this.dispatches.get(requestId);
    if (existing) {
      return { status: 'found', ...existing };
    }
    if (this.pendingDispatches.has(requestId)) {
      return { status: 'dispatching', app_id: this.app_id, request_id: requestId };
    }
    return { status: 'not_found', app_id: this.app_id, request_id: requestId };
  }

  recordAcceptedDispatch(requestId, accepted) {
    this.pendingDispatches.delete(requestId);
    this.dispatches.set(requestId, accepted);
    while (this.dispatches.size > this.dispatchCacheMaxEntries) {
      const oldestRequestId = this.dispatches.keys().next().value;
      this.dispatches.delete(oldestRequestId);
    }
  }

  on(topic, callback) {
    return registerTopicListener(this.listeners, topic, callback);
  }

  emitTopic(topic, event) {
    return emitTopic(this.listeners, topic, event);
  }
}

function registerTopicListener(listeners, topic, callback) {
  const normalizedTopic = String(topic || '').trim();
  if (!normalizedTopic) {
    throw new Error('os.on requires a topic');
  }
  if (typeof callback !== 'function') {
    throw new Error('os.on requires a callback');
  }
  const topicListeners = listeners.get(normalizedTopic) || new Set();
  topicListeners.add(callback);
  listeners.set(normalizedTopic, topicListeners);
  return () => {
    topicListeners.delete(callback);
    if (topicListeners.size === 0) listeners.delete(normalizedTopic);
  };
}

function emitTopic(listeners, topic, event) {
  const normalizedTopic = String(topic || '').trim();
  const deliveries = [];
  for (const [pattern, callbacks] of listeners.entries()) {
    if (!topicMatches(pattern, normalizedTopic)) continue;
    for (const callback of callbacks) {
      try {
        deliveries.push(Promise.resolve(callback(event, normalizedTopic)).catch((err) => {
          console.error?.('[app-contract] topic listener rejected', {
            topic: normalizedTopic,
            pattern,
            error: err?.message || String(err),
          });
          return { delivered: false, error: err };
        }));
      } catch (err) {
        console.error?.('[app-contract] topic listener threw', {
          topic: normalizedTopic,
          pattern,
          error: err?.message || String(err),
        });
        deliveries.push(Promise.resolve({ delivered: false, error: err }));
      }
    }
  }
  return deliveries;
}

function topicMatches(pattern, topic) {
  if (pattern === topic) return true;
  if (!pattern.includes('*')) return false;
  const escaped = pattern
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${escaped}$`).test(topic);
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

function runDispatchCommand(command, payload, { timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS } = {}) {
  const argv = Array.isArray(command) ? command : [command];
  return new Promise((resolveCommand, reject) => {
    const child = spawn(argv[0], argv.slice(1), { stdio: ['pipe', 'pipe', 'pipe'] });
    const commandTimeoutMs = normalizePositiveInteger(timeoutMs, DEFAULT_REQUEST_TIMEOUT_MS);
    const stdoutChunks = [];
    const stderrChunks = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      settleReject(retryableDispatchCommandError(`standalone dispatch command timed out after ${commandTimeoutMs}ms`));
    }, commandTimeoutMs);

    function settleResolve(value) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolveCommand(value);
    }

    function settleReject(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    }

    child.stdout.on('data', (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes + stderrBytes > DEFAULT_DISPATCH_COMMAND_OUTPUT_MAX_BYTES) {
        child.kill('SIGKILL');
        settleReject(retryableDispatchCommandError(
          `standalone dispatch command output exceeded ${DEFAULT_DISPATCH_COMMAND_OUTPUT_MAX_BYTES} bytes`,
        ));
        return;
      }
      stdoutChunks.push(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderrBytes += chunk.length;
      if (stdoutBytes + stderrBytes > DEFAULT_DISPATCH_COMMAND_OUTPUT_MAX_BYTES) {
        child.kill('SIGKILL');
        settleReject(retryableDispatchCommandError(
          `standalone dispatch command output exceeded ${DEFAULT_DISPATCH_COMMAND_OUTPUT_MAX_BYTES} bytes`,
        ));
        return;
      }
      stderrChunks.push(chunk);
    });
    child.on('error', (error) => {
      settleReject(markRetryableTransientDispatchError(error));
    });
    child.stdin.on('error', (error) => {
      if (isBestEffortStdinWriteError(error)) return;
      settleReject(markRetryableTransientDispatchError(error));
    });
    child.on('close', (code) => {
      if (settled) return;
      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      const stderr = Buffer.concat(stderrChunks).toString('utf8');
      if (code !== 0) {
        settleReject(new Error(`standalone dispatch command failed (${code}): ${stderr || stdout}`));
        return;
      }
      try {
        settleResolve(stdout.trim() ? JSON.parse(stdout) : {});
      } catch (error) {
        settleReject(error);
      }
    });
    try {
      child.stdin.end(JSON.stringify(stripUndefined(payload)));
    } catch (error) {
      if (!isBestEffortStdinWriteError(error)) {
        settleReject(markRetryableTransientDispatchError(error));
      }
    }
  });
}

function retryableDispatchCommandError(message) {
  const error = new Error(message);
  error.retryable = true;
  return error;
}

function markRetryableTransientDispatchError(error) {
  if (isTransientDispatchCommandError(error)) {
    error.retryable = true;
  }
  return error;
}

function isTransientDispatchCommandError(error) {
  const code = String(error?.code || '').toUpperCase();
  return ['EAGAIN', 'EIO', 'ENOMEM'].includes(code);
}

function isBestEffortStdinWriteError(error) {
  const code = String(error?.code || '').toUpperCase();
  return code === 'EPIPE' || code === 'ERR_STREAM_DESTROYED';
}

function normalizeLaunchRequestId(result) {
  if (typeof result === 'string' && result) {
    return result;
  }
  const launchRequestId = result?.launch_request_id ?? result?.launchRequestId ?? result?.dispatchId;
  if (!launchRequestId) {
    throw new Error('standalone dispatch did not return a launch request id');
  }
  return String(launchRequestId);
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

function normalizePositiveInteger(value, fallback) {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : fallback;
}

function trimTrailingSlash(value) {
  return String(value).replace(/\/+$/, '');
}

function pathInside(candidate, parent) {
  const rel = resolve(candidate).slice(resolve(parent).length);
  return rel === '' || rel.startsWith('/');
}
