# Reviewer snapshots blocked by repo-local state (2026-09-27)

## Impact and detection

After adversarial-review #1129 reached the deploy checkout, new reviewer attempts stopped before model dispatch. The watcher remained alive and kept admitting queued work, but its child reviewers failed with `reviewer snapshot cache must be outside the source checkout`. The watcher log records this for agent-os #7079 at 00:07 UTC, agent-os #7062 at 00:08 UTC, and adversarial-review #1135 at 00:11 UTC. Older remediated heads, including adversarial-review #1131 and #1133, remained queued without a fresh verdict.

## Cause

#1129 correctly required a reviewer model to run from an immutable archive outside the source checkout. `reviewer.mjs` passed `resolveAdversarialReviewStateDir(ROOT)` to the new snapshot builder. With no `ADVERSARIAL_REVIEW_STATE_DIR` override, that resolver returns `ROOT/data`. For adversarial-review PRs, `ROOT/data` is inside the submodule checkout; for agent-os PRs, it is inside the parent checkout. The snapshot builder rejected both before any model launched. Tests supplied an external state directory, so they did not cover the production default.

## Recovery

REVIEWWS-02 resolves a separate workspace state directory for snapshots and subprocess audits. It preserves the review ledger and fence state locations. An explicit workspace override must be outside the source checkout; otherwise the reviewer uses an external existing state directory, `$HQ_ROOT/adversarial-review/reviewer-workspace`, or a per-user fallback. Regression tests exercise both production checkout shapes and the invalid override.

The watcher cannot review this gatekeeper repair while the deployed default fails before model dispatch. This is a recursive recovery under `docs/RUNBOOK-convergence-loop-merge-rules.md`: the exemption is limited to this repair, with exact-head CI and offline validation required before landing. The precedent is the 2026-05-11 silent-stall incident and its recovery PRs #76 and #78. Once deployed, retry pending exact-head reviews and confirm a new reviewer snapshot and verdict before resuming normal gatekeeper merges.
