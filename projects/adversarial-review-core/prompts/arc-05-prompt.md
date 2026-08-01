# ARC-05 — AgentRuntime port contract + local runtime implementation

> Plan ticket `ARC-05` from `projects/adversarial-review-core/plan.json`
> Spec: `adversarial-review-core@2c2af26f2eda`

## Source-of-truth references

- **Pack spec:** `projects/adversarial-review-core/SPEC.md` — §3 (ARC-05), §4 acceptance, §9 boundaries.
- **Plan:** `projects/adversarial-review-core/plan.json` — dependencies: ARC-01; downstream consumers depend on this ticket's contract, keep it stable.
- **Design specs (in the adversarial-review repo):** `docs/SPEC-adversarial-review-v2-app-architecture.md` and `docs/SPEC-merge-authority-v2.md`.
- **Read first:**
  - `src/kernel/contracts.d.ts` — extend, keep tsconfig.contracts.json green
  - `src/adapters/reviewer-runtime/cli-direct/index.mjs` (790 lines) — the local runtime's ancestor
  - `src/process-group-spawn.mjs`, `src/process-group-identity.mjs`
  - `src/watcher-memory-pressure.mjs`, `src/quota-exhaustion.mjs` — become the local admission layer
- **Why this exists:** The port is the altitude fix: today's runtime boundary abstracts process supervision of a monolith, not which agent runs; the local impl preserves the outage-lifeline path as a first-class citizen.

## Scope (mirrored from plan.json)

Define the AgentRuntime port in kernel contracts: run(request{role, promptSet, promptStage, subjectContent, workspaceRef, idempotencyKey, budget, timeoutMs}) -> handle{runRef, mode, await(), cancel(), reattach()} returning a structured RunResult{status, artifact?, failureClass?, usage?}. Implement the 'local' runtime as a refactor of the cli-direct path behind the port, preserving process-group isolation, forbidden-fallback env stripping, failure classification, atomic run records under data/reviewer-runs/, and adding a local admission layer composed of the existing memory-pressure gates, quota-exhaustion detection, and a per-run token/time cap.

## Tests (mandatory)

- port contract typecheck under tsconfig.contracts.json.
- local runtime fixture spawn/cancel/reattach round-trips.
- admission refusal paths for memory pressure and quota exhaustion.

## Completion contract

- **Shape:** PR against `adversarial-review@main`.
- **Title prefix:** `[claude-code] ARC-05:` — adversarial review routes on the bracketed worker-class prefix.
- **Risk class:** high.
- **Target repo:** `adversarial-review` — declared additional repos: `agent-os` (read allowlist via XRW).
- **Worker class:** claude-code (you).

## Don't

- Do not wire the watcher to the port yet — ARC-06/07 do; this ticket ships the port + local impl + tests.
- Do not delete cli-direct — refactor it into the local runtime, deletions land in ARC-10.

## How to land this PR

1. Provisioned worktree.
2. Read `projects/adversarial-review-core/SPEC.md` in full, then the design specs' sections named above.
3. Build the smallest reviewable diff that satisfies the scope.
4. Collect concise acceptance evidence (tests run + outcome summary).
5. Open the PR via `hq pr open` with a reviewer-pitch body (summary, what changed, why it matters, post-merge activities, acceptance evidence).

<!-- hq:closeout:pr -->

## Final step

Open the PR from inside the worker tree via `hq pr open --title "ARC-05: AgentRuntime port contract + local runtime implementation" --summary "<1-3 sentence headline>" --what-changed "<files/surfaces touched, new flags, behavior deltas>" --why "<problem solved and fleet value>" --post-merge "<config flip, follow-up, or None>" --acceptance-evidence "<tests run + observed result>" --spec-ref "adversarial-review-core@2c2af26f2eda"`. After the PR opens, your turn is complete — adversarial-review and merge-agent pipelines take over.
