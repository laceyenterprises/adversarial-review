# ARC-14 — Finalization port + v1 AMA wrapped unchanged

> Plan ticket `ARC-14` from `projects/adversarial-review-core/plan.json`
> Spec: `adversarial-review-core@2c2af26f2eda`

## Source-of-truth references

- **Pack spec:** `projects/adversarial-review-core/SPEC.md` — §3 (ARC-14), §4 acceptance, §9 boundaries.
- **Plan:** `projects/adversarial-review-core/plan.json` — dependencies: ARC-11; downstream consumers depend on this ticket's contract, keep it stable.
- **Design specs (in the adversarial-review repo):** `docs/SPEC-adversarial-review-v2-app-architecture.md` and `docs/SPEC-merge-authority-v2.md`.
- **Read first:**
  - `src/ama/daemon-merge.mjs`, `src/ama/dispatch-closer.mjs`, `src/follow-up-merge-agent.mjs` — wrap, do NOT modify
  - `docs/SPEC-merge-authority-v2.md` — Decision vocabulary
- **Why this exists:** The port isolates 'decide and act on finalization' so MA-v2 can be built and shadowed without touching frozen v1 behavior.

## Scope (mirrored from plan.json)

Define the finalization port in kernel contracts: evaluate(subjectState) -> FinalizationDecision (finalize-now | remediate | wait | halt | escalate) and execute(decision); implement trivial finalizers for non-code domains (mark-terminal, archive); wrap v1 AMA UNCHANGED behind the port for code-pr — wrapper only, zero behavior change, the freeze from ARC-01 holds.

## Tests (mandatory)

- port typecheck.
- trivial-impl fixtures.
- v1-wrapper parity fixtures proving identical decisions/actions on recorded scenarios.

## Completion contract

- **Shape:** PR against `adversarial-review@main`.
- **Title prefix:** `[claude-code] ARC-14:` — adversarial review routes on the bracketed worker-class prefix.
- **Risk class:** high.
- **Target repo:** `adversarial-review` — declared additional repos: `agent-os` (read allowlist via XRW).
- **Worker class:** claude-code (you).

## Don't

- ZERO v1 AMA behavior change — wrapper parity fixtures are the whole point.
- No MA-v2 logic here (ARC-15).

## How to land this PR

1. Provisioned worktree.
2. Read `projects/adversarial-review-core/SPEC.md` in full, then the design specs' sections named above.
3. Build the smallest reviewable diff that satisfies the scope.
4. Collect concise acceptance evidence (tests run + outcome summary).
5. Open the PR via `hq pr open` with a reviewer-pitch body (summary, what changed, why it matters, post-merge activities, acceptance evidence).

<!-- hq:closeout:pr -->

## Final step

Open the PR from inside the worker tree via `hq pr open --title "ARC-14: Finalization port + v1 AMA wrapped unchanged" --summary "<1-3 sentence headline>" --what-changed "<files/surfaces touched, new flags, behavior deltas>" --why "<problem solved and fleet value>" --post-merge "<config flip, follow-up, or None>" --acceptance-evidence "<tests run + observed result>" --spec-ref "adversarial-review-core@2c2af26f2eda"`. After the PR opens, your turn is complete — adversarial-review and merge-agent pipelines take over.
