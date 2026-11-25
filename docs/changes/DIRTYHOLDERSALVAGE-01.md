# DIRTYHOLDERSALVAGE-01 — Report validation custody before promising a retry

## Summary

The hammer records `canonical-validation-operator-decision` immediately for
dirty or unreadable custody and for a retained process-inspection no-verdict.
When reconciling an ended launch, the watcher uses the closure sweep's custody
predicate across the dispatch and current heads and appends an operator
continuation to each matching latest audit that has yet to record one, including
when the hold and audit use different heads. A clean, published source with
confirmed cleanup retains watcher-owned same-head backoff and fresh-lease admission.

## Interface changes

The append-only audit can add an operator continuation for the same launch
after its initial deferral. The audit schema and merge gates are unchanged.

## Verification

The PR body's 23 synthetic tests and two CI-mirror checks describe the initial
implementation. The subsequent remediation at `14bd0d49` recorded
`node test/run-tests.mjs test/inconclusiveretry-01b.test.mjs test/ama-audit.test.mjs test/deferred-source-custody.test.mjs test/smv.test.mjs`
passing 76 tests, plus `npm run lint`, `npm run typecheck:contracts`,
`bash demo/research-finding-walkthrough.sh` and
`node scripts/validate-data-model-catalog.mjs`. These are separate targeted
local runs, not full-suite evidence. The existing Node 22 and Node 26 test lanes
passed on that exact head in [CI run 45587006941](https://github.com/laceyenterprises/adversarial-review/actions/runs/45587006941).
Current-head required CI remains the merge gate; no full suite runs locally.

The final Comment-only round reran the same four-file command above: 78 tests
passed, including both directions of split-head custody/audit matching. Lint
passed with zero errors (147 warnings); contract typechecking, catalog validation
and the offline demo also passed. Validation used the installed dependencies
from a checkout with a byte-identical lockfile.
All 208 tests in `test/watcher-claim-loop.test.mjs` also passed under a
900-second bound. The initial 180-second run timed out; the longer five-file
invocation retained an earlier snapshot of an overstrict new fixture assertion,
which was corrected and verified by the clean 78-test rerun above.
