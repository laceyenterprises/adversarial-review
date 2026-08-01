# ARC-21 — App-facing ledger notes API (GAP-2)

> Plan ticket `ARC-21` from `projects/adversarial-review-core/plan.json`
> Spec: `adversarial-review-core@2c2af26f2eda`

## Source-of-truth references

- **Pack spec:** `projects/adversarial-review-core/SPEC.md` — §3 (ARC-21), §4 acceptance, §9 boundaries.
- **Plan:** `projects/adversarial-review-core/plan.json` — dependencies: none; downstream consumers depend on this ticket's contract, keep it stable.
- **Design specs (in the adversarial-review repo):** `docs/SPEC-adversarial-review-v2-app-architecture.md` and `docs/SPEC-merge-authority-v2.md`.
- **Read first:**
  - `platform/app-contract-endpoint/SPEC.md` + `server` implementation — endpoint conventions, session tokens, idempotency
  - `platform/session-ledger/` AGENTS.md + migration conventions — the sanctioned write path
- **Why this exists:** Apps have no sanctioned way to write notes/events into durable session truth; adversarial-review's finalization ledger mirror and every future app need one.

## Scope (mirrored from plan.json)

Add a minimal append-only notes/events write surface for registered apps on the app-contract endpoint (platform/app-contract-endpoint): schema-validated note kinds, quota-bounded per app, session-token-authenticated, landing in a session-ledger app-notes table via the ledger's sanctioned write path; document local-queue-and-flush client semantics for apps in degraded mode.

## Tests (mandatory)

- endpoint contract tests (accept, schema-reject, quota refusal).
- replay dedupe on (app_id, note_id).
- ledger row landing assertions against the disposable-Postgres harness.

## Completion contract

- **Shape:** PR against `agent-os@main`.
- **Title prefix:** `[claude-code] ARC-21:` — adversarial review routes on the bracketed worker-class prefix.
- **Risk class:** medium.
- **Target repo:** `agent-os` (single-repo ticket — no adversarial-review/** reads or edits).
- **Worker class:** claude-code (you).

## Don't

- Append-only; no update/delete surface.
- Quota-bounded per app; schema-validated kinds only.

## How to land this PR

1. Provisioned worktree.
2. Read `projects/adversarial-review-core/SPEC.md` in full, then the design specs' sections named above.
3. Build the smallest reviewable diff that satisfies the scope.
4. Collect concise acceptance evidence (tests run + outcome summary).
5. Open the PR via `hq pr open` with a reviewer-pitch body (summary, what changed, why it matters, post-merge activities, acceptance evidence).

<!-- hq:closeout:pr -->

## Final step

Open the PR from inside the worker tree via `hq pr open --title "ARC-21: App-facing ledger notes API (GAP-2)" --summary "<1-3 sentence headline>" --what-changed "<files/surfaces touched, new flags, behavior deltas>" --why "<problem solved and fleet value>" --post-merge "<config flip, follow-up, or None>" --acceptance-evidence "<tests run + observed result>" --spec-ref "adversarial-review-core@2c2af26f2eda"`. After the PR opens, your turn is complete — adversarial-review and merge-agent pipelines take over.
