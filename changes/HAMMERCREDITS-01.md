# HAMMERCREDITS-01 — exhausted Codex account grounding

The shared fleet quota classifier treats a current Codex plan meter at or above
100% as exhausted even when the active probe reports success using credits.
Personal/corporate closer selection, reviewer admission, Codex account routing,
remediation fallback, AFH reviewer fallback, Argus and burst all consume this
classification and retain their existing fallback/hold policies.

Stale meter rows, elapsed resets and stale cached provider evidence cannot
synthesize exhaustion. Projected rate limits require measured, non-inferred
evidence. The latest future exhausting-meter reset is retained for account caps
and corporate reviewer cooldowns; normalized rows and diagnostics identify
`codex-plan-meter` as the state source.

Synthetic offline fixtures cover closer fallback/hold, reviewer refusal and
corporate cooldowns, remediation fallback, freshness/reset boundaries, unknown
reset times and projection confidence. Existing soft-grounding and account
routing regressions remain applicable. No configuration, persistent store shape,
lifecycle state or smoke promise changes.
