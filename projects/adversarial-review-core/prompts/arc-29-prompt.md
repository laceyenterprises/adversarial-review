# ARC-29 — Branch-protection closeout

> Plan ticket `ARC-29` from `projects/adversarial-review-core/plan.json`
> Spec: `adversarial-review-core@2c2af26f2eda`

## Source-of-truth references

- **Pack spec:** `projects/adversarial-review-core/SPEC.md` — Phase 5, ARC-29, acceptance criteria 14 and 17.
- **RCA:** `docs/RCA-adversarial-review-sdk-cutover-readiness-2026-08-01.md` — branch gate warnings remain unclosed.
- **Plan:** `projects/adversarial-review-core/plan.json` — no dependencies.
- **Existing code to read first:**
  - adversarial-review `src/check-branch-protection.mjs` lines 64-121 — current audit CLI and exit behavior.
  - adversarial-review `src/branch-protection.mjs` — GitHub branch protection probe.
  - adversarial-review `src/ama/eligibility.mjs` around branch-protection requirement checks.
  - adversarial-review `docs/follow-up-runbook.md` lines 13, 123-131 — operator contract.
  - Live warning shape: missing for `laceyenterprises/adversarial-review`; forbidden/unreadable for several watched repos including `agent-os`.
- **Why this exists:** The adversarial gate is only a real merge invariant when branch protection requires it or autonomous merge refuses to proceed without that proof.

## Scope (mirrored from plan.json)

Turn agent-os/adversarial-gate warnings into an operator-closeable contract: audit all watched repos, apply or prepare the required branch-protection context where credentials allow it, persist forbidden/missing evidence per repo, and make autonomous merge refuse the protected path when the configured domain requires branch protection but the gate is not actually required.

## Tests (mandatory)

- `check-branch-protection --json` output schema and exit-code tests.
- Missing, forbidden, and required-context fixtures.
- AMA eligibility refusal when domain policy requires branch protection and evidence says the gate is missing.
- Runbook/update with exact manual GitHub admin commands for forbidden repos.

## Completion contract

- **Shape:** PR against `adversarial-review@main`.
- **Title prefix:** `[codex] ARC-29:`.
- **Risk class:** high.
- **Target repo:** `adversarial-review` — declared additional repo: `agent-os` for policy/runbook references.
- **Worker class:** codex (you).

## Don't

- Do not assume the token has repo-admin privileges; persist forbidden evidence.
- Do not silently waive branch protection for production code-pr domains.
- Do not require the adversarial gate as a circular CI check in checks-summary logic.

## How to land this PR

1. Use a provisioned worker worktree.
2. Read the spec/RCA and branch-protection docs before coding.
3. Add machine-readable closeout evidence and fail-closed autonomous merge behavior.
4. Open the PR via `hq pr open` with tests and manual-action evidence.

<!-- hq:closeout:pr -->

## Final step

Open the PR from inside the worker tree via `hq pr open --title "ARC-29: Branch-protection closeout" --summary "<1-3 sentence headline>" --what-changed "<files/surfaces touched, new flags, behavior deltas>" --why "<problem solved and fleet value>" --post-merge "<operator branch-protection audit/apply step or None>" --acceptance-evidence "<tests run + observed result>" --spec-ref "adversarial-review-core@2c2af26f2eda"`.
