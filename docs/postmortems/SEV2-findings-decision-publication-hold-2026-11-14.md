# SEV2: findings publication blocked by retained decision custody

- Date: 2026-11-14
- Ticket: FINDINGSDECISIONHOLD-01
- Status: fix proposed; deployment and natural verification pending

## Impact and supplied evidence

Three batches completed preparation but ended with a publication question on
a decision-only launch. Their retained checkouts prevented the publisher from
claiming the pushed branch. One batch repeatedly failed dispatch, including its
single publication-intent retry. Another received a peer answer, continued with
the same preparation prompt, and asked the same question again before release.
A third reached the 24-hour release window. Finished remediation was discarded
by batch release rather than published.

In the supplied five-day control sample, all 35 batches that reached a publisher
had preparation launches ending succeeded (34) or failed (1); none came from a
blocked decision launch. These are supplied observations, not live measurements
made by this change. No production identifiers or private transcripts are
included here.

## Cause

`publishFindingBatch` accepted `blockedNeedsDecision` when remote push evidence
matched, then dispatched a PR-shaped publisher on the same branch. That did not
close the question. The provisioning custody proof correctly refused a
“retained decision or triage owner.” Retrying dispatch could not change that
ownership. Answering a question starts a continuation, which is inappropriate
when only the independent publisher remains.

The Agent OS failfast checkpoint in
`SupervisorRecoveryMixin._enforce_failfast_budgets` provides a concrete conflicting
steer: it derives a completion shape for the budget but previously sent every
selected run “If useful work is already complete, wrap up and open the PR now.”
There was no completion-shape condition around that message. Its delivery test
now exercises decision-only selection and proves the publication instruction is
absent, while PR-shaped selection retains it. This source trace proves the
conflicting producer exists; it does not assert access to an individual live
session's delivery record.

The collector's failure handler preferred `error.message` on publication
failures. The subprocess command echo occupied the bounded database field,
hiding the refusal in stderr. The stale path treated a parked decision as an
ordinary terminal launch and released its findings.

## Correction

After independent remote-head verification and keyed custody checks, the
collector requests a supported, idempotent publication supersession. The API
proves clean retained files, exact local/tested/remote head equality, stopped
processes and original workspace identity under the existing locks. It writes
an append-only superseded decision audit, closes launch/run capacity through the
shared terminalizer, and detaches the branch through the existing preservation
and Git fence. It writes no answer and launches no continuation. The collector
persists the bound release receipt before dispatching its single publisher.
Interrupted handoffs resume from the same audit binding.
The collector rechecks keyed launch custody after that call. Once any earlier
ambiguous dispatch deadline and grace have passed, the verified handoff can
replace a spent pre-handoff publication intent once. The replacement retains
the old submission in `handoffOf` and the exact handoff binding in
`decisionPublication`; the handoff cannot renew its own spent retry.

The budget steer now follows completion shape, and the preparation prompt says
to finish successfully after the push and outcome artifact. Errors retain the
refusal first within 300 characters and log the redacted full stderr once per
failure. An unresolved decision prevents age-based batch release.

## Validation and limits

Offline synthetic fixtures cover ordered handoff, retained unpushed work,
saved answers, interrupted closure, receipt identity, one publisher, ordinary
success, diagnostic visibility and shape-specific steering. No live ledger,
decision, batch directory, configuration or service was modified. Merge the
Agent OS API and steer fix before the collector consumer. Deployment and
observation of natural batches remain necessary to establish production effect.
