# CUSTODYREDRIVE-01

## Summary

The watcher selects a publication-only closer for a clean, bundled validation deferral after the previous owner and cleanup settle. An already recorded reviewer pass can coexist with a new custody launch. The retry restores the retained commit on the original PR head, checks compatibility with the current base, runs canonical validation and publishes behind the existing Git head lease. Compatible changes preserve existing PR commit IDs. Confirmed publication settles the bundle and transfers the resulting head to independent review.

## Interface changes

The watcher exposes `custody-redrive` and `custody-redrive-backoff`. The private source receipt records retry timing, confirmed refusals, the validated candidate and its published head. The existing `closer_inconclusive_retry` settings bound both the delay and number of charged attempts. Confirmed non-launch restores the prior retry slot and clock. Infrastructure and inconclusive stops refund the slot and keep the clock. Deterministic refusals and confirmed publication rejections consume the slot. On the target head, disabled automatic recovery, deterministic replay refusal or exhaustion routes to `canonical-validation-operator-decision`. An unrelated head retains normal closer and daemon routing. See the [SEV2 report](../postmortems/SEV2-CUSTODYREDRIVE-01-unpublished-closer-bundles-stranded.md).

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
candidate SHA. Offline tests cover unrelated-head routing, reservation refunds,
conflict refusal and deduplicated operator surfacing.

Historical markers are read to reconcile a live head that exactly matches the
retained source or validated candidate. Completion diagnostics include
observed and expected heads and distinguish a stale source-head read, branch
divergence and failed custody settlement. Fast-forward publication relies on
the PR-head lease after base movement. A rewrite also requires the validated
base to match the base branch at publication.

Final advisory validation passed all 26 custody tests, 43 Node-pin and
inconclusive-retry tests, and the three focused state-projection checks.
Lint had zero errors; contract typechecking, the offline walkthrough,
data-model catalog validation and `git diff --check` passed.
The custody/claim-loop selection in `watcher-claim-loop.test.mjs` reached the
90-second local bound without a test verdict; PR-head CI owns the full suite.

The Node 26 CI log reported two failures in `test/smv.test.mjs` because the
closer-successor source fingerprint predated the exact-head custody change.
Refreshed the fingerprint after checking that the existing successor states and
transitions still describe the code. The independent graph and smoke contract
are unchanged.

The offline custody wrapper fixture passes only its own process environment so
a live close controller cannot interfere with the simulated publication and
audit.
