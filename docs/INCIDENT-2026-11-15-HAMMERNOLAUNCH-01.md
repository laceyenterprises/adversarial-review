# HAMMERNOLAUNCH-01 — missing closer launch after a conflict wake

Severity: **SEV2**, as assigned by the ticket. The operator's ownerless-open-PR
rule is SEV1; no downgrade of that rule is implied.

Status: **unresolved; Phase 0 report only**. This investigation does not prove
the incident's dispatch drop or remediation requeue blocker, and does not
claim a lifecycle fix. No live PR, review database, job, label or daemon was
changed. Fixtures use synthetic identities.

## Reported impact and timeline

The ticket supplies the following observations for one open product PR on
2026-11-15. They are incident input, not independently collected live evidence:

| UTC | Observation |
| --- | --- |
| 01:57:08 | Final remediation job created; stopped at 2/2 rounds 56 seconds later. |
| 01:57:37 | `hammer_wake` reported `requested`, reason `conflict-rebase`, admission budget 300000 ms. No subsequent closer launch was found by the supplied probe. |
| Subsequent polls | Expired R04 ownership reported “no discovery executor”; discovery continued toward the closer, without confirmed custody. |
| 02:36:52 | Operator retrigger raised the cap 2→3 but returned `bumped-requeue-failed`, with a non-pending job rather than an exception. |

The ticket also reports the expired-ownership symptom on another PR the
previous evening. Its common cause remains unproven.

## Phase 0 results

`test/hammernolaunch-01.test.mjs` runs three offline probes:

1. A real conflict decision has reason `conflict-rebase` and a 300000 ms
   admission budget. `requestEligibleHammerWake` records `requested` after a
   synthetic watcher delivery acknowledgement. Its audit contains a watcher
   request ID, not a launch receipt. This reproduces the reported wake shape,
   but does **not** reproduce an orchestration or HQ dispatch failure.
2. A stopped `max-rounds-reached` job, with `finalRound: comment-only`,
   suppressed re-review and current/max rounds 2/2, passes the real label
   handler, budget writer and requeue implementation. It becomes pending for
   round 3 with maxRounds 3 and a successful mutation audit. Thus the supplied
   shape alone does **not** reproduce the second drop on this checkout.
3. A **completed** comment-only final round deliberately throws
   `completed:comment-only-final-round; ownership belongs to the hammer` from
   the requeue implementation. This is a separate, intended handoff. It does
   not establish that the incident's **stopped** job was excluded by that
   guard. The label handler also excludes completed jobs without a requested
   re-review before attempting a budget bump.

All three probes pass. Production changes stop at Phase 0: treating a wake
acknowledgement as a launch, or bypassing the completed-round handoff, would
change an intentional contract without proving either incident cause.

## Exact source boundaries

Line references describe the investigated base, `03bc32c2f`.

- `src/hammer-wake.mjs:319–328` checks watcher delivery, assigns `requested`
  and persists the wake audit. It does not invoke a closer. This is the exact
  boundary where the observed word acquires its meaning, not a proven launch
  drop.
- `src/ama-closure-orchestration.mjs:2259` calls that helper before subsequent
  closure decisions. Its background submission begins at line 3024; inline
  and background execution eventually call `maybeDispatchAmaCloser`.
- `src/ama/dispatch-closer.mjs:8586` submits `hq dispatch` through
  `execFileImpl`. No supplied incident evidence establishes that this line was
  reached. No dispatch-side refusal has been demonstrated, so an additional
  repository is unnecessary for this report.
- `src/ownerproof-review-recovery.mjs:62–71` logs the expired discovery action
  and returns `null` to continue the walk. That message proves neither that the
  posted-review handler ran nor that the closer took ownership.
- `src/ama-closure-orchestration.mjs:853–855` only calls wake refusal
  settlement when a closer was invoked and a wake sink was captured. The sink
  is restricted to the native CI-blocked route at lines 2291–2292.
  `src/ama/dispatch-closer.mjs:2719` is a compatibility no-op: pre-receipt intent
  reconciliation owns fenced submission settlement. Restoring the old helper
  as a receipt writer could falsely settle an interrupted, accepted submission.
- `src/follow-up-jobs.mjs:3671–3672` explicitly refuses **completed** final
  remediation jobs. For a stopped job, lines 3720 onward validate its stop and
  cap; line 3845 returns the pending move after a successful budget increase.
- `src/follow-up-retrigger-label.mjs:1244–1254` is the exact branch matching the
  ticket's non-pending diagnostic. It records status and a generic detail,
  rather than deriving the blocking condition from `job.remediationPlan.stop`.
  The acknowledgement at lines 198–217 reads top-level `reason`/`error`; those
  need not exist on a returned stopped job. This is a diagnostic gap, not proof
  of which stop or competing mutation caused the incident.

There is no proven exact silent-drop line for either incident. The source
supports multiple later refusal/ownership paths; selecting one from a wake
line alone would invent causality.

## Existing bounds and remaining gaps

The current runbook already documents three wake-expiry successors before
`wake-expiry-cap-reached` escalation, and closure recovery has an independent
deadline executor in `src/ama/closure-recovery.mjs`. Their existence does not
prove the incident traversed them. Repeating “continuing the walk” is not
evidence that those bounds were enforced for this PR.

The requested guarantee—every closer request has a launch receipt or a typed,
PR-scoped refusal—remains unverified. The stopped-job acknowledgement can lose
the exact blocker. Neither gap is declared fixed by this report.

## Evidence needed to complete the diagnosis

Obtain sanitized, read-only copies covering the same PR/head and deployment:

- The wake audit, subsequent closure results/background settlement logs and
  watcher phase exit/deadline records, including the deployed source revision.
- The matching closer intent, lease and pre-receipt reconciliation observations;
  the bounded launch-ledger query and its coverage/errors, including retries.
- The stopped job before/after the bump, especially currentRound, maxRounds,
  stop, completion, reReview, closureHandoff and operatorRetriggerAudit; the
  label consumption's saved requeue context and any concurrent job mutation.

These distinguish “no submission attempted,” “submission refused,”
“submission accepted but receipt interrupted,” and incomplete ledger evidence.
The failed retrigger needs its returned job's stop code and reason, not just
the boolean fact that status was non-pending.

Operator-facing state for the unresolved incident should read:

> Closure ownership unconfirmed. Watcher attention was requested, but no
> closer launch is established by the available evidence. The operator budget
> bump succeeded; the returned job was not pending. Its exact blocking
> condition has not been preserved in the supplied diagnostic.

For a **proven completed** final-round refusal, the intended wording is:

> Remediation requeue refused: completed comment-only final round; ownership
> belongs to the hammer. This is a closure handoff, not a transient queue error.
> Confirm the closer's actual launch or refusal before treating the PR as owned.

These are report recommendations, not comments posted to any live PR.

## Verification

The new test file passed all three probes under the ticket's netguard
environment, one file at a time, through
`python3 -m cwp_dispatch.worker_validation --repo-root . --timeout-seconds 600
--command node --test test/hammernolaunch-01.test.mjs`.
No full suite or walkthrough demo was run: the ticket restricts test execution
to touched test files. No CI check, gate, label or live recovery was added.
ESLint on the new test passed; repository lint passed with zero errors and
149 warnings in unchanged files. Contract typechecking passed. Both commands
also used the managed timeout wrapper.
