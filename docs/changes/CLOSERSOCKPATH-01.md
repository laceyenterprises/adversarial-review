# CLOSERSOCKPATH-01

## Summary

Hammer and closer validation use a real, worker-owned temp directory under
`/tmp`. Node continues to resolve modules from the checkout, and Unix socket
fixtures have space for their nested paths. The validator cleans up after
each battery and checks for abandoned directories at most once an hour per
user, including after a timed-out census.

## Interface changes

The validator exports `TMPDIR`, `TMP`, and `TEMP` to the battery and relocates
the closer's pytest base temp. A failed socket-path budget check or qualifying
runtime socket diagnostic produces `harness-fault:socket-path` and a same-head
retry through the existing infrastructure deferral flow. TAP output retains
its ordinary validation status. Other scratch setup errors use
`validation-environment-failed`. The local validation receipt documents the
socket outcome, the setup or runtime scratch diagnostic, and optional
per-check evidence. The controller reads the exact-head receipt to route a
socket fault through the watcher; timeout deferral receipts govern validation
drain and can allow exact-head GitHub checks to decide.

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

Final advisory remediation relocates pytest basetemp arguments with unquoted,
single-quoted, or double-quoted values while preserving other caller flags.
The validation observer clears each stream's pending fragment when a stop
flushes it, preventing the normal completion flush from replaying that fragment.
Focused scratch and deferral regressions cover quoting and a trailing TAP
failure observed before timeout deferral.
