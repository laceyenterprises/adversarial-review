# REPODISCOVERY-01

## Summary

Failed startup organization discovery restores durable current repository names
with exclusions and persisted identity-conflict quarantine. Startup retries use
the earlier budget reset or bounded 2/5/10-minute backoff. A successful listing
replaces fallback scope and preserves the existing steady-state refresh cadence.
Zero-scope polls warn and emit one SEV2 discovery notice after two minutes per
continuous process-local empty episode. See the
[SEV1 report](../postmortems/SEV1-REPODISCOVERY-01-startup-budget-deferral-disabled-repository-discovery.md).

## Interface changes

No new configuration. Discovery adds an optional clock/logger injection for
offline tests, the additive `repository_discovery_quarantine(full_name)` table,
and the `adversarial-repository-discovery` event through the existing alert path.
Canonical discovery, storage and state documentation describe recovery behavior.

## Verification

- `node --test test/watcher-repository-discovery.test.mjs`: 10 synthetic tests passed, under netguard with a 600-second process-group timeout.
- `npm run lint`: passed with zero errors (153 existing warnings outside this change).
- `npm run typecheck:contracts`: passed.
- ESLint `--fix` on the changed source and test: passed without warnings or rewrites.

Only the touched test file is run, as required by the ticket. Full-suite and demo
execution are omitted under that scoped-validation constraint.
