# TEN-06 — AMA routing and independent remediation review

## Summary

Read tenure from the stable PR build launch. Tenured remediation keeps the PR
alias on native HQ dispatch; closers retain their merge-authority class and
principal. Changed heads of tenured PRs require independent exact-head review,
including final-round publication and heads observed before completion receipts.
HAM certificates and closer ownership cannot waive that review.

## Interface changes

- Optional `remediationWorker.originTenureId` records build-tenure routing context.
- Exact-head requests preserve budgets and record the remediation range in the
  existing review reason. Full, slim and adapter review prompts receive the range.
- Tenured closer inputs set `HAM_TENURE_REVIEW_REQUIRED=1`. The existing predicate
  accepts refusal-only `--tenure-review`; the in-lease check enforces the same
  requirement after head changes.
- Missing `tenureId` preserves the existing routing and suppression paths.
  No reviewer models, strictness, merge principals, CI gates or live settings change.

## Verification

Validation commands used the managed worker validator with requested 600-second
bounds; test commands used the prescribed netguard environment.

- `npm run lint`: zero errors (existing warnings retained).
- `npm run typecheck:contracts`: passed.
- `bash demo/research-finding-walkthrough.sh`: passed with byte-stable deliveries.
- `node --test test/ten-06.test.mjs`: 18 tests passed.
- Targeted AMA predicate, remediation closeout, reply/publication recovery,
  reviewer runtime, daemon merge, controller, generated-procedure, prompt,
  conflict-custody, conflict-sync, dispatch-priority, lifecycle and lease-finalization
  suites passed. Each affected test file was invoked with `node --test <file>`.
- `node --test test/head-closer-local-git-daemon-robust.test.mjs`: 30 tests passed
  with a resolved temporary-directory path; the initial symlink-path assertion
  compared equivalent paths with different spellings.
- `shellcheck bin/hammer-close-controller.sh` and `bash -n` passed.
  The rendered merge procedure passed ShellCheck at error severity; existing
  wrapper/source-following warnings remain.
- The legacy `test/follow-up-remediation.test.mjs` run reported 349 passing and
  41 failing tests, primarily inherited OAuth-home fixture contracts in the
  untouched local startup adapter. No green result is claimed for that suite.

- `node --test test/watcher-claim-loop.test.mjs`: 181 tests passed, including
  the real moved-head tenure request, outside-family dispatch and single-claim case.
- `npm test`: did not complete. The managed validator was requested with a
  600-second budget; its load-aware execution reached the test runner's own
  900-second limit, which stopped and cleaned up the suite. Partial output
  included the same legacy OAuth fixture failures. No full-suite pass is claimed.
