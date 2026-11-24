# CLOSERSOCKPATH-01

## Summary

Hammer and closer validation prefer a real, worker-owned temp directory under
`/tmp`. If that parent is unavailable for writing, they try the caller's
system temp directory within the same socket budget. Node resolves modules
from the checkout. Each temp parent has a per-user cooldown for orphan scans,
including after a timed-out census.

## Interface changes

The validator exports `TMPDIR`, `TMP`, and `TEMP` to the battery and relocates
the closer's pytest base temp. A failed socket-path budget check or qualifying
runtime socket diagnostic produces `harness-fault:socket-path` and enters
the existing counted closer stop flow. The runtime diagnostic must be the
command's only nonblank output. Mixed failures retain their ordinary
validation status. Other scratch setup errors use
`validation-environment-failed`. The local validation receipt documents the
socket outcome, the setup or runtime scratch diagnostic, and optional
per-check evidence. The controller reads the exact-head receipt to route a
socket fault through the watcher. Timeout deferral receipts govern validation
drain and can allow exact-head GitHub checks to decide.

## Final review disposition

The [final Claude review](https://github.com/laceyenterprises/adversarial-review/pull/2046#pullrequestreview-6043601521)
covers mixed product failures, repeat refunds, supported diagnostics, the
caller temp fallback, and scratch catalog custody. The implementation keeps
exit 75 and the existing `harness-fault:socket-path` code. Runtime
classification replaces the separate TAP exclusions with an output-only
check. The proposed rename is closed as a compatibility
disposition in this ticket. Any future rename requires a versioned migration
of receipt readers, the shell controller and historical audit consumers.

## Verification

`test/closersockpath-01.test.mjs` covers a socket bind and local Node module
resolution from a deep checkout, the budget-checked caller temp fallback,
cleanup, orphan reaping and same-head counted stops. The canonical TAP and
spec reporters retain product failures. Both validators replay a mixed pytest
assertion and inherited stderr socket traceback.
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
