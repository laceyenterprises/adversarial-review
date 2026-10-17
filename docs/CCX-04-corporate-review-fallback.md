CCX-04 implements `credential-capacity-expansion@aaef99e5bd2e` §2a/§3.

The quota reader separates `openai/oauth` from `openai/oauth-corp`, including
model caps and AFH soft grounding. Corporate fallback requires confirmed
admission; missing, degraded, unknown or capped corporate evidence is skipped.
An exhausted account never lends its cap or availability to the other account.

The hammer follows the role-declared order. The loader accepts
`[hammer-corp, hammer-claude]`; its default remains `[hammer-claude]`.
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
If that account cannot admit, normal local holds and bounded model fallback remain.
Legacy rows
without account attribution retain the primary-account interpretation.

`codex-corp` normalizes to the Codex family. Codex-family reviewers never review
Codex-family builders, including timeout and repeated-execution fallback paths.
Title prefixes remain unchanged: a corporate builder opens with `[codex]`.
All routing decisions re-resolve automatically when quota recovers.
