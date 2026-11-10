# HISTREADLOAD-01

## Summary

Mandatory closure history reads honor the caller's effective timeout and use
the existing load-aware policy for their nominal 90-second default. Successful
immutable pages and per-file comparisons persist under the exact PR head,
so a deferred collection resumes its evidence read. Every retry still checks
the live head, current reviews, provenance and author-change preservation.
Neighboring closer history helpers and optional preservation evidence reads
use the same load-aware sizing. No merge predicates or CI jobs change.

## Interface changes

`createHistoryReader` adds `withProgress({rootDir, repo, prNumber, headSha})`.
The canonical data owner writes atomic partial-read checkpoints alongside the
existing completed history store. See the
[data model](../data-model/primary-change-history.md).
Caller cancellation, timeout classification, child-group cleanup and scratch
cleanup retain their existing semantics.

## Verification

Synthetic progress, budget and store tests passed individually under netguard,
each bounded to 600 seconds. The fixtures cover extended load budgets, persisted
pagination and local diff progress, full mixed-author collection across
deferrals, changed-head isolation, cancellation and fail-closed preservation.
Further scoped regression results are recorded in the PR acceptance evidence.
The history throughput/retry, primary-change and context CLI, generated-block,
migration-renumber/rebase, derived-artifact, hammer head/base/rebase, closure-gate,
daemon-merge and watcher closure-latency files passed individually. ESLint
passed with zero errors (152 existing warnings), contract typechecking passed,
and the offline research-finding walkthrough retained byte-stable deliveries.
The full suite was not run, as required by this dispatch.

After ordinary deployment, SRE must verify watcher/follow-up PID start times,
observe no new history-budget exhaustion at comparable load, and observe a
long-history PR close through its closer. This work performs no live action.
