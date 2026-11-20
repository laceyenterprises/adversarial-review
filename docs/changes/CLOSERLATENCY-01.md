# CLOSERLATENCY-01

## Summary

Completed remediation queues its PR for an immediate closer decision. The
watcher can handle that event during an ongoing poll, using the existing
posted-review handler and closer custody checks. The coexistence caller
yields after 45 seconds, and a batch can share positive live launch evidence
across PR decisions.

Final remediation removes priority events for unmanaged repositories or missing
PRs and quarantines malformed JSON under the queue's `dead-letter/` directory.
The atomic writer already creates missing parent directories; a pre-startup
enqueue regression fixture pins that behavior without another directory write.

## Interface changes

The watcher reads durable priority events under `data/remediation-closer-queue/`.
Closure health and `ama.closer_queue_launch` record
`remediation_complete_to_closer_launch_seconds` for a confirmed launch.
Quarantined files retain their original names and bytes for manual inspection
and are excluded from retries, including after watcher restart.

## Verification

- `node test/run-tests.mjs test/remediation-closer-queue.test.mjs` passed all
  six offline fixtures for pre-startup enqueue, duplicate preservation,
  quarantine/restart, retryable exceptions and watcher terminal filters.
- `node scripts/validate-data-model-catalog.mjs` validated 100 entries after
  adding the dead-letter store.
- `node test/run-tests.mjs test/watcher-closure-latency.test.mjs
  test/watcher-claim-loop.test.mjs test/smv.test.mjs` passed all 240 tests
  under a 420-second command bound after the initial 240-second bound expired.
- `node --test test/watcher-closure-latency.test.mjs` passed completion
  priority, lease idempotency, timeout deferral, launch-status batching and
  latency telemetry fixtures.
- `node --test` passed the scoped closer reconciliation, closure recovery
  and follow-up job files. `npm run lint`, `npm run typecheck:contracts` and
  `bash demo/research-finding-walkthrough.sh` passed.
- See the [SEV1 report](../postmortems/SEV1-remediation-completion-waited-for-closer-dispatch.md).
