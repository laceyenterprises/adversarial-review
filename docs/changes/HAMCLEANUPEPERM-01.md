# HAMCLEANUPEPERM-01

## Summary

Standalone `run-bounded` preserves a validation timeout after EPERM when the
child has closed and a bounded process-group observation confirms drain. The
runner reuses the controller census, which executes outside the validator's
group and excludes zombies. Live members and unreadable evidence keep cleanup
unconfirmed. The canonical validator still requires `cleanup: finished` and
the existing exact-head evidence before handing an UNKNOWN verdict to CI.

## Interface changes

Exit 124 retains its timeout meaning. Exit 125 still marks unconfirmed cleanup.
Runner diagnostics include failed census reads and a bounded list of live
member PIDs when the group remains.

## Verification

The synthetic empty-group EPERM case reproduced the old exit 125 before the
fix. `test/run-bounded.test.mjs` covers drain, live and unreadable census
results, and normal timeout behavior. `test/hammer-validation-deferral.test.mjs`
drives those receipts through the canonical validator's exact-head decision.
