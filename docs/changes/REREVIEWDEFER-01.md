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
Daemon exact-head zero-finding attestation, strict mode, leases and hammer gates
are unchanged. No CI or configuration surface is added.

## Interface changes

Waiting notices never ask for label reapplication. Canonical
[store](../data-model/explicit-review-intents.md) and
[state](../STATE-MACHINE.md#explicit-same-head-re-review-intent-retriggerdedup-01)
contracts describe the retained schema and updated lifecycle.

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
