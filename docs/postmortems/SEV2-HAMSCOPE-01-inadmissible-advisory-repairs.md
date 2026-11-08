# SEV2 — advisory repairs exceeded admissible reversal scope

Date: 2026-11-08. Ticket: HAMSCOPE-01. Severity: SEV2, merge availability.
Status: source correction with offline synthetic coverage; no live recovery performed.

## Impact

Three reported PRs in one day exhibited the same failure family. Hammers completed
repairs that changed reviewed author code on the strength of advisory findings.
One required operator intervention; two encountered `primary-change-reverted`
after remediation, requiring further work or leaving the PR open. The merge
predicate preserved its safety contract, but remediation effort could not produce
an eligible head.

## Cause

The hammer's all-comments remediation mandate operated before a concrete
admissibility check. Reversal authorization was enforced at merge time, after
edits, validation and publication. A finding's presence and a reversal trailer
were insufficient: advisory non-blocking findings cannot authorize reversals when
strict remediation is disabled. Prompt guidance lacked a direct pre-edit helper
and a routine way to record that finding as deferred rather than withdrawn.

## Correction

The hammer now checks a planned author-line edit through a helper that shares
finding-kind, verdict, finding selection and cited-location validation with the
primary-change gate. The helper reads effective merge policy. An inadmissible
advisory edit is deferred through the existing findings-backlog capture path with
a one-line reason, before any author-code edit. Capture failure stops the edit.
Additive fixes changing no author line remain allowed. Blocking reversals and
strict-mode non-blocking reversals keep their existing requirements.

The final gate continues verifying commit identity, ancestry and actual patch
coverage. This correction adds no CI check, override label or merge exception.
The planner relies on the hammer correctly identifying author-line edits from
the primary patches; it is a remediation tool, not an editor interceptor.

## Verification

`test/hamscope-01.test.mjs` uses synthetic review/history evidence and temporary
SQLite stores. It checks durable advisory deferral with unchanged author content,
additive test allowance, blocking and strict-mode reversal agreement with the
actual primary-change gate, invalid evidence refusal and stale capture failure.
No deployed recovery or live merge result is claimed.
