# GRK-12 — Opt-in Grok remediation

## Summary

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
remain **pending v2**. Both flags default off. Static/seed registration is deferred to GRK-16 for the
remediator and GRK-17 for the closer. Grok vault-policy entries are deferred to
the GRK-16 operator activation; the merge-authority enum is deferred to GRK-17.
Frozen v1 closer dispatch and
all v2 finalization code remain unchanged; exact-head checks, merge leases,
attestations and the prohibition on admin-merge bypass remain in force.

Final remediation preserves the non-Grok builder route under a Grok pin,
recognizes Grok job-local quota holds, refuses domain closer selectors, and
names the actual account-bound lane in dispatch errors.

Reconciliation now preserves the Grok-builder pin exemption for public outcome
attribution and GitHub-auth recovery. Subject refusals before spawn, including
post-assignment refusals, stop with `subject-refused` and a named operator
correction/retrigger action instead of a re-arming quota hold. Grok delivery uses the existing
Codex commenter identity; named Codex and Claude remediator routes map to their
existing commenters as well. This changes no worker execution entitlement.

## Interface changes

The parity fixture copies must be updated as a pair:
`test/fixtures/grok-config-parity.v1.json` here and
`platform/agent-os-config/src/agent_os_config/tests/fixtures/grok-config-parity.v1.json`
in Agent OS. The Agent OS companion supplies the same pending-v2 refusal in
Python `_validate_grok_role_pins`, also used by the shell loader, for the legacy
closer selector; the strict merge-authority enum continues to reject
unregistered Grok values. Deploy the paired changes before GRK-16 activation;
source validation does not certify live
deployment readiness. Keep both default-off flags and the Node refusal in place.

The existing stop record accepts `subject-refused`; explicit retrigger remains
subject to the existing cap. No new store field, lifecycle status, merge
permission or smoke promise is introduced. Existing quota fallback and HQ
admission apply. Domain closer selections are checked during domain loading,
before poll phases; the policy resolver retains its defensive validation.
Pooled fallback provider labels use a frozen map and `unknown` for unregistered
families, including unpooled fallbacks. Returned legacy remediator aliases
resolve through that same family map for provider attribution. The claimed
subject-stop helper accepts optional `topPath` and `loaderImpl`, forwards both
to subject evaluation, and returns without touching job state when no routing
class is supplied. Grok commit identity uses the same
`@laceyenterprises.com` domain as the other remediation workers.

The Agent OS Python/shell loader and parity-fixture companion must merge
**before the submodule pointer bump**, not merely before GRK-16 activation.
Before daemon restart, the operator must confirm no effective host/local
config pins `roles.merge_agent_worker_class: hammer-grok`. These are
superproject deployment obligations; this patch does not edit Agent OS or
claim live config confirmation.

## Verification

Final fix-all checks passed offline:

- `node --test test/grok-remediator.test.mjs test/worker-token-pool.test.mjs test/domain-policy.test.mjs test/domain-registry.test.mjs test/config-loader-grok.test.mjs test/remediation-worker-class-fallback.test.mjs test/follow-up-remediation-quota-hold.test.mjs` (155 passed).
- `node --test test/worker-token-pool.test.mjs test/arc19-boundary-gate.test.mjs` (74 passed, including both added regressions and the unchanged line ceiling).
- `node --test --test-name-pattern 'AMA merge_authority public docs' test/config-loader.test.mjs` (passed; the predicate was already limited to the closure runbook).
- `node scripts/validate-data-model-catalog.mjs` (93 entries validated).
- `node --test test/smv.test.mjs` (11 passed, including disposable sandbox smoke).
- Six watcher claim-loop cases passed through `test/run-tests.mjs`, with
  `NODE_OPTIONS=--test-name-pattern=...` selecting claim CAS, head refresh,
  moved-head release, same-head deduplication and runtime config recovery.
  Broader attempts reached their 120/60-second bounds without assertion
  failures; the sandbox re-exec drops a CLI-only name filter.
- `npm run lint` (zero errors; existing warnings).
- `npm run typecheck:contracts`.
- `bash demo/research-finding-walkthrough.sh` (byte-stable transcript).
- `git diff --check`.

The affected state declarations and source projections describe the
subject-refused terminal stop and explicit retrigger. The full suite runs
in PR-head CI; no live rollout or parity acceptance is claimed here.

The touched routing block retains the existing monolith line ceiling by
trimming local spacing; no limit or gate changes.

Builder update for PR 1805: the branch already contains current `origin/main`
and all latest-review fixes: terminal `subject-refused` stops, companion-first
deployment ordering, domain-load validation, defined pooled provider labels,
and the shared remediation email domain. The Node 22 and Node 26 CI failures
both identified the existing retrigger documentation test: its bounded operator
retrigger sections omitted `subject-refused`. The canonical spec and runbook
now include that code, the required lane correction, claim-time revalidation,
and the unchanged round cap. The existing contract test reproduced the failure
before this correction; no runtime policy or CI gate changed.

Update validation: all 18 affected documentation and review-regression test
files passed (712 tests), each run separately as `node --test <file>` through
`cwp_dispatch.worker_validation --timeout-seconds 600`, under netguard.
This includes `test/follow-up-retrigger-label.test.mjs` (28 passed after the
reproduced failure), the full config-loader file, reconcile/comment delivery,
Grok routing, subject-stop, domain-loading, fallback and documentation tests.
`npm run lint` passed with zero errors (152 existing warnings);
`npm run typecheck:contracts`, the netguard-wrapped offline research-finding
demo and `git diff --check` passed. The host full suite was not run.

Latest advisory remediation adds regressions for remediator alias provider
attribution, absent routing classes, and enabled/disabled subject evaluation
through injected loaders and explicit config paths. The whitespace advisory
requires no runtime change: both Node loader entry points already reject
space/tab-padded `hammer-grok` values in all three closer selectors during
schema validation, before `validateGrokRolePins`. A targeted regression
exercises those twelve combinations. Strict identifier validation is preserved.
No store shape, lifecycle state or smoke promise changed; existing Agent OS
companion deployment obligations above remain in force.

Validation: the six targeted files `test/worker-token-pool.test.mjs`,
`test/config-loader-grok.test.mjs`, `test/grok-remediator.test.mjs`,
`test/follow-up-remediation-quota-hold.test.mjs`,
`test/arc19-boundary-gate.test.mjs` and `test/smv.test.mjs` passed (157 tests).
Lint passed with zero errors and 152 existing warnings; contract typecheck
and the offline research-finding demo passed. Full-suite validation remains
with PR-head CI.
