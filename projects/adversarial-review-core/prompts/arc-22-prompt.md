# ARC-22 — Attestation read surface (GAP-3)

> Plan ticket `ARC-22` from `projects/adversarial-review-core/plan.json`
> Spec: `adversarial-review-core@2c2af26f2eda`

## Source-of-truth references

- **Pack spec:** `projects/adversarial-review-core/SPEC.md` — §3 (ARC-22), §4 acceptance, §9 boundaries.
- **Plan:** `projects/adversarial-review-core/plan.json` — dependencies: none; downstream consumers depend on this ticket's contract, keep it stable.
- **Design specs (in the adversarial-review repo):** `docs/SPEC-adversarial-review-v2-app-architecture.md` and `docs/SPEC-merge-authority-v2.md`.
- **Read first:**
  - `platform/session-ledger/` — attestation + build-completion tables and their sanctioned read APIs
  - `modules/hq-control-plane/` route conventions — if the ADR picks HCP
- **Why this exists:** Direct ledger reads from apps are the reach-into-internals pattern this whole program retires; attestations/identity are the concrete consumer.

## Scope (mirrored from plan.json)

Add a sanctioned read API for reviewed/produced head attestations and worker build-completion signals, replacing direct ledger SQLite/Postgres reads by apps (target consumer: adversarial-review's session-ledger-read-adapter.mjs). Home is platform/ or the app-contract endpoint — implementer records an ADR. Read-only, session-token-authenticated for apps plus loopback for OS daemons.

## Tests (mandatory)

- contract tests.
- parity fixtures comparing surface results against direct-read results on seeded ledgers.
- auth refusal paths.

## Completion contract

- **Shape:** PR against `agent-os@main`.
- **Title prefix:** `[claude-code] ARC-22:` — adversarial review routes on the bracketed worker-class prefix.
- **Risk class:** medium.
- **Target repo:** `agent-os` (single-repo ticket — no adversarial-review/** reads or edits).
- **Worker class:** claude-code (you).

## Don't

- Read-only surface; no attestation writes.
- Consumer queries to satisfy: reviewed/produced attestations by (repo, pr, head-sha); build-completion signal by (repo, pr). Keep the response shapes stable and versioned.

## How to land this PR

1. Provisioned worktree.
2. Read `projects/adversarial-review-core/SPEC.md` in full, then the design specs' sections named above.
3. Build the smallest reviewable diff that satisfies the scope.
4. Collect concise acceptance evidence (tests run + outcome summary).
5. Open the PR via `hq pr open` with a reviewer-pitch body (summary, what changed, why it matters, post-merge activities, acceptance evidence).

<!-- hq:closeout:pr -->

## Final step

Open the PR from inside the worker tree via `hq pr open --title "ARC-22: Attestation read surface (GAP-3)" --summary "<1-3 sentence headline>" --what-changed "<files/surfaces touched, new flags, behavior deltas>" --why "<problem solved and fleet value>" --post-merge "<config flip, follow-up, or None>" --acceptance-evidence "<tests run + observed result>" --spec-ref "adversarial-review-core@2c2af26f2eda"`. After the PR opens, your turn is complete — adversarial-review and merge-agent pipelines take over.
