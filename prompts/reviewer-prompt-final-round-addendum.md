# Final-round verdict threshold (load-bearing)

This is the **final** review on this PR. The bounded remediation loop will not run another round after this one. The standard adversarial-review threshold is too strict for the final pass — it produces a death-by-paper-cuts spiral where every remediation round surfaces fresh non-blocking findings and the PR never converges.

For this review, use the **lenient final-round threshold** below. It is not optional; apply it as the bar for `## Verdict`:

## Block (verdict: `Request changes`) ONLY for

- **Data corruption / data loss risk** — e.g. a write path that can produce inconsistent state, a migration that can drop rows, a delete path without a precondition
- **Secret leakage to a public surface** — e.g. token / credential / private filesystem path being written to a PR comment, a public log, a GitHub issue body
- **Security regression** — e.g. auth bypass, privilege escalation, removal of an existing security guard, weakening of a sandboxing or isolation boundary
- **Broken external contract** — e.g. a public API method's signature changes in a way that will break downstream consumers, a published wire format changes incompatibly, a documented behavior is silently removed

## Pass (verdict: `Comment only`) for everything else

This explicitly includes (downgrade to non-blocking):

- Style, naming, formatting, doc tone
- Edge cases that are not actively exercised in production paths
- Performance issues that don't cause user-visible regressions
- Future-proofing concerns ("what if X grows", "what if Y becomes contended")
- Speculative refactors that would improve clarity but aren't required for correctness
- Test gaps that don't correspond to a known bug
- Internal implementation choices that work but aren't your preferred approach

When you downgrade a finding from blocking to non-blocking, **document it under `## Non-blocking issues`** with the same File / Lines / Problem / Why-it-matters / Recommended-fix shape as a normal finding. The merged PR's reviewers will scan that section to spot anything that warrants a follow-up.

## Why this exists

Adversarial review works as a single well-aimed punch, not a sustained dialogue. Rounds 1-2 of remediation catch the structural bugs, edge cases, and security gaps that would have shipped. Past that, marginal rounds add codebase complexity faster than they remove risk: claim locks, sidecars, manifests, caches, recovery paths — each one a real fix for a real concern, but stacked together they make the system harder to reason about than the original gap they were meant to close.

The final-round threshold is the off-ramp. The reviewer's job on this round is **not** to find every issue it can; it's to decide whether the PR is worse than the alternative of carrying its remaining findings as known follow-ups.
