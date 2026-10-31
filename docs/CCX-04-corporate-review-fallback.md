CCX-04 implements `credential-capacity-expansion@aaef99e5bd2e` §2a/§3.

ITP-10 adds [common account snapshot readers](../README.md#common-account-snapshot-readers-itp-10)
for the shared Python owner's selection outcomes and fleet `identityPools`
diagnostics. These APIs are additive: the routing and explicit-pin behavior
described here remains active until the later consumer tickets. Snapshot
metadata cannot replace lease acquisition, signing or cross-model checks.

The quota reader separates `openai/oauth` from `openai/oauth-corp`, including
model caps and AFH soft grounding. Corporate fallback requires confirmed
admission; missing, degraded, unknown or capped corporate evidence is skipped.
An exhausted account never lends its cap or availability to the other account.

Account routing shares `reserveFloorWeeklyMeasurement` to read Anthropic's
`weeklyMeasurement` and OpenAI's `measurement`, accepting both provider
`confidence` readings and legacy `status` readings. Finite numeric strings are
normalized in either shape; null, absent, blank, boolean and invalid percentages
remain unknown rather than becoming zero. A measured weekly reading with a
finite percentage takes precedence, including zero; otherwise the reader tries
`measurement`. Routing still requires fresh measured evidence in the 0–100 range
and independent broker readiness; provider readings marked inferred cannot admit
an account.

The hammer follows the role-declared order. The loader accepts
`[hammer-corp, hammer-claude]`; its default remains `[hammer-claude]`.
HHRCLAUDECORP-01 also accepts the corporate Claude hammer
`hammer-claude-corp` as a fallback entry (not as the primary
`worker_class`), so a host can declare
`[hammer-corp, hammer-claude, hammer-claude-corp]`. HHR gates it on the
corporate Claude account (`anthropic` / `oauth-corp`), so personal Claude
exhaustion does not ground it.
CCX-05 owns changing the host value. If every declared candidate is capped,
closure defers without launching a capped worker or spending a retry attempt.

The remediator default order is
`[remediator-codex-corp, remediator-claude, codex]`. The corporate twin continues
the routed Codex writer, inheriting the primary's diversity decision. Changes
to another writer family retain REMFALLBACK-01's next-round-reviewer screening.
Both local and pool dispatch retain the remediator's entitlement and harness
commit/push identity. Neither lane falls back to the `codex-corp` builder class.

REVIEWCORPFIRST-01: the watcher selects corporate Codex first for direct reviews,
worker-class spills, and provider/execution/timeout fallbacks. Corporate admission
requires fresh measured quota, an uncapped governed reviewer model, and a broker
that is ready and can serve. Reserve flags alone never switch accounts. Personal
Codex is eligible only after corporate exhaustion or explicit broker unavailability,
and requires its own quota and broker evidence. Stale or unknown corporate evidence
holds instead of spending personal quota. Legacy AFH projections retain their
provider classification; final watcher admission still requires account evidence.
Every Codex spawn logs `codex_account=corporate|primary`. Disabling the AFH model
hop retains the watcher’s shared quota read and account admission.
`CODEX_BROKER_PROVIDER` reaches the reviewer child and every per-worker auth-sync
request. Corporate auth starts empty, requires a successful corporate broker
mint, and fails closed instead of copying or falling back to primary tokens.
The CLI and OAuth Responses recovery use the same isolated credential file.
Corporate auth-sync captures stderr and retries recognized network timeouts,
connection failures, TLS handshake failures, and transient HTTP responses for
at most three attempts with 100/200ms backoff (15s timeout per attempt).
Permanent auth/configuration failures and invalid token responses fail closed
immediately; exhausted transient retries also fail closed and clean up the
isolated credential directory. Primary auth-sync remains best-effort.

After winning the existing single-claim CAS, the watcher stamps
`reviewed_prs.codex_broker_provider` under the claimed session before dispatch.
The account is retained on failure: primary quota exhaustion may bypass the
local hold and execution fallback to try corporate Codex, but a corporate
quota failure records an account-local cooldown before capacity is released,
allowing independently admitted personal capacity while fleet evidence catches up.
Spawn preflight checks that cooldown before consulting fleet quota, preserving its
original reset time and leaving the cooldown file untouched on repeated refusals.
New exhaustion reports preserve any later active reset instead of shortening it
with a shorter provider reset or the fallback hold.
Before dispatch, both fallback selection stages share a refreshed account
selection so an in-tick cooldown cannot reuse
the original corporate admission snapshot.
If that account cannot admit, normal local holds and bounded model fallback remain.
Legacy rows
without account attribution retain the primary-account interpretation.

`codex-corp` normalizes to the Codex family. Codex-family reviewers never review
Codex-family builders, including timeout and repeated-execution fallback paths.
Title prefixes remain unchanged: a corporate builder opens with `[codex]`.
All routing decisions re-resolve automatically when quota recovers.
