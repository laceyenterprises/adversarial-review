# ARC-12 — Role registry + comms identity binding

> Plan ticket `ARC-12` from `projects/adversarial-review-core/plan.json`
> Spec: `adversarial-review-core@2c2af26f2eda`

## Source-of-truth references

- **Pack spec:** `projects/adversarial-review-core/SPEC.md` — §3 (ARC-12), §4 acceptance, §9 boundaries.
- **Plan:** `projects/adversarial-review-core/plan.json` — dependencies: ARC-11; downstream consumers depend on this ticket's contract, keep it stable.
- **Design specs (in the adversarial-review repo):** `docs/SPEC-adversarial-review-v2-app-architecture.md` and `docs/SPEC-merge-authority-v2.md`.
- **Read first:**
  - `config.yaml` roles.* + `src/role-config.mjs` — the enum being replaced
  - `src/adapters/subject/github-pr/routing.mjs:19-52` — botTokenEnv fusion being dismantled
  - `src/adapters/comms/github-pr-comments/` — where identity binding lands
- **Why this exists:** Roles become config: adding a reviewer type stops meaning code changes, and GitHub bot identity moves to the delivery layer where it belongs.

## Scope (mirrored from plan.json)

Add the roles.registry config shape (role id -> promptSet, workerClass or persona, taskKind, completionShape) with load-time validation of worker classes against the hq-published class list; implement the never-review-own-builder-class routing constraint kernel-side against SubjectState.builderClass; move per-role GitHub bot identity (botTokenEnv) out of adapters/subject/github-pr/routing.mjs into comms-adapter delivery config keyed by role id so the kernel and registry never see tokens.

## Tests (mandatory)

- registry validation (unknown worker class fails at load).
- routing-constraint fixtures.
- comms delivery fixtures asserting per-role identity selection.

## Completion contract

- **Shape:** PR against `adversarial-review@main`.
- **Title prefix:** `[claude-code] ARC-12:` — adversarial review routes on the bracketed worker-class prefix.
- **Risk class:** high.
- **Target repo:** `adversarial-review` — declared additional repos: `agent-os` (read allowlist via XRW).
- **Worker class:** claude-code (you).

## Don't

- Kernel and registry never see tokens — identity is comms-adapter config.
- Worker-class validation calls hq at load with a cached snapshot fallback; never a hardcoded class list.

## How to land this PR

1. Provisioned worktree.
2. Read `projects/adversarial-review-core/SPEC.md` in full, then the design specs' sections named above.
3. Build the smallest reviewable diff that satisfies the scope.
4. Collect concise acceptance evidence (tests run + outcome summary).
5. Open the PR via `hq pr open` with a reviewer-pitch body (summary, what changed, why it matters, post-merge activities, acceptance evidence).

<!-- hq:closeout:pr -->

## Final step

Open the PR from inside the worker tree via `hq pr open --title "ARC-12: Role registry + comms identity binding" --summary "<1-3 sentence headline>" --what-changed "<files/surfaces touched, new flags, behavior deltas>" --why "<problem solved and fleet value>" --post-merge "<config flip, follow-up, or None>" --acceptance-evidence "<tests run + observed result>" --spec-ref "adversarial-review-core@2c2af26f2eda"`. After the PR opens, your turn is complete — adversarial-review and merge-agent pipelines take over.
