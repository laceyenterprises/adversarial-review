# MLRBULKAPPLY-01

## Summary

Reviewed exact shadow patterns can resolve existing open divergences through
individual audited overrides. Revoking the pattern atomically reopens its current
apply-existing overrides, preserving history and subsequent human replacements.

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
