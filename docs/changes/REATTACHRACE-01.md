# REATTACHRACE-01

## Summary

Reviewer reattach no longer treats missing launch-time builder context as proof
of family ineligibility. It recovers the builder from durable reviewer-pass
metadata for the exact claimed session, runs process adoption and launch guards
before family classification, and retains sticky refusal for known refused pairs
before posted-review settlement.

Missing or incomplete launches remain reviewing through their existing guard.
After expiry without a posted review, ordinary bounded dead-process recovery
can re-arm pending or quarantine failed at the recovery cap. A posted review
requires verified eligible builder context before runtime or delivery settlement;
unresolved posted identity becomes sticky `failed-orphan`. This guard covers both
null and persisted PGIDs. Existing launch-intent timeout protection, head checks,
family policy and waivers remain in force.

Durable fallback reuses prepared statements per database and selects the newest
exact-session pass with builder context rather than deserializing all pass
history in JavaScript. Canonical `rereview` remains unchanged; read compatibility
also accepts `re-review` and session keys `sessionUuid` and `session_uuid` after
`reviewerSessionUuid`. Malformed JSON and unrelated sessions are excluded.

## Interface changes

None. No schema, configuration, CI, gate or label changes.

## Verification

Focused offline tests cover missing/incomplete records, guard expiry, durable
session-matched fallback, unrelated-session rejection and genuine family refusal.
Each command used the bounded `cwp_dispatch.worker_validation` runner with
`NETGUARD_LOG` and the required netguard `PATH`, with a 600-second timeout:

- `node --test test/watcher-reattach.test.mjs`: 71 passed.
- `node --test test/reviewer-reattach-posted-review-probe.test.mjs`: 9 passed.
- `node --test test/reviewer-attribution.test.mjs`: 15 passed.
- `node --test test/smv.test.mjs`: 11 passed, including sandbox smoke.
- `node --test test/watcher-claim-loop.test.mjs`: 168 passed.
- `npx --no-install eslint --fix src/reviewer-reattach.mjs test/watcher-reattach.test.mjs`: passed.
- `npm run lint`: zero errors; 149 warnings in existing unrelated code.
- `npm run typecheck:contracts`: passed.
- `bash demo/research-finding-walkthrough.sh`: passed byte-equivalence demo.

The full test suite was not run, per the ticket's scoped-validation constraint.

After the normal AR float and watcher restart, SRE verifies PID start time and
observes 24 hours with no new family-message `failed-orphan` rows whose run record
shows an eligible builder/reviewer pair. This worker makes no live changes.
The operator handoff is declared in
`modules/worker-pool/post-merge-actions/REATTACHRACE-01.yaml` relative to this AR
repository, or `tools/adversarial-review/modules/worker-pool/post-merge-actions/REATTACHRACE-01.yaml`
from Agent OS. It is a manual reference here, not proof the superproject action
runner can discover it. Installing/registering a plan in the superproject and
correcting its PR deployment declaration remain a superproject/operator
follow-up; no superproject files or PR metadata were changed by this remediation.

### Final comment-only round

- Focused reattach (85), posted-review probe (9), attribution (15) and SMV
  (11) tests passed: 120 tests, including the new settlement and compatibility
  regressions. The combined run's claim-loop file exited without reporting
  individual results; `node test/run-tests.mjs watcher-claim-loop.test.mjs`
  then passed all 168 tests under a 300-second bounded foreground run.
- `npm run lint` passed with zero errors and 149 existing warnings.
- Changed-source/test ESLint, `npm run typecheck:contracts`,
  `node scripts/validate-data-model-catalog.mjs` (94 entries),
  `bash demo/research-finding-walkthrough.sh` and `git diff --check` passed.
- The full suite remains assigned to PR-head CI. No additional adversarial
  review is requested for this final comment-only round.
