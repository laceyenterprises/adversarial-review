# ARC-25 — Runtime default cutover gate

> Plan ticket `ARC-25` from `projects/adversarial-review-core/plan.json`
> Spec: `adversarial-review-core@2c2af26f2eda`

## Source-of-truth references

- **Pack spec:** `projects/adversarial-review-core/SPEC.md` — Phase 5, ARC-25, acceptance criteria 10 and 17.
- **RCA:** `docs/RCA-adversarial-review-sdk-cutover-readiness-2026-08-01.md` — runtime selection blocker.
- **Plan:** `projects/adversarial-review-core/plan.json` — dependencies: ARC-24.
- **Existing code to read first:**
  - adversarial-review `domains/code-pr.json` and `domains/code-pr-security.json` — both still declare `reviewerRuntime: "cli-direct"`.
  - adversarial-review `src/adapters/reviewer-runtime/index.mjs` lines 18-42 — env kill switch, `orchestrationMode === 'agentos'`, and domain default resolution.
  - adversarial-review `src/adapters/reviewer-runtime/agent-runtime/index.mjs` — SDK-backed adapter behavior.
  - adversarial-review `src/runtime-status.mjs` and `src/runtime-status-snapshot.mjs` — operator-visible truth surface.
  - agent-os `platform/app-sdk/` — SDK/hybrid contracts consumed by ARC-24.
- **Why this exists:** Full cutover is unsafe while production config still points at cli-direct and agentos mode still resolves to the older HQ adapter.

## Scope (mirrored from plan.json)

Replace the remaining cli-direct production reviewer default with agent-runtime only behind a truthful readiness gate: domain config, orchestrationMode=agentos, runtime status, canary, and the ADVERSARIAL_REVIEWER_RUNTIME kill switch all agree. The gate must refuse full cutover when hybrid fallback is degraded, and it must record why.

## Tests (mandatory)

- Runtime-selection unit matrix covering domain config, orchestrationMode, env kill switch, unknown env override, and degraded readiness.
- code-pr and code-pr-security domain fixture assertions.
- agent-runtime settle smoke proving a review can dispatch and reattach through the SDK-backed adapter.
- Kill-switch rollback fixture proving `ADVERSARIAL_REVIEWER_RUNTIME=cli-direct` forces standalone local operation quickly.

## Completion contract

- **Shape:** PR against `adversarial-review@main`.
- **Title prefix:** `[codex] ARC-25:` — adversarial review routes on the bracketed worker-class prefix.
- **Risk class:** high.
- **Target repo:** `adversarial-review` — declared additional repo: `agent-os` for SDK contract reads.
- **Worker class:** codex (you).

## Don't

- Do not remove the emergency runtime kill switch.
- Do not flip tracked production domains unless the readiness gate can explain and refuse degraded states.
- Do not edit Agent OS SDK code except for a minimal contract fixture/readme correction required by this ticket.

## How to land this PR

1. Use a provisioned worker worktree.
2. Read `projects/adversarial-review-core/SPEC.md` in full, then the RCA above.
3. Build the smallest reviewable diff that satisfies the readiness gate.
4. Collect concise acceptance evidence with test names and outcomes.
5. Open the PR via `hq pr open` with summary, changed surfaces, why it matters, post-merge action, and acceptance evidence.

<!-- hq:closeout:pr -->

## Final step

Open the PR from inside the worker tree via `hq pr open --title "ARC-25: Runtime default cutover gate" --summary "<1-3 sentence headline>" --what-changed "<files/surfaces touched, new flags, behavior deltas>" --why "<problem solved and fleet value>" --post-merge "<config flip, deploy smoke, or None>" --acceptance-evidence "<tests run + observed result>" --spec-ref "adversarial-review-core@2c2af26f2eda"`.
