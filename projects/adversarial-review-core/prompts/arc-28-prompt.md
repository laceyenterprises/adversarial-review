# ARC-28 — Alert sink durability

> Plan ticket `ARC-28` from `projects/adversarial-review-core/plan.json`
> Spec: `adversarial-review-core@2c2af26f2eda`

## Source-of-truth references

- **Pack spec:** `projects/adversarial-review-core/SPEC.md` — Phase 5, ARC-28, acceptance criteria 13 and 17.
- **RCA:** `docs/RCA-adversarial-review-sdk-cutover-readiness-2026-08-01.md` — alert delivery is failing to the local bus.
- **Plan:** `projects/adversarial-review-core/plan.json` — no dependencies.
- **Existing code to read first:**
  - adversarial-review `src/alert-delivery.mjs` lines 67-88 and 186-218 — single-shot delivery and error throw.
  - adversarial-review `src/health-probe.mjs` lines 108-117 — health alert delivery currently logs and returns false.
  - adversarial-review `src/config-loader.mjs` lines 733-745 and 2595-2600 — `agent_gateway.alert_bus_url` CFG.
  - adversarial-review `src/merge-agent-stuck-alert.mjs` and `src/ama/hammer-retry-cap.mjs` — existing alert callers.
  - agent-os alert bus/gateway docs and tests for durable alert/outbox delivery.
- **Why this exists:** A stuck review pipeline must not depend on a best-effort localhost POST that disappears when the bus is down.

## Scope (mirrored from plan.json)

Replace single-shot local HTTP alert delivery with a durable, observable alert sink: delivery uses the Agent OS alert bus config, records success/failure receipts, retries or queues locally when 127.0.0.1:18799 is unavailable, and exposes a health/readiness signal that fails before a page is silently lost.

## Tests (mandatory)

- Unavailable bus queues a durable receipt instead of losing the alert.
- Recovered bus drains the queued receipt exactly once.
- Config precedence test for `agent_gateway.alert_bus_url` and legacy envs.
- no-progress and hammer-cap alert callers use the same sink.

## Completion contract

- **Shape:** PR against `adversarial-review@main`.
- **Title prefix:** `[codex] ARC-28:`.
- **Risk class:** high.
- **Target repo:** `adversarial-review` — declared additional repo: `agent-os` for alert bus contract reads.
- **Worker class:** codex (you).

## Don't

- Do not create a second alert stack that bypasses Agent OS comms ownership.
- Do not make missing ALERT_TO silently succeed.
- Do not block the watcher on slow network delivery; durable queue first, drain separately.

## How to land this PR

1. Use a provisioned worker worktree.
2. Read the spec/RCA and alert-delivery call sites.
3. Add durable receipts/outbox behavior and health evidence.
4. Open the PR via `hq pr open` with acceptance evidence.

<!-- hq:closeout:pr -->

## Final step

Open the PR from inside the worker tree via `hq pr open --title "ARC-28: Alert sink durability" --summary "<1-3 sentence headline>" --what-changed "<files/surfaces touched, new flags, behavior deltas>" --why "<problem solved and fleet value>" --post-merge "<deploy alert-smoke or None>" --acceptance-evidence "<tests run + observed result>" --spec-ref "adversarial-review-core@2c2af26f2eda"`.
