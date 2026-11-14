# TENUREGATE-01 — honor optional tenure routing and isolate read failures

## Summary

Disabled tenure performs no watcher or shared-reader tenure reads. Enabled
watcher read failures skip tenure queueing, warn once per PR/head per process
and continue ordinary review and closure handlers. Unknown tenure remains
unknown in closer suppression. See the [SEV1 report](../postmortems/SEV1-TENUREGATE-01-disabled-tenure-routing-stopped-pr-polls-2026-11-14.md)
for supplied impact evidence and the separate dispatch-grant diagnosis.

## Interface changes

The existing config reader mirrors `worker_pool.tenure.enabled` (default false)
and `AGENT_OS_WORKER_POOL_TENURE_ENABLED`. No new fleet key, durable field,
CI check, merge gate or lifecycle value is introduced.

## Verification

Scoped tests run serially through the managed validator with 600-second bounds
and the required `NETGUARD_LOG` and netguard `PATH`; live dispatch/observation
flags were disabled for the offline fixtures.

- `node --test test/ten-06.test.mjs`: 30 passed.
- `node --test test/watcher-claim-loop.test.mjs`: 185 passed.
- `npm run lint`: zero errors, 149 existing warnings; changed-file ESLint
  with `--fix` passed.
- `npm run typecheck:contracts`: passed.
- Watcher state projection, state/smoke JSON parsing and `git diff --check`: passed.

Initial fixture setup and admission assertions were corrected before the
passing reruns. The ticket's touched-file test restriction superseded the
full-suite/demo convention. No live activation or recovery is claimed.
