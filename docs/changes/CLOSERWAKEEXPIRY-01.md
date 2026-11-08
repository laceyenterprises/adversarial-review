# CLOSERWAKEEXPIRY-01

## Summary

Expired unacted hammer wakes can reserve a new audited attempt. AMA closer
dispatch uses the current head when no reviewed head exists and emits a
deduplicated alert with a named refusal when neither head is known.
See the [SEV1 report](../postmortems/SEV1-expired-closer-wake-and-missing-reviewed-head-2026-11-08.md).

## Interface changes

Wake audits add optional `supersedes` and `wakeDeadline` fields. AMA bootstrap
audits explicitly retain null `reviewedHead`/`reviewSha` provenance when the
current head supplies the audit anchor. Missing-head dispatch returns
`ama-head-unavailable` and alerts through the existing closure-wait path.
No configuration, CI job, review budget or merge predicate changes.

## Verification

Each touched test file ran separately through the worker validation wrapper,
with a 600-second command bound and the prescribed NETGUARD environment:

- `node --test test/hammer-wake-next-action.test.mjs`: 52 passed.
- `node --test test/ama-closer-dispatch-priority.test.mjs`: 320 passed.
- `node --test test/smv.test.mjs`: 11 passed, including the disposable offline
  smoke and its expiry/missing-head handoff evidence.
- `npm run lint`: zero errors, 152 warnings.
- `npm run typecheck:contracts`: passed.
- `git diff --check`: passed.

Only touched test suites were run, as required by the ticket. No live recovery
operation or production acceptance observation was performed.
