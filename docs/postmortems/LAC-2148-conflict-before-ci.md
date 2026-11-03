# LAC-2148 / CONFLICTBEFORECI-01 — published conflict cannot start PR CI

Source severity assessment: SEV3 — closure liveness loss without a review or
merge-gate bypass. Production incident classification remains operator-owned.
Parent LAC-2132. Source publication and organic activation are separate
acceptance boundaries.

## Evidence and causal limit

The operator reports AR #1687 at c919830ba6bb465f221a55032509f6c2b068c147
and #1688 at e68d59dd9ad14a7a1fd17a20884b96bb46e0dfd0 published
CONFLICTING with zero checks. The preserved evidence directory is
`/private/tmp/os-rescue-20261102T212906Z`; #1687 was canonically canceled
before operator rebase and 165 integrated tests; #1688 retained its active
native owner. These are operator observations, not new live probes by this fix.
No rescue branch, workspace, lease or owner was changed.

The repository Test workflow runs on pull_request, main-only push and manual
dispatch. GitHub's [official troubleshooting guide](https://docs.github.com/en/actions/how-tos/troubleshoot-workflows#triggering-event-conditions)
confirms that merge conflicts suppress pull_request runs. An empty rollup must
remain unknown; waiting for it cannot repair the conflict.

## Demonstrated source gap

The protocol publishes source, runs verify-head, publishes audit, waits for
exact-head CI and then evaluates merge authority. The controller bounds that
foreground execution and fences cancellation/lease cleanup; it does not reorder
these phases. verify-head's loop previously matched only BEHIND, leaving
CONFLICTING/DIRTY snapshots untouched. The merge wait required SUCCESS before
routing base repair. The same-head hammer-resume selector chose a checks wait
before the general conflict row. Each is reproduced with synthetic facts or
rendered production shell phases, not inferred solely from prompt wording.

The correction admits positive conflict to the existing bounded verify/rebase
procedure; a server conflict returns 21 after releasing the lane. A conflict
first seen during CI observation enters the same single bounded repair before
waiting, repeating admission and cancellation fences on lease reacquisition.
Resume dispatch selects conflict before waiting for absent checks, while earlier
live-owner, hold, safety and cap rows retain priority. UNKNOWN alone waits.
Local conflict repair stays outside the lane, preserves reviewed author/HAM
intent and actual current-main behavior, and publishes using existing CAS.
Publication failure stops; old-head CI never validates the replacement head.
No extra final rereview or merge waiver is added.

## Regression and custody

`test/hammer-self-rebase.test.mjs` exercises positive conflict with empty checks
both at verify and during CI observation, including the pre-predicate wait.
Positive-conflict fixtures also refuse moved heads, cancellation/hold and failed
audit publication before repair. Its existing LAC-2097 fixtures retain
unrelated nonconflicting main advances without mutation, bounded async old-head
acknowledgements, head races, publication/snapshot failures, cancellation and
lease cleanup. `test/pr-next-action.test.mjs` covers conflict resume, existing
owner and safety refusal precedence, and UNKNOWN/BEHIND observation. Normal
controller and publication suites remain part of validation.

Stable v2 requirement/scenario: CONFLICTBEFORECI-01/positive-conflict-absent-checks.
Invariant: a known conflict has a bounded native repair successor before a CI
wait that the conflict prevents from completing. Retain original reviewed source,
current-main semantics, native custody and immutable-head evidence through
repair. The Agent OS MLR requirements ledger is outside this provisioned AR
repository; this checked-in scenario is the AR-side handoff for its owner.

Only this worker's codex-lac-2148/LAC-2148 branch is the source deliverable.
Managed push and PR-open receipts identify its exact publication. Hosted Node
22/26 checks and the initial cross-model review must settle normally. Deployment
and a naturally scheduled conflict-to-repair observation remain organic
activation acceptance; tests or source publication alone do not satisfy it.
