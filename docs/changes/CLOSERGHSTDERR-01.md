# CLOSERGHSTDERR-01

## Summary

Transient GitHub object reads can retry up to five attempts inside the
existing history deadline. Retries honor `Retry-After`. Permanent reads
stop without transport retries. See the [SEV3 report](../postmortems/SEV3-CLOSERGHSTDERR-01-closer-history-read-diagnostics.md).

## Interface changes

Transient closer audits use registered `reason=history-read-failed` and carry
the history failure class in `reasonDetail`. Permanent stops retain their
classified reason and counted failure handling. The audit records the
redacted `historyReadError` and optional `historyReadAttempts`. The watcher's
inconclusive retry handles transient stops. Non-history primary-change
helper failures retain a terminal audit.

## Verification

- The CI repair keeps classified history text in the Bash abort path, preserves
  the wrapped read's `cause`, and retains leading and trailing bounded transport
  diagnostic. Focused tests cover the real audit CLI and the three diagnostic
  assertions that failed in Node 22 and Node 26 CI.
- `node --test test/finalclose-01.test.mjs` passed 78 tests, including the
  production audit CLI fixture. The combined focused run passed controller
  and history-read suites; the final-close fixture was corrected and rerun.
- `node --test test/verifyheadtransient-01.test.mjs` passed 154 tests, including
  classified early-failure audit coverage.
- `npm run lint` passed with zero errors; `npm run typecheck:contracts` and
  `node scripts/validate-data-model-catalog.mjs` passed.
- `bash demo/research-finding-walkthrough.sh` passed with three byte-stable
  transcript deliveries.
