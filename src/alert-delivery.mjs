import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import https from 'node:https';

const DEFAULT_SECRETS_ROOT = join(homedir(), '.config', 'adversarial-review', 'secrets');
const DEFAULT_OPENCLAW_AGENT_HOOKS_URL = 'http://127.0.0.1:18789/hooks/agent';
const DEFAULT_ALERT_AGENT_ID = 'main';
const DEFAULT_ALERT_NAME = 'Adversarial Watcher Health';
const DEFAULT_HTTP_TIMEOUT_MS = 5_000;
const HTTP_TIMEOUT_MS = Number(
  process.env.ALERT_HTTP_TIMEOUT_MS || process.env.HTTP_TIMEOUT_MS || DEFAULT_HTTP_TIMEOUT_MS
);

function firstNonEmpty(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function resolveAlertDefaults(env = process.env) {
  const secretsRoot = env.ADV_SECRETS_ROOT || env.LITELLM_SECRETS_ROOT || DEFAULT_SECRETS_ROOT;
  const alertTo = firstNonEmpty(env.ALERT_TO);
  if (!alertTo) {
    throw new Error('ALERT_TO must be configured for alert delivery');
  }
  return {
    openclawAgentHooksUrl: env.OPENCLAW_AGENT_HOOKS_URL || DEFAULT_OPENCLAW_AGENT_HOOKS_URL,
    hooksTokenFile:
      env.OPENCLAW_HOOKS_TOKEN_FILE ||
      env.HOOKS_TOKEN_FILE ||
      `${secretsRoot}/litellm-alert-bridge.token`,
    alertChannel: env.ALERT_CHANNEL || 'telegram',
    alertTo,
    alertAgentId: env.ALERT_AGENT_ID || DEFAULT_ALERT_AGENT_ID,
    alertName: env.ALERT_NAME || DEFAULT_ALERT_NAME,
  };
}

function readHooksToken({ env = process.env, fsImpl = { readFileSync } } = {}) {
  const config = resolveAlertDefaults(env);
  let tokenFromFile = null;
  try {
    tokenFromFile = fsImpl.readFileSync(config.hooksTokenFile, 'utf8');
  } catch {
    tokenFromFile = null;
  }
  const token = firstNonEmpty(
    env.GATEWAY_DELIVERY_TOKEN,
    env.OPENCLAW_GATEWAY_TOKEN,
    env.OPENCLAW_HOOKS_TOKEN,
    env.HOOKS_TOKEN,
    tokenFromFile
  );
  if (!token) {
    throw new Error('Missing OpenClaw hooks token for alert delivery');
  }
  return token;
}

function httpRequestText(urlString, { method = 'GET', headers = {}, body, timeoutMs = HTTP_TIMEOUT_MS } = {}) {
  const url = new URL(urlString);
  const payload = body != null ? JSON.stringify(body) : null;

  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http;
    const req = transport.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method,
        timeout: timeoutMs,
        headers: {
          ...headers,
          ...(payload
            ? {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload),
              }
            : {}),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          if ((res.statusCode || 500) >= 400) {
            reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 800)}`));
            return;
          }
          resolve(data);
        });
      }
    );

    req.on('timeout', () => {
      req.destroy(new Error(`Request to ${urlString} timed out after ${timeoutMs}ms`));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function deliverAlert(text, {
  event = null,
  payload = null,
  env = process.env,
  fsImpl = { readFileSync },
  requestText = httpRequestText,
} = {}) {
  const config = resolveAlertDefaults(env);
  const token = readHooksToken({ env, fsImpl });
  await requestText(config.openclawAgentHooksUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: {
      message: text,
      name: config.alertName,
      agentId: config.alertAgentId,
      wakeMode: 'now',
      deliver: true,
      channel: config.alertChannel,
      to: config.alertTo,
      ...(event ? { event } : {}),
      ...(payload ? { payload } : {}),
    },
  });
}

export {
  deliverAlert,
  firstNonEmpty,
  httpRequestText,
  readHooksToken,
  resolveAlertDefaults,
};
