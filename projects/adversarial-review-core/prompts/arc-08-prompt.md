# ARC-08 — Unify remediation dispatch through the AgentRuntime port

> Plan ticket `ARC-08` from `projects/adversarial-review-core/plan.json`
> Spec: `adversarial-review-core@2c2af26f2eda`

## Source-of-truth references

- **Pack spec:** `projects/adversarial-review-core/SPEC.md` — §3 (ARC-08), §4 acceptance, §9 boundaries.
- **Plan:** `projects/adversarial-review-core/plan.json` — dependencies: ARC-07; downstream consumers depend on this ticket's contract, keep it stable.
- **Design specs (in the adversarial-review repo):** `docs/SPEC-adversarial-review-v2-app-architecture.md` and `docs/SPEC-merge-authority-v2.md`.
- **Read first:**
  - `src/follow-up-remediation.mjs` — spawnDetachedCli path AND shouldDispatchRemediationViaHq/buildLegacyHqRemediationDispatchArgs (:470-560)
  - role-registry default (ARC-12 may not be merged yet — read the role default from config with a documented fallback)
- **Why this exists:** Two forked remediation paths are a drift factory; one port-routed path with role-registry selection ends it.

## Scope (mirrored from plan.json)

Collapse the two forked remediation paths in src/follow-up-remediation.mjs (self-spawn via spawnDetachedCli vs legacy hq-dispatch via shouldDispatchRemediationViaHq) into AgentRuntime port calls routed by the health router; remediator role/worker-class selection moves to the role-registry default with the domain able to override. The workspace-prep responsibilities stay with the subject adapter.

## Tests (mandatory)

- remediation fixture e2e through both runtimes (os stub + local).
- the forked-path functions are deleted and a grep gate proves absence.
- round/budget accounting parity with v1 fixtures.

## Completion contract

- **Shape:** PR against `adversarial-review@main`.
- **Title prefix:** `[claude-code] ARC-08:` — adversarial review routes on the bracketed worker-class prefix.
- **Risk class:** high.
- **Target repo:** `adversarial-review` — declared additional repos: `agent-os` (read allowlist via XRW).
- **Worker class:** claude-code (you).

## Don't

- Workspace prep stays with the subject adapter — do not move git mechanics into the runtime.
- Round/budget accounting must stay parity with v1 fixtures.

## How to land this PR

1. Provisioned worktree.
2. Read `projects/adversarial-review-core/SPEC.md` in full, then the design specs' sections named above.
3. Build the smallest reviewable diff that satisfies the scope.
4. Collect concise acceptance evidence (tests run + outcome summary).
5. Open the PR via `hq pr open` with a reviewer-pitch body (summary, what changed, why it matters, post-merge activities, acceptance evidence).

<!-- hq:closeout:pr -->

## Final step

Open the PR from inside the worker tree via `hq pr open --title "ARC-08: Unify remediation dispatch through the AgentRuntime port" --summary "<1-3 sentence headline>" --what-changed "<files/surfaces touched, new flags, behavior deltas>" --why "<problem solved and fleet value>" --post-merge "<config flip, follow-up, or None>" --acceptance-evidence "<tests run + observed result>" --spec-ref "adversarial-review-core@2c2af26f2eda"`. After the PR opens, your turn is complete — adversarial-review and merge-agent pipelines take over.
