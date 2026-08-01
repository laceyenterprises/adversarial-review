# ARC-30 — Dispatch no-progress and latency SLO

> Plan ticket `ARC-30` from `projects/adversarial-review-core/plan.json`
> Spec: `adversarial-review-core@2c2af26f2eda`

## Source-of-truth references

- **Pack spec:** `projects/adversarial-review-core/SPEC.md` — Phase 5, ARC-30, acceptance criteria 15 and 17.
- **RCA:** `docs/RCA-adversarial-review-sdk-cutover-readiness-2026-08-01.md` — no-progress and dispatch latency remain log-only.
- **Plan:** `projects/adversarial-review-core/plan.json` — no dependencies.
- **Existing code to read first:**
  - adversarial-review `src/health-probe.mjs` — current watcher.no_progress state machine.
  - adversarial-review `src/pollonce-phases.mjs` — watcher spawn/review loop integration.
  - agent-os `modules/worker-pool/lib/python/cwp_dispatch/dispatch.py` around dispatch receipt/admission state.
  - agent-os `modules/worker-pool/lib/python/cwp_dispatch/supervisor.py` post-resume pending wake handling.
  - agent-os `modules/worker-pool/bin/hq` drain-status surface.
- **Why this exists:** A clean reviewed PR cannot be allowed to sit indefinitely because the watcher has no durable SLO action.

## Scope (mirrored from plan.json)

Add first-class dispatch acceptance latency and watcher no-progress SLOs for adversarial review: receipt-to-spawn timing is recorded from HQ, p95 feeds the hybrid-router probe, open pending PRs cannot sit past the SLO without a durable alert, and post-merge/main-catchup wake hints reduce the several-minute idle window.

## Tests (mandatory)

- Seeded dispatch ledger p95 calculation.
- Watcher no-progress alert receipt using the ARC-28 sink when available, with a test fallback if ARC-28 has not landed.
- main-catchup/post-merge wake hint fixture proving the hint is durable and bounded.
- `hq dispatch drain-status` remains read-only, bounded, and not part of the mutation path.

## Completion contract

- **Shape:** PR against `agent-os@main`.
- **Title prefix:** `[codex] ARC-30:`.
- **Risk class:** high.
- **Target repo:** `agent-os` — declared additional repo: `adversarial-review` for watcher contract reads only.
- **Worker class:** codex (you).

## Don't

- Do not make drain-status a mutating dependency.
- Do not add unbounded HQ/GitHub/log scans.
- Do not rely on the watcher eventually polling a PR as the only alert trigger.
- Do not edit adversarial-review source from this ticket; open a follow-up if the SLO work exposes a required watcher-side change.

## How to land this PR

1. Use a provisioned worker worktree.
2. Read the spec/RCA and worker-pool dispatch surfaces.
3. Add latency/SLO instrumentation and wake hints with focused tests.
4. Open the PR via `hq pr open` with acceptance evidence.

<!-- hq:closeout:pr -->

## Final step

Open the PR from inside the worker tree via `hq pr open --title "ARC-30: Dispatch no-progress and latency SLO" --summary "<1-3 sentence headline>" --what-changed "<files/surfaces touched, new flags, behavior deltas>" --why "<problem solved and fleet value>" --post-merge "<deploy smoke or None>" --acceptance-evidence "<tests run + observed result>" --spec-ref "adversarial-review-core@2c2af26f2eda"`.
