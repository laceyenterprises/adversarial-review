# CLOSERREREVIEWRACE-01

## Summary

Add publication custody and exhausted no-merge successor reconciliation to AMA.
Publication intent, the remote mutation and exact returned-head recording share
a PR lock with reviewer ownership reads. A queued successor retains refusing
review input and uses the existing final-fix-all claim; refusal persists an
ownerless state and invokes existing closure-wait alerting.

## Interface changes

New scheduling-only publication reasons and head-scoped successor records are
documented in [the repository note](../../../docs/changes/CLOSERREREVIEWRACE-01.md)
and linked canonical data-model docs. Merge and finding predicates are unchanged.

## Verification

See the repository note for bounded offline test, lint, contract typecheck and
byte-equivalence validation results.
