# SEV2 — a review-requested reversion became unprovable after a later review

Date: 2026-10-31. Ticket: REVERSALPROOF-01. Severity: SEV2, merge availability.
Status: source fix and synthetic regression coverage; live receipt pending
normal deployment and the next qualifying closure.

scars: merge.finding-remediation-and-authoritative-terminal

The preservation predicate belongs to this existing contract: finding repairs
must preserve author intent while permitting specifically authorized reversals.
Historical authority must remain provable after ordinary review and rebase work.

## Impact and generic timeline

A PR open for about 36 hours had all twelve findings remediated, passing targeted
tests and green exact-head CI. Two consecutive closure attempts stopped at
`primary-change-reverted`. An earlier closer had moved an author-added document
section because a non-blocking finding explicitly requested that move, with a
`Reversal-Authorized-By` trailer citing the review, finding and kind.

After a rebase, the authorization was refused as `reviewed-parent-patch-differs`.
After an exact-head review superseded the authorizing review, another attempt
reported `original-reversal-not-proven-before-supersession`. The new reviewer
saw the already moved section and had no reason to request the move again.
Undoing the requested repair was the remaining way to satisfy preservation.
No unsafe merge was observed. This report contains generic evidence only;
all regression content is synthetic.

## Cause

The collector could verify authority while the finding and matching parent
patch were available, but retained it only inside a head/base/review-keyed
history cache. Superseding reviews changed the key. Reconstructing the original
authorization then depended on later immutable review snapshots containing
the original reversal. If those snapshots did not prove it, the authorization
was lost. Rebase proof also required the entire parent patch to match the
reviewed patch, even when the specifically authorized region was unchanged.

This coupled a historical fact to mutable review currency and unrelated parent
changes. A fully remediated PR could become permanently unable to prove that
its completed repair was authorized.

## Correction and refusal boundaries

The canonical collector now persists a separate verified observation after the
shared evaluator proves a region's authorization. It binds the repository and
PR, reversal patch and trailers, original review/finding and parent snapshots,
and each verified region and removal/restoration direction. Observations use
the existing owned, atomic store and survive disposable history-cache expiry.
The history identity advances once to collect proof from older cached heads.

Later collection recomputes region equivalence against the recorded parent
patch. It rechecks live commit provenance, protected-closure ancestry, unique
content matching, recorded region scope, original finding coverage and current
HAM patch coverage. Context movement and unrelated preserved regions cannot
erase proof. Changed content, ambiguous matches, altered reversal patches and
never-verified citations still refuse. Non-blocking findings still authorize
only their cited region under effective strict policy.

There is no new check, gate, label, workflow, runtime option or merge bypass.
Current-head review and green required checks remain independent requirements.

## Validation and deployment receipt

Synthetic tests in `test/primary-change-reversal-rebase.test.mjs` exercise
verification followed by superseding review without an original snapshot,
changed head/base coordinates after rebase, preserved unrelated parent edits,
changed region and reversal content, never-verified citations, strict
non-blocking policy and recorded-region boundaries. Existing tests in the same
file cover primary-change and closer recovery behavior.
`test/primary-change-store.test.mjs` covers durable retention, repository/PR/patch
isolation, corrupt records and mode-0600 publication alongside existing
ownership and cache tests. Validation runs only the touched test files with
concurrency two under the required network guard.

Both touched test files pass. The successful supersession regression also
passes the shared merge-eligibility and closer-eligibility predicates.
Repository lint reports zero errors (existing warnings remain), contract
typechecking passes, all 84 data-model catalog entries validate, and the offline
research-finding demo converges with three byte-stable deliveries.
The full test suite was not run, honoring this ticket's targeted-test scope.

SRE live receipt: after normal deployment, observe the next PR whose verified
closer-authorized reversal is followed by a rebase or re-review. It should merge
through ordinary authority once all other gates pass, without
`primary-change-reverted`. That live observation is pending; this change performs
no live-state repair.
