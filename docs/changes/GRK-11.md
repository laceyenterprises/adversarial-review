# GRK-11 — Opt-in Grok reviewer on other families

Registers the Grok reviewer route and invokes `grok-reviewer` through the
existing managed HQ reviewer runtime. The Agent OS Grok adapter retains all
broker grants, account selection, isolated homes, CLI pinning, stream and quota
validation. This repository adds no credential reader. Review output uses the
existing artifact sanitizer and reply validation; usage/cost comes from the
common worker-run ledger reader, preserving unknown cost.

Both Grok switches must be enabled. Unknown and Grok-family original builders
are refused across aliases, closer provenance and AFH selection, including
operator pins and missing provider health. The managed class must be enabled
in the effective DB registry with its Grok harness and no opaque nested
fallback. Review retries remain with the provenance-aware review routing owner.
With no explicit reviewer pin, enabling the reviewer flag selects Grok for
eligible other-family builders in the `code-pr` domain; a Grok-built subject
keeps its non-Grok route. Retry exclusions (including Grok family aliases)
prevent opt-in Grok selection and retain the usual per-builder route.
Other domains retain their configured reviewer routing.
AFH consumes the existing `xai` provider evidence and can return to the usual
per-builder primary without changing role configuration.
GitHub posting uses only `GH_GROK_REVIEWER_TOKEN` and the independent
`grok-reviewer` signing subject; missing posting authority refuses execution.
The existing reviewed signing/recording path is preserved.
AMA, review capture, reattach, closeout and backfill recognize both
`lacey-grok-reviewer[bot]` and `grok-reviewer-lacey` GitHub identities.
Nested HQ records carry `subjectContext.nestedReviewerRuntime` so watcher
recovery leaves them to the outer reviewer; a termination cancels the nested
dispatch without exiting the host process, leaving shutdown and fence cleanup
to the outer reviewer. Managed preflight recognizes qualified Grok model names
without probing sibling credentials. Queued fence cleanup resolves both
`grok-reviewer` and `grok-reviewer-*` identities to `GH_GROK_REVIEWER_TOKEN`.
Its timeout remains below the outer reviewer budget. Execution
provenance records the model from an available dispatch receipt and otherwise
records an unknown model rather than the registry default. Pre-execution
refusals use `reviewer-configuration-error`; worker-class fallback accepts
`grok-reviewer` explicitly.

## Interface changes

Grok routing is limited to `code-pr`; nested HQ run records carry the
`nestedReviewerRuntime` ownership marker.

## Verification

Targeted Grok routing, reviewer, and runtime recovery tests; data-model catalog
validation and lint.

Remediation verification:

- Serial targeted run of `test/grok-reviewer.test.mjs`,
  `test/grok-builder-routing.test.mjs`, `test/reviewer-fence.test.mjs` and
  `test/gemini-reviewer-routing.test.mjs`: passed.
- `test/reviewer-runtime-adapter.test.mjs`: all 84 tests passed.
- `npm run lint`: passed with zero errors (existing warnings retained).
- `npm run typecheck:contracts`: passed.
- `bash demo/research-finding-walkthrough.sh`: passed with byte-stable deliveries.
- `node scripts/validate-data-model-catalog.mjs`: validated 91 entries.
- `git diff --check`: passed.

Merge prerequisites: GRK-05, GRK-09 and GRK-10, plus Agent OS
[PR 10478](https://github.com/laceyenterprises/agent-os/pull/10478) for the
worker class and additive registry observation fields. Merge PR 10478 first.
No superproject gitlink PR is needed.

GRK-16 owns effective registry import/enablement, provisioning independent
posting/signing authority, checking the existing HQ runtime environment
(`HQ_ROOT`, `HQ_PARENT_SESSION`, `HQ_PROJECT`, HQ command), enabling only the
reviewer lane after master-switch qualification, and the registered watcher
reload if required. It must collect a real other-family toy review,
MODEL-TURN, common token/cost evidence and signed reviewed receipt. No live
activation follows from merging this PR.
