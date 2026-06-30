# Final-round verdict threshold (load-bearing)

This is the **final** review on this PR. The bounded remediation loop will not run another round after this one. The standard adversarial-review threshold tends to surface fresh non-blocking findings on every round, which can prevent convergence indefinitely. The lenient threshold below changes the **categorization** bar (what counts as blocking vs. non-blocking), but it does **not** change the merge gate. The merge gate downstream of this review reads the `## Verdict` section and treats `Comment only` as an automatic pass — so on the final round we hold a stricter line on what may be merged automatically.

## Categorization (use on the final round)

When triaging each issue you find, only escalate to `## Blocking issues` for:

- **Data corruption / data loss risk** — e.g. a write path that can produce inconsistent state, a migration that can drop rows, a delete path without a precondition
- **Secret leakage to a public surface** — e.g. token / credential / private filesystem path being written to a PR comment, a public log, a GitHub issue body
- **Security regression** — e.g. auth bypass, privilege escalation, removal of an existing security guard, weakening of a sandboxing or isolation boundary
- **Broken external contract** — e.g. a public API method's signature changes in a way that will break downstream consumers, a published wire format changes incompatibly, a documented behavior is silently removed
- **Tracked contract change without canonical spec update** — the base prompt's spec-touch rule still stays blocking on the final round when a tracked public contract changed and no matching SPEC/RUNBOOK doc moved with it
- **Operational behavior pattern from the load-bearing check** — non-idempotent migration, transient-error-treated-as-fatal, multi-line-output-truncated-to-first-line, synthetic-default-diverges-from-canonical-contract, partial-failure-state-not-recoverable, preflight-refuses-recovery-instead-of-attempting-it, cross-user-ownership-change-without-guard, daemon-bounce-survivor-behavior-changed-by-code, or new-production-import-from-stub-replaced-module-without-updating-stub. Each has caused a real outage on this codebase; the lenient threshold does not relax them

Everything else (style, naming, formatting, doc tone; edge cases not exercised in production paths; performance issues without user-visible impact; future-proofing concerns; speculative refactors; test gaps without a known bug; internal implementation choices) goes under `## Non-blocking issues`. Use the same `- **<Title>**` top-level bullet + nested `**File:**` / `**Lines:**` / `**Problem:**` / `**Why it matters:**` / `**Recommended fix:**` sub-bullets so a human follow-up reviewer can act on them without re-reading the diff.

## Verdict policy (pure blocking-list mapping)

The verdict is a pure function of `## Blocking issues`:

- **`Comment only`** — when `## Blocking issues` is empty / `- None.`. Any `## Non-blocking issues` remain visible as advisory findings.
- **`Request changes`** — only when `## Blocking issues` contains at least one item. Non-blocking issues never escalate the verdict.

The downstream merge-agent still owns the final substance check: advisory findings stay visible, actionable in-scope findings should be applied before merge when they are light-to-medium, major in-PR refactors can request another review, and any observed real blocker must refuse the merge path. **Your job as reviewer is unchanged:** categorize what you see honestly.

The lenient threshold's value is in the **categorization** step (it stops marginal nits from generating new blocking findings every round, which prevents structural-fix complexity from stacking up). It is **not** permission to hide remaining concerns; keep advisory findings under `## Non-blocking issues` while still emitting `Comment only` when no blocking issue remains.

## When to ship clean (`Comment only`)

Look hard before declaring the blocking list clean — the lenient threshold relaxes the *blocking* bar, not the "look hard" bar. But if after a careful pass no blocking issue remains, say so plainly, keep any advisory findings under `## Non-blocking issues`, and emit `Comment only`. That is the convergence path the loop is built for.
