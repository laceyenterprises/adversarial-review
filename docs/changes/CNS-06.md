# CNS-06 — Bounded dispatch config visibility

## Summary

Mirror Python-owned `sentinel.cns.auto_dispatch` settings in the Node reader:
shadow by default, fixed normal priority/claude-code, family and severity policy,
hourly cap, daily token envelope and fingerprint cooldown. Unread CNS sibling
fields remain tolerated. This is configuration visibility only; no review,
paging or worker dispatch behavior changes. Activation belongs to CNS-11.

The final remediation moves this new note to the canonical `docs/changes/`
directory and pins all ten declared policy defaults in the parity test.

## Interface changes

The Node configuration reader accepts the Python-owned `sentinel.cns.auto_dispatch`
declaration. This remediation adds no further interface or runtime changes.

## Verification

`node --test test/config-module-parity.test.mjs` passes all 9 tests, including
assertions for family lists, minimum severity, worker token budget and cooldown.
`git diff --check` passes.
