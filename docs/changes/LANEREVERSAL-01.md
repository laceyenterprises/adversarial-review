# LANEREVERSAL-01

## Summary

Final-fix-all builder commits can authorize review-cited primary-line reversals
when durable PR/source-head job ownership, exact-commit produced attestation
and worker class/job provenance agree. Closer eligibility and daemon merge use
the existing finding admissibility, strictness, ancestry and region/content
proof. Ordinary builder classification and hammer authorization are preserved;
a later clean review alone supplies no reversal authority.

The final-fix-all prompt requires conditional worker-generated citation
trailers and final branch-push completion to emit exact-commit evidence.
Canonical runbook, state/verification declarations and data-model docs describe
the contract. Public examples and fixtures are synthetic.

## Interface changes

Lane commits require `Reviewed-Head`, `Worker-Job-Id`, the existing remediation
`Worker-Class`, and explicit-kind
`Reversal-Authorized-By: <review node ID or URL> finding=N kind=...` trailers.
No new CLI, config, lifecycle status, CI check, label or lease exception.
History cache identity advances to `reversalproof-v7`; lane evidence is
transient and reread at every evaluation. Durable HAM observations keep their
existing contract.

SRE float/restart, PID start-time verification, operator lane-brief update and
natural-traffic acceptance are declared in the
[manual operator plan](../../modules/worker-pool/post-merge-actions/LANEREVERSAL-01.yaml).
Affected incident PR recovery belongs to the operator after deployment, as
recorded in the companion SEV2 report. No live actions ran here.

## Verification

Each test file ran individually through `cwp_dispatch.worker_validation` with
`NETGUARD_LOG`, the prescribed netguard PATH and a 600-second command bound.
The full host suite was excluded as required by the dispatch.

- `test/lanereversal-01.test.mjs`: 33 passed, including both gates, negative
  provenance/citation cases, historical lane-before-hammer reversals, strict
  mode, rebase/snapshot proofs, fresh evidence and worker prompt generation.
- `test/primary-change.test.mjs`: 80 passed.
- `test/primary-change-lines.test.mjs`: 51 passed.
- `test/primary-change-reversal-rebase.test.mjs`: 74 passed.
- `test/primary-change-store.test.mjs`: 27 passed.
- `test/primary-change-context.test.mjs`: 8 passed.
- `test/laneauto-01.test.mjs`: 20 passed.
- `test/ama-merge-eligibility.test.mjs`: 40 passed.
- `test/smv.test.mjs`: 11 passed.
- Changed-source ESLint with `--fix`: clean. `npm run lint`: zero errors,
  152 existing warnings. `npm run typecheck:contracts`: passed.
- `bash demo/research-finding-walkthrough.sh`: byte-equivalence passed.
- Report frontmatter/links, catalog fragment, state declarations and the
  operator-only post-merge plan: passed offline validation, including the
  production plan schema parser. `git diff --check`: passed in both repos.
