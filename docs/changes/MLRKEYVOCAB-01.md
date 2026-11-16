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

Final comment-round remediation keeps unknown legacy owners, wait/review reasons
and explicit terminal reasons unkeyable through distinct `unmapped-legacy-*`
details. A terminal observation with no reason still uses `terminal-observed`.
Known review and terminal mappings keep their exact details; hammer/page
pass-through text keys only when its resulting detail is explicitly allowlisted.
The vocabulary also includes the workflow's default terminal recovery reason,
`automated stop requires relevant evidence`. The canonical data-model table and
catalog describe these boundaries. No lifecycle state or smoke promise changes.

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

Final comment-round validation after rebasing onto freshly fetched `origin/main`:

- `node --test test/finalization-shadow-pattern.test.mjs test/pr-next-action.test.mjs test/pr-next-action-shadow.test.mjs test/finalization-live-shadow.test.mjs test/finalization-workflow.test.mjs`:
  371 passed, zero failures. Includes pattern-application regressions for unknown
  adapter inputs, preserved exact pass-through mappings and the actual workflow
  default terminal recovery producer.
- `npm run lint`: zero errors (149 existing warnings).
- `npm run typecheck:contracts`: passed.
- `bash demo/research-finding-walkthrough.sh`: passed, three byte-stable deliveries.
- `node scripts/validate-data-model-catalog.mjs`: passed, 98 entries.
- `git diff --check`: passed.
- Full-suite validation remains the PR-head CI merge gate; this final round
  intentionally runs targeted tests only, per its governing worker instructions.
