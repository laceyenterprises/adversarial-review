# MLRKEYVOCAB-01

## Summary

Expand exact shadow-pattern classes to recognize fixed workflow reasons and
v1 next-action/adapter details. Repeated matching divergences can then use
reviewed pattern dispositions. See the [incident report](../postmortems/SEV3-shadow-pattern-key-vocabulary-missed-the-reasons-and-details-live-producers-emit-2026-11-16.md).

## Interface changes

No new commands or schema changes. Key format, version, element order and
null-detail behavior remain unchanged. Reports re-key history at read time,
including old evidence whose stored key is null. Pattern capture remains
append-time only, using the vocabulary after the normal watcher reload;
fold errors and dynamic text remain excluded.

## Verification

- Plain `node --test` across the eight required suites: 118 passed, zero failures.
- Plain `node --test` across exact-head review, queue cutover and shadow recorder:
  36 passed, zero failures. Both scoped commands were bounded to 600 seconds
  and used the required netguard environment with synthetic fixtures.
- `npm run lint`: zero errors (149 existing warnings).
- `npm run typecheck:contracts`: passed.
- `bash demo/research-finding-walkthrough.sh`: passed, three byte-stable deliveries.
- Full `npm test`: incomplete; the repository runner reached its 900-second
  limit after 5,061 passing tests, with no failed assertions reported before
  timeout. This does not establish a green repository-wide run.
- `git diff --check`: passed.
