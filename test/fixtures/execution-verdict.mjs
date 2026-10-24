// Public synthetic equivalent of RCV-07 ExecutionVerdict.export.
export function noWorkVerdict(launchRequestId, overrides = {}) {
  return { schemaVersion: 1, producer: 'cwp-execution/1', launchRequestId, attempt: 1,
    verdictId: `synthetic-${launchRequestId}`, verdict: 'no_work', reason: 'credential_before_work',
    evidenceRefs: [`ledger:launch_requests:${launchRequestId}`], observedAt: '2026-10-24T12:00:00Z', ...overrides };
}
