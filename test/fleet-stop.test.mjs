import test from 'node:test';
import assert from 'node:assert/strict';
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fleetStopReason } from '../src/fleet-stop.mjs';
import { alertSinkRoot, deliverAlert, drainPendingAlerts } from '../src/alert-delivery.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'fleet-stop-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, 'control', 'halt');
  mkdirSync(directory, { recursive: true });
  const alerts = [];
  const errors = [];
  const recoveries = [];
  const options = {
    env: { HQ_ROOT: root, ADVERSARIAL_ALERT_DELIVERY_ROOT: join(root, 'alerts') },
    deliverAlertImpl: (text, metadata) => { alerts.push({ text, ...metadata }); },
    logger: { error: line => errors.push(line), info: line => recoveries.push(line) },
  };
  assert.equal(fleetStopReason(options), null);
  return { root, directory, alerts, errors, recoveries, options };
}

function unreadable(code) {
  return () => { throw Object.assign(new Error('synthetic private contents'), { code }); };
}

test('file stop is uncached, accepts no content and preserves merge-only holds', () => {
  const root = mkdtempSync(join(tmpdir(), 'fleet-stop-'));
  const directory = join(root, 'control', 'halt');
  const env = { HQ_ROOT: root, AGENT_OS_HQ_ROOT: join(root, 'unused') };
  try {
    assert.equal(fleetStopReason({ env }), null);
    mkdirSync(directory, { recursive: true });
    const active = join(directory, 'active.json');
    writeFileSync(active, 'corrupt', { mode: 0o600 });
    assert.equal(fleetStopReason({ env }), 'fleet-stop-active');
    rmSync(active);
    symlinkSync(join(root, 'missing'), active);
    assert.equal(fleetStopReason({ env }), 'fleet-stop-active');
    rmSync(active);
    writeFileSync(join(directory, 'merge-kill.json'), '', { mode: 0o600 });
    assert.equal(fleetStopReason({ env }), 'fleet-stop-merge-kill');
    writeFileSync(active, '');
    assert.equal(fleetStopReason({ env }), 'fleet-stop-active');
    rmSync(active);
    assert.equal(fleetStopReason({ env }), 'fleet-stop-merge-kill');
    rmSync(join(directory, 'merge-kill.json'));
    assert.equal(fleetStopReason({ env: { AGENT_OS_HQ_ROOT: root } }), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('unreadable and invalid latch paths fail closed; only ENOENT permits work', (t) => {
  const { options, alerts } = fixture(t);
  for (const code of ['EACCES', 'EPERM', 'ENOTDIR', 'EIO', 'ELOOP']) {
    assert.equal(fleetStopReason({ ...options, lstatImpl: unreadable(code) }), 'fleet-stop-unreadable');
  }
  assert.equal(alerts.length, 5);
});

test('ten evaluations of one unreadable cause alert and log once, including after recovery', (t) => {
  const { options, alerts, errors, recoveries } = fixture(t);
  let reads = 0;
  const lstatImpl = () => { reads += 1; unreadable('EACCES')(); };
  for (let attempt = 0; attempt < 10; attempt += 1) {
    assert.equal(fleetStopReason({ ...options, lstatImpl }), 'fleet-stop-unreadable');
  }
  assert.equal(reads, 10);
  assert.equal(alerts.length, 1);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /ERROR.*fleet-stop-unreadable.*halt directory.*EACCES/u);
  assert.doesNotMatch(JSON.stringify({ alerts, errors }), /synthetic private contents/u);
  assert.equal(fleetStopReason(options), null);
  assert.equal(fleetStopReason(options), null);
  assert.equal(recoveries.length, 1);
  assert.match(recoveries[0], /recovered.*fleet-stop-unreadable.*halt directory/u);
  assert.equal(fleetStopReason({ ...options, lstatImpl }), 'fleet-stop-unreadable');
  assert.equal(alerts.length, 1);
});

test('an unresolvable state root holds and identifies the state root path class', (t) => {
  const { options, alerts, errors } = fixture(t);
  const env = { ...options.env, HQ_ROOT: {} };
  assert.equal(fleetStopReason({ ...options, env }), 'fleet-stop-unreadable');
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].payload.pathClass, 'state root');
  assert.match(errors[0], /fleet-stop-unreadable.*state root/u);
});

test('recovery belongs to the unreadable root, independently of other environments', (t) => {
  const first = fixture(t);
  const second = fixture(t);
  assert.equal(fleetStopReason({ ...first.options, lstatImpl: unreadable('EACCES') }), 'fleet-stop-unreadable');
  assert.equal(fleetStopReason(second.options), null);
  assert.equal(second.recoveries.length, 0);

  assert.equal(fleetStopReason({ ...second.options, lstatImpl: unreadable('EIO') }), 'fleet-stop-unreadable');
  assert.equal(fleetStopReason(first.options), null);
  assert.equal(fleetStopReason(first.options), null);
  assert.equal(first.recoveries.length, 1);
  assert.equal(second.recoveries.length, 0);
  assert.equal(fleetStopReason(second.options), null);
  assert.equal(fleetStopReason(second.options), null);
  assert.equal(second.recoveries.length, 1);
  assert.equal(first.alerts.length, 1);
  assert.equal(second.alerts.length, 1);
});

test('an explicit null logger preserves holds, alert attempts and recovery', async (t) => {
  for (const delivery of ['success', 'throw', 'reject']) {
    const { options } = fixture(t);
    let attempts = 0;
    const silentOptions = {
      ...options,
      logger: null,
      deliverAlertImpl: () => {
        attempts += 1;
        if (delivery === 'throw') throw new Error('synthetic');
        if (delivery === 'reject') return Promise.reject(new Error('synthetic'));
      },
    };
    assert.equal(fleetStopReason({ ...silentOptions, lstatImpl: unreadable('EACCES') }), 'fleet-stop-unreadable');
    await Promise.resolve();
    assert.equal(fleetStopReason(silentOptions), null);
    assert.equal(fleetStopReason({ ...silentOptions, lstatImpl: unreadable('EACCES') }), 'fleet-stop-unreadable');
    assert.equal(attempts, 1);
  }
});

test('present halt markers hold without alerts, including recovery to a deliberate stop', (t) => {
  const { options, directory, alerts, recoveries } = fixture(t);
  for (const [name, reason] of [['active.json', 'fleet-stop-active'], ['merge-kill.json', 'fleet-stop-merge-kill']]) {
    writeFileSync(join(directory, name), 'synthetic contents');
    assert.equal(fleetStopReason(options), reason);
    rmSync(join(directory, name));
  }
  assert.equal(alerts.length, 0);
  assert.equal(fleetStopReason({ ...options, lstatImpl: unreadable('EIO') }), 'fleet-stop-unreadable');
  writeFileSync(join(directory, 'active.json'), '');
  assert.equal(fleetStopReason(options), 'fleet-stop-active');
  assert.equal(recoveries.length, 1);
  assert.equal(alerts.length, 1);
});

test('a readable empty halt directory neither holds nor alerts', (t) => {
  const { options, alerts, errors, recoveries } = fixture(t);
  assert.equal(fleetStopReason(options), null);
  assert.equal(alerts.length, 0);
  assert.equal(errors.length, 0);
  assert.equal(recoveries.length, 0);
});

test('alert enqueue failures never change the unreadable hold or create repeated attempts', async (t) => {
  const { options, errors } = fixture(t);
  for (const deliverAlertImpl of [() => { throw new Error('synthetic'); }, async () => { throw new Error('synthetic'); }]) {
    const env = { ...options.env, HQ_ROOT: join(options.env.HQ_ROOT, String(errors.length)) };
    for (let attempt = 0; attempt < 10; attempt += 1) {
      assert.equal(fleetStopReason({ ...options, env, lstatImpl: unreadable('EACCES'), deliverAlertImpl }), 'fleet-stop-unreadable');
    }
    await Promise.resolve();
  }
  assert.equal(errors.filter(line => line.includes('delivery failed')).length, 2);
});

test('an unreadable halt directory holds while one real alert drains to delivered, never quarantine', async (t) => {
  const { options, directory } = fixture(t);
  // A non-directory halt path reliably exercises a real filesystem read error,
  // including when tests run with permission to bypass chmod restrictions.
  rmSync(directory, { recursive: true });
  writeFileSync(directory, 'synthetic private contents');
  const env = {
    ...options.env,
    ALERT_TO: 'synthetic-recipient',
    AGENT_OS_ALERT_DELIVERY_SCRIPT: '',
    OPENCLAW_HOOKS_TOKEN_FILE: join(options.env.HQ_ROOT, 'synthetic-token'),
    AGENT_OS_GBI_ALERT_BUS_URL: 'https://alerts.example.test/hooks/wake',
  };
  writeFileSync(env.OPENCLAW_HOOKS_TOKEN_FILE, 'synthetic-token');
  const requests = [];
  const transport = { requestText: async (...args) => { requests.push(args); return '{}'; } };
  const queued = [];
  const deliverAlertImpl = (text, metadata) => {
    const result = deliverAlert(text, { ...metadata, ...transport });
    queued.push(result);
    return result;
  };
  for (let attempt = 0; attempt < 10; attempt += 1) {
    assert.equal(fleetStopReason({ ...options, env, lstatImpl: lstatSync, deliverAlertImpl }), 'fleet-stop-unreadable');
  }
  assert.equal(queued.length, 1);
  const [receipt] = await Promise.all(queued);
  assert.match(receipt.id, /^[A-Za-z0-9_-]+$/u);
  const doc = JSON.parse(readFileSync(receipt.queuePath, 'utf8'));
  assert.match(doc.event, /^[A-Za-z0-9_-]+$/u);
  assert.equal(doc.event, 'fleet-stop-unreadable');
  assert.equal(doc.payload.pathClass, 'halt directory');
  assert.doesNotMatch(JSON.stringify(doc), /synthetic private contents/u);
  const drained = await drainPendingAlerts({ env, ...transport });
  assert.equal(drained.drained, 1);
  const sink = alertSinkRoot(env.ADVERSARIAL_ALERT_DELIVERY_ROOT);
  assert.deepEqual(readdirSync(join(sink, 'delivered')), [`${receipt.id}.json`]);
  assert.deepEqual(readdirSync(join(sink, 'quarantine')), []);
  assert.equal(requests.length, 1);
  assert.equal(requests[0][1].body.metadata.deliveryClass, 'page');
});
