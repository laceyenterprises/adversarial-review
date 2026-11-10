# FINDINGS-23d6c617

## Summary

Address both non-blocking findings from the latest review of PR 1782:

- Record successful native watcher registration and assert it precedes the
  contended lock acquisition recheck. Restore both the mocked filesystem method
  and its named ESM export after the test.
- Assert that the native watcher wake completes within eight seconds of its
  ten-second deadline, retaining the existing contention and stale-route checks.

Merge current main (`671efff4bd23f8b0457ddf2b4addcb46f26045f0`) into the
branch without conflicts. The prior failing `npm test (Node 22)` check
([run 42587953125](https://github.com/laceyenterprises/adversarial-review/actions/runs/42587953125))
exceeded the existing 900-second suite limit. Main includes ARSUITETIMEOUT-01's
fixture/runtime improvements; its latest
[Test run 42707962086](https://github.com/laceyenterprises/adversarial-review/actions/runs/42707962086)
passed both Node checks. Preserve that fix and leave full-suite acceptance to
CI on the updated PR head.

## Interface changes

None. Production behavior, CI configuration and merge policy are unchanged by
these test assertions.

## Verification

Commands ran offline under netguard through `cwp_dispatch.worker_validation`,
each with a 600-second bound. Test files ran individually:

- `node --test test/finalization-queue-routing.test.mjs`: 17 passed.
- `node --test test/config-rgy.test.mjs`: 3 passed.
- A temporary acquire-before-subscribe mutation was rejected by the targeted
  recheck test at the new watcher-registration assertion; production source
  was restored afterward.
- ESLint `--fix` on both affected test files: passed without rewrites.
- `npm run lint`: zero errors (existing unused-variable warnings).
- `npm run typecheck:contracts`: passed.
- `bash demo/research-finding-walkthrough.sh`: passed.

The full host suite was not run, per the builder-fix lane's scoped-test
requirement.
