# SEV2: exhausted GitHub budget kept reviewer claims and credential slots occupied

Date: 2026-11-14. Ticket: REVIEWTHROTTLESLEEP-01.
Status: source repair with synthetic offline regressions; deployed recovery has
not been verified. Evidence below is the sanitized incident account supplied
with the task. This repair does not inspect or alter live reviewers or stores.

## Impact and timeline

One reviewer lane made no progress for about an hour. Merge throughput fell
from roughly eight per hour to two per hour. Four PRs were affected, including
a re-review waiting for credential capacity.

| UTC | Observed behavior |
| --- | --- |
| 18:40:07 | Two first-pass reviewers started on the same reviewer credential, across two repositories. |
| 18:40:11 | A successful PR-state REST response produced a core observation of zero remaining out of 5,400, with reset at 19:40:02. |
| 18:40:12 | Both reviewers logged a throttle wait of about 3,590 seconds after their diff-fetch message. GraphQL separately reported 5,399 remaining. |
| Until reset | The processes remained alive with no CPU, sockets or children. The watcher reattached and suppressed duplicate same-head dispatch. Two later PRs were held for credential concurrency. |

The approximately 99-minute reviewer timeout exceeded the remaining hour-long
budget window, so timeout recovery could not free the lane sooner.

## Cause

Pre-model GitHub context and diff reads ran without a throttle scope. The
unscoped throttle shares an in-flight promise and sleeps until reset when a
bucket falls below its floor. A sleeping process still satisfied reviewer
liveness and retained its claim and credential reservation. Same-head spawn
suppression correctly prevented duplicates, but also prevented the existing
exhausted-provider fallback from being considered for another pass. The lease
and timeout were bounds on runtime, not an admission-deferral mechanism.

## Was the zero reading real, and who could have consumed the budget?

**Historical exhaustion is unconfirmed.** The supplied telemetry establishes
that the local throttle recorded zero and slept. It does not retain all five
raw quota headers or an independent contemporaneous `/rate_limit` response.
The tool's 29 logged calls that day cannot explain an entire 5,400-call budget.
The apparent nine seconds between the inferred window start and exhaustion
is suspicious, but does not identify a consumer or prove a parsing error.
The healthy GraphQL reading concerns a separate primary resource and does not
disprove core exhaustion.

An installation budget is shared by **all installation access tokens minted
for that installation**, including rotated tokens, across repositories,
processes and hosts. Potential consumers include reviewer context/diff/blob
reads, prompt-enrichment reads, review-list and review-post housekeeping, and
any watcher, follow-up worker, automation or direct CLI/API caller that uses
that same installation. Merely running in this repository does not prove a
consumer uses that installation; a different installation has a different
budget. Local API logs cover only instrumented consumers. See GitHub's
[installation rate-limit contract](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api#primary-rate-limit-for-github-app-installations).

A later live check cannot establish what happened at 18:40. Attribution of a
recurrence requires the new exhaustion rows, installation binding evidence,
and the confirmation result. No credential fingerprints or identities from
the incident are reproduced here.

## Repair

- All reviewer pre-model GitHub preparation runs in a deferring scope. A typed
  `GitHubBudgetDeferredError` produces exit 79 and a structured
  `github-budget-deferred` receipt before model execution. Optional enrichment
  cannot swallow the refusal and proceed to the model.
- Settlement saves the exact reset in existing cascade `nextRetryAfter`, then
  releases the matching claim, session, PID and lease. Existing admission
  settlement releases credential capacity before token accounting. Neither
  review attempts nor infrastructure recovery attempts increase. The pass ledger
  records cancellation and does not spend the hard attempt ceiling. No successful
  post handoff occurs. A replacement claim is protected by the existing CAS.
- The reset hold applies to the deferred model. An alternate chosen by the
  existing exhausted-provider fallback can run earlier. Preferences, family
  refusal, review strictness and merge authority remain unchanged.
- An unscoped wait longer than two minutes first makes a bounded, unthrottled
  `GET /rate_limit` request with the sending identity. A newer confirmed primary
  balance corrects stale shared state. Actual rate-limit responses retain their
  hold because primary capacity cannot disprove secondary throttling. Failed
  confirmation retains the hold; mismatched identities defer. GitHub documents
  that [this endpoint does not consume REST budget](https://docs.github.com/en/rest/rate-limit/rate-limit#get-rate-limit-status-for-the-authenticated-user).
- Zero observations log only the raw quota limit/remaining/used/reset/resource
  headers, request category, consumer and credential bucket. Confirmation has
  a separate diagnostic unit. Bodies and authorization headers are excluded.

## Verification and recovery boundaries

Synthetic regressions cover no-model deferral, swallowed optional reads,
claim and slot release while accounting is still pending, exact-reset retry,
existing exhausted-reviewer fallback, stale-zero correction across readers,
failed confirmation, secondary-limit retention and quota-header attribution.
The change note records the commands and results.

The repair adds no CI check or operational override. Normal deployment and
observation of an organic deferral remain separate from source validation.
No restart, configuration edit, live database update or manual reviewer action
was performed by this work.
