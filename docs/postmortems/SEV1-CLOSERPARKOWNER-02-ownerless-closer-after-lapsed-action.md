# SEV1 — Open PRs lost their closer after a deadline or worker exit

Ticket `CLOSERPARKOWNER-02`

scars: merge.finding-remediation-and-authoritative-terminal

## Impact

A posted review could remain attached to an open PR for hours without a
reviewer, follow-up worker, or closer advancing it. An available closer slot
could not help when the PR never reached launch admission. Both an exact-head
review with non-blocking findings and a head pushed by a departed closer could
fall into this state.

## Synthetic reproduction

A fictional PR had a posted `Comment only` review, a terminal closer lease,
and a lapsed `R04-ownership` decision. The second fixture used a new head with
a closer trailer and carried the earlier review. With the closure ledger read
unavailable, both fixtures produced the same result:

| Surface | Observed value |
| --- | --- |
| Shared decision | `hammer` / `closure-recovery` with queue intent `reconcile` |
| Closure probe reason | `closure-recovery-ownership-unresolved` |
| Discovery watchdog outcome | `recovery-exhausted` |
| Discovery watchdog reason | `next-action-deadline-expired` |
| Discovery return | `null` |

`recoverOrphan` uses `canDispatch` to require `intent === 'dispatch'` and
an executor matching the action and actor. An R04 reconciliation therefore
never called the supplied hammer dispatcher. The discovery caller returned to
the ordinary walk, where the PR could miss closer admission. A closer trailer
suppressed the review refresh but supplied no wake through posted-review
backoff. As a result, `hasHammerDispatchIntent` never saw a fresh admissible
hammer decision for those parked passes, and the launch queue had no eligible
entry to count.

## Correction

Discovery checks current ownership and reopens lapsed closer work through the
same dispatch-only closure entry used by rescue. The entry reads the live PR
and applies existing launch, review, and lease checks. A closer trailer takes
the posted review through the ordinary closure handler when slow-lane backoff
would otherwise defer it. Admitted background work contributes to the closer
backlog while waiting for a slot. Exhausted budgets and observed hard-stop
refusals use the existing durable closure-wait escalation.

The regression fixtures cover a single successor across repeated passes,
follow-up and closer custody, operator holds, and one page for a spent budget.
