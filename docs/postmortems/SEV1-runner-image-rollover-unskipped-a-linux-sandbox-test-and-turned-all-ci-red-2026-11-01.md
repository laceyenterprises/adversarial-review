# SEV1 — runner image rollover unskipped a Linux sandbox test and turned all CI red

Date: 2026-11-01. Ticket: ARCIPIN-01. Severity: SEV1.
Status: runner pin prepared; recovery requires green CI on both Node versions.

scars: none

The incident-history search returned no matching records for runner image
rollover exposing a previously skipped sandbox test. The available CI-cost
contract concerns spend and shared gates, rather than this sandbox capability
change; this report does not assign it an unrelated hardening contract.

## Impact

All review-service CI runs on main and pull requests failed after the runner
image changed. Required CI could not pass, blocking merges into the review
service repository.

## Evidence and timeline

The following summarizes the incident evidence supplied with ARCIPIN-01:

- At 00:10 UTC on 2026-11-01, the last green main run used `ubuntu-24.04`,
  image version `20261025.353.1`. The native sandbox test in
  `test/derived-artifacts.test.mjs` skipped because `bwrap` was unavailable
  (`spawnSync bwrap ENOENT`).
- From 00:35 UTC, main and pull request runs used `ubuntu-26.04`, image version
  `20261025.179.1`. Both Node 22 and Node 26 failed the same test:
  “native sandbox rebuilds archives and denies network, host file reads and
  writes.”
- With `bwrap` available, the test ran and reported a missing expected
  rejection when a sandboxed Node process wrote a synthetic host file in a
  temporary directory.
- The commit at the first red main run changed neither sandbox code nor
  derived-artifact code. The workflow selected `ubuntu-latest`.

## Cause

The floating runner label selected a newer operating-system image whose
available sandbox tools differed from the last green image. The presence of
`bwrap` activated existing Linux sandbox coverage and exposed a host-write
isolation failure. The runner rollover triggered the CI outage; the underlying
Linux sandbox defect is tracked separately by ARSANDBOXLINUX-01.

The earlier green runs had skipped this coverage because the sandbox tool was
missing. They therefore provided no evidence that Linux host-write isolation
worked.

## Recovery

Pin the existing npm test job in `.github/workflows/test.yml` to
`ubuntu-24.04`, the image family used by the last green run. The accompanying
comment names ARSANDBOXLINUX-01 as the condition for moving back to the newer
image. The Node matrix, workflow steps and test files remain unchanged.

This restores the prior runner selection; it does not repair Linux sandbox
isolation. No test skip or assertion is added or weakened.

## Verification and follow-up

Local validation is limited to YAML validity, as required by this ticket.
GitHub CI is the acceptance gate: both Node 22 and Node 26 must pass on
`ubuntu-24.04`, and the native sandbox test must skip for the same unavailable
`bwrap` reason as the last green run. These results remain pending until the
pull request runs complete.

ARSANDBOXLINUX-01 owns the Linux sandbox fix and validation needed before
returning this job to the newer image.
