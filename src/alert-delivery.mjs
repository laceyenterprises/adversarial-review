import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import https from 'node:https';

const DEFAULT_SECRETS_ROOT = join(homedir(), '.config', 'adversarial-review', 'secrets');
const LEGACY_SECRETS_ROOT = '/Users/airlock/agent-os/agents/clio/credentials/local';  // cfg-allowlist(account-airlock): oss-readiness-apply-reviewed
const DEFAULT_AGENT_GATEWAY_AGENT_HOOKS_URL = 'http://127.0.0.1:18799/hooks/agent';
const DEFAULT_ALERT_AGENT_ID = 'main';
const DEFAULT_ALERT_NAME = 'Adversarial Watcher Health';
const DEFAULT_HTTP_TIMEOUT_MS = 5_000;
const HTTP_TIMEOUT_MS = Number(
  process.env.ALERT_HTTP_TIMEOUT_MS || process.env.HTTP_TIMEOUT_MS || DEFAULT_HTTP_TIMEOUT_MS
);
const TEL_COMMS_TELEMETRY_URL = new URL(
  '../../../modules/agent-gateway/lib/tel-comms-telemetry.mjs',
  import.meta.url
);

let telTelemetryPromise;

function firstNonEmpty(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function resolveDefaultHooksTokenFile(fsImpl = { existsSync }) {
  const defaultTokenFile = join(DEFAULT_SECRETS_ROOT, 'litellm-alert-bridge.token');
  const legacyTokenFile = join(LEGACY_SECRETS_ROOT, 'litellm-alert-bridge.token');
  if (fsImpl.existsSync(defaultTokenFile)) return defaultTokenFile;
  if (fsImpl.existsSync(legacyTokenFile)) return legacyTokenFile;
  return defaultTokenFile;
}

function resolveHooksTokenFileFromRoot(root, fsImpl = { existsSync }) {
  const trimmedRoot = typeof root === 'string' ? root.trim() : '';
  if (!trimmedRoot) return null;
  const candidateTokenFile = join(trimmedRoot, 'litellm-alert-bridge.token');
  return fsImpl.existsSync(candidateTokenFile) ? candidateTokenFile : null;
}

// Alert config resolution — precedence chains are load-bearing; reordering
// them changes which deployment wins silently. Ordering rationale:
//   - Hooks URL: specific (AGENT_GATEWAY_AGENT_HOOKS_URL) over legacy spelling
//     (OPENCLAW_AGENT_HOOKS_URL) over the localhost gateway default. Both env
//     names must keep working — launchd plists on older hosts still export the
//     legacy one.
//   - Token FILE: explicit file overrides (OPENCLAW_HOOKS_TOKEN_FILE, then
//     HOOKS_TOKEN_FILE) over secrets-root probing (ADV_SECRETS_ROOT before
//     LITELLM_SECRETS_ROOT — the adversarial-specific root must beat the
//     shared LiteLLM root when both are set) over the default/legacy paths.
//     The root probes return a path only if the file EXISTS; the final
//     default does NOT check existence, so a missing file surfaces later as a
//     token-read failure rather than a confusing null config.
//   - ALERT_TO is fail-loud (throw): a page with no recipient is a silent
//     alert blackhole, which is the exact failure this daemon exists to page
//     about.
// Threat model: these are paging credentials for the watcher's health
// alerts. The silent-misresolution failure mode is a STALE-but-present
// source earlier in the chain (e.g. a generic HOOKS_TOKEN exported for some
// other service) shadowing the intended one — resolution succeeds, delivery
// 401s, and the operator never gets the page. When alerts auth-fail, audit
// the full chain in this order before touching token files.
function resolveAlertDefaults(env = process.env, { fsImpl = { existsSync } } = {}) {
  const alertTo = firstNonEmpty(env.ALERT_TO);
  if (!alertTo) {
    throw new Error('ALERT_TO must be configured for alert delivery');
  }
  return {
    openclawAgentHooksUrl:
      env.AGENT_GATEWAY_AGENT_HOOKS_URL ||
      env.OPENCLAW_AGENT_HOOKS_URL ||
      DEFAULT_AGENT_GATEWAY_AGENT_HOOKS_URL,
    hooksTokenFile:
      env.OPENCLAW_HOOKS_TOKEN_FILE ||
      env.HOOKS_TOKEN_FILE ||
      resolveHooksTokenFileFromRoot(env.ADV_SECRETS_ROOT, fsImpl) ||
      resolveHooksTokenFileFromRoot(env.LITELLM_SECRETS_ROOT, fsImpl) ||
      resolveDefaultHooksTokenFile(fsImpl),
    alertChannel: env.ALERT_CHANNEL || 'telegram',
    alertTo,
    alertAgentId: env.ALERT_AGENT_ID || DEFAULT_ALERT_AGENT_ID,
    alertName: env.ALERT_NAME || DEFAULT_ALERT_NAME,
  };
}

// Token VALUE precedence: direct env tokens (GATEWAY_DELIVERY_TOKEN, then
// the OPENCLAW_*/HOOKS_TOKEN legacy spellings) beat the file-sourced token.
// Env-first lets a wrapper inject a freshly-minted token without touching
// disk, but it is also the sharpest silent-misresolution edge: an exported
// stale token wins over a rotated token file with no diagnostic. The file
// read failing is deliberately swallowed (catch → null) so the env chain can
// still satisfy delivery; only ALL sources empty throws.
function readHooksToken({ env = process.env, fsImpl = { readFileSync } } = {}) {
  const config = resolveAlertDefaults(env, { fsImpl: { existsSync: fsImpl.existsSync || existsSync } });
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

function notificationHookPath(urlString) {
  try {
    const url = new URL(urlString);
    return url.pathname || '/';
  } catch {
    return 'unknown';
  }
}

function telTelemetry() {
  if (!telTelemetryPromise) {
    telTelemetryPromise = import(TEL_COMMS_TELEMETRY_URL).catch(() => null);
  }
  return telTelemetryPromise;
}

async function emitNotificationBusDeliverSpan(attrs) {
  const telemetry = await telTelemetry();
  telemetry?.emitNotificationBusDeliverSpan?.(attrs);
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
  const hookPath = notificationHookPath(config.openclawAgentHooksUrl);
  const producer = 'adversarial-review';
  try {
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
    await emitNotificationBusDeliverSpan({ hookPath, producer, outcome: 'success' });
  } catch (error) {
    await emitNotificationBusDeliverSpan({ hookPath, producer, outcome: 'error' });
    throw error;
  }
}

export {
  deliverAlert,
  firstNonEmpty,
  httpRequestText,
  readHooksToken,
  resolveAlertDefaults,
};
