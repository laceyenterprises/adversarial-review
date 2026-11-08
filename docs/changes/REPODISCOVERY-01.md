# REPODISCOVERY-01

## Summary

Failed startup organization discovery restores durable current repository names
with shared case-insensitive exclusions, persisted identity-conflict quarantine
and a fence for names with multiple historical repository IDs. Startup failures,
including repository-state lock contention, retry at the earlier budget reset
or bounded 2/5/10-minute backoff. A successful listing
replaces fallback scope and preserves the existing steady-state refresh cadence.
Quarantine write failures log a local error and retain the complete listing with
its in-memory conflicts, without recording a GitHub failure. Zero-scope polls
warn and emit one SEV2 discovery digest notice with an explicit recovery action
per continuous process-local empty episode. Retry deadlines and the two-minute
grace are checked at the next poll on or after they fall due. See the
[SEV1 report](../postmortems/SEV1-REPODISCOVERY-01-startup-budget-deferral-disabled-repository-discovery.md).

## Interface changes

No new configuration. Discovery adds an optional clock/logger injection for
offline tests, the additive `repository_discovery_quarantine(full_name)` table,
and the `adversarial-repository-discovery` event through the existing alert path.
Canonical discovery, storage and state documentation describe recovery behavior.
The quarantine table is registered in `docs/data-model/catalog.json`; the unused
`catalog.d/` fragment is removed. Lifecycle states, merge authority and smoke
promises remain unchanged. Discovery notices deliberately retain SEV2 digest
routing during startup recovery.

## Verification

- `node test/run-tests.mjs watcher-repository-discovery.test.mjs`: 16 tests passed
  under the offline runner and a 120-second bounded process-group supervisor.
- `node test/run-tests.mjs watcher-repository-discovery.test.mjs repository-identity.test.mjs alert-delivery.test.mjs`:
  131 tests passed.
- `node test/run-tests.mjs smv.test.mjs`: 11 tests passed, including disposable
  sandbox smoke and unchanged generated README state diagrams.
- `node test/run-tests.mjs watcher-claim-loop.test.mjs`: all 159 tests passed
  under a 600-second bounded supervisor (148 seconds elapsed). The initial
  combined claim-loop/state run reached its 120-second cap without assertion
  failures; the longer focused run completed.
- `npm run lint`: passed with zero errors (153 existing warnings outside this change).
- `npm run typecheck:contracts`: passed.
- `node scripts/validate-data-model-catalog.mjs`: passed, 90 entries validated.
- `bash demo/research-finding-walkthrough.sh`: passed, three byte-stable transcript deliveries.
- `git diff --check`: passed.

The worktree initially had no dependencies. Validation uses the installed service
checkout's dependencies through a local ignored symlink after confirming its
lockfile is byte-identical. The full local test suite is intentionally omitted
under the final remediation's explicit targeted-validation instruction; PR-head
CI owns the full-suite merge gate.
