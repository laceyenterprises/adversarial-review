import './helpers/load-aware-timeout-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  alertDeliveryHeartbeatStatus, canonicalAlertScriptTimeoutMs, drainPendingAlerts,
  queueAlertDoc, readAlertSinkHealth, spawnCanonicalAlertScript,
} from '../src/alert-delivery.mjs';
import { MAX_TIMER_DELAY_MS } from '../src/load-aware-timeout.mjs';
import { createWatcherHeartbeat } from '../src/watcher-heartbeat.mjs';

const tripleLoad = {
  enabled: true, maxMultiplier: 3, loadAvg1m: 4, cpuCount: 1, cpuBusyPercent: 100,
};

function fakeChild() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.kill = () => { child.killed = true; };
  return child;
}

function queuedFixture(t, event = 'watcher.no_progress') {
  const root = mkdtempSync(join(tmpdir(), 'delivery-timeout-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const script = join(root, 'synthetic.mjs');
  writeFileSync(script, 'process.exit(0);\n');
  const env = { ADVERSARIAL_ALERT_DELIVERY_ROOT: root, AGENT_OS_ALERT_DELIVERY_SCRIPT: script,
    ADVERSARIAL_ALERT_DELIVERY_MAX_ATTEMPTS: '3' };
  queueAlertDoc(root, {
    id: 'synthetic-page', event, text: 'Synthetic operator notice',
    payload: { repo: 'example/project', prNumber: 42, headSha: 'a'.repeat(40) },
    delivery: { alertTo: 'synthetic', alertChannel: 'telegram', alertName: 'Test', alertAgentId: 'test' },
    createdAt: '2026-10-01T00:00:00.000Z', state: 'pending', attemptCount: 0,
  });
  return { root, env };
}

test('canonical spawn lets a 60-second script finish at 3x load, scaling once', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const child = fakeChild();
  const result = spawnCanonicalAlertScript('synthetic.mjs', {}, {}, {
    loadOptions: tripleLoad,
    spawnImpl: () => { setTimeout(() => child.emit('close', 0), 60_000); return child; },
  });
  assert.equal(canonicalAlertScriptTimeoutMs(tripleLoad), 105_000);
  t.mock.timers.tick(60_000);
  assert.equal((await result).code, 0);
  t.mock.timers.tick(105_000);
  assert.equal(child.killed, false);
});

test('canonical spawn reports its effective timeout and marks it transient', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const child = fakeChild();
  const result = spawnCanonicalAlertScript('synthetic.mjs', {}, {}, {
    loadOptions: tripleLoad, spawnImpl: () => child,
  });
  t.mock.timers.tick(104_999);
  assert.equal(child.killed, false);
  t.mock.timers.tick(1);
  const failure = await result;
  assert.equal(child.killed, true);
  assert.equal(failure.errorCode, 'ETIMEDOUT');
  assert.match(failure.stderr, /timed out after 105000ms/);
});

test('canonical timeout always respects five-minute and platform ceilings', () => {
  for (const options of [tripleLoad, { ...tripleLoad, maxMultiplier: Infinity, maxMs: Infinity,
    loadAvg1m: Number.MAX_VALUE }, { enabled: false, maxMultiplier: Infinity }]) {
    const timeout = canonicalAlertScriptTimeoutMs(options);
    assert.ok(timeout >= 35_000 && timeout <= 300_000 && timeout <= MAX_TIMER_DELAY_MS);
  }
  assert.equal(canonicalAlertScriptTimeoutMs({ ...tripleLoad, maxMultiplier: Infinity,
    loadAvg1m: Number.MAX_VALUE, maxMs: Infinity }), 300_000);
});

test('transient canonical timeout backs off before delivery with the same identity', async t => {
  const { env } = queuedFixture(t);
  const ids = [];
  const runAlertScript = async (_script, payload) => {
    ids.push(payload.idempotencyKey);
    return ids.length === 1 ? { code: 1, errorCode: 'ETIMEDOUT', stderr: 'timed out' } : { code: 0 };
  };
  const drain = at => drainPendingAlerts({ env, runAlertScript, now: new Date(`2026-10-01T00:00:${at}.000Z`) });
  const first = await drain('00');
  assert.equal(first.results[0].status, 'queued');
  assert.equal(first.results[0].nextAttemptAfter, '2026-10-01T00:00:05.000Z');
  assert.equal((await drain('04')).results[0].reason, 'backoff-not-elapsed');
  assert.equal(ids.length, 1);
  assert.equal((await drain('05')).drained, 1);
  assert.deepEqual(ids, ['synthetic-page', 'synthetic-page']);
  assert.equal(readAlertSinkHealth({ env }).deadLetterCount, 0);
});

for (const stderr of ['HTTP 400: Bad Request', 'unknown sink: synthetic', 'HTTP 401']) {
  test(`permanent canonical error dead-letters immediately: ${stderr}`, async t => {
    const { env } = queuedFixture(t);
    let attempts = 0;
    const runAlertScript = async () => { attempts++; return { code: 1, stderr }; };
    const first = await drainPendingAlerts({ env, runAlertScript });
    assert.equal(first.results[0].status, 'dead-lettered');
    await drainPendingAlerts({ env, runAlertScript });
    assert.equal(attempts, 1);
    assert.equal(alertDeliveryHeartbeatStatus({ env }).alert_delivery_failure, null);
  });
}

for (const stderr of ['HTTP 429: retry later', 'HTTP 503: unavailable', 'temporary credential lookup failure']) {
  test(`transient canonical exit retries after backoff: ${stderr}`, async t => {
    const { env } = queuedFixture(t);
    const runAlertScript = async () => ({ code: 1, stderr });
    const result = await drainPendingAlerts({ env, runAlertScript, now: new Date('2026-10-01T00:00:00Z') });
    assert.equal(result.results[0].status, 'queued');
    assert.equal(result.results[0].nextAttemptAfter, '2026-10-01T00:00:05.000Z');
    assert.equal(readAlertSinkHealth({ env }).deadLetterCount, 0);
  });
}

test('a permanently rejected SEV1 signals its first failed attempt', async t => {
  const { env } = queuedFixture(t, 'ama.review_cycle_cap.hammer_final');
  await drainPendingAlerts({ env, runAlertScript: async () => ({ code: 1, stderr: 'unknown sink' }) });
  const signal = alertDeliveryHeartbeatStatus({ env }).alert_delivery_failure;
  assert.equal(signal.attemptCount, 1);
  assert.equal(signal.event, 'ama.review_cycle_cap.hammer_final');
  assert.equal(signal.pr, 42);
});

test('exhausted SEV1 delivery persists one failure signal in health and heartbeat', async t => {
  const { env, root } = queuedFixture(t, 'ama.review_cycle_cap.hammer_final');
  let attempts = 0;
  const runAlertScript = async () => { attempts++; return { code: 1, errorCode: 'ETIMEDOUT', stderr: 'timeout' }; };
  const drain = seconds => drainPendingAlerts({ env, runAlertScript,
    now: new Date(Date.parse('2026-10-01T00:00:00Z') + seconds * 1000) });
  await drain(0);
  await drain(5);
  assert.equal(alertDeliveryHeartbeatStatus({ env }).alert_delivery_failure, null);
  assert.equal((await drain(14)).results[0].reason, 'backoff-not-elapsed');
  assert.equal((await drain(15)).results[0].status, 'dead-lettered');
  const signal = readAlertSinkHealth({ env }).lastSev1DeliveryFailure;
  assert.equal(signal.signal, 'alert-delivery-failed');
  assert.equal(signal.event, 'ama.review_cycle_cap.hammer_final');
  assert.equal(signal.repo, 'example/project');
  assert.equal(signal.pr, 42);
  assert.equal(signal.attemptCount, 3);
  const filePath = join(root, 'heartbeat.json');
  for (const event of ['alert-failed', 'poll', 'restart']) {
    const heartbeat = createWatcherHeartbeat({ rootDir: root, filePath,
      statusProvider: () => alertDeliveryHeartbeatStatus({ env }) });
    heartbeat.persist(event);
    assert.deepEqual(JSON.parse(readFileSync(filePath, 'utf8')).alert_delivery_failure, signal);
    await drain(60);
  }
  assert.equal(attempts, 3, 'terminal failures are never sent back to the failing transport');
  queueAlertDoc(root, {
    id: 'unrelated-notice', event: 'watcher.recovered', text: 'Recovered',
    delivery: { alertTo: 'synthetic', alertChannel: 'telegram', alertName: 'Test', alertAgentId: 'test' },
    createdAt: '2026-10-01T00:01:00.000Z', state: 'pending', attemptCount: 0,
  });
  await drainPendingAlerts({ env, runAlertScript: async () => ({ code: 0 }) });
  assert.deepEqual(readAlertSinkHealth({ env }).lastSev1DeliveryFailure, signal);
});
