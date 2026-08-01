# ARC-11 — Kernel pipeline contract: stages, panels, aggregation

> Plan ticket `ARC-11` from `projects/adversarial-review-core/plan.json`
> Spec: `adversarial-review-core@2c2af26f2eda`

## Source-of-truth references

- **Pack spec:** `projects/adversarial-review-core/SPEC.md` — §3 (ARC-11), §4 acceptance, §9 boundaries.
- **Plan:** `projects/adversarial-review-core/plan.json` — dependencies: ARC-03; downstream consumers depend on this ticket's contract, keep it stable.
- **Design specs (in the adversarial-review repo):** `docs/SPEC-adversarial-review-v2-app-architecture.md` and `docs/SPEC-merge-authority-v2.md`.
- **Read first:**
  - `src/kernel/contracts.d.ts` SubjectState/Verdict — extend with pipeline[]
  - `src/review-cycle-cap.mjs`, `src/follow-up-jobs.mjs` resolveRoundBudgetForJob — budget seams
  - SPEC §4.1–4.2 of the v2 architecture doc — stage/panel/aggregation semantics are contract
- **Why this exists:** The single-verdict assumption blocks multiple reviewer types; the pipeline contract enables sequential stages now and parallel panels later with no rework.

## Scope (mirrored from plan.json)

Introduce the review pipeline contract in kernel contracts: ordered Stage[] each with a panel of reviewer roles and an AggregationPolicy (unanimous-clean, any-blocking-blocks, quorum(n), weighted); per-stage round budgets by risk class plus a subject-level remediation ceiling; re-review after remediation re-runs the failed stage plus all downstream stages; every verdict pinned to the revisionRef it reviewed. SubjectState gains pipeline[] with panelVerdicts; latestVerdict becomes a deprecated alias resolving to the newest verdict of the active stage.

## Tests (mandatory)

- contract typecheck.
- budget/ceiling unit matrix across risk classes.
- stage-invalidation semantics on revision advance.
- alias-compatibility fixtures.

## Completion contract

- **Shape:** PR against `adversarial-review@main`.
- **Title prefix:** `[claude-code] ARC-11:` — adversarial review routes on the bracketed worker-class prefix.
- **Risk class:** high.
- **Target repo:** `adversarial-review` — declared additional repos: `agent-os` (read allowlist via XRW).
- **Worker class:** claude-code (you).

## Don't

- Contract + kernel logic only — no production two-stage enablement (ARC-13).
- latestVerdict alias must keep every existing consumer green.

## How to land this PR

1. Provisioned worktree.
2. Read `projects/adversarial-review-core/SPEC.md` in full, then the design specs' sections named above.
3. Build the smallest reviewable diff that satisfies the scope.
4. Collect concise acceptance evidence (tests run + outcome summary).
5. Open the PR via `hq pr open` with a reviewer-pitch body (summary, what changed, why it matters, post-merge activities, acceptance evidence).

<!-- hq:closeout:pr -->

## Final step

Open the PR from inside the worker tree via `hq pr open --title "ARC-11: Kernel pipeline contract: stages, panels, aggregation" --summary "<1-3 sentence headline>" --what-changed "<files/surfaces touched, new flags, behavior deltas>" --why "<problem solved and fleet value>" --post-merge "<config flip, follow-up, or None>" --acceptance-evidence "<tests run + observed result>" --spec-ref "adversarial-review-core@2c2af26f2eda"`. After the PR opens, your turn is complete — adversarial-review and merge-agent pipelines take over.
