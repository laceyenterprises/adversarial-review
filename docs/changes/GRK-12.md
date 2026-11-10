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
remain **pending v2**. Both flags default off. Static/seed role registration and vault policies are
deferred to GRK-16/17; the merge-authority enum is deferred to GRK-17.
Frozen v1 closer dispatch and
all v2 finalization code remain unchanged; exact-head checks, merge leases,
attestations and the prohibition on admin-merge bypass remain in force.

Final remediation preserves the non-Grok builder route under a Grok pin,
recognizes Grok job-local quota holds, refuses domain closer selectors, and
names the actual account-bound lane in dispatch errors.

Reconciliation now preserves the Grok-builder pin exemption for public outcome
attribution and GitHub-auth recovery. Post-assignment subject refusals have a
bounded retry deadline anchored to the claim. Grok delivery uses the existing
Codex commenter identity; named Codex and Claude remediator routes map to their
existing commenters as well. This changes no worker execution entitlement.

## Interface changes

The parity fixture copies must be updated as a pair:
`test/fixtures/grok-config-parity.v1.json` here and
`platform/agent-os-config/src/agent_os_config/tests/fixtures/grok-config-parity.v1.json`
in Agent OS. The Agent OS companion supplies the same pending-v2 refusal in
Python `_validate_grok_role_pins`, also used by the shell loader, for the legacy closer selector; the strict merge-authority enum continues to
reject unregistered Grok values. Deploy the Agent OS companion before activation. Deploy the paired
changes before GRK-16 activation; source validation does not certify live
deployment readiness. Keep both default-off flags and the Node refusal in place.

No persistent store shape, lifecycle status, merge permission or smoke promise
changes. Existing pre-spawn routing, quota fallback and HQ admission apply.

## Verification

Passed offline:

- `node --test --test-name-pattern "reconcile routes" test/follow-up-remediation.test.mjs` (385 tests passed; the file runner executes all tests in this file).
- `node --test test/grok-remediator.test.mjs test/worker-token-pool.test.mjs test/pr-comments.test.mjs` (73 tests, including reconcile comment/auth recovery, bounded handoff hold and named-route delivery regressions).

- `node --test test/grok-remediator.test.mjs test/grok-builder-routing.test.mjs test/domain-policy.test.mjs test/remediation-worker-class-fallback.test.mjs test/config-loader-grok.test.mjs test/remediatorlane-01-mode-runnable-lane.test.mjs test/follow-up-remediation-quota-hold.test.mjs`
- `npm run lint` (zero errors; existing warnings).
- `npm run typecheck:contracts`.
- `bash demo/research-finding-walkthrough.sh` (byte-stable transcript).
- `git diff --check`.

The follow-up-remediation state projection is unchanged. The full suite runs
in PR-head CI; no live rollout or parity acceptance is claimed here.

The touched routing block retains the existing monolith line ceiling by
trimming local spacing; no limit or gate changes.
