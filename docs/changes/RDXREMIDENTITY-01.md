# RDXREMIDENTITY-01

## Summary

Follow-up workspaces and local remediation workers can use a repository-specific
Git author and committer identity, such as a GitHub App noreply address.

## Interface changes

`REMEDIATION_WORKER_GIT_IDENTITY_REPO_OVERRIDES` maps lowercase repository slugs
and worker classes to complete name and email pairs. A matching pair takes
precedence over class-wide settings and built-in defaults. Malformed matching
configuration warns without printing its contents and uses the existing
fallback. See the [follow-up runbook](../follow-up-runbook.md).

The repository lookup checks the exact dispatch class first, then its harness
key. Workspace setup and local worker startup share that lookup.

## Verification

- `npm test -- test/follow-up-remediation.test.mjs` passed all 397 tests.
- `npm test -- test/arc19-boundary-gate.test.mjs` passed all 7 tests.
- `npm run lint` passed with zero errors.
- `npm run typecheck:contracts` passed.
- `bash demo/research-finding-walkthrough.sh` passed with three byte-stable
  transcript deliveries.
