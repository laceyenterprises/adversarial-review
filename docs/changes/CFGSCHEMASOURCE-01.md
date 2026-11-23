# CFGSCHEMASOURCE-01

## Summary

Validate config cascades against the shared generated schema in a deployed
Agent OS checkout. Use the bundled schema in standalone mode or when the
checkout contract is unavailable or cannot be compiled.

## Interface changes

The loader reports the selected schema and SHA-256 digest to stderr, including
the reason for a fallback. Cached reads track changes to the contract file.
The existing checkout variables and vendored module layout locate the contract.

## Verification

- `npm test -- config-schema-source.test.mjs` passed five synthetic cases
  covering local overlays, strict unknown-key rejection, standalone and
  deployed layout resolution, failure diagnostics and cached recovery.
- The config-loader, runtime-tolerance, CFG parity, OSG and role-config-cache
  suites passed individually.
- `npm run lint`, `npm run typecheck:contracts` and the offline research-finding
  walkthrough passed.
