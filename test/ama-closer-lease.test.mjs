import { seedCloserIntent, intentExpired } from './helpers/closer-intent-fixture.mjs';
import test from 'node:test';
import { abandonAmaCloserLease, reconcileAndAbandonAmaCloserLease } from '../src/ama/abandoned-closer-lease.mjs';
import { probeOrphanOwnership } from '../src/ama/orphan-watchdog.mjs';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  AMA_CLOSER_LEASE_STATUS,
  releaseRetryableAmaCloserLease,
  rekeyAmaCloserLease,
  abandonedAmaCloserLeaseOutcome,
  acquireAmaCloserLease,
  amaCloserLeaseFilePath,
  deleteAmaCloserLeaseIfCurrent,
  isCurrentAmaCloserLease,
  isReclaimablePendingAmaCloserLease,
  readAmaCloserLease,
  restoreAmaCloserLeaseIfCurrent,
  updateAmaCloserLease,
} from '../src/ama/closer-lease.mjs';

test('CLOSERCUSTODYLRQ-01: durable launch identity and original dispatch time survive repeated promotion and terminalization', t => {
  const rootDir = mkdtempSync(join(tmpdir(), 'closer-receipt-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const owner = { repo: 'fixture/project', prNumber: 17, headSha: 'a'.repeat(40) };
  const dispatchedAt = '2026-10-01T12:00:00Z';
  acquireAmaCloserLease({ rootDir, ...owner, now: dispatchedAt });
  for (const now of [dispatchedAt, '2026-10-01T12:01:00Z']) {
    updateAmaCloserLease({ rootDir, ...owner, status: 'dispatched',
      lrqId: 'synthetic-receipt', workerId: 'hammer-ama-pr-17',
      dispatchedAt: now, now });
  }
  updateAmaCloserLease({ rootDir, ...owner, status: 'terminal',
    terminalOutcome: 'failed-without-merge', now: '2026-10-01T13:00:00Z' });
  const recovered = JSON.parse(readFileSync(amaCloserLeaseFilePath(rootDir, owner), 'utf8'));
  assert.equal(recovered.lrqId, 'synthetic-receipt');
  assert.equal(recovered.workerId, 'hammer-ama-pr-17');
  assert.equal(recovered.dispatchedAt, dispatchedAt);
  assert.equal(recovered.headSha, owner.headSha);
});

test('CLOSERCUSTODYLRQ-01: retained custody restores the predecessor lease only over the unchanged replacement', t => {
  const rootDir = mkdtempSync(join(tmpdir(), 'closer-restore-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const owner = { repo: 'fixture/project', prNumber: 17, headSha: 'a'.repeat(40) };
  acquireAmaCloserLease({ rootDir, ...owner, now: '2026-10-01T12:00:00Z' });
  const { lease: predecessor } = updateAmaCloserLease({ rootDir, ...owner, status: 'dispatched',
    lrqId: 'synthetic-receipt', workerId: 'hammer-ama-pr-17', now: '2026-10-01T12:00:00Z' });
  rmSync(amaCloserLeaseFilePath(rootDir, owner));
  const { lease: replacement } = acquireAmaCloserLease({ rootDir, ...owner, now: '2026-10-01T13:00:00Z' });
  const { lease: changed } = updateAmaCloserLease({ rootDir, ...owner, status: 'terminal',
    terminalOutcome: 'deferred', now: '2026-10-01T13:01:00Z' });
  assert.equal(restoreAmaCloserLeaseIfCurrent(rootDir, predecessor, { expectedLease: replacement }), false);
  assert.deepEqual(readAmaCloserLease(rootDir, owner), changed);
  assert.equal(restoreAmaCloserLeaseIfCurrent(rootDir, predecessor, { expectedLease: changed }), true);
  assert.deepEqual(readAmaCloserLease(rootDir, owner), predecessor);
});

function freshRoot() {
  return mkdtempSync(join(tmpdir(), 'ama-lease-'));
}

const IDENTITY = Object.freeze({
  repo: 'acme/myrepo',
  prNumber: 1234,
  headSha: 'abc12345abc12345abc12345abc12345abc12345',
});

test('review handoff reacquires a handed-to-review lease', t => {
  const rootDir = freshRoot();
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  acquireAmaCloserLease({ rootDir, ...IDENTITY, watcherPid: 4242 });
  updateAmaCloserLease({ rootDir, ...IDENTITY, status: 'handed-to-review' });
  const result = acquireAmaCloserLease({ rootDir, ...IDENTITY, watcherPid: 4243, fromReviewHandoff: true });
  assert.equal(result.acquired, true);
  assert.equal(result.lease.watcherPid, 4243);
  assert.equal(readAmaCloserLease(rootDir, IDENTITY).status, 'pending');
});

// ---------------------------------------------------------------------------
// Test 1 — first acquire on a fresh (repo, pr, head) → acquired:true.
// ---------------------------------------------------------------------------

test('first acquire on fresh PR/head returns acquired:true and writes the lease', () => {
  const rootDir = freshRoot();
  try {
    const r = acquireAmaCloserLease({
      rootDir,
      ...IDENTITY,
      watcherPid: 4242,
      now: '2026-06-11T22:00:00Z',
    });
    assert.equal(r.acquired, true);
    assert.equal(r.lease.status, 'pending');
    assert.equal(r.lease.lrqId, null);
    assert.equal(r.lease.terminalOutcome, null);
    assert.equal(r.lease.watcherPid, 4242);
    assert.equal(r.lease.acquiredAt, '2026-06-11T22:00:00Z');
    assert.equal(r.lease.schemaVersion, 1);
    // File exists on disk; path matches the documented convention.
    const expectedPath = amaCloserLeaseFilePath(rootDir, IDENTITY);
    assert.equal(r.leasePath, expectedPath);
    assert.match(r.leasePath, /\/data\/ama-closer-leases\/acme__myrepo-pr-1234-abc12345abc12345abc12345abc12345abc12345\.json$/);
    assert.ok(existsSync(r.leasePath));
    // Mode is 0640 per SPEC §4.9.
    assert.equal(statSync(r.leasePath).mode & 0o777, 0o640);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Test 2 — second acquire returns acquired:false + existingLease.
// ---------------------------------------------------------------------------

test('second acquire on same head returns acquired:false with the existing lease', () => {
  const rootDir = freshRoot();
  try {
    const first = acquireAmaCloserLease({ rootDir, ...IDENTITY, now: '2026-06-11T22:00:00Z' });
    assert.equal(first.acquired, true);
    const second = acquireAmaCloserLease({ rootDir, ...IDENTITY, now: '2026-06-11T22:01:00Z' });
    assert.equal(second.acquired, false);
    assert.ok(second.existingLease);
    assert.equal(second.existingLease.acquiredAt, '2026-06-11T22:00:00Z');
    assert.equal(second.existingLease.status, 'pending');
    // The lease path is the same canonical path.
    assert.equal(second.leasePath, first.leasePath);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Test 3 — head-change → new lease file; old lease preserved on disk.
// ---------------------------------------------------------------------------

test('head-change creates a fresh lease; the old lease persists for audit', () => {
  const rootDir = freshRoot();
  try {
    const oldHead = 'abc12345abc12345abc12345abc12345abc12345';
    const newHead = 'def67890def67890def67890def67890def67890';
    const a = acquireAmaCloserLease({ rootDir, ...IDENTITY, headSha: oldHead, now: '2026-06-11T22:00:00Z' });
    const b = acquireAmaCloserLease({ rootDir, ...IDENTITY, headSha: newHead, now: '2026-06-11T22:05:00Z' });
    assert.equal(a.acquired, true);
    assert.equal(b.acquired, true);
    // Both files exist on disk.
    assert.ok(existsSync(a.leasePath));
    assert.ok(existsSync(b.leasePath));
    // The lease dir contains exactly two files (one per head).
    const dir = join(rootDir, 'data', 'ama-closer-leases');
    const files = readdirSync(dir).sort();
    assert.equal(files.length, 2);
    assert.match(files[0], /-pr-1234-abc12345/);
    assert.match(files[1], /-pr-1234-def67890/);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Test 4 — restart-after-acquire (no in-memory state) → lease respected.
// ---------------------------------------------------------------------------

test('restart-after-acquire re-reads the lease from disk and respects it', () => {
  const rootDir = freshRoot();
  try {
    acquireAmaCloserLease({ rootDir, ...IDENTITY, now: '2026-06-11T22:00:00Z' });
    // Simulate a watcher restart by re-acquiring with no in-memory state.
    // The acquire reads the lease from disk and respects it.
    const r = acquireAmaCloserLease({ rootDir, ...IDENTITY, now: '2026-06-11T23:00:00Z' });
    assert.equal(r.acquired, false);
    assert.ok(r.existingLease);
    assert.equal(r.existingLease.acquiredAt, '2026-06-11T22:00:00Z');
    // Public read also exposes the same shape.
    const direct = readAmaCloserLease(rootDir, IDENTITY);
    assert.equal(direct.acquiredAt, '2026-06-11T22:00:00Z');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Test 5 — pending → dispatched succeeds and populates lrqId.
// ---------------------------------------------------------------------------

test('updateAmaCloserLease pending → dispatched succeeds and populates lrqId', () => {
  const rootDir = freshRoot();
  try {
    acquireAmaCloserLease({ rootDir, ...IDENTITY, now: '2026-06-11T22:00:00Z' });
    const { lease } = updateAmaCloserLease({
      rootDir,
      ...IDENTITY,
      status: AMA_CLOSER_LEASE_STATUS.DISPATCHED,
      lrqId: 'lrq_test_0001',
      now: '2026-06-11T22:00:30Z',
    });
    assert.equal(lease.status, 'dispatched');
    assert.equal(lease.lrqId, 'lrq_test_0001');
    assert.equal(lease.terminalOutcome, null);
    assert.equal(lease.updatedAt, '2026-06-11T22:00:30Z');
    // Persisted to disk.
    const ondisk = readAmaCloserLease(rootDir, IDENTITY);
    assert.equal(ondisk.status, 'dispatched');
    assert.equal(ondisk.lrqId, 'lrq_test_0001');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('updateAmaCloserLease dispatched without lrqId is rejected', () => {
  const rootDir = freshRoot();
  try {
    acquireAmaCloserLease({ rootDir, ...IDENTITY });
    assert.throws(
      () => updateAmaCloserLease({ rootDir, ...IDENTITY, status: 'dispatched' }),
      /requires lrqId/,
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('lease CAS accepts reordered snapshot keys', t => {
  const rootDir = freshRoot();
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const { lease } = acquireAmaCloserLease({ rootDir, ...IDENTITY, watcherPid: 4242 });
  const expectedLease = Object.fromEntries(Object.entries(lease).reverse());
  const result = updateAmaCloserLease({ rootDir, ...IDENTITY, expectedLease,
    status: 'dispatched', lrqId: 'lrq_reordered' });
  assert.equal(result.lease.status, 'dispatched');
  assert.equal(readAmaCloserLease(rootDir, IDENTITY).lrqId, 'lrq_reordered');
});

test('lease CAS rejects changed, missing and additional snapshot fields without writing', t => {
  const rootDir = freshRoot();
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const { lease, leasePath } = acquireAmaCloserLease({ rootDir, ...IDENTITY, watcherPid: 4242 });
  const before = readFileSync(leasePath, 'utf8');
  const missingField = { ...lease };
  delete missingField.dispatchTimeoutMs;
  for (const expectedLease of [
    { ...lease, watcherPid: 4243 },
    missingField,
    { ...lease, annotation: 'concurrent change' },
    null,
  ]) {
    assert.throws(() => updateAmaCloserLease({ rootDir, ...IDENTITY, expectedLease,
      status: 'dispatched', lrqId: 'lrq_stale' }), { code: 'ESTALE' });
    assert.equal(readFileSync(leasePath, 'utf8'), before);
  }
});

// ---------------------------------------------------------------------------
// Test 6 — dispatched → terminal succeeds and sets terminalOutcome.
// ---------------------------------------------------------------------------

test('updateAmaCloserLease dispatched → terminal succeeds with valid terminalOutcome', () => {
  const rootDir = freshRoot();
  try {
    acquireAmaCloserLease({ rootDir, ...IDENTITY, now: '2026-06-11T22:00:00Z' });
    updateAmaCloserLease({
      rootDir, ...IDENTITY,
      status: 'dispatched', lrqId: 'lrq_test_0001',
      now: '2026-06-11T22:00:30Z',
    });
    const { lease } = updateAmaCloserLease({
      rootDir, ...IDENTITY,
      status: AMA_CLOSER_LEASE_STATUS.TERMINAL, terminalOutcome: 'succeeded',
      now: '2026-06-11T22:01:00Z',
    });
    assert.equal(lease.status, 'terminal');
    assert.equal(lease.terminalOutcome, 'succeeded');
    assert.equal(lease.updatedAt, '2026-06-11T22:01:00Z');
    // lrqId is preserved from the dispatched state.
    assert.equal(lease.lrqId, 'lrq_test_0001');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('updateAmaCloserLease terminal with invalid outcome is rejected', () => {
  const rootDir = freshRoot();
  try {
    acquireAmaCloserLease({ rootDir, ...IDENTITY });
    updateAmaCloserLease({ rootDir, ...IDENTITY, status: 'dispatched', lrqId: 'lrq_x' });
    assert.throws(
      () => updateAmaCloserLease({
        rootDir, ...IDENTITY, status: 'terminal', terminalOutcome: 'maybe-merged',
      }),
      /requires terminalOutcome/,
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Test 7 — terminal → pending (or any non-terminal) is refused.
// ---------------------------------------------------------------------------

test('updateAmaCloserLease refuses to demote a terminal lease', () => {
  const rootDir = freshRoot();
  try {
    acquireAmaCloserLease({ rootDir, ...IDENTITY });
    updateAmaCloserLease({ rootDir, ...IDENTITY, status: 'dispatched', lrqId: 'lrq_x' });
    updateAmaCloserLease({
      rootDir, ...IDENTITY, status: 'terminal', terminalOutcome: 'succeeded',
    });
    assert.throws(
      () => updateAmaCloserLease({
        rootDir, ...IDENTITY, status: 'pending',
      }),
      /refusing to demote terminal lease/,
    );
    assert.throws(
      () => updateAmaCloserLease({
        rootDir, ...IDENTITY, status: 'dispatched', lrqId: 'lrq_y',
      }),
      /refusing to demote terminal lease/,
    );
    // The on-disk lease stayed terminal — the writer's refusal didn't
    // partially mutate.
    const ondisk = readAmaCloserLease(rootDir, IDENTITY);
    assert.equal(ondisk.status, 'terminal');
    assert.equal(ondisk.terminalOutcome, 'succeeded');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('updateAmaCloserLease refuses to revert dispatched lease to pending', () => {
  const rootDir = freshRoot();
  try {
    acquireAmaCloserLease({ rootDir, ...IDENTITY });
    updateAmaCloserLease({ rootDir, ...IDENTITY, status: 'dispatched', lrqId: 'lrq_x' });
    assert.throws(
      () => updateAmaCloserLease({ rootDir, ...IDENTITY, status: 'pending' }),
      /refusing to revert dispatched lease back to pending/,
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Test 8 — concurrent acquire race: exactly one wins.
// ---------------------------------------------------------------------------

test('two concurrent acquires (race) → exactly one returns acquired:true', () => {
  // Promise.all-style race; the underlying writeFileAtomic uses
  // linkSync(tmp, finalPath) which throws EEXIST on collision. Exactly
  // one acquirer wins regardless of OS scheduling.
  const rootDir = freshRoot();
  try {
    const N = 16;
    const results = [];
    for (let i = 0; i < N; i += 1) {
      results.push(acquireAmaCloserLease({
        rootDir, ...IDENTITY,
        watcherPid: i,
        now: `2026-06-11T22:00:${String(i).padStart(2, '0')}Z`,
      }));
    }
    const winners = results.filter((r) => r.acquired === true);
    const losers = results.filter((r) => r.acquired === false);
    assert.equal(winners.length, 1, `exactly one acquire must win; got ${winners.length}`);
    assert.equal(losers.length, N - 1, `all others must lose; got ${losers.length}`);
    // Every loser's existingLease is the same on-disk lease.
    const winnerLease = winners[0].lease;
    for (const l of losers) {
      assert.equal(l.existingLease.acquiredAt, winnerLease.acquiredAt);
      assert.equal(l.existingLease.watcherPid, winnerLease.watcherPid);
    }
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Defensive: updateAmaCloserLease throws when no lease exists.
// ---------------------------------------------------------------------------

test('updateAmaCloserLease throws when no lease exists yet', () => {
  const rootDir = freshRoot();
  try {
    assert.throws(
      () => updateAmaCloserLease({
        rootDir, ...IDENTITY, status: 'dispatched', lrqId: 'lrq_x',
      }),
      /no lease at .* — call acquireAmaCloserLease first/,
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// CLR-02 — the lease records the acquiring HOST alongside the pid.
//
// Recovery is allowed to reclaim a lease early only when its holder is provably
// dead, and `watcherPid` alone cannot support that claim: a pid probed on host B
// says nothing about a process on host A. Without `holderHost` the reaper has to
// fall back to the 6h floor for every lease, which is the state that let 11 of 11
// dead-held leases sit unreclaimed (SEV 2026-08-26).
// ---------------------------------------------------------------------------

test('acquire records the holder host so recovery can trust a local liveness probe', () => {
  const rootDir = freshRoot();
  try {
    const r = acquireAmaCloserLease({
      rootDir,
      ...IDENTITY,
      watcherPid: 4242,
      now: '2026-08-26T22:00:00Z',
    });
    assert.equal(r.lease.holderHost, hostname(), 'defaults to this host');
    assert.equal(readAmaCloserLease(rootDir, IDENTITY).holderHost, hostname(), 'and is durable');

    // Preserved across every state transition — a lease that loses its holder
    // identity mid-flight would silently drop back to the 6h floor.
    updateAmaCloserLease({
      rootDir, ...IDENTITY, status: AMA_CLOSER_LEASE_STATUS.DISPATCHED, lrqId: 'lrq_1',
      now: '2026-08-26T22:01:00Z',
    });
    assert.equal(readAmaCloserLease(rootDir, IDENTITY).holderHost, hostname());
    updateAmaCloserLease({
      rootDir, ...IDENTITY, status: AMA_CLOSER_LEASE_STATUS.TERMINAL, terminalOutcome: 'succeeded',
      now: '2026-08-26T22:02:00Z',
    });
    assert.equal(readAmaCloserLease(rootDir, IDENTITY).holderHost, hostname());
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('acquire accepts an explicit holder host so cross-host tests stay deterministic', () => {
  const rootDir = freshRoot();
  try {
    const r = acquireAmaCloserLease({
      rootDir, ...IDENTITY, watcherPid: 4242, host: 'some-other-host',
      now: '2026-08-26T22:00:00Z',
    });
    assert.equal(r.lease.holderHost, 'some-other-host');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});


test('CLOSERLEASEDEAD-01 bounds uncertain ownership and checks holder identity', () => {
  const acquiredAt = '2026-01-01T00:00:00Z';
  const lease = { status: 'pending', lrqId: null, holderHost: 'fixture-host',
    watcherPid: 4242, acquiredAt, dispatchTimeoutMs: 60_000 };
  const opts = { host: 'fixture-host', livePid: 4343, now: Date.parse(acquiredAt) + 30_000,
    isProcessAlive: () => true,
    captureProcessImpl: () => ({ startedAt: '2025-12-31T23:59:00Z' }) };
  assert.equal(abandonedAmaCloserLeaseOutcome(lease, opts), null);
  assert.equal(abandonedAmaCloserLeaseOutcome(lease, { ...opts, isProcessAlive: () => false }), 'abandoned-holder-dead');
  assert.equal(abandonedAmaCloserLeaseOutcome(lease, { ...opts,
    captureProcessImpl: () => ({ startedAt: '2026-01-01T00:00:01Z' }) }), 'abandoned-holder-dead');
  for (const isProcessAlive of [() => null, () => { throw Error('unreadable'); }]) {
    assert.equal(abandonedAmaCloserLeaseOutcome(lease, { ...opts, isProcessAlive }), null);
    assert.equal(abandonedAmaCloserLeaseOutcome(lease, { ...opts, isProcessAlive,
      now: Date.parse(acquiredAt) + 60_000 }), null);
    assert.equal(abandonedAmaCloserLeaseOutcome(lease, { ...opts, isProcessAlive,
      now: Date.parse(acquiredAt) + 60_001 }), null, 'unknown local identity cannot expire by age');
  }
  const expired = { ...opts, now: Date.parse(acquiredAt) + 60_001,
    isProcessAlive: () => assert.fail('no process probe required') };
  for (const changed of [{ status: 'handed-to-review' }, { status: 'dispatched', lrqId: 'lrq_live' },
    { lrqId: 'lrq_live' }, { watcherPid: opts.livePid }]) {
    assert.equal(abandonedAmaCloserLeaseOutcome({ ...lease, ...changed }, expired), null);
  }
  assert.equal(abandonedAmaCloserLeaseOutcome({ ...lease, holderHost: 'remote-fixture' }, expired), 'abandoned-timeout');
});


test('CLAIMPIDSTALE-01 hostless lease abandonment agrees with local ownership', () => {
  const acquiredAt = '2026-01-01T00:00:00Z';
  const lease = { status: 'pending', lrqId: null, watcherPid: 4242,
    acquiredAt, dispatchTimeoutMs: 120_000 };
  const opts = { now: Date.parse(acquiredAt) + 1_000, host: 'fixture-host', livePid: 4343,
    captureProcessImpl: () => ({ startedAt: '2025-12-31T23:59:00Z' }) };
  for (const holderHost of [undefined, null, '']) {
    const legacy = { ...lease, holderHost };
    assert.equal(abandonedAmaCloserLeaseOutcome(legacy, { ...opts,
      isProcessAlive: () => false }), 'abandoned-holder-dead');
    for (const isProcessAlive of [() => true, () => null, () => { throw Error('unreadable'); }]) {
      assert.equal(abandonedAmaCloserLeaseOutcome(legacy, { ...opts, isProcessAlive }), null);
    }
    const noProbe = () => assert.fail('current processes and launch owners must not be probed');
    for (const changed of [{ watcherPid: opts.livePid }, { lrqId: 'lrq_fixture' }]) {
      assert.equal(abandonedAmaCloserLeaseOutcome({ ...legacy, ...changed }, {
        ...opts, isProcessAlive: noProbe, captureProcessImpl: noProbe }), null);
    }
  }
  assert.equal(abandonedAmaCloserLeaseOutcome({ ...lease, holderHost: 'foreign-fixture' }, {
    ...opts, isProcessAlive: () => assert.fail('foreign PIDs must not be probed') }), null);
});

test('DEADWATCHERLEASE-01 exact process identity survives acquisition and prevents PID reuse custody', t => {
  const rootDir = freshRoot();
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const startedAt = '2025-12-31T23:58:00Z';
  const lease = acquireAmaCloserLease({ rootDir, repo: 'fixture/project', prNumber: 77,
    headSha: 'a'.repeat(40), watcherPid: 4242, now: '2026-01-01T00:00:00Z',
    dispatchTimeoutMs: 60_000, captureProcessImpl: () => ({ pid: 4242, startedAt }) }).lease;
  assert.equal(lease.watcherStartedAt, startedAt);
  const options = { now: Date.parse(lease.acquiredAt) + 60_001, livePid: 4343,
    isProcessAlive: () => true, captureProcessImpl: () => ({ startedAt }) };
  assert.equal(abandonedAmaCloserLeaseOutcome(lease, options), null, 'expired live owner retains custody');
  assert.equal(abandonedAmaCloserLeaseOutcome(lease, { ...options,
    isProcessAlive: () => false }), 'abandoned-holder-dead');
  // Both processes predate acquisition: comparing only acquiredAt misses reuse.
  assert.equal(abandonedAmaCloserLeaseOutcome(lease, { ...options,
    captureProcessImpl: () => ({ startedAt: '2025-12-31T23:59:00Z' }) }), 'abandoned-holder-dead');
  assert.equal(abandonedAmaCloserLeaseOutcome(lease, { ...options,
    captureProcessImpl: () => { throw Error('unreadable'); } }), null);
  assert.equal(abandonedAmaCloserLeaseOutcome(lease, { ...options, livePid: lease.watcherPid,
    captureProcessImpl: () => ({ startedAt: '2025-12-31T23:59:00Z' }) }), 'abandoned-holder-dead',
  'a restarted watcher reusing the PID cannot adopt its predecessor by PID alone');
});

test('DEADWATCHERLEASE-01 acquisition tolerates missing PIDs and failed identity capture', t => {
  const rootDir = freshRoot();
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  for (const watcherPid of [undefined, null, 0, -1, 1.5, NaN, 'invalid', 4242]) {
    const captured = [];
    const result = acquireAmaCloserLease({ rootDir, ...IDENTITY,
      headSha: `pid-${String(watcherPid)}`, watcherPid, captureProcessImpl: pid => {
        captured.push(pid);
        throw Error('transient capture failure');
      } });
    assert.deepEqual(captured, watcherPid === 4242 ? [4242] : [],
      'only positive integer PIDs reach process capture');
    assert.equal(result.acquired, true);
    assert.equal(result.lease.watcherStartedAt, null);
    assert.equal(result.lease.watcherPid, watcherPid === 4242 ? 4242 : null);
    assert.equal(readAmaCloserLease(rootDir, result.lease).watcherStartedAt, null);
  }
  const captured = [];
  const foreign = acquireAmaCloserLease({ rootDir, ...IDENTITY, watcherPid: 4242,
    host: 'foreign-fixture-host', captureProcessImpl: pid => captured.push(pid) });
  assert.equal(foreign.acquired, true);
  assert.equal(foreign.lease.watcherStartedAt, null);
  assert.deepEqual(captured, [], 'foreign PIDs must not be inspected locally');
});

test('DEADWATCHERLEASE-01 legacy CAS treats missing and null identity equally but rejects replacement identities', t => {
  const rootDir = freshRoot();
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  for (const omittedOnDisk of [true, false]) {
    const { lease, leasePath } = acquireAmaCloserLease({ rootDir, ...IDENTITY });
    const expected = { ...lease };
    if (omittedOnDisk) {
      delete lease.watcherStartedAt;
      writeFileSync(leasePath, JSON.stringify(lease));
    } else {
      delete expected.watcherStartedAt;
    }
    assert.equal(isCurrentAmaCloserLease(rootDir, expected), true);
    assert.equal(deleteAmaCloserLeaseIfCurrent(rootDir, {
      ...expected, watcherStartedAt: '2026-01-01T00:00:00Z',
    }), false, 'a different process identity must still defeat deletion');
    assert.equal(deleteAmaCloserLeaseIfCurrent(rootDir, expected), true);
  }
});

test('DEADWATCHERLEASE-01 pending reclaim checks identity before raw PID liveness', () => {
  const lease = { status: 'pending', lrqId: null, watcherPid: 4242,
    holderHost: hostname(), acquiredAt: '2026-01-01T00:00:00Z',
    watcherStartedAt: '2025-12-31T23:58:00Z' };
  for (const dispatchTimeoutMs of [null, 60_000]) {
    for (const reused of [false, true]) {
      assert.equal(isReclaimablePendingAmaCloserLease({ ...lease, dispatchTimeoutMs }, {
        now: '2026-01-02T00:00:00Z', processKillImpl: () => {},
        captureProcessImpl: () => ({ startedAt: reused
          ? '2025-12-31T23:59:00Z' : lease.watcherStartedAt }),
      }), reused, 'matching owners retain custody; verified reused PIDs are reclaimed');
    }
  }
});

test('DEADWATCHERLEASE-01 orphan ownership rejects a pending lease with reused process identity', async t => {
  const rootDir = freshRoot();
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const identity = { rootDir, repo: 'fixture/project', prNumber: 78, headSha: 'b'.repeat(40) };
  const acquiredAt = '2026-01-01T00:00:00Z';
  acquireAmaCloserLease({ ...identity, watcherPid: 4242, now: acquiredAt,
    dispatchTimeoutMs: 60_000, captureProcessImpl: () => ({ startedAt: '2025-12-31T23:58:00Z' }) });
  for (const reused of [false, true]) {
    const result = await probeOrphanOwnership({ ...identity, now: '2026-01-01T00:00:01Z',
      processKillImpl: () => {},
      captureProcessImpl: () => ({ startedAt: reused ? '2025-12-31T23:59:00Z' : '2025-12-31T23:58:00Z' }),
      readStatusImpl: async () => assert.fail('no receipt exists'), env: {}, logger: { warn() {} } });
    assert.equal(result.owned, !reused);
    if (!reused) assert.equal(result.proof, 'pending-closer-lease');
  }
});

test('CLOSERLEASEDEAD-01 a replacement launch installed during the identity probe is preserved', async t => {
  const rootDir = freshRoot();
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const now = '2026-01-01T00:00:00Z';
  const identity = { rootDir, repo: 'fixture/project', prNumber: 7, headSha: 'a'.repeat(40) };
  const lease = acquireAmaCloserLease({ ...identity, now, host: 'fixture-host', watcherPid: 4242,
    dispatchTimeoutMs: 120_000 }).lease;
  const abandoned = await abandonAmaCloserLease(rootDir, lease, { now, host: 'fixture-host', livePid: 4343,
    isProcessAlive: () => true, captureProcessImpl: () => {
      updateAmaCloserLease({ ...identity, status: 'dispatched', lrqId: 'lrq_replacement', now });
      return { startedAt: '2026-01-01T00:00:01Z' };
    } });
  assert.equal(abandoned, null);
  assert.equal(readAmaCloserLease(rootDir, identity).lrqId, 'lrq_replacement');
  assert.equal(readAmaCloserLease(rootDir, identity).status, 'dispatched');
});

for (const rekeyed of [false, true]) test(`CLOSERINTENTRECON-01 age-only abandonment defers to intent proof, rekeyed=${rekeyed}`, async t => {
  const rootDir = freshRoot();
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const f = seedCloserIntent(rootDir, { repo: 'fixture/project', prNumber: 17, headSha: 'a'.repeat(40) },
    { rekeyedHead: rekeyed ? 'b'.repeat(40) : null });
  const before = f.lease();
  assert.equal(await abandonAmaCloserLease(rootDir, before, { ...f.options, now: intentExpired, readIntentReceiptImpl: () => ({ ok: false }), isProcessAlive: () => false,
    logger: { warn() {} } }), null);
  assert.deepEqual(f.lease(), before);
  assert.equal(f.record().state, 'dispatching');
});

const identity = { repo: 'fixture/repo', prNumber: 21, headSha: 'a'.repeat(40) };
const launchRequestId = 'synthetic-closer';
const now = '2026-10-27T00:00:00Z';
function fixture(t) {
  const rootDir = freshRoot();
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  acquireAmaCloserLease({ rootDir, ...identity, now });
  updateAmaCloserLease({ rootDir, ...identity, now, status: 'dispatched', lrqId: launchRequestId });
  return rootDir;
}

test('closure recovery observes a dispatched outcome before abandonment and returns its fresh receipt', async t => {
  const rootDir = fixture(t);
  let calls = 0;
  const result = await reconcileAndAbandonAmaCloserLease(rootDir, readAmaCloserLease(rootDir, identity), {
    now: '2026-10-28T00:00:00Z',
    reconcileDispatched: async lease => {
      calls++;
      assert.equal(lease.status, 'dispatched');
      assert.equal(readAmaCloserLease(rootDir, identity).status, 'dispatched');
      updateAmaCloserLease({ rootDir, ...identity, status: 'terminal', terminalOutcome: 'succeeded', now });
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.terminalOutcome, 'succeeded');
  assert.deepEqual(result, readAmaCloserLease(rootDir, identity));
});

test('closure recovery does not abandon ownership when dispatched reconciliation fails', async t => {
  const rootDir = fixture(t);
  const before = readAmaCloserLease(rootDir, identity);
  await assert.rejects(reconcileAndAbandonAmaCloserLease(rootDir, before, {
    now: '2026-10-28T00:00:00Z',
    reconcileDispatched: async () => { throw new Error('ledger unavailable'); },
  }), /ledger unavailable/);
  assert.deepEqual(readAmaCloserLease(rootDir, identity), before);
});

for (const scenario of ['receipt', 'absent', 'unreadable']) {
  test(`closure recovery re-reads intent settlement before launch observation: ${scenario}`, async t => {
    const rootDir = freshRoot();
    t.after(() => rmSync(rootDir, { recursive: true, force: true }));
    const f = seedCloserIntent(rootDir, identity, { scenario });
    const before = f.lease();
    let calls = 0;
    const result = await reconcileAndAbandonAmaCloserLease(rootDir, before, {
      ...f.options, now: intentExpired, logger: { warn() {} },
      reconcileDispatched: async lease => {
        calls++;
        assert.equal(lease.lrqId, f.receipt.launch_request_id);
        assert.equal(lease.status, 'dispatched');
      },
    });
    assert.equal(f.reads(), 1, 'intent evidence is queried once');
    assert.equal(calls, scenario === 'receipt' ? 1 : 0);
    assert.deepEqual(result, f.lease());
    if (scenario === 'absent') assert.equal(result.terminalOutcome, 'deferred');
    if (scenario === 'unreadable') assert.deepEqual(result, before);
  });
}

for (const reason of ['lane-busy', 'merge-lease-timeout', 'required-checks-pending', 'pr-mergeability-unknown']) {
  test(`HAMLANEWAIT-02: ${reason} records one released terminal receipt`, t => {
    const rootDir = fixture(t), args = { rootDir, ...identity, launchRequestId,
      attempt: { outcome: 'deferred', reason }, now };
    assert.equal(releaseRetryableAmaCloserLease(args), true);
    const receipt = readAmaCloserLease(rootDir, identity);
    assert.equal(receipt.status, 'terminal');
    assert.equal(receipt.terminalOutcome, `retryable-${reason}`);
    assert.equal(releaseRetryableAmaCloserLease({ ...args, now: '2026-10-27T01:00:00Z' }), true);
    assert.deepEqual(readAmaCloserLease(rootDir, identity), receipt);
  });
}

test('HAMLANEWAIT-02: release preserves successor, review handoff and in-run lease retry', t => {
  const rootDir = fixture(t), args = { rootDir, ...identity, launchRequestId,
    attempt: { outcome: 'deferred', reason: 'lane-busy' }, now };
  assert.equal(releaseRetryableAmaCloserLease({ ...args, launchRequestId: 'old-worker' }), false);
  assert.equal(releaseRetryableAmaCloserLease({ ...args, attempt: { ...args.attempt, inRunRetry: true } }), false);
  assert.equal(readAmaCloserLease(rootDir, identity).status, 'dispatched');
  updateAmaCloserLease({ rootDir, ...identity, status: 'handed-to-review', now });
  assert.equal(releaseRetryableAmaCloserLease(args), false);
  assert.equal(readAmaCloserLease(rootDir, identity).status, 'handed-to-review');
});

test('HAMLANEWAIT-02: release follows the matching rekeyed launch', t => {
  const rootDir = fixture(t), moved = { ...identity, headSha: 'b'.repeat(40) };
  rekeyAmaCloserLease({ rootDir, ...identity, fromHeadSha: identity.headSha, toHeadSha: moved.headSha });
  assert.equal(releaseRetryableAmaCloserLease({ rootDir, ...identity, launchRequestId,
    attempt: { outcome: 'deferred', reason: 'lane-busy' }, now }), true);
  assert.equal(readAmaCloserLease(rootDir, moved).terminalOutcome, 'retryable-lane-busy');
});


test('HAMLANEWAIT-02: original-head release cannot retire a successor at the published head', t => {
  const rootDir = fixture(t), moved = { ...identity, headSha: 'c'.repeat(40) };
  acquireAmaCloserLease({ rootDir, ...moved, now });
  updateAmaCloserLease({ rootDir, ...moved, status: 'dispatched', lrqId: 'successor', now });
  const successor = readAmaCloserLease(rootDir, moved);
  assert.equal(releaseRetryableAmaCloserLease({ rootDir, ...moved,
    sourceHeadSha: identity.headSha, launchRequestId,
    attempt: { outcome: 'deferred', reason: 'lane-busy' }, now }), true);
  assert.equal(readAmaCloserLease(rootDir, identity).terminalOutcome, 'retryable-lane-busy');
  assert.deepEqual(readAmaCloserLease(rootDir, moved), successor);
});
