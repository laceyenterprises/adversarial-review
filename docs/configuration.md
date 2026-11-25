# Configuration and schema

ONS-07: the Node config reader validates against the CFG JSON Schema that
agent-os generates from the Python `schema_v1`. The loader reads
`platform/contracts/generated/config.schema.json` in the selected checkout.
It checks `AGENT_OS_ROOT` and `AGENT_OS_DEPLOY_CHECKOUT` first, then the
vendored module layout. When no checkout is found or its contract cannot be
read or compiled, the loader uses
[`src/generated/config.schema.json`](../src/generated/config.schema.json). It
reports the selected schema's source and SHA-256 digest to stderr and
deduplicates repeated messages. Fallback messages include the reason. Cached
loads watch the contract alongside the config layers.

[`test/config-cfg-parity.test.mjs`](../test/config-cfg-parity.test.mjs) replays
Python-recorded verdicts. `loadConfig` refuses an unknown key in a checked-in
file. Local overlays and runtime/cached loaders tolerate unknown keys outside
strict-always policies (`ADVERSARIAL_CONFIG_DEBUG=1` prints a note for runtime
unknowns). An empty env value is absent.
Nullable projections also support a numeric zero sentinel alongside a positive
floor. Informational metadata on a null branch is accepted; assertion keywords
outside the supported projection cause the loader to use the bundled schema.
Recorder fixture fields `env`, `modules`, and `get` may be omitted or null.
Leaf-pattern compilation is cached without modifying the exported schema, and
rejection diagnostics display the normalized value being checked.

To refresh the standalone schema or the environment aliases, run
`node scripts/sync-cfg-schema.mjs <agent-os>`
(`--check` reports drift); it vendors both generated files, the schema
(`src/generated/config.schema.json`) and the env alias table
(`src/generated/config.env.json`). Nothing else is hand-written: the reader has no
Node-only keys, enum members or env names, and a key or alias this service needs
is added to CFG in agent-os first. This replaces CFGREADERSCOPE-01's
read-surface mirror ([SEV2 report](postmortems/SEV2-every-new-config-key-forced-workers-to-provision-the-review-service-repo-2026-10-31.md)).
The exported `ENV_ALIASES` table and the table returned by
`AgentOSConfig.envAliasTable()` are read-only: the registry, rows, alias arrays
and alias tuples are frozen so cached readers can safely index them once.

AFA-07 mirrors disabled-by-default `cloud_access.aws.enabled`, the fixed
`us-east-2` region and private project/budget/activation-receipt inputs in the
same strict schema. Identifiers and file paths have no defaults. This is
parse-only, with no cloud consumer, operation, state or smoke change.
Deploy this reader before the Agent OS companion uses its host-overlay keys;
`test/cloud-access-config.test.mjs` covers defaults, overlay and refusals.

ZFA-01 adds parse-only strict `cloud_access.azure` foundation inputs, now
read from the generated CFG schema (ONS-07).
Both enablement flags default false; the region is `eastus2`; private identity,
certificate-path and budget choices have no defaults. No cloud operation or
reviewer consumer is added. `test/cloud-access-config.test.mjs` covers host
overlay parsing and refusals. Deploy this reader before the Agent OS companion's
host-overlay keys are used. `cloud_access.azure.infrastructure.budget_start_date`
is a string; the Node reader preserves quoted and unquoted YAML ISO timestamps
such as `2026-10-01T00:00:00Z` as strings. Existing lifecycle/smoke promises are
unchanged.

GTMGAWIRE-01 adds the strict `services.hcp.google_tokens.profiles` metadata
schema, matching Agent OS's Python and shell readers. It accepts purpose-named
profiles, a 1Password Document reference, the `lacey-web` identity and six
approved scopes, plus read-class and exact-LRQ task grants. It grants no access
and performs no credential reads. Deploy this reader before the Agent OS
companion adds the tracked profile; existing lifecycle and smoke promises
are unchanged. `test/config-google-tokens.test.mjs` exercises the offline shape. Vault
identifiers in `op-document://<vault>/<item>` must be UUIDs or whitespace-free
names/slugs, matching the Python credential parser; vault titles with spaces are
not supported. Item titles may contain spaces. Queries, fragments, percent
escapes and extra path components are refused. Worker classes in both read and
task grants must be non-empty identifiers using letters, digits, underscores or
hyphens; display labels and whitespace are not worker-class identities.
This metadata mirror permits partial profile declarations, including enable-only
overrides; `enabled: true` is not proof of a complete minting configuration. The
host Google token service owns `validate_profile` and checks required identity
fields before authorization or credential I/O. Node consumers must retain that
boundary rather than treat schema acceptance as token eligibility. Omitted task
grant scopes materialize `[]`, an empty grant with no ambient permission.
