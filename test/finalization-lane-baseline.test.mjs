import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { openFinalizationExecutorLeaseStore } from '../src/finalization/executor-lease-store.mjs';

test('MGQ-01 baseline: subject leases permit competing writers on the same base', t => {
  let duplicateOwners = 0;
  for (let trial = 0; trial < 30; trial++) {
    const db = new Database(':memory:');
    const store = openFinalizationExecutorLeaseStore({ db });
    const acquired = [101, 102].map(pr => store.acquire({
      subject: { domainId: 'code-pr', subjectExternalId: `example/review#${pr}` },
      holder: `worker-${pr}`, leaseId: `${trial}-${pr}`,
      now: '2026-10-23T00:00:00.000Z', deadline: '2026-10-23T00:01:00.000Z',
    }));
    // Outcome read-back, rather than trusting the acquire responses.
    const holders = [101, 102].map(pr => store.read({
      domainId: 'code-pr', subjectExternalId: `example/review#${pr}`,
    }));
    if (acquired.every(r => r.acquired) && holders.every(Boolean)) duplicateOwners++;
    db.close();
  }
  assert.equal(duplicateOwners, 30);
  t.diagnostic(`unfixed subject-only serialization: ${duplicateOwners}/30 duplicate lane owners`);
});
