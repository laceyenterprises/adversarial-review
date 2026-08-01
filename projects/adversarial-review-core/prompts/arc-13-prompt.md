# ARC-13 — Sequential two-stage pipeline live (code-quality -> security)

> Plan ticket `ARC-13` from `projects/adversarial-review-core/plan.json`
> Spec: `adversarial-review-core@2c2af26f2eda`

## Source-of-truth references

- **Pack spec:** `projects/adversarial-review-core/SPEC.md` — §3 (ARC-13), §4 acceptance, §9 boundaries.
- **Plan:** `projects/adversarial-review-core/plan.json` — dependencies: ARC-04, ARC-12; downstream consumers depend on this ticket's contract, keep it stable.
- **Design specs (in the adversarial-review repo):** `docs/SPEC-adversarial-review-v2-app-architecture.md` and `docs/SPEC-merge-authority-v2.md`.
- **Read first:**
  - ARC-11 pipeline contract + ARC-12 registry (merged)
  - `domains/code-pr.json` — gains pipeline config
  - SPEC §1 Win 2 — rollup rendering is the contract
- **Why this exists:** The operator-visible payoff of Phase 3: code-quality then security review on real PRs, with correct budgets and downstream re-review.

## Scope (mirrored from plan.json)

Wire the code-pr domain to a two-stage pipeline [code-quality, security] behind a config gate defaulting off; later stages run only when all prior stages are clean at the current revision; post the pipeline rollup comment (SPEC section 1 Win 2) through the comms adapter; prove downstream re-review semantics (remediation from stage-2 findings re-runs stage 2 at the same revision, not stage 1).

## Tests (mandatory)

- fixture e2e covering both stages.
- downstream re-review fixture.
- gate-off preserves v1 single-stage behavior byte-for-byte.
- rollup rendering snapshots.

## Completion contract

- **Shape:** PR against `adversarial-review@main`.
- **Title prefix:** `[claude-code] ARC-13:` — adversarial review routes on the bracketed worker-class prefix.
- **Risk class:** high.
- **Target repo:** `adversarial-review` — declared additional repos: `agent-os` (read allowlist via XRW).
- **Worker class:** claude-code (you).

## Don't

- Gate defaults OFF; gate-off must be byte-identical to v1 single-stage.
- Downstream-only re-review: stage-2 remediation never re-runs stage 1 at the same revision.

## How to land this PR

1. Provisioned worktree.
2. Read `projects/adversarial-review-core/SPEC.md` in full, then the design specs' sections named above.
3. Build the smallest reviewable diff that satisfies the scope.
4. Collect concise acceptance evidence (tests run + outcome summary).
5. Open the PR via `hq pr open` with a reviewer-pitch body (summary, what changed, why it matters, post-merge activities, acceptance evidence).

<!-- hq:closeout:pr -->

## Final step

Open the PR from inside the worker tree via `hq pr open --title "ARC-13: Sequential two-stage pipeline live (code-quality -> security)" --summary "<1-3 sentence headline>" --what-changed "<files/surfaces touched, new flags, behavior deltas>" --why "<problem solved and fleet value>" --post-merge "<config flip, follow-up, or None>" --acceptance-evidence "<tests run + observed result>" --spec-ref "adversarial-review-core@2c2af26f2eda"`. After the PR opens, your turn is complete — adversarial-review and merge-agent pipelines take over.
