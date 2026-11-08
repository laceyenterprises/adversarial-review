# SEV1 — mandatory hammer reads exhausted fixed helper alarms

Ticket: HAMHELPERTIMEOUT-01. Report date: 2026-11-08.
Status: source correction and synthetic coverage; deployed recovery unverified.

## Impact and evidence

The supplied anonymised one-hour sample contained ten closer launches ending
without merge. Three stopped at `base-head-timeout` after a 90-second limit
and one at `review-read-timeout`. An earlier launch that day stopped at
`context-timeout` after 90 seconds. Reported host load per core was about 4–6.
The operator escalated the open-PR backlog. These observations establish
premature helper stops in that sample; they do not establish how many PRs would
otherwise have merged or attribute all ten unsuccessful launches to timeouts.

The mandatory stops prevented continuation without required evidence.
There is no supplied evidence of an unsafe merge or bypass. This report uses
neutral descriptions and contains no production identifiers or credentials.

## Cause and contributing factors

Read helpers were wrapped in fixed wall-clock alarms despite sharing a host
and performing latency-sensitive GitHub and git reads. The repository already
scaled validation budgets under load, but helper alarms did not use that
mechanism. A single delayed read could end a closer after its work had already
consumed the run. Terminal timeout wording did not distinguish nominal from
effective patience, and there was no consistent outer retry for read timeouts.
The supplied evidence does not isolate CPU contention from API or I/O delay.

## Correction

A shared runner uses the existing load-aware CLI with the old nominal budget
and an explicit ceiling. Read-only timeouts receive one further bounded
attempt; semantic refusals retain their status. The final timeout reason names
the step, effective budget, applied multiplier and number of attempts.
Provisional helper audits cannot leave a terminal failure after a successful
retry. Partial output from an interrupted read is discarded before retry.

Mutations receive load-aware budgets and execute once through the runner.
Existing publication recovery, receipt, lease and merge-gate rules remain in
force. Node resolution from HAMNODEBIN-01 remains the phase entry contract.
Fast local guards and existing deadline-owned poll loops retain their bounds.
No live changes or new CI checks are included.

## Verification and recovery

Synthetic offline tests exercise a slow base-head fake within a scaled budget,
timeout recovery, two exhausted attempts with a named reason, permanent refusal,
provisional audit handling and a timed-out mutation preserving its receipt
without replay. Prompt tests pin read/mutation wiring and retained fast guards.
The [change note](../changes/HAMHELPERTIMEOUT-01.md) records validation results.

Normal review, merge and deployment must precede assessing organic recovery.
Subsequent audits can compare effective budgets and multipliers for helper
timeouts and observe whether closers reach the existing merge gates. Source
tests and PR publication alone do not establish backlog recovery.
