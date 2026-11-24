# ARCISUITE-01

## Summary

Pull requests select affected Node test files from the diff between the
checked-out merge commit and its first parent. The offline selector follows
reverse imports, re-exports and literal references to repository inputs. Harness,
package, workflow, shared fixture and unclassified changes select the full file
set. Prose-only and empty diffs select zero files.

Small selections run on both Node majors. Broad selections are balanced by
measured duration hints across the existing `npm test (Node 22)` and
`npm test (Node 26)` jobs. Both jobs run on `ubuntu-24.04`. Pushes to main,
the 06:37 UTC nightly schedule and manual runs execute the full suite on both
majors. The CI suite deadline is 900 seconds. The pre-push mirror and GitHub
Actions both invoke `npm test`.

## Interface changes

`npm test -- --base <revision> --dry-run` lists the plan for that revision
against the checked-out `HEAD`. Set `AR_TEST_PR_SHARD` to `0` or `1` to
preview a matrix shard. `npm test` without a diff base remains the full local
suite. Exact path and basename arguments still run a focused selection.

## Verification

Synthetic fixtures exercise reverse reachability, non-import CLI links,
the merge commit's first-parent diff, scope fallbacks and shard coverage.
The focused runner, sandbox, selector and watcher claim-loop suites passed
238 tests. Repository lint, changed-file ESLint, contract typechecking,
workflow lint and the offline byte-equivalence demo passed. The Agent OS
mirror drift check also passed with the AR overlay present. See the committed
observation plan for the hosted 450-second target.
