# BROKERREADYGATE-01

## Summary

Remediation waits for credential broker readiness before preparation and dispatch.
An outage defers the same pending job with bounded exponential backoff and no
round charge. A proven credential-only publisher failure records an
infrastructure-failed attempt and retries without charging the remediation budget,
retaining the commit and workspace for recovery.

## Interface changes

Pending jobs may carry `credentialBrokerDeferral` with typed
`credential-broker-unready` evidence and a retry time. Publisher failures may use
`remediation-credential-refresh-unavailable`; replies carry the same operational
blocker code. Retry history records `credential-refresh-unavailable` and
`state: infrastructure-failed`. Local retries resume the preserved workspace.
No config key, CI job, label or merge-authority rule changes.

## Verification

Offline synthetic fixtures cover readiness, timeout, backoff, spawn admission,
publisher artifacts, refunds, preserved work and lease rejection. The isolated
broker, publication and infrastructure-refund suites passed all 70 assertions.
The follow-up suite passed all 388 assertions; its combined invocation reported
a checkout-data isolation guard failure caused by concurrently invoked fixtures.
Lint, contract typechecking and the byte-equivalence demo passed. The broader
affected-file run and full suite each reached their fixed 600-second limit,
so neither provides a completed suite result.
