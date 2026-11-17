# INTERACTIVEPRIDENTITY-02 — an identity-absent daemon fail-close parks instead of dispatching a closer

- `src/ama/daemon-decline.mjs`: `isDurableIdentityAbsence` separates a read that found no build
  identity from a transient read and from malformed, denied or unknown identity evidence.
- `src/ama-closure-orchestration.mjs`: a clean exact-head `daemon-failed-closed` decision whose
  identity is durably absent parks under `daemon-identity-absent-parked` (page once per head,
  `needsOperator`) and dispatches no closer; the daemon still re-checks every pass.
- `src/daemon-merge-park-log.mjs`: the park record's remedy names `hq pr sign` (pr-sign skill) or
  hand-merge.
- `docs/RUNBOOK-ama-closure.md`: the `worker-identity-unresolved` section describes the park.
- Tests: `test/interactiveprident-02.test.mjs`.
