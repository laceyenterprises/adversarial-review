# GRK-12 — Opt-in Grok remediation

## Change notes

Plan `grok-build-harness-v1`. `remediator-grok` is an account-bound HQ lane,
requiring `grok.enabled`, `grok.remediator.enabled` and an enabled imported
worker class. Unknown original builder provenance and Grok-family builders
refuse Grok remediation before account selection and after routing handoffs.
Subscription and API-key selection keep the same normalized family. Grok
builders retain the existing non-Grok default route. No direct CLI fallback
is introduced. GRK-16 owns activation and live MODEL-TURN evidence after the
Agent OS companion deploys; no live actions are part of this change.

Selecting `hammer-grok` as the closer refuses with
`grok-closer-pending-merge-authority-v2`, including when its flags are on.
The Grok closer is deferred to GRK-17: the Merge Authority v2 executor after
the MLR cutover, using the v2 queue-closer prompt. The closer cell and receipt
remain **pending v2**. Both flags default off. Frozen v1 closer dispatch and
all v2 finalization code remain unchanged; exact-head checks, merge leases,
attestations and the prohibition on admin-merge bypass remain in force.
