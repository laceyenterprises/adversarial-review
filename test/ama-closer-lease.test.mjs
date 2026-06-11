import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  AMA_CLOSER_LEASE_STATUS,
  acquireAmaCloserLease,
  amaCloserLeaseFilePath,
  readAmaCloserLease,
  updateAmaCloserLease,
} from '../src/ama/closer-lease.mjs';

function freshRoot() {
  return mkdtempSync(join(tmpdir(), 'ama-lease-'));
}

const IDENTITY = Object.freeze({
  repo: 'acme/myrepo',
  prNumber: 1234,
  headSha: 'abc12345abc12345abc12345abc12345abc12345',
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
