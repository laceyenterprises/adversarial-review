# REMBUILDERTAG-01

## Summary

Recover missing or unrecognized code-PR remediation builder tags from agreeing
recorded PR title, stable opener identity and explicit body metadata. Persist
the derived tag and evidence before selecting a remediator. Missing/conflicting
evidence stops with a named job, operator owner and escalation/retrigger action.
Recovered jobs refuse their own builder family across account and experiment
routing. Normalize known legacy and corporate class/tag spellings.

The [SEV2 report](../postmortems/SEV2-REMBUILDERTAG-01-remediation-builder-authorship.md)
records the supplied impact, reproduced shapes and limits of the evidence.

## Interface changes

Additive `builderTagRecovery` and stopped-job `builderAuthorshipEscalation`
evidence are documented in the [job model](../data-model/follow-up-jobs.md).
Missing/conflicting authorship and own-family recovered routing use existing
stopped/retrigger transitions. The consume API accepts an injectable recorded
authorship reader for offline testing. No CI check, label, override, runner,
merge predicate or live operation is added.

## Verification

- `node --test test/remediation-builder-authorship.test.mjs`: 44 tests pass.
  Run alone through the worker validation process-group wrapper with a
  600-second bound and `NETGUARD_LOG=<file> PATH=<netguard-bin>:$PATH`.
  Synthetic fixtures exercise durable recovery, selection, refusal and claim
  escalation without network or credentials.
- ESLint autofix on changed source files: zero errors.
- `npm run lint`: zero errors; 152 existing warnings.
- `npm run typecheck:contracts`: pass.
- `git diff --check`: pass.

Per the ticket's scoped-validation constraint, the full test suite and
walkthrough demo were not run manually. Existing deployed smoke commands remain
unchanged; organic recovery observation follows normal reviewed deployment.
