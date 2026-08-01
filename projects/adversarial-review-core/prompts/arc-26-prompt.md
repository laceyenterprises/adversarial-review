# ARC-26 — Remediation AgentRuntime parity

> Plan ticket `ARC-26` from `projects/adversarial-review-core/plan.json`
> Spec: `adversarial-review-core@2c2af26f2eda`

## Source-of-truth references

- **Pack spec:** `projects/adversarial-review-core/SPEC.md` — Phase 5, ARC-26, acceptance criteria 11 and 17.
- **RCA:** `docs/RCA-adversarial-review-sdk-cutover-readiness-2026-08-01.md` — remediation is still outside the SDK path.
- **Plan:** `projects/adversarial-review-core/plan.json` — dependencies: ARC-08, ARC-24.
- **Existing code to read first:**
  - adversarial-review `src/follow-up-remediation.mjs` lines 70-91, 520-580, and 1680-1730 — current direct imports/spawns for Claude/Gemini/Codex remediation.
  - adversarial-review `src/remediation-claude-code-worker.mjs` lines 17-147 — extracted leaf that still calls `spawnDetachedCli`.
  - adversarial-review `src/adapters/agent-runtime/local/index.mjs` and `src/adapters/agent-runtime/os-dispatch/index.mjs` — AgentRuntime handle semantics.
  - adversarial-review `src/remediation-reply-paths.mjs` and `src/remediation-prompt-builder.mjs` — reply landing pad and prompt ownership.
- **Why this exists:** Reviews cannot be "SDK cut over" while remediation, the half that actually keeps PRs alive, still bypasses the runtime port.

## Scope (mirrored from plan.json)

Finish the ARC-08 promise for every remediator path, including the extracted Claude Code leaf and the Codex and Gemini spawns still in follow-up-remediation.mjs: remediation requests go through AgentRuntime branch-push handles with local fallback, preserving reply landing pads, commit trailers, round accounting, OAuth stripping, and reattach/cancel behavior.

## Tests (mandatory)

- Branch-push remediation fixture through OS stub and through local runtime.
- Grep gate proving direct `spawnDetachedCli` is absent from remediation surfaces.
- v1 parity fixtures for remediation round/budget accounting and reply files.
- Reattach/cancel fixture for an in-flight remediation handle.

## Completion contract

- **Shape:** PR against `adversarial-review@main`.
- **Title prefix:** `[codex] ARC-26:`.
- **Risk class:** high.
- **Target repo:** `adversarial-review` — declared additional repo: `agent-os` for SDK/HQ contract reads.
- **Worker class:** codex (you).

## Don't

- Do not move workspace-prep git mechanics into AgentRuntime.
- Do not weaken OAuth fallback stripping or commit-trailer provenance.
- Do not delete local fallback; standalone operation is the safety rail.

## How to land this PR

1. Use a provisioned worker worktree.
2. Read the pack spec, RCA, and ARC-08 prompt before changing code.
3. Keep the diff focused on remediation runtime ownership and tests.
4. Open the PR via `hq pr open` with concrete acceptance evidence.

<!-- hq:closeout:pr -->

## Final step

Open the PR from inside the worker tree via `hq pr open --title "ARC-26: Remediation AgentRuntime parity" --summary "<1-3 sentence headline>" --what-changed "<files/surfaces touched, new flags, behavior deltas>" --why "<problem solved and fleet value>" --post-merge "<deploy smoke or None>" --acceptance-evidence "<tests run + observed result>" --spec-ref "adversarial-review-core@2c2af26f2eda"`.
