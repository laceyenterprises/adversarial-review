# ARC-17 — MA-v2 leased executor + promotion runbook (ships gated off)

> Plan ticket `ARC-17` from `projects/adversarial-review-core/plan.json`
> Spec: `adversarial-review-core@2c2af26f2eda`

## Source-of-truth references

- **Pack spec:** `projects/adversarial-review-core/SPEC.md` — §3 (ARC-17), §4 acceptance, §9 boundaries.
- **Plan:** `projects/adversarial-review-core/plan.json` — dependencies: ARC-16, ARC-20, ARC-22; downstream consumers depend on this ticket's contract, keep it stable.
- **Design specs (in the adversarial-review repo):** `docs/SPEC-adversarial-review-v2-app-architecture.md` and `docs/SPEC-merge-authority-v2.md`.
- **Read first:**
  - ARC-15/16 (merged); `docs/SPEC-merge-authority-v2.md` §4–5
  - `src/github-adapter-client.mjs` — local-fallback merge execution path
  - ARC-20's adjudicate-surface contract + ADR in the declared additional repo agent-os (merged before this dispatches)
- **Why this exists:** The executor is the last piece of MA-v2 — leased, idempotent, fail-closed — shipped dark until the operator promotes it on shadow evidence.

## Scope (mirrored from plan.json)

Implement the single leased executor per subject: leases live in the app store (not GitHub labels); execute is idempotent with a re-fold guard (if the world moved since the decision, discard and re-decide); merge executes through the ARC-20 adjudicate surface with github-adapter pr-merge as the local-mode fallback; identity/attestation checks read through the ARC-22 surface. Ships GATED OFF — promotion is an operator action after the shadow gate clears; deliver the promotion runbook (gate criteria, one-flag rollback, kill-switch fail-closed audit).

## Tests (mandatory)

- lease contention.
- re-fold discard on world-move.
- execute idempotency under repeat.
- kill-switch fail-closed audit row.

## Completion contract

- **Shape:** PR against `adversarial-review@main`.
- **Title prefix:** `[claude-code] ARC-17:` — adversarial review routes on the bracketed worker-class prefix.
- **Risk class:** high.
- **Target repo:** `adversarial-review` — declared additional repos: `agent-os` (read allowlist via XRW).
- **Worker class:** claude-code (you).

## Don't

- Ships GATED OFF — no execution in production until operator promotion.
- Leases in the app store, never GitHub labels.

## How to land this PR

1. Provisioned worktree.
2. Read `projects/adversarial-review-core/SPEC.md` in full, then the design specs' sections named above.
3. Build the smallest reviewable diff that satisfies the scope.
4. Collect concise acceptance evidence (tests run + outcome summary).
5. Open the PR via `hq pr open` with a reviewer-pitch body (summary, what changed, why it matters, post-merge activities, acceptance evidence).

<!-- hq:closeout:pr -->

## Final step

Open the PR from inside the worker tree via `hq pr open --title "ARC-17: MA-v2 leased executor + promotion runbook (ships gated off)" --summary "<1-3 sentence headline>" --what-changed "<files/surfaces touched, new flags, behavior deltas>" --why "<problem solved and fleet value>" --post-merge "<config flip, follow-up, or None>" --acceptance-evidence "<tests run + observed result>" --spec-ref "adversarial-review-core@2c2af26f2eda"`. After the PR opens, your turn is complete — adversarial-review and merge-agent pipelines take over.
