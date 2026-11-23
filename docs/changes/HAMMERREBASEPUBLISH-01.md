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
existing infrastructure refund. Backoff moves to the published head only when
the ended launch's push receipt confirms that exact SHA.

## Interface changes

The conflict-repair instructions now route the completed rebase directly to
`bin/hammer-close.sh`. The command performs validation, publication, and the
existing CI wait or queue handoff. If validation stops while the supervisor
still owns cleanup, the controller leaves the result unwritten and the launcher
can start one fresh round after verified drain. Verify-head reuses the
CI-authoritative receipt for the published SHA.

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
- The review-remediation regressions cover a timeout or load stop before
  supervisor drain, same-head CI receipt reuse, and external head movement
  with and without a matching push receipt. The focused close-controller
  selection passed all nine cases. The targeted `node --test` run for
  `mrq-20-validation-unknown`, `inconclusiveretry-01b`, `hammer-controller`,
  `hammer-validation-deferral`, and `lac-2252-publication` passed 165 cases.
  The data-model catalog validator passed.
