import './helpers/load-aware-timeout-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireAmaCloserLease, updateAmaCloserLease, readAmaCloserLease } from '../src/ama/closer-lease.mjs';
import { writeAmaAuditEntry } from '../src/ama/audit.mjs';
import { updateAmaCloserDispatchRecord } from '../src/ama/dispatch-closer.mjs';
import { reapStaleCloserLeases } from '../src/recovery-reaper.mjs';
import { probeOrphanOwnership } from '../src/ama/orphan-watchdog.mjs';

const identity = { repo: 'fixture/repo', prNumber: 21, headSha: 'a'.repeat(40) };
const launchRequestId = 'synthetic-closer';
const now = '2026-10-27T00:00:00Z';
function fixture(t) {
  const rootDir = mkdtempSync(join(tmpdir(), 'hamlanewait-02-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  acquireAmaCloserLease({ rootDir, ...identity, now });
  updateAmaCloserLease({ rootDir, ...identity, now, status: 'dispatched', lrqId: launchRequestId });
  return rootDir;
}

for (const status of ['succeeded', 'running']) {
  test(`HAMLANEWAIT-02: orphan watchdog probes ${status} lease even without a dispatch record`, async t => {
    const rootDir = fixture(t);
    const owner = await probeOrphanOwnership({ rootDir, ...identity, env: {}, now,
      readStatusImpl: async () => ({ ok: true, row: { status } }) });
    assert.equal(owner.owned, status === 'running');
    assert.equal(owner.uncertain, false);
  });
}

for (const status of ['succeeded', 'running']) {
  test(`HAMLANEWAIT-02: next reaper sweep settles ${status} launch only when terminal`, async t => {
    const rootDir = fixture(t), hqRoot = join(rootDir, 'hq');
    updateAmaCloserDispatchRecord(rootDir, identity, () => ({ ...identity, state: 'dispatched',
      launchRequestId, dispatchedAt: now }));
    writeAmaAuditEntry({ hqRoot, ...identity, now,
      attempt: { outcome: 'deferred', reason: 'lane-busy', launchRequestId } });
    const result = await reapStaleCloserLeases({ rootDir, now, env: { HQ_ROOT: hqRoot },
      readLaunchRequestStatusImpl: async () => ({ ok: true, row: { status } }),
      closerLeaseReconciliationOptions: {
        readMergedSignalImpl: async () => assert.fail('no remote merge read needed for recorded deferral'),
      }, logger: { warn() {}, info() {} } });
    assert.equal(result.released, status === 'succeeded' ? 1 : 0);
    const receipt = readAmaCloserLease(rootDir, identity);
    assert.equal(receipt.status, status === 'succeeded' ? 'terminal' : 'dispatched');
    assert.equal(receipt.terminalOutcome, status === 'succeeded' ? 'retryable-lane-busy' : null);
  });
}
