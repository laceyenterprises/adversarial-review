import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';

import { createAttestationLogGateProvider } from '../src/adapters/sor/attestation-log/index.mjs';
import { openFinalizationLedgerStore } from '../src/finalization/ledger-store.mjs';

const REF = {
  domainId: 'research-finding',
  subjectExternalId: 'subject.md',
  revisionRef: 'sha256:current',
};
const OBSERVED = '2026-05-11T19:00:00.000Z';

function memStore() {
  return openFinalizationLedgerStore({ db: new Database(':memory:') });
}

test('attestation-log provider gates an accepted decision on the exact revisionRef', async () => {
  const store = memStore();
  const calls = [];
  const provider = createAttestationLogGateProvider({
    ledgerStore: store,
    principal: 'research-finding-signer',
    hqAttestSubject: { repo: 'laceyenterprises/research-finding', prNumber: 7 },
    execFileImpl: async (bin, args) => {
      calls.push({ bin, args });
      return { stdout: '{"signature":"sig-1"}\n' };
    },
  });

  const result = await provider.gate(REF, 'sha256:current', {
    kind: 'finalize-now',
    observedAt: OBSERVED,
    sourceRef: 'slack-review:review-2',
  });

  assert.equal(result.gated, true);
  assert.equal(result.revisionRef, 'sha256:current');
  assert.equal(result.sourceRef, 'slack-review:review-2');
  assert.deepEqual(calls.map((call) => [call.bin, call.args.slice(0, 2)]), [['hq', ['attest', 'sign']]]);
  assert.deepEqual(calls[0].args.slice(2, 10), [
    '--repo',
    'laceyenterprises/research-finding',
    '--pr',
    '7',
    '--head-sha',
    'sha256:current',
    '--kind',
    'produced',
  ]);

  const events = store.read(REF);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'attestation_recorded');
  assert.equal(events[0].revisionRef, 'sha256:current');
  assert.equal(events[0].principal, 'research-finding-signer');
  assert.equal(events[0].kind, 'produced');
  assert.equal(events[0].sourceRef, 'slack-review:review-2');
  store.close();
});

test('attestation-log provider refuses to gate a stale revisionRef', async () => {
  const store = memStore();
  const provider = createAttestationLogGateProvider({ ledgerStore: store });

  const result = await provider.gate(REF, 'sha256:stale', {
    kind: 'finalize-now',
    observedAt: OBSERVED,
    sourceRef: 'slack-review:review-1',
  });

  assert.equal(result.gated, false);
  assert.equal(result.reason, 'stale-revision');
  assert.equal(store.read(REF).length, 0, 'stale revisions never append attestations');
  store.close();
});

test('attestation-log provider requires sourceRef provenance', async () => {
  const store = memStore();
  const provider = createAttestationLogGateProvider({ ledgerStore: store });

  await assert.rejects(
    () => provider.gate(REF, 'sha256:current', {
      kind: 'finalize-now',
      observedAt: OBSERVED,
    }),
    /sourceRef/,
  );
  assert.equal(store.read(REF).length, 0);
  store.close();
});
