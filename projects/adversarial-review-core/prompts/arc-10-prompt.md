# ARC-10 — Delete bespoke harness code from reviewer.mjs and cli-direct

> Plan ticket `ARC-10` from `projects/adversarial-review-core/plan.json`
> Spec: `adversarial-review-core@2c2af26f2eda`

## Source-of-truth references

- **Pack spec:** `projects/adversarial-review-core/SPEC.md` — §3 (ARC-10), §4 acceptance, §9 boundaries.
- **Plan:** `projects/adversarial-review-core/plan.json` — dependencies: ARC-08; downstream consumers depend on this ticket's contract, keep it stable.
- **Design specs (in the adversarial-review repo):** `docs/SPEC-adversarial-review-v2-app-architecture.md` and `docs/SPEC-merge-authority-v2.md`.
- **Read first:**
  - `src/reviewer.mjs` spawn families: spawnClaude :306, spawnCodexReview :2159, spawnGeminiReview :3123, spawnAgyReview :3147, reviewWithGemini :3191
  - `src/adapters/reviewer-runtime/cli-direct/index.mjs:143-330` — duplicated model detection/token parsing
- **Why this exists:** Deletion is the payoff of Phase 2: the repo stops knowing what a claude/codex/gemini/agy binary is.

## Scope (mirrored from plan.json)

Remove the spawnClaude / spawnCodexReview / spawnGeminiReview / spawnAgyReview families from src/reviewer.mjs and both duplicated copies of model detection and token-usage parsing (reviewer.mjs and adapters/reviewer-runtime/cli-direct); reviewer.mjs shrinks to prompt assembly + artifact emission invoked by the runtimes. Any residual per-harness knowledge must live in OS worker classes, not this repo.

## Tests (mandatory)

- fixture parity for review outputs across the local runtime.
- dead-code grep gate for the removed spawn family names.
- a line-count ratchet on reviewer.mjs enforced in CI.

## Completion contract

- **Shape:** PR against `adversarial-review@main`.
- **Title prefix:** `[claude-code] ARC-10:` — adversarial review routes on the bracketed worker-class prefix.
- **Risk class:** high.
- **Target repo:** `adversarial-review` — declared additional repos: `agent-os` (read allowlist via XRW).
- **Worker class:** claude-code (you).

## Don't

- Pure deletion + shrink ticket: no new features.
- If a fixture breaks, the gap is in ARC-05/06/08 coverage — fix the runtime, don't resurrect a spawn family.

## How to land this PR

1. Provisioned worktree.
2. Read `projects/adversarial-review-core/SPEC.md` in full, then the design specs' sections named above.
3. Build the smallest reviewable diff that satisfies the scope.
4. Collect concise acceptance evidence (tests run + outcome summary).
5. Open the PR via `hq pr open` with a reviewer-pitch body (summary, what changed, why it matters, post-merge activities, acceptance evidence).

<!-- hq:closeout:pr -->

## Final step

Open the PR from inside the worker tree via `hq pr open --title "ARC-10: Delete bespoke harness code from reviewer.mjs and cli-direct" --summary "<1-3 sentence headline>" --what-changed "<files/surfaces touched, new flags, behavior deltas>" --why "<problem solved and fleet value>" --post-merge "<config flip, follow-up, or None>" --acceptance-evidence "<tests run + observed result>" --spec-ref "adversarial-review-core@2c2af26f2eda"`. After the PR opens, your turn is complete — adversarial-review and merge-agent pipelines take over.
