import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  recordRuntimeRun,
  readRuntimeRuns,
  summarizeRuntimeRuns,
  monthStampsInWindow,
  runLedgerDir,
  wrapRuntimeWithRunLedger,
} from '../src/adapters/agent-runtime/run-ledger.mjs';

function tmpRoot() {
  return mkdtempSync(join(tmpdir(), 'run-ledger-'));
}

test('records runs and summarizes 24h counts by mode', () => {
  const rootDir = tmpRoot();
  try {
    const nowIso = '2026-07-17T12:00:00.000Z';
    const now = () => new Date(nowIso);
    // Within the 24h window.
    recordRuntimeRun(rootDir, { at: '2026-07-17T09:00:00.000Z', mode: 'os', status: 'completed', domainId: 'code-pr', kind: 'reviewer' });
    recordRuntimeRun(rootDir, { at: '2026-07-17T10:00:00.000Z', mode: 'os', status: 'completed' });
    recordRuntimeRun(rootDir, { at: '2026-07-17T11:00:00.000Z', mode: 'local', status: 'failed' });
    // Outside the 24h window (previous day) — must be excluded.
    recordRuntimeRun(rootDir, { at: '2026-07-16T09:00:00.000Z', mode: 'os', status: 'completed' });

    const summary = summarizeRuntimeRuns(rootDir, { now });
    assert.equal(summary.os, 2);
    assert.equal(summary.local, 1);
    assert.equal(summary.total, 3);
    assert.equal(summary.byStatus.completed, 2);
    assert.equal(summary.byStatus.failed, 1);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('normalizes an unknown mode rather than miscounting it as os/local', () => {
  const rootDir = tmpRoot();
  try {
    const now = () => new Date('2026-07-17T12:00:00.000Z');
    recordRuntimeRun(rootDir, { at: '2026-07-17T10:00:00.000Z', mode: 'bogus', status: 'completed' });
    const summary = summarizeRuntimeRuns(rootDir, { now });
    assert.equal(summary.os, 0);
    assert.equal(summary.local, 0);
    assert.equal(summary.unknown, 1);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('reads across a month boundary within the window', () => {
  const rootDir = tmpRoot();
  try {
    const now = () => new Date('2026-08-01T06:00:00.000Z');
    recordRuntimeRun(rootDir, { at: '2026-07-31T23:00:00.000Z', mode: 'os', status: 'completed' });
    recordRuntimeRun(rootDir, { at: '2026-08-01T01:00:00.000Z', mode: 'local', status: 'completed' });
    const rows = readRuntimeRuns(rootDir, { now });
    assert.equal(rows.length, 2, 'both the July and August rows fall in the 24h window');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('monthStampsInWindow spans the covered months', () => {
  const since = Date.parse('2026-07-31T23:00:00.000Z');
  const now = Date.parse('2026-08-01T06:00:00.000Z');
  assert.deepEqual(monthStampsInWindow(since, now), ['2026-07', '2026-08']);
});

test('a torn final line does not break the read', () => {
  const rootDir = tmpRoot();
  try {
    const now = () => new Date('2026-07-17T12:00:00.000Z');
    const { path } = recordRuntimeRun(rootDir, { at: '2026-07-17T10:00:00.000Z', mode: 'os', status: 'completed' });
    // Simulate a crash mid-append: a partial JSON line with no trailing newline.
    appendFileSync(path, '{"schema_version":1,"at":"2026-07-17T11:00:00.000Z","mode":"local"');
    const rows = readRuntimeRuns(rootDir, { now });
    assert.equal(rows.length, 1, 'the intact row reads; the torn line is skipped');
    assert.equal(rows[0].mode, 'os');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('wrapRuntimeWithRunLedger records a run on await settle', async () => {
  const rootDir = tmpRoot();
  try {
    const now = () => new Date('2026-07-17T12:00:00.000Z');
    const inner = {
      async run(request) {
        return {
          runRef: request.idempotencyKey,
          mode: 'local',
          async await() { return { status: 'completed', runtimeMode: 'local', artifact: { kind: 'review' } }; },
          async cancel() {},
          async reattach() { return { status: 'completed', runtimeMode: 'local' }; },
        };
      },
      describe() { return { id: 'inner', mode: 'local' }; },
    };
    const wrapped = wrapRuntimeWithRunLedger(inner, { rootDir, domainId: 'code-pr', now });
    const handle = await wrapped.run({ idempotencyKey: 'k1' });
    const result = await handle.await();
    assert.equal(result.status, 'completed');
    // Awaiting twice must not double-record.
    await handle.await();

    const rows = readRuntimeRuns(rootDir, { now });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].mode, 'local');
    assert.equal(rows[0].kind, 'review');
    assert.equal(rows[0].idempotency_key, 'k1');
    assert.ok(existsSync(runLedgerDir(rootDir)));
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('wrapRuntimeWithRunLedger records a runtime-level reattach on settle', async () => {
  const rootDir = tmpRoot();
  try {
    const now = () => new Date('2026-07-17T12:00:00.000Z');
    const inner = {
      async run() { throw new Error('not used'); },
      async reattach(request) {
        assert.equal(request.idempotencyKey, 'adopted-k1');
        return { status: 'completed', runtimeMode: 'os', artifact: { kind: 'review' } };
      },
    };
    const wrapped = wrapRuntimeWithRunLedger(inner, { rootDir, domainId: 'code-pr', now });
    const result = await wrapped.reattach({ idempotencyKey: 'adopted-k1' });
    assert.equal(result.status, 'completed');

    const rows = readRuntimeRuns(rootDir, { now });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].mode, 'os');
    assert.equal(rows[0].kind, 'review');
    assert.equal(rows[0].idempotency_key, 'adopted-k1');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('a ledger write failure never fails the underlying run', async () => {
  const rootDir = tmpRoot();
  try {
    const inner = {
      async run() {
        return {
          runRef: 'k1',
          mode: 'os',
          async await() { return { status: 'completed', runtimeMode: 'os' }; },
          async cancel() {},
          async reattach() { return { status: 'completed', runtimeMode: 'os' }; },
        };
      },
    };
    const wrapped = wrapRuntimeWithRunLedger(inner, {
      rootDir,
      recordImpl: () => { throw new Error('disk full'); },
      logger: { warn() {} },
    });
    const handle = await wrapped.run({ idempotencyKey: 'k1' });
    const result = await handle.await();
    assert.equal(result.status, 'completed', 'run result survives a ledger write failure');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});
