# KEY-04 — Shared credential configuration namespace

## Summary

No Node credential mirror is needed under CFGREADERSCOPE-01. This service
does not read `credentials.*`; its existing unknown-key handling ignores the
entire sibling-owned namespace in checked-in configuration and local overlays.
Remove the proposed mirror so unfamiliar enforcement modes and non-boolean
cloud flags cannot introduce credential validation failures at Node startup.
Foreign credential subtrees are dropped rather than retained in `values`;
`cfg.get('credentials.enforcement', fallback)` returns the caller's fallback.

See the [reader ownership decision](../postmortems/SEV2-every-new-config-key-forced-workers-to-provision-the-review-service-repo-2026-10-31.md).
A future Node consumer must register the shared keys it actually reads in that
consumer's PR. This change requires no host configuration edit or activation.

## Interface changes

None relative to main: no credential keys or defaults are added to the Node
read surface. Review, closure, lifecycle and smoke contracts are unchanged.

## Verification

`node --test test/config-credentials.test.mjs test/config-loader-foreign-sections.test.mjs test/config-loader-runtime-tolerance.test.mjs test/config-loader.test.mjs`
passes all 304 tests offline. Credential regressions cover startup and runtime loads in both
top-level and local files, unfamiliar enforcement modes, a string cloud flag,
nested unknown `model_broker` and cloud keys, caller fallbacks and exclusion of
foreign data from resolved values.

`npm run lint` passes with zero errors (153 warnings);
`npm run typecheck:contracts`, `bash demo/research-finding-walkthrough.sh` and
`git diff --check` also pass. The full local suite was not run; PR-head CI owns it.
