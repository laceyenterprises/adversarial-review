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

## Review remediation

Canonicalize legacy bracketed and alias tags in persisted recovery evidence
before routing. Accept explicit HTML comment metadata outside fences. Retry
transient PR reads twice within 15 seconds and requeue unavailable PR/transient
opener reads for 60 seconds with the existing pre-spawn round refund. Settled
absence/conflict still requires operator correction. The real fallback-refusal
consumer fixture confirms own-family proposals already stop before dispatch.
Move the catalog fragment into the root catalog read by the validator.

Corrected declaration drift by retaining the existing lifecycle graph/inventory
and documenting recovery in the owner declaration; refreshed the changed
consumer source projection. No test guard or smoke command changed.

Verification after rebase and remediation:

- Bounded `node --test test/remediation-builder-authorship.test.mjs test/smv.test.mjs`:
  pass (52 authorship cases and all SMV checks, including disposable sandbox smoke).
- `npm run lint`: pass, zero errors and 152 existing warnings.
- `npm run typecheck:contracts`: pass.
- `node scripts/validate-data-model-catalog.mjs`: pass, 92 entries.
- `git diff --check`: pass.

Full-suite validation remains with PR-head CI per worker scope.

## Current-head CI repair

The failed Node 22/26 lanes identified incomplete operator-retrigger documentation
and a consume module above its existing size ceiling. Document all three
operator-retriggerable authorship stop codes and the correction required before
retriggering in the SPEC and follow-up runbook. Move pre-routing recovery
settlement and initial routing assembly into their existing helper modules,
keeping pending refunds, stopped ownership, route ordering and admission intact.
The consumer now has 4296 lines against the existing 4297-line limit; no guard,
workflow or CI configuration changed. Refresh its reviewed state projection;
existing lifecycle values, durable store shape and smoke promises are unchanged.

Validation: authorship, retrigger-label, boundary, fallback, runnable-lane and
capped-hold suites pass. All 11 SMV checks, including disposable Git smoke, pass
from a clean tracked archive with this patch applied and installed dependencies
linked. In-workspace smoke attempts hit the existing clean-step time budget;
the unchanged reviewed head also passes from a clean archive. Lint passes with
zero errors and 152 existing warnings; contract typecheck, data-model catalog
validation (92 entries), and diff check pass. The full suite remains delegated
to PR-head CI.
