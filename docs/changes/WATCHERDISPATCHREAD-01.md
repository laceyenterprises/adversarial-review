# WATCHERDISPATCHREAD-01

## Summary

Phase 0 reproduced the service-session opener launch refusal in both dispatch
readers: `dispatch-read-unavailable`, detail `dispatch absence scope unproven`.
Provenance returns the opener, but dispatch lookup returns filtered
`not_found` with `scope_complete: false`. Other launch reads succeed through
the same session. This is a report-only producer-repair handoff, as required
by the ticket; no runtime code or authorization semantics change.

The [SEV1 report](../postmortems/SEV1-WATCHERDISPATCHREAD-01-filtered-opener-launch-reads-2026-11-16.md)
records sanitized request/response shapes, evidence limits, sibling symptoms
and the activation lesson.

## Interface changes

None.

## Verification

Read-only service-session probes confirmed registration, affected opener
provenance, both reader refusals and positive historical-launch controls.

All commands below ran through the bounded `cwp_dispatch.worker_validation`
wrapper:

- `node test/run-tests.mjs dispatch-read-client.test.mjs dispatch-read-context.test.mjs ten-06.test.mjs`:
  82 tests passed across three files.
- `npm run lint`: passed, zero errors and 149 existing warnings.
- `npm run typecheck:contracts`: passed.
- `bash demo/research-finding-walkthrough.sh`: passed with three byte-stable
  transcript deliveries.

The ticket requests narrow validation; the full suite was not run. No source,
test, CI or runtime configuration files changed.
