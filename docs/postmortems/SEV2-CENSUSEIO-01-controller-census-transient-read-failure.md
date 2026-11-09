# SEV2 — transient process census reads ended eligible hammer work

Date: 2026-11-08. Ticket: CENSUSEIO-01. Severity: SEV2, closure availability.
Status: source correction with offline synthetic regression coverage; normal
review and deployment remain pending.

## Impact and evidence

The supplied incident evidence describes three hammer runs in about four hours
ending with `controller-process-census-unavailable` after the census helper
reported EIO. One stopped in the merge phase after the PR had been validated
as eligible, with exit 143. Reported host load was approximately 100–107 and
process creation approximately 85–120 processes per second. These are incident
observations, not measurements reproduced by this change. No unsafe merge is
reported. This report uses neutral descriptions and synthetic fixture identities.

## Cause and contributing conditions

The Darwin helper retried explicit EIO/EINTR only three times, separated by
10ms and 20ms. Successful kernel reads containing a missing start time or a
process-group mismatch refused immediately. Process creation or a concurrent
process-group transition can make those records transiently inconsistent.
The controller treated any failed census poll as immediate cancellation,
including while validation or merge gates were pending. The outer load-aware
request timeout could not help a helper that had already refused in 30ms.

Three similar closures in the supplied four-hour interval establish the
structural correction threshold. Increasing a fixed attempt count alone would
leave the immediate inconsistent-record refusal and controller cancellation
paths intact. The pre-edit memory search for this symptom and the affected
helper/controller paths was available and returned no matching records.
Sibling one-shot and persistent adapters were inspected and updated together.

## Correction and safety boundaries

Kernel reads now share one monotonic retry deadline, including buffer growth.
EIO, EINTR, embryonic start times and group mismatches cause a full fresh read
with 10ms exponential backoff capped at 200ms. The nominal two-second budget
is sized by the existing load-aware timeout policy, independently capped at
40 seconds. The persistent helper freezes that budget at startup. An additional
unscaled second of transport slack allows the bounded exhaustion reply to
arrive. Malformed buffers, invalid PID/microseconds, permission denial, missing
errno and exhausted buffer capacities still refuse immediately.

After readiness, the controller retries census failures until three consecutive
failed requests or its load-aware nominal ten-second window is exhausted. An
admitted request may finish beyond that window. Pending validation/merge
requests await a readable snapshot. Separate cancellation and launch authority
still apply. Exhaustion preserves the reason classifier and records request
count, kernel attempts, elapsed milliseconds and last errno in `reasonDetail`.
The latest failed series also remains in `censusFailure` after recovery.

Unreadable data never proves ownership, authorizes group signaling, clears a
validator or proves drain. A required stop can signal only the direct child
until a fresh census proves group ownership. Lease-release predicates and
identity matching are unchanged. No CI check, label, live state mutation or
operator configuration change is introduced.

## Verification and recovery observation

Synthetic fixtures cover EIO/EINTR twice then success, embryonic and moving
records followed by clean data, persistent failures with bounded attempts and
elapsed metadata, deadline continuity across buffer growth, adapter metadata,
controller validation/merge recovery, bounded controller exhaustion and denial
of group signals on unreadable data. Existing identity, cancellation, descendant
drain and lease custody cases remain in the touched suites.

The change note records the exact scoped validation commands and results.
After normal deployment, a naturally occurring transient failure should leave
failure metadata followed by ordinary completion; persistent failure should
retain diagnostic exhaustion metadata and unknown drain custody. This ticket
performs no live recovery, deployment, forced merge or service restart.
