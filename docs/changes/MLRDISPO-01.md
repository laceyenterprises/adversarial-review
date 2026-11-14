# MLRDISPO-01

## Summary

Repeated exact shadow divergences can receive an audited pattern disposition
that applies to future matching observations. Revocation and expiry stop new
application while preserving history. Unknown text and fold errors remain
outside auto-apply; individual overrides retain precedence.

## Interface changes

`finalization shadow-pattern add|list|revoke` manages pattern history. Add
requires an exact key, kind (`equivalent`, `v2-defect`, `policy`), principal,
note and matching evidence sample IDs; defects require a ticket reference.
An additive SQLite migration stores pattern records. Shadow payloads capture
the matching record and reports expose counts per pattern and disposition source.
See the canonical shadow data model and divergence triage guide for details.

## Verification

- Focused `node --test` run across all nine test files exercising the edited
  surfaces: 120 passed, zero failures, bounded to 600 seconds with the requested
  netguard environment. Includes synthetic clocks, two synchronized writers,
  schema compatibility, revoke/expiry, dedupe and override precedence.
- `npm run lint`: zero errors (existing warnings in unchanged files).
- `npm run typecheck:contracts`: passed.
- `bash demo/research-finding-walkthrough.sh`: passed, three byte-stable deliveries.
- `npm test test/finalization-shadow-pattern.test.mjs`: all nine new tests passed
  under the repository sandbox/preload runner.
- Full `npm test`: failed with five assertions in unchanged hammer self-rebase
  fixtures, then hit the repository runner's 900-second limit. The managed
  validation wrapper load-scales its nominal timeout. This full-suite result
  does not establish a green repository-wide run; affected suites pass above.
