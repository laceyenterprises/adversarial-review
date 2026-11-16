# RDXMERGEOFF-02

## Summary

Add a config-only repository fence for autonomous merge while preserving review
and remediation rounds. Listed repositories receive the fail-closed
`merge-disabled-for-repository` reason and remain available for manual operator
merge. No repository is listed by this change.

## Interface changes

- `roles.adversarial.merge_authority.disabled_repositories` defaults to `[]`.
  Entries must be complete `owner/name` strings; normalization lowercases them
  and rejects duplicates. There is no environment alias.
- `getMergeAuthorityConfig().disabledRepositories` exposes the normalized list.
  Closure orchestration applies the repository override without changing
  `enabled`; next-action policy selects an operator hold for this reason.
- Daemon merge, fast-merge processing and the queue GitHub adapter surface accept
  `disabledRepositories` and refuse listed repositories before merge writes.
  Daemon refusal precedes leases and records one failed attempt; fast-merge uses
  its existing blocked state and audit, preventing repeated audits and poll-cap
  starvation. Factories propagate the list from configuration.
- Shared eligibility, lane routing, worker scripts and review paths are unchanged.
  Both the watcher reader and the parent platform's worker reader must recognize
  the key before configuration can rely on it; see the
  [closure runbook](../RUNBOOK-ama-closure.md#merge-off-for-one-repository).

## Verification

Executed 204 selected offline test files using
`node --test --test-concurrency=2 <selected files>`, in batches of at most 25,
with a 600-second timeout and the network guard. All 19 new cases passed,
including repository normalization, loader validation, closure audit/dispatch
refusal, R02, executor refusal, cached config propagation, fast-merge poll-cap
progress and unlisted byte-equivalence. The existing SMV source projection was
refreshed after reviewing the additional fast-merge guard and existing blocked
state writer; the graph and smoke steps are unchanged.

198 files passed. Thirteen concurrent checkout-data mutation warnings cleared
when those files ran individually, including `test/watcher-claim-loop.test.mjs`.
Eleven existing assertions across these six files also fail with unchanged
`origin/main` source: `test/ama-closer-lease-failed-without-merge-reclaim.test.mjs`,
`test/ciblockham-03.test.mjs`, `test/hamclose-ownership.test.mjs`,
`test/hamrefund-01.test.mjs`, `test/ownerproof-review-recovery.test.mjs` and
`test/unregistered-repo.test.mjs`. Existing test cases were not edited.

`npm run lint` passed with zero errors (149 existing warnings).
`npm run typecheck:contracts`, the SMV contract/sandbox suite and
`bash demo/research-finding-walkthrough.sh` passed. The full `npm test` command
was intentionally excluded in favor of the ticket's scoped validation contract.
