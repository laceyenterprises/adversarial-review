# HISTREADLOAD-01

## Summary

Mandatory closure history reads honor the caller's effective timeout and use
the existing load-aware policy for their nominal 90-second default. Successful
immutable pages and per-file comparisons persist under the exact PR head,
so a deferred collection resumes its evidence read. Every retry still checks
the live head, current reviews, provenance and author-change preservation.
Commit account attribution/verification remains a per-head observation; the
canonical data-model doc now includes a manual refresh/purge procedure.
Neighboring closer history helpers and optional preservation evidence reads
use the same load-aware sizing. No merge predicates or CI jobs change.

## Interface changes

`createHistoryReader` adds `withProgress({rootDir, repo, prNumber, headSha})`.
The canonical data owner writes atomic partial-read checkpoints alongside the
existing completed history store. See the
[data model](../data-model/primary-change-history.md).
Semantic blob/tree/pagination failures abort sibling publications and purge
head progress. Progress uses a separate 512-directory/256 MiB periodic sweep
budget; completed publication removes partial progress. Rename planning skips
disposable progress payloads. Supervisor expiry can precede the child's deadline
under load and is documented as timeout/overload deferral. Merge lifecycle,
merge authority and existing smoke promises are unchanged.

## Verification

Synthetic progress, budget and store tests passed individually under netguard,
each bounded to 600 seconds. The fixtures cover extended load budgets, persisted
pagination and local diff progress, full mixed-author collection across
deferrals, changed-head isolation, cancellation and fail-closed preservation.
Final comment remediation passed the targeted history progress, store, repository
identity, budget, retry, throughput, primary-change and context CLI test files.
New cases cover same-head recovery after malformed compare/blob/recursive-tree
responses (including a stalled sibling), independent byte/count eviction,
completed-progress removal and sweep/publication races. The data-model catalog
validator passed. Further scoped results are recorded in the PR evidence.
The history throughput/retry, primary-change and context CLI, generated-block,
migration-renumber/rebase, derived-artifact, hammer head/base/rebase, closure-gate,
daemon-merge and watcher closure-latency files passed individually. ESLint
passed with zero errors (152 existing warnings), contract typechecking passed,
and the offline research-finding walkthrough retained byte-stable deliveries.
The full suite was not run, as required by this dispatch.

After ordinary deployment, SRE must verify watcher/follow-up PID start times,
observe no new history-budget exhaustion at comparable load, and observe a
long-history PR close through its closer. This work performs no live action.
