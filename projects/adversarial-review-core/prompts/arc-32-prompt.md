# ARC-32 — End-to-end cutover drill and readiness report

> Plan ticket `ARC-32` from `projects/adversarial-review-core/plan.json`
> Spec: `adversarial-review-core@2c2af26f2eda`

## Source-of-truth references

- **Pack spec:** `projects/adversarial-review-core/SPEC.md` — Phase 5, ARC-32, acceptance criterion 17.
- **RCA:** `docs/RCA-adversarial-review-sdk-cutover-readiness-2026-08-01.md` — all readiness blockers.
- **Plan:** `projects/adversarial-review-core/plan.json` — dependencies: ARC-25 through ARC-31.
- **Existing code to read first:**
  - agent-os `platform/app-sdk/` — SDK status and hybrid behavior.
  - agent-os `modules/worker-pool/bin/hq` and dispatch status/drain commands.
  - adversarial-review runtime status, health-probe, alert-delivery, branch-protection, retrigger, and follow-up job surfaces.
  - adversarial-review `docs/follow-up-runbook.md` and Agent OS deploy/catchup runbooks.
- **Why this exists:** Full cutover must be a command with a report, not a vibe. The command is the final permission slip for SDK-first operation.

## Scope (mirrored from plan.json)

Ship the final operator command and report that proves ARC can cut over: runtime default, SDK/hybrid fallback, remediation branch-push, alert delivery, branch protection, dispatch SLO, verdict fidelity, standalone fallback drill, and live clean-PR closure are all checked in one bounded run.

## Tests (mandatory)

- Fixture drill covering SDK healthy, SDK down -> standalone fallback, SDK recovered -> resume, zero duplicate dispatches.
- JSON report schema with pass/fail/details for ARC-25..31 gates.
- Failure matrix proving each missing gate returns NOT_READY with a specific reason.
- Runbook update declaring full SDK cutover blocked until this command returns READY on the deploy host.

## Completion contract

- **Shape:** PR against `agent-os@main`.
- **Title prefix:** `[codex] ARC-32:`.
- **Risk class:** high.
- **Target repo:** `agent-os` — declared additional repo: `adversarial-review`.
- **Worker class:** codex (you).

## Don't

- Do not make the command mutate production by default; fixture and dry-run first.
- Do not call READY if branch protection, alerts, remediation, or standalone fallback are degraded.
- Do not require long unbounded log scans.

## How to land this PR

1. Use a provisioned worker worktree.
2. Read the spec/RCA and verify ARC-25..31 merged/deployed state before coding.
3. Implement a bounded readiness command and report schema.
4. Open the PR via `hq pr open` with fixture evidence and any live dry-run output.

<!-- hq:closeout:pr -->

## Final step

Open the PR from inside the worker tree via `hq pr open --title "ARC-32: End-to-end cutover drill and readiness report" --summary "<1-3 sentence headline>" --what-changed "<files/surfaces touched, new flags, behavior deltas>" --why "<problem solved and fleet value>" --post-merge "<deploy-host dry-run command or None>" --acceptance-evidence "<tests run + observed result>" --spec-ref "adversarial-review-core@2c2af26f2eda"`.
