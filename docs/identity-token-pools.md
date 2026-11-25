# OAuth identity token pool declarations (ITP-01)

The strict configuration loader accepts inert ITP-01 OAuth declarations under
`oauth.token_accounts` and `oauth.identity_token_pools`, both empty by default.
Descriptors contain family, allowed model IDs, positive bounded concurrency
(1–64), and exactly one existing broker-provider or `family: gemini` (agy)
`holder_user` binding; Gemini holder concurrency stays 1. Duplicate bindings,
unknown account references, unknown fields and cross-family pools refuse.
Each role retains its declared
account order. Personal-first declarations for hammer/Codex remediators and
corporate-first declarations for other in-scope Codex/Claude roles are operator
conventions; this loader does not validate account order or change runtime routing.


GRK-03 extends these declarations with family `grok` and canonical roles `grok`,
`grok-reviewer`, `remediator-grok`, and `hammer-grok`. Grok accounts additionally
require `kind` (`oauth` or `api-key`) and `broker_instance`; `broker_provider`
remains a provider type (`grok` for OAuth, `grok-api` for keys). Legacy account
fields and fixed provider mappings remain unchanged.

`remediator-grok` uses account-bound HQ dispatch and requires an enabled worker
class plus `grok.enabled` and `grok.remediator.enabled`, both default off.
Original Grok builders retain non-Grok remediation after account and assignment
handoffs. GRK-16 owns remediator registration, activation and live receipts.
`hammer-grok` is a reserved routing name; closer selection refuses with `grok-closer-pending-merge-authority-v2`.
GRK-17 adds its v2 executor after the MLR cutover, using the v2 queue-closer prompt.

`oauth.broker_instances` is a third atomic map, empty by default. Each opaque
instance names exactly `provider` plus `custody_dir` (OAuth) or `op_ref` (key).
Custody directories must be canonical absolute paths; duplicate and nested
paths, compared case-insensitively, refuse. Secret references must have the
`op://vault/item/field` shape and be unique case-insensitively. Validation is
lexical and performs no credential or filesystem I/O; provisioning must also
prevent filesystem aliases such as symlinks from sharing custody. One account
may bind an instance; multiple distinct instances may use the same Grok provider
type. At most 64 instances are accepted. Descriptor errors omit binding values.
All three maps replace prior layers as a whole and validate together after the
cascade, including non-strict local overrides. Shell loading exposes them only
through the JSON reader, never flattened environment variables.

Raw config retains declared order. Typed readers stably put OAuth members before
API-key members for each Grok role, preserving order within each kind. The shared
selector applies account-specific readiness, requested-model evidence, quota,
reserve and active lease counts against concurrency; stale or unknown evidence
still holds. Exhausted subscriptions fall through to the key in the same role;
the next eligible attempt prefers a recovered subscription. Kind, instance and
custody binding participate in declaration generation, invalidating observations
when the auth path changes. Legacy generation encoding is unchanged.

Activation: both repository changes must merge before importing Grok declarations.
Configuration pickup uses the existing next config read/reload path; this slice
does not enable a Grok lane or instantiate a broker. GRK-04 consumes the instance
contract; GRK-16 imports configured accounts, checks effective pool order and
account-scoped metadata, and captures live MODEL-TURN receipts for both auth kinds.
No live credential, HOME/GROK_HOME or service change occurs in GRK-03.

The same strict `oauth` root also mirrors the existing `litellm_vk_*` `op_ref`
children declared by `schema_v1/core.py::_oauth_litellm_vk_schema_keys` and wired
by `schema_v1/oauth_github_ci.py` in the Python `agent_os_config` owner. These
nullable string keys preserve compatibility with existing shared YAML.

`src/identity-token-pools.v1.json` and
`test/fixtures/identity-token-pools.v1.json` are published copies of the
agent-os-config vocabulary and shared vectors. Keep them byte-identical to
that owner on publication. Standalone Node config loading remains offline and
needs no Python or superproject checkout. Both maps replace whole prior-layer
maps; an empty map clears declarations. Final effective config validates
references after all layers without changing role/vault or signing authority.
Public `validateSchema` validates declaration semantics within its single input
document; cascade loading defers them until the final effective configuration,
so references can span layers. Declaration errors report the winning source
for the failing map and both maps' source/path metadata in `declarationSources`,
without copying account or binding values into diagnostics.

Both `loadConfig` and `loadConfigRuntime` deliberately fail closed on invalid
declarations, including unknown roles or descriptor fields. Generic runtime
unknown-key tolerance does not apply inside these atomic maps. Deploy updated
Node vocabulary and validation before publishing Python-owner vocabulary changes
or enabling new declarations in shared/local configuration; otherwise Node
daemon config reads can fail until their loader is updated. The offline loader
asserts vocabulary version 1 and required field shapes at import time; shared
fixture tests pin the same version. The canonical cross-loader contract lives
in the agent-os superproject (`projects/cfg/LOADER-CONTRACT.md`); its ITP rollout
documentation must carry this deployment ordering alongside the Python schema PR.
No persistent store, lifecycle state or post-deploy smoke promise changes here.

### Common account snapshot readers (ITP-10)

`src/identity-token-snapshot.mjs` reads the version 1 declarations, evidence
snapshots and selection results owned by `agent_os_core`. It validates family,
identity/account model intersection, generation binding, ordered candidates,
bounded stamps/counts and exact metadata fields, returning detached frozen
values. Unknown or stale evidence remains representable; the reader consumes
the owner's `selected`, `hold` or `unavailable` outcome without running a
second selection policy. A selection result is a proposal for a new attempt,
not an execution lease, an attestation or merge authority. Consumers must still
acquire/revalidate through the existing lease/admission owner before dispatch.

`readIdentityTokenPools(oauth)` always returns `token_accounts`,
`identity_token_pools` and `broker_instances` mappings. Omitted or empty broker
instance declarations project as a detached, frozen `{}`, so consumers can
enumerate the mapping directly even with legacy-only configuration.

`readAccountSelection(result, { oauth, request })` consumes the Python
`SelectionResult.to_dict()` wire value alongside its original request and
effective declarations. Unavailable and pool-level capacity-saturated results
must contain only refusing candidates; `accounts-unavailable` must cover every
declared pool member. `readSelectionSnapshot(snapshot, oauth)` validates raw
evidence without upgrading missing components to readiness. Unsupported
versions, unknown fields and credential-bearing extensions refuse without
echoing their values. Credential storage and refresh remain with existing owners.

`resolveIdentityTokenPools(options)` uses the existing role config cascade.
An explicitly configured `reviewer.gemini.identities` list is normalized to
strings, as in the legacy reviewer resolver, and must agree with the
new Gemini pool's ordered holders; conflicting declarations and duplicate
provider/holder bindings refuse. Legacy-only config remains readable and does
not invent account attribution. `identityPoolsFromSnapshot(payload, oauth)`
reads the existing fleet quota `identityPools` projection, preserving null
occupancy and verifying account bindings and capacity totals. An absent
projection returns `null`; an explicitly malformed projection refuses.
Each role's capacity describes shared account slots and must not be summed
across roles as independent fleet capacity.

ITP-10 added reader APIs only. Existing reviewer corporate-first and
hammer/Codex-remediator personal-first routes, explicit pin provenance, old
review rows and signed identities retain their current behavior. ITP-12–14
wire the later routing/receipt consumers; live cutover remains an operator step.
The standalone Node readers and offline suite require neither Python nor an
Agent OS checkout, network access or credentials. No runtime reads policy from
the project spec directory.

The published selection vocabulary and vectors are byte-identical copies from
agent-os `dee6b8e622e31c64dd500a05abd7e54fab3008b8`; the companion owner also
produced all 155 complete outcomes in
`test/fixtures/identity-token-outcomes.v1.json`. Offline tests consume those
outcomes, including every unknown hold and account-model denial. When updating
the contract, verify the copies and replay the Python owner from its registered
read-only workspace explicitly:

The argument is the source root containing both `agent_os_config` and
`agent_os_core`; in the companion layout both packages live under
`platform/agent-os-config/src`.

```sh
node test/verify-identity-token-owner.mjs /path/to/registered/agent-os/platform/agent-os-config/src
node test/run-tests.mjs identity-token-snapshot.test.mjs
```

The owner verification is an opt-in bounded publication check, not a new CI
gate or runtime dependency. Keep Node readers deployed before enabling an
incompatible owner vocabulary. No store, lifecycle or smoke contract changes.

### Remediator and hammer account pools (ITP-14)

Declared `hammer`, `hammer-claude`, `remediator-codex` and `remediator-claude`
pools use `src/worker-token-pool.mjs` and the shared Python selection owner.
The operator's current static order is corporate then primary for both families.
`codex`/`claude-code` remediation routes become their privileged remediator role
when that role has a pool; a corporate receipt never selects a builder role or
requires a corporate class. The registry keeps GitHub entitlement, tools, models,
role budgets and merge capabilities attached to the canonical role.

The Node result is a proposal only. Managed `hq dispatch` revalidates admission
and acquires/binds the account under its existing global semaphore. It emits no
automatic harness or account pin. The proposal uses the role's coding/merge task
policy, while reviewers retain their stricter reviewer reserve policy. Hammer
unknown, stale or unreadable evidence for a valid declared pool holds before fallback.
ITPPOOLCONFLICT-01 checks each worker's membership in the effective raw pool map
before validating pool declarations or legacy policy. An undeclared role keeps
its class route even when another role's pool is invalid. A legacy/new policy
conflict produces `pool-config-conflict` with `conflictKey`, never an account
value or `evidence-unknown`. Each conflicting key warns once per process.
A declared hammer with a conflict dispatches on its class route and records
the diagnostic in AMA audit evidence; admission still owns account selection.
`validateStartupRoleConfig` returns these conflicts as `warnings` entries
(`reason`, `key`) and logs them without refusing startup. Global declaration
validation and the legacy conflict rules remain strict.
Remediators instead
retain legacy class routing when their own identity has no declaration or usable
evidence (including selector errors); declaring only `codex` does not enroll
`remediator-codex`. A declared remediator pool with a usable account takes
precedence over the legacy account policy. Fresh pool exhaustion reaches
only the existing declared eligible cross-family role, retaining `hammer-claude`
and remediation reviewer-family exclusions. Typed infrastructure repair retains
its declared cross-family edge. Recovery reselects on the next new attempt;
running/resumed leases remain dispatcher-owned and unchanged.

Managed remediation bypasses daemon-local OAuth preflight only for pooled
privileged roles. A selected pooled remediator always takes managed dispatch,
including when config, a previous round or health routing selected local mode.
The dispatcher reselects and binds the account at admission, so the proposal
cannot spawn as an unleased local worker. Positive all-account exhaustion with
no eligible available fallback holds budget neutral; its log and retry record
retain the pool refusal reason. `accountProposal` in existing
job and AMA audit evidence records non-secret selection metadata, never a bound lease.
The dispatcher's launch/run provenance remains authoritative for the account that
actually ran. Undeclared pools and explicit legacy corporate requests retain
compatibility routing/affinity until the separately approved migration/drain.
The compatibility order accessor now defaults to corporate-first while preserving
explicit file/env order and class-pin provenance; the legacy strict schema's
personal-first code default remains readable until policy migration. Declared
pools always use their own ordered account IDs. Automatic compatibility routing
recognizes `remediator-codex` as well as the legacy `codex` class. Direct callers
of the remediation fallback resolver use the same job-aware model resolution as
the claim wrapper unless they supply a model callback. No config key is added.
An existing explicit personal class pin with a newly declared pool holds with
`legacy-account-pin-requires-migration` for operator resolution; it cannot silently
become corporate-first or create a new account hard pin. Named legacy corporate
requests keep their compatibility affinity.

Offline owner verification (using the registered companion workspace):
`python3 -I -B test/verify-reviewer-token-owner.py ../agent-os`.
This uses the real reducer with mocked collectors, registry and broker; it never
reads production quota or credentials. Deployment/enrollment remains operator-only
ITP-19, and ITP-23 owns the future operator account hard pin.

### Reviewer account pools (ITP-12)

When `oauth.identity_token_pools` declares `claude-reviewer` or `codex-reviewer`,
reviewer admission uses the canonical Python selection owner and broker execution
semaphore. The declared corporate-first order keeps the reviewer role and GitHub
identity constant. Fresh refusal can select primary; unknown or stale evidence
holds. Undeclared roles retain the legacy selectors during migration.
Claude and Codex admission reject cached pooled selections when the grounding
refresh fails, including when no local account cooldown is active.

`src/reviewer-token-pool.mjs` transports secret-free requests to
`src/adapters/reviewer-runtime/token-pool-owner.py`, which reuses worker-pool's
snapshot collector, registry/model authorization, quota/reserve resolvers and
broker client. A new session UUID is the broker request ID. Admission revalidates
and acquires before native CLI spawn; a declaration change during acquisition
releases the unstarted slot and holds. A capacity CAS loss holds until a later
dispatch, without an unleased fallback. The deployed Python environment must
provide `agent_os_core`, `cwp_dispatch` and their quota dependencies. A missing
owner or unreadable evidence holds rather than reverting to a legacy account.
Native `cli-direct` consumes the binding; other production runtime
adapters hold until they support account binding. This is inert without declared
pools; ITP-19 remains the separately approved operator enrollment step.

Account proposals and acquisitions resolve the canonical `<family>-reviewer`
registry entry with the same model resolver used by the reviewer harness. Reviewer
roles are valid registry keys; no remediation-class translation is required.
An admitted account can establish snapshot availability when fleet quota is
unreadable; a hold descriptor cannot. Held selections remain attached so admission
can preserve the account hold without treating unavailable quota as healthy.

The immutable receipt travels through spawn records, runtime subject context,
settlement results and reviewer-pass metadata. Native auth preparation and refresh
use its provider even if preference recovers or inherited environment changes.
Renewals use the original account/lease/generation every 60 seconds, and restart
reconciliation renews the same receipt. Only confirmed drain releases capacity;
an active process or failed release retains the broker slot for recovery.
Broker expiry alone never frees it. Before acquisition, a durable journal records
the session request ID. Any receipt returned is journaled before pass/spawn writes.
Validation/serialization failures release best-effort; killed transports and
pre-launch exceptions remain discoverable through broker diagnostics by request
ID, even without a run record. After a resolved attempt, terminal or missing run
records permit release; corrupt records defer to the journal's process probes.
The independent recovery sweep runs before capped row reconciliation with four
transports at a time, including terminal/missing rows and runs beyond the row cap.
It renews live bindings and releases only after PGID/session probes confirm drain.
A 60-second launch grace protects receipts without a PGID. Unknown probes or
failed operations log a warning and retain the journal for the next sweep.
Renew/release require explicit positive acknowledgements; transport exceptions,
fence loss and hold responses cannot count as success.
Typed quota exhaustion writes a bounded cooldown for the selected account before
settlement; sibling accounts remain eligible for subsequent attempts.

Unreadable OAuth declarations log the role and routing decision. A durable
last-good reviewer enrollment record keeps undeclared roles on legacy routing
through unrelated config errors, while previously enrolled roles hold with
`pool-configuration-unreadable`. A corrupt enrollment record holds conservatively.
Account holds log repo, PR and reason, release the claim without charging review
attempts, and use the existing 1/2/4/8/15-minute per-PR cascade backoff before the
next claim. Correct the declarations/evidence and allow that bounded backoff to
expire; no account is silently reselected on a live lease.

There are no new delivery or runtime states. The sandbox smoke checks journal
recovery and retry with synthetic leases; it does not enroll live accounts. See [run-record data](data-model/reviewer-run-records.md)
and [lease/enrollment recovery](data-model/reviewer-token-leases.md).
See also [account cooldowns](data-model/reviewer-account-cooldowns.md). Offline
consumer checks and opt-in owner integration (temporary fixtures, no live broker):

```sh
node test/run-tests.mjs reviewer-token-pool.test.mjs reviewer-token-lease-recovery.test.mjs
python3 -I -B test/verify-reviewer-token-owner.py /path/to/registered/agent-os
```

The original 36-case consumer acceptance replay against parent `fad3947f` failed
34 cases; the unchanged same-family refusal and no-account-release compatibility
invariants passed. ITP-12 coverage includes canonical account receipts,
immutable renewal bindings, account-local cooldowns, settlement persistence and
restart renewal/drain release to the already delivered corporate-first selectors.
The intermediate lease implementation without the active-run guard releases
capacity incorrectly in 100/100 duplicate-spawn replays; the guarded version
retains capacity in 100/100 replays. The opt-in owner tests also pin CLC's
primary reserve refusal to the canonical policy flags, so a generic non-coding
task exemption cannot silently admit the primary account below its reserve.
They also run the real `propose` with only registry/evidence/broker boundaries
injected, verifying the minimal daemon shim and JSON row payload offline.

### Review-family attribution and recovery (ITP-13)

A common `reviewerAttribution` receipt now follows canonical reviewer roles
through runtime launch, body capture, reviewed-head attestation and restart
recovery. Every account keeps the existing GitHub actor and HCP subject. Historic
Gemini OS logins remain holder metadata, with unknown account IDs explicitly null;
recovery and backfill do not rewrite historic bodies, run records or signatures.
Same-family exclusion precedes account admission, includes the explicit legacy
aliases, and refuses recovery of a recorded same-family pair. All seven title
prefixes and the existing cross-family routes stay the same.

Restart recovery resolves missing builder context from the durable reviewer pass
for the claim's exact session UUID. Missing or unresolved launch context does not
prove family ineligibility: null-PGID claims first use the existing launch guard
and process adoption. After the guard, confirmed dead launches use ordinary
bounded recovery; known refused pairs still stop before posted-review settlement.
Settlement also requires a verified eligible builder: a posted review with
unresolved builder identity becomes `failed-orphan` for operator inspection.
Durable lookup selects the newest matching pass with builder context, accepting
`first-pass`, canonical `rereview` and compatibility spelling `re-review`, with
session keys `reviewerSessionUuid`, `sessionUuid` or `session_uuid`.

A watcher bounce can leave a live detached reviewer attached to a `pending`
or `failed` claim. Before admitting another reviewer, the watcher restores the
existing claim to `reviewing` when the current head, session, launch record,
and live group leader agree. Subprocess start time and exact launch arguments
fence the restoration and any later native cancellation. Unknown liveness,
unverified launch identity, or a moved head holds admission only until the
persisted reviewer deadline or one-hour fallback. The original review can
settle once from its GitHub artifact. Confirmed exit without a post returns
to bounded bounce recovery with the original counters. See the
[review lifecycle](STATE-MACHINE.md).

After deployment, SRE verifies the watcher PID start time and observes 24 hours
with no new family-message `failed-orphan` rows whose run record shows an eligible
builder/reviewer pair. This observation requires organic runtime evidence.

Captured-body retries retain their original account attribution. Backfill shares
App/PAT matching with capture, pins known heads, and preserves old builder-tag
interpretation when no native reviewer model was recorded. See the
[pass data model](data-model/reviewer-passes.md#review-execution-attribution-itp-13)
and [attestation queue contract](data-model/reviewed-attestations.md).
There are no new states, credentials, configuration keys, smoke promises or CI
jobs. Existing sandbox smoke still covers lease ownership and drain; account
attribution is exercised by the bounded offline tests:

```sh
node test/run-tests.mjs reviewer-attribution.test.mjs review-body-capture.test.mjs reviewed-attestation.test.mjs backfill-review-bodies.test.mjs watcher-reattach.test.mjs watcher-claim-loop.test.mjs
```

ITP-19 remains the separately approved operator rollout; this change performs no
host cutover or alias retirement.

CLI dispatch and restart recovery retain validated, prebuilt holder projections
when raw leases are absent from sanitized context. Corporate model aliases use
their canonical family at review posting. Recovery refuses same-family pass
attribution before metadata writes, and integer generations include initial zero.

Acceptance replay used pre-change parent `6761b30b94035ca9e4e93f6b2dccae7a5fc65f81`:
all 10 ITP-13 outcome tests failed there and pass after implementation. The focused
357-test pass covers capture, restart recovery, native spawn/settle, legacy
backfill, reviewed signatures, exact-head merge eligibility and fixture ledger
lookups. The watcher claim-loop suite also passes all 127 tests, and the runtime
and state/smoke contract suites pass all 100 tests. No companion ledger migrations
or concurrency algorithm changed.

### OSG configuration declarations

OSG-16 adds inert `osg.double_blind` declarations for the dispatch owner:
`enabled: false`, empty `window_start`/`window_end`, `sample_rate: 0.05` and
`weekly_cap: 10`. Both optional numeric controls have strict bounds, and a null
subtree is rejected in top, module and local layers. The shared synthetic vectors
cover the same inputs in Node, Python and shell. This loader does not launch
paired work or enable the experiment.

OSG-13 adds the shared `osg.sample_rate` declaration: a number from 0 through
1, defaulting to 0.5. The dispatch owner consumes it; this loader preserves
Python/shell parity and leaves all modes off by default.

The strict loader accepts `osg.version: 1`, `osg.mode` (`off`, `shadow`, `apply`)
and `osg.arms`. Defaults are mode `off` and an empty arm catalog. Each arm
requires role, harness, worker class, model, effort and a non-secret account ID.
The generated CFG schema carries the arm shape (ONS-07); synthetic shared
vectors live in `test/fixtures/osg-config.v1.json`. Reviewer routing consumes them
only through the optional seam below; remediation routing remains unchanged.

### Reviewed routing policy (OSG-18)

`osg.policy.enabled` defaults to false. `src/osg-policy.mjs` exports `readPolicy`,
`loadPolicy` and `resolveDefault`. The policy file belongs to the parent
configuration package at
`platform/agent-os-config/src/agent_os_core/osg-routing-policy.v1.json`.
The caller supplies its already-resolved path; there is no second policy copy.
OSG-12 delegates reviewer policy resolution to the parent owner; the remediation
seam is separate.

The v1 document is `{version: 1, entries: [...]}`. Each entry has `role`,
`stratum: {task_type, size}`, `arm` and `promotions`. Roles are builder, reviewer
and remediator; task types are build, fix, refactor/chore and docs/config, with
small/large size. Initial `arm: "current"` entries preserve the caller's route,
cross-model rules and ordered token-pool selection. A concrete arm uses the
existing six-field OSG arm contract. Its final promotion receipt
`{checkpoint, report, arm}` must match that arm. Role/checkpoint pairs cannot
repeat across entries. Shared accept/reject vectors cover both loaders.

`resolveDefault({enabled, mode, policyPath, role, stratum, current, allowArm})`
returns `{arm, reason}`. It reads no file unless enabled is true and mode is
apply. On missing/invalid policy or an unavailable arm it returns the exact
current object with a safe reason for the seam to record. The caller must
provide `allowArm` using its normal allowlist, availability, token-pool and
cross-model checks; only literal true authorizes a concrete arm. The file
reader bounds input at 128 KiB and refuses non-regular files and malformed UTF-8.
Values are copied and frozen; current routing objects are never mutated.

Promotions are reviewed one-entry policy changes with a matching checkpoint
report under `docs/reports/`. The parent package owns the on-demand promotion
check and idempotent ledger-ticket interface for demotion alarms. A policy-file
revert restores the previous route. Report analysis and service wiring are
separate changes; no startup read, provider request, config flip, CI gate,
authority change or daemon restart is introduced here.

The shared strict OSG configuration schema also declares `osg.budget` monetary
and account-share limits. Defaults are inert; schema parity fixtures exercise
lower values and reject invalid/above-approved limits. This schema update does
not activate routing or change review/merge authority.

### Configuration reconciliation (ITP-17)

The strict config default for Codex account order is now `corporate-first`,
matching the pooled hammer, remediator and reviewer selectors. Explicit legacy
orders remain loadable before enrollment. Once a role pool is declared,
`resolveIdentityTokenPools` accepts canonical role selectors from repo, local
and environment layers, including `roles.remediator: codex` for the
`remediator-codex` pool. Only account-affine twins conflict with a declared role
pool. An explicit `roles.codex_worker_account_order` conflicts when its provider
order disagrees with any declared Codex-family pool; an agreeing key emits one
redacted redundancy warning per process. Singleton pools agree with either
legacy order. Account IDs are opaque; provider bindings determine agreement.
Unresolved provider bindings or malformed Codex-family membership cannot prove
agreement and yield a structured account-order conflict. Legacy Gemini reviewers
without a declared pool log that conflict and retain their legacy holders;
ordinary configuration reads retain full OAuth declaration validation.
`inspectLegacyPoolOverrides` returns conflict and redundant keys without logging
or changing warning state; `legacyPoolOverrideConflicts` remains a pure array
query. Validation and startup emit redundancy warnings through injectable loggers,
including the Gemini reviewer's logger. Tests and explicit reload boundaries can
call `resetLegacyPoolOverrideWarnings()` to clear conflict and redundancy warning
scopes; ordinary reads retain per-process deduplication.
Refusals retain the exact config path and winning source. The helper never
rewrites an override, and canonicalizes class aliases before
mapping remediator harness names to their role pools. This does not expand the
strict schema's accepted role values. Empty maps mean no enrollment; null pool
declarations remain invalid and produce a sourced configuration error from the
strict loader. The inspect-only proposal/report owner is
`cwp_dispatch.config_token_pool_migration` in the registered agent-os repo;
apply no proposal until the separately approved ITP-19 operator rollout.

`src/worker-class-aliases.v1.json` is the byte-identical publication of the
agent-os-config alias vocabulary. Hammer capability and remediation provenance
maps derive their compatibility views from canonical roles. The compatibility
reader grants no account lease, model, GitHub actor or merge authority. All
legacy spellings remain readable through drain, and broker/refresh provider IDs
retain their account names. This changes no durable state or smoke promise.

### Remediator execution arms (OSG-14)

The optional remediator seam consumes an existing ticket assignment and changes
only execution class, model, effort and proposed account. `osg.mode: off` retains
the original dispatch object and emits no experiment evidence. Active modes use
the canonical ledger budget/catalog owner and ITP account proposals; any missing,
unavailable or invalid arm retains the default route with a bounded reason.
The hammer's logical identity, prompt, lease, rebase and merge rules are unchanged.
See [the execution contract](OSG-remediator-execution.md) for evidence and
rollout ordering. Existing lifecycle states and smoke promises are unchanged.

### Per-PR reviewer arms (OSG-12)

`src/osg-reviewer-arm.mjs` runs between subject routing and effective reviewer
selection. Mode off returns the original route with no owner process, account
proposal or policy read. Shadow records a proposal and keeps the same route.
Apply can replace the default with an approved native reviewer arm. The normal
cross-family and Gemini integrity guards still run; title routing, posting,
verdicts, signed reviewed attestations and merge authority retain their owners.

The bounded, secret-free stdio request invokes `cwp_dispatch.osg_reviewer` from
the configured Agent OS deployment, retaining the full `owner/repo` identity
and resolving the incumbent against the domain route table. That owner reads the canonical arm
contract, policy and budget, exact publication provenance and classified stratum,
and persists one immutable assignment per ticket before returning an arm. An
unavailable owner or missing classification returns the default. The whole owner
process uses a 5-second nominal budget, scaled by the existing
`adversarial.reviewer.load_aware` policy up to an absolute 30-second ceiling;
it never installs dependencies or migrates a ledger. The deployment is resolved
from `AGENT_OS_DEPLOY_CHECKOUT` or `roots.deploy`, reading configuration through
the supplied execution environment (including `AGENT_OS_CONFIG_PATH`). The interpreter is
`HQ_PYTHON3`, then `AGENT_OS_PY`, then the deployment's `runtime/python/bin/python3`
when present, then `python3`. Explicit deployment package roots replace ambient
`PYTHONPATH`, and the child runs in that deployment. Spawn, import, timeout,
exit and invalid-JSON failures log distinct stable `error-owner-*` tokens without
stderr and retain the default route. All modes ship off; host flips
belong to the configuration writer's operating runbook.
Import classification includes missing modules and Python `ImportError` symbol
resolution failures.

The initial executable surface is native Codex/Claude under `cli-direct`, with
declared ITP accounts. Other runtimes, open-model arms and unmeasured accounts
are unavailable proposals. An incumbent whose account cannot be measured, including
holder-based Gemini, keeps current routing. ITP still authorizes the model, chooses the account
and acquires its execution lease at spawn. A changed/held account discards the
experiment pins and uses the ordinary default; a family change transfers the
existing review claim through a model-neutral compare-and-swap callback. The
fallback reuses the resolved incumbent route and sends stable reason notices
through the caller's contextual logger when provided.
The claim, runtime and settlement retain one session UUID; this pre-spawn fallback
does not invoke Gemini quota handling or release Gemini credential probes. No trial pins cross
a subsequent family fallback. CLI arguments carry model/effort to the existing
`reasoningPin`, including Claude broker model preparation and silent retries.

There are no new review states, lease states, transitions or smoke promises.
Offline validation uses `osg-reviewer-{arm,effort,spawn}.test.mjs`, the watcher
claim-loop, ITP account, spawn/settlement and reviewed-attestation fixtures. The
assigned/default fixture compares the real posting path's verdict and attestation
payload with injected effects; it never calls GitHub, a signer or a provider.

### Model/Effort Selector review-service hook (MES-06, MES-09)

`src/mes-shadow-hook.mjs` records one Agent OS MES decision per review pass and
per local remediation round through `hq mes decide --record --json`
(`schemaVersion: 1`). A recorded `apply: true` response can replace the implicit
model/effort pair. Precedence is service env pins, OSG reviewer/remediator arm,
MES, then the registry default. An explicit model or effort prevents MES from
replacing either field. Explicit sources are reported to the CLI for
`overridden_by`; no runtime policy is read from project files.

- **Review.** Claude and Codex decide before authentication so model-bound auth
  uses the selected model. Codex revalidates against the refreshed registry after
  auth. Oversized chunked passes decide once with the whole diff and reuse the
  chosen pair. Gemini remains observational. The subject is
  `<owner/repo>/pr/<n>/review/<head>`.
- **Local remediation.** The runtime awaits the bounded decision before model
  auth and spawn, then passes the whole resolution to the worker. Claude broker
  minting uses that final model. The subject is
  `<owner/repo>/pr/<n>/remediation/round-<r>`. HQ dispatch owns its separate MES
  hook; round budgets and account routing are unchanged.
- **Validation.** Applied choices must match the existing non-corporate role,
  its live registry `allowedModels`, and its per-model
  `reasoningLevelsByModel`, with effort in `low`, `medium`, `high`, `xhigh`.
  The outage seed cannot authorize a new MES choice. Invalid policy logs
  `invalid-policy`; resolver errors log `resolver-error`, retaining the static
  execution. Codex receives `model_reasoning_effort`; Claude receives `--effort`.
- **Signals.** Review: diff lines and file count from the reviewed diff, risk
  paths matched against `worker_pool.scope.restricted_paths`, and the change
  kind and builder prefix from the title. Remediation: blocking and
  non-blocking finding counts from the review body, `git --no-optional-locks
  diff --numstat origin/<base>...HEAD` in the workspace, and rounds so far
  against `remediationPlan.maxRounds`. Only numbers, closed enumerations and
  booleans are sent. No title, path, prompt or finding text crosses the
  process boundary. A signal that cannot be computed is `null`, never `0`; a
  binary file nulls the remediation line count but still counts as a file.
  Head SHAs are matched case-insensitively and keyed in lowercase.
- **Sources.** `registry` stays `registry` and `committed-seed` maps to
  `static-default`. Env model/effort pins and the non-blocking remediation
  config map to `env`, the OSG reviewer arm to `reviewerArm`, and the OSG
  remediator arm to `osg-apply`. Agent OS records each explicit source as
  `overridden_by`. A host-config fallback effort is a default fill, not a pin.
- **Bounds.** The CLI call has a 5 s ceiling (`MES_DECIDE_TIMEOUT_MS`,
  SIGKILL), and the remediation `git` read has 2 s. A `duplicate` refusal for a
  re-review of the same head, or a respawned round, is retried as the next
  `attempt`, at most four times inside the same ceiling. The ledger's unique
  `(work_kind, subject_key, attempt)` key decides which attempt is recorded.
- **Failure.** A missing CLI, a timeout, garbage output or a CLI/ledger error
  logs one `[mes-shadow] <kind> decision not recorded reason=<reason>;
  execution unchanged` line to stderr and returns. The hook never throws.
  Offline tests (`NODE_TEST_CONTEXT` or the runner sandbox) never reach a host
  `hq` unless they inject an exec; the Codex resolver fixture's `HQ_BIN` stays
  in force.

This adds no configuration key, review state, lease state, transition or smoke
promise. `apply: false` is checked on every launch; decisions are never cached.
Offline validation is `test/mes-shadow-hook.test.mjs` and
`test/mes-enforcement.test.mjs`. The provisioned CLI currently returns
`apply: false` (`enforcement-unregistered`); synthetic enforcement evidence does
not establish live activation. After normal deployment, the runtime owner can
inspect natural decision reasons and execution provenance read-only. Enabling
MES or restarting services remains an operator step for MES-12/MES-13.
See [the consumer contract](data-model/mes-review-enforcement.md).
The [operator handoff](../modules/worker-pool/post-merge-actions/mes-09-review-enforcement.yaml)
declares deployment and read-only acceptance without automated activation.

Run selected suites through `node test/run-tests.mjs <test files>` to isolate
production state from the checkout. Restricted workers can set
`ADVERSARIAL_REVIEW_TEST_TEMP_BASE` to an owned temporary parent; this disables
the runner's short-path `/tmp` fallback. Socket-based tests still need a parent
short enough for the platform's Unix socket path limit.

Each runner sandbox records its owning PID and, atomically after spawn, its
detached test group ID in a private `.runner-owner.json` marker. Startup logs
failed deletions and reclaimed `art-*` directories under the same temporary
parent. Reclamation requires same-user directory and marker ownership, at least
24 hours of age, and confirmed absence of both the runner PID and test group.
Live or uncertain processes, PID-only markers from older runs, missing or invalid
markers, and symlinks are preserved, including older sandboxes created before
ownership markers existed. Normal completion and handled
SIGTERM/SIGINT/SIGHUP remove the current sandbox after stopping the test group;
a synchronous exit hook also stops the group and retries cleanup on an explicit
`process.exit()` or an unhandled asynchronous error outside the runner's `try`
block. Synchronous exceptions inside that block unwind through `finally`, which
also stops a still-running test group before cleanup. SIGKILL cannot run cleanup,
so a later run reclaims its marked sandbox once it is old enough and both owners
are absent. Exit-hook cleanup errors are logged without replacing the original
exit status.

### V2 repository/base queue foundation (MGQ-01)

The finalization port now has durable lane storage and a fenced single-host
owner seam in `src/finalization/`. The watcher uses it for transferred queue lanes.
Acknowledged readiness is atomic, parked entries rejoin the tail explicitly,
and replay preserves candidate, phase and original infrastructure deadline.
Owner states are `idle`, `active`, `parked`. A per-lane issuance lock spans
intent, remote operation and drain; an expired lease cannot authorize takeover
while a request is ambiguous. Missing stop/drain and authoritative reconciliation
proof parks the lane. A watcher tick that ends with an unresolved operation
parks its active fence immediately and retains the prior owner and intent for
reconciliation. Subject leases continue to protect only individual subjects.

Focused offline fixtures in `test/finalization-queue-owner.test.mjs` exercise
simultaneous claims, stale generations/routes, paused issuance, ambiguous push
and merge intents, phase replay, FIFO/readmission, publication restart cases,
bounded waits and a probe that performs no store mutation. These are focused
fixtures; the existing smoke promises gain no new live action or CI check.

After normal deployment, the operator runs
`node src/finalization/queue-probe.mjs --capability owner --json` under the
runtime account in the deployed checkout. It checks actual schema/adapter
availability and reports the probe's runtime module digest and existing claims.
Empty lanes mean organic execution evidence is pending. No route/config flag,
service bounce or synthetic traffic is part of this slice. See the
[owner observation and recovery procedure](finalization-executor-promotion-runbook.md#queue-owner-storage-observation-mgq-01-no-activation)
and [store contract](data-model/finalization-ledger.md#repositorybase-queue-mgq-01).

RCV-01 shared configuration: the strict Node loader recognizes the full
`worker_pool.recovery` subtree, matching Python and the shell export reader.
`test/fixtures/recovery-parity.json` is the shared synthetic acceptance/rejection
fixture. This reader-support change publishes no recovery config values and
changes no review, queue, merge or hammer authority. Merge/deploy compatible
readers before an operator publishes recovery host settings. Normal Agent OS
submodule float carries the merged companion; no feature-head pointer bump.

### V2 durable closer handoff (MGQ-02)

`createQueueHandoffService` validates complete terminal finding coverage and
persists pushed head, source review id/commit, signed evidence, worker/closer
identities, primary-change/local-validation provenance and fixed/withdrawn
dispositions with the queue entry and ack in one transaction. Real non-blocking
findings require dispositions too. Fixes need concrete evidence; withdrawals
also need source explanations and locations. Original signatures and finding
identities survive candidate derivations without rebinding or another model
judgement.

`createCloserQueueHandoffBoundary` confirms durable acknowledgement before
resource release and suppresses duplicate closer dispatch at the admission.
State is absent until the transaction commits; duplicates, lost replies and
restart return the same immutable `acknowledged` receipt. Write failure rolls
back entry/event/readiness. The installed receiver uses authenticated review and
publication reads and verifies the dispatched launch and generation. The legacy
retry helper continues to serve lanes under legacy ownership.

`test/finalization-queue-handoff.test.mjs` covers coverage/provenance refusals,
independent duplicate submitters, crash after commit, lost ack, release ordering,
signature/disposition preservation, bounded waits and a read-only probe. Existing
smoke promises are unchanged; there is no new live action or CI check.

After source deployment and both additive queue migrations, the operator runs
`node src/finalization/queue-probe.mjs --capability handoff --json` from the
deployed checkout under its runtime account, using the bounded load-aware
supervisor in the [observation procedure](finalization-executor-promotion-runbook.md#durable-handoff-observation-mgq-02-no-activation).
Require `.capabilities.handoff.available == true` and `.runtime.build != null`.
The probe resolves the durable adapter against real schema and reports ack
counts. Zero means organic evidence is pending. Availability does not assert
live evidence-reader composition, lane routing or a running watcher's build.
See the [handoff contract](data-model/finalization-ledger.md#durable-closer-handoff-mgq-02).

### Shadow replay policy and parsing (OSG-11)

`src/osg-reviewer-replay.mjs` exposes read-only `replayRouteAllowed` and
`parseReplayReview`; `bin/osg-reviewer-replay.mjs` accepts bounded private JSON
stdin operations `route`, `parse`, and `ranges`. It imports the existing routing
and finding parsers, with no production reviewer, store, GitHub writer or
attestation path. Parsing requires both canonical findings sections (`Blocking
Issues` and `Non-blocking Issues`) to be known; a missing section or unedited
template placeholders in either section reject the review. Omitted or null
route options use the ordinary non-diagnostic defaults. The bridge decodes
streamed UTF-8 across chunk boundaries, caps input at 128 KiB and review bodies
at 64 KiB, and emits one newline-terminated JSON result. Invalid input exits
nonzero with a generic stderr diagnostic and no stdout result.
The `ranges` operation serializes the shared parser's result directly (an empty
array for unknown or unparseable citations); unsupported operations are rejected
before dispatch. Native recommendations follow the canonical base builder route
or permit Gemini for the canonical Gemini-eligible classes (`claude-code`,
`codex`, `clio-agent`).
Codex and Claude arms accept their matching `-reviewer-corp` worker identities.
Model-family detection includes OpenAI `o1`, `o3`, and `o4` reasoning IDs and
Bedrock `anthropic.claude-*` IDs, including regional inference-profile prefixes.
Unknown/same-family models are refused, including models concealed behind a
third-party harness. DeepSeek through Pi can run diagnostically when the known
builder family differs; that diagnostic permission cannot recommend a route.
The caller owns pinned diff extraction, authorized read-only execution, budget
reservations, quota measurement and score evidence. This bridge does not launch
reviewers or change any live routing configuration. Synthetic tests exercise
parsing/routing with network, process execution and publication writes forbidden.

The strict OSG schema recognizes `osg.router.mode` as `off`, `shadow` or `apply`,
defaulting to `off`. Router subtree nulls are rejected in every configuration layer,
matching the shared Python/shell acceptance vectors. This reader-only addition
performs no routing or artifact access, grants no activation approval, and changes
no review/merge authority or service lifecycle. Allocation and offline evaluation
belong to the companion worker-pool owner; activation follows its config-writer runbook.

LVR-08 provides two bounded evidence commands for observe-mode activation:
`node src/activation-check.mjs hammer-token` forces the existing in-process
hammer refresh/parser, without held-token fallback or a GitHub operation, and
emits only `{parsed, source, expiresInSeconds}`. It requires the caller's
existing entitled refresh-command environment; absent launch entitlement or
transport failure exits nonzero (inconclusive), never a healthy-token fallback.
The module's `checkRefresh(now)` accepts an epoch-millisecond timestamp or a
clock function returning milliseconds; it defaults to `Date.now`.
Invalid parser output emits `parsed:false` for the activation expectation to
fail. No raw command, child stream, token or exception is printed or persisted.
`node src/activation-check.mjs daemon-reservation` reads the watcher's poll
interval and calls `daemonMergeReservationSeconds` with that effective value;
its evidence is `{reservationSeconds, pollSeconds}`. Activation YAML lives in
the consuming superproject and remains observe-only. Normal deployment must
make both repository revisions available before that consumer declares success.
Both commands also execute when the script is invoked through a symbolic link.
Importing the module's helpers does not require a real filesystem path in
the host's `process.argv[1]` and does not execute either command.

Evidence-read failures use exit 126 (the consuming activation contract's
`check_error`), making missing entitlement and transport/read failures
inconclusive. Exit zero means evidence was collected; the declaration evaluates
that evidence for pass or fail.

### V2 FIFO admission (MGQ-03)

`createCleanReviewService` admits signed, complete zero-finding exact-head reviews
through the same transactional readiness counter as terminal closer handoffs.
`createQueueAdmissionService` reads live subject/head/base, complete labels,
identity, write rights and shared structural policy. Clean work retains its final
current-head review read; complete terminal adjudication needs no re-review.
Live/unknown holds park outside actionable FIFO. Closed/merged observations
reconcile without dispatch. External author changes return for fresh adjudication.
Parked recovery and repairs join the tail with fresh evidence, retaining history;
duplicate wakes and restarts preserve position and the original absolute deadline.
Snapshot comparison prevents late recovery reads from overwriting a newer hold.
Terminal structural returns record the matching reversion/conflict reason even
when infrastructure also fails. Progress events retain the phase before mutation;
legacy events remain replayable. Live SHA casing and numeric/string review IDs
do not change identity, and complete labels are passed as names to shared policy.

The lifecycle is acknowledged → ready, or parked-hold/permission/infrastructure,
returned-to-closer, or closed-observed. The watcher admits only lanes with matching configuration and durable queue
ownership. Readiness alone grants no merge authority. Focused offline
`finalization-queue-admission.test.mjs` exercises mixed-source process contention,
read/recovery races, holds, current-head reads, bounded waits and probe immutability.
Regressions also cover mixed infrastructure/conflict diagnostics, equivalent head
and review identities, label objects and durable prior-phase audit/replay.
Existing smoke promises gain no new live action, CI check or promotion gate.

After normal source deployment and all three queue migrations, the operator runs
`node src/finalization/queue-probe.mjs --capability admission --json` from the
deployed checkout under its runtime account with the existing bounded load-aware
supervisor. Require `.capabilities.admission.available == true` and
`.runtime.build != null`; record actual source/disposition/observation counts.
Empty organic evidence and live-reader/routing composition remain pending.
See the [store contract](data-model/finalization-ledger.md#fifo-admission-and-clean-reviews-mgq-03)
and [operator observation procedure](finalization-executor-promotion-runbook.md#fifo-admission-observation-mgq-03-no-activation).

LAC-2096 deployment restores automatic daemon intent reconciliation; pre-deploy reader grants and affected intents must be checked. Canonical identity/absence guarantees are PostgreSQL-scoped; producer-shaped SQLite ticket recovery remains fenced. See the recovery deployment boundaries in the closure runbook.

LVR-04 mirrors the strict boolean
`deploy.post_merge_activation.incident_dispatch` (default false). This is a
forward-reader contract for the host's bounded deploy-incident repair. The review
service does not dispatch incidents or change merge authority through this knob.
`test/config-loader-incident-dispatch.test.mjs` covers default, explicit booleans
and invalid values with synthetic configs only. Deploy the reader before enabling
the setting in a host overlay.

### V2 mechanical rebase (MGQ-04)

`createQueueRebaseService` prepares conservative rebases in isolated repositories,
proves every ordered change including binary data, whitespace, paths, modes,
symlinks and gitlinks, and persists the candidate/base/source before the fenced
expected-old-head push. Empty commits, unsupported histories and unprovable
preservation return to the closer. Full-index patches must match byte for byte:
even conflict-free edits to a file changed upstream fail proof. Disjoint-file
rebases are the supported case. Generated files receive no exception.
Original signed evidence stays at its source head; author warning and permission
notice intents remain durable for the delivery composition.

The execution lifecycle is ready → rebasing → publishing → waiting-checks,
with permission/hold/infrastructure parking outside FIFO and terminal returns
for author changes or failed proof. Restart verifies the persisted candidate and
reconciles outstanding operations before retry. A published candidate resumes
checks without repushing. A no-op keeps the SHA with explicit proof. Outside base
movement keeps the original absolute deadline and records the derivation chain.
Admission re-proves a queue-published candidate against its immutable receipt
before readmission; retained candidates resume via rebasing → publishing. Explicit
Git push success settles the intent despite API lag, with a Git-sourced publication
reference. Explicit single-ref remote refusals settle as not-applied; unknown
transport outcomes still require drain recovery. Failed preparation removes its
unreturned workspace. Successful workspaces remain for restart proof and require
operator retention cleanup; no automatic retention sweep is wired. Rewritten
commits default to `Queue Rebase <queue@example.invalid>` as committer, with the
original author and message preserved. Full prior proofs and live snapshots are
still duplicated in progress events; compact evidence storage remains follow-up
work before production routing.

Recovery verifies every contiguous derivation from the admission head, including
prior workspaces, before accepting either the current candidate or its proven
expected old head. This includes a park after a second candidate was prepared
but before publication. A computed proof mismatch returns to the closer;
unavailable Git execution parks as infrastructure, and expired patience parks
before proof execution. Both already-published paths recheck live holds and
permissions before advancing to checks. Deterministic workspace, remote, runner
or deadline refusals before transport invocation settle `not-applied` with
`git:push-not-spawned`; failures after invocation still require authoritative
results or drain reconciliation. Ambient author/committer environment variables
and `EMAIL` are removed from local Git execution so replay retains the source
author and uses the synthetic committer.

The production consumer uses the existing entitled GitHub credential for
network Git. The runner refuses ambient SSH credentials. The existing execution brake applies before preparation and push.
No new CI or smoke step is added.

Focused offline fixtures are `finalization-queue-rebase-proof.test.mjs`,
`finalization-queue-rebase.test.mjs` and `finalization-queue-git.test.mjs`.
After normal deployment, the runtime owner runs
`node src/finalization/queue-probe.mjs --capability rebase --json` under the
existing bounded load-aware supervisor. Require
`.capabilities.rebase.available == true` and `.runtime.build != null` and record
the Git/proof adapter and actual publication observations. Missing organic
publications and unverified loaded routing remain pending. The probe
checks the real schema and Git executable and never creates a workspace or
mutates a lane. See the [operator procedure](finalization-executor-promotion-runbook.md#mechanical-rebase-observation-mgq-04-no-activation)
and [data contract](data-model/finalization-ledger.md#mechanical-rebase-and-publication-mgq-04).

### V2 candidate checks and parking (MGQ-05)

The v2 finalization waiter resolves and versions the complete existing
required set, enumerates all exact-candidate check-run and legacy-status pages,
and uses the shared CI classifier. Latest reruns win, with numeric REST IDs or
GraphQL database IDs breaking timestamp ties. REST runs use start/completion
timestamps; undated queued runs remain pending evidence. Missing, pending,
stale, partial, unreadable and inconclusive
evidence never authorizes finalization. Existing explicit no-CI policy still
requires a fresh candidate proof. Original local validation stays at its source
SHA in the immutable receipt.

The lifecycle is waiting-checks → finalizing for green, returned-to-closer for
completed red, or parked-infrastructure on expiry. The entry retains its original
30-minute nominal infrastructure patience, scaled once with a 60-minute hard
ceiling across polls, restart and base churn. Infrastructure parking releases the
lane and journals one stable cause page through existing Sentinel delivery;
outages never dispatch or charge remediation. Bounded recovery revalidates the
candidate/base, derivation, holds and existing admission policy before tail
readmission. An expired entry gets no new CI wait. Readmission grants no merge
rights; final eligibility remains the executor's responsibility.

No production route, new config, CI check or smoke step is installed. Source
fixtures are `finalization-queue-checks.test.mjs`,
`finalization-queue-check-transport.test.mjs`, `finalization-queue-check-race.test.mjs`,
`checks-summary.test.mjs`,
`hammer-token.test.mjs` and `alert-delivery.test.mjs`. The runtime owner separately
runs `node src/finalization/queue-probe.mjs --capability checks --json` from the
deployed checkout with a bounded load-aware supervisor. See the
[store contract](data-model/finalization-ledger.md#candidate-checks-and-infrastructure-parking-mgq-05)
and [deployment observation procedure](finalization-executor-promotion-runbook.md#checks-and-parking-observation-mgq-05-no-activation).

### V2 final eligibility, guarded merge and receipts (MGQ-06)

The v2 merge step consumes a `finalizing` exact candidate. Immediately
before mutation it rereads the existing emergency brake, subject ledger,
immutable receipt and disposition digest, live head/base/holds, identity, branch
rights, primary change, existing structural eligibility, the recomputed rebase
proof and a complete exact-candidate check snapshot. The live owner fence and
route generation replace only the legacy merge-lease execution input. Head
changes return to the closer; holds and the brake park; an outside base write
clears stale readiness and rebases/retests under the original deadline.

The final decision and owner-journaled intent precede the existing squash
expected-head surface. A reply is never success: only live merged state at the
candidate with a structured merge SHA and the attributed bot as merger records a
receipt. Mismatched, unstructured or foreign already-merged replies are not
success, and an invisible ambiguous merge waits for drained owner takeover. The
receipt (old/new head, base, rebase provenance, check snapshot, decision, merge
SHA, bot/closer attribution) commits with the merged phase, a subject-ledger
`merge_observed` landing event and stable-key outbox rows for the existing merge-action
accounting and AMA closure audit. Delivery retries never repeat the merge or an
action, and pending delivery stays visible after the lane advances. The subject
retains a post-merge delivery owner until a matching PMA run supplies verified
activation evidence; landing alone never writes `finalized`. Custody changes
invalidate authorization and select owned reconciliation from the shared fold.
Outbox database operations retain the store's configured busy timeout so a
transient writer can finish after lane release. The merge probe's recent receipt
`recordedAt` is the authoritative merge time (`merge.mergedAt`). Clean reviews
have no closer; remediated receipts retain the admitted closer attribution.

No production route, new config, CI check or smoke step is installed. Source
fixtures are `finalization-queue-merge.test.mjs` and
`finalization-execution-surfaces.test.mjs`. The runtime owner separately runs
`node src/finalization/queue-probe.mjs --capability merge --json` from the
deployed checkout with a bounded load-aware supervisor. See the
[store contract](data-model/finalization-ledger.md#final-eligibility-merge-receipts-and-delivery-outbox-mgq-06)
and [deployment observation procedure](finalization-executor-promotion-runbook.md#merge-and-receipt-delivery-observation-mgq-06-no-activation).

### V2 queue shadow decisions and throughput (MGQ-07)

The finalization port exposes a read-only queue observation consumer alongside
the existing shadow recorder/store/report. Paired observations carry v1 action
provenance, lane readiness/order, rebase/check/final proposals and evidence.
Only telemetry is written; no owner claim, push, merge, remediation dispatch or
closer budget is available to this consumer. Live composition belongs to the
routing slice. Unknown store/fold/read results stay open for operator escalation;
queue differences can be attributed to either v1 or queue defects with recorded
disposition evidence.

`finalization shadow-report --days 7 --json` now includes separate organic and
synthetic per-lane metrics: sample/window denominators, total/mean completed
service time, oldest ready age, arrivals/merges/returns per hour, check waits and
infrastructure/hold parking. Durable lifecycle replay preserves denominators
and readiness age over duplicate ticks and restart. Synthetic replay cannot
establish organic coverage. The text report rounds hourly rates to two decimal
places; the JSON model retains numeric precision. Existing promotion criteria
and smoke promises remain; this adds no CI check or automated gate. Focused
offline fixtures are `test/finalization-queue-shadow.test.mjs` and the existing
shadow tests.

After deployment, the runtime owner runs
`node src/finalization/queue-probe.mjs --capability shadow --json` under the
existing bounded load-aware supervisor. It reports real schema/adapter
availability, the probe build, latest organic consumer/time and observation-only
mode. A null `shadow.lastObservationAt` with `shadow.organicEvidence == "pending"`
is valid pending evidence; an organic observation requires a timestamp. See the
[shadow deployment observation procedure](finalization-executor-promotion-runbook.md#queue-shadow-observation-mgq-07-no-activation),
[triage guide](finalization-shadow-divergence-triage.md#queue-decision-evidence-mgq-07)
and [store contract](data-model/finalization-shadow.md#queue-observations-mgq-07).

The existing next-action observer also feeds legacy-lane snapshots/results into
the same ledger and shadow report. `hq merge-lane shadow report [--json]`
forwards the service read model; `promotionGate` adds MLR-04's 50 distinct
organic terminal-subject requirement, terminal head-move/exhaustion examples and
full-history triage/error arithmetic. Both MGQ and MLR readiness are required.
See the [deployment handoff](https://github.com/laceyenterprises/agent-os/blob/main/modules/worker-pool/post-merge-actions/mlr-07-shadow.yaml): after both
repository PRs merge and normal deployment, Main Loop 6/SRE reloads the watcher
through its registered service path and proves row growth across natural
traffic in every active lane. Historical nonzero rows alone are insufficient.
Shadow has no execution port; frozen v1 policy and existing smoke commands
remain unchanged. Focused synthetic fixtures exercise the live ingestion seam.
