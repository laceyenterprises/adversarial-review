import './helpers/rate-limit-state-isolation.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closerProcessFixture } from './helpers/closer-process-fixture.mjs';
import { captureCloserProcessSync } from '../src/ama/dispatch-submitter.mjs';
import {
  acquireAmaCloserLease, readAmaCloserLease, isReclaimablePendingAmaCloserLease,
} from '../src/ama/closer-lease.mjs';

for (const scenario of [
  { name: 'holder started before acquisition', stdout: 'Wed Dec 31 23:59:00 2025\n',
    startedAt: '2025-12-31T23:59:00.000Z', reclaim: false },
  { name: 'PID reused after acquisition', stdout: 'Thu Jan  1 00:00:01 2026\n',
    startedAt: '2026-01-01T00:00:01.000Z', reclaim: true },
  { name: 'missing process row', stdout: '', startedAt: null, reclaim: false },
  { name: 'invalid process timestamp', stdout: 'invalid\n', startedAt: null, reclaim: false },
  { name: 'process read failed', error: new Error('synthetic ps unavailable'),
    startedAt: null, reclaim: false },
]) {
  test(`LEASECIPROOF-01 raw process evidence: ${scenario.name}`, t => {
    const rootDir = mkdtempSync(join(tmpdir(), 'leaseciproof-'));
    t.after(() => rmSync(rootDir, { recursive: true, force: true }));
    const calls = closerProcessFixture(t, scenario);
    const identity = { repo: 'fixture/project', prNumber: 7, headSha: 'a'.repeat(40) };
    const acquired = acquireAmaCloserLease({ rootDir, ...identity, watcherPid: 123,
      now: '2026-01-01T00:00:00Z', dispatchTimeoutMs: 60_000,
      captureProcessImpl: () => ({ pid: 123, startedAt: '2025-12-31T23:59:00.000Z' }) });
    assert.equal(acquired.acquired, true);
    assert.deepEqual(captureCloserProcessSync(123), { pid: 123, startedAt: scenario.startedAt });
    let pidProbes = 0;
    const reclaim = isReclaimablePendingAmaCloserLease(readAmaCloserLease(rootDir, identity), {
      now: '2026-01-01T00:00:30Z',
      processKillImpl: (pid, signal) => {
        assert.equal(pid, 123);
        assert.equal(signal, 0);
        pidProbes++;
      },
    });
    assert.equal(reclaim, scenario.reclaim);
    assert.equal(pidProbes, 1);
    assert.equal(calls.length, 2, 'producer parser and consumer both read the raw evidence');
    assert.deepEqual(readAmaCloserLease(rootDir, identity), acquired.lease,
      'observation never mutates native lease custody');
    assert.equal(acquireAmaCloserLease({ rootDir, ...identity }).acquired, false,
      'the native acquisition fence remains exclusive even after a reclaim observation');
  });
}
