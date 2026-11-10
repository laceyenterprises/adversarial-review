# REREVIEWDEFER-01

## Summary

Explicit re-review requests survive reviewer capacity, credential and queue waits.
The legacy expiry column now marks a load-scaled waiting observation; one notice
reports automatic retry. Head movement, terminal PR and budget fences still settle
requests. Positively unstarted launches return only their own session's intent.

Queued/running requests dismiss configured bots' strictly superseded Request
changes through SVD-02 after live head/state verification. Unreadable state
defers dismissal; moved/closed requests settle during admission holds. Human,
current-head and unprovable-head reviews remain.
Final remediation bounds unchanged live probes and failed dismissal retries to
once per five minutes, and memoizes successful checks per request/head in a
512-entry process-local cache per database handle. Periodic live probes still
settle moved/closed requests; a new request, changed discovery head, eviction or
restart permits a fresh check. No persistent store shape changes.
Daemon exact-head zero-finding attestation, strict mode, leases and hammer gates
are unchanged. No CI or configuration surface is added.

## Interface changes

Waiting notices never ask for label reapplication. Canonical
[store](../data-model/explicit-review-intents.md) and
[state](../STATE-MACHINE.md#explicit-same-head-re-review-intent-retriggerdedup-01)
contracts describe the retained schema and updated lifecycle.
Lifecycle declarations, generated README diagrams and the disposable refusal
smoke now describe waiting notices without expiry and session-scoped return of
positively unstarted launches. The review's missing-head-override and missing-
coalescing reports were checked against the reviewed head: both behaviors
already exist, so no redundant implementation changes were made.

## Verification

Each test file ran individually under netguard and `cwp_dispatch.worker_validation`
with a 600-second process-group bound; no full suite ran on the host.

- `node --test test/explicit-review-intent.test.mjs`: 13 passed.
- `node --test test/queued-review-dismissal.test.mjs`: 2 passed.
- `node --test test/watcher-claim-loop.test.mjs`: 164 passed, including overdue
  credential holds, moved/closed live heads during holds and split callback holds.
- `node --test test/reviewed-head-dispatch-gate.test.mjs`: 16 passed.
- `node --test test/follow-up-retrigger-review-label.test.mjs`: 15 passed.
- `node --test test/review-state.test.mjs`: 53 passed.
- `node --test test/watcher-daemon-clean-merge.test.mjs`: 125 passed, including
  strict findings, moved-head and missing-attestation refusals.
- `npm run lint`: zero errors; existing repository warnings remain.
- Scoped ESLint `--fix` on all changed source files: passed.
- `npm run typecheck:contracts`: passed.
- `bash demo/research-finding-walkthrough.sh`: passed with byte-stable deliveries.
- Both operator-only post-merge plans parse; the catalog fragment is valid JSON.

Final comment-only remediation validation:

- `node --test test/queued-review-dismissal.test.mjs`: 3 passed.
- `node --test test/explicit-review-intent.test.mjs`: 13 passed, including
  coalescing and label coalescing already present at the reviewed head.
- `NODE_OPTIONS=--test-name-pattern=RETRIGGERDEDUP-01 node --test test/watcher-claim-loop.test.mjs`:
  10 passed, including the already-wired `head-moved-held` override.
  An initial invocation lost the CLI name filter during sandbox re-execution
  and hit its 180-second bound; the environment filter correctly scopes the run.
- `node --test test/smv.test.mjs`: 11 passed, including disposable smoke.
  Reviewed and refreshed the four existing intent/dispatch source projections.
- `npm run lint`: zero errors (152 existing warnings).
- `npm run typecheck:contracts`, `bash demo/research-finding-walkthrough.sh`,
  `node scripts/validate-data-model-catalog.mjs` and `git diff --check`: passed.

All test commands used the checked-in bounded foreground runner. No full suite ran.
