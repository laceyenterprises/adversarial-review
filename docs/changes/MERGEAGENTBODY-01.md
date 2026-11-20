# MERGEAGENTBODY-01: merge-agent fallback controller writes a sanitized squash message

## Summary

`bin/merge-agent-close-controller.sh` was the last merge path that ran a bare
`gh pr merge --squash --auto --match-head-commit` with no `--subject`/`--body`.
GitHub then built the squash commit message from the PR body, so a cross-link
written as a closing keyword (for example `Fixes #N`) could auto-close an
unrelated open issue or PR when the merge landed.

The controller now reads the live PR title and body after the CI-cost check,
pipes the body through `bin/merge-commit-body.mjs` exactly as
`bin/hammer-merge.sh` does, and passes the resulting `--subject` and `--body`.
The subject is the sanitized title plus `(#<PR>)`; the body is the sanitized PR
body plus a `Closed-By: merge-agent` trailer. `--match-head-commit`, `--squash`
and `--auto` are unchanged, and `--admin` is still never used.

## Interface changes

- New refusals before `gh pr merge`, all through the existing lease-release
  EXIT trap: unreadable title/body or an empty title exits 75 (retry later);
  a sanitizer or JSON decode failure exits 64 (escalate). There is no fallback
  to GitHub's default message.
- Merge commits from this path carry `Closed-By: merge-agent`.
- `docs/RUNBOOK-ama-closure.md` merge-message section corrected in place: the
  merge-agent controller is no longer listed as remaining scope.

## Verification

- `test/hamcontrollerscript-01.test.mjs`: a stubbed `gh` records the merge argv;
  the controller passes `--subject`/`--body`, and a synthetic body with
  `Fixes #123`, an `owner/repo#N` and a GitHub URL reference comes out byte-equal
  to the hammer helper's output (only the closer trailer differs), while a
  reference to the PR itself stays intact. Empty-title and failed-read cases
  refuse the merge and release the lease.
- Every suite that references the controller or `merge-commit-body.mjs` (12
  files, `node --test --test-concurrency=2`): 320 tests, 316 pass. The 4
  failures (one in `lvr-no-op-outcomes`, three in `withdrawn-review-dismissal`)
  exercise the hammer shell, not this controller, and fail identically on an
  untouched copy of the base branch in the same environment.
- A/B: the three merge-agent controller tests that assert the new argv fail
  against the base controller and pass with this change.
- `npm run lint` (0 errors), `npm run typecheck:contracts`, and
  `bash demo/research-finding-walkthrough.sh` pass; `shellcheck` is clean on
  the controller.
