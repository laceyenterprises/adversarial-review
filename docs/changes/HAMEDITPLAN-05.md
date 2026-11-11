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

## Interface changes

Plan errors return `action: correct` (exit 21), including `plan-json-invalid`,
`plan-invalid`, `plan-head-invalid` and `finding-citation-invalid`. Invalid
review verdicts retain terminal `finding-evidence-invalid`. The value-free
review-evidence diagnostic union now contains only run/evidence faults.
The CLI catches plan JSON syntax errors and reads authoritative review evidence
before correction. One object per invocation; invoke once per finding for
multiple edits. No new CI check, gate, label or live operation.

## Verification

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
