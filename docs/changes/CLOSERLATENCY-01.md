# CLOSERLATENCY-01

## Summary

Completed remediation queues its PR for an immediate closer decision. The
watcher can handle that event during an ongoing poll, using the existing
posted-review handler and closer custody checks. The coexistence caller
yields after 45 seconds, and a batch can share positive live launch evidence
across PR decisions.

## Interface changes

The watcher reads durable priority events under `data/remediation-closer-queue/`.
Closure health and `ama.closer_queue_launch` record
`remediation_complete_to_closer_launch_seconds` for a confirmed launch.

## Verification

- `node --test test/watcher-closure-latency.test.mjs` passed completion
  priority, lease idempotency, timeout deferral, launch-status batching and
  latency telemetry fixtures.
- `node --test` passed the scoped closer reconciliation, closure recovery
  and follow-up job files. `npm run lint`, `npm run typecheck:contracts` and
  `bash demo/research-finding-walkthrough.sh` passed.
- See the [SEV1 report](../postmortems/SEV1-remediation-completion-waited-for-closer-dispatch.md).
