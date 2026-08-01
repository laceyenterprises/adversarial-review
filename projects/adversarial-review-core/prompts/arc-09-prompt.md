# ARC-09 — Fallback canary + failover drill + runtime status CLI

> Plan ticket `ARC-09` from `projects/adversarial-review-core/plan.json`
> Spec: `adversarial-review-core@2c2af26f2eda`

## Source-of-truth references

- **Pack spec:** `projects/adversarial-review-core/SPEC.md` — §3 (ARC-09), §4 acceptance, §9 boundaries.
- **Plan:** `projects/adversarial-review-core/plan.json` — dependencies: ARC-07; downstream consumers depend on this ticket's contract, keep it stable.
- **Design specs (in the adversarial-review repo):** `docs/SPEC-adversarial-review-v2-app-architecture.md` and `docs/SPEC-merge-authority-v2.md`.
- **Read first:**
  - ARC-07 router (merged) — drill asserts its transitions
  - `launchd/` + `scripts/` daemon wrappers — where the canary schedule hooks in
  - SPEC §1 Win 1 — the status CLI output is the contract
- **Why this exists:** A fallback that only runs during disasters rots; the canary and drill keep the lifeline honest and give the operator a truthful runtime status surface.

## Scope (mirrored from plan.json)

Add a daily scheduled synthetic review through the local runtime on a fixture domain that alerts on failure (the fallback must not rot); a drill script that kills OS endpoint connectivity in a sandboxed fixture harness, asserts automatic failover, restores connectivity, and asserts automatic resume with zero duplicate dispatches; and the 'runtime status' CLI surface from SPEC section 1 Win 1 (mode, probe detail, last failover/resume, 24h run counts by mode, reconcile stats, canary status).

## Tests (mandatory)

- canary run wired into CI against fixtures.
- drill script asserting the full failover/resume cycle.
- status CLI snapshot tests.

## Completion contract

- **Shape:** PR against `adversarial-review@main`.
- **Title prefix:** `[claude-code] ARC-09:` — adversarial review routes on the bracketed worker-class prefix.
- **Risk class:** medium.
- **Target repo:** `adversarial-review` — declared additional repos: `agent-os` (read allowlist via XRW).
- **Worker class:** claude-code (you).

## Don't

- The drill runs against a sandboxed fixture harness — never against live OS endpoints in CI.

## How to land this PR

1. Provisioned worktree.
2. Read `projects/adversarial-review-core/SPEC.md` in full, then the design specs' sections named above.
3. Build the smallest reviewable diff that satisfies the scope.
4. Collect concise acceptance evidence (tests run + outcome summary).
5. Open the PR via `hq pr open` with a reviewer-pitch body (summary, what changed, why it matters, post-merge activities, acceptance evidence).

<!-- hq:closeout:pr -->

## Final step

Open the PR from inside the worker tree via `hq pr open --title "ARC-09: Fallback canary + failover drill + runtime status CLI" --summary "<1-3 sentence headline>" --what-changed "<files/surfaces touched, new flags, behavior deltas>" --why "<problem solved and fleet value>" --post-merge "<config flip, follow-up, or None>" --acceptance-evidence "<tests run + observed result>" --spec-ref "adversarial-review-core@2c2af26f2eda"`. After the PR opens, your turn is complete — adversarial-review and merge-agent pipelines take over.
