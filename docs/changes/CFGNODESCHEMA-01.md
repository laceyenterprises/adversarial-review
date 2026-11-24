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

The loader builds the code-default values and their provenance once from
the bundled schema. Each load clones that baseline before applying files,
environment aliases, or CLI overrides.

## Verification

Hammer added an internal `_resetCodeDefaultsForTesting()` hook in
`src/config-cascade.mjs` so an in-process test can rebuild the memoized
values and their provenance on the next load. The extended parity fixture
records below-minimum and fractional inputs for each of the four admission
and disk reclaim settings. Re-recording at the same Python revision produced
byte-identical output.

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

The final fix-all round revalidated all 90 targeted tests after a fresh base
fetch and rebase, and reproduced the three-case fixture twice from an archive
of its declared Python revision with byte-identical results. Lint, contract
typecheck, and the offline walkthrough passed again. The earlier Node 22 CI
failure in run `45189283580` exhausted the 900-second suite deadline; the same
deadline failure occurred on main in run `45152911652`. No runtime or CI
configuration change was needed for the fixture provenance finding.

## Node 22 suite deadline

Four PR attempts reached the 900-second deadline with eight active
file workers and 114 to 287 files still queued. No assertion failure
appeared in their TAP output. The rerun's 19,216 case names with
matching occurrence counts took 6,369 seconds of overlapping case time,
compared with 4,840 seconds at the original base and 4,430 seconds on
current main. Main also had a prior deadline failure. These runs show
lower suite throughput on the affected jobs. The logs do not identify the
cause of the difference between individual hosted runners.
[PR rerun](https://github.com/laceyenterprises/adversarial-review/actions/runs/45201815346/job/137799645792)
· [original base](https://github.com/laceyenterprises/adversarial-review/actions/runs/45157516305/job/137634134250)
· [current main](https://github.com/laceyenterprises/adversarial-review/actions/runs/45205266280/job/137799139281)
· [earlier main timeout](https://github.com/laceyenterprises/adversarial-review/actions/runs/45152911652/job/137618515679)

On local Node 22.22.3, a probe that passed the old and refreshed schemas
through the same code found comparable costs for default construction,
flattening and path writes. The generated schema and aliases are loaded
once per process. The config cache watches input files and relevant
environment values, and neither parity fixture invokes the Python recorder.

A CPU profile of uncached loads attributed about half the samples under
the loader to rebuilding, flattening and writing the same defaults.
Reusing the baseline removes that work from each load while preserving
independent values and traces. In three interleaved batches of 400 loads
of a synthetic YAML file, median process CPU time was 2.82 seconds on
main, 3.51 seconds on the original branch and 1.89 seconds with the fix.
Cached loads used 0.09–0.10 seconds per batch. The suite retains its
existing worker count and deadline.

All 1,415 tests across 36 config and cache files passed with the offline
runner on Node 22.22.3. Lint, contract typecheck and the offline walkthrough
passed.
