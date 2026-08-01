# ARC-31 — Operator final re-review recovery

> Plan ticket `ARC-31` from `projects/adversarial-review-core/plan.json`
> Spec: `adversarial-review-core@2c2af26f2eda`

## Source-of-truth references

- **Pack spec:** `projects/adversarial-review-core/SPEC.md` — Phase 5, ARC-31, acceptance criteria 16 and 17.
- **RCA:** `docs/RCA-adversarial-review-sdk-cutover-readiness-2026-08-01.md` — operator final re-review needed multiple manual surfaces.
- **Plan:** `projects/adversarial-review-core/plan.json` — no dependencies.
- **Existing code to read first:**
  - adversarial-review `src/retrigger-review.mjs` and `test/retrigger-review.test.mjs` — current operator re-review surface.
  - adversarial-review `src/follow-up-retrigger-review-label.mjs` and label tests — PR-side path.
  - adversarial-review `src/pollonce-phases.mjs` around hard review ceiling and operator marker handling.
  - adversarial-review `docs/follow-up-runbook.md` lines 604-617 — current documented retrigger contract.
  - adversarial-review `src/review-cancel.mjs` — active reviewer cancellation surface.
- **Why this exists:** The operator needs one safe "review this exact head now" command under stress, not a chain of budget bumps, stale job stops, and DB reasoning.

## Scope (mirrored from plan.json)

Provide one audited operator surface for review this exact head now that clears stale terminal state, honors current-head idempotency, can intentionally bypass hard review ceiling once, refuses active reviewers unless explicitly cancelled, and never requires manual budget hacks or SQLite edits.

## Tests (mandatory)

- Hard-review-ceiling bypass fixture with one-shot audit.
- Active-review refusal unless explicit cancellation/allow flag is provided.
- Stale follow-up stop and requeue fixture.
- Operator mutation audit idempotency and refusal rows.

## Completion contract

- **Shape:** PR against `adversarial-review@main`.
- **Title prefix:** `[codex] ARC-31:`.
- **Risk class:** high.
- **Target repo:** `adversarial-review` — declared additional repo: `agent-os` for operator command/runbook references.
- **Worker class:** codex (you).

## Don't

- Do not hand-edit `data/reviews.db` or follow-up job JSON in the implementation path.
- Do not allow duplicate active reviewer spawns by default.
- Do not weaken explicit operator-stop or redesign pauses.

## How to land this PR

1. Use a provisioned worker worktree.
2. Read the spec/RCA and retrigger docs/tests.
3. Add one audited command or extend the existing CLI with an explicit mode.
4. Open the PR via `hq pr open` with acceptance evidence.

<!-- hq:closeout:pr -->

## Final step

Open the PR from inside the worker tree via `hq pr open --title "ARC-31: Operator final re-review recovery" --summary "<1-3 sentence headline>" --what-changed "<files/surfaces touched, new flags, behavior deltas>" --why "<problem solved and fleet value>" --post-merge "None" --acceptance-evidence "<tests run + observed result>" --spec-ref "adversarial-review-core@2c2af26f2eda"`.
