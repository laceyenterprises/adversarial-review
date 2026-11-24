# AMASTRICTROUTE-01

## Summary

An exact-head review with findings takes precedence over a terminal remediation
receipt in strict mode. The shared table selects findings closure in R14 and
rescue projects the same owner. Strict-mode daemon routing requires zero findings
on a current-head review, including the head-scoped approval route. The existing
terminal proof for a superseded review still goes through daemon preflight.

## Interface changes

A refused successor handoff writes `needs-closer` to the existing head-scoped
receipt. Later closure passes can retry admission from either this state or the
legacy receipt. A confirmed successor records its remediation job ID. If final
fix-all is already spent, normal hammer admission receives the selected route.
Successor custody has an immediate refusal alert and no timed escalation.
The daemon executor also checks strict exact-head finding counts when called
without a shared decision.

## Verification

Synthetic decision and successor fixtures reproduce the former daemon selection
and ownerless receipt. The regressions cover strict findings, strict zero
findings, non-strict findings, rescue agreement and a successful later retry.
The routing, successor, dispatch, retry-cap and state-machine suites passed
individually, along with lint, contract typechecking and the offline demo.
After deployment, a strict-mode Comment-only head with non-blocking findings
gets a closer or an explicit `needs-closer` receipt when admission is deferred.
