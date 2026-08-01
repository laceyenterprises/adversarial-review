# ARC-02 — Thread promptSet from domain config through reviewer and remediator

> Plan ticket `ARC-02` from `projects/adversarial-review-core/plan.json`
> Spec: `adversarial-review-core@2c2af26f2eda`

## Source-of-truth references

- **Pack spec:** `projects/adversarial-review-core/SPEC.md` — §3 (ARC-02), §4 acceptance, §9 boundaries.
- **Plan:** `projects/adversarial-review-core/plan.json` — dependencies: ARC-01; downstream consumers depend on this ticket's contract, keep it stable.
- **Design specs (in the adversarial-review repo):** `docs/SPEC-adversarial-review-v2-app-architecture.md` and `docs/SPEC-merge-authority-v2.md`.
- **Read first:**
  - `src/reviewer.mjs:1554` (REVIEWER_PROMPT_SET) and its use sites (:1557,1564,1569,1597)
  - `src/follow-up-remediation.mjs:65` (REMEDIATOR_PROMPT_SET)
  - `src/kernel/prompt-stage.mjs` — promptSet param already exists
  - `domains/code-pr.json` + `domains/research-finding.json` — promptSet declarations
- **Why this exists:** The prompt set is the cheapest harness-agnosticism lever: domain configs already declare promptSet but two hardcoded constants override them — this is also the root of the doc-PRs-reviewed-as-code hallucination mode.

## Scope (mirrored from plan.json)

Replace the hardcoded REVIEWER_PROMPT_SET (src/reviewer.mjs:1554) and REMEDIATOR_PROMPT_SET (src/follow-up-remediation.mjs:65) constants with the domain's declared promptSet from domains/<id>.json, threaded through the existing kernel prompt-stage.mjs promptSet parameter. Prompt-set resolution failures fail loud at selection time, never silently fall back to code-pr.

## Tests (mandatory)

- code-pr fixture parity proving byte-identical prompt assembly for the code-pr domain.
- research-finding fixture selects its own prompt set.
- unknown promptSet fails loud with a classified error.

## Completion contract

- **Shape:** PR against `adversarial-review@main`.
- **Title prefix:** `[claude-code] ARC-02:` — adversarial review routes on the bracketed worker-class prefix.
- **Risk class:** high.
- **Target repo:** `adversarial-review` — declared additional repos: `agent-os` (read allowlist via XRW).
- **Worker class:** claude-code (you).

## Don't

- No silent fallback to code-pr on unknown promptSet — fail loud with a classified error.
- Do not touch prompt file contents; wiring only.

## How to land this PR

1. Provisioned worktree.
2. Read `projects/adversarial-review-core/SPEC.md` in full, then the design specs' sections named above.
3. Build the smallest reviewable diff that satisfies the scope.
4. Collect concise acceptance evidence (tests run + outcome summary).
5. Open the PR via `hq pr open` with a reviewer-pitch body (summary, what changed, why it matters, post-merge activities, acceptance evidence).

<!-- hq:closeout:pr -->

## Final step

Open the PR from inside the worker tree via `hq pr open --title "ARC-02: Thread promptSet from domain config through reviewer and remediator" --summary "<1-3 sentence headline>" --what-changed "<files/surfaces touched, new flags, behavior deltas>" --why "<problem solved and fleet value>" --post-merge "<config flip, follow-up, or None>" --acceptance-evidence "<tests run + observed result>" --spec-ref "adversarial-review-core@2c2af26f2eda"`. After the PR opens, your turn is complete — adversarial-review and merge-agent pipelines take over.
