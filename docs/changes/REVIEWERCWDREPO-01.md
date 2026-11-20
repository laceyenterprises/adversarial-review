# REVIEWERCWDREPO-01 — Bind reviewer workspaces to the reviewed repository

## Summary

The reviewer and Argus share a checkout resolver that verifies the full
GitHub origin. The reviewer archives the requested PR commit and uses an empty
read-only workspace when the commit cannot be materialized. The review body
records diff-only mode, and legacy saved bodies are ineligible for redelivery.
Harnesses start in an empty directory; the PR-head archive is exposed only as
an evidence path, preventing automatic project settings, hooks and memory loads.
Escaping PR symlinks recover to diff-only mode. Commit fetch shares bounded
transient Git retries, disables auto-maintenance, respects caller environment
and accepts SHA-256 commit IDs.

[SEV2 report](../postmortems/SEV2-REVIEWERCWDREPO-01-reviewer-used-a-foreign-checkout-2026-11-20.md)

## Interface changes

`ADVERSARIAL_REVIEWER_CLONE_ROOT` optionally supplies additional local checkouts
at `<root>/<owner>/<repo>`. `prepareReviewerWorkspace` now returns a separate
`subprocessCwd`; `snapshotDir` remains the evidence archive. See the [reviewer workspace runbook](../RUNBOOK-reviewer-workspace.md).

## Verification

- `npm test -- test/reviewer-workspace.test.mjs test/reviewer.test.mjs test/argus-dependency-evidence.test.mjs test/reviewer-file-inventory.test.mjs test/reviewer-generated-review-delivery.test.mjs test/reviewer-snapshot-base-alert.test.mjs` passed 322 tests under netguard. One optional rubric integration test skipped because its companion package was unavailable.
- `npm run lint` completed with zero errors.
- `npm run typecheck:contracts` passed.
- `bash demo/research-finding-walkthrough.sh` passed with three byte-stable transcript deliveries.

Remediation validation: the four targeted reviewer-workspace, reviewer, Argus
dependency-evidence and snapshot-alert suites passed 294 tests with one optional
companion-package integration skip. `npm run lint` passed with zero errors
(existing warnings remain), `npm run typecheck:contracts` passed,
`bash demo/research-finding-walkthrough.sh` passed, and `git diff --check` passed.

## Final Claude review closeout

- The reviewer and Argus accept the canonical GitHub origin forms documented
  in the runbook, check configured and effective origin identity, and use the
  native, case-preserving clone path. Offline fixtures cover credential-bearing
  HTTPS without exposing userinfo, SSH spellings, aliases, URL rewrites and
  mismatched hosts or repositories. The PR worker origin used canonical SSH.
- Diff-only setup records five bounded causes and per-repository counts. A
  transition from snapshot mode logs the degradation. Operational degradation
  uses the shared digest path with a 24-hour per-repository debounce. PR-authored
  escaping links remain log-only and safely fall back to diff-only.
- Snapshot GC reads owned byte totals and retains the legacy filesystem walk,
  cache budgets and liveness pins. Exact-head cache misses still build a full
  Git archive. A sparse archive would omit unchanged files needed to interpret
  the patch. The runbook documents the archive cost and completeness limits.
- Empty startup directories use the owned workspace root and are reclaimed
  after confirmed process death. The Antigravity launcher keeps the required
  cross-user traversal in a per-UID root. Offline tests exercise signal
  termination, a surviving detached harness, unknown liveness, and cleanup.
- The PR archive remains a separate read-only evidence path for harnesses that
  can access it. Argus separates evidence assembly from model startup. Keeping
  project files in the archive preserves review evidence, while putting an
  archive on the harness workspace search path could reintroduce automatic
  settings or instruction discovery. Harness startup uses an empty cwd in
  both workspace modes. Argus allocates the startup workspace when a model is
  ready to launch, so jobs settled from existing evidence skip that allocation.
- Existing fetch tests exercise caller environment, both commit widths,
  bounded transient retries and disabled auto-maintenance. The existing
  deploy-state containment and PR-authored escaping-link regressions remain
  in the focused suite.
