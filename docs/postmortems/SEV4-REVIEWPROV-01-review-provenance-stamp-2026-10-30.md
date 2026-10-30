# SEV4 REVIEWPROV-01 — Review provenance stamp misnamed the harness and effort

Incident date: 2026-10-30. Severity: SEV4, provenance truthfulness.
Disposition: source correction with offline tests. No verdict, finding count,
merge decision or remediation was affected.

## What was observed

An operator reading a posted Gemini review saw the provenance stamp
`> Reviewer: gemini · Gemini 3.8 Flash (High) · none` on a review that had run
through the Antigravity (`agy`) runtime. The operator expected the harness slot
to name Antigravity.

Two of the three fields were wrong:

- **Harness.** The slot showed the model family (`gemini`), not the runtime
  that executed the review. An Antigravity review and a direct Gemini CLI
  review were indistinguishable.
- **Effort.** The slot showed `none` while the model display name requested
  the `High` thinking level, so the stamp read as "no reasoning effort".

The fields were also unlabelled, which made the positional `· none` easy to
misread.

## Root cause

`reviewWithGemini` (`src/reviewer-harness.mjs`) resolved the runtime
(`antigravity` or `cli`) for the spawn, but the execution record it returned
hardcoded `harness: 'gemini'` and `effort: null`. The Claude and Codex paths
likewise stamped bare family constants (`claude`, `codex`) instead of a runtime
name. `src/review-comment-body.mjs` then rendered a null effort as `none`.

Nothing parsed the stamp, so no gate saw the wrong value. The same execution
record is persisted on the reviewer pass, so Gemini passes also recorded a null
`reasoning_effort`.

## Correction

- One helper, `reviewerExecutionHarness(family, runtime)`, maps every reviewer
  family to its execution runtime: `claude-code`, `codex`, `antigravity` or
  `gemini-cli`. Every execution record now uses it, so the reviewer families
  cannot drift.
- An Antigravity review's effort is the thinking level it requested: the
  parenthesised suffix of the agy display-name model token, lowercased. agy
  has no other effort input. The Gemini CLI receives no thinking level, so its
  effort stays null.
- The stamp labels its fields and prints `n/a` for a null effort:
  `> Reviewer: harness antigravity · model Gemini 3.8 Flash (High) · effort high`.
  It remains a blockquote line, so the verdict and blocking-finding parsers are
  unaffected.

## Evidence and follow-up

Offline tests cover the Antigravity and Gemini CLI stamps, the labelled Claude
and Codex stamps, and verdict and blocking-finding parsing of a stamped body.
The live receipt is owned by SRE: the next posted Gemini review should show
`harness antigravity` and a real effort value.
