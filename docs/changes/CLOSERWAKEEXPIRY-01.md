# CLOSERWAKEEXPIRY-01

## Summary

Expired unacted hammer wakes can reserve a new audited attempt. AMA closer
dispatch reconciles existing custody before refusing missing reviewed-head
evidence with a deduplicated alert. Wake targets never fill live-head metadata.
See the [SEV1 report](../postmortems/SEV1-expired-closer-wake-and-missing-reviewed-head-2026-11-08.md).

## Interface changes

Wake audits add optional `supersedes` and `wakeDeadline` fields. AMA bootstrap
dispatch refuses new launches without review provenance: `ama-reviewed-head-unavailable`
with a known current head, otherwise `ama-head-unavailable`. Both alert through
the existing closure-wait path. Catalog fields live in the canonical catalog.json.
No configuration, CI job, review budget or merge predicate changes.

## Verification

Targeted offline validation (full local suite intentionally omitted per the
remediation worker contract):

- `node test/run-tests.mjs test/ama-closer-dispatch-priority.test.mjs`: 327 passed.
- `node test/run-tests.mjs test/hammer-wake-next-action.test.mjs`: 52 passed.
- `node --test test/smv.test.mjs`: 11 passed, including the disposable smoke
  and missing-review refusal before prompt rendering.
- `npm run lint`: zero errors, 152 existing warnings.
- `npm run typecheck:contracts`: passed.
- `node scripts/validate-data-model-catalog.mjs`: 91 entries validated.
- `bash demo/research-finding-walkthrough.sh`: byte-equivalence demo passed.
- `git diff --check`: passed.

The initial dispatch run passed 324 cases; expanded custody coverage passed
in the final dispatch run. An attempted name-filtered run was redirected by the
repository sandbox runner to the whole file and exceeded its 120-second bound;
validation uses the explicit file runner with a 600-second bound instead.

Wake successor-chain caps/backoff remain a non-blocking follow-up. No live
recovery operation or production acceptance observation was performed.
