# ARC-18 — Watcher decomposition to scheduler + kernel effects

> Plan ticket `ARC-18` from `projects/adversarial-review-core/plan.json`
> Spec: `adversarial-review-core@2c2af26f2eda`

## Source-of-truth references

- **Pack spec:** `projects/adversarial-review-core/SPEC.md` — §3 (ARC-18), §4 acceptance, §9 boundaries.
- **Plan:** `projects/adversarial-review-core/plan.json` — dependencies: ARC-10, ARC-13; downstream consumers depend on this ticket's contract, keep it stable.
- **Design specs (in the adversarial-review repo):** `docs/SPEC-adversarial-review-v2-app-architecture.md` and `docs/SPEC-merge-authority-v2.md`.
- **Read first:**
  - `src/watcher.mjs` inline GitHub mechanics: fast-merge diff-shape :1169-1319, fetchLivePRLabels :945, fetchLivePRHeadSha :978, timeline scrape :1046-1169
  - `src/adapters/subject/github-pr/` + `src/adapters/comms/github-pr-comments/` — where they move
- **Why this exists:** watcher.mjs at 10k lines is where domain knowledge goes to hide; decomposition to scheduler + effects makes the kernel boundary real.

## Scope (mirrored from plan.json)

Reduce src/watcher.mjs to a scheduler loop that pumps subjects through the kernel state machine and executes kernel-emitted effects through the adapter layers; move the inline GitHub mechanics (fast-merge diff-shape evaluation, live label/head-SHA reads, timeline scraping) behind the subject/comms adapters.

## Tests (mandatory)

- full fixture e2e parity across all registered domains.
- line-count ratchet on watcher.mjs (< 2000 lines).
- lint asserting no direct GitHub/API imports outside adapters.

## Completion contract

- **Shape:** PR against `adversarial-review@main`.
- **Title prefix:** `[claude-code] ARC-18:` — adversarial review routes on the bracketed worker-class prefix.
- **Risk class:** high.
- **Target repo:** `adversarial-review` — declared additional repos: `agent-os` (read allowlist via XRW).
- **Worker class:** claude-code (you).

## Don't

- Behavior parity is the gate — decomposition, not redesign.
- Keep each extraction commit reviewable; this is the largest diff in the pack.

## How to land this PR

1. Provisioned worktree.
2. Read `projects/adversarial-review-core/SPEC.md` in full, then the design specs' sections named above.
3. Build the smallest reviewable diff that satisfies the scope.
4. Collect concise acceptance evidence (tests run + outcome summary).
5. Open the PR via `hq pr open` with a reviewer-pitch body (summary, what changed, why it matters, post-merge activities, acceptance evidence).

<!-- hq:closeout:pr -->

## Final step

Open the PR from inside the worker tree via `hq pr open --title "ARC-18: Watcher decomposition to scheduler + kernel effects" --summary "<1-3 sentence headline>" --what-changed "<files/surfaces touched, new flags, behavior deltas>" --why "<problem solved and fleet value>" --post-merge "<config flip, follow-up, or None>" --acceptance-evidence "<tests run + observed result>" --spec-ref "adversarial-review-core@2c2af26f2eda"`. After the PR opens, your turn is complete — adversarial-review and merge-agent pipelines take over.
