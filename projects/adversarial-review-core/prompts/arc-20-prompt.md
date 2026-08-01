# ARC-20 — Adjudicate-merge app surface (GAP-1)

> Plan ticket `ARC-20` from `projects/adversarial-review-core/plan.json`
> Spec: `adversarial-review-core@2c2af26f2eda`

## Source-of-truth references

- **Pack spec:** `projects/adversarial-review-core/SPEC.md` — §3 (ARC-20), §4 acceptance, §9 boundaries.
- **Plan:** `projects/adversarial-review-core/plan.json` — dependencies: none; downstream consumers depend on this ticket's contract, keep it stable.
- **Design specs (in the adversarial-review repo):** `docs/SPEC-adversarial-review-v2-app-architecture.md` and `docs/SPEC-merge-authority-v2.md`.
- **Read first:**
  - `modules/worker-pool/lib/hq-adjudicate-merge.sh` + `modules/worker-pool/bin/hq:302,1375` — semantics to wrap
  - `platform/app-contract-endpoint/SPEC.md` — workflow_action stub + registry/idempotency model
  - `modules/hq-control-plane/server/hq_control_plane/server/mutations.py` — HCP mutation pattern if the ADR picks HCP
- **Why this exists:** Merge adjudication is the biggest sanctioned-surface gap for any app that lands work; today it exists only as a shell verb.

## Scope (mirrored from plan.json)

Expose merge adjudication through a sanctioned app surface: either wire the app-contract endpoint workflow_action backend to a real adjudicate operation or add an HCP route — the implementer records the choice in a short ADR committed with the change. The surface wraps the existing worker-pool adjudicate semantics (modules/worker-pool/lib/hq-adjudicate-merge.sh), is fail-closed, audited, idempotent on (app_id, request_id), and never widens merge authority (same checks the shell verb enforces).

## Tests (mandatory)

- surface contract tests.
- denied-without-entitlement.
- idempotent repeat returns the original outcome.
- audit rows.

## Completion contract

- **Shape:** PR against `agent-os@main`.
- **Title prefix:** `[claude-code] ARC-20:` — adversarial review routes on the bracketed worker-class prefix.
- **Risk class:** high.
- **Target repo:** `agent-os` (single-repo ticket — no adversarial-review/** reads or edits).
- **Worker class:** claude-code (you).

## Don't

- Never widen merge authority — the surface enforces exactly what the shell verb enforces.
- Fail closed on registry/ledger unavailability.

## How to land this PR

1. Provisioned worktree.
2. Read `projects/adversarial-review-core/SPEC.md` in full, then the design specs' sections named above.
3. Build the smallest reviewable diff that satisfies the scope.
4. Collect concise acceptance evidence (tests run + outcome summary).
5. Open the PR via `hq pr open` with a reviewer-pitch body (summary, what changed, why it matters, post-merge activities, acceptance evidence).

<!-- hq:closeout:pr -->

## Final step

Open the PR from inside the worker tree via `hq pr open --title "ARC-20: Adjudicate-merge app surface (GAP-1)" --summary "<1-3 sentence headline>" --what-changed "<files/surfaces touched, new flags, behavior deltas>" --why "<problem solved and fleet value>" --post-merge "<config flip, follow-up, or None>" --acceptance-evidence "<tests run + observed result>" --spec-ref "adversarial-review-core@2c2af26f2eda"`. After the PR opens, your turn is complete — adversarial-review and merge-agent pipelines take over.
