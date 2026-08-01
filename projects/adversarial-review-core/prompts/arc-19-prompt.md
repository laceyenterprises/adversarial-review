# ARC-19 — Fold remaining monoliths + import-boundary lint gate

> Plan ticket `ARC-19` from `projects/adversarial-review-core/plan.json`
> Spec: `adversarial-review-core@2c2af26f2eda`

## Source-of-truth references

- **Pack spec:** `projects/adversarial-review-core/SPEC.md` — §3 (ARC-19), §4 acceptance, §9 boundaries.
- **Plan:** `projects/adversarial-review-core/plan.json` — dependencies: ARC-18, ARC-16; downstream consumers depend on this ticket's contract, keep it stable.
- **Design specs (in the adversarial-review repo):** `docs/SPEC-adversarial-review-v2-app-architecture.md` and `docs/SPEC-merge-authority-v2.md`.
- **Read first:**
  - `src/follow-up-remediation.mjs`, `src/follow-up-merge-agent.mjs` — remaining orchestration after ARC-08/14/18
  - `eslint.config.mjs` / `test/` — where the boundary lint lives
- **Why this exists:** The boundary lint is the ratchet that keeps the architecture from regressing after the pack closes.

## Scope (mirrored from plan.json)

Fold the remaining orchestration logic in follow-up-remediation.mjs and follow-up-merge-agent.mjs into kernel effects + adapters (the AMA v1 actor code stays frozen behind the finalization port until MA-v2 promotion, then is deleted outside this pack); add the CI import-boundary lint: kernel imports nothing from layers 3-5, adapter/OS-integration layers never import review vocabulary upward.

## Tests (mandatory)

- boundary lint red/green fixtures.
- all v1 e2e fixtures pass unmodified.
- monolith line-count ratchets.

## Completion contract

- **Shape:** PR against `adversarial-review@main`.
- **Title prefix:** `[claude-code] ARC-19:` — adversarial review routes on the bracketed worker-class prefix.
- **Risk class:** high.
- **Target repo:** `adversarial-review` — declared additional repos: `agent-os` (read allowlist via XRW).
- **Worker class:** claude-code (you).

## Don't

- Frozen v1 AMA actor code stays (behind the port) — its deletion is post-promotion, outside this pack.

## How to land this PR

1. Provisioned worktree.
2. Read `projects/adversarial-review-core/SPEC.md` in full, then the design specs' sections named above.
3. Build the smallest reviewable diff that satisfies the scope.
4. Collect concise acceptance evidence (tests run + outcome summary).
5. Open the PR via `hq pr open` with a reviewer-pitch body (summary, what changed, why it matters, post-merge activities, acceptance evidence).

<!-- hq:closeout:pr -->

## Final step

Open the PR from inside the worker tree via `hq pr open --title "ARC-19: Fold remaining monoliths + import-boundary lint gate" --summary "<1-3 sentence headline>" --what-changed "<files/surfaces touched, new flags, behavior deltas>" --why "<problem solved and fleet value>" --post-merge "<config flip, follow-up, or None>" --acceptance-evidence "<tests run + observed result>" --spec-ref "adversarial-review-core@2c2af26f2eda"`. After the PR opens, your turn is complete — adversarial-review and merge-agent pipelines take over.
