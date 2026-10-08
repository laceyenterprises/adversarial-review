# DUPTERM-01 / LAC-1895: terminal members retained in duplicate families

Incident: `SEV3-DUPTERM-01-20261008T2048Z`

Signature: `review-pipeline:duplicate-family-terminal-members`

Ticket: [LAC-1895](https://linear.app/laceyenterprises/issue/LAC-1895)

## Contract and impact

The [duplicate-family contract](data-model/duplicate-families.md) requires
terminal `reviewed_prs` siblings outside discovery to enter the census and stop
keeping families active. Slice absence alone must preserve cached live members.
Unknown/error evidence must not release holds. Discovery can observe a reopening
and takes precedence over older reviewed terminal state.

The supplied owner-lane snapshot at 2026-10-08 20:36–20:47 UTC shows stale
lifecycle/alert state, not a demonstrated current merge outage. Health reports
these two advisory families with five unresolved members:

| Family | Candidate | Authoritative terminal evidence |
|---|---|---|
| `agent-os-main-healthmem-01-2026-09-12-1ae5785b5b` | 6674 | closed Sep 12 |
| same | 6680 | merged Sep 13 |
| `agent-os-main-spawntmo-01-2026-09-14-0d5a4dcc99` | 6801 | merged Sep 14 |
| same | 6802 | closed Sep 14 |
| same | 6812 | merged Sep 14 |

All candidate rows still say `open`; family and candidate observations remain
at `2026-09-20T16:02:35.058Z`. Fresh historical GitHub reads and `reviewed_prs`
agree on the terminal states.

Evidence remains in the operator artifact directory
`/Users/airlock/agent-os-hq/operator-artifacts/sre-loop-20261008T0610Z/tick-2031`:
`pipeline-health.json`, `duplicate-family-db-proof.json`,
`duplicate-family-reviewed-prs.json`, `historical-pr-{6674,6680,6801,6802,6812}.json`,
`prior-dupfam-output-last-message.md`, and `prior-dupfam-prs-adversarial-review.json`.
Decode only the first JSON value in `pipeline-health.json` (a stderr trailer is
possible). Its `observedAt` is `2026-10-08T20:36:18.052Z` and the two findings
have respectively two and three unresolved members.

## Reproduced cause

Unfixed checkout: `8806cf20`. This is a current code defect, independently
reproduced offline; the snapshot alone does not establish which code version
was loaded in production or whether every recent census succeeded.

The watcher discovers subjects, fetches state, runs
`runDuplicateFamilyCensusForWatcher()`, then reconciles labels before review
processing. `reconcileDuplicateFamiliesForRepo()` used this order:

1. Refresh persisted candidates from discovery only and collect only those keys
   as observations.
2. `mergePersistedDuplicateCandidates()` joins active candidates to
   `reviewed_prs` and supplies terminal state to detection.
3. Detection omits all-terminal groups. `upsertDuplicateFamilies()` therefore
   never refreshes their candidate rows; its missing-family deactivation also
   refuses because none of their keys were discovery observations.
4. `summarizeDuplicateFamilies()` reads those unchanged advisory/open rows and
   emits stale examples; `evaluateReviewPipelineFindings()` reports them.

The previous vanished-sibling regression included a live discovered sibling,
which permitted deactivation but did not assert terminal candidate persistence.
It missed the all-absent case. DUPFAM-01 / AR#1215 changed content corroboration;
this correction retains that policy.

## Correction and regression evidence

The persisted merge marks only joined `closed`/`merged` reviewed states as terminal
observations. After successful detection, reconciliation refreshes discovery
plus those terminal observations and passes the same keys to lifecycle
persistence. Cached open siblings remain census context, never inferred closure.
The existing deactivation predicate still requires the family to disappear from
detection, so two remaining live unsuppressed siblings keep the family advisory.
Direct discovery still wins over the joined reviewed state.

Sibling-site audit: the preliminary watcher content census uses the same merge
helper but does not persist or deactivate; final reconciliation owns both.
Candidate refresh, observed-key construction and missing-family deactivation
have no other implementations. Health remains a read-only consumer; labels and
adjudicated closeout retain their existing verification/authority rules.
`survivor-merged` remains outside ordinary census deactivation.

Reproducer: `node test/run-tests.mjs duplicate-family-state.test.mjs`.
Before the fix, exactly the HEALTHMEM-01 and SPAWNTMO-01 all-terminal tests fail
(`advisory` rather than `inactive`), with 43 passing and 2 failing tests.
After the fix the tests assert terminal state and refreshed observation times
for all five candidates, natural deactivation, and idempotent transitions.
Additional regressions cover mixed live/terminal members, absent and
unknown/error/open reviewed states retaining corroborated holds, reopening
precedence, and an unverified empty census preserving rows and labels until a
healthy tick, plus a malformed SQLite reviewed-state join failing closed. The health integration begins with both stale findings and
proves natural reconciliation removes them through the real collector.

Validation: lint passed with zero errors; contract typecheck and research
byte-equivalence demo passed. Full `npm test`: 8,502 tests, 8,497 passed,
5 skipped, zero failures (169 seconds). Final state regressions: 48/48;
census/health integration: 217/217. The earlier four-file targeted run passed
267/267, including watcher claim CAS, labels and survivor closeout. This repo has no formatter script, docs inventory generator, or
`docs/INDEX.md`; no parent-repo inventory is generated here.

## Production acceptance (incident remains open)

Merge this gate-keeper change only through independent cross-model review,
convergence, required CI and the native closer. Normal main-catchup must float
the AR gitlink; the documented deployment owner must load the corrected watcher
(the data-model deployment contract requires watcher restart). A checkout SHA
alone does not prove loaded code. This worker performs no production edits,
restart, manual database/ledger rewrite, family abandonment or suppression.

The deployment owner must preserve read-only before/after evidence proving:

1. Deployed AR gitlink contains this fix and the currently loaded watcher uses it.
2. A verified natural duplicate census updates all five terminal candidate rows
   and deactivates both families; a failed census is not acceptance evidence.
3. Fresh pipeline health from the same owner root no longer emits either stale
   family finding for the reconciled reason.

Worker completion and PR merge do not close LAC-1895. Preserve all unrelated
holds, including PR 7392 `no-merge-hold` and PR 7578 `do-not-merge`, Searchlight40
capacity cap, and build-pack operator gates. No new config keys, CI jobs,
provider pins, quota overrides or merge bypasses are introduced.
