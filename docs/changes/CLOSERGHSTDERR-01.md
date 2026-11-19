# CLOSERGHSTDERR-01

## Summary

Transient GitHub object reads can retry up to five attempts inside the
existing history deadline. Retries honor `Retry-After`. Permanent reads
stop without transport retries. See the [SEV3 report](../postmortems/SEV3-CLOSERGHSTDERR-01-closer-history-read-diagnostics.md).

## Interface changes

Closer stop reasons carry the history failure class and HTTP status when
available. The audit records the redacted `historyReadError` and optional
`historyReadAttempts`. The watcher's inconclusive retry handles transient
stops, and permanent stops retain counted failure handling.

## Verification

- `npm test -- test/history-read-retry.test.mjs test/finalclose-01.test.mjs test/hamcontrollerscript-01.test.mjs` passed 121 tests under netguard.
- `npm run lint` passed with zero errors. `npm run typecheck:contracts` passed.
- `bash demo/research-finding-walkthrough.sh` passed with three byte-stable transcript deliveries.
