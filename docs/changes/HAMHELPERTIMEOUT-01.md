# HAMHELPERTIMEOUT-01

## Summary

Mandatory hammer reads use load-aware helper budgets and one retry for transient
timeouts. Publication/provenance mutations use scaled budgets without new
retries. The PR update fixes symlinked CLI execution, separates the runner
from the wrapped runtime, defers audit imports until failure, quotes wrapped
arguments, and extracts reusable shell functions to keep the prompt within
60 KiB. Child exit statuses and receipt output are preserved. All mandatory stops and
merge fences remain in force. Includes the
[SEV1 report](../postmortems/SEV1-HAMHELPERTIMEOUT-01-helper-read-timeouts.md).

## Interface changes

`bin/hammer-helper-step.mjs MODE STEP NOMINAL CEILING COMMAND [ARG...]`
owns helper bounds and timeout diagnostics. `read` permits two attempts for
timeouts; `mutation` permits one. Both leave durable reporting to their caller.
The explicit `read:report` / `mutation:report` modes delegate terminal reporting
to the runner except for caller-owned semantic exits 20 and 21. Inner failure
audits remain provisional, including for best-effort receipt writes and
caller-retried submodule updates. Base-head initialization resolves its runtime
before `inputs.sh` exists. The closure runbook compares stacked allowances
with the independent two-hour controller limit and merge-lease deadline.
Applied multipliers are
effective budget divided by nominal, represented as thousandths in reason codes.
`bin/load-aware-timeout.mjs NOMINAL [CEILING]` accepts an optional explicit ceiling
without changing existing one-argument callers. Phase scripts keep resolving
`HAM_NODE_BIN` through the shared HAMNODEBIN-01 resolver.

### Alarm classification

| Sites | Classification | Nominal / ceiling | Retry |
| --- | --- | --- | --- |
| Base-head, context, full-review, primary-change context, head range, conflict-primary and rebase-result proof reads | GitHub/git reads | 90 / 540 seconds | One timeout retry |
| API publication and submodule synchronization, including the existing bounded sync function | Network-capable mutations | 120 / 720 seconds | No new replay; existing publication recovery and submodule retry rules remain |
| Pushed attestations and finding-dispute publication | Network-capable mutations | 90 / 540 seconds | No new replay |
| Merge-action receipt capture | GitHub-reading receipt write | 60 / 360 seconds | No new replay |
| Token preflight and local disputed-head read | Deliberate fast guards | Fixed 15 seconds | Existing rules |
| Local merge-signal capture | Local bookkeeping guard | Fixed 20 seconds | Existing rules |
| Published-head probes, CI gate reads and synchronization TERM grace | Deadline-owned polling / cleanup guards | Existing 30-second probe cap within 300-second head wait; existing CI deadline; 5-second cleanup grace | Existing rules |
| Git fetch and validation | Already load-aware, separate bound owners | Existing policy and ceilings | Existing retry/cleanup rules |

## Verification

Twelve targeted files pass individually on Node 22 and Node 26 (360 tests per
runtime): `hammer-helper-launch`, `hammer-helper-step`,
`ama-hammer-merge-protocol-prompt`, `ham-bounded-git-sync`, `load-aware-timeout`,
`hammer-procedure-generation`, `hammer-scratch`, `hammer-rebase-guards`,
`simplicity-note-prompts`, `hammertrim-contract`, `hamgittoken-01`, and
`finalclose-01`.
The new launch suite also passes with an actual SIGTERM child, checking receipt
preservation and lease cleanup under `set -e`. Existing tests are unchanged
relative to the PR's concurrent remediation head.

Every targeted file ran separately through `cwp_dispatch.worker_validation`
with a 600-second bound, `NETGUARD_LOG`, and the prescribed netguard PATH.
Node 22 used an isolated checkout copy with its own ABI-compatible `fs-ext`
build; the working checkout's dependencies were unchanged.

`npm run lint` passed with zero errors (152 existing warnings),
`npm run typecheck:contracts` passed, and the offline research-finding demo
passed with byte-stable deliveries. The three rendered phases passed `bash -n`
and `shellcheck --severity=error`; the new shell helper passed ShellCheck.
This repository has no `scripts/test-shellcheck-gate.sh`, so the installed
ShellCheck was used directly. The rendered prompt is 61,391 bytes against the
unchanged 61,440-byte limit. Memory searches were available and returned no
matching records for the investigated execution and timeout patterns.

The full offline `npm test` run reached the suite's 900-second limit. Its
partial output included artifact-build/lane timing failures and a
hammer abort regression: a redundant phase-entry presence check ran before
history-read abort cleanup. Removing that check preserves the existing abort
audit and lease release; the dispatch preflight still requires the helper.
The affected targeted files were rerun after that correction. The full suite
is not claimed green.
