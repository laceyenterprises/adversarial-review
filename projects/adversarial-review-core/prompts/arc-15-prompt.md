# ARC-15 — MA-v2 finalization ledger + eligibility fold

> Plan ticket `ARC-15` from `projects/adversarial-review-core/plan.json`
> Spec: `adversarial-review-core@2c2af26f2eda`

## Source-of-truth references

- **Pack spec:** `projects/adversarial-review-core/SPEC.md` — §3 (ARC-15), §4 acceptance, §9 boundaries.
- **Plan:** `projects/adversarial-review-core/plan.json` — dependencies: ARC-14; downstream consumers depend on this ticket's contract, keep it stable.
- **Design specs (in the adversarial-review repo):** `docs/SPEC-adversarial-review-v2-app-architecture.md` and `docs/SPEC-merge-authority-v2.md`.
- **Read first:**
  - `docs/SPEC-merge-authority-v2.md` §2–3 — event vocabulary, fold, policy inputs (this IS the contract)
  - `migrations/` — app-store schema conventions for the new ledger table
  - `src/reviewed-attestation.mjs` — attestation shapes feeding attestation_recorded events
- **Why this exists:** The six known merge-authority failure classes share one root — distributed implicit state; the event ledger + pure fold removes the coordination problem instead of patching it again.

## Scope (mirrored from plan.json)

Implement the merge-authority v2 core per docs/SPEC-merge-authority-v2.md sections 2-3: an append-only per-subject finalization event ledger in the app store (revision_advanced, verdict_recorded, checks_settled, attestation_recorded, remediation_dispatched/concluded, budget_exhausted, operator_override, finalized, halted), and a pure eligibility fold eligible(fold(events), policy) -> Decision. Head-move is an ordinary event; every external fact carries provenance (review commit_id, check-run id); strict_mode, exhaustion-always-closes, and all-comments-before-merge are explicit policy inputs; consume_attestations without recorded producers is a config-validation error at load.

## Tests (mandatory)

- fold determinism property tests.
- replay-resume equivalence.
- regression fixtures for the six v1 failure classes (phantom die-before-merge, identity head-pin, ceiling+head-move deadlock, LHA premature cutover, CI impatience, verdict-at-wrong-head) each producing a safe decision.

## Completion contract

- **Shape:** PR against `adversarial-review@main`.
- **Title prefix:** `[claude-code] ARC-15:` — adversarial review routes on the bracketed worker-class prefix.
- **Risk class:** high.
- **Target repo:** `adversarial-review` — declared additional repos: `agent-os` (read allowlist via XRW).
- **Worker class:** claude-code (you).

## Don't

- The fold is PURE — no I/O, no clock reads inside; time enters as event data.
- No executor here (ARC-17); no shadow wiring here (ARC-16).

## How to land this PR

1. Provisioned worktree.
2. Read `projects/adversarial-review-core/SPEC.md` in full, then the design specs' sections named above.
3. Build the smallest reviewable diff that satisfies the scope.
4. Collect concise acceptance evidence (tests run + outcome summary).
5. Open the PR via `hq pr open` with a reviewer-pitch body (summary, what changed, why it matters, post-merge activities, acceptance evidence).

<!-- hq:closeout:pr -->

## Final step

Open the PR from inside the worker tree via `hq pr open --title "ARC-15: MA-v2 finalization ledger + eligibility fold" --summary "<1-3 sentence headline>" --what-changed "<files/surfaces touched, new flags, behavior deltas>" --why "<problem solved and fleet value>" --post-merge "<config flip, follow-up, or None>" --acceptance-evidence "<tests run + observed result>" --spec-ref "adversarial-review-core@2c2af26f2eda"`. After the PR opens, your turn is complete — adversarial-review and merge-agent pipelines take over.
