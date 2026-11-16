# MCMRESOLVE-03

## Summary

Review CLI launches honor a validated optional metering launcher at synchronous
and asynchronous boundaries, including direct and launchctl Claude execution.
Resolution logs preserve the underlying CLI path, version and binary digest.

## Interface changes

Protocol v1 accepts optional `launcher: { path, sha256, routeKey }`. The path must
be absolute and name a regular executable file without a final symlink, with a
matching SHA-256 at launch. Accepted route keys are exactly `CLAUDE_CLI` and
`CLAUDE_CODE_CLI_PATH`. Invalid launchers fail closed with
`reviewer-configuration-error`; absent launchers retain existing behavior.
Discovery and failure classification preserve that configuration class.

## Verification

All commands ran through bounded `cwp_dispatch.worker_validation`:

- `npm test -- review-cli-resolver.test.mjs reviewclijson-01.test.mjs reviewer.test.mjs agent-runtime-local.test.mjs`: 292 passed, zero failed.
- `npm run lint`: zero errors (existing warnings).
- `npm run typecheck:contracts`: passed.
- `bash demo/research-finding-walkthrough.sh`: passed with byte-stable deliveries.

Synthetic fixtures cover both route keys and both path helpers, direct and
launchctl Claude spawn selection, retained binary evidence, absent launchers,
changed bytes, digest mismatch, symlinks, invalid metadata, missing files,
directories and non-executable files. Invalid selection prevents auth and spawn.
