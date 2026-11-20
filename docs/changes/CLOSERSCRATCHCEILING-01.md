# CLOSERSCRATCHCEILING-01: fence git discovery in closer scratch

## Summary

The closer's prompt and scratch directories live inside the service's own
checkout. Before this change, `hammerScratchEnvironment()` set only `TMPDIR` and
`PYTEST_ADDOPTS`, so a bare, cwd-relative `git` started in a scratch directory
walked up and operated on the enclosing checkout. For example, it could move
that checkout onto a PR branch, and a later daemon restart would then run the
wrong code.

`hammerScratchEnvironment()` now prepends the prompt directory and its parent to
`GIT_CEILING_DIRECTORIES`. Git discovery that starts in scratch, a subdirectory
of scratch or the prompt directory stops with "not a git repository". Inherited
ceiling entries are preserved. Repositories located outside the prompt
directory, such as the worker's workspace, and repositories created inside
scratch are still discovered.

## Interface changes

The closer dispatch environment gains `GIT_CEILING_DIRECTORIES`. No other
interface changes.

## Verification

- `node test/run-tests.mjs test/hammer-scratch.test.mjs`: 81/81 pass. The new
  test runs real `git rev-parse --show-toplevel` from scratch, a nested scratch
  directory and the prompt directory inside a synthetic repository. Run against
  the unpatched source, the same test fails because git resolves the outer
  repository.
- The other ten test files that import `dispatch-closer.mjs` and inspect the
  dispatch environment: 1148/1148 pass.
