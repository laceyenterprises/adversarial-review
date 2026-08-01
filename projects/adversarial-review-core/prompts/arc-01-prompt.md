# ARC-01 — v1 snapshot, maintenance branch, AMA freeze marker

> Plan ticket `ARC-01` from `projects/adversarial-review-core/plan.json`
> Spec: `adversarial-review-core@2c2af26f2eda`

## Source-of-truth references

- **Pack spec:** `projects/adversarial-review-core/SPEC.md` — §3 (ARC-01), §4 acceptance, §9 boundaries.
- **Plan:** `projects/adversarial-review-core/plan.json` — dependencies: none; downstream consumers depend on this ticket's contract, keep it stable.
- **Design specs (in the adversarial-review repo):** `docs/SPEC-adversarial-review-v2-app-architecture.md` and `docs/SPEC-merge-authority-v2.md`.
- **Read first:**
  - `docs/SPEC-adversarial-review-v2-app-architecture.md` + `docs/SPEC-merge-authority-v2.md` (freeze rationale; merged via #609/#610)
  - `test/` fixture suites — enumerate what constitutes the green baseline
  - `src/ama/` — where the freeze note lands
- **Why this exists:** Everything downstream is a strangler-fig refactor of a live, SEV-prone system; the snapshot tag, maintenance branch, and AMA freeze are the rollback floor every later phase gate stands on.

## Scope (mirrored from plan.json)

Tag the adversarial-review repo HEAD as v1-working-snapshot, cut a v1-maintenance branch from it, record the fixture-e2e baseline (all existing domain fixture tests green at the tag, with the command list and results committed as docs/BASELINE-v1-snapshot.md), and add a FREEZE note to src/ama/ (README or header comment block) plus a cross-reference in docs stating v1 merge authority is bug-fix-only pending MA-v2 shadow promotion per docs/SPEC-merge-authority-v2.md.

## Tests (mandatory)

- baseline fixture suite green at the tag.
- a grep-based freeze-note lint added to the repo test suite.

## Completion contract

- **Shape:** PR against `adversarial-review@main`.
- **Title prefix:** `[claude-code] ARC-01:` — adversarial review routes on the bracketed worker-class prefix.
- **Risk class:** medium.
- **Target repo:** `adversarial-review` — declared additional repos: `agent-os` (read allowlist via XRW).
- **Worker class:** claude-code (you).

## Don't

- No behavior changes anywhere — this ticket is tags, branch, docs, and one grep-lint test.
- Do not tag or branch the agent-os parent repo; scope is the adversarial-review repo only.

## How to land this PR

1. Provisioned worktree.
2. Read `projects/adversarial-review-core/SPEC.md` in full, then the design specs' sections named above.
3. Build the smallest reviewable diff that satisfies the scope.
4. Collect concise acceptance evidence (tests run + outcome summary).
5. Open the PR via `hq pr open` with a reviewer-pitch body (summary, what changed, why it matters, post-merge activities, acceptance evidence).

<!-- hq:closeout:pr -->

## Final step

Open the PR from inside the worker tree via `hq pr open --title "ARC-01: v1 snapshot, maintenance branch, AMA freeze marker" --summary "<1-3 sentence headline>" --what-changed "<files/surfaces touched, new flags, behavior deltas>" --why "<problem solved and fleet value>" --post-merge "<config flip, follow-up, or None>" --acceptance-evidence "<tests run + observed result>" --spec-ref "adversarial-review-core@2c2af26f2eda"`. After the PR opens, your turn is complete — adversarial-review and merge-agent pipelines take over.
