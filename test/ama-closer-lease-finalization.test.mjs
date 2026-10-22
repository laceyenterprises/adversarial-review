import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { finalizeAmaCloserLeaseBestEffort } from '../src/ama/dispatch-closer.mjs';
import { acquireAmaCloserLease, readAmaCloserLease, updateAmaCloserLease } from '../src/ama/closer-lease.mjs';
import { digest, stateProjection } from './helpers/smv-contracts.mjs';

for (const replacement of [false, true]) {
  test(`superseded finalization succeeds with ${replacement ? 'a replacement' : 'no'} lease`, t => {
    const rootDir = mkdtempSync(join(tmpdir(), 'ama-finalize-'));
    t.after(() => rmSync(rootDir, { recursive: true, force: true }));
    const leaseIdentity = { repo: 'fixture/repo', prNumber: 1, headSha: 'a'.repeat(40) };
    const now = '2026-10-21T00:00:00Z';
    if (replacement) {
      acquireAmaCloserLease({ rootDir, ...leaseIdentity, now });
      updateAmaCloserLease({ rootDir, ...leaseIdentity, now, status: 'dispatched', lrqId: 'successor' });
    }
    const before = readAmaCloserLease(rootDir, leaseIdentity);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      assert.equal(finalizeAmaCloserLeaseBestEffort({
        rootDir, leaseIdentity, terminalOutcome: 'superseded', launchRequestId: 'predecessor', now,
      }), true, 'already-retired ownership must not abort predecessor reconciliation');
      assert.deepEqual(readAmaCloserLease(rootDir, leaseIdentity), before,
        'finalization must neither recreate a missing lease nor change successor ownership');
    }
  });
}

test('orchestration producer catalog matches its state projection after logging changes', () => {
  const catalog = JSON.parse(readFileSync(new URL('../state-machines.json', import.meta.url), 'utf8'));
  const source = readFileSync(new URL('../src/ama-closure-orchestration.mjs', import.meta.url), 'utf8');
  assert.equal(catalog.sourceProjectionSha256['src/ama-closure-orchestration.mjs'], digest(stateProjection(source)));
});
