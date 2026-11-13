# SPILLCLASS-01

## Summary

Keep a queued review spill's alternate reviewer class and original reservation
when discovery refreshes the same known head. Previously refresh refunded and
replaced the candidate, so a smaller subsequent budget could strand it on the
saturated primary lane. New spills still use the current tick's budget;
changed or unknown heads replace and refund the old snapshot as before.

## Interface changes

None. Existing admission, freshness and reservation settlement gates still apply.

## Verification

- `node test/run-tests.mjs test/reviewspillstall-01.test.mjs
  test/watcher-reviewer-admission.test.mjs test/watcher-reviewer-dispatch.test.mjs
  test/watcher-admission-latency.test.mjs test/watcher-claim-loop.test.mjs`:
  232 tests passed in the isolated runner.
- `npm run lint`: passed with zero errors (existing warnings).
- `npm run typecheck:contracts`: passed.
- `bash demo/research-finding-walkthrough.sh`: passed, including byte equivalence.
- `npm test`: incomplete; the clean isolated attempt hit the runner's existing
  900-second timeout after reporting 676 passing tests, with no test failures
  reported before timeout.

Test commands used the network guard and the managed validation wrapper with a
600-second requested command budget (the host wrapper scales wall budgets).
