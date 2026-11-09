# HAMEDITPLAN-01

## Summary

Align the hammer's four literal edit-plan shapes with the checker. Uncited CI
repairs omit citation fields. Shape refusals carry expected-shape feedback and
permit one corrected submission per run across all plans before stopping;
they never authorize an edit.

## Interface changes

`hammer-edit-plan.mjs` returns `action: correct`, exit 21, for malformed edit
kinds, malformed edit locations and otherwise admissible cited in-place CI plans.
Cited in-place plans first retain policy deferral/stop outcomes and backlog capture;
correction feedback retains citations and removes only requiredCiRepair.
Exit 0 permits edits; exit 20 defers; other refusals and owner errors retain
existing outcomes. Review-head matching, strict policy and reversal coverage
remain unchanged. The prompt procedure bounds shape correction to one retry per
run. Its first
shape refusal prints NO EDIT and exits 21 (never conflict handling); the second
exits 1. Missing or misspelled uncited CI edit kinds are correctable.
Compacted existing prompt guidance without changing its requirements to retain
the 60 KiB rendered budget.
Canonical closure documentation and the existing activation declaration agree.

## Verification

Scoped offline `test/hameditplan-01.test.mjs` and `test/hamscope-01.test.mjs`,
ESLint, contract typecheck and the research walkthrough run under netguard with
per-command limits: all 16 tests passed, lint passed with 0 errors (existing
warnings), typecheck passed and the walkthrough passed byte-equivalence. No full host suite or live
changes. SRE activation is declared in `modules/worker-pool/post-merge-actions/HAMEDITPLAN-01.yaml`.

Round-two remediation verification: `node --test test/hameditplan-01.test.mjs
test/hamscope-01.test.mjs test/hammertrim-contract.test.mjs` covers cited-policy
refusals, backlog capture, literal examples, direct shell exits and prompt budget.
All 115 targeted tests passed, including
`test/ama-hammer-merge-protocol-prompt.test.mjs`. The rendered size fixture is 61,418 bytes (limit 61,440). `npm run lint` passed
with zero errors (existing warnings), `npm run typecheck:contracts` passed, and
`bash demo/research-finding-walkthrough.sh` passed byte-equivalence. No full suite
or live smoke was run; deployment acceptance remains SRE-owned.
