# INTERACTIVEPRIDENTITY-02 — an identity-absent daemon fail-close parks instead of dispatching a closer

## Summary

- `src/ama/daemon-decline.mjs`: `isDurableIdentityAbsence` separates a read that found no build
  identity from a transient read and from malformed, denied or unknown identity evidence.
- `src/ama-closure-orchestration.mjs`: a clean exact-head `daemon-failed-closed` decision whose
  identity is durably absent parks under `daemon-identity-absent-parked` (page once per head,
  `needsOperator`) and dispatches no closer; the daemon still re-checks every pass.
- `src/daemon-merge-park-log.mjs`: the park record's remedy names `hq pr sign` (pr-sign skill) or
  hand-merge.
- `docs/RUNBOOK-ama-closure.md`: the `worker-identity-unresolved` section describes the park.
- Final remediation records the parked reason once per watcher pass, retaining
  its first observation and count. Unverified exact-head produced attestations
  return `invalid-produced-head-attestation`, preserving the fail-closed handoff.
- Reviewed and refreshed the orchestration state projection and documented the
  unchanged lifecycle/smoke contracts. Moved this PR's note to `docs/changes/`.

## Interface changes

The identity resolver distinguishes absent produced attestations from present
but unverified rows. Park record shape and merge predicates are unchanged.

## Verification

- `node test/run-tests.mjs test/interactiveprident-02.test.mjs
  test/ama-closer-lease-finalization.test.mjs test/daemon-merge-park-log.test.mjs
  test/daemon-worker-identity-ledger-target.test.mjs`: 45 passed.
- `node test/run-tests.mjs test/smv.test.mjs`: 11 passed.
- `test/watcher-daemon-clean-merge.test.mjs` passed in a combined targeted run;
  the unchanged trunk `test/primary-change-authorized-rename.test.mjs` reproduced
  19 pre-existing failures also present in the reviewed head's CI logs.
- `test/watcher-claim-loop.test.mjs` exceeded its bounded 150-second run after
  96 passing cases; no full local suite was run.
- `npm run lint`: zero errors (149 existing warnings).
- `npm run typecheck:contracts`, `node scripts/validate-data-model-catalog.mjs`
  (98 entries), `bash demo/research-finding-walkthrough.sh`, and
  `git diff --check`: passed.
