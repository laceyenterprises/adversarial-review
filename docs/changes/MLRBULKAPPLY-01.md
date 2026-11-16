# MLRBULKAPPLY-01

## Summary

Reviewed exact shadow patterns can resolve existing open divergences through
individual audited overrides. Revoking the pattern atomically reopens its current
apply-existing overrides, preserving history and subsequent human replacements.
Final comment-only remediation keeps the 5,000-row revoke correctness assertion
and elapsed-time diagnostic, removing the contention-sensitive one-second
wall-clock assertion from the unit test.

## Interface changes

`finalization shadow-pattern apply-existing --id ID` previews read-only by default;
`--apply --principal PRINCIPAL` writes eligible rows in batches of at most 500.
Stores expose `planPatternApplication` and `applyPatternToExisting`. Reports add
`byPatternExisting`; promotion arithmetic and append-time capture are unchanged.
No migration or dependency is added.

## Verification

Scoped `node --test` passed 144 tests, including both SQLite UPDATE paths.
`npm run lint` passed (zero errors); contract typecheck and byte-equivalence
demo passed. Three isolated on-disk 5,000-row atomic revokes measured
46.78, 29.31 and 327.69 ms; no other validation ran concurrently.
`npm test` passed: 20,696 passed, 11 skipped, zero failures across 886 files.

Final remediation validation: `node --test test/finalization-shadow-pattern-apply.test.mjs`
passed all 10 tests; the revoke diagnostic measured 35.19 ms. `npm run lint`
passed with zero errors (149 existing warnings), `npm run typecheck:contracts`
and `bash demo/research-finding-walkthrough.sh` passed, and `git diff --check`
passed. The full suite was not rerun locally in this round; PR-head CI owns it.
