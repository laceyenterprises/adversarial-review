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
import { basename, dirname, join, normalize } from 'node:path';
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn as spawnChild } from 'node:child_process';

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
const DEFAULT_ARCHIVE_RETENTION_DAYS = 30;
const DEFAULT_ARCHIVE_SWEEP_INTERVAL_MS = 60 * 60 * 1000;
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
let scheduledDrainAtMs = null;
const archiveSweepAtByRoot = new Map();

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

function finiteNonNegativeNumber(value, fallback) {
  if (value === null || value === undefined || String(value).trim() === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
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
  const normalizedRoot = normalize(String(rootDir || ''));
  const withoutTrailingSeparators = normalizedRoot.length > 1
    ? normalizedRoot.replace(/[\\/]+$/gu, '')
    : normalizedRoot;
  return withoutTrailingSeparators.endsWith('/data/alert-delivery')
    ? withoutTrailingSeparators
    : join(withoutTrailingSeparators, 'data', 'alert-delivery');
}

function resolveAlertSinkStateRoot(env = process.env, rootDir = ROOT) {
  const defaultOwnerRoot = rootDir === ROOT
    ? join(homedir(), '.config', 'adversarial-review')
    : rootDir;
  return firstNonEmpty(
    env.ADVERSARIAL_ALERT_DELIVERY_ROOT,
    env.AGENT_OS_ALERT_DELIVERY_STATE_DIR
  ) || alertSinkRoot(defaultOwnerRoot);
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

function ensureAlertSinkDirs(rootDir = ROOT, {
  existsSyncImpl = existsSync,
  mkdirSyncImpl = mkdirSync,
  statSyncImpl = statSync,
  geteuidImpl = typeof process.geteuid === 'function' ? () => process.geteuid() : null,
} = {}) {
  const sinkRoot = alertSinkRoot(rootDir);
  const ownerOptions = { existsSyncImpl, statSyncImpl, geteuidImpl };
  assertAlertSinkOwner(rootDir, ownerOptions);
  mkdirSyncImpl(sinkRoot, { recursive: true });
  assertAlertSinkOwner(rootDir, ownerOptions);
  for (const child of ['pending', 'inflight', 'delivered', 'quarantine', 'dead-letter', 'receipts']) {
    const childPath = join(sinkRoot, child);
    mkdirSyncImpl(childPath, { recursive: true });
    assertOwnedAlertDirectory(childPath, ownerOptions);
  }
}

function assertOwnedAlertDirectory(directoryPath, {
  statSyncImpl = statSync,
  geteuidImpl = typeof process.geteuid === 'function' ? () => process.geteuid() : null,
} = {}) {
  const directoryStat = statSyncImpl(directoryPath);
  if (typeof directoryStat?.isDirectory === 'function' && !directoryStat.isDirectory()) {
    throw new Error(`Alert delivery path ${directoryPath} is not a directory`);
  }
  if (typeof geteuidImpl !== 'function') return;
  const effectiveUid = geteuidImpl();
  if (Number.isInteger(directoryStat?.uid) && directoryStat.uid !== effectiveUid) {
    throw new Error(
      `Alert delivery directory ${directoryPath} is owned by uid ${directoryStat.uid}; `
      + `refusing cross-user access as uid ${effectiveUid}`
    );
  }
}

function assertAlertSinkOwner(rootDir = ROOT, {
  existsSyncImpl = existsSync,
  statSyncImpl = statSync,
  geteuidImpl = typeof process.geteuid === 'function' ? () => process.geteuid() : null,
} = {}) {
  if (typeof geteuidImpl !== 'function') return;
  let ownerBoundary = alertSinkRoot(rootDir);
  while (!existsSyncImpl(ownerBoundary)) {
    const parent = dirname(ownerBoundary);
    if (parent === ownerBoundary) break;
    ownerBoundary = parent;
  }
  const sinkStat = statSyncImpl(ownerBoundary);
  if (typeof sinkStat?.isDirectory === 'function' && !sinkStat.isDirectory()) {
    throw new Error(`Alert delivery owner boundary ${ownerBoundary} is not a directory`);
  }
  const effectiveUid = geteuidImpl();
  if (Number.isInteger(sinkStat?.uid) && sinkStat.uid !== effectiveUid) {
    throw new Error(
      `Alert delivery owner boundary ${ownerBoundary} is owned by uid ${sinkStat.uid}; `
      + `refusing cross-user write as uid ${effectiveUid}`
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

function countDirEntries(dirPath, { readdirSyncImpl = readdirSync } = {}) {
  try {
    return readdirSyncImpl(dirPath).filter((name) => name.endsWith('.json')).length;
  } catch (error) {
    if (error?.code === 'ENOENT') return 0;
    throw error;
  }
}

function sweepAlertArchiveRetention(rootDir, {
  now = new Date(),
  retentionDays = DEFAULT_ARCHIVE_RETENTION_DAYS,
  statSyncImpl = statSync,
  rmSyncImpl = rmSync,
} = {}) {
  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const cutoffMs = nowMs - (positiveInteger(retentionDays, DEFAULT_ARCHIVE_RETENTION_DAYS)
    * 24 * 60 * 60 * 1000);
  let removed = 0;
  for (const directory of [deliveredDir(rootDir), receiptDir(rootDir)]) {
    let names;
    try {
      names = readdirSync(directory).filter((name) => name.endsWith('.json'));
    } catch {
      continue;
    }
    for (const name of names) {
      const filePath = join(directory, name);
      try {
        if (statSyncImpl(filePath).mtimeMs >= cutoffMs) continue;
        rmSyncImpl(filePath, { force: true });
        removed += 1;
      } catch {
        // Retention is best effort. Delivery and queue health remain authoritative.
      }
    }
  }
  return removed;
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

function resolveAlertTransportDefaults(env = process.env, {
  fsImpl = { existsSync },
  loadConfigRuntimeImpl = null,
  rootDir = ROOT,
} = {}) {
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
    rootDir: resolveAlertSinkStateRoot(env, rootDir),
    retryDelayMs: finiteNonNegativeNumber(
      env.ADVERSARIAL_ALERT_DELIVERY_RETRY_DELAY_MS,
      DEFAULT_RETRY_DELAY_MS
    ),
    maxRetryDelayMs: finiteNonNegativeNumber(
      env.ADVERSARIAL_ALERT_DELIVERY_MAX_RETRY_DELAY_MS,
      DEFAULT_MAX_RETRY_DELAY_MS
    ),
    maxAttempts: positiveInteger(
      env.ADVERSARIAL_ALERT_DELIVERY_MAX_ATTEMPTS,
      DEFAULT_MAX_DELIVERY_ATTEMPTS
    ),
    archiveRetentionDays: positiveInteger(
      env.ADVERSARIAL_ALERT_DELIVERY_ARCHIVE_RETENTION_DAYS,
      DEFAULT_ARCHIVE_RETENTION_DAYS
    ),
  };
}

function resolveAlertDefaults(env = process.env, options = {}) {
  const alertTo = firstNonEmpty(env.ALERT_TO);
  if (!alertTo) {
    throw new Error('ALERT_TO must be configured for alert delivery');
  }
  return {
    ...resolveAlertTransportDefaults(env, options),
    alertChannel: env.ALERT_CHANNEL || DEFAULT_ALERT_CHANNEL,
    alertTo,
    alertAgentId: env.ALERT_AGENT_ID || DEFAULT_ALERT_AGENT_ID,
    alertName: env.ALERT_NAME || DEFAULT_ALERT_NAME,
  };
}

function readHooksToken({ env = process.env, fsImpl = { readFileSync, existsSync }, loadConfigRuntimeImpl = null } = {}) {
  const config = resolveAlertTransportDefaults(env, {
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

function validateAlertDocIdentity(filePath, doc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new Error(`Alert document ${basename(filePath)} must be a JSON object`);
  }
  const id = typeof doc.id === 'string' ? doc.id.trim() : '';
  if (doc.id !== id || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/u.test(id)) {
    throw new Error(`Alert document ${basename(filePath)} has an unsafe id`);
  }
  const expectedName = `${id}.json`;
  if (basename(filePath) !== expectedName) {
    throw new Error(
      `Alert document id ${id} does not match queue filename ${basename(filePath)}`
    );
  }
  return doc;
}

function validateQueuedAlertDelivery(filePath, doc) {
  const delivery = doc?.delivery;
  for (const field of ['alertTo', 'alertChannel', 'alertName', 'alertAgentId']) {
    if (typeof delivery?.[field] !== 'string' || !delivery[field].trim()) {
      throw new Error(`Alert document ${basename(filePath)} is missing delivery.${field}`);
    }
  }
  return doc;
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
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

function listInflightAlertPaths(rootDir = ROOT) {
  try {
    return readdirSync(inflightDir(rootDir))
      .filter((name) => name.endsWith('.json'))
      .sort()
      .map((name) => join(inflightDir(rootDir), name));
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
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
      doc = validateAlertDocIdentity(filePath, readAlertDoc(filePath));
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
      const terminalState = existsSync(alertDocPath(rootDir, 'delivered', doc.id))
        ? 'delivered'
        : existsSync(alertDocPath(rootDir, 'dead-letter', doc.id)) ? 'dead-letter' : null;
      if (terminalState) {
        rmSync(filePath, { force: true });
        results.push({
          status: 'terminal-cleaned',
          state: terminalState,
          id: doc.id,
          filePath,
        });
        continue;
      }
      if (doc.state === 'delivered' || doc.state === 'dead-letter') {
        const terminalPath = alertDocPath(rootDir, doc.state, doc.id);
        renameSync(filePath, terminalPath);
        results.push({
          status: 'terminal-finalized',
          state: doc.state,
          id: doc.id,
          filePath,
          terminalPath,
        });
        continue;
      }
      const pendingPath = alertDocPath(rootDir, 'pending', doc.id);
      if (existsSync(pendingPath)) {
        rmSync(filePath, { force: true });
        results.push({ status: 'pending-duplicate-cleaned', id: doc.id, filePath, pendingPath });
        continue;
      }
      writeFileAtomic(filePath, `${JSON.stringify({
        ...doc,
        state: 'pending',
      }, null, 2)}\n`);
      renameSync(filePath, pendingPath);
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

function movePendingToInflight(rootDir, filePath, doc) {
  const dest = alertDocPath(rootDir, 'inflight', doc.id);
  renameSync(filePath, dest);
  return dest;
}

function returnInflightToPending(rootDir, doc) {
  const inflightPath = alertDocPath(rootDir, 'inflight', doc.id);
  const pendingPath = alertDocPath(rootDir, 'pending', doc.id);
  writeFileAtomic(inflightPath, `${JSON.stringify(doc, null, 2)}\n`);
  renameSync(inflightPath, pendingPath);
  return pendingPath;
}

function markInflightDelivered(rootDir, doc) {
  const inflightPath = alertDocPath(rootDir, 'inflight', doc.id);
  const deliveredPath = alertDocPath(rootDir, 'delivered', doc.id);
  writeFileAtomic(inflightPath, `${JSON.stringify(doc, null, 2)}\n`);
  renameSync(inflightPath, deliveredPath);
  return deliveredPath;
}

function markInflightDeadLettered(rootDir, doc) {
  const inflightPath = alertDocPath(rootDir, 'inflight', doc.id);
  const deadLetterPath = alertDocPath(rootDir, 'dead-letter', doc.id);
  writeFileAtomic(inflightPath, `${JSON.stringify(doc, null, 2)}\n`);
  renameSync(inflightPath, deadLetterPath);
  return deadLetterPath;
}

// The canonical superproject alert-delivery script (scripts/alert-delivery.mjs)
// delivers via the CURRENT alerts bus — `sink: telegram-direct` in config.yaml,
// straight to the Telegram Bot API — the same path sentinel and the rest of the OS
// use. The watcher historically POSTed to the legacy agent-gateway bus
// (:18799/hooks/wake), whose rotated bridge token now returns HTTP 401, silently
// dead-lettering every operator page. Routing through the canonical script puts the
// watcher back on the live bus while keeping this module's durable queue / retry /
// dead-letter / health telemetry.
const CANONICAL_ALERT_SCRIPT_TIMEOUT_MS = 35_000;

// Resolve the canonical superproject script, or null when absent. Uses the REAL
// filesystem (not the injectable fsImpl, which controls token/config reads) because
// availability is a deployment-layout fact: present when the submodule is checked
// out under the superproject, absent in a standalone/CI clone (where the legacy bus
// fallback keeps this module self-contained). `AGENT_OS_ALERT_DELIVERY_SCRIPT`
// overrides the path (tests point it at a stub).
function resolveCanonicalAlertScript(env = process.env) {
  const override = env.AGENT_OS_ALERT_DELIVERY_SCRIPT;
  if (override) {
    return existsSync(override) ? override : null;
  }
  // src/alert-delivery.mjs -> src -> adversarial-review -> tools -> <superproject root>
  const candidate = fileURLToPath(new URL('../../../scripts/alert-delivery.mjs', import.meta.url));
  return existsSync(candidate) ? candidate : null;
}

// Spawn `node <canonical script> --stdin-json`, feed the alert payload, and resolve
// with the exit code + captured output. Never rejects — a spawn error maps to a
// non-zero code so the caller's retry/dead-letter contract handles it uniformly.
function spawnCanonicalAlertScript(scriptPath, payload, env = process.env) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnChild(process.execPath, [scriptPath, '--stdin-json'], {
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolve({ code: 1, stdout: '', stderr: String(error?.message || error) });
      return;
    }
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdin.on('error', () => {});
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // already exited
      }
      finish({
        code: 1,
        stdout,
        stderr: `${stderr}\ncanonical alert-delivery timed out after ${CANONICAL_ALERT_SCRIPT_TIMEOUT_MS}ms`.trim(),
      });
    }, CANONICAL_ALERT_SCRIPT_TIMEOUT_MS);
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      finish({ code: 1, stdout, stderr: stderr || String(error?.message || error) });
    });
    child.on('close', (code) => {
      finish({ code: code == null ? 1 : code, stdout, stderr });
    });
    try {
      child.stdin.write(`${JSON.stringify(payload)}\n`);
      child.stdin.end();
    } catch {
      // the 'error'/'close' handler resolves the promise
    }
  });
}

async function deliverViaCanonicalAlertScript(scriptPath, doc, {
  env = process.env,
  runAlertScript = spawnCanonicalAlertScript,
} = {}) {
  const payload = {
    source: doc.event || 'adversarial-review',
    message: doc.text,
    idempotencyKey: doc.id,
    metadata: {
      alertId: doc.id,
      event: doc.event || null,
      source: 'adversarial-review',
    },
  };
  const result = await runAlertScript(scriptPath, payload, env);
  // Exit 0 = handled: the canonical script delivered OR intentionally suppressed
  // (rate-limit / dedup) — either way the alert is done, so clear it from the queue.
  // A non-zero exit is a real failure; throw so drainSingleAlert retries / dead-letters.
  if (!result || result.code !== 0) {
    const detail = String((result && (result.stderr || result.stdout)) || '').trim();
    throw new Error(
      `canonical alert-delivery exited ${result ? result.code : 'null'}${detail ? `: ${detail}` : ''}`
    );
  }
  return { status: 'delivered', via: 'canonical-alert-script' };
}

async function postAlertDoc(doc, {
  env = process.env,
  requestText = httpRequestText,
  fsImpl = { readFileSync, existsSync },
  loadConfigRuntimeImpl = null,
  runAlertScript = spawnCanonicalAlertScript,
} = {}) {
  // Prefer the canonical superproject script (current telegram-direct bus). Fall
  // back to the legacy agent-gateway bus POST only when it is absent — a standalone
  // submodule / CI checkout with no superproject parent.
  const canonicalScript = resolveCanonicalAlertScript(env);
  if (canonicalScript) {
    return deliverViaCanonicalAlertScript(canonicalScript, doc, { env, runAlertScript });
  }
  const config = resolveAlertTransportDefaults(env, {
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
  const config = resolveAlertTransportDefaults(env, {
    fsImpl: { existsSync: fsImpl.existsSync || existsSync },
    loadConfigRuntimeImpl,
    rootDir,
  });
  const alertRoot = config.rootDir;
  const hookPath = notificationHookPath(config.alertBusUrl);
  const producer = 'adversarial-review';
  const prior = validateQueuedAlertDelivery(
    filePath,
    validateAlertDocIdentity(filePath, readAlertDoc(filePath))
  );
  if (!isDueForRetry(prior, now instanceof Date ? now.getTime() : new Date(now).getTime())) {
    return {
      status: 'skipped',
      reason: 'backoff-not-elapsed',
      id: prior.id,
      nextAttemptAfter: prior.nextAttemptAfter,
    };
  }
  const inflightPath = movePendingToInflight(alertRoot, filePath, prior);
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
    return {
      status: 'queued',
      id: retryDoc.id,
      attemptCount: retryDoc.attemptCount,
      error: retryDoc.lastError,
      nextAttemptAfter,
    };
  }
}

async function drainPendingAlerts({
  env = process.env,
  now = new Date(),
  requestText = httpRequestText,
  fsImpl = { readFileSync, existsSync },
  loadConfigRuntimeImpl = null,
  maxItems = Infinity,
  archiveSweepIntervalMs = DEFAULT_ARCHIVE_SWEEP_INTERVAL_MS,
} = {}) {
  const config = resolveAlertTransportDefaults(env, {
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
  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const priorArchiveSweepAtMs = archiveSweepAtByRoot.get(rootDir);
  const normalizedArchiveSweepIntervalMs = finiteNonNegativeNumber(
    archiveSweepIntervalMs,
    DEFAULT_ARCHIVE_SWEEP_INTERVAL_MS
  );
  const archiveRetentionSwept = !Number.isFinite(priorArchiveSweepAtMs)
    || nowMs - priorArchiveSweepAtMs >= normalizedArchiveSweepIntervalMs;
  let archiveRetentionRemoved = 0;
  if (archiveRetentionSwept) {
    archiveRetentionRemoved = sweepAlertArchiveRetention(rootDir, {
      now,
      retentionDays: config.archiveRetentionDays,
    });
    archiveSweepAtByRoot.set(rootDir, nowMs);
  }
  const nextAttemptAtMs = results.reduce((nearest, entry) => {
    const candidate = Date.parse(entry?.nextAttemptAfter || '');
    return Number.isFinite(candidate) && (nearest === null || candidate < nearest)
      ? candidate
      : nearest;
  }, null);
  return {
    status: results.some((entry) => (
      entry.status === 'failed' || entry.status === 'dead-lettered'
    )) ? 'error'
      : results.some((entry) => entry.status === 'queued' || entry.status === 'quarantined') ? 'queued'
        : 'ok',
    drained: results.filter((entry) => entry.status === 'delivered').length,
    queued: countDirEntries(pendingDir(rootDir)),
    nextAttemptAtMs,
    archiveRetentionRemoved,
    archiveRetentionSwept,
    results,
  };
}

function nextAlertDrainDelayMs(drainResult, retryDelayMs, nowMs = Date.now()) {
  const baseDelayMs = finiteNonNegativeNumber(retryDelayMs, DEFAULT_RETRY_DELAY_MS);
  const nextAttemptAtMs = Number(drainResult?.nextAttemptAtMs);
  if (!Number.isFinite(nextAttemptAtMs)) return baseDelayMs;
  return Math.max(baseDelayMs, nextAttemptAtMs - nowMs);
}

function scheduleAlertDrain({
  env = process.env,
  delayMs = 0,
  requestText = httpRequestText,
  fsImpl = { readFileSync, existsSync },
  loadConfigRuntimeImpl = null,
} = {}) {
  const normalizedDelayMs = finiteNonNegativeNumber(delayMs, 0);
  const fireAtMs = Date.now() + normalizedDelayMs;
  if (scheduledDrainTimer) {
    if (scheduledDrainAtMs !== null && scheduledDrainAtMs <= fireAtMs) return;
    clearTimeout(scheduledDrainTimer);
    scheduledDrainTimer = null;
    scheduledDrainAtMs = null;
  }
  scheduledDrainAtMs = fireAtMs;
  scheduledDrainTimer = setTimeout(() => {
    scheduledDrainTimer = null;
    scheduledDrainAtMs = null;
    if (activeDrainPromise) return;
    activeDrainPromise = drainPendingAlerts({
      env,
      requestText,
      fsImpl,
      loadConfigRuntimeImpl,
    });
    let completedDrain = null;
    activeDrainPromise = activeDrainPromise.catch((error) => {
      console.error?.('[alert-delivery] scheduled drain failed', error);
      return { status: 'error', drained: 0, queued: 0, results: [], error: String(error?.message || error) };
    }).then((result) => {
      completedDrain = result;
      return result;
    }).finally(() => {
      activeDrainPromise = null;
      try {
        const config = resolveAlertTransportDefaults(env, {
          fsImpl: { existsSync: fsImpl.existsSync || existsSync },
          loadConfigRuntimeImpl,
        });
        const pendingCount = countDirEntries(pendingDir(config.rootDir), {
          readdirSyncImpl: fsImpl.readdirSync || readdirSync,
        });
        if (pendingCount > 0) {
          scheduleAlertDrain({
            env,
            delayMs: nextAlertDrainDelayMs(completedDrain, config.retryDelayMs),
            requestText,
            fsImpl,
            loadConfigRuntimeImpl,
          });
        }
      } catch (error) {
        console.error?.('[alert-delivery] scheduled drain reschedule check failed', error);
      }
    }).catch((error) => {
      console.error?.('[alert-delivery] scheduled drain completion failed', error);
      return { status: 'error', drained: 0, queued: 0, results: [], error: String(error?.message || error) };
    });
  }, normalizedDelayMs);
  scheduledDrainTimer.unref?.();
}

function readAlertSinkHealth({
  env = process.env,
  loadConfigRuntimeImpl = null,
  fsImpl = { existsSync, readFileSync, readdirSync, statSync },
  geteuidImpl = typeof process.geteuid === 'function' ? () => process.geteuid() : null,
} = {}) {
  void loadConfigRuntimeImpl;
  const rootDir = resolveAlertSinkStateRoot(env);
  const health = readHealth(rootDir);
  try {
    const ownerOptions = {
      existsSyncImpl: fsImpl.existsSync || existsSync,
      statSyncImpl: fsImpl.statSync || statSync,
      geteuidImpl,
    };
    assertAlertSinkOwner(rootDir, ownerOptions);
    const counts = {};
    for (const [field, directoryPath] of [
      ['pendingCount', pendingDir(rootDir)],
      ['inflightCount', inflightDir(rootDir)],
      ['quarantineCount', quarantineDir(rootDir)],
      ['deadLetterCount', deadLetterDir(rootDir)],
    ]) {
      if ((fsImpl.existsSync || existsSync)(directoryPath)) {
        assertOwnedAlertDirectory(directoryPath, ownerOptions);
      }
      counts[field] = countDirEntries(directoryPath, {
        readdirSyncImpl: fsImpl.readdirSync || readdirSync,
      });
    }
    return {
      ...health,
      rootDir,
      ready: Object.values(counts).every((count) => count === 0),
      ...counts,
      healthCheckError: null,
    };
  } catch (error) {
    return {
      ...health,
      rootDir,
      ready: false,
      pendingCount: null,
      inflightCount: null,
      quarantineCount: null,
      deadLetterCount: null,
      healthCheckError: String(error?.message || error),
      lastFailureReason: `alert sink health check failed: ${String(error?.message || error)}`,
    };
  }
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
  ensureAlertSinkDirs,
  firstNonEmpty,
  healthPath,
  httpRequestText,
  nextAlertDrainDelayMs,
  pendingDir,
  readAlertSinkHealth,
  readHooksToken,
  resolveAlertDefaults,
  resolveAlertTransportDefaults,
  scheduleAlertDrain,
  sweepAlertArchiveRetention,
};
