import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  assertAlertSinkOwner,
  deliverAlert,
  drainPendingAlerts,
  pendingDir,
  readAlertSinkHealth,
  resolveAlertDefaults,
} from '../src/alert-delivery.mjs';

function makeEnv(overrides = {}) {
  const rootDir = mkdtempSync(join(tmpdir(), 'alert-delivery-'));
  const env = {
    ALERT_TO: '123456',
    ALERT_AGENT_ID: 'ops',
    ALERT_NAME: 'Adversarial Watcher Health Test',
    ALERT_CHANNEL: 'telegram',
    AGENT_OS_GBI_ALERT_BUS_URL: 'http://127.0.0.1:18799/hooks/wake',
    OPENCLAW_HOOKS_TOKEN_FILE: '/secrets/hooks.token',
    ADVERSARIAL_ALERT_DELIVERY_ROOT: rootDir,
    ...overrides,
  };
  return { env, rootDir };
}

function sinkPath(rootDir, ...parts) {
  return join(rootDir, 'data', 'alert-delivery', ...parts);
}

test('watcher alert defaults require an explicit recipient', () => {
  assert.throws(
    () => resolveAlertDefaults({}),
    /ALERT_TO must be configured for alert delivery/
  );
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
  assert.equal(calls[0].options.body.metadata.alertId, queued.id);
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

test('permanent delivery failure reaches an operator-visible dead letter ceiling', async (t) => {
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

  assert.equal(first.status, 'queued');
  assert.equal(second.status, 'error');
  assert.equal(second.results[0].status, 'dead-lettered');
  assert.equal(readdirSync(sinkPath(rootDir, 'dead-letter')).length, 1);
  const health = readAlertSinkHealth({ env });
  assert.equal(health.ready, false);
  assert.equal(health.pendingCount, 0);
  assert.equal(health.deadLetterCount, 1);
  assert.match(health.lastFailureReason, /dead-lettered.*2 attempts.*HTTP 401/);
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
