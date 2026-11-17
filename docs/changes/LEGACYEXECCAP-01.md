# LEGACYEXECCAP-01 — legacy lane writer run budget

## Summary

The legacy lane writer reused its lock/route wait budget (30 s nominal, at most
60 s, shrunk by the lane deadline) as the run budget of the whole wrapped
command. A wrapped dispatcher that provisions a workspace needs 25–90 s under
load, so it was terminated 25–60 s in. Node's `execFile` timeout also destroys
the child's pipes before signalling, so the child's final flush failed (a Python
child exits 120, not 143) and its later output was lost.

The wrapped command now has its own budget, `loadAwareTimeoutMs(240000,
{ maxMs: 600000 })`, applied after the route/issuance lock is held. The lane
deadline still bounds only the wait and still refuses with
`legacy writer deadline expired` when already spent. Expiry runs through
`runCommandKeepingOutput` (SIGTERM, 10 s grace, SIGKILL, read until close) and
returns `{ ok: false, reason: 'legacy writer command timed out after <ms> ms' }`
with the captured stdout/stderr.

## Interface changes

- `--timeout-ms <n>` on `bin/legacy-lane-write.mjs` and `bin/legacy-pr-write.mjs`;
  `timeoutMs` option on `runLegacyLaneWrite`/`runLegacyPrWrite`. Positive integer
  up to 3600000, otherwise exit 64 (TypeError in the library).
- On a timeout both bins print the child's stdout/stderr, then one reason line,
  and exit 75 (unchanged deferred status). Exit codes, stdout/stderr relay and
  `maxBuffer` (64 MiB) otherwise behave as before.
- New exported helper `src/run-command-keeping-output.mjs`.
- Three existing assertions that pinned the old coupling (`exec` received the
  remaining lane wait as `timeout`) now assert the independent run budget.

## Verification

`node --test` over `legacy-lane-write-run-budget`, `finalization-queue-routing`,
`finalization-legacy-actor`, `finalization-cli-timeout-stderr`, the three
`load-aware-*` suites, `hamunknown-02`, `hamverdictready-01`,
`hammertrim-contract`, `hammer-controller`: all pass. `withdrawn-review-dismissal`
has 3 failures that are identical on the unmodified base. `npm run lint` has
0 errors; `npm run typecheck:contracts` is clean.
