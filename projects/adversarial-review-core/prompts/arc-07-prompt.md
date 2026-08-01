# ARC-07 — Health router: automatic failover and automatic resume

> Plan ticket `ARC-07` from `projects/adversarial-review-core/plan.json`
> Spec: `adversarial-review-core@2c2af26f2eda`

## Source-of-truth references

- **Pack spec:** `projects/adversarial-review-core/SPEC.md` — §3 (ARC-07), §4 acceptance, §9 boundaries.
- **Plan:** `projects/adversarial-review-core/plan.json` — dependencies: ARC-06; downstream consumers depend on this ticket's contract, keep it stable.
- **Design specs (in the adversarial-review repo):** `docs/SPEC-adversarial-review-v2-app-architecture.md` and `docs/SPEC-merge-authority-v2.md`.
- **Read first:**
  - SPEC §6.2–6.3 of `docs/SPEC-adversarial-review-v2-app-architecture.md` — thresholds and reconcile semantics are contract
  - ARC-05/ARC-06 port + runtimes (merged by the time this dispatches)
  - `src/watcher-heartbeat.mjs`, `src/health-probe.mjs` — existing probe plumbing to reuse
- **Why this exists:** Operator-decided hybrid policy: automatic failover keeps reviews flowing through OS outages, automatic resume returns to governed dispatch without operator action or duplicate work.

## Scope (mirrored from plan.json)

Implement the hybrid runtime router: probe = app-contract healthz AND rolling dispatch-acceptance latency p95 AND SSE liveness; OS-HEALTHY -> LOCAL-FALLBACK on 3 consecutive probe failures or a single hard contract error on a live dispatch; LOCAL-FALLBACK -> OS-RESUMING -> OS-HEALTHY on 6 consecutive healthy probes spanning at least 5 minutes (hysteresis, all thresholds config-tunable). Runs finish in the mode they started; on resume, reconcile every idempotency key possibly handed to the OS pre-failover via dispatch_status and ADOPT accepted-but-unobserved dispatches, never re-issue. Every transition emits an operator notice, an audit row in the app store, and a best-effort telemetry event.

## Tests (mandatory)

- router state-machine unit tests including flap resistance and the hard-error fast path.
- reconcile-adopts fixture.
- audit-row and notice emission assertions.

## Completion contract

- **Shape:** PR against `adversarial-review@main`.
- **Title prefix:** `[claude-code] ARC-07:` — adversarial review routes on the bracketed worker-class prefix.
- **Risk class:** high.
- **Target repo:** `adversarial-review` — declared additional repos: `agent-os` (read allowlist via XRW).
- **Worker class:** claude-code (you).

## Don't

- Runs never migrate modes mid-flight.
- Resume must never re-issue an idempotency key that dispatch_status reports as known — adopt it.
- All thresholds config-tunable; no hardcoded literals outside config defaults.

## How to land this PR

1. Provisioned worktree.
2. Read `projects/adversarial-review-core/SPEC.md` in full, then the design specs' sections named above.
3. Build the smallest reviewable diff that satisfies the scope.
4. Collect concise acceptance evidence (tests run + outcome summary).
5. Open the PR via `hq pr open` with a reviewer-pitch body (summary, what changed, why it matters, post-merge activities, acceptance evidence).

<!-- hq:closeout:pr -->

## Final step

Open the PR from inside the worker tree via `hq pr open --title "ARC-07: Health router: automatic failover and automatic resume" --summary "<1-3 sentence headline>" --what-changed "<files/surfaces touched, new flags, behavior deltas>" --why "<problem solved and fleet value>" --post-merge "<config flip, follow-up, or None>" --acceptance-evidence "<tests run + observed result>" --spec-ref "adversarial-review-core@2c2af26f2eda"`. After the PR opens, your turn is complete — adversarial-review and merge-agent pipelines take over.
