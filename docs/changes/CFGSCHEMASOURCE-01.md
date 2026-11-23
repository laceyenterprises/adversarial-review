# CFGSCHEMASOURCE-01

## Summary

Validate config cascades against the shared generated schema in a deployed
Agent OS checkout. Use the bundled schema in standalone mode or when the
checkout contract is unavailable or cannot be compiled.

## Interface changes

The loader reports the selected schema and SHA-256 digest to stderr, including
the reason for a fallback. Cached reads track changes to the contract file.
The existing checkout variables and vendored module layout locate the contract.

Profile overlays use the same resolved schema for versioned and unversioned
documents. Direct calls to `contractSchemaPath()` use the process environment
when no environment is supplied. OSG arm validation checks the schema's
required fields when an arm definition is present.

Hammer keeps schema selection diagnostics in its logs and ignores them when
classifying retryable command failures. Checkout paths containing strings such
as `TLS` cannot turn a permanent GitHub error into a retry.

Consecutive identical schema diagnostics are suppressed. A return to an earlier
schema source or fallback reason is logged again. `contractSchemaPath(null)`
uses the process environment, and missing review-module paths are skipped when
inferring the checkout. The transient-error classifiers consume all filtered
stderr so an early match still succeeds with `pipefail` enabled.

## Verification

- `npm test -- config-schema-source.test.mjs` passed five synthetic cases
  covering local overlays, strict unknown-key rejection, standalone and
  deployed layout resolution, failure diagnostics and cached recovery.
- The config-loader, runtime-tolerance, CFG parity, OSG and role-config-cache
  suites passed individually.
- `npm run lint`, `npm run typecheck:contracts` and the offline research-finding
  walkthrough passed.
- Hammer's canonical targeted validation passed 776 tests across 17 files,
  including both profile overlay document forms, OSG required and optional
  fields, the default schema path, and CLI stderr contracts. Lint completed
  with zero errors. Contract typechecking and the offline walkthrough passed.
