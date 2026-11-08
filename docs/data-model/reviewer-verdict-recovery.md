# Reviewer verdict recovery

**Owner:** reviewer output reconciliation

**Store:** `data/reviewer-verdict-recovery/<sha256>.json`

**Source:** `src/reviewer-verdict-recovery.mjs`

The key is SHA-256 of the JSON array `[repo, prNumber, headSha]`, with `prNumber`
coerced through `Number(prNumber)` and `headSha` trimmed and lowercased before
hashing and storage. Numeric and string PR numbers share the same reservation.
The reviewer reserves one reconciliation attempt for an immutable PR head with an exclusive,
atomic write before invoking the model again. Reviewer family, stage, process
restart and claim concurrency cannot replenish the budget. A different head
gets a different key. Missing heads or unavailable storage refuse the retry
and retain a blocking review.

| Field | Meaning |
|---|---|
| `repo`, `prNumber`, `headSha` | Exact review subject and immutable revision. |
| `verdict_inconsistent` | Always `true`: the original review contradicted itself. |
| `status` | `reserved`, `reconciled`, or `operator-required`. |
| `reviewBody` | Original canonical review, retained as evidence. |
| `reconciledReviewBody` | Review after the bounded attempt, when it returns or fails. |
| `error` | Optional reconciliation failure message. |

A reservation is a permanent charge, including after an interrupted or failed
attempt. `reconciled` means the second review passed the reply contract and its
sections agree; it does not mean the review is permissive. `operator-required`
retains the blocking review. Receipt-update failure leaves the reservation
consumed. Files use mode `0600`, contain review evidence, and carry no credentials.
There is no automatic deletion or budget reset.

The reconciliation uses the original review's diff, context, stage and reviewer
selection, with an instruction to reconcile the sections and the previous review
as untrusted data. Size recovery still applies. Chunk contradictions survive
aggregation and share the whole head's single retry. Persistent contradictions
carry `<!-- verdict_inconsistent: true -->` and an operator notice in Summary.
Generated-review preservation retains this result for delivery retries.
Caller-post runtime outputs use the same reservation and retain the head in
their reconciliation request; the retry has a distinct runtime session identity.
