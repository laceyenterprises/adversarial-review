# SEV2 | Watcher stranded deferred closer bundles

## Impact

On 2026-11-26, between 02:00 and 03:00 UTC, an inventory for Main Loop 6 and the evaluation bench showed 10 unpublished bundles and 62 attempts whose source matched the target. Two open PRs needed operator publication from the retained bundle, and three more open PRs had unpublished bundles. In one case, about 50 minutes elapsed after the review-service float without a replacement closer. These are incident-brief observations. Recovery verification in this repository uses synthetic fixtures.

## Timeline (UTC)

- By approximately 02:13, the four fixes for validation authority, unpublished round accounting, process inspection and cleanup permissions were live.
- A watcher tick emitted a hammer wake with `shared-next-action`. A terminal closer reconciliation logged that attempt 1 already had a reviewer pass. The deferred source stayed unpublished.
- The operator published two retained remediations with bundle-based PR updates. Other open PRs still had retained source.

## Cause and reproduction

`recordAmaCloserReviewerPassTokensOnce` returns early when accounting for a launch it already recorded. Dispatch continues after that return. The synthetic reproducer pre-recorded attempt 1, provided a bundled attempt with confirmed cleanup and ended the owner. `gateDeferredSourceCustody` then received `canonical-validation-operator-decision` from `observeDeferredSourceDecision`. A complete bundle let teardown release the old checkout, but the watcher treated the same unpublished bundle as an operator decision. An exhausted review or closer budget could also stop ordinary replacement before that gate ran.

## Resolution

A clean bundle with verified retention and confirmed cleanup selects a publication-only closer under normal PR ownership. The watcher uses the existing retry backoff settings and records the next due time on the attempt. The closer verifies the retained ref, replays it against current PR and base history, runs current canonical validation, and publishes with a head-bound lease. It records the exact published head and requests independent review. Ambiguous history or a failed replay leaves the bundle available. Operator holds and live owners take precedence.

After float, observe a naturally eligible `custody-redrive` wake and a new closer launch, then verify the same retained attempt records `matches-target` and its `publishedHead` matches the PR update. Confirm a subsequent watcher pass leaves the completed attempt alone and that the published head enters independent review. The [rollout observation plan](../../modules/worker-pool/post-merge-actions/CUSTODYREDRIVE-01.yaml) records this check.
