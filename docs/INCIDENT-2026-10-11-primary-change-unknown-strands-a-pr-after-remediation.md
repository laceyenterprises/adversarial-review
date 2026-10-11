# INCIDENT 2026-10-11 — primary-change unknown strands a PR after remediation

**Detected:** SRE tick, 2026-10-11
**Affected:** agent-os PR 8044 and PR 7991
**Fix:** PRIMARYCHG-01 (deployment pending)

## Impact

The hammer stopped before remediation on PR 8044 at head
`5f8cc8f19a67960d73e86f320cd8e9136e5bdfb2` because primary-change evidence was
unknown. Five reviewed heads and earlier hammer launches that pushed nothing
preceded that stop. Remediation workers pushed between launches. The refusal
left the PR without an owner or automatic redispatch. PR 7991 exhibited the
same failure after a non-hammer base merge.

Operator decisions: 2026-10-10, "Hammers judgement is final"; 2026-10-11,
"Several PRs stuck". Missing evidence must not be mistaken for a final judgment.

## Reproduction and root cause

The read-only helper in the worker checkout initially returned false because
it has no production launch records. With `HAM_ROOT_DIR` set to the deployed
adversarial-review root, the same command returned `hasHammerCommits: null`.
The earliest recorded launch was `0f3fd2ffee55ef37a72bad3dba744db5969d0dc0`.
GitHub's comparison of that launch to the incident head returned `diverged`.
No tagged hammer commit existed. In `fetchPrimaryChangeHistory`, the ancestry
fallback's `if (!first) return unknown` was the precise failing branch.

The launch record anchored a run that never committed. Ordinary remediation
rebases then invalidated that anchor. Unknown audits were also read as final
hammer stops, requiring a head/base/check input change before redispatch.

## Correction

Select the actual parent of the first hammer commit still in current history,
using existing hammer identity and terminal trailer evidence as well as legacy
worker-class tags. A complete history without hammer commits is not applicable,
regardless of launch records. Remediation commits before the first hammer are
part of the protected change. Missing or unsupported evidence carries a reason.

Unknown evidence defers both merge paths and is recomputed on subsequent ticks.
The hammer records a deferred audit; old unknown no-merge audits do not hold
redispatch. Proven reversals remain blocked, with no override of preservation,
CI, live-head, terminal-state or lease gates. No CI job or guard was added.

## Regression coverage

Offline primary-change fixtures cover no-op launches followed by remediation,
rebases, repeated hammer launches with intervening remediation, unreadable
history diagnostics, identity-based untagged repairs, and retained reversal
protection. Closer, daemon and hammer stop tests cover evidence deferral.

## Recovery

Deploy this change to the watcher and hammer checkout. Subsequent pipeline
ticks recompute evidence on the same head and ordinary eligibility decides
redispatch. No audit deletion, override label or manual merge is required.
