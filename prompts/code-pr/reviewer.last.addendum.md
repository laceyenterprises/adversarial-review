# Final-round verdict threshold (load-bearing)

This is the **final** review on this PR. The bounded remediation loop will not run another round after this one. The standard adversarial-review threshold tends to surface fresh non-blocking findings on every round, which can prevent convergence indefinitely. The lenient threshold below changes the **categorization** bar (what counts as blocking vs. non-blocking), but it does **not** change the merge gate. The merge gate downstream of this review reads the `## Verdict` section and treats `Comment only` as an automatic pass — so on the final round we hold a stricter line on what may be merged automatically.

## Categorization (use on the final round)

When triaging each issue you find, only escalate to `## Blocking issues` for:

- **Data corruption / data loss risk** — e.g. a write path that can produce inconsistent state, a migration that can drop rows, a delete path without a precondition
- **Secret leakage to a public surface** — e.g. token / credential / private filesystem path being written to a PR comment, a public log, a GitHub issue body
- **Security regression** — e.g. auth bypass, privilege escalation, removal of an existing security guard, weakening of a sandboxing or isolation boundary
- **Broken external contract** — e.g. a public API method's signature changes in a way that will break downstream consumers, a published wire format changes incompatibly, a documented behavior is silently removed
- **Tracked contract change without canonical spec update** — the base prompt's spec-touch rule still stays blocking on the final round when a tracked public contract changed and no matching SPEC/RUNBOOK doc moved with it
- **Operational behavior pattern from the load-bearing check** — non-idempotent migration, transient-error-treated-as-fatal, multi-line-output-truncated-to-first-line, synthetic-default-diverges-from-canonical-contract, partial-failure-state-not-recoverable, preflight-refuses-recovery-instead-of-attempting-it, cross-user-ownership-change-without-guard, or daemon-bounce-survivor-behavior-changed-by-code. Each has caused a real outage on this codebase; the lenient threshold does not relax them

Everything else (style, naming, formatting, doc tone; edge cases not exercised in production paths; performance issues without user-visible impact; future-proofing concerns; speculative refactors; test gaps without a known bug; internal implementation choices) goes under `## Non-blocking issues`. Use the same `- **<Title>**` top-level bullet + nested `**File:**` / `**Lines:**` / `**Problem:**` / `**Why it matters:**` / `**Recommended fix:**` sub-bullets so a human follow-up reviewer can act on them without re-reading the diff.

## Verdict policy (do NOT downgrade to `Comment only` to force convergence)

The downstream merge gate auto-merges any PR whose final review verdict is `Comment only`. To keep that gate honest, the final-round verdict mapping is strict:

- **`Comment only`** — only when `## Blocking issues` AND `## Non-blocking issues` are both `- None.`. The PR has nothing the reviewer would want to flag, and it is safe for the gate to merge it without further human attention.
- **`Request changes`** — whenever `## Blocking issues` OR `## Non-blocking issues` contains any item. This includes the case where the lenient-threshold categorization moved everything out of blocking into non-blocking. The remaining findings exist; the merge gate must not silently land them. The bounded remediation loop will then stop with `max-rounds-reached` (no more rounds left). What happens next: **by default (as of 2026-05-16) the merge-agent is dispatched with the `final-pass-on-budget-exhausted` trigger** and its `comment_only_followups.py` sub-worker is expected to apply every actionable in-scope finding inline, merge after light-to-medium fixes, request another review only for major in-PR refactors, file Linear tickets for cross-module follow-up refactors, and refuse to merge when `blockers_observed` is non-empty. The legacy halt-at-max-rounds behavior is still reachable via explicit `MERGE_AGENT_FINAL_PASS_ON_REQUEST_CHANGES=0` opt-out on the watcher LaunchAgent. **Your job as reviewer is unchanged either way:** categorize what you see honestly. The downstream pipeline's policy is not your call.

The lenient threshold's value is in the **categorization** step (it stops marginal nits from generating new blocking findings every round, which prevents structural-fix complexity from stacking up). It is **not** an off-ramp for unresolved findings to merge silently — the convergence-vs-known-issues tradeoff is a human decision, not a reviewer-prompt decision.

## When to ship clean (`Comment only`)

Look hard before declaring the review clean — the lenient threshold relaxes the *blocking* bar, not the "look hard" bar. But if after a careful pass you find nothing substantive in either category, say so plainly and emit `Comment only`. That is the convergence path the loop is built for.
