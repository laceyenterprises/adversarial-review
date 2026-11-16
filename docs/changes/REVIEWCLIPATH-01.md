# REVIEWCLIPATH-01

## Summary

Resolve hq independently of the reviewer's restricted PATH. Command lookup and
spawn failures now stop as configuration errors and alert through the existing
bus. Preserve load-aware retries for transient timeout and protocol failures.
See the [SEV1 report](../postmortems/SEV1-REVIEWCLIPATH-01-resolver-command-path.md).

## Interface changes

No new CLI flags, durable statuses or gates. Existing
`reviewer-configuration-error` now covers resolver command lookup/spawn errors;
resolver failure evidence includes its failure class. HQ_BIN precedence is
caller then service; bare command lookup uses service PATH and invocation uses
an absolute path. The resolver receives the reviewer environment as before.

## Verification

All commands ran through the bounded worker validation wrapper.

- `npm test -- review-cli-resolver.test.mjs reviewclijson-01.test.mjs reviewer-spawn-settle.test.mjs reviewer.test.mjs reviewer-runtime-adapter.test.mjs`: 372 passed, zero failed.
- `npm run lint`: zero errors (existing warnings); ESLint `--fix` on changed source files also passed.
- `npm run typecheck:contracts`: passed.
- `bash demo/research-finding-walkthrough.sh`: passed with three byte-stable transcript deliveries.
- `npm test`: the 885-file offline run reached the existing 900-second runner limit after 16,020 passing results, with no `not ok` results reported; the full suite did not complete. Checked-in historical timing data for 832 files totals about 24,143 worker-seconds, exceeding this budget even at eight-way concurrency. The affected-path suite above completed green; the broad suite was not rerun.
