# CUSTODYREDRIVE-01

## Summary

The watcher selects a publication-only closer for a clean, bundled validation deferral after the previous owner and cleanup settle. An already recorded reviewer pass can coexist with a new custody launch. The retry restores the retained commit, rebases against current history, runs current canonical validation and publishes behind the existing Git head lease. Confirmed publication settles the bundle and transfers the resulting head to independent review.

## Interface changes

The watcher exposes `custody-redrive` and `custody-redrive-backoff`. The private source receipt records retry timing, the validated candidate and its published head. Retries use the existing `closer_inconclusive_retry` backoff settings. See the [SEV2 report](../postmortems/SEV2-CUSTODYREDRIVE-01-unpublished-closer-bundles-stranded.md).

## Verification

Before the fix, the synthetic fixture with a bundled attempt and a pre-recorded closer pass returned `canonical-validation-operator-decision` without launching. After float, an operator observes a naturally eligible attempt through its wake, launch, publication receipt and exact-head review. [Read-only observation plan](../../modules/worker-pool/post-merge-actions/CUSTODYREDRIVE-01.yaml)

The focused Node suites passed for dispatch, custody and replay. Lint reported zero errors. The kernel contract typecheck and offline research-finding walkthrough passed.
