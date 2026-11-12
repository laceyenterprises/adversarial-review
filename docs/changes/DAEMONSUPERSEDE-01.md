# DAEMONSUPERSEDE-01

## Summary

An approved, zero-finding, exact-head PR no longer waits for a closer that has
not booted. Before this change, a hammer launch still `admitted` (queued for a
fresh workspace) counted as the live owner. Every pass logged
`ama.closure_blocker reason=in-flight:<launch>` until someone cancelled the
launch by hand.

The shared next action now sets such a launch aside. When the remaining policy
selects the ordinary `R15-daemon` `clean-exact-head` row, the decision carries
`supersede-not-booted-closer:<launch>`. That row requires zero blocking and zero
non-blocking or demoted findings, both known, on the exact head, with green
required checks and a MERGEABLE PR. The closure executor then re-reads the
launch, cancels it with `hq dispatch cancel <launch> --reason
superseded-by-clean-exact-head-review` and confirms it ended. The daemon then
merges under the shared lease as before. Final-round remediation makes the
supersession intent durable before cancellation, refusing cancellation on marker
write failure or a missing/replaced dispatch record. A fresh boot-state read
after persistence retains booted ownership. Terminal-status enrichment remains
best effort; the original intent prevents hammer retries after deferred merges
even when enrichment fails.

The review's SHA-casing concern was checked against the reviewed head:
`sameHead` and the executor both compare case-sensitively. A regression fixture
confirms mixed-case review SHAs cannot select supersession in either path;
no SHA policy change is required.

PR-head CI also exposed resumed closer custody and fixture compatibility gaps.
A matching deferred terminal lease now protects a previously parked closer
and its retry descendants even when they resume through `requested` or
`admitted`; the observation projection retains the root launch identity.
The lifecycle fixture's
ledger stub exports the new observation reader with unknown evidence. The
state source projection was reviewed and refreshed; the graph and existing
smoke promises are unchanged.

Family rule: an owner that has done nothing yet does not outrank a completed
clean verdict.

A booted closer (leased, starting, running, suspended or parked) is never
superseded. The same applies to an unreadable retry chain, an unconfirmed
cancel, a failed live merge predicate, any finding, a head mismatch, a hold
label and non-green CI. In each case the closer keeps the merge. A closer that
boots in the race reads `pr-merged` at lease admission and closes out as
`already-merged`.

## Interface changes

- `src/pr-next-action.mjs`: launch facts expose `notBooted` and review facts
  expose `zeroFindings`. New exports `CLOSER_SUPERSEDE_REASON`,
  `CLOSER_SUPERSEDE_REF_PREFIX` and `closerSupersedeOf(decision)`. Decision
  rows, actions and actors are unchanged.
- `src/ama/closer-supersede.mjs` (new): `closerBootState` and
  `supersedeNotBootedCloser`.
- `src/merge-agent-hq-exec.mjs`: `execHqDispatchCancel` accepts an optional
  `reason` (passed as `--reason`). Existing callers are unchanged.
- Closer dispatch records gain optional `supersededByReview`
  (`docs/data-model/ama-closer-dispatches.md`). The closer lease settles
  `terminal`/`superseded`, an existing reclaimable outcome.
- New watcher event: `ama.closer_superseded`.
- No configuration, CI check, gate, override label or strict-mode change.

## Verification

Final-round remediation:

- `node test/run-tests.mjs test/launch-request-status.test.mjs test/daemonsupersede-01.test.mjs`:
  92/92 pass, including failed marker persistence, deferred merge recovery,
  mixed-case identity refusal, boot races and resumed closer/retry custody.
- Six neighboring policy, adapter, lifecycle and SMV suites: 546/546 pass.
  `test/watcher-claim-loop.test.mjs`: 168/168 pass under a 240-second bound
  after the earlier 60/120-second bounds proved insufficient.
- `npm run lint` passes with zero errors (149 existing warnings);
  `npm run typecheck:contracts` and the offline research-finding demo pass.
- Data-model catalog validation passes (94 entries); `git diff --check` passes.

Original implementation validation:

- `node test/run-tests.mjs test/daemonsupersede-01.test.mjs`: 11/11 pass. The
  file covers an admitted hammer cancelled with the typed reason followed by a
  daemon merge, no supersede for a running hammer, a finding or a head
  mismatch, and the post-cancel marker.
- 20 neighbouring decision, closure, SMV and claim-loop suites, including
  `pr-next-action`, `closer-next-action`, `daemon-next-action`, `smv` and
  `watcher-claim-loop`: 1093/1093 pass.
- `npm run lint`, `npm run typecheck:contracts` and
  `bash demo/research-finding-walkthrough.sh` pass.
