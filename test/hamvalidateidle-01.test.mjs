import { performance } from 'node:perf_hooks';
import { FakeClock } from './helpers/load-time-kit.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { runBounded } from '../src/ama/bounded-command.mjs';
import { LEASE_VALIDATION_IDLE_MS, leaseValidationIdleMs } from '../src/ama/lease-validation.mjs';

// Synthetic host readings, so no test depends on the machine running it.
const IDLE_HOST = { loadAvg1m: 0, cpuCount: 18, cpuBusyPercent: 5 };
const BUSY_HOST = { loadAvg1m: 110, cpuCount: 18, cpuBusyPercent: 90 };
const ONE_HOUR = 3_600_000;

function fakeChild() {
  return Object.assign(new EventEmitter(), {
    pid: 42424, exitCode: null, signalCode: null,
    stdout: new PassThrough(), stderr: new PassThrough(),
  });
}

function startSilentValidation(t, idleMs) {
  const clock = new FakeClock(t, { wall: Date.now() });
  t.mock.method(performance, 'now', () => clock.monotonic());
  const child = fakeChild();
  let err = '';
  const pending = runBounded('synthetic-check', [], {
    timeoutMs: ONE_HOUR, idleMs, graceMs: 100,
    spawnImpl: () => child,
    killImpl: (_pid, signal) => {
      if (signal !== 0 && child.signalCode === null && child.exitCode === null) {
        child.signalCode = signal;
        child.emit('exit', null, signal);
        child.emit('close');
      }
      if (signal === 0) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
    },
    stdout: { write() {} }, stderr: { write(chunk) { err += chunk; } },
  });
  return { clock, child, pending, log: () => err };
}

test('the no-progress limit is the base value at normal load', () => {
  assert.equal(leaseValidationIdleMs(ONE_HOUR, IDLE_HOST), LEASE_VALIDATION_IDLE_MS);
  assert.equal(leaseValidationIdleMs(ONE_HOUR, { ...IDLE_HOST, enabled: false }), LEASE_VALIDATION_IDLE_MS);
});

test('the no-progress limit grows with host load, within the shared ceiling', () => {
  const scaled = leaseValidationIdleMs(ONE_HOUR, BUSY_HOST);
  assert.ok(scaled > LEASE_VALIDATION_IDLE_MS, `${scaled} should exceed the base`);
  assert.ok(scaled <= LEASE_VALIDATION_IDLE_MS * 6, `${scaled} must respect the multiplier ceiling`);
});

test('the no-progress limit stays strictly below the remaining absolute deadline', () => {
  assert.equal(leaseValidationIdleMs(50_000, BUSY_HOST), 49_999);
  assert.equal(leaseValidationIdleMs(50_000, IDLE_HOST), 49_999);
  assert.equal(leaseValidationIdleMs(1, BUSY_HOST), 1);
  for (const remaining of [2, 1000, 119_999, 120_001, 700_000, ONE_HOUR]) {
    for (const host of [IDLE_HOST, BUSY_HOST]) {
      assert.ok(leaseValidationIdleMs(remaining, host) < remaining);
    }
  }
});

test('a quiet check that outlasts the base limit completes at high load', async t => {
  const idleMs = leaseValidationIdleMs(ONE_HOUR, BUSY_HOST);
  const { clock, child, pending, log } = startSilentValidation(t, idleMs);
  await clock.advance(LEASE_VALIDATION_IDLE_MS * 2);
  assert.ok(LEASE_VALIDATION_IDLE_MS * 2 < idleMs);
  child.stdout.write('check passed\n');
  await clock.flush();
  child.exitCode = 0;
  child.emit('exit', 0, null);
  child.emit('close');
  assert.equal(await pending, 0);
  assert.doesNotMatch(log(), /no-progress-timeout/);
  assert.match(log(), new RegExp(`started absolute=${ONE_HOUR}ms idle=${idleMs}ms`));
});

test('the same quiet check is killed at the base limit when load is normal', async t => {
  const { clock, pending, log } = startSilentValidation(t, leaseValidationIdleMs(ONE_HOUR, IDLE_HOST));
  await clock.advance(LEASE_VALIDATION_IDLE_MS + 100);
  assert.equal(await pending, 124);
  assert.match(log(), /no-progress-timeout/);
});

test('a truly silent child is still stopped at the scaled limit', async t => {
  const idleMs = leaseValidationIdleMs(ONE_HOUR, BUSY_HOST);
  const { clock, pending, log } = startSilentValidation(t, idleMs);
  await clock.advance(idleMs - 200);
  let settled = false;
  pending.then(() => { settled = true; });
  await clock.flush();
  assert.equal(settled, false);
  await clock.advance(300);
  assert.equal(await pending, 124);
  assert.match(log(), /no-progress-timeout.*bytes=0.*status=124/);
});
