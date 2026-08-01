# ARC-03 — De-hardcode domainId; watcher iterates the domain registry

> Plan ticket `ARC-03` from `projects/adversarial-review-core/plan.json`
> Spec: `adversarial-review-core@2c2af26f2eda`

## Source-of-truth references

- **Pack spec:** `projects/adversarial-review-core/SPEC.md` — §3 (ARC-03), §4 acceptance, §9 boundaries.
- **Plan:** `projects/adversarial-review-core/plan.json` — dependencies: ARC-01; downstream consumers depend on this ticket's contract, keep it stable.
- **Design specs (in the adversarial-review repo):** `docs/SPEC-adversarial-review-v2-app-architecture.md` and `docs/SPEC-merge-authority-v2.md`.
- **Read first:**
  - `src/watcher.mjs` domainId sites: :321,405,448,474,532,547,3510,5733,5748,7337,7664,7948
  - `src/identity-shapes.mjs:1` (CODE_PR_DOMAIN_ID fallback)
  - `src/adapters/reviewer-runtime/index.mjs` loadDomainConfig — reuse, don't duplicate
- **Why this exists:** The watcher assumes exactly one domain; multi-domain iteration is the precondition for security review, research-finding, and every future subject type.

## Scope (mirrored from plan.json)

Remove the ~12 hardcoded domainId: 'code-pr' sites in src/watcher.mjs and the CODE_PR_DOMAIN_ID fallback in src/identity-shapes.mjs; introduce a domain registry loader that enumerates domains/*.json with an explicit registered/enabled flag, and make the watcher poll loop pump each registered domain through its own adapter set. code-pr remains the only enabled production domain after this ticket.

## Tests (mandatory)

- code-pr behavior parity on fixtures.
- a two-domain fixture run proving per-domain adapter isolation (no cross-domain state bleed).
- registry loader validation failures fail loud.

## Completion contract

- **Shape:** PR against `adversarial-review@main`.
- **Title prefix:** `[claude-code] ARC-03:` — adversarial review routes on the bracketed worker-class prefix.
- **Risk class:** high.
- **Target repo:** `adversarial-review` — declared additional repos: `agent-os` (read allowlist via XRW).
- **Worker class:** claude-code (you).

## Don't

- code-pr stays the only ENABLED domain; do not enable research-finding in production config.
- Do not refactor watcher structure beyond the registry loop — decomposition is ARC-18.

## How to land this PR

1. Provisioned worktree.
2. Read `projects/adversarial-review-core/SPEC.md` in full, then the design specs' sections named above.
3. Build the smallest reviewable diff that satisfies the scope.
4. Collect concise acceptance evidence (tests run + outcome summary).
5. Open the PR via `hq pr open` with a reviewer-pitch body (summary, what changed, why it matters, post-merge activities, acceptance evidence).

<!-- hq:closeout:pr -->

## Final step

Open the PR from inside the worker tree via `hq pr open --title "ARC-03: De-hardcode domainId; watcher iterates the domain registry" --summary "<1-3 sentence headline>" --what-changed "<files/surfaces touched, new flags, behavior deltas>" --why "<problem solved and fleet value>" --post-merge "<config flip, follow-up, or None>" --acceptance-evidence "<tests run + observed result>" --spec-ref "adversarial-review-core@2c2af26f2eda"`. After the PR opens, your turn is complete — adversarial-review and merge-agent pipelines take over.
