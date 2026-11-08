# DEADWATCHERLEASE-01

## Summary

Bind pending closer ownership to process start identity and reclaim dead or
reused local owners through the existing fenced abandonment path. Startup records
prior claims once, and the ticker now waits its interval before repeating. Confirmed
live owners retain custody after expiry; ordinary closer admission resumes
in the same evaluation. Reclaim audit names the previous owner.

See the [SEV2 report](../postmortems/SEV2-watcher-restart-left-closer-ownership-on-a-dead-process-2026-11-08.md).

## Interface changes

Optional lease field `watcherStartedAt` records the local owner's UTC process
start identity; older leases remain readable. Structured abandonment event
`ama_closer.abandoned_lease_reclaimed` includes the owner PID and start identity. Startup also emits
`ama_closer.startup_claim_observed` for inspected prior claims.
No new runtime option or lifecycle state.

## Verification

Each test command ran individually under the required network guard through
`python3 -m cwp_dispatch.worker_validation --repo-root . --timeout-seconds 600 --command`:

- `node --test test/ama-closer-lease.test.mjs`: 38 passed.
- `node --test test/ama-dispatch-submitter.test.mjs`: 14 passed.
- `node --test test/finalclose-01.test.mjs`: 75 passed.
- `node --test test/recovery-reaper.test.mjs`: 108 passed.
- `npm run lint`: zero errors (153 existing warnings).
- `npm run typecheck:contracts`: passed.
- Scoped `eslint --fix` and `git diff --check`: passed.

Only touched test files were run, as required by the ticket. The reaper suite
now imports the existing synthetic load fixture so direct execution does not
scale its expected deadlines with host load. No live recovery was performed.
