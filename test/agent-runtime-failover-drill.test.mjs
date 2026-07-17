import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runFailoverDrill } from '../src/adapters/agent-runtime/failover-drill.mjs';
import { routerAuditDir } from '../src/adapters/agent-runtime/router/audit.mjs';
import { readRuntimeStatusSnapshot } from '../src/runtime-status-snapshot.mjs';

function tmpRoot() {
  return mkdtempSync(join(tmpdir(), 'failover-drill-'));
}

test('the drill exercises the full kill -> failover -> restore -> resume cycle and every phase passes', async () => {
  const rootDir = tmpRoot();
  try {
    const now = () => new Date('2026-07-17T09:12:04.000Z');
    const report = await runFailoverDrill({ rootDir, now });

    assert.equal(report.ok, true, `expected the drill to pass; phases: ${JSON.stringify(report.phases)}`);
    const phaseNames = report.phases.map((p) => p.name);
    assert.deepEqual(phaseNames, [
      'healthy-dispatch',
      'kill-os-and-failover',
      'local-serves-during-outage',
      'restore-and-resume',
      'reconcile-zero-duplicate',
      'fresh-dispatch-after-resume',
    ]);
    assert.ok(report.phases.every((p) => p.ok), 'every phase passes');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('resume reconciles the pre-failover dispatch with ZERO duplicates', async () => {
  const rootDir = tmpRoot();
  try {
    const report = await runFailoverDrill({ rootDir });
    const m = report.metrics;
    assert.equal(m.adopted, 1, 'the one pre-failover key is adopted on resume');
    assert.equal(m.duplicated, 0, 'no dispatch is duplicated on resume');
    // Two distinct OS dispatches ever: the pre-failover key and the fresh
    // post-resume key. The adopted key is never re-dispatched.
    assert.equal(m.distinctOsKeysDispatched, 2);
    assert.equal(m.osDispatchCount, 2);
    assert.equal(m.localRunCount, 1, 'exactly one run was served locally during the outage');
    assert.deepEqual(m.transitions, ['failover', 'resume-start', 'resume-complete']);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('the drill leaves a real audit trail and a status snapshot behind', async () => {
  const rootDir = tmpRoot();
  try {
    const report = await runFailoverDrill({ rootDir, now: () => new Date('2026-07-17T09:12:04.000Z') });
    assert.equal(report.snapshotWritten, true);

    // Audit rows were written to disk by the real audit sink.
    assert.ok(existsSync(routerAuditDir(rootDir)), 'audit dir exists');
    const snapshot = readRuntimeStatusSnapshot(rootDir);
    assert.ok(snapshot, 'a status snapshot was persisted');
    assert.equal(snapshot.status.mode, 'os', 'the drill ends resumed on OS');
    assert.equal(snapshot.status.reconciled.adopted, 1);
    assert.equal(snapshot.status.reconciled.duplicated, 0);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('the drill never pages the operator (notices are swallowed in the sandbox)', async () => {
  // A failing/side-effecting deliverAlert would throw or hang on a network call;
  // the drill wires a no-op notice sink, so completing at all proves no page.
  const rootDir = tmpRoot();
  try {
    const report = await runFailoverDrill({ rootDir });
    assert.equal(report.ok, true);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});
