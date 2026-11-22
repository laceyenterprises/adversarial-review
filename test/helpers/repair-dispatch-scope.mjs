import { dispatchReadTransport } from '../../src/dispatch-read-client.mjs';

export function pairedDispatchAbsence(selector, grantId = 'project-repository-dispatch-read') {
  return { schema_version: 1, status: 'not_found', complete: true, items: [], roots: [], retry_edges: [],
    scope_complete: true, absence_proof: { version: 1, kind: 'canonical-exact-selector-absence',
      selector, grant_id: grantId, observed_at: '2026-01-01T00:00:00Z' } };
}

export function mockRepairDispatchScope(t, lookup = pairedDispatchAbsence) {
  const sdk = dispatchReadTransport.sdk();
  t.mock.method(dispatchReadTransport, 'sdk', () => ({ ...sdk,
    connect: async config => ({ sessionToken: 'fixture-session', endpoint_url: config.endpoint_url }),
    readSessionDispatchLookup: async selector => lookup(selector),
  }));
  return { env: { APP_CONTRACT_ENDPOINT_URL: 'https://fixture.invalid/repair-scope' } };
}
