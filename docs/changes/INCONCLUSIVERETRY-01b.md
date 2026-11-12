# INCONCLUSIVERETRY-01b

## Summary

A closer result that cannot conclude is now an owned retry with backoff. It
never counts as a closer failure, never spends closer budget and never ends the
PR's automated path. A real refusal stays terminal and counted. One classifier
and one owned-retry record (`src/ama/closer-inconclusive-retry.mjs`) serve both
sites. The classifier reuses the HAMSELFERRORS-01 stop-origin registry and adds
only the launch-level failures that registry cannot see.

- **Ended launch.** An inconclusive ended or never-started launch on an unmoved
  head is refunded in full and spends no CLOSERRETRY key. The watcher records
  it with owner, attempt, reason, next time and deadline. From attempt N the
  delay doubles, and the owner is notified once through the existing closure-wait
  page. The HAMSELFERRORS-01 `closer-self-error-budget-exhausted` park is removed.
- **`closure-retry-exhausted`.** A budget spent only by owned inconclusive
  launches is refunded rather than paged. Real exhaustion pages once with the
  PR, reason and recommended next action, and the result names its owner.
- **Correction refusal.** A closer fault that asks for correction (exit 21) now
  leaves its diagnostic last-phase receipt. A `succeeded` launch that ended
  before correcting, and pushed and merged nothing, is therefore classified.
- **Conflict proof.** The helper now exits 75, recorded as
  `conflict-primary-failed`, when the preservation proof could not run (a git
  or input failure). `conflict-primary-unproven` remains for a proof that shows
  a primary-line conflict.

## Interface changes

- New config keys (Node reader only):
  `roles.adversarial.merge_authority.closer_inconclusive_retry.{surface_after_attempts,backoff_base_ms,backoff_max_ms}`,
  with defaults 3, 300000 and 3600000. They are exposed as
  `getMergeAuthorityConfig().closerInconclusiveRetry`. The Python and shell
  mirrors belong to sibling INCONCLUSIVERETRY-01. Leave the keys unset until
  then.
- New store: `data/follow-up-jobs/closer-inconclusive-retries/`
  ([data model](../data-model/closer-inconclusive-retries.md)).
- New closure-wait class `closer-inconclusive` and new alert event
  `ama_closer.inconclusive_retry_surfaced`. These replace `closer-self-error` and
  `ama_closer.self_error_exhausted`.
- New dispatch result reason `closer-inconclusive-retry-backoff`, with
  `recoveryWait` and `ownedRetry`.
- `refundCloserSelfError` no longer refuses at three refunds per head and no
  longer returns `exhausted`. `HAMMER_SELF_ERROR_REFUND_LIMIT` is removed.
- `proveConflictPrimary` accepts an optional `onRefusal(kind)` callback, where
  kind is `conflict` or `unavailable`. `bin/hammer-conflict-primary.mjs` exits
  75 when the proof could not run.
- No CI check, label, gate or live action.

## Verification

All test commands ran under the netguard prefix with
`ADVERSARIAL_REVIEW_TEST_TEMP_BASE=/tmp`, using `node test/run-tests.mjs`:

- The 171 test files that import the edited closer, retry-cap, escalation,
  orchestration or config modules: 7,391 passed, 0 failed, 1 skipped.
- The 41 files that touch the terminal audit, conflict proof, prompt template
  or hammer outcome: all green after the expected contract updates.
- `test/inconclusiveretry-01b.test.mjs`: 12 tests. An ablation of the
  last-phase receipt turns the succeeded-launch test red.
- `npm run lint` reports 0 errors. `npm run typecheck:contracts` passes. The
  byte-equivalence demo passes. `node scripts/validate-data-model-catalog.mjs`
  passes.

The rendered hammer prompt stays under its 60 KiB budget.
