# Gemini remediation crossed the builder admission boundary

LAC-2146 / GEMREMEDIATORCLASS-01; parent LAC-2132.
SEV3-class prospective remediation starvation regression, found before the
paired builder-isolation feature merged. This is an exported-source
reproduction and dependency repair; no production outage is inferred.

## Cause and consequence

The logical route `gemini` survived normalization, but the concrete spelling
`remediator-gemini` was discarded. Native
`buildLegacyHqRemediationDispatchArgs` and SDK dispatch then submitted the
logical name as HQ's worker class with task kind `coding`. A second filter in
pooled Codex/Claude fallback skipped non-OAuth Gemini altogether.

[Agent OS #10087](https://github.com/laceyenterprises/agent-os/pull/10087),
merged at `3237516e7b01ab188c3a5e7118e9926b8ca19115`, registered
`remediator-gemini` with its own agy display-name default/allowlist,
`foundry-remediator-worker` entitlement, restricted network profile and
git-safe/GitHub write tool policy. Its adapter resolves model and entitlement
against the dispatched class.

[Agent OS #10117](https://github.com/laceyenterprises/agent-os/pull/10117),
inspected at `db0c448858e06157ec3486f38c3338183e7687ec`, gates concrete
`gemini` in `adapter_subprocess_env_for_payload`, generic class fallback and
the native shell adapter. Its empty-by-default dedicated builder pool has no
implicit HQ-owner/reviewer seat. Thus legacy HQ remediation would encounter
builder admission, even though reviewer/remediator isolation was promised.
This head predates #10087 and lacks its concrete remediation registration.
Changing only normalization would still send a builder; changing only argv
would leave concrete fallback and receipt consumers inconsistent.

## Repair and fences

One leaf defines logical normalization and the remediation-only HQ translation.
Native and SDK producers emit `remediator-gemini`; durable workers distinguish
logical `model` from concrete `workerClass`. Local agy spawning, governed
remediator model selection, quota evidence, cross-model exclusion, Git identity,
broker provider and provenance trailer recognize the route consistently.
After positive pooled account refusal, Gemini keeps its configured fallback
position and passes the existing non-pooled availability/model policy.

No builder/reviewer account pool, schema key, provider policy, entitlement,
credential, role pin, runtime activation, launch identity, broker, remote
publication proof or merge predicate is relaxed. Unknown pooled evidence
cannot manufacture account exhaustion. Missing/withdrawn model policy remains
a deferral/skip. Terminal PR guards and round charging remain unchanged.

## Evidence and limits

`test/gemremediatorclass-01.test.mjs` drives exported selection, native dispatch,
quota, reconciliation and identity assertions. It feeds actual rendered argv
into verbatim exported Python consumer snapshots under
`test/fixtures/gemremediatorclass-01/`, whose source commits, paths and hashes
are recorded in `sources.json`. The fixture composes #10117's adapter-env and
builder admission functions with #10087's registry and launch-model resolver.
Configuration/registry plumbing is synthetic; native builder admission is
executed, never stubbed true. Empty builder identities refuse builder launch;
the concrete remediation request retains launch/run IDs, restricted network,
class model policy and entitlement. Builder-only model pins are refused.
No credential readiness or provider call occurs. Python's standard library is
the only fixture dependency; no Agent OS checkout or service is required.

SDK retries exercise the exported dispatch function against the existing local
App Contract fixture, preserving stable request/ticket and launch receipts.
The local agy argv test uses the concrete local entry and enables real Git and
broker identity assertions. Positive and negative identity tests reject wrong
Git authors and push providers, while retaining workflow-push escalation.
Daemon-bounce recovery exercises both logical and concrete historical model
receipts, preserving job/round, launch request and reply path through re-review.
Existing tests cover held-round accounting and lost-workspace fences.

This bounded source composition proves the class boundary, not a complete
qualification of the current unrebased #10117 adapter. The existing CI workflow
runs the full offline suite on Node 22 and 26.10.0; no jobs or triggers are added.

## Paired release prerequisites — retain #10117's functional hold

1. Land this ordinary tagged companion only after normal initial cross-model
   review and required CI. No self/admin merge or review waiver.
2. Catch #10117 up to merged #10087 plus this reviewed AR revision, resolving
   its registry, model/runtime, entitlement and native adapter overlap while
   preserving GEMBUILDLANE's dedicated builder identity and empty pool.
3. Run paired offline integration at the resulting exact heads: logical and
   concrete configured fallback routes in HQ and local modes; model default,
   valid/invalid pins, remediator entitlement/Git identity; actual native argv,
   SDK wire payload, dispatch/artifact recovery and round continuity. With an
   empty builder pool, builder `gemini` must refuse and HQ remediation
   `remediator-gemini` must progress. Reviewer seats must remain ineligible for
   builders. Auth/broker, native identity and remote-proof negatives must pass.
4. Record the resulting exact commits, companion review/CI and paired test
   evidence on LAC-2146. Keep the native no-merge-hold on #10117 until those
   prerequisites are actually satisfied. Then use normal reviewed merge and
   native rollout. Observe natural remediation receipts and next-round review
   continuity after normal activation; do not launch a provider probe.

This ticket changes only its provisioned AR tree. It neither edits nor releases
#10117 and performs no runtime restart or live queue/lease/job mutation.
