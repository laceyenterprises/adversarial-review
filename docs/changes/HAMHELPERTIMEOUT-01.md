# HAMHELPERTIMEOUT-01

## Summary

Mandatory hammer reads use load-aware helper budgets and one retry for transient
timeouts. Publication/provenance mutations use scaled budgets without new
retries. All mandatory stops and merge fences remain in force. Includes the
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

All five touched test files pass (109 tests):

- `node --test test/hammer-helper-step.test.mjs` — 10 passed.
- `node --test test/ama-hammer-merge-protocol-prompt.test.mjs` — 45 passed.
- `node --test test/ham-bounded-git-sync.test.mjs` — 9 passed.
- `node --test test/load-aware-timeout.test.mjs` — 34 passed.
- `node --test test/hammer-procedure-generation.test.mjs` — 11 passed.

Each command ran separately under `cwp_dispatch.worker_validation` with
`--timeout-seconds 600`, `NETGUARD_LOG` and the prescribed netguard PATH.
No broad test suite or demo was run, following the ticket's touched-file limit.
`npm run lint` passed with zero errors (existing unrelated warnings);
`npm run typecheck:contracts` passed. ESLint `--fix` on touched JavaScript
files was clean. The three rendered phases passed `bash -n` and
`shellcheck --severity=error`; this repository has no
`scripts/test-shellcheck-gate.sh`, so the installed ShellCheck was used directly.
The prompt remains within its existing 60 KiB bound. Memory searches were
available and returned no matching records for this timeout/retry pattern.

### Final comment-only remediation

The five targeted suites above pass with 115 tests: helper-step now has 16,
including caller-owned timeout reporting, semantic exits, failed post-merge
receipt capture, a recovered conflict submodule loop, fresh-shell base capture,
and a pinned high-load CLI ceiling regression. Protocol, bounded Git sync,
load-aware timeout and procedure generation retain 45/9/34/11 passing tests.
Commands ran through `bin/run-bounded.sh --timeout 120` with bounded output.
`npm run lint` passed (zero errors, 152 existing warnings);
`npm run typecheck:contracts`, `bash demo/research-finding-walkthrough.sh`
and `git diff --check` passed. No full local test suite was run.
