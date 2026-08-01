# ARC-24 — Consume published app-sdk; delete vendored fork

> Plan ticket `ARC-24` from `projects/adversarial-review-core/plan.json`
> Spec: `adversarial-review-core@2c2af26f2eda`

## Source-of-truth references

- **Pack spec:** `projects/adversarial-review-core/SPEC.md` — §3 (ARC-24), §4 acceptance, §9 boundaries.
- **Plan:** `projects/adversarial-review-core/plan.json` — dependencies: ARC-23, ARC-07; downstream consumers depend on this ticket's contract, keep it stable.
- **Design specs (in the adversarial-review repo):** `docs/SPEC-adversarial-review-v2-app-architecture.md` and `docs/SPEC-merge-authority-v2.md`.
- **Read first:**
  - adversarial-review `src/app-contract-dispatch.mjs` — the fork being deleted, and every import site
  - agent-os `platform/app-sdk/node/` — the published package + ARC-23 packaging ADR (agent-os is a declared additional repo for this ticket)
- **Why this exists:** Deletes the vendored fork — the reference app should consume the real SDK it forced into existence.

## Scope (mirrored from plan.json)

Swap adversarial-review's vendored app-contract client (src/app-contract-dispatch.mjs) for the published app-sdk inside the os-dispatch runtime and anywhere else the fork is imported; delete the fork; the health router keeps its own probe policy but may delegate transport to the SDK hybrid mode where contracts align.

## Tests (mandatory)

- os-dispatch fixtures green on the SDK client.
- fork-file absence grep gate.
- dependency declared in package.json per the ARC-23 packaging recipe.

## Completion contract

- **Shape:** PR against `adversarial-review@main`.
- **Title prefix:** `[claude-code] ARC-24:` — adversarial review routes on the bracketed worker-class prefix.
- **Risk class:** medium.
- **Target repo:** `adversarial-review` — declared additional repos: `agent-os` (read allowlist via XRW).
- **Worker class:** claude-code (you).

## Don't

- The health router keeps its own probe policy — delegate transport only where contracts align.
- No other adversarial-review refactoring in this diff.

## How to land this PR

1. Provisioned worktree.
2. Read `projects/adversarial-review-core/SPEC.md` in full, then the design specs' sections named above.
3. Build the smallest reviewable diff that satisfies the scope.
4. Collect concise acceptance evidence (tests run + outcome summary).
5. Open the PR via `hq pr open` with a reviewer-pitch body (summary, what changed, why it matters, post-merge activities, acceptance evidence).

<!-- hq:closeout:pr -->

## Final step

Open the PR from inside the worker tree via `hq pr open --title "ARC-24: Consume published app-sdk; delete vendored fork" --summary "<1-3 sentence headline>" --what-changed "<files/surfaces touched, new flags, behavior deltas>" --why "<problem solved and fleet value>" --post-merge "<config flip, follow-up, or None>" --acceptance-evidence "<tests run + observed result>" --spec-ref "adversarial-review-core@2c2af26f2eda"`. After the PR opens, your turn is complete — adversarial-review and merge-agent pipelines take over.
