# ARC-16 — MA-v2 shadow mode + divergence telemetry

> Plan ticket `ARC-16` from `projects/adversarial-review-core/plan.json`
> Spec: `adversarial-review-core@2c2af26f2eda`

## Source-of-truth references

- **Pack spec:** `projects/adversarial-review-core/SPEC.md` — §3 (ARC-16), §4 acceptance, §9 boundaries.
- **Plan:** `projects/adversarial-review-core/plan.json` — dependencies: ARC-15; downstream consumers depend on this ticket's contract, keep it stable.
- **Design specs (in the adversarial-review repo):** `docs/SPEC-adversarial-review-v2-app-architecture.md` and `docs/SPEC-merge-authority-v2.md`.
- **Read first:**
  - ARC-15 ledger + fold (merged)
  - `docs/SPEC-merge-authority-v2.md` §5 — shadow protocol + bidirectional triage
  - SPEC §1 Win 3 — shadow-report output contract
- **Why this exists:** Shadow mode is how a ground-up redesign earns trust against a live buggy incumbent: decisions diffed, divergences triaged in both directions.

## Scope (mirrored from plan.json)

Run MA-v2 in shadow: ingest live events, log Decisions without acting; record every (v1 action, v2 decision) pair; implement the shadow-report CLI (SPEC section 1 Win 3) with divergence classification; write the bidirectional triage doc (a divergence is evidence about EITHER system — v1 is the known-buggy one). Fold errors or ledger unavailability emit escalate, never a guess.

## Tests (mandatory)

- shadow harness replaying recorded v1 traces.
- divergence classifier fixtures.
- report CLI snapshots.
- fail-closed fold-error path.

## Completion contract

- **Shape:** PR against `adversarial-review@main`.
- **Title prefix:** `[claude-code] ARC-16:` — adversarial review routes on the bracketed worker-class prefix.
- **Risk class:** high.
- **Target repo:** `adversarial-review` — declared additional repos: `agent-os` (read allowlist via XRW).
- **Worker class:** claude-code (you).

## Don't

- Shadow NEVER acts — log-only; fold errors emit escalate, never a guess.

## How to land this PR

1. Provisioned worktree.
2. Read `projects/adversarial-review-core/SPEC.md` in full, then the design specs' sections named above.
3. Build the smallest reviewable diff that satisfies the scope.
4. Collect concise acceptance evidence (tests run + outcome summary).
5. Open the PR via `hq pr open` with a reviewer-pitch body (summary, what changed, why it matters, post-merge activities, acceptance evidence).

<!-- hq:closeout:pr -->

## Final step

Open the PR from inside the worker tree via `hq pr open --title "ARC-16: MA-v2 shadow mode + divergence telemetry" --summary "<1-3 sentence headline>" --what-changed "<files/surfaces touched, new flags, behavior deltas>" --why "<problem solved and fleet value>" --post-merge "<config flip, follow-up, or None>" --acceptance-evidence "<tests run + observed result>" --spec-ref "adversarial-review-core@2c2af26f2eda"`. After the PR opens, your turn is complete — adversarial-review and merge-agent pipelines take over.
