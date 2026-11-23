# MRQ-11 — Fix the v2 fold where the divergence adjudication proves it wrong

## Summary

The divergence adjudication traced every v2-wrong shadow pattern to how the live
shadow feeds evidence to Merge Authority v2, not to the pure fold. This change
fixes those adapter defects and the two v2 decision gaps they exposed. It adds
one MLR-05 live-adapter scenario per fixed pattern. v1 (`src/ama/*`,
`src/pr-next-action*.mjs`, `src/follow-up-*.mjs`) is unchanged.

- **D1 custody.** `live-shadow.mjs` translates the snapshot's closer launch into
  `launch_custody_observed`, using the same tri-state ownership helpers v1 reads.
  A held launch is re-observed on every poll. It is released (`terminal`) when it
  ends, or when a complete read stops naming a launch this adapter observed. A
  launch the ledger still reports running, after its closer lease window lapsed,
  now yields a custody wait instead of a verdict-patience page or a second
  remediation. Unreadable ownership at the head is a typed unknown.
- **D2 suppressed-review heads.** `readFinalRemediatorHead` also accepts a
  completed comment-only final-round push (`completion.workerPushedHeadSha` with
  the round budget spent), which the closeout writer never marks
  `finalRemediationPush`. The shadow and the executor's exact-head review surface
  share this reader, so v2 requests the strict exact-head review for such heads.
  Final comment remediation normalizes validated input SHAs to lowercase before
  either job lookup, and returns the canonical lowercase proof and source reference.
- **D3 operator-decision holds.** `workflow-decision.mjs` escalates
  (`monitor-hold`) when the snapshot's exact-head review gates every finding behind
  an operator label. It does this only after the live-owner and custody gates, so
  a closer already landing the PR keeps it. The hold is re-derived on every
  observation and persists no halt.
- **D4 spent rounds.** Spent v1 remediation rounds append `budget_exhausted`
  (same fields as the review ceiling, so the two never double-append).
- **D5 observed merge.** A GitHub-merged PR appends `merge_observed` and no
  post-merge `mergeability_observed`. The classifier records v1 `merged` against
  v2's delivery wait on that recorded merge as `merge-observed` concurrence.
  The final review's observation-error precedence concern is already prevented
  by `workflowDecision`'s merge branch, before its unknown-evidence gate. Added
  adapter regressions prove checks/reviews refresh errors retain delivery after
  landing, still hold open PRs, and cannot use an unreadable PR state as merge proof.
  No production change is needed for that finding.
- **D7 keys.** `operator-hold:operator-label-required:<label>` keys as one class
  (the label never enters the key). `operator-hold:repair-owner-unproven` and
  `review:disputed-findings-review` are keyable. The new v2 reasons are keyable.
- **D8 typed unknowns.** `recordLiveShadow` no longer substitutes a throwing ledger.
  It records each evidence problem as a typed unknown: an errored observation,
  regressed checks or verdict at a settled head, an out-of-order snapshot, a
  translation failure, or unreadable launch ownership. A typed unknown yields a
  `refresh-evidence` wait whose reason names the cause. Only an unreadable ledger
  or a fold exception remains a fold error.

Not changed here, and why:

- **D6** (operator-approved and carried reviews): the adjudication asked for
  reproduction first (medium/low confidence). Minting `operator_override(approve)`
  from label evidence conflicts with the simulator invariant that label presence
  never creates an override. The override is also subject-scoped, so it would
  apply across later heads. This needs its own decision.
- **D2 for closer-authored heads** (hammer retry/CI-repair heads): they have no
  remediation job proof, so the executor's review surface would refuse the
  request. Feeding the shadow a proof the executor cannot honour would hide a
  promotion defect.
- **D4 for pending builder-handoff jobs** (low confidence): translating a v1 job
  into dispatch/conclusion lifecycle events needs reproduction.
- **A1** shadow-adapter labels: optional per the adjudication. Not needed for promotion.

The memory search for this scope returned no matching scars.

## Interface changes

- `shadowObserve` / `shadowObserveFromStore` accept an optional `unknownEvidence`
  array, forwarded to `eligible(..., { unknownEvidence })`. Decisions carry
  `unknownEvidence` when it gates them.
- New leaf module `src/finalization/live-evidence-reasons.mjs` holds the fixed reasons.
  It is included in `QUEUE_RUNNING_BUILD`.
- `live-shadow.mjs` exports `snapshotCloserCustody`, `remediationRoundsSpent` and
  `LIVE_EVIDENCE_UNKNOWN_CAUSES`.
- No migration, store column, config key, CI check, gate or label.
- Canonical docs corrected in place: the v2 spec §5 shadow item, the
  `finalization-shadow` data model, the divergence triage guide, the simulator
  README and the `finalizationShadow` state-machine declaration.

## Verification

- `node --test test/finalization-simulator.test.mjs`: 50 pass, 0 fail. This
  includes the unchanged 78-scenario MLR-05 library at ×1/×3/×6 over 20 seeds,
  and 27 new live-pattern tests.
- A/B against the base sources: every non-regression live-pattern scenario fails
  (24 of 27 tests; the 3 passes are the library-shape test and the two regression
  scenarios).
- All `test/finalization-*.test.mjs`, plus tests importing the changed modules
  (45 files): 672 pass. The 22 failures in `finalization-execution-surfaces`,
  `finalization-queue-check-transport` and `immediate-store-transactions` are
  identical on the base sources (`github-owner-token-unavailable` in this
  environment).
- Unit regressions: `test/finalization-live-shadow.test.mjs` 34 pass (typed unknowns
  per cause; one custody row per pass; another producer's workspace custody is
  never released). `test/finalization-shadow-pattern.test.mjs` 16 pass (label
  class normalization and its strict near misses).
  `node test/finalization-exact-head-review.test.mjs` 21 pass (comment-only
  final-round proof and its near misses).
- `node --test test/smv.test.mjs`: 11 pass. `npm run lint`: 0 errors.
  `npm run typecheck:contracts`: clean. `bash demo/research-finding-walkthrough.sh`: exit 0.
- Final comment remediation: bounded
  `node --test test/finalization-exact-head-review.test.mjs test/finalization-live-shadow.test.mjs`
  passes (22 exact-head tests and 37 live-shadow tests). The uppercase proof
  cases failed before the one-line normalization fix; the merged-refresh cases
  passed without changing production code. Lint has 0 errors (147 existing
  warnings); contract typecheck, the byte-equivalence demo, the data-model
  catalog validator (103 entries), and `git diff --check` pass. No persistent
  shape, lifecycle state, transition or smoke promise changes.
  Bounded workflow and SMV suites also pass (26 tests, including the disposable
  Git sandbox smoke).
- Hammer verified that a confirmed merge enters delivery before the workflow
  evaluates snapshot refresh errors. The regression tests distinguish that case
  from a failed refresh on an open PR or an unreadable PR state. The HELDHEAD
  watcher fixture now supplies the empty follow-up scan expected by the live
  finalization adapter, so the test reaches the request-exception assertion.
  Hammer's canonical changed-file validation passed 2,080 tests across 49 files,
  including `test/watcher-claim-loop.test.mjs`. `npm run lint` reported zero
  errors and 147 warnings. `npm run typecheck:contracts` and
  `bash demo/research-finding-walkthrough.sh` passed.
- Final fix-all round retained the existing SHA normalization and regression
  coverage for both advisories. The v2 spec and shadow data-model prose now
  explicitly state that a recorded merge retains delivery ownership ahead of refresh errors,
  while an unreadable PR observation cannot establish a merge. There is no
  runtime, storage, lifecycle or smoke-contract change in this round.
  The dispatched head's Node 26 CI run `45091784058` hit the 900-second suite
  deadline without a failing assertion; current main (`e844f9a483fe004dc4d6902c785d563006093b6c`,
  run `45084331983`) has the same Node 26 timeout. Node 22 passed on the
  dispatched head. This baseline timeout does not justify changing CI policy.
  Fresh bounded advisory validation passes all 22 exact-head and 37 live-shadow
  tests; the workflow suite passes all 15 tests. Lint has zero errors (147
  existing warnings); contract typechecking, the catalog validator (103 entries),
  the offline byte-equivalence demo and `git diff --check` pass.
