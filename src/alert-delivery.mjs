import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { writeFileAtomic } from './atomic-write.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_TOP_LEVEL_PATH = join(homedir(), 'agent-os/config.yaml');
const DEFAULT_SECRETS_ROOT = join(homedir(), '.config', 'adversarial-review', 'secrets');
const LEGACY_SECRETS_ROOT = '/Users/airlock/agent-os/agents/clio/credentials/local';  // cfg-allowlist(account-airlock): oss-readiness-apply-reviewed
const DEFAULT_ALERT_BUS_URL = 'http://127.0.0.1:18799/hooks/wake';
const DEFAULT_ALERT_NAME = 'Adversarial Watcher Health';
const DEFAULT_ALERT_AGENT_ID = 'main';
const DEFAULT_ALERT_CHANNEL = 'telegram';
const DEFAULT_HTTP_TIMEOUT_MS = 5_000;
const DEFAULT_RETRY_DELAY_MS = 5_000;
const DEFAULT_MAX_RETRY_DELAY_MS = 60_000;
const DEFAULT_STALE_INFLIGHT_AGE_MS = 120_000;
const DEFAULT_MAX_DELIVERY_ATTEMPTS = 8;
const HTTP_TIMEOUT_MS = Number(
  process.env.ALERT_HTTP_TIMEOUT_MS || process.env.HTTP_TIMEOUT_MS || DEFAULT_HTTP_TIMEOUT_MS
);
const TEL_COMMS_TELEMETRY_URL = new URL(
  '../../../modules/agent-gateway/lib/tel-comms-telemetry.mjs',
  import.meta.url
);

let telTelemetryPromise;
let activeDrainPromise = null;
let scheduledDrainTimer = null;

function firstNonEmpty(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
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

function legacyAgentHooksUrlToWake(url) {
  const trimmed = typeof url === 'string' ? url.trim() : '';
  if (!trimmed) return null;
  return trimmed.replace(/\/hooks\/agent\/?$/u, '/hooks/wake');
}

function parseYamlStringValue(raw) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return null;
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function readAlertBusUrlFromConfig(env = process.env, fsImpl = { readFileSync }) {
  const topPath = env.AGENT_OS_CONFIG_PATH || DEFAULT_TOP_LEVEL_PATH;
  let raw = null;
  try {
    raw = fsImpl.readFileSync(topPath, 'utf8');
  } catch {
    return null;
  }
  const lines = String(raw).split(/\r?\n/u);
  let inAgentGateway = false;
  for (const line of lines) {
    if (!inAgentGateway) {
      if (/^\s*agent_gateway:\s*(?:#.*)?$/u.test(line)) {
        inAgentGateway = true;
      }
      continue;
    }
    if (/^\s*(?:#.*)?$/u.test(line)) continue;
    if (/^\S/u.test(line)) break;
    const keyMatch = line.match(/^\s+alert_bus_url:\s*([^\n#]+?)\s*$/u);
    if (keyMatch?.[1]) return parseYamlStringValue(keyMatch[1]);
  }
  return null;
}

function resolveAlertBusUrl(env, {
  loadConfigRuntimeImpl = null,
  fsImpl = { readFileSync },
} = {}) {
  const envUrl = firstNonEmpty(
    env.AGENT_OS_GBI_ALERT_BUS_URL,
    env.AGENT_OS_AGENT_GATEWAY_ALERT_BUS_URL,
    env.AGENT_GATEWAY_ALERT_BUS_URL,
    legacyAgentHooksUrlToWake(env.AGENT_GATEWAY_AGENT_HOOKS_URL),
    legacyAgentHooksUrlToWake(env.OPENCLAW_AGENT_HOOKS_URL)
  );
  if (envUrl) return envUrl;
  if (typeof loadConfigRuntimeImpl === 'function') {
    try {
      const cfg = loadConfigRuntimeImpl({ env });
      return cfg.get('agent_gateway.alert_bus_url', DEFAULT_ALERT_BUS_URL);
    } catch {
      return DEFAULT_ALERT_BUS_URL;
    }
  }
  return readAlertBusUrlFromConfig(env, fsImpl) || DEFAULT_ALERT_BUS_URL;
}

function alertSinkRoot(rootDir = ROOT) {
  const normalized = String(rootDir || '');
  return normalized.endsWith('/data/alert-delivery')
    ? normalized
    : join(normalized, 'data', 'alert-delivery');
}

function pendingDir(rootDir = ROOT) {
  return join(alertSinkRoot(rootDir), 'pending');
}

function inflightDir(rootDir = ROOT) {
  return join(alertSinkRoot(rootDir), 'inflight');
}

function deliveredDir(rootDir = ROOT) {
  return join(alertSinkRoot(rootDir), 'delivered');
}

function quarantineDir(rootDir = ROOT) {
  return join(alertSinkRoot(rootDir), 'quarantine');
}

function deadLetterDir(rootDir = ROOT) {
  return join(alertSinkRoot(rootDir), 'dead-letter');
}

function receiptDir(rootDir = ROOT) {
  return join(alertSinkRoot(rootDir), 'receipts');
}

function healthPath(rootDir = ROOT) {
  return join(alertSinkRoot(rootDir), 'health.json');
}

function ensureAlertSinkDirs(rootDir = ROOT) {
  mkdirSync(pendingDir(rootDir), { recursive: true });
  mkdirSync(inflightDir(rootDir), { recursive: true });
  mkdirSync(deliveredDir(rootDir), { recursive: true });
  mkdirSync(quarantineDir(rootDir), { recursive: true });
  mkdirSync(deadLetterDir(rootDir), { recursive: true });
  mkdirSync(receiptDir(rootDir), { recursive: true });
  assertAlertSinkOwner(rootDir);
}

function assertAlertSinkOwner(rootDir = ROOT, {
  statSyncImpl = statSync,
  geteuidImpl = typeof process.geteuid === 'function' ? () => process.geteuid() : null,
} = {}) {
  if (typeof geteuidImpl !== 'function') return;
  const sinkStat = statSyncImpl(alertSinkRoot(rootDir));
  const effectiveUid = geteuidImpl();
  if (Number.isInteger(sinkStat?.uid) && sinkStat.uid !== effectiveUid) {
    throw new Error(
      `Alert delivery state root is owned by uid ${sinkStat.uid}; refusing cross-user write as uid ${effectiveUid}`
    );
  }
}

function makeAlertId(now = new Date()) {
  const stamp = (now instanceof Date ? now : new Date(now)).toISOString().replace(/[:.]/gu, '-');
  return `alert-${stamp}-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
}

function alertDocPath(rootDir, state, id) {
  return join(
    state === 'pending' ? pendingDir(rootDir)
      : state === 'inflight' ? inflightDir(rootDir)
        : state === 'dead-letter' ? deadLetterDir(rootDir)
          : deliveredDir(rootDir),
    `${id}.json`
  );
}

function receiptPath(rootDir, id, phase, at, attempt = 0) {
  const base = `${String(at).replace(/[:.]/gu, '-')}-${id}-${phase}`;
  return join(receiptDir(rootDir), attempt === 0 ? `${base}.json` : `${base}-${attempt}.json`);
}

function writeReceipt(rootDir, doc, phase, at, extra = {}) {
  const stamp = typeof at === 'string' ? at : new Date(at).toISOString();
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const filePath = receiptPath(rootDir, doc.id, phase, stamp, attempt);
    try {
      writeFileAtomic(filePath, `${JSON.stringify({
        id: doc.id,
        phase,
        at: stamp,
        event: doc.event || null,
        text: doc.text,
        attemptCount: doc.attemptCount || 0,
        createdAt: doc.createdAt,
        ...extra,
      }, null, 2)}\n`, { overwrite: false });
      return filePath;
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;
    }
  }
  throw new Error(`Unable to allocate alert receipt path for ${doc.id}`);
}

function readHealth(rootDir = ROOT) {
  try {
    return JSON.parse(readFileSync(healthPath(rootDir), 'utf8'));
  } catch {
    return {
      ready: true,
      pendingCount: 0,
      lastQueuedAt: null,
      lastDeliveredAt: null,
      lastFailureAt: null,
      lastFailureReason: null,
      lastQueuedEvent: null,
      lastQuarantinedAt: null,
      lastQuarantinedFile: null,
      quarantineCount: 0,
      deadLetterCount: 0,
      lastDeadLetteredAt: null,
      lastDeadLetteredFile: null,
    };
  }
}

function writeHealth(rootDir, next) {
  writeFileAtomic(healthPath(rootDir), `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

function countDirEntries(dirPath) {
  try {
    return readdirSync(dirPath).filter((name) => name.endsWith('.json')).length;
  } catch {
    return 0;
  }
}

function setHealthQueued(rootDir, doc) {
  const prior = readHealth(rootDir);
  return writeHealth(rootDir, {
    ...prior,
    ready: false,
    pendingCount: countDirEntries(pendingDir(rootDir)),
    lastQueuedAt: doc.createdAt,
    lastQueuedEvent: doc.event || null,
  });
}

function setHealthFailed(rootDir, doc, error, failedAt) {
  const prior = readHealth(rootDir);
  return writeHealth(rootDir, {
    ...prior,
    ready: false,
    pendingCount: countDirEntries(pendingDir(rootDir)),
    lastFailureAt: failedAt,
    lastFailureReason: String(error?.message || error),
    lastQueuedEvent: doc.event || null,
  });
}

function setHealthQuarantined(rootDir, filePath, error, quarantinedAt) {
  const prior = readHealth(rootDir);
  return writeHealth(rootDir, {
    ...prior,
    ready: false,
    pendingCount: countDirEntries(pendingDir(rootDir)),
    quarantineCount: countDirEntries(quarantineDir(rootDir)),
    lastFailureAt: quarantinedAt,
    lastFailureReason: `quarantined ${basename(filePath)}: ${String(error?.message || error)}`,
    lastQuarantinedAt: quarantinedAt,
    lastQuarantinedFile: basename(filePath),
  });
}

function setHealthDeadLettered(rootDir, doc, error, deadLetteredAt) {
  const prior = readHealth(rootDir);
  return writeHealth(rootDir, {
    ...prior,
    ready: false,
    pendingCount: countDirEntries(pendingDir(rootDir)),
    deadLetterCount: countDirEntries(deadLetterDir(rootDir)),
    lastFailureAt: deadLetteredAt,
    lastFailureReason: `dead-lettered ${doc.id} after ${doc.attemptCount} attempts: ${String(error?.message || error)}`,
    lastDeadLetteredAt: deadLetteredAt,
    lastDeadLetteredFile: `${doc.id}.json`,
  });
}

function setHealthDelivered(rootDir, deliveredAt) {
  const pendingCount = countDirEntries(pendingDir(rootDir));
  const inflightCount = countDirEntries(inflightDir(rootDir));
  const quarantineCount = countDirEntries(quarantineDir(rootDir));
  const deadLetterCount = countDirEntries(deadLetterDir(rootDir));
  const ready = pendingCount === 0 && inflightCount === 0 && quarantineCount === 0
    && deadLetterCount === 0;
  const prior = readHealth(rootDir);
  return writeHealth(rootDir, {
    ...prior,
    ready,
    pendingCount,
    quarantineCount,
    deadLetterCount,
    lastDeliveredAt: deliveredAt,
    lastFailureReason: ready ? null : prior.lastFailureReason,
    lastFailureAt: ready ? null : prior.lastFailureAt,
  });
}

function resolveAlertDefaults(env = process.env, {
  fsImpl = { existsSync },
  loadConfigRuntimeImpl = null,
  rootDir = ROOT,
} = {}) {
  const defaultOwnerRoot = rootDir === ROOT
    ? join(homedir(), '.config', 'adversarial-review')
    : rootDir;
  const alertTo = firstNonEmpty(env.ALERT_TO);
  if (!alertTo) {
    throw new Error('ALERT_TO must be configured for alert delivery');
  }
  return {
    alertBusUrl: resolveAlertBusUrl(env, {
      loadConfigRuntimeImpl,
      fsImpl: { readFileSync: fsImpl.readFileSync || readFileSync },
    }),
    hooksTokenFile:
      env.OPENCLAW_HOOKS_TOKEN_FILE ||
      env.HOOKS_TOKEN_FILE ||
      resolveHooksTokenFileFromRoot(env.ADV_SECRETS_ROOT, fsImpl) ||
      resolveHooksTokenFileFromRoot(env.LITELLM_SECRETS_ROOT, fsImpl) ||
      resolveDefaultHooksTokenFile(fsImpl),
    alertChannel: env.ALERT_CHANNEL || DEFAULT_ALERT_CHANNEL,
    alertTo,
    alertAgentId: env.ALERT_AGENT_ID || DEFAULT_ALERT_AGENT_ID,
    alertName: env.ALERT_NAME || DEFAULT_ALERT_NAME,
    rootDir:
      firstNonEmpty(env.ADVERSARIAL_ALERT_DELIVERY_ROOT, env.AGENT_OS_ALERT_DELIVERY_STATE_DIR)
      || alertSinkRoot(defaultOwnerRoot),
    retryDelayMs: Math.max(
      0,
      Number(env.ADVERSARIAL_ALERT_DELIVERY_RETRY_DELAY_MS || DEFAULT_RETRY_DELAY_MS)
    ),
    maxRetryDelayMs: Math.max(
      0,
      Number(env.ADVERSARIAL_ALERT_DELIVERY_MAX_RETRY_DELAY_MS || DEFAULT_MAX_RETRY_DELAY_MS)
    ),
    maxAttempts: positiveInteger(
      env.ADVERSARIAL_ALERT_DELIVERY_MAX_ATTEMPTS,
      DEFAULT_MAX_DELIVERY_ATTEMPTS
    ),
  };
}

function readHooksToken({ env = process.env, fsImpl = { readFileSync, existsSync }, loadConfigRuntimeImpl = null } = {}) {
  const config = resolveAlertDefaults(env, {
    fsImpl: { existsSync: fsImpl.existsSync || existsSync },
    loadConfigRuntimeImpl,
  });
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

function httpRequestText(urlString, {
  method = 'GET',
  headers = {},
  body,
  timeoutMs = HTTP_TIMEOUT_MS,
} = {}) {
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

function buildQueuedAlertDoc(text, { event, payload, config, now }) {
  const createdAt = (now instanceof Date ? now : new Date(now)).toISOString();
  return {
    version: 1,
    id: makeAlertId(now),
    createdAt,
    event: event || null,
    payload: payload || null,
    text,
    attemptCount: 0,
    lastAttemptAt: null,
    nextAttemptAfter: createdAt,
    delivery: {
      alertName: config.alertName,
      alertAgentId: config.alertAgentId,
      alertChannel: config.alertChannel,
      alertTo: config.alertTo,
    },
  };
}

function queueAlertDoc(rootDir, doc) {
  ensureAlertSinkDirs(rootDir);
  const filePath = alertDocPath(rootDir, 'pending', doc.id);
  writeFileAtomic(filePath, `${JSON.stringify(doc, null, 2)}\n`, { overwrite: false });
  const receipt = writeReceipt(rootDir, doc, 'queued', doc.createdAt, { state: 'pending' });
  setHealthQueued(rootDir, doc);
  return { filePath, receipt };
}

function readAlertDoc(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function quarantineAlertFile(rootDir, filePath, error, now = new Date()) {
  ensureAlertSinkDirs(rootDir);
  const stamp = (now instanceof Date ? now : new Date(now)).toISOString().replace(/[:.]/gu, '-');
  const originalName = basename(filePath);
  let quarantinedPath = join(quarantineDir(rootDir), `${stamp}-${originalName}`);
  for (let attempt = 0; existsSync(quarantinedPath) && attempt < 1000; attempt += 1) {
    quarantinedPath = join(quarantineDir(rootDir), `${stamp}-${attempt}-${originalName}`);
  }
  renameSync(filePath, quarantinedPath);
  setHealthQuarantined(rootDir, filePath, error, (now instanceof Date ? now : new Date(now)).toISOString());
  return quarantinedPath;
}

function listPendingAlertPaths(rootDir = ROOT) {
  try {
    return readdirSync(pendingDir(rootDir))
      .filter((name) => name.endsWith('.json'))
      .sort()
      .map((name) => join(pendingDir(rootDir), name));
  } catch {
    return [];
  }
}

function listInflightAlertPaths(rootDir = ROOT) {
  try {
    return readdirSync(inflightDir(rootDir))
      .filter((name) => name.endsWith('.json'))
      .sort()
      .map((name) => join(inflightDir(rootDir), name));
  } catch {
    return [];
  }
}

function isDueForRetry(doc, nowMs) {
  const nextAttemptMs = Date.parse(doc?.nextAttemptAfter || '');
  return !Number.isFinite(nextAttemptMs) || nextAttemptMs <= nowMs;
}

function recoverStaleInflightAlerts(rootDir, {
  now = new Date(),
  staleInflightAgeMs = DEFAULT_STALE_INFLIGHT_AGE_MS,
} = {}) {
  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const results = [];
  for (const filePath of listInflightAlertPaths(rootDir)) {
    let doc;
    try {
      doc = readAlertDoc(filePath);
    } catch (error) {
      try {
        const quarantinedPath = quarantineAlertFile(rootDir, filePath, error, now);
        results.push({
          status: 'quarantined',
          filePath,
          quarantinePath: quarantinedPath,
          error: String(error?.message || error),
        });
      } catch (quarantineError) {
        results.push({
          status: 'failed',
          filePath,
          error: String(error?.message || error),
          quarantineError: String(quarantineError?.message || quarantineError),
        });
      }
      continue;
    }
    const lastAttemptMs = Date.parse(doc?.lastAttemptAt || doc?.createdAt || '');
    if (Number.isFinite(lastAttemptMs) && nowMs - lastAttemptMs < staleInflightAgeMs) continue;
    try {
      const pendingPath = alertDocPath(rootDir, 'pending', doc.id);
      writeFileAtomic(pendingPath, `${JSON.stringify({
        ...doc,
        state: 'pending',
      }, null, 2)}\n`);
      rmSync(filePath, { force: true });
      results.push({ status: 'recovered', id: doc.id, filePath, pendingPath });
    } catch (error) {
      results.push({
        status: 'failed',
        id: doc.id,
        filePath,
        error: String(error?.message || error),
      });
    }
  }
  return results;
}

function movePendingToInflight(rootDir, doc) {
  const src = alertDocPath(rootDir, 'pending', doc.id);
  const dest = alertDocPath(rootDir, 'inflight', doc.id);
  renameSync(src, dest);
  return dest;
}

function returnInflightToPending(rootDir, doc) {
  const pendingPath = alertDocPath(rootDir, 'pending', doc.id);
  writeFileAtomic(pendingPath, `${JSON.stringify(doc, null, 2)}\n`);
  rmSync(alertDocPath(rootDir, 'inflight', doc.id), { force: true });
  return pendingPath;
}

function markInflightDelivered(rootDir, doc) {
  const deliveredPath = alertDocPath(rootDir, 'delivered', doc.id);
  writeFileAtomic(deliveredPath, `${JSON.stringify(doc, null, 2)}\n`);
  rmSync(alertDocPath(rootDir, 'inflight', doc.id), { force: true });
  return deliveredPath;
}

function markInflightDeadLettered(rootDir, doc) {
  const deadLetterPath = alertDocPath(rootDir, 'dead-letter', doc.id);
  writeFileAtomic(deadLetterPath, `${JSON.stringify(doc, null, 2)}\n`);
  rmSync(alertDocPath(rootDir, 'inflight', doc.id), { force: true });
  return deadLetterPath;
}

async function postAlertDoc(doc, {
  env = process.env,
  requestText = httpRequestText,
  fsImpl = { readFileSync, existsSync },
  loadConfigRuntimeImpl = null,
} = {}) {
  const config = resolveAlertDefaults(env, {
    fsImpl: { existsSync: fsImpl.existsSync || existsSync },
    loadConfigRuntimeImpl,
  });
  const token = readHooksToken({ env, fsImpl, loadConfigRuntimeImpl });
  return requestText(config.alertBusUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: {
      text: doc.text,
      message: doc.text,
      mode: 'now',
      wakeMode: 'now',
      deliver: true,
      channel: doc.delivery.alertChannel,
      to: doc.delivery.alertTo,
      name: doc.delivery.alertName,
      agentId: doc.delivery.alertAgentId,
      event: doc.event || undefined,
      payload: doc.payload || undefined,
      severity: 'critical',
      source: 'adversarial-review',
      metadata: {
        alertId: doc.id,
        event: doc.event || null,
      },
    },
  });
}

async function drainSingleAlert(filePath, {
  env = process.env,
  now = new Date(),
  requestText = httpRequestText,
  fsImpl = { readFileSync, existsSync },
  loadConfigRuntimeImpl = null,
} = {}) {
  const rootDir = ROOT;
  const config = resolveAlertDefaults(env, {
    fsImpl: { existsSync: fsImpl.existsSync || existsSync },
    loadConfigRuntimeImpl,
    rootDir,
  });
  const alertRoot = config.rootDir;
  const hookPath = notificationHookPath(config.alertBusUrl);
  const producer = 'adversarial-review';
  const prior = readAlertDoc(filePath);
  if (!isDueForRetry(prior, now instanceof Date ? now.getTime() : new Date(now).getTime())) {
    return { status: 'skipped', reason: 'backoff-not-elapsed', id: prior.id };
  }
  const inflightPath = movePendingToInflight(alertRoot, prior);
  const attemptAt = (now instanceof Date ? now : new Date(now)).toISOString();
  const doc = {
    ...prior,
    attemptCount: Number(prior.attemptCount || 0) + 1,
    lastAttemptAt: attemptAt,
    state: 'inflight',
  };
  writeFileAtomic(inflightPath, `${JSON.stringify(doc, null, 2)}\n`);

  try {
    await postAlertDoc(doc, { env, requestText, fsImpl, loadConfigRuntimeImpl });
    const deliveredAt = (now instanceof Date ? now : new Date(now)).toISOString();
    const delivered = {
      ...doc,
      state: 'delivered',
      deliveredAt,
    };
    markInflightDelivered(alertRoot, delivered);
    writeReceipt(alertRoot, delivered, 'delivered', deliveredAt, { state: 'delivered' });
    setHealthDelivered(alertRoot, deliveredAt);
    await emitNotificationBusDeliverSpan({ hookPath, producer, outcome: 'success' });
    return { status: 'delivered', id: delivered.id, attemptCount: delivered.attemptCount };
  } catch (error) {
    if (doc.attemptCount >= config.maxAttempts) {
      const deadLetteredAt = attemptAt;
      const deadLettered = {
        ...doc,
        state: 'dead-letter',
        deadLetteredAt,
        lastError: String(error?.message || error),
      };
      markInflightDeadLettered(alertRoot, deadLettered);
      writeReceipt(alertRoot, deadLettered, 'dead-lettered', deadLetteredAt, {
        state: 'dead-letter',
        error: deadLettered.lastError,
      });
      setHealthDeadLettered(alertRoot, deadLettered, error, deadLetteredAt);
      await emitNotificationBusDeliverSpan({ hookPath, producer, outcome: 'error' });
      return {
        status: 'dead-lettered',
        id: deadLettered.id,
        attemptCount: deadLettered.attemptCount,
        error: deadLettered.lastError,
      };
    }
    const nextAttemptAfter = new Date(
      (now instanceof Date ? now.getTime() : new Date(now).getTime())
      + Math.min(
        config.maxRetryDelayMs,
        config.retryDelayMs * (2 ** Math.max(0, doc.attemptCount - 1))
      )
    ).toISOString();
    const retryDoc = {
      ...doc,
      state: 'pending',
      nextAttemptAfter,
      lastError: String(error?.message || error),
    };
    returnInflightToPending(alertRoot, retryDoc);
    writeReceipt(alertRoot, retryDoc, 'failed', attemptAt, {
      state: 'pending',
      error: retryDoc.lastError,
      nextAttemptAfter,
    });
    setHealthFailed(alertRoot, retryDoc, error, attemptAt);
    await emitNotificationBusDeliverSpan({ hookPath, producer, outcome: 'error' });
    return { status: 'queued', id: retryDoc.id, attemptCount: retryDoc.attemptCount, error: retryDoc.lastError };
  }
}

async function drainPendingAlerts({
  env = process.env,
  now = new Date(),
  requestText = httpRequestText,
  fsImpl = { readFileSync, existsSync },
  loadConfigRuntimeImpl = null,
  maxItems = Infinity,
} = {}) {
  const config = resolveAlertDefaults(env, {
    fsImpl: { existsSync: fsImpl.existsSync || existsSync },
    loadConfigRuntimeImpl,
  });
  const rootDir = config.rootDir;
  ensureAlertSinkDirs(rootDir);
  const recoveredInflight = recoverStaleInflightAlerts(rootDir, { now });
  const pending = listPendingAlertPaths(rootDir);
  const results = [...recoveredInflight];
  for (const filePath of pending.slice(0, maxItems)) {
    try {
      results.push(await drainSingleAlert(filePath, {
        env,
        now,
        requestText,
        fsImpl,
        loadConfigRuntimeImpl,
      }));
    } catch (error) {
      try {
        const quarantinedPath = quarantineAlertFile(rootDir, filePath, error, now);
        results.push({
          status: 'quarantined',
          filePath,
          quarantinePath: quarantinedPath,
          error: String(error?.message || error),
        });
      } catch (quarantineError) {
        results.push({
          status: 'failed',
          filePath,
          error: String(error?.message || error),
          quarantineError: String(quarantineError?.message || quarantineError),
        });
      }
    }
  }
  return {
    status: results.some((entry) => (
      entry.status === 'failed' || entry.status === 'dead-lettered'
    )) ? 'error'
      : results.some((entry) => entry.status === 'queued' || entry.status === 'quarantined') ? 'queued'
        : 'ok',
    drained: results.filter((entry) => entry.status === 'delivered').length,
    queued: countDirEntries(pendingDir(rootDir)),
    results,
  };
}

function scheduleAlertDrain({
  env = process.env,
  delayMs = 0,
  requestText = httpRequestText,
  fsImpl = { readFileSync, existsSync },
  loadConfigRuntimeImpl = null,
} = {}) {
  if (scheduledDrainTimer) return;
  scheduledDrainTimer = setTimeout(() => {
    scheduledDrainTimer = null;
    if (activeDrainPromise) return;
    activeDrainPromise = drainPendingAlerts({
      env,
      requestText,
      fsImpl,
      loadConfigRuntimeImpl,
    }).catch((error) => {
      console.error?.('[alert-delivery] scheduled drain failed', error);
      return { status: 'error', drained: 0, queued: 0, results: [], error: String(error?.message || error) };
    }).finally(() => {
      activeDrainPromise = null;
      let rootDir;
      let retryDelayMs = DEFAULT_RETRY_DELAY_MS;
      try {
        const config = resolveAlertDefaults(env, {
          fsImpl: { existsSync: fsImpl.existsSync || existsSync },
          loadConfigRuntimeImpl,
        });
        rootDir = config.rootDir;
        retryDelayMs = config.retryDelayMs;
      } catch (error) {
        console.error?.('[alert-delivery] scheduled drain reschedule check failed', error);
        return;
      }
      if (countDirEntries(pendingDir(rootDir)) > 0) {
        scheduleAlertDrain({
          env,
          delayMs: retryDelayMs,
          requestText,
          fsImpl,
          loadConfigRuntimeImpl,
        });
      }
    });
  }, delayMs);
  scheduledDrainTimer.unref?.();
}

function readAlertSinkHealth({ env = process.env, loadConfigRuntimeImpl = null } = {}) {
  const config = resolveAlertDefaults(env, { loadConfigRuntimeImpl });
  const rootDir = config.rootDir;
  const health = readHealth(rootDir);
  const pendingCount = countDirEntries(pendingDir(rootDir));
  const inflightCount = countDirEntries(inflightDir(rootDir));
  const quarantineCount = countDirEntries(quarantineDir(rootDir));
  const deadLetterCount = countDirEntries(deadLetterDir(rootDir));
  return {
    ...health,
    rootDir,
    ready: pendingCount === 0 && inflightCount === 0 && quarantineCount === 0
      && deadLetterCount === 0,
    pendingCount,
    inflightCount,
    deliveredCount: countDirEntries(deliveredDir(rootDir)),
    quarantineCount,
    deadLetterCount,
  };
}

async function deliverAlert(text, {
  event = null,
  payload = null,
  env = process.env,
  fsImpl = { readFileSync, existsSync },
  requestText = httpRequestText,
  now = new Date(),
  loadConfigRuntimeImpl = null,
} = {}) {
  const config = resolveAlertDefaults(env, {
    fsImpl: { existsSync: fsImpl.existsSync || existsSync },
    loadConfigRuntimeImpl,
  });
  const rootDir = config.rootDir;
  const doc = buildQueuedAlertDoc(text, { event, payload, config, now });
  const queued = queueAlertDoc(rootDir, doc);
  scheduleAlertDrain({ env, requestText, fsImpl, loadConfigRuntimeImpl });
  return {
    status: 'queued',
    queued: true,
    id: doc.id,
    queuePath: queued.filePath,
    receiptPath: queued.receipt,
  };
}

export {
  DEFAULT_ALERT_BUS_URL,
  assertAlertSinkOwner,
  alertSinkRoot,
  deliverAlert,
  drainPendingAlerts,
  firstNonEmpty,
  healthPath,
  httpRequestText,
  pendingDir,
  readAlertSinkHealth,
  readHooksToken,
  resolveAlertDefaults,
  scheduleAlertDrain,
};
