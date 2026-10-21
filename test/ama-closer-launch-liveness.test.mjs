import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AMA_CLOSER_UNKNOWN_LAUNCH_RECLAIM_AGE_MS as FALLBACK,
  AMA_CLOSER_DISPATCHED_LEASE_RECLAIM_AGE_MS as TERMINAL_AGE,
  amaCloserLeaseFilePath,
  acquireAmaCloserLease, updateAmaCloserLease, readAmaCloserLease, isHeldAmaCloserLease,
  isReclaimableDispatchedAmaCloserLease as reclaim,
  isReclaimableDispatchedAmaCloserLeaseAsync as reclaimAsync,
} from '../src/ama/closer-lease.mjs';
import { MAX_WORKER_EXEC_TIMEOUT_SECONDS } from '../src/worker-execution-limits.mjs';
import { decideClosureOwner } from '../src/ama/closure-owner.mjs';
import { reapStaleCloserLeases, selectReleasableCloserLeases } from '../src/recovery-reaper.mjs';

const probes = JSON.parse(readFileSync(new URL('./fixtures/closer-launch-liveness.json', import.meta.url)));
const now = Date.parse('2026-10-01T12:00:00Z');
const leaseAt = (age, extra = {}) => ({ status: 'dispatched', lrqId: 'synthetic-launch',
  updatedAt: new Date(now - age).toISOString(), terminalOutcome: null, ...extra });

for (const status of ['requested', 'queued', 'admitted', 'leased', 'starting', 'running']) {
  test(`LEASELIVE-01: ${status} retains ownership at 45 minutes and past fallback`, async () => {
    const reader = ({ launchRequestId, includeRetryChain }) => {
      assert.equal(launchRequestId, 'synthetic-launch');
      assert.equal(includeRetryChain, true);
      return { ok: true, row: { status } };
    };
    for (const age of [45 * 60_000, FALLBACK + 1]) {
      const lease = leaseAt(age);
      assert.equal(reclaim(lease, { now, readLaunchRequestStatusImpl: reader }), false);
      assert.equal(await reclaimAsync(lease, { now, readLaunchRequestStatusImpl: async args => reader(args) }), false);
      assert.equal(decideClosureOwner({ lease, now, readLaunchRequestStatusImpl: reader }).reason, 'in-flight:synthetic-launch');
    }
  });
}

test('LEASELIVE-01: terminal launch retains the existing age and sticky success rules', () => {
  for (const [age, expected] of [[30 * 60_000 - 1, false], [45 * 60_000, true]]) {
    assert.equal(reclaim(leaseAt(age), { now, launchStatusProbe: probes.terminal }), expected);
    assert.equal(reclaim(leaseAt(age, { terminalOutcome: 'succeeded' }), { now, launchStatusProbe: probes.terminal }), false);
  }
  assert.equal(reclaim(leaseAt(FALLBACK + 1), { now, launchStatusProbe: probes.liveRetry }), false);
});

for (const kind of ['missing-id', 'unreadable', 'throwing', 'unreadableRetry']) {
  test(`LEASELIVE-01: ${kind} uses the execution ceiling plus margin`, async () => {
    assert.ok(FALLBACK >= MAX_WORKER_EXEC_TIMEOUT_SECONDS * 1000 + 30 * 60_000);
    const reader = () => { if (kind === 'throwing') throw new Error('synthetic read failure'); return probes[kind] ?? null; };
    for (const age of [45 * 60_000, FALLBACK - 1, FALLBACK, FALLBACK + 1]) {
      const lease = leaseAt(age, kind === 'missing-id' ? { lrqId: null } : {});
      assert.equal(reclaim(lease, { now, readLaunchRequestStatusImpl: reader }), age >= FALLBACK);
      assert.equal(await reclaimAsync(lease, { now, readLaunchRequestStatusImpl: async () => reader() }), age >= FALLBACK);
    }
  });
}

test('LEASELIVE-01: periodic reaper retains a running launch despite dead watcher and short thresholds', async t => {
  const rootDir = mkdtempSync(join(tmpdir(), 'closer-liveness-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const identity = { repo: 'acme/repo', prNumber: 7, headSha: 'synthetic-head' };
  const stamp = leaseAt(FALLBACK + 1).updatedAt;
  acquireAmaCloserLease({ rootDir, ...identity, now: stamp, watcherPid: 4242 });
  updateAmaCloserLease({ rootDir, ...identity, now: stamp, status: 'dispatched', lrqId: 'synthetic-launch' });
  const options = { rootDir, now, thresholdMs: 1, deadHolderThresholdMs: 1, livePid: null,
    isProcessAlive: () => false, logger: { info() {}, warn() {}, error() {} } };
  const held = await reapStaleCloserLeases({ ...options, readLaunchRequestStatusImpl: async () => probes.running });
  assert.equal(held.released, 0);
  assert.equal(readAmaCloserLease(rootDir, identity).status, 'dispatched');
  assert.equal(isHeldAmaCloserLease(rootDir, identity, { now, launchStatusProbe: probes.running }), true);
  const released = await reapStaleCloserLeases({ ...options, readLaunchRequestStatusImpl: async () => probes.terminal });
  assert.equal(released.released, 1);
  assert.equal(readAmaCloserLease(rootDir, identity), null);
});

test('LEASELIVE-01: periodic missing/unreadable launch fallback ignores dead watcher tier', () => {
  for (const lrqId of [null, 'synthetic-launch']) {
    for (const age of [45 * 60_000, FALLBACK - 1, FALLBACK + 1]) {
      const selected = selectReleasableCloserLeases([leaseAt(age, { lrqId, watcherPid: 4242 })], {
        now, thresholdMs: 1, deadHolderThresholdMs: 1, isProcessAlive: () => false,
        launchStatusProbes: new Map([['synthetic-launch', probes.unreadable]]),
      });
      assert.equal(selected.length, age >= FALLBACK ? 1 : 0);
    }
  }
});

test('LEASELIVE-01: periodic reaper probes only leases at the terminal reclaim age', async t => {
  const stamp = age => new Date(now - age).toISOString();
  const cases = [
    { updatedAt: stamp(TERMINAL_AGE - 1), probe: false },
    { updatedAt: stamp(TERMINAL_AGE), probe: true },
    { updatedAt: stamp(TERMINAL_AGE + 1), probe: true },
    { updatedAt: stamp(1), acquiredAt: stamp(FALLBACK + 1), probe: false },
    { updatedAt: null, acquiredAt: stamp(TERMINAL_AGE), probe: true },
    { updatedAt: null, acquiredAt: stamp(TERMINAL_AGE - 1), probe: false },
    { updatedAt: 'unreadable', acquiredAt: stamp(FALLBACK + 1), probe: false },
    { updatedAt: null, acquiredAt: null, probe: false },
    { updatedAt: stamp(-1), probe: false },
  ];
  for (const clock of [now, new Date(now).toISOString()]) {
    for (const { probe, ...timestamps } of cases) {
      const rootDir = mkdtempSync(join(tmpdir(), 'closer-probe-age-'));
      t.after(() => rmSync(rootDir, { recursive: true, force: true }));
      const identity = { repo: 'acme/repo', prNumber: 9, headSha: 'synthetic-head' };
      acquireAmaCloserLease({ rootDir, ...identity, now: stamp(FALLBACK + 1) });
      const { lease } = updateAmaCloserLease({ rootDir, ...identity,
        now: stamp(FALLBACK + 1), status: 'dispatched', lrqId: 'synthetic-launch' });
      writeFileSync(amaCloserLeaseFilePath(rootDir, identity), JSON.stringify({ ...lease, ...timestamps }));
      const calls = [];
      const result = await reapStaleCloserLeases({ rootDir, now: clock, livePid: null,
        logger: { info() {}, warn() {}, error() {} },
        readLaunchRequestStatusImpl: async args => { calls.push(args); return probes.terminal; } });
      assert.equal(calls.length, probe ? 1 : 0, JSON.stringify({ clock, timestamps }));
      assert.equal(result.released, probe ? 1 : 0);
      if (probe) assert.deepEqual(calls[0], {
        launchRequestId: 'synthetic-launch', rootDir, includeRetryChain: true,
      });
    }
  }
});

test('LEASELIVE-01: async reclaim checks disk currency only with a numeric PR identity', async t => {
  const rootDir = mkdtempSync(join(tmpdir(), 'closer-partial-identity-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  for (const prNumber of [undefined, null, 'unreadable', NaN, Infinity, 9, '9']) {
    const hasNumericPr = prNumber != null && Number.isFinite(Number(prNumber));
    const lease = leaseAt(TERMINAL_AGE, { repo: 'acme/repo', headSha: 'synthetic-head', prNumber });
    const result = await reclaimAsync(lease, { rootDir, now,
      readLaunchRequestStatusImpl: async () => probes.terminal });
    assert.equal(result, !hasNumericPr, `PR ${String(prNumber)}`);
  }
});

test('LEASELIVE-01: an awaited probe cannot reclaim a replacement lease', async t => {
  const rootDir = mkdtempSync(join(tmpdir(), 'closer-replaced-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const identity = { repo: 'acme/repo', prNumber: 8, headSha: 'synthetic-head' };
  const stamp = leaseAt(FALLBACK + 1).updatedAt;
  acquireAmaCloserLease({ rootDir, ...identity, now: stamp });
  updateAmaCloserLease({ rootDir, ...identity, now: stamp, status: 'dispatched', lrqId: 'synthetic-launch' });
  const oldLease = readAmaCloserLease(rootDir, identity);
  assert.equal(await reclaimAsync(oldLease, { rootDir, now,
    readLaunchRequestStatusImpl: async () => probes.terminal }), true);
  const replaceDuringRead = async () => {
    updateAmaCloserLease({ rootDir, ...identity, now: new Date(now).toISOString(),
      status: 'dispatched', lrqId: 'synthetic-replacement' });
    return probes.terminal;
  };
  assert.equal(await reclaimAsync(oldLease, { rootDir, now, readLaunchRequestStatusImpl: replaceDuringRead }), false);
  updateAmaCloserLease({ rootDir, ...identity, now: stamp, status: 'dispatched', lrqId: 'synthetic-launch' });
  const result = await reapStaleCloserLeases({ rootDir, now: now + FALLBACK, livePid: null,
    readLaunchRequestStatusImpl: replaceDuringRead, logger: { info() {}, warn() {}, error() {} } });
  assert.equal(result.released, 0);
  assert.equal(readAmaCloserLease(rootDir, identity).lrqId, 'synthetic-replacement');
});
