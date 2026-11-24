# CLOSERSOCKPATH-01

## Summary

Hammer and closer validation use a real, worker-owned temp directory under
`/tmp`. Node continues to resolve modules from the checkout, and Unix socket
fixtures have space for their nested paths. The validator cleans up after
each battery and checks for abandoned directories before subsequent runs.

## Interface changes

The validator exports `TMPDIR`, `TMP`, and `TEMP` to the battery and relocates
the closer's pytest base temp. A failed socket-path budget check or an
overlong Unix socket diagnostic produces `harness-fault:socket-path` and a
same-head retry through the existing infrastructure deferral flow.

## Verification

`node --test test/closersockpath-01.test.mjs` passed six synthetic checks,
covering a socket bind and local Node module resolution from a deep checkout,
setup rejection, cleanup, orphan reaping and infrastructure deferral.
The mirror and validation-deferral suites passed, including preservation of
an ordinary failed check alongside a socket failure. Lint reported zero
errors, contract typechecking passed, and the research-finding demo produced
three byte-stable transcript deliveries.
