# CNS-04: durable closer outcome observations

## Summary

Preserve terminal closer launch evidence across same-head retries. Dispatch
projections can be replaced and some terminal launches never write an AMA
audit, so those stores alone cannot supply a complete historical denominator.

## Interface changes

The append-only [outcome journal](../data-model/ama-closer-outcomes.md) separates
terminal launch evidence from authoritative lease outcomes. Consumers join by
launch identity; process success never proves a merge. Closure, strict review,
dispatch, cleanup, and paging policies remain unchanged.

Remediation retains underscore-bearing operator-hold launch statuses verbatim
and registers the store in the validated data-model catalog. The reader contract
joins on globally unique launch IDs regardless of repository spelling, selects
the latest terminal status, and requires separate live-retry evidence for
current-terminal counts; historical observations alone cannot prove liveness.

Final comment-only remediation keeps reconciliation writes at the scanned
dispatch path, including legacy filename/identity mismatches. Offline fixtures
check one terminal observation, no repeated reconciliation, and identical
return values, cleanup and event logs when the journal is unavailable. The
existing dispatch equivalence test now names its actual coverage.
The reader contract excludes incidental pre-deployment predecessor rows using
an externally supplied deployment cutover and names `handed-to-review` as a
known no-terminal-lease-row case. Catalog registrations share the description.
The journal schema and closer lifecycle/smoke promises are unchanged.

Rescue remediation guards the entire observation build so classifier exceptions
cannot prevent authoritative dispatch writes. Legacy string PR numbers are
normalized; rejected terminal candidates emit the fixed local diagnostic rather
than silently losing evidence or serializing an invalid status as null.
An unchanged terminal rewrite skips predecessor capture, avoiding the duplicate
predecessor/new-document pair while retaining changed launch, timestamp or status
observations. Diagnostic-sink failures are also contained.

Comment-only rescue remediation rejects empty or whitespace-only repository
and head SHA identities for both terminal observation kinds. The journal now
creates its directory only on an append's `ENOENT` and retries once, avoiding
directory checks on steady-state appends while recovering after directory
removal. Other filesystem errors and retry failures retain the fixed diagnostic
and non-fatal behavior.

This is the upstream prerequisite for pipeline observers. Downstream work
remains incomplete until this change merges, the normal submodule float
advances the consumer, and fixtures validate that merged version.
This PR does not ship downstream observers or config thresholds.

## Verification

Synthetic offline fixtures cover both terminal evidence kinds, same-head
replacement, exclusion of provisional/parked/unlaunched observations, field
filtering, and dispatch/cleanup equivalence when journal writes fail.
`node --test test/closer-outcomes.test.mjs`, run through the bounded worker
validator with network guards: 7 passed. ESLint on the changed source and test
files: clean. The changed-file CI mirror: CDM re-derivation guard and contract
typecheck passed; the full suite was deferred by the fast tier.

Remediation validation: bounded `node --test test/closer-outcomes.test.mjs`
passed all 8 tests, including both operator-hold status round trips.
`node scripts/validate-data-model-catalog.mjs` validated 92 entries.
`npm run lint` passed with 0 errors (152 existing warnings);
`npm run typecheck:contracts`, `bash demo/research-finding-walkthrough.sh`
and `git diff --check` passed. The full suite remains delegated to PR-head CI.

Final-round bounded validation passed the outcome/reconciliation fixtures,
all 161 watcher claim-loop tests, and all 11 SMV tests (including source
projection and disposable Git smoke). The initial 120-second watcher bound
expired without an assertion failure; its targeted rerun completed in 178
seconds under a 360-second bound. Lint passed with 0 errors and the same 152
warnings; contract typecheck, offline walkthrough, 92-entry catalog validation,
exact catalog-fragment comparison, changed-source CDM audit, and
`git diff --check` passed. No full local suite was run.

Rescue validation: all 13 outcome fixtures passed through the isolated offline
runner, including injected classifier exceptions during dispatch replacement,
legacy PR-number normalization for both row kinds, invalid terminal evidence
diagnostics, unchanged-rewrite append counts and diagnostic-sink failure.
Changed-file ESLint with `--fix` passed; repository lint passed with 0 errors
and the same 152 warnings. Contract typecheck and the offline byte-equivalence
walkthrough passed; catalog validation checked all 92 entries.
The full `npm test` run exited 1 after the runner's 900-second timeout;
it also reported failures in untouched remediation-worker tests. All outcome
fixtures passed within that run. The full suite is not claimed green; those
unrelated failures were left outside this rescue's scope.

Comment-only rescue validation: all 16 outcome tests passed with the isolated
offline runner, including blank identities for both kinds, lazy directory
creation, recovery after directory removal, and bounded retry failure.
Changed-file ESLint with `--fix`, repository lint (0 errors, 152 existing
warnings), contract typecheck, and the offline byte-equivalence walkthrough
passed. A direct `node --test` invocation observed an unrelated host CPU-sample
warning in a console assertion; the repository runner's deterministic timeout
fixture avoids that host dependency.
The required full `npm test` run exited 1 at its 900-second timeout, reporting
failures in untouched suites (including hammer self-rebase and review pipeline
health) and unfinished tests. Outcome fixtures passed in that run. Full-suite
greenness is not claimed; the scoped offline result is 16 passed, 0 failed.

HAM CI repair: reviewed the state projection delta introduced by terminal
telemetry deduplication. Its sole addition is the `doc.state !==
'launch-terminal'` comparison that controls a journal append; it changes no
lifecycle write, state, transition, custody rule, or smoke promise. Refresh
the existing `dispatch-closer.mjs` source fingerprint in `state-machines.json`
to cover that reviewed comparison. The independent graph snapshot and drift
mutation tests remain unchanged. Both final Gemini findings are already
addressed by the live head's trimmed identity validation and lazy ENOENT-only
directory creation. No interface change is introduced by this CI repair.

HAM validation: the isolated offline runner passed all 188 targeted tests
(outcome journal, SMV including mutation checks and disposable Git smoke,
and watcher claim-loop). Repository lint passed with 0 errors and 152
existing warnings; contract typecheck, offline byte-equivalence walkthrough,
92-entry data-model catalog validation and git diff --check passed.
The full suite remains assigned to exact-head remote CI.
