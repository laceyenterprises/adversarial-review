# HAMEDITPLAN-01

## Summary

Align the hammer's four literal edit-plan shapes with the checker. Uncited CI
repairs omit citation fields. Shape refusals carry expected-shape feedback and
permit one corrected submission before stopping; they never authorize an edit.

## Interface changes

`hammer-edit-plan.mjs` returns `action: correct`, exit 21, for malformed edit
kinds, malformed edit locations and CI-repair plans carrying citation fields.
Exit 0 permits edits; exit 20 defers; other refusals and owner errors retain
existing outcomes. Review-head matching, strict policy and reversal coverage
remain unchanged. The prompt procedure bounds shape correction to one retry.
Canonical closure documentation and the existing activation declaration agree.

## Verification

Scoped offline `test/hameditplan-01.test.mjs` and `test/hamscope-01.test.mjs`,
ESLint, contract typecheck and the research walkthrough run under netguard with
per-command limits: all 16 tests passed, lint passed with 0 errors (existing
warnings), typecheck passed and the walkthrough passed byte-equivalence. No full host suite or live
changes. SRE activation is declared in `modules/worker-pool/post-merge-actions/HAMEDITPLAN-01.yaml`.
