# CFGNODESCHEMA-01

## Summary

Refresh the bundled config schema and environment aliases from the shared
contract. The previous schema rejected valid checked-in keys before the
strict loader could finish validating the file.

## Interface changes

`loadConfig` accepts `worker_pool.work_items.shadow_gate_days` as a positive
integer with a default of `7`. The refresh also registers
`worker_pool.admission.low_priority_max_wait_seconds`,
`worker_pool.admission.low_priority_reserved_slots`,
`disk_reclaim.archive_ref_retention_days`, and
`disk_reclaim.dehydrate.unreclaimable_recheck_hours`.

## Verification

`node --test test/config-cfg-parity.test.mjs` passed all 76 tests. The new
cases compare both loaders on all five settings and on zero and fractional
shadow durations.

The final advisory remediation moves those three cases to
`test/fixtures/cfg-parity-cases.cfgnodeschema-01.json`, recorded with the Python
loader at agent-os `0dccb53077d9de74b91c7e2dc283f0078dcecb18`. The original
fixture keeps its original source revision. The recorder documentation now
explains that fixture cases are its inputs and survive recording; independently
recorded revisions use separate files loaded by the same offline Node suite.

Regeneration (with a clean checkout at that revision):

```sh
PYTHONPATH=<agent-os>/platform/agent-os-config/src \
  python3 scripts/record-cfg-parity-cases.py \
  test/fixtures/cfg-parity-cases.cfgnodeschema-01.json
```

Final remediation verification: the parity and ONS-07 rescue suites passed
all 90 tests; recording the new fixture again was byte-identical. `npm run
lint` passed with zero errors (147 existing warnings), `npm run
typecheck:contracts` passed, and `bash demo/research-finding-walkthrough.sh`
passed. The full suite is left to PR-head CI.
