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

The watcher selects the corporate broker provider before its existing model
fallbacks when primary Codex is capped and corporate Codex is admitting.
`CODEX_BROKER_PROVIDER` reaches the reviewer child and every per-worker auth-sync
request. Corporate auth starts empty, requires a successful corporate broker
mint, and fails closed instead of copying or falling back to primary tokens.
The CLI and OAuth Responses recovery use the same isolated credential file.

`codex-corp` normalizes to the Codex family. Codex-family reviewers never review
Codex-family builders, including timeout and repeated-execution fallback paths.
Title prefixes remain unchanged: a corporate builder opens with `[codex]`.
All routing decisions re-resolve automatically when quota recovers.
