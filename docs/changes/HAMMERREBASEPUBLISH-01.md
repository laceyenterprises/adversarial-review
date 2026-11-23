# Publish completed conflict repairs after inconclusive validation

## Summary

The close controller validates a completed local conflict repair before pushing
it. A genuine local failure blocks publication. A timeout, load-related stop,
or denied process inspection permits publication after confirmed cleanup. The
controller checks the retained validation evidence after drain for late
failures. Unreadable evidence blocks publication. The push uses a Git lease
against the captured source head.

Declared required CI gates the exact published head. If the closer must defer
because there is no usable required CI declaration, it records a durable
watcher continuation on that head. The original launch remains eligible for the
existing infrastructure refund.

## Interface changes

The conflict-repair instructions now route the completed rebase directly to
`bin/hammer-close.sh`. The command performs validation, publication, and the
existing CI wait or queue handoff.

## Verification

- Synthetic controller coverage includes a drained timeout with old-head and
  exact-head CI, genuine and late local failures, unconfirmed cleanup,
  unreadable evidence, and a durable watcher continuation.
- The focused `node test/run-tests.mjs` run passed 283 tests, including the
  watcher claim loop and the retry on the new head with a refund on the source
  launch. The preceding impacted-file run passed 5,049 tests across 125 files,
  with three skips.
- `npm run lint`, `npm run typecheck:contracts`, ShellCheck on both controller
  scripts, and `bash demo/research-finding-walkthrough.sh` passed.
