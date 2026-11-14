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

## Final comment remediation

- Reuse the watcher's cached tenure absence in closer suppression. Independent
  lookup failures warn and retain live-writer custody, otherwise leaving the
  head reviewable without accepting a closer certificate.
- Treat a missing completion launch ID or a successful unindexed-stage lookup
  as opener-only routing. Unreadable launch evidence still defers; a bound stage
  still excludes its harness family.
- Skip already armed same-head/range requests before opening a write transaction,
  retaining pending, upstream and CI admission states, timestamps and budgets.
- Warn and omit optional tenure range context on reviewer startup read failures.
  Preserve the exact review head and include range context when available.
- Correct the closure runbook, state notes, README contract and existing
  state/smoke declarations. Persistent field shapes and smoke commands do not change.

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

## Final remediation verification

Commands ran through `bin/run-bounded.sh`, with 60–300 second limits.
Legacy fixtures used `ADVERSARIAL_DISPATCH_READS_ENABLED=0` and
`ADVERSARIAL_WORKER_OBSERVATIONS_ENABLED=0`; tenure cases inject their own
readers. The initial inherited live-read flag caused fixture failures. The
extended watcher fixture's duplicate seed was corrected before its final run.

- `node test/run-tests.mjs test/watcher-claim-loop.test.mjs`: 181 passed.
- `node test/run-tests.mjs test/watcher-claim-loop.test.mjs test/ten-06.test.mjs test/head-closer-local-git-daemon-robust.test.mjs`:
  tenure (28) and closer (30) passed; the watcher seed failure was then fixed
  and the whole watcher file passed separately as listed above.
- `node test/run-tests.mjs test/reviewer-spawn-settle.test.mjs`: 26 passed.
- `npm run lint` and final ESLint on the four changed source files:
  zero errors; existing warnings remain.
- `npm run typecheck:contracts`, `node scripts/validate-data-model-catalog.mjs`
  (98 entries), `bash demo/research-finding-walkthrough.sh`, state/smoke JSON
  parsing and `git diff --check`: passed.
- No full local test suite was run in this remediation round.

## HAM closeout repairs

Rebased onto current main while preserving both reviewer startup imports. Reused
all four existing final-comment fixes. Refreshed the watcher state projection
following review of the tenure pending-request and admission guards; lifecycle
states and graph edges remain unchanged. Updated existing offline gate fixtures
to supply the tenure imports/placeholders and recognize the rendered helper
source line. Extracted required HQ session/project reads into the existing
remediation dispatch helper, preserving validation order, trimming and errors;
the remediation module remains below its existing size ceiling. The offline test
runner also discards inherited live dispatch/observation switches; tenure fixtures
continue to opt in explicitly.

Verification: lint (zero errors), contract typecheck, data-model catalog (98
entries), and the offline research walkthrough passed. Targeted canonical
validation covers tenure, watcher claims, reviewer startup, closer suppression,
state projection, HAM credentials, late-review race protection, module boundaries,
and HQ dispatch: 420 tests passed across ten files. Initial live-read fixture failures
were resolved by runner environment isolation; the late-review fixture import was
corrected before its passing run. Exact-head GitHub CI remains the full-suite merge authority.
