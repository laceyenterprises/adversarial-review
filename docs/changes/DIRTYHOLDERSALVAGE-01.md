# DIRTYHOLDERSALVAGE-01 — Report validation custody before promising a retry

## Summary

The hammer records `canonical-validation-operator-decision` immediately for
dirty or unreadable custody and for a retained process-inspection no-verdict,
so the terminal audit can name the operator action before the next sweep.
When reconciling an ended launch, the watcher uses the closure sweep's custody
predicate across the dispatch and current heads and appends an operator
continuation to each matching latest audit that has yet to record one, including
when the hold and audit use different heads. A clean, published source with
confirmed cleanup retains watcher-owned same-head backoff and fresh-lease admission.

## Interface changes

The append-only audit can add an operator continuation for the same launch
after its initial deferral. The audit schema and merge gates are unchanged.

## Verification

The initial implementation passed 23 synthetic tests and two CI-mirror
checks. The subsequent remediation at `14bd0d49` recorded
`node test/run-tests.mjs test/inconclusiveretry-01b.test.mjs test/ama-audit.test.mjs test/deferred-source-custody.test.mjs test/smv.test.mjs`
passing 76 tests, plus `npm run lint`, `npm run typecheck:contracts`,
`bash demo/research-finding-walkthrough.sh` and
`node scripts/validate-data-model-catalog.mjs`. These are separate targeted
local runs, not full-suite evidence. The existing Node 22 and Node 26 test lanes
passed on that exact head in [CI run 45587006941](https://github.com/laceyenterprises/adversarial-review/actions/runs/45587006941).

At `e5b351326`, 78 focused tests and 208 watcher claim-loop tests passed
locally. Lint, contract typechecking, catalog validation and the offline demo
also passed. The full suite passed across the Node 22 and Node 26 shards in
[CI run 45594962183](https://github.com/laceyenterprises/adversarial-review/actions/runs/45594962183).

The 78-test run used the same four-file command and covered both directions of
split-head custody and audit matching. The watcher claim-loop ran under a
900-second bound after an initial 180-second timeout. A five-file run retained
an earlier version of an overstrict fixture assertion, which the corrected
four-file run verified. Local validation used dependencies from a checkout with
a byte-identical lockfile. Lint reported zero errors and 147 warnings.
