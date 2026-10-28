# Search configuration mirror (SPE-01)

`src/config-loader.mjs` mirrors `services.hcp.search` for Node consumers such as
the watcher and follow-up daemons. This reader validates metadata only: loading
configuration does not resolve credentials, contact providers or enable worker
access. Defaults keep all six providers disabled; omitted local budgets stay unset.

## Strict policy and deployment order

Search policy deliberately opts out of the generic agent-os#1743 rolling-schema
tolerance. Both `loadConfig` and `loadConfigRuntime` reject unknown search keys,
including `__`-prefixed keys, even inside disabled providers and versionless
`config.local.yaml` or module-local files. Known invalid values also fail closed.
There is no environment flag to relax search validation. Unknown keys outside
this subtree retain their existing compatibility behavior.

For any new search key or operation vocabulary:

1. Publish and deploy the Node mirror first, ensuring watcher and follow-up
   processes use the updated reader before their next configuration load.
2. Deploy the companion Python and shell readers in the Agent OS superproject.
3. Only after all readers accept the declaration, publish it in shared or local
   configuration. Keep providers disabled until separately authorized activation.

Setting a new key before updating Node can stop daemon configuration reads,
including when the provider is disabled. Recover by removing the premature key
or deploying its reader; do not use runtime tolerance as a rollout bypass.
Validation failures identify the policy path. Successful resolution exposes
winning file provenance through `sources` and layer history through
`resolutionTrace`; this mirror adds no separate audit store.

## Optional budgets and usage watch

Provider `budget_usd` and gateway `run_budget_usd` are independent optional
local controls. Omission disables local spend refusal for that dimension; a
configured budget must be positive when enabled. Explicit disabled zero values
remain valid and are retained, so enabling an inherited zero requires changing
that value. No loader inserts an implicit zero. Money is a finite nonnegative
decimal USD string; negative, non-finite and numeric values are rejected.

Request ceilings remain required. `max_charge_usd` is optional in each operation
limit; when supplied it must be positive and accompanied by `currency: USD` and
`pricing_provenance`. An absent charge declaration does not remove request limits,
product authorization or route/confinement requirements. Optional operation-limit
`product_authorized` is a boolean host attestation for separately authorized
products; its omission grants no product access.

Optional provider `watch_threshold_usd` and gateway `run_watch_threshold_usd`
use the same money syntax but accept zero while enabled. They are monitoring
thresholds, never budgets or access controls. Optional gateway
`usage_watch_window_seconds` is an integer from 1 through 2678400 (runtime default
86400). Omitted thresholds do not create a local budget. This reader validates
these declarations only; the host gateway owns durable accounting and alerts.

The companion superproject change depends on this Node relaxation merging and
floating first. Deploy the updated reader before publishing optional-budget
configuration or new watch keys; Node tests do not attest the other loaders.

## Layer replacement and credential metadata

A provider's `allowed_operations` list and `operation_limits` map each replace
their complete prior-layer value. When narrowing allowed operations, supply a
replacement limits map containing only allowed operations. An explicit
`operation_limits: {}` clears inherited limits; disable the provider when clearing
its required declarations. Omitting the map inherits it. Replacing a map also
replaces its individual limit records: earlier ceilings are not unioned with
later declarations.

Operation IDs such as `brave.image_search` remain literal map keys. Query the
whole `services.hcp.search.providers.brave.operation_limits` path with `get`,
`resolutionTrace` or `sources`, then index its value by the operation ID.
Provenance is recorded for the whole map, not dotted operation subpaths.

Every supported credential-reference field excludes the `Exa KB PAT` item name
after case and whitespace normalization, regardless of provider. Vault and field
names remain operator-selected metadata; no secret lookup occurs.

The canonical cross-loader contract and config data model live in the Agent OS
superproject (`projects/cfg/LOADER-CONTRACT.md` and its config-owner domain docs),
alongside `projects/search-provider-entitlements/SPEC.md`. The companion schema
change must document this strict exception, deploy order, whole-map replacement
and credential exclusion there and exercise the same fixtures. Those owner docs
are not vendored here; Node tests alone do not attest Python/shell parity.

Offline regression: `node test/run-tests.mjs config-search.test.mjs`.
