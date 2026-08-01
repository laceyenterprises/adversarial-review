# ARC-06 — os-dispatch runtime implementation (app-contract dispatch)

> Plan ticket `ARC-06` from `projects/adversarial-review-core/plan.json`
> Spec: `adversarial-review-core@2c2af26f2eda`

## Source-of-truth references

- **Pack spec:** `projects/adversarial-review-core/SPEC.md` — §3 (ARC-06), §4 acceptance, §9 boundaries.
- **Plan:** `projects/adversarial-review-core/plan.json` — dependencies: ARC-05; downstream consumers depend on this ticket's contract, keep it stable.
- **Design specs (in the adversarial-review repo):** `docs/SPEC-adversarial-review-v2-app-architecture.md` and `docs/SPEC-merge-authority-v2.md`.
- **Read first:**
  - `src/app-contract-dispatch.mjs` — the vendored v1.0 app-contract client; refactor INTO this adapter (endpoints: /v1/register, /v1/dispatch, /v1/dispatch_status; idempotency on (app_id, request_id))
  - `src/adapters/reviewer-runtime/agent-os-hq/index.mjs` — AOM's seam; supersede or absorb
  - `src/kernel/verdict.mjs` — artifact must normalize to the same Verdict shape
- **Why this exists:** Routes reviews/remediations through the OS worker pool (admission, allowlists, auth, budgets, telemetry) instead of the repo's private harness zoo.

## Scope (mirrored from plan.json)

Implement the AgentRuntime port against the app-contract endpoint: reviews dispatch with task-kind review and completion-shape decision-only, returning the verdict as a structured ReviewArtifact (schemaVersion 2, per SPEC-adversarial-review-v2-app-architecture section 4.3); remediation dispatches with completion-shape branch-push. Builds on the AOM agent-os-hq seam; the existing vendored app-contract client is refactored INTO this adapter (published-SDK swap happens in ARC-24). Propagate idempotency keys as the app-contract request_id.

## Tests (mandatory)

- stub-endpoint round-trip returning a verdict artifact.
- artifact schema validation (valid, missing-field, wrong-kind).
- idempotency-key propagation assertions.
- dispatch_status polling with terminal-state mapping.

## Completion contract

- **Shape:** PR against `adversarial-review@main`.
- **Title prefix:** `[claude-code] ARC-06:` — adversarial review routes on the bracketed worker-class prefix.
- **Risk class:** high.
- **Target repo:** `adversarial-review` — declared additional repos: `agent-os` (read allowlist via XRW).
- **Worker class:** claude-code (you).

## Don't

- Do not import from or reference the agent-os repo tree — the vendored client in this repo is the wire-contract reference (published-SDK swap is ARC-24).
- Do not make os-dispatch the production default here — router cutover is ARC-07.

## How to land this PR

1. Provisioned worktree.
2. Read `projects/adversarial-review-core/SPEC.md` in full, then the design specs' sections named above.
3. Build the smallest reviewable diff that satisfies the scope.
4. Collect concise acceptance evidence (tests run + outcome summary).
5. Open the PR via `hq pr open` with a reviewer-pitch body (summary, what changed, why it matters, post-merge activities, acceptance evidence).

<!-- hq:closeout:pr -->

## Final step

Open the PR from inside the worker tree via `hq pr open --title "ARC-06: os-dispatch runtime implementation (app-contract dispatch)" --summary "<1-3 sentence headline>" --what-changed "<files/surfaces touched, new flags, behavior deltas>" --why "<problem solved and fleet value>" --post-merge "<config flip, follow-up, or None>" --acceptance-evidence "<tests run + observed result>" --spec-ref "adversarial-review-core@2c2af26f2eda"`. After the PR opens, your turn is complete — adversarial-review and merge-agent pipelines take over.
