# SEV2 — repairable hammer stop hold had no reachable repair owner

Date: 2026-11-08. Ticket: STOPHOLDREPAIR-01. Severity: SEV2, closure availability.
Status: source correction and offline synthetic regression coverage; runtime
recovery remains unverified pending normal deployment.

scars: merge.finding-remediation-and-authoritative-terminal

## Impact and evidence

A PR containing completed, reviewed builder work remained open after a hammer
remediated findings and removed additional builder-authored regions without
finding citations. The primary-change gate correctly refused that head.
Its deterministic `primary-change-reverted` hold explicitly named restoration
as a repair, but subsequent closer wakes were skipped as `safety-refusal`.
Operator recovery did not establish a closer owner. The open-PR backlog was
escalated. The supplied evidence does not establish an exact start time,
affected count, duration, or an unsafe merge.

## Sequence

1. A builder head received a Comment only review.
2. A hammer pushed remediation together with uncited reversals.
3. The gate retained a repairable deterministic hold and named restoration.
4. Later wakes retained the refusal without executing its repair.
5. This investigation reproduced the recovery routing gap with synthetic
   subjects and added a bounded repair route. No live recovery was performed.

## Cause and contributing conditions

The hold described a next action without ensuring that its executor was
reachable. Current main already contained a scoped R05 repair dispatcher,
durable head/refusal reservations and shared hammer budgets. However, the
generic ownerless watchdog ran before that owner. It could return pending or
exhausted for R05, whose actor it does not execute, preventing the later
recovery call. A generic safety-result projection could also discard the
structured hammer refusal before projecting the snapshot.

The existing brief carried recorded evidence but did not explicitly require
builder authorship, prohibit closer trailers or require fast-forward-only
publication. Attribution stopped at the first refused path; the original
coordinates were merge-base coordinates, which must not be presented as
reviewed-file line numbers. Per-head receipts alone did not prevent a failing
repair output from starting another repair after its head changed.

## Correction

An exact-head R05 refusal explicitly marked repairable with a concrete action
reaches its existing recovery owner before the generic watchdog. The structured
refusal survives safety projection. Live-head, operator hold, fleet stop,
ownership, execution switches and all ordinary budgets still govern dispatch.
Non-repairable refusals launch no worker.

A fresh diagnostic traversal uses the existing primary-change evaluator and
authorization context to collect every refused path. It maps gate regions
through the builder patch to reviewed-file ranges and includes both coordinate
systems and snapshot identities. Unavailable or unmappable evidence refuses
dispatch. Merge evaluation still returns the original first failed predicate.
The worker must restore the uncited regions as a builder-authored commit,
without closer trailers, on the expected hammer head, and push fast-forward.

Reservations precede submission and survive repeat wakes, process restart and
ambiguous receipts. The PR ledger also retains repair source heads and their
original evidence across head/series resets. A failing descendant surfaces both
refusals without another repair launch. This intentionally conservative bound
also requires operator inspection for later failing descendants. A passing
repaired head returns to ordinary closure; authoritative live merged/closed
state remains terminal.

## Verification and follow-up

`test/safety-stop-repair.test.mjs` uses synthetic fixtures and injected
transports. It covers repair ownership before the watchdog, scoped operator
wakes, one launch with both files and explicit restoration instructions,
non-repairable refusal, repeated/concurrent wakes, shifted line coordinates,
deletion anchors, incomplete evidence, failed descendants, budgets, deferrals,
ambiguous submissions and normal closure of a passing repaired head.

Only the touched test file is run, serially, with a 600-second process-group
timeout and the required netguard environment. Lint and contract typechecking
are recorded in the change note. No CI job, gate, label, configuration key or
live state change is part of this correction. HAMSCOPE-01 separately addresses
the production of uncited hammer reversals.

Memory searches for the symptom and then the recovery-routing cause returned
no matching records. The supplied contract history and local runbooks informed
the design: bounded work must have a reachable executor, findings and strict
mode remain authoritative, and merged PRs must not be redriven. After normal
deployment, the runtime owner can inspect naturally occurring repair receipts
and closure evidence; this report does not claim deployed recovery.
