# CUSTODYREDRIVE-01

## Summary

The watcher selects a publication-only closer for a clean, bundled validation deferral after the previous owner and cleanup settle. An already recorded reviewer pass can coexist with a new custody launch. The retry restores the retained commit on the original PR head, checks compatibility with the current base, runs canonical validation and publishes behind the existing Git head lease. Compatible changes preserve existing PR commit IDs. Confirmed publication settles the bundle and transfers the resulting head to independent review.

## Interface changes

The watcher exposes `custody-redrive` and `custody-redrive-backoff`. The private source receipt records retry timing, confirmed refusals, the validated candidate and its published head. The existing `closer_inconclusive_retry` settings bound both the delay and number of attempts. Confirmed non-launch restores the prior retry slot. A deterministic refusal, exhausted retry budget or moved head routes to `canonical-validation-operator-decision`. See the [SEV2 report](../postmortems/SEV2-CUSTODYREDRIVE-01-unpublished-closer-bundles-stranded.md).

## Verification

Before the fix, the synthetic fixture with a bundled attempt and a pre-recorded closer pass returned `canonical-validation-operator-decision` without launching. After float, an operator observes a naturally eligible attempt through its wake, launch, publication receipt and exact-head review. [Read-only observation plan](../../modules/worker-pool/post-merge-actions/CUSTODYREDRIVE-01.yaml)

The focused Node suites passed for dispatch, custody and replay. Lint reported zero errors. The kernel contract typecheck and offline research-finding walkthrough passed.

The custody CLI regression exercises prepare with distinct PR and base branch
heads. Prepare requires the PR head pinned by the retained launch intent and
fetches the current base branch to check merge compatibility. After a successful push, completion
rechecks a stale PR read up to twice. The regression covers confirmation on
the final retry, persistent staleness and a moved head. Settlement still
requires the exact validated candidate.

The wrapper audits a publication refusal with the controller's outcome. An
unconfirmed post-push candidate reports `review-handoff-unconfirmed` with the
candidate SHA. Offline tests cover historical-head fencing, reservation
refunds, conflict refusal and deduplicated operator surfacing.
