# REMEDIATIONLIVEPLAN-01 — remediators resolve live-pack plan and spec findings by policy

## Summary

A remediation round could edit a live build pack's `plan.json` when the PR was
one of that pack's own tickets: the LIVEPACK-01 remediation rule only forbade
edits to *another* live pack, and the facts block only listed packs the PR diff
already touched. An executable activation-assertion change is a global plan
edit that append-only rebind refuses, so merging such an edit strands the
running DAG run.

Remediators now never edit a live pack's `SPEC.md`, `SPEC.meta.json`,
`plan.json` or `prompts/**`, own pack included, and a PR that is itself an
approved live edit is covered too (the operator's approval covers the author's
change, not a remediator's). A finding whose fix would edit one is resolved by
policy:

```
Resolved-By-Policy: live-pack-plan <path> requires an operator live edit
```

No edit, no blocker, no operator decision. Liveness is data, not a list: the
live-pack review gate's base-plan plus dispatch-read evaluation. Any failed or
inconclusive lookup protects every guarded pack path (fail closed).

This extends the existing mechanisms rather than adding one:

- HAMMERNOCI-01 scope rules: one new rule line in the follow-up remediator's
  Required Operating Rules (`src/remediation-prompt-builder.mjs`) and in the
  hammer's Appendix B (`templates/hammer-prompt.md`). The workflow rule is
  unchanged.
- REVIEWGUARD-01 helper: `bin/guard-forbidden-paths.mjs` also emits `livePack`
  and resolves live-pack findings (blocking and non-blocking) with audit lines
  the strict-mode accounting already reads. The hammer now passes its effective
  strict policy and runs the helper in both modes.
- LIVEPACK-01 context: `resolveLivePackRemediationContext` also reads packs the
  review findings cite (`citedFiles`), and its rule no longer exempts `ownPack`.

## Interface changes

- `src/live-pack-cross-edit.mjs`: new exports `loadLivePackPolicy`,
  `livePackPolicyProtects`, `guardedPackPathsInText`, `LIVE_PACK_POLICY_AUDIT`;
  `resolveLivePackRemediationContext` accepts `reviewBody`.
- `src/guard-forbidden-paths.mjs`: new exports `livePackOnlyRemedy`,
  `LIVE_PACK_POLICY_INSTRUCTIONS`; `resolveGuardForbiddenNonBlocking` accepts
  `livePackProtects` and returns `remainingBlocking`. Existing fields are
  unchanged.
- `bin/guard-forbidden-paths.mjs` output adds `livePack` and
  `remainingBlocking`. It reads the PR head SHA only when the review cites a
  pack path.

No CI check, gate, ratchet, guard or override label is added. The predicate and
every merge safety gate are unchanged.

## Verification

Run under the netguard environment, each file with `node --test <file>`:

- `test/remediationliveplan-01.test.mjs`: 8/8 pass (a live-plan finding resolved by
  policy with no edit, own pack included, and closure eligibility through the HAM
  audit; a blocking live-plan finding; a non-live pack's finding stays remediable;
  lookup failure protects every plan/spec/spec-meta/prompt path; mixed remedies and
  `live_pack_cross_edit` grant nothing; the HAMMERNOCI-01 workflow rule is unchanged
  in both prompts; the helper CLI runs end-to-end offline and fails closed).
- `test/live-pack-cross-edit.test.mjs` 44/44, `test/livepack-remediation.test.mjs`
  11/11, `test/reviewguard-close.test.mjs` 3/3, `test/reviewguard-context.test.mjs`
  2/2, `test/guard-forbidden-paths.test.mjs` 12/12,
  `test/remlabel-operator-findings.test.mjs` 11/11,
  `test/ama-hammer-merge-protocol-prompt.test.mjs` 45/45,
  `test/hammertrim-contract.test.mjs` 53/53 (rendered hammer prompt 59,319 B of the
  60 KiB cap), `test/hammer-prompt-contract.test.mjs` 6/6.
