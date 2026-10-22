import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { withGitHubBudgetScope } from '../src/rate-limit-throttle.mjs';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  FIXED_RECOVERY_EVENTS,
  queueAlertDoc,
  validateAlertDocIdentity,
  assertAlertSinkOwner,
  alertPresentationForDoc,
  alertSinkRoot,
  deliverAlert,
  drainPendingAlerts,
  ensureAlertSinkDirs,
  nextAlertDrainDelayMs,
  pendingDir,
  readAlertSinkHealth,
  resolveAlertDefaults,
  sanitizeAlertIdPrefix,
  sweepAlertArchiveRetention,
} from '../src/alert-delivery.mjs';

test('fleet-stop page uses the orphan recovery id sanitizer for its event', () => {
  const event = sanitizeAlertIdPrefix('fleet.stop.unreadable');
  assert.equal(event, 'fleet-stop-unreadable');
  const presentation = alertPresentationForDoc({
    event,
    text: 'fleet-stop-unreadable: cannot read halt directory (EACCES); autonomous merges remain on hold.',
    payload: { pathClass: 'halt directory', errorCode: 'EACCES' },
  });
  assert.equal(presentation.severity, 'SEV1');
  assert.match(presentation.headline, /Fleet-stop state unreadable/u);
  assert.match(presentation.detail, /halt directory.*EACCES/u);
});

function makeEnv(overrides = {}) {
  const rootDir = mkdtempSync(join(tmpdir(), 'alert-delivery-'));
  const env = {
    ALERT_TO: '123456',
    ALERT_AGENT_ID: 'ops',
    ALERT_NAME: 'Adversarial Watcher Health Test',
    ALERT_CHANNEL: 'telegram',
    AGENT_OS_GBI_ALERT_BUS_URL: 'http://127.0.0.1:18799/hooks/wake',
    // Unit tests exercise the legacy transport unless a test deliberately
    // supplies a canonical-script stub below.
    AGENT_OS_ALERT_DELIVERY_SCRIPT: '',
    OPENCLAW_HOOKS_TOKEN_FILE: '/secrets/hooks.token',
    ADVERSARIAL_ALERT_DELIVERY_ROOT: rootDir,
    ...overrides,
  };
  return { env, rootDir };
}

function sinkPath(rootDir, ...parts) {
  return join(rootDir, 'data', 'alert-delivery', ...parts);
}

test('only an actual stalled first-pass queue is an immediate page', () => {
  const page = alertPresentationForDoc({
    event: 'adversarial_review.reviewer_stalled',
    payload: { age_ms: 24 * 60_000, pending_review_count: 1 },
  });
  const digest = alertPresentationForDoc({
    event: 'merge_agent.stuck_pre_spawn',
    text: 'merge work has not started',
  });

  assert.equal(page.severity, 'SEV1');
  assert.equal(page.headline, 'Reviews stalled — restore reviewer dispatch');
  assert.match(page.action, /\/v1\/dispatch/);
  assert.equal(digest.severity, 'SEV2');
  assert.equal(digest.headline, 'Merge dispatch delayed — inspect queue');
});

test('watcher alert defaults require an explicit recipient', () => {
  assert.throws(
    () => resolveAlertDefaults({}),
    /ALERT_TO must be configured for alert delivery/
  );
});

test('alert sink health remains observable without an ALERT_TO recipient', () => {
  const { env, rootDir } = makeEnv();
  delete env.ALERT_TO;
  const pendingRoot = pendingDir(rootDir);
  mkdirSync(pendingRoot, { recursive: true });
  writeFileSync(join(pendingRoot, 'owed.json'), '{}\n');

  const health = readAlertSinkHealth({ env });

  assert.equal(health.ready, false);
  assert.equal(health.pendingCount, 1);
  rmSync(rootDir, { recursive: true, force: true });
});

test('watcher alert defaults use the configured alert bus and token discovery chain', () => {
  const tokenFile = join(homedir(), '.config', 'adversarial-review', 'secrets', 'litellm-alert-bridge.token');
  const cfg = resolveAlertDefaults(
    { ALERT_TO: '123456' },
    { fsImpl: { existsSync: (filePath) => filePath === tokenFile } }
  );
  assert.equal(cfg.alertBusUrl, 'http://127.0.0.1:18799/hooks/wake');
  assert.equal(cfg.hooksTokenFile, tokenFile);
  assert.equal(cfg.alertChannel, 'telegram');
  assert.equal(cfg.alertTo, '123456');
});

test('config parser keeps the agent gateway block open across top-level comments', () => {
  const cfg = resolveAlertDefaults(
    { ALERT_TO: '123456', AGENT_OS_CONFIG_PATH: '/config.yaml' },
    {
      fsImpl: {
        existsSync() {
          return false;
        },
        readFileSync() {
          return [
            'agent_gateway:',
            '# operator note between the section and key',
            '  alert_bus_url: https://cfg.example.test/hooks/wake',
          ].join('\n');
        },
      },
    }
  );

  assert.equal(cfg.alertBusUrl, 'https://cfg.example.test/hooks/wake');
});

test('alert sink refuses a root owned by another effective uid', () => {
  assert.throws(
    () => assertAlertSinkOwner('/state', {
      statSyncImpl() {
        return { uid: 502 };
      },
      geteuidImpl() {
        return 501;
      },
    }),
    /refusing cross-user write/
  );
});

test('alert sink validates the nearest existing owner boundary before creating children', () => {
  const mkdirCalls = [];
  assert.throws(
    () => ensureAlertSinkDirs('/state', {
      existsSyncImpl(filePath) {
        return filePath === '/state';
      },
      statSyncImpl() {
        return { uid: 502 };
      },
      geteuidImpl() {
        return 501;
      },
      mkdirSyncImpl(...args) {
        mkdirCalls.push(args);
      },
    }),
    /owner boundary \/state.*refusing cross-user write/
  );
  assert.deepEqual(mkdirCalls, []);
});

test('alert sink validates every existing lane after creation', () => {
  assert.throws(
    () => ensureAlertSinkDirs('/state', {
      existsSyncImpl() {
        return true;
      },
      statSyncImpl(filePath) {
        return {
          uid: filePath.endsWith('/pending') ? 502 : 501,
          isDirectory: () => true,
        };
      },
      geteuidImpl() {
        return 501;
      },
      mkdirSyncImpl() {},
    }),
    /directory \/state\/data\/alert-delivery\/pending is owned by uid 502/
  );
});

test('alert sink root normalizes a final sink path with a trailing separator', () => {
  const finalRoot = '/state/data/alert-delivery';
  assert.equal(alertSinkRoot(`${finalRoot}/`), finalRoot);
  assert.equal(alertSinkRoot('/state'), finalRoot);
});

test('agent_gateway alert bus URL precedence honors config then canonical and legacy env aliases', () => {
  const configOnly = resolveAlertDefaults(
    { ALERT_TO: '123456' },
    {
      loadConfigRuntimeImpl() {
        return { get: () => 'https://cfg.example.test/hooks/wake' };
      },
    }
  );
  assert.equal(configOnly.alertBusUrl, 'https://cfg.example.test/hooks/wake');

  const canonicalEnv = resolveAlertDefaults(
    {
      ALERT_TO: '123456',
      AGENT_OS_GBI_ALERT_BUS_URL: 'https://canonical.example.test/hooks/wake',
    },
    {
      loadConfigRuntimeImpl() {
        return { get: () => 'https://cfg.example.test/hooks/wake' };
      },
    }
  );
  assert.equal(canonicalEnv.alertBusUrl, 'https://canonical.example.test/hooks/wake');

  const legacyEnv = resolveAlertDefaults(
    {
      ALERT_TO: '123456',
      AGENT_GATEWAY_ALERT_BUS_URL: 'https://legacy.example.test/hooks/wake',
    },
    {
      loadConfigRuntimeImpl() {
        return { get: () => 'https://cfg.example.test/hooks/wake' };
      },
    }
  );
  assert.equal(legacyEnv.alertBusUrl, 'https://legacy.example.test/hooks/wake');
});

test('unavailable bus queues a durable receipt instead of losing the alert', async (t) => {
  const { env, rootDir } = makeEnv();
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));

  const queued = await deliverAlert('watcher.no_progress text', {
    event: 'watcher.no_progress',
    payload: { openPendingPRs: 2 },
    env,
    fsImpl: {
      readFileSync() {
        return 'hook-token';
      },
      existsSync() {
        return true;
      },
    },
    requestText: async () => {
      throw new Error('ECONNREFUSED');
    },
  });

  assert.equal(queued.status, 'queued');
  assert.equal(queued.queued, true);
  assert.equal(readAlertSinkHealth({ env }).pendingCount, 1);

  await drainPendingAlerts({
    env,
    fsImpl: {
      readFileSync() {
        return 'hook-token';
      },
      existsSync() {
        return true;
      },
    },
    requestText: async () => {
      throw new Error('ECONNREFUSED');
    },
  });

  const health = readAlertSinkHealth({ env });
  assert.equal(health.ready, false);
  assert.equal(health.pendingCount, 1);
  assert.match(String(health.lastFailureReason), /ECONNREFUSED/);

  const queueEntries = pendingDir(rootDir);
  const queuedDoc = JSON.parse(readFileSync(join(queueEntries, `${queued.id}.json`), 'utf8'));
  assert.equal(queuedDoc.event, 'watcher.no_progress');
  assert.equal(queuedDoc.attemptCount, 1);
});

test('recovered bus drains the queued receipt exactly once', async (t) => {
  const { env, rootDir } = makeEnv();
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));

  const queued = await deliverAlert('hammer cap text', {
    event: 'hammer_lifetime_ceiling_reached',
    payload: { cap: 3 },
    env,
    fsImpl: {
      readFileSync() {
        return 'hook-token';
      },
      existsSync() {
        return true;
      },
    },
    requestText: async () => {
      throw new Error('ECONNREFUSED');
    },
  });

  await drainPendingAlerts({
    env,
    fsImpl: {
      readFileSync() {
        return 'hook-token';
      },
      existsSync() {
        return true;
      },
    },
    requestText: async () => {
      throw new Error('ECONNREFUSED');
    },
  });

  const calls = [];
  const drained = await drainPendingAlerts({
    env,
    now: new Date(Date.now() + 6_000),
    fsImpl: {
      readFileSync() {
        return 'hook-token';
      },
      existsSync() {
        return true;
      },
    },
    requestText: async (url, options) => {
      calls.push({ url, options });
      return 'ok';
    },
  });

  assert.equal(drained.drained, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://127.0.0.1:18799/hooks/wake');
  assert.deepEqual(calls[0].options.body, {
    text: 'Review pipeline notice — inspect digest\nhammer cap text',
    message: 'Review pipeline notice — inspect digest\nhammer cap text',
    mode: 'digest',
    wakeMode: 'digest',
    deliver: true,
    channel: 'telegram',
    to: '123456',
    name: 'Adversarial Watcher Health Test',
    agentId: 'ops',
    event: 'hammer_lifetime_ceiling_reached',
    payload: { cap: 3 },
    severity: 'warning',
    source: 'adversarial-review',
    metadata: {
      alertId: queued.id,
      event: 'hammer_lifetime_ceiling_reached',
      deliveryClass: 'digest',
    },
  });
  assert.equal(readAlertSinkHealth({ env }).ready, true);
  assert.equal(readAlertSinkHealth({ env }).pendingCount, 0);

  const secondDrain = await drainPendingAlerts({
    env,
    now: new Date(Date.now() + 12_000),
    fsImpl: {
      readFileSync() {
        return 'hook-token';
      },
      existsSync() {
        return true;
      },
    },
    requestText: async () => {
      calls.push('unexpected-second-send');
      return 'ok';
    },
  });
  assert.equal(secondDrain.drained, 0);
  assert.deepEqual(calls, [calls[0]]);
});

test('permanent delivery failure dead-letters on its first attempt', async (t) => {
  const { env, rootDir } = makeEnv({
    ADVERSARIAL_ALERT_DELIVERY_MAX_ATTEMPTS: '2',
    ADVERSARIAL_ALERT_DELIVERY_RETRY_DELAY_MS: '0',
  });
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));

  await deliverAlert('permanent failure', {
    env,
    fsImpl: {
      readFileSync() {
        return 'hook-token';
      },
      existsSync() {
        return true;
      },
    },
    requestText: async () => {
      throw new Error('HTTP 401');
    },
  });

  const drainOptions = {
    env,
    fsImpl: {
      readFileSync() {
        return 'hook-token';
      },
      existsSync() {
        return true;
      },
    },
    requestText: async () => {
      throw new Error('HTTP 401');
    },
  };
  const first = await drainPendingAlerts(drainOptions);
  const second = await drainPendingAlerts(drainOptions);

  assert.equal(first.status, 'error');
  assert.equal(first.results[0].status, 'dead-lettered');
  assert.equal(second.results.length, 0);
  assert.equal(readdirSync(sinkPath(rootDir, 'dead-letter')).length, 1);
  const health = readAlertSinkHealth({ env });
  assert.equal(health.ready, false);
  assert.equal(health.pendingCount, 0);
  assert.equal(health.deadLetterCount, 1);
  assert.match(health.lastFailureReason, /dead-lettered.*1 attempts.*HTTP 401/);
});

// A stub standing in for the canonical superproject scripts/alert-delivery.mjs:
// it captures the stdin payload to STUB_OUT and exits with STUB_EXIT, so the test
// exercises the REAL spawn path (via AGENT_OS_ALERT_DELIVERY_SCRIPT) without a
// network send or a superproject checkout.
const CANONICAL_ALERT_STUB = [
  "import { writeFileSync } from 'node:fs';",
  "let input = '';",
  "process.stdin.setEncoding('utf8');",
  "process.stdin.on('data', (chunk) => { input += chunk; });",
  "process.stdin.on('end', () => {",
  "  if (process.env.STUB_OUT) writeFileSync(process.env.STUB_OUT, input);",
  "  process.exit(Number(process.env.STUB_EXIT || '0'));",
  "});",
].join('\n');

test('watcher alerts route through the canonical script (current telegram-direct bus)', async (t) => {
  const { env, rootDir } = makeEnv({ ADVERSARIAL_ALERT_DELIVERY_RETRY_DELAY_MS: '0' });
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const scriptPath = join(rootDir, 'stub-alert-delivery.mjs');
  const capturePath = join(rootDir, 'canonical-payload.json');
  writeFileSync(scriptPath, CANONICAL_ALERT_STUB);
  env.AGENT_OS_ALERT_DELIVERY_SCRIPT = scriptPath;
  env.STUB_OUT = capturePath;
  env.STUB_EXIT = '0';

  // The legacy bus POST must NOT be used when the canonical script is present.
  const requestText = async () => {
    throw new Error('legacy bus must not be used when the canonical script is present');
  };

  const queued = await deliverAlert('watcher.no_progress body', {
    env,
    event: 'watcher.no_progress',
    payload: { polls: 12 },
    requestText,
  });
  const drained = await drainPendingAlerts({ env, requestText });

  assert.equal(drained.drained, 1);
  const health = readAlertSinkHealth({ env });
  assert.equal(health.ready, true);
  assert.equal(health.deadLetterCount, 0);
  // The canonical script received the alert on stdin in the contract shape.
  const sent = JSON.parse(readFileSync(capturePath, 'utf8'));
  assert.equal(sent.message, 'Review dispatch delayed — monitor queue\nwatcher.no_progress body');
  assert.equal(sent.metadata.deliveryClass, 'digest');
  assert.equal(sent.metadata.presentation.severity, 'SEV2');
  assert.equal(sent.metadata.presentation.headline, 'Review dispatch delayed — monitor queue');
  assert.equal(sent.source, 'watcher.no_progress');
  assert.equal(sent.idempotencyKey, queued.id);
  assert.equal(sent.metadata.alertId, queued.id);
  assert.equal(sent.metadata.event, 'watcher.no_progress');
});

test('a failing canonical alert script dead-letters through the durable queue', async (t) => {
  const { env, rootDir } = makeEnv({
    ADVERSARIAL_ALERT_DELIVERY_MAX_ATTEMPTS: '2',
    ADVERSARIAL_ALERT_DELIVERY_RETRY_DELAY_MS: '0',
  });
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const scriptPath = join(rootDir, 'stub-alert-delivery.mjs');
  writeFileSync(scriptPath, CANONICAL_ALERT_STUB);
  env.AGENT_OS_ALERT_DELIVERY_SCRIPT = scriptPath;
  env.STUB_EXIT = '3'; // non-zero -> the canonical send failed

  const requestText = async () => {
    throw new Error('legacy bus must not be used when the canonical script is present');
  };
  await deliverAlert('canonical failure', { env, requestText });
  const first = await drainPendingAlerts({ env, requestText });
  const second = await drainPendingAlerts({ env, requestText });

  assert.equal(first.status, 'queued');
  assert.equal(second.status, 'error');
  assert.equal(second.results[0].status, 'dead-lettered');
  const health = readAlertSinkHealth({ env });
  assert.equal(health.deadLetterCount, 1);
  assert.match(health.lastFailureReason, /canonical alert-delivery exited 3/);
});

test('canonical alert script output capture is bounded', async (t) => {
  const { env, rootDir } = makeEnv({
    ADVERSARIAL_ALERT_DELIVERY_MAX_ATTEMPTS: '1',
    ADVERSARIAL_ALERT_DELIVERY_RETRY_DELAY_MS: '0',
  });
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const scriptPath = join(rootDir, 'stub-alert-delivery.mjs');
  writeFileSync(scriptPath, [
    "process.stderr.write('x'.repeat(120_000));",
    'process.exit(4);',
  ].join('\n'));
  env.AGENT_OS_ALERT_DELIVERY_SCRIPT = scriptPath;

  const requestText = async () => {
    throw new Error('legacy bus must not be used when the canonical script is present');
  };
  await deliverAlert('noisy canonical failure', { env, requestText });
  await drainPendingAlerts({ env, requestText });

  const health = readAlertSinkHealth({ env });
  assert.equal(health.deadLetterCount, 1);
  assert.match(health.lastFailureReason, /canonical alert-delivery exited 4/);
  assert.ok(health.lastFailureReason.length < 101_000);
});

test('canonical alert script stdin pipe errors stay local to delivery failure', async (t) => {
  const { env, rootDir } = makeEnv({
    ADVERSARIAL_ALERT_DELIVERY_MAX_ATTEMPTS: '1',
    ADVERSARIAL_ALERT_DELIVERY_RETRY_DELAY_MS: '0',
  });
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const scriptPath = join(rootDir, 'stub-alert-delivery.mjs');
  writeFileSync(scriptPath, "process.exit(7);\n");
  env.AGENT_OS_ALERT_DELIVERY_SCRIPT = scriptPath;

  const requestText = async () => {
    throw new Error('legacy bus must not be used when the canonical script is present');
  };
  await deliverAlert('x'.repeat(1024 * 1024), { env, requestText });
  const drained = await drainPendingAlerts({ env, requestText });

  assert.equal(drained.status, 'error');
  assert.equal(drained.results[0].status, 'dead-lettered');
  const health = readAlertSinkHealth({ env });
  assert.equal(health.deadLetterCount, 1);
  assert.match(health.lastFailureReason, /canonical alert-delivery exited 7/);
});

test('empty canonical alert script override disables real filesystem discovery', async (t) => {
  const { env, rootDir } = makeEnv({
    AGENT_OS_ALERT_DELIVERY_SCRIPT: '',
    ADVERSARIAL_ALERT_DELIVERY_RETRY_DELAY_MS: '0',
  });
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));

  const calls = [];
  await deliverAlert('isolated legacy bus', {
    env,
    fsImpl: {
      readFileSync() {
        return 'hook-token';
      },
      existsSync() {
        return true;
      },
    },
    requestText: async () => {
      throw new Error('initial queue attempt should stay retryable');
    },
  });
  const drained = await drainPendingAlerts({
    env,
    now: new Date(Date.now() + 6_000),
    fsImpl: {
      readFileSync() {
        return 'hook-token';
      },
      existsSync() {
        return true;
      },
    },
    requestText: async (url, options) => {
      calls.push({ url, options });
      return 'ok';
    },
  });

  assert.equal(drained.drained, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://127.0.0.1:18799/hooks/wake');
  assert.equal(
    calls[0].options.body.text,
    'Review pipeline notice — inspect digest\nisolated legacy bus'
  );
  assert.equal(readAlertSinkHealth({ env }).ready, true);
});

test('invalid retry delay configuration falls back without wedging an inflight alert', async (t) => {
  const { env, rootDir } = makeEnv({
    ADVERSARIAL_ALERT_DELIVERY_RETRY_DELAY_MS: 'not-a-number',
    ADVERSARIAL_ALERT_DELIVERY_MAX_RETRY_DELAY_MS: 'also-invalid',
  });
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const pendingRoot = pendingDir(rootDir);
  mkdirSync(pendingRoot, { recursive: true });
  const doc = {
    version: 1,
    id: 'invalid-delay-recoverable',
    createdAt: '2026-08-02T05:00:00.000Z',
    text: 'must remain retryable',
    attemptCount: 0,
    nextAttemptAfter: '2026-08-02T05:00:00.000Z',
    delivery: {
      alertName: 'Adversarial Watcher Health Test',
      alertAgentId: 'ops',
      alertChannel: 'telegram',
      alertTo: '123456',
    },
  };
  writeFileSync(join(pendingRoot, `${doc.id}.json`), `${JSON.stringify(doc)}\n`);

  const drained = await drainPendingAlerts({
    env,
    now: new Date('2026-08-02T05:01:00.000Z'),
    fsImpl: {
      readFileSync() { return 'hook-token'; },
      existsSync() { return true; },
    },
    requestText: async () => { throw new Error('temporary bus outage'); },
  });

  assert.equal(drained.status, 'queued');
  assert.equal(drained.results[0].status, 'queued');
  assert.equal(readdirSync(sinkPath(rootDir, 'inflight')).length, 0);
  assert.deepEqual(readdirSync(pendingRoot), [`${doc.id}.json`]);
  const retryDoc = JSON.parse(readFileSync(join(pendingRoot, `${doc.id}.json`), 'utf8'));
  assert.equal(retryDoc.nextAttemptAfter, '2026-08-02T05:01:05.000Z');
  assert.equal(drained.nextAttemptAtMs, Date.parse(retryDoc.nextAttemptAfter));
  assert.equal(
    nextAlertDrainDelayMs(drained, 5_000, Date.parse('2026-08-02T05:01:00.000Z')),
    5_000
  );
});

test('malformed pending alert is quarantined and later alerts still drain', async (t) => {
  const { env, rootDir } = makeEnv();
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));

  const pendingRoot = pendingDir(rootDir);
  mkdirSync(pendingRoot, { recursive: true });
  writeFileSync(join(pendingRoot, '000-bad.json'), '{not json\n');
  writeFileSync(join(pendingRoot, '001-good.json'), `${JSON.stringify({
    version: 1,
    id: '001-good',
    createdAt: '2026-08-02T05:00:00.000Z',
    event: 'watcher.no_progress',
    payload: { openPendingPRs: 1 },
    text: 'valid alert',
    attemptCount: 0,
    lastAttemptAt: null,
    nextAttemptAfter: '2026-08-02T05:00:00.000Z',
    delivery: {
      alertName: 'Adversarial Watcher Health Test',
      alertAgentId: 'ops',
      alertChannel: 'telegram',
      alertTo: '123456',
    },
  }, null, 2)}\n`);

  const calls = [];
  const drained = await drainPendingAlerts({
    env,
    now: new Date('2026-08-02T05:01:00.000Z'),
    fsImpl: {
      readFileSync() {
        return 'hook-token';
      },
      existsSync() {
        return true;
      },
    },
    requestText: async (url, options) => {
      calls.push({ url, options });
      return 'ok';
    },
  });

  assert.equal(drained.status, 'queued');
  assert.equal(drained.drained, 1);
  assert.equal(drained.results.some((entry) => entry.status === 'quarantined'), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.body.metadata.alertId, '001-good');

  const quarantineEntries = readdirSync(sinkPath(rootDir, 'quarantine'));
  assert.equal(quarantineEntries.length, 1);
  assert.match(quarantineEntries[0], /000-bad\.json$/);

  const health = readAlertSinkHealth({ env });
  assert.equal(health.ready, false);
  assert.equal(health.pendingCount, 0);
  assert.equal(health.quarantineCount, 1);
  assert.match(health.lastFailureReason, /quarantined 000-bad\.json/);
});

test('queued recipient survives current ALERT_TO removal and still drains', async (t) => {
  const { env, rootDir } = makeEnv();
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const pendingRoot = pendingDir(rootDir);
  mkdirSync(pendingRoot, { recursive: true });
  const doc = {
    version: 1,
    id: 'persisted-recipient',
    createdAt: '2026-08-02T05:00:00.000Z',
    text: 'owed alert',
    attemptCount: 0,
    nextAttemptAfter: '2026-08-02T05:00:00.000Z',
    delivery: {
      alertName: 'Persisted name',
      alertAgentId: 'ops',
      alertChannel: 'telegram',
      alertTo: 'persisted-recipient-id',
    },
  };
  writeFileSync(join(pendingRoot, `${doc.id}.json`), `${JSON.stringify(doc)}\n`);
  delete env.ALERT_TO;

  const calls = [];
  const drained = await drainPendingAlerts({
    env,
    now: new Date('2026-08-02T05:01:00.000Z'),
    fsImpl: {
      readFileSync() { return 'hook-token'; },
      existsSync() { return true; },
    },
    requestText: async (_url, options) => { calls.push(options.body); return 'ok'; },
  });

  assert.equal(drained.drained, 1);
  assert.equal(calls[0].to, 'persisted-recipient-id');
});

test('mismatched and traversal-like ids quarantine only their own queue files', async (t) => {
  const { env, rootDir } = makeEnv();
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const pendingRoot = pendingDir(rootDir);
  mkdirSync(pendingRoot, { recursive: true });
  const delivery = {
    alertName: 'Adversarial Watcher Health Test',
    alertAgentId: 'ops',
    alertChannel: 'telegram',
    alertTo: '123456',
  };
  const docs = [
    ['000-mismatch.json', { id: '001-good', text: 'must quarantine', delivery }],
    ['002-traversal.json', { id: '../outside', text: 'must quarantine', delivery }],
    ['003-whitespace.json', { id: '003-whitespace ', text: 'must quarantine', delivery }],
    ['001-good.json', { id: '001-good', text: 'must deliver', delivery }],
  ];
  for (const [name, doc] of docs) {
    writeFileSync(join(pendingRoot, name), `${JSON.stringify({
      version: 1,
      createdAt: '2026-08-02T05:00:00.000Z',
      attemptCount: 0,
      nextAttemptAfter: '2026-08-02T05:00:00.000Z',
      ...doc,
    })}\n`);
  }
  const calls = [];
  const drained = await drainPendingAlerts({
    env,
    now: new Date('2026-08-02T05:01:00.000Z'),
    fsImpl: {
      readFileSync() { return 'hook-token'; },
      existsSync() { return true; },
    },
    requestText: async (_url, options) => { calls.push(options.body.metadata.alertId); return 'ok'; },
  });

  assert.deepEqual(calls, ['001-good']);
  assert.equal(drained.results.filter((entry) => entry.status === 'quarantined').length, 3);
  assert.deepEqual(readdirSync(sinkPath(rootDir, 'delivered')), ['001-good.json']);
  assert.equal(readdirSync(sinkPath(rootDir, 'quarantine')).length, 3);
  assert.equal(existsSync(join(rootDir, 'outside.json')), false);
});

test('malformed inflight alert is quarantined during stale recovery', async (t) => {
  const { env, rootDir } = makeEnv();
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));

  const inflightRoot = sinkPath(rootDir, 'inflight');
  const pendingRoot = pendingDir(rootDir);
  mkdirSync(inflightRoot, { recursive: true });
  mkdirSync(pendingRoot, { recursive: true });
  writeFileSync(join(inflightRoot, 'bad-inflight.json'), '{not json\n');

  const drained = await drainPendingAlerts({
    env,
    now: new Date('2026-08-02T05:01:00.000Z'),
    fsImpl: {
      readFileSync() {
        return 'hook-token';
      },
      existsSync() {
        return true;
      },
    },
    requestText: async () => {
      throw new Error('unexpected send');
    },
  });

  assert.equal(drained.status, 'queued');
  assert.equal(drained.drained, 0);
  assert.equal(drained.results.length, 1);
  assert.equal(drained.results[0].status, 'quarantined');
  assert.equal(readdirSync(sinkPath(rootDir, 'quarantine')).length, 1);
  assert.equal(readAlertSinkHealth({ env }).quarantineCount, 1);
});

test('stale inflight recovery does not resurrect an alert with a delivered archive', async (t) => {
  const { env, rootDir } = makeEnv();
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const doc = {
    id: 'already-delivered',
    state: 'inflight',
    createdAt: '2026-08-02T04:00:00.000Z',
    lastAttemptAt: '2026-08-02T04:00:00.000Z',
  };
  mkdirSync(sinkPath(rootDir, 'inflight'), { recursive: true });
  mkdirSync(sinkPath(rootDir, 'delivered'), { recursive: true });
  writeFileSync(sinkPath(rootDir, 'inflight', `${doc.id}.json`), `${JSON.stringify(doc)}\n`);
  writeFileSync(
    sinkPath(rootDir, 'delivered', `${doc.id}.json`),
    `${JSON.stringify({ ...doc, state: 'delivered' })}\n`
  );

  const drained = await drainPendingAlerts({
    env,
    now: new Date('2026-08-02T05:00:00.000Z'),
    requestText: async () => {
      throw new Error('terminal alert must not be sent again');
    },
  });

  assert.equal(drained.results[0].status, 'terminal-cleaned');
  assert.equal(drained.results[0].state, 'delivered');
  assert.deepEqual(readdirSync(sinkPath(rootDir, 'inflight')), []);
  assert.deepEqual(readdirSync(sinkPath(rootDir, 'pending')), []);
  assert.deepEqual(readdirSync(sinkPath(rootDir, 'delivered')), [`${doc.id}.json`]);
});

test('stale inflight recovery finalizes a terminal state after a pre-rename crash', async (t) => {
  const { env, rootDir } = makeEnv();
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const doc = {
    id: 'dead-letter-before-rename',
    state: 'dead-letter',
    createdAt: '2026-08-02T04:00:00.000Z',
    lastAttemptAt: '2026-08-02T04:00:00.000Z',
  };
  mkdirSync(sinkPath(rootDir, 'inflight'), { recursive: true });
  writeFileSync(sinkPath(rootDir, 'inflight', `${doc.id}.json`), `${JSON.stringify(doc)}\n`);

  const drained = await drainPendingAlerts({
    env,
    now: new Date('2026-08-02T05:00:00.000Z'),
    requestText: async () => {
      throw new Error('terminal alert must not be sent again');
    },
  });

  assert.equal(drained.results[0].status, 'terminal-finalized');
  assert.equal(drained.results[0].state, 'dead-letter');
  assert.deepEqual(readdirSync(sinkPath(rootDir, 'inflight')), []);
  assert.deepEqual(readdirSync(sinkPath(rootDir, 'pending')), []);
  assert.deepEqual(readdirSync(sinkPath(rootDir, 'dead-letter')), [`${doc.id}.json`]);
});

test('health readiness is derived from live pending and quarantine counts', async (t) => {
  const { env, rootDir } = makeEnv();
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));

  const pendingRoot = pendingDir(rootDir);
  mkdirSync(pendingRoot, { recursive: true });
  writeFileSync(join(pendingRoot, 'stuck.json'), '{}\n');

  const health = readAlertSinkHealth({ env });
  assert.equal(health.ready, false);
  assert.equal(health.pendingCount, 1);
});

test('health fails closed on a wrong-owner sink instead of reporting zero', (t) => {
  const { env, rootDir } = makeEnv();
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  mkdirSync(pendingDir(rootDir), { recursive: true });

  const health = readAlertSinkHealth({
    env,
    geteuidImpl: () => 501,
    fsImpl: {
      existsSync,
      readdirSync,
      statSync(filePath) {
        const real = statSync(filePath);
        return { ...real, uid: 502, isDirectory: () => real.isDirectory() };
      },
    },
  });

  assert.equal(health.ready, false);
  assert.equal(health.pendingCount, null);
  assert.match(health.healthCheckError, /owned by uid 502/);
});

test('health fails closed when a live lane is unreadable', (t) => {
  const { env, rootDir } = makeEnv();
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const pendingRoot = pendingDir(rootDir);
  mkdirSync(pendingRoot, { recursive: true });

  const health = readAlertSinkHealth({
    env,
    fsImpl: {
      existsSync,
      statSync,
      readdirSync(filePath) {
        if (filePath === pendingRoot) {
          throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
        }
        return readdirSync(filePath);
      },
    },
  });

  assert.equal(health.ready, false);
  assert.equal(health.pendingCount, null);
  assert.match(health.healthCheckError, /permission denied/);
});

test('archive retention removes old delivered documents and receipts only', (t) => {
  const { rootDir } = makeEnv();
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const deliveredRoot = sinkPath(rootDir, 'delivered');
  const receiptsRoot = sinkPath(rootDir, 'receipts');
  mkdirSync(deliveredRoot, { recursive: true });
  mkdirSync(receiptsRoot, { recursive: true });
  const oldDelivered = join(deliveredRoot, 'old.json');
  const oldReceipt = join(receiptsRoot, 'old.json');
  const freshReceipt = join(receiptsRoot, 'fresh.json');
  for (const filePath of [oldDelivered, oldReceipt, freshReceipt]) {
    writeFileSync(filePath, '{}\n');
  }
  const oldAt = new Date('2026-06-01T00:00:00.000Z');
  utimesSync(oldDelivered, oldAt, oldAt);
  utimesSync(oldReceipt, oldAt, oldAt);

  const removed = sweepAlertArchiveRetention(rootDir, {
    now: new Date('2026-08-02T00:00:00.000Z'),
    retentionDays: 30,
  });

  assert.equal(removed, 2);
  assert.deepEqual(readdirSync(deliveredRoot), []);
  assert.deepEqual(readdirSync(receiptsRoot), ['fresh.json']);
});

test('queue drains throttle archive retention sweeps to an hourly cadence', async (t) => {
  const { env, rootDir } = makeEnv();
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const deliveredRoot = sinkPath(rootDir, 'delivered');
  mkdirSync(deliveredRoot, { recursive: true });
  const firstOld = join(deliveredRoot, 'first-old.json');
  writeFileSync(firstOld, '{}\n');
  const oldAt = new Date('2026-06-01T00:00:00.000Z');
  utimesSync(firstOld, oldAt, oldAt);

  const first = await drainPendingAlerts({
    env,
    now: new Date('2026-08-02T00:00:00.000Z'),
  });
  assert.equal(first.archiveRetentionSwept, true);
  assert.equal(first.archiveRetentionRemoved, 1);

  const secondOld = join(deliveredRoot, 'second-old.json');
  writeFileSync(secondOld, '{}\n');
  utimesSync(secondOld, oldAt, oldAt);
  const second = await drainPendingAlerts({
    env,
    now: new Date('2026-08-02T00:00:05.000Z'),
  });
  assert.equal(second.archiveRetentionSwept, false);
  assert.equal(second.archiveRetentionRemoved, 0);
  assert.deepEqual(readdirSync(deliveredRoot), ['second-old.json']);

  const third = await drainPendingAlerts({
    env,
    now: new Date('2026-08-02T01:00:00.000Z'),
  });
  assert.equal(third.archiveRetentionSwept, true);
  assert.equal(third.archiveRetentionRemoved, 1);
});

test('retry scheduling honors the nearest pending exponential backoff', () => {
  const nowMs = Date.parse('2026-08-02T00:00:00.000Z');
  assert.equal(
    nextAlertDrainDelayMs({ nextAttemptAtMs: nowMs + 15 * 60_000 }, 5_000, nowMs),
    15 * 60_000
  );
});

test('health-probe and hammer-cap callers both resolve through the shared alert sink module', async () => {
  const healthProbeSource = readFileSync(new URL('../src/health-probe.mjs', import.meta.url), 'utf8');
  const hammerSource = readFileSync(new URL('../src/ama/dispatch-closer.mjs', import.meta.url), 'utf8');

  assert.match(healthProbeSource, /import \{ deliverAlert as defaultDeliverAlert \} from '\.\/alert-delivery\.mjs';/);
  assert.match(hammerSource, /import \{ deliverAlert \} from '\.\.\/alert-delivery\.mjs';/);
  assert.match(
    readFileSync(new URL('../src/watcher.mjs', import.meta.url), 'utf8'),
    /scheduleAlertDrain\(\);/
  );
});

test('AMA recovery exhaustion is a SEV1 page with structured recovery evidence', () => {
  const page = alertPresentationForDoc({ event: 'ama.automated_recovery.exhausted',
    text: 'Automation cannot recover', payload: { repo: 'fixture/repo', pr: 42, head: 'abc', attempts: 3, reason: 'unknown-findings' } });
  assert.equal(page.severity, 'SEV1');
  assert.match(page.detail, /fixture\/repo#42.*abc.*3.*unknown-findings/);
});

test('AMA recovery page outbox identity deduplicates retries before and after delivery', async (t) => {
  const { env, rootDir } = makeEnv();
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const options = { env, event: 'ama.automated_recovery.exhausted',
    payload: { repo: 'fixture/repo', pr: 42, head: 'abc', reason: 'not-eligible', attempts: 3 },
    requestText: async () => ({ statusCode: 200, body: '{}' }) };
  const first = await deliverAlert('Recovery exhausted', options);
  const second = await deliverAlert('Recovery exhausted', options);
  assert.equal(first.id, second.id);
  assert.equal(second.queued, false);
  assert.equal(readdirSync(pendingDir(rootDir)).filter((name) => name.endsWith('.json')).length, 1);
  const deliveredPath = sinkPath(rootDir, 'delivered', `${first.id}.json`);
  renameSync(first.queuePath, deliveredPath);
  const afterDelivery = await deliverAlert('Recovery exhausted', options);
  assert.equal(afterDelivery.status, 'delivered');
  assert.equal(afterDelivery.queued, false);
  assert.equal(readdirSync(pendingDir(rootDir)).filter((name) => name.endsWith('.json')).length, 0);
  const differentReason = { ...options, payload: { ...options.payload, reason: 'hammer-refused' } };
  const later = await deliverAlert('Different recovery exhausted', differentReason);
  assert.equal(later.queued, true);
  assert.notEqual(later.id, first.id);
  assert.equal((await deliverAlert('Different recovery exhausted', differentReason)).queued, false);
});

for (const state of ['pending', 'inflight', 'delivered', 'dead-letter']) {
  test(`AMA recovery reason identities honor legacy ${state} receipts without suppressing a new reason`, async t => {
    const { env, rootDir } = makeEnv();
    t.after(() => rmSync(rootDir, { recursive: true, force: true }));
    const options = { env, event: 'ama.automated_recovery.exhausted',
      payload: { repo: 'fixture/repo', pr: 42, head: 'abc', reason: 'background-pr-mergeable-unknown' },
      requestText: async () => ({ statusCode: 200, body: '{}' }) };
    const initial = await deliverAlert('UNKNOWN exhausted', options);
    const legacyId = `ama-recovery-${createHash('sha256').update('fixture/repo#42@abc').digest('hex')}`;
    const doc = JSON.parse(readFileSync(initial.queuePath, 'utf8'));
    doc.id = legacyId;
    const legacyPath = sinkPath(rootDir, state, `${legacyId}.json`);
    renameSync(initial.queuePath, legacyPath);
    writeFileSync(legacyPath, JSON.stringify(doc));
    const retry = await deliverAlert('UNKNOWN exhausted', options);
    assert.equal(retry.queued, false);
    assert.equal(retry.id, legacyId);
    assert.equal(retry.status, state);
    const later = await deliverAlert('Hammer exhausted', {
      ...options, payload: { ...options.payload, reason: 'hammer-refused' },
    });
    assert.equal(later.queued, true);
    assert.notEqual(later.id, legacyId);
  });
}

test('HAM exhaustion pages reuse deterministic identities after uncertain enqueue', async (t) => {
  const { env, rootDir } = makeEnv();
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  for (const event of ['ama_finding_dispute_exhausted', 'ama_primary_change_refusal_exhausted', 'ama.orphan_recovery.exhausted', 'ama.orphan_recovery.ownership-uncertain', 'ama.orphan_recovery.store-error']) {
    const options = { env, event, payload: { repo: 'fixture/repo', prNumber: 1, headSha: 'a'.repeat(40) },
      requestText: async () => ({ statusCode: 200, body: '{}' }) };
    const first = await deliverAlert('SEV1: exhausted', options);
    const second = await deliverAlert('SEV1: exhausted again', options);
    assert.equal(first.id, second.id);
    assert.equal(second.queued, false);
    if (event.startsWith('ama.orphan_recovery.')) {
      const otherHead = await deliverAlert('SEV1: new head', { ...options, payload: { ...options.payload, headSha: 'b'.repeat(40) } });
      assert.notEqual(first.id, otherHead.id);
      const deliveredPath = sinkPath(rootDir, 'delivered', `${first.id}.json`);
      renameSync(first.queuePath, deliveredPath);
      assert.equal((await deliverAlert('SEV1: retry after crash', options)).queued, false);
    }
  }
});

test('REVIEWLINE-01: decision page outbox identity survives a lost watcher debounce', async (t) => {
  const { env, rootDir } = makeEnv();
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const options = {
    event: 'adversarial_review.operator_decision_required',
    payload: { decisionId: 'review-failure-head-a', decisionSeriesId: 'series-a' }, env,
    fsImpl: { readFileSync: () => 'hook-token', existsSync: () => true },
    requestText: async () => { throw new Error('ECONNREFUSED'); },
  };
  const first = await deliverAlert('Review failed', options);
  const second = await deliverAlert('Review failed', options);
  assert.equal(first.id, second.id);
  assert.equal(second.queued, false);
  const nextHead = await deliverAlert('Review failed', {
    ...options, payload: { decisionId: 'review-failure-head-b', decisionSeriesId: 'series-a' },
  });
  assert.notEqual(first.id, nextHead.id);
  const nextSeries = await deliverAlert('Review failed again', {
    ...options, payload: { ...options.payload, decisionSeriesId: 'series-b' },
  });
  assert.notEqual(first.id, nextSeries.id);
});

test('corrupt legacy receipt suppresses duplicate recovery page', async t => {
  const { env, rootDir } = makeEnv();
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const options = { env, event: 'ama.automated_recovery.exhausted', payload: { repo: 'fixture/repo', pr: 42, head: 'abc', reason: 'unknown' }, requestText: async () => ({ statusCode: 200, body: '{}' }) };
  const initial = await deliverAlert('exhausted', options);
  const legacyId = `ama-recovery-${createHash('sha256').update('fixture/repo#42@abc').digest('hex')}`;
  const legacyPath = sinkPath(rootDir, 'delivered', `${legacyId}.json`);
  renameSync(initial.queuePath, legacyPath);
  writeFileSync(legacyPath, '{broken');
  const retry = await deliverAlert('exhausted', options);
  assert.equal(retry.queued, false);
  assert.equal(retry.id, legacyId);
});

test('REVIEWMODEL-02: model refusal alerts deduplicate across PRs by model and UTC day', async (t) => {
  const { env, rootDir } = makeEnv();
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const options = {
    event: 'reviewer.model_unavailable', env,
    now: new Date('2026-10-12T01:00:00Z'),
    requestText: async () => { throw new Error('synthetic offline transport'); },
    fsImpl: { readFileSync: () => 'synthetic-token', existsSync: () => true },
  };
  const payload = { refusedModel: 'Synthetic model', availableModels: ['Offered model'] };
  const first = await deliverAlert('synthetic refusal', { ...options, payload: { ...payload, prNumber: 1 } });
  const second = await deliverAlert('synthetic refusal', { ...options, payload: { ...payload, prNumber: 2 } });
  assert.equal(first.id, second.id);
  assert.equal(first.queued, true);
  assert.equal(second.queued, false);
  const nextDay = await deliverAlert('synthetic refusal', { ...options, payload, now: new Date('2026-10-13T01:00:00Z') });
  const otherModel = await deliverAlert('synthetic refusal', { ...options, payload: { ...payload, refusedModel: 'Other synthetic model' } });
  assert.notEqual(nextDay.id, first.id);
  assert.notEqual(otherModel.id, first.id);
});

test('REVIEWMODEL-02: refusal receipt checks use their injected filesystem', async (t) => {
  const { env, rootDir } = makeEnv();
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const inspected = [];
  const result = await deliverAlert('synthetic refusal', {
    event: 'reviewer.model_unavailable', env,
    payload: { refusedModel: 'Synthetic model', availableModels: [] },
    now: new Date('2026-10-12T01:00:00Z'),
    receiptFsImpl: { existsSync: path => { inspected.push(path); return path.includes('/delivered/'); } },
  });
  assert.equal(result.queued, false);
  assert.equal(result.status, 'delivered');
  assert.equal(inspected.length, 3);
  assert.equal(inspected[2], result.queuePath);
  assert.equal(existsSync(result.queuePath), false);
});

test('REVIEWMODEL-02: token filesystem mocks cannot create or hide durable refusal receipts', async (t) => {
  const { env, rootDir } = makeEnv();
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const options = {
    event: 'reviewer.model_unavailable', env,
    payload: { refusedModel: 'Synthetic model', availableModels: ['Offered model'] },
    now: new Date('2026-10-12T01:00:00Z'),
    requestText: async () => { throw new Error('synthetic offline transport'); },
  };
  const first = await deliverAlert('synthetic refusal', {
    ...options, fsImpl: { readFileSync: () => 'synthetic-token', existsSync: () => true },
  });
  assert.equal(first.queued, true, 'virtual token presence must not suppress enqueue');
  assert.equal(existsSync(first.queuePath), true);
  const deliveredPath = sinkPath(rootDir, 'delivered', `${first.id}.json`);
  renameSync(first.queuePath, deliveredPath);
  const second = await deliverAlert('synthetic refusal', {
    ...options, fsImpl: { readFileSync: () => 'synthetic-token', existsSync: () => false },
  });
  assert.equal(second.queued, false, 'virtual token absence must not hide an actual receipt');
  assert.equal(second.status, 'delivered');
  assert.equal(second.queuePath, deliveredPath);
  assert.equal(existsSync(first.queuePath), false);
});


for (const event of [...FIXED_RECOVERY_EVENTS, 'reviewer.model_unavailable', 'adversarial_review.operator_decision_required']) {
  test(`ORPHANPAGE-01: fixed identity validates and delivers once: ${event}`, async t => {
    const { env, rootDir } = makeEnv();
    t.after(() => rmSync(rootDir, { recursive: true, force: true }));
    let sends = 0;
    const options = { env, event,
      payload: { repo: 'fixture/repo', pr: 1, head: 'synthetic', prNumber: 1, headSha: 'synthetic',
        reason: 'synthetic', refusedModel: 'synthetic', decisionId: 'synthetic', decisionSeriesId: 'synthetic' },
      fsImpl: { existsSync: () => true, readFileSync: () => 'synthetic-token' },
      requestText: async () => { sends += 1; return { statusCode: 200, body: '{}' }; } };
    const queued = await deliverAlert('synthetic page', options);
    const doc = JSON.parse(readFileSync(queued.queuePath, 'utf8'));
    assert.match(doc.id, /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/u);
    assert.equal(validateAlertDocIdentity(queued.queuePath, doc), doc);
    assert.equal((await deliverAlert('synthetic duplicate', options)).queued, false);
    await drainPendingAlerts(options);
    assert.equal(existsSync(sinkPath(rootDir, 'delivered', `${doc.id}.json`)), true);
    assert.equal((await deliverAlert('synthetic duplicate', options)).status, 'delivered');
    await drainPendingAlerts(options);
    assert.equal(sends, 1);
  });
}

test('ORPHANPAGE-01: old dotted quarantine is reported but never suppresses or replays a page', async t => {
  const { env, rootDir } = makeEnv();
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  ensureAlertSinkDirs(rootDir);
  const event = 'ama.orphan_recovery.exhausted';
  const payload = { repo: 'fixture/repo', prNumber: 1, headSha: 'synthetic' };
  const oldId = `${event}-${createHash('sha256').update('fixture/repo#1@synthetic').digest('hex')}`;
  const oldPath = sinkPath(rootDir, 'quarantine', `${oldId}.json`);
  const bytes = JSON.stringify({ id: oldId, event, payload });
  writeFileSync(oldPath, bytes);
  let sends = 0;
  const options = { env, event, payload,
    fsImpl: { existsSync: () => true, readFileSync: () => 'synthetic-token' },
    requestText: async () => { sends += 1; return { statusCode: 200, body: '{}' }; } };
  assert.equal((await deliverAlert('synthetic page', options)).queued, true);
  await drainPendingAlerts(options);
  assert.equal(sends, 1);
  assert.equal(readFileSync(oldPath, 'utf8'), bytes);
  assert.equal(readAlertSinkHealth({ env }).quarantineEventCounts[event], 1);
});

test('ORPHANPAGE-01: unsafe enqueue identity is normalized with one warning and delivers', async t => {
  const { env, rootDir } = makeEnv();
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const options = { env, fsImpl: { existsSync: () => true, readFileSync: () => 'synthetic-token' },
    requestText: async () => ({ statusCode: 200, body: '{}' }) };
  const original = await deliverAlert('synthetic page', { ...options, event: 'synthetic.event' });
  const doc = JSON.parse(readFileSync(original.queuePath, 'utf8'));
  rmSync(original.queuePath);
  doc.id = 'unsafe.id';
  const warnings = [];
  const queued = queueAlertDoc(rootDir, doc, { logger: { warn: line => warnings.push(line) } });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /synthetic\.event/);
  validateAlertDocIdentity(queued.filePath, JSON.parse(readFileSync(queued.filePath, 'utf8')));
  await drainPendingAlerts(options);
  assert.equal(existsSync(sinkPath(rootDir, 'delivered', `${doc.id}.json`)), true);
  assert.equal(readdirSync(sinkPath(rootDir, 'quarantine')).length, 0);
});


for (const event of ['ama_finding_dispute_exhausted', 'ama_primary_change_refusal_exhausted',
  'ama.closure_lag.slo_breach', 'reviewer.model_unavailable', 'adversarial_review.operator_decision_required']) {
  for (const state of ['pending', 'inflight', 'delivered', 'dead-letter']) {
    test(`ORPHANPAGE-01: previous valid ${event} id suppresses duplicate in ${state}`, async t => {
      const { env, rootDir } = makeEnv();
      t.after(() => rmSync(rootDir, { recursive: true, force: true }));
      const payload = { repo: 'fixture/repo', prNumber: 1, headSha: 'synthetic',
        refusedModel: 'synthetic', decisionId: 'synthetic', decisionSeriesId: 'synthetic' };
      const now = new Date('2026-10-13T12:00:00Z');
      const options = { env, event, payload, now };
      const queued = await deliverAlert('synthetic page', options);
      const hashInput = event === 'ama_finding_dispute_exhausted' ? 'fixture/repo#1'
        : event === 'ama_primary_change_refusal_exhausted' ? 'fixture/repo#1@synthetic'
          : event === 'ama.closure_lag.slo_breach' ? JSON.stringify(payload)
            : event === 'reviewer.model_unavailable' ? JSON.stringify(['synthetic', '2026-10-13'])
              : JSON.stringify(['synthetic', 'synthetic']);
      const prefix = event === 'ama.closure_lag.slo_breach' ? 'ama-closure-lag'
        : event === 'reviewer.model_unavailable' ? 'reviewer-model'
          : event === 'adversarial_review.operator_decision_required' ? 'review-decision' : event;
      const oldId = `${prefix}-${createHash('sha256').update(hashInput).digest('hex')}`;
      assert.equal(queued.id, oldId);
      if (state !== 'pending') renameSync(queued.queuePath, sinkPath(rootDir, state, `${oldId}.json`));
      assert.equal((await deliverAlert('synthetic duplicate', options)).status, state);
      assert.equal((await deliverAlert('synthetic duplicate', options)).queued, false);
    });
  }
}

test('ORPHANPAGE-01: quarantine event diagnostics are bounded and watcher includes them', t => {
  const { env, rootDir } = makeEnv();
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  ensureAlertSinkDirs(rootDir);
  for (let index = 0; index < 30; index += 1) {
    writeFileSync(sinkPath(rootDir, 'quarantine', `${index}.json`), JSON.stringify({ event: `synthetic.event.${index}` }));
  }
  const counts = readAlertSinkHealth({ env }).quarantineEventCounts;
  assert.equal(Object.keys(counts).length, 21);
  assert.equal(counts.other, 10);
  assert.equal(Object.values(counts).reduce((sum, count) => sum + count, 0), 30);
  const source = readFileSync(new URL('../src/watcher.mjs', import.meta.url), 'utf8');
  assert.match(source, /quarantineEventCounts: sinkHealth\.quarantineEventCounts/);
});

test('quarantine diagnostics use injected reads, stable ordering and a count-invalidated cache', t => {
  const { env, rootDir } = makeEnv();
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  ensureAlertSinkDirs(rootDir);
  const directory = sinkPath(rootDir, 'quarantine');
  let names = ['z.json', 'notes.txt', 'a.json', 'bad.json'];
  const reads = [];
  const fsImpl = {
    existsSync, statSync,
    readdirSync: path => path === directory ? names : readdirSync(path),
    readFileSync: path => {
      reads.push(path);
      if (path.endsWith('bad.json')) throw new Error('unreadable fixture');
      return JSON.stringify({ event: path.endsWith('a.json') ? 'z.event' : 'a.event' });
    },
  };
  const health = () => readAlertSinkHealth({ env, fsImpl });
  const first = health();
  assert.equal(first.ready, false);
  assert.deepEqual(first.quarantineEventCounts, { 'a.event': 1, unknown: 1, 'z.event': 1 });
  assert.deepEqual(reads, ['a.json', 'bad.json', 'z.json'].map(name => join(directory, name)));
  names.reverse();
  assert.equal(JSON.stringify(health().quarantineEventCounts), JSON.stringify(first.quarantineEventCounts));
  assert.equal(reads.length, 3, 'unchanged count reuses the breakdown');
  first.quarantineEventCounts['a.event'] = 99;
  assert.equal(health().quarantineEventCounts['a.event'], 1, 'callers cannot mutate the cache');
  const fresh = readAlertSinkHealth({ env, fsImpl: { ...fsImpl, readdirSync: path => fsImpl.readdirSync(path) } });
  assert.deepEqual(fresh.quarantineEventCounts, health().quarantineEventCounts, 'injected filesystem changes rescan deterministically');
  names.push('new.json');
  assert.equal(health().quarantineEventCounts['a.event'], 2, 'count changes refresh the breakdown');
  names = [];
  reads.length = 0;
  assert.equal(health().ready, true);
  assert.deepEqual(health().quarantineEventCounts, {});
  names = ['z.json'];
  assert.deepEqual(health().quarantineEventCounts, { 'a.event': 1 });
  names = [];
  assert.deepEqual(health().quarantineEventCounts, {});
  names = ['a.json'];
  assert.deepEqual(health().quarantineEventCounts, { 'z.event': 1 }, 'empty quarantine clears the cache');
  names = [];
  writeFileSync(sinkPath(rootDir, 'pending', 'pending.json'), '{}');
  reads.length = 0;
  assert.equal(health().ready, false);
  assert.deepEqual(health().quarantineEventCounts, {});
  assert.equal(reads.length, 0, 'empty quarantine never reads diagnostic documents, even when degraded');
});

test('quarantine diagnostics filter and sort before the 1,000-document cap', t => {
  const { env, rootDir } = makeEnv();
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  ensureAlertSinkDirs(rootDir);
  const directory = sinkPath(rootDir, 'quarantine');
  const names = Array.from({ length: 1005 }, (_, index) => `${String(index).padStart(4, '0')}.json`);
  const reads = [];
  const health = readAlertSinkHealth({ env, fsImpl: {
    existsSync, statSync,
    readdirSync: path => path === directory ? ['notes.txt', ...names.toReversed()] : readdirSync(path),
    readFileSync: path => { reads.push(path); return '{"event":"fixture.event"}'; },
  } });
  assert.equal(health.quarantineCount, 1005);
  assert.deepEqual(health.quarantineEventCounts, { 'fixture.event': 1000 });
  assert.deepEqual(reads, names.slice(0, 1000).map(name => join(directory, name)));
});
for (const budgetState of ['rateLimited', 'deferred']) {
  test(`operator alerts remain durable during a ${budgetState} GitHub tick`, async t => {
    const { env, rootDir } = makeEnv();
    t.after(() => rmSync(rootDir, { recursive: true, force: true }));
    await withGitHubBudgetScope({ [budgetState]: true }, async () => {
      for (const event of ['ama.closure_lag.slo_breach', 'ama.orphan_recovery.exhausted',
        'adversarial_review.operator_decision_required', 'ama.ci_blocked.hammer_final']) {
        const queued = await deliverAlert('Operator action required', {
          event, payload: { repo: 'fixture/repo', prNumber: 1, headSha: 'a'.repeat(40) },
          env, requestText: async () => { throw new Error('offline'); },
        });
        assert.equal(queued.status, 'queued');
        assert.equal(queued.queued, true);
        assert.equal(JSON.parse(readFileSync(queued.queuePath, 'utf8')).event, event);
        assert.ok(existsSync(queued.receiptPath));
      }
    });
    assert.equal(readAlertSinkHealth({ env }).pendingCount, 4);
  });
}

test('CLOSERGATE-01: inspection page deduplicates an attempt before and after outbox delivery', async t => {
  const { env, rootDir } = makeEnv();
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const options = { env, event: 'ama_closer.pre_receipt_inspection_required',
    payload: { repo: 'fixture/repo', prNumber: 7, headSha: 'synthetic-head',
      dispatchIdempotencyKey: 'synthetic-key', reason: 'receipt-lookup-unreadable' },
    requestText: async () => ({ statusCode: 200, body: '{}' }) };
  const first = await deliverAlert('Synthetic intent requires inspection', options);
  const retry = await deliverAlert('Synthetic intent requires inspection', options);
  assert.equal(retry.id, first.id);
  assert.equal(retry.queued, false);
  renameSync(first.queuePath, sinkPath(rootDir, 'delivered', `${first.id}.json`));
  const afterDelivery = await deliverAlert('Synthetic intent requires inspection', {
    ...options, payload: { ...options.payload, reason: 'receipt-identity-ambiguous' } });
  assert.equal(afterDelivery.status, 'delivered');
  assert.equal(afterDelivery.queued, false);
  const nextAttempt = await deliverAlert('Another synthetic intent requires inspection', {
    ...options, payload: { ...options.payload, dispatchIdempotencyKey: 'synthetic-next-key' } });
  assert.notEqual(nextAttempt.id, first.id);
  const presentation = alertPresentationForDoc({ ...options, text: 'Synthetic intent requires inspection' });
  assert.equal(presentation.severity, 'SEV1');
  assert.match(presentation.detail, /fixture\/repo#7.*synthetic-head.*receipt-lookup-unreadable/);
});
