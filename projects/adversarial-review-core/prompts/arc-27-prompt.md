# ARC-27 — Verdict and follow-up fidelity

> Plan ticket `ARC-27` from `projects/adversarial-review-core/plan.json`
> Spec: `adversarial-review-core@2c2af26f2eda`

## Source-of-truth references

- **Pack spec:** `projects/adversarial-review-core/SPEC.md` — Phase 5, ARC-27, acceptance criteria 12 and 17.
- **RCA:** `docs/RCA-adversarial-review-sdk-cutover-readiness-2026-08-01.md` — false critical follow-up blocker.
- **Plan:** `projects/adversarial-review-core/plan.json` — no dependencies.
- **Existing code to read first:**
  - adversarial-review `src/follow-up-jobs.mjs` lines 348-358 — recommended follow-up action currently says "critical review findings" when `critical` is true.
  - adversarial-review `src/follow-up-jobs.mjs` lines 361-370 — settled comment-only/approved detection.
  - adversarial-review `src/reviewed-attestation.mjs` lines 64-108 and 236-264 — findings count extraction/provenance.
  - adversarial-review tests around `reviewed-attestation.test.mjs`, `follow-up-retrigger-label.test.mjs`, and any Linear triage adapter tests.
  - Live regression shape: `laceyenterprises/agent-os#4562` had a clean `Comment only`, green checks, and no blocking findings.
- **Why this exists:** A clean review must not create urgent or critical remediation state; noisy false critical work hides real system failures.

## Scope (mirrored from plan.json)

Make comment-only or approved reviews with zero blocking findings settle cleanly: they must not create critical follow-up jobs, critical Linear flags, high-priority recommended actions, or misleading critical review findings prompt text. Blocking findings still open remediation under the same strict posture.

## Tests (mandatory)

- comment-only/findings_count=0 fixture creates no critical follow-up state.
- request-changes or blocking-finding fixture still opens remediation under strict policy.
- Linear triage adapter fixture proves no critical flag/comment for clean comment-only.
- Regression fixture for the `agent-os#4562` clean-review shape.

## Completion contract

- **Shape:** PR against `adversarial-review@main`.
- **Title prefix:** `[codex] ARC-27:`.
- **Risk class:** medium.
- **Target repo:** `adversarial-review` — declared additional repo: `agent-os` for live regression context only.
- **Worker class:** codex (you).

## Don't

- Do not weaken blocking review behavior.
- Do not treat missing findings_count as clean unless the review body itself proves no blocking issues.
- Do not make the Linear path silently skip real critical blockers.

## How to land this PR

1. Use a provisioned worker worktree.
2. Read the spec/RCA, then inspect follow-up job creation and Linear sync.
3. Patch the smallest fidelity bug and add regression tests.
4. Open the PR via `hq pr open` with test evidence.

<!-- hq:closeout:pr -->

## Final step

Open the PR from inside the worker tree via `hq pr open --title "ARC-27: Verdict and follow-up fidelity" --summary "<1-3 sentence headline>" --what-changed "<files/surfaces touched, new flags, behavior deltas>" --why "<problem solved and fleet value>" --post-merge "None" --acceptance-evidence "<tests run + observed result>" --spec-ref "adversarial-review-core@2c2af26f2eda"`.
