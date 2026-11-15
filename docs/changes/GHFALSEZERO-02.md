# GHFALSEZERO-02

## Summary

Correct the SEV0 report with the proven oversized-diff trigger, two shared
credential outage windows, disputed 18:40Z attribution and BENCHSEV-110 pointer.
The companion agent-os documentation PR can merge in either order.

## Interface changes

None; documentation only. Existing maxBuffer regression coverage is cited.

## Verification

`npm run lint`: passed with zero errors (149 existing warnings).
`git diff --check`: passed. Reviewed the existing named maxBuffer regression;
no test added or run, per this ticket’s docs-only validation scope.

## HAM CI repair

The Node 26 job exposed a host-speed race in the exhausted shared-quota history
reader test: its real one-second context deadline could expire during quota
persistence. Use the existing fake clock for that test, preserving both the
quota-deferral assertion and the assertions that no execution or retry occurs.
No production interface changes.

Verification: canonical targeted validation of `test/history-read-retry.test.mjs`
passed all 27 tests; `git diff --check` passed. Full suites remain remote CI gates.
