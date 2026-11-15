# SEV3 — branch-protection timeout tests assumed a child had spawned

Date: 2026-11-14. Ticket: BRANCHPROTFLAKE-01. Severity: SEV3.
Status: test repair; production reader behavior unchanged.

## Impact and four reported instances

The supplied incident evidence records four occurrences, all on Node 22:

| Instance | Observed impact |
| --- | --- |
| Main run 43682832291, head 7f6d34e7 | One of 20,685 tests failed: protection lookup threw `TypeError` at test line 56 reading `signal.aborted`; Node 26 passed on the same head. |
| Earlier closer rescue | The same failure left CI red and the rescue escalated as `ci-not-green`. |
| Earlier PR run, org discovery variant | The same undefined-signal `TypeError` made PR CI red. |
| Earlier PR run, passed on rerun | The same failure initially made PR CI red; a rerun passed. |

Only the main run identifier was supplied; the earlier occurrences are
reported descriptions, not independently retrieved run records.
The operator reported main red after the CIWAITLANE-01 merge. That change
touched unrelated review-row, no-progress-lane, test and documentation files.

## Cause and correction

The reader starts its absolute timer before asynchronous pre-spawn admission.
If admission consumes the budget, the reader reports the typed timeout and
aborts its controller; the guarded transport correctly refuses a late spawn.
Both CLI tests captured the signal only inside their fake transport and
unconditionally dereferenced it after a 50 ms timeout.

The tests now assert child abort when a child was spawned, while retaining
the real elapsed-time bound and typed timeout-reason assertions in both CLI
variants. Two deterministic reader cases use the existing retry injection seam
and mocked timers: one holds asynchronous admission beyond the deadline and
then proves a late spawn is refused; the other advances the deadline only
after capturing the child signal and proves it changes from active to aborted.
The former always checks zero attempts and admission phase; the latter always
checks one attempt and child phase. Both require the branch-protection reason.

The existing reader unit tests also cover admission and child timeouts.
No production seam, timeout budget, retry policy, CI job or merge gate changed.
The required memory search returned no matching records.

## Qualification

See the [change note](../changes/BRANCHPROTFLAKE-01.md) for scoped validation.
The repeated file run includes admission held past the virtual deadline on
every iteration, so coverage does not depend on provoking a loaded host.
This is source qualification; no live settings, daemons or review state changed.
