# MRQ-02

## Summary

An unregistered closer stop code no longer throws or becomes a closer fault.
It is an `infrastructure` stop, retried through the existing owned retry, and
alerted once per code per day. Retryable hammer deferrals now name their
continuation, so a reader can tell "deferred, re-drive owned" apart from
"deferred, nothing comes next".

## Behaviour

- `hammerStopOrigin()` returns `infrastructure` for a well-formed unregistered
  code and emits one `ama_closer.stop_code_unregistered` alert per code per UTC
  day: an in-process set cleared when the UTC day changes, plus an outbox
  identity of `(code, day)` in alert delivery. Only a malformed reason throws.
  `registeredHammerStopOrigin()` is the side-effect-free read used by
  historical-audit projections.
- `recordHammerEarlyFailure()` records an unregistered code as the registered
  `unregistered-stop-code` infrastructure deferral. The original code stays in
  `originalReason` and `reasonDetail`. New attempts never record
  `stop-reason-unregistered`, and no in-run closer correction is demanded.
- No extra retry credit: `unregistered-stop-code` follows the same paths as
  every registered infrastructure stop. An unregistered code seen only at
  launch end keeps the bounded, counted exit refund.
- `hammerPhaseAttempt()` adds `continuation: {kind: "redrive", owner:
  "watcher", headSha, notBefore, lease: "fresh"}` to a retryable deferral when
  the head is known. In-run retries and world refusals get none.
- Registration stays documentation. The HAMWRITERTIMEOUT-01 completeness tests
  still require every shipped click-hold and writer code to be registered.

## Compatibility

Historical audit bytes are not rewritten. A companion change in the consuming
runtime reads `attempts[].continuation`: a closer launch whose PR is still open
ends succeeded only with a named continuation. Merge this change first.

## Interface changes

None in final remediation; only the active UTC day's alert keys are retained.

## Verification

Final remediation adds a rollover regression covering eviction, same-day
deduplication after midnight and a multi-day gap. Passed:

- `node --test test/mrq-02-unregistered-stop-code.test.mjs test/hamselferrors-01.test.mjs test/hamwritertimeout-01.test.mjs`
- `npm run lint` (zero errors; existing unused-variable warnings)
- `npm run typecheck:contracts`
- `bash demo/research-finding-walkthrough.sh`
- `git diff --check`

The full suite is left to PR-head CI under the final-round validation policy.
