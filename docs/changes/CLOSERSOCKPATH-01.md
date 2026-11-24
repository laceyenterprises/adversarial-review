# CLOSERSOCKPATH-01

## Summary

Hammer and closer validation use a real, worker-owned temp directory under
`/tmp`. Node continues to resolve modules from the checkout, and Unix socket
fixtures have space for their nested paths. The validator cleans up after
each battery and checks for abandoned directories before subsequent runs.

## Interface changes

The validator exports `TMPDIR`, `TMP`, and `TEMP` to the battery and relocates
the closer's pytest base temp. A failed socket-path budget check or qualifying
runtime socket diagnostic produces `harness-fault:socket-path` and a same-head
retry through the existing infrastructure deferral flow. TAP output retains
its ordinary validation status. Other scratch setup errors use
`validation-environment-failed`. The local validation receipt documents the
socket outcome and optional per-check evidence.

## Verification

`test/closersockpath-01.test.mjs` covers a socket bind and local Node module
resolution from a deep checkout, setup rejection, cleanup, orphan reaping and
infrastructure deferral. The canonical TAP fixture retains a failed test even
when a passing test is named after a socket diagnostic. Both validators replay
the same diagnostic cases.
The mirror and validation-deferral suites passed, including preservation of
an ordinary failed check alongside a socket failure. Lint reported zero
errors, contract typechecking passed, and the research-finding demo produced
three byte-stable transcript deliveries.

The isolated helper-launch fixture includes the socket-fault module required
by stop-origin classification. It still omits the audit dependency so it can
verify that the helper preserves the wrapped command's exit status and receipt.
