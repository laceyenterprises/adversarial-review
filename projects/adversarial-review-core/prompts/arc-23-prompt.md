# ARC-23 — app-sdk hybrid mode + real SSE on() (GAP-4)

> Plan ticket `ARC-23` from `projects/adversarial-review-core/plan.json`
> Spec: `adversarial-review-core@2c2af26f2eda`

## Source-of-truth references

- **Pack spec:** `projects/adversarial-review-core/SPEC.md` — §3 (ARC-23), §4 acceptance, §9 boundaries.
- **Plan:** `projects/adversarial-review-core/plan.json` — dependencies: none; downstream consumers depend on this ticket's contract, keep it stable.
- **Design specs (in the adversarial-review repo):** `docs/SPEC-adversarial-review-v2-app-architecture.md` and `docs/SPEC-merge-authority-v2.md`.
- **Read first:**
  - `platform/app-sdk/node/src/index.js` + `python/src/agent_os_app_sdk/__init__.py` — both clients get hybrid mode
  - `platform/app-contract-endpoint/SPEC.md` §topics/sse — on() backing
- **Why this exists:** The SDK is the app paradigm's front door: hybrid mode generalizes adversarial-review's lifeline pattern to every future app (Finch next).

## Scope (mirrored from plan.json)

Add mode: 'hybrid' to both app-sdk clients (platform/app-sdk node + python): probe/failover/resume semantics matching the ARC-07 router contract (thresholds injectable), a working on(topic, cb) implementation in agent-os mode backed by the SSE endpoint, and packaging so external repos can consume the Node SDK (published tarball or git-subtree recipe — implementer ADR; adversarial-review is the first consumer in ARC-24).

## Tests (mandatory)

- SDK contract tests in both languages.
- hybrid-mode state machine unit tests.
- SSE on() integration test against the stub endpoint.

## Completion contract

- **Shape:** PR against `agent-os@main`.
- **Title prefix:** `[claude-code] ARC-23:` — adversarial review routes on the bracketed worker-class prefix.
- **Risk class:** high.
- **Target repo:** `agent-os` (single-repo ticket — no adversarial-review/** reads or edits).
- **Worker class:** claude-code (you).

## Don't

- Contract version stays 1.0 — hybrid is client-side behavior, not a wire change.
- Thresholds injectable; defaults mirror the ARC-07 router contract (k=3 fail, m=6 healthy over ≥5m).

## How to land this PR

1. Provisioned worktree.
2. Read `projects/adversarial-review-core/SPEC.md` in full, then the design specs' sections named above.
3. Build the smallest reviewable diff that satisfies the scope.
4. Collect concise acceptance evidence (tests run + outcome summary).
5. Open the PR via `hq pr open` with a reviewer-pitch body (summary, what changed, why it matters, post-merge activities, acceptance evidence).

<!-- hq:closeout:pr -->

## Final step

Open the PR from inside the worker tree via `hq pr open --title "ARC-23: app-sdk hybrid mode + real SSE on() (GAP-4)" --summary "<1-3 sentence headline>" --what-changed "<files/surfaces touched, new flags, behavior deltas>" --why "<problem solved and fleet value>" --post-merge "<config flip, follow-up, or None>" --acceptance-evidence "<tests run + observed result>" --spec-ref "adversarial-review-core@2c2af26f2eda"`. After the PR opens, your turn is complete — adversarial-review and merge-agent pipelines take over.
