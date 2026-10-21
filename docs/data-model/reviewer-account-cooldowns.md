# Reviewer account cooldowns

Owner: `src/reviewer-token-pool.mjs`, written by `src/reviewer-spawn-settle.mjs`
on typed `quota-exhausted` results for a declared Claude/Codex pool.

Store: `<adversarial review state dir>/reviewer-account-cooldowns/<sha256(account ID)>.json`.
The existing state-root resolver honors `ADVERSARIAL_REVIEW_STATE_DIR`.
Each atomic file contains only `{ "resetAt": "<ISO timestamp>" }`.

The parsed provider reset bounds the hold, defaulting to 15 minutes and clamping
at seven days. Repeated observations do not shorten an active hold. Expired or
absent files return no local cooldown; unreadable files supply unknown quota
evidence and hold when that account is considered. Canonical quota/readiness
evidence is still required. No other account's cooldown is inferred from the reviewer family.

Admission supplies the cooled account IDs to the shared owner's snapshot reducer
as fresh typed exhaustion. Other evidence retains its original generation and
freshness; a local quota refusal cannot excuse unknown readiness. An existing
attempt keeps its account. New attempts re-evaluate the ordered role pool.
The existing corporate-only cooldown files remain legacy compatibility inputs.
