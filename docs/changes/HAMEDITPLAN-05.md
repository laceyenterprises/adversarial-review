# HAMEDITPLAN-05

## Summary

Classify every edit-plan error by origin in one explicit registry. All
plan-originated errors receive one correction through the existing run-wide
marker, including JSON syntax, arrays/non-objects and unmatched citations.
Every correction lists both parsed finding sections, the required single-object
shape and the field fault. Review/run faults and existing reversal-policy
outcomes retain their terminal or backlog behavior. Correction never permits an
edit; finding authority, strict mode, range coverage, budgets and leases remain
mandatory. Prompt, closure runbook and README describe the total contract.

Final comment-only remediation removes the unreachable second review-head
equality guard. The earlier expected-head evidence guard and plan-head format
validation already enforce the same invariant; refusal ordering and edit
authorization are unchanged.

HAM closeout shortens equivalent prompt wording to repair the rendered 60 KiB
budget regression (61587 bytes on the remediation head). Phase execution,
source-inspection restrictions, missing-script handling, finding citations and
the single correction budget retain their meaning; the size assertion remains
unchanged.

## Interface changes

Plan errors return `action: correct` (exit 21), including `plan-json-invalid`,
`plan-invalid`, `plan-head-invalid` and `finding-citation-invalid`. Invalid
review verdicts retain terminal `finding-evidence-invalid`. The value-free
review-evidence diagnostic union now contains only run/evidence faults.
The CLI catches plan JSON syntax errors and reads authoritative review evidence
before correction. One object per invocation; invoke once per finding for
multiple edits. No new CI check, gate, label or live operation.

## Verification

HAM closeout: all 53 tests in `test/hammertrim-contract.test.mjs` passed after
the prompt reduction; the 37 edit-plan, review-witness and scope tests also
passed. A receipt-classification assertion failed once in the combined run,
then passed both alone and in the complete prompt-contract rerun.
`npm run lint` passed (0 errors, 149 existing warnings),
`npm run typecheck:contracts` passed, and the offline byte-equivalence demo
`bash demo/research-finding-walkthrough.sh` passed. The full suite runs in CI.

Final remediation: `node --test test/hameditplan-01.test.mjs
test/hameditplan-04.test.mjs test/hameditplan-05.test.mjs
test/hamrevwitness-01.test.mjs` passed all 25 tests. `npm run lint` passed
with zero errors (149 existing warnings); `npm run typecheck:contracts` and
`bash demo/research-finding-walkthrough.sh` passed. Commands used the bounded
runner with a 120-second limit and local dependencies from an identical
lockfile. No full suite run.

Individually under netguard with the worker validation runner and a 600-second
limit per command: `node --test test/<file>` for `hameditplan-01`,
`hameditplan-04`, `hameditplan-05`, `hamrevwitness-01`, `hammer-prompt-contract`,
`hamscope-01`, `laneauto-01` and `lanereversal-01` (all `.test.mjs`).
`npm run lint` passed with zero errors (existing unrelated warnings);
`npm run typecheck:contracts` and the offline byte-equivalence demo
`bash demo/research-finding-walkthrough.sh` passed. No full suite run.

The operator-only plan is
`modules/worker-pool/post-merge-actions/HAMEDITPLAN-05.yaml`: after normal float
and watcher/follow-up restart, verify PID start times, kickstart if skipped,
and retain 24 hours of correction-before-plan-stop and reasoned outcome evidence.
No live activation receipt is claimed by these offline checks.
