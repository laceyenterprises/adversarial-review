# LOADER-CONTRACT.md - Cross-language config loader behavior spec

This repository carries the Node.js adversarial-review implementation of the
Agent OS CFG loader. The full Agent OS CFG contract lives at this same path in
the parent Agent OS repository; this local mirror records the Node-facing
behavior that must stay aligned with the Python and shell loaders.

## Strict schema

The v1 schema is strict by default. Unknown keys fail validation at startup,
including nested keys under an otherwise-known section. Type and enum violations
also fail loud with the offending dotted key, expected shape, rejected value, and
source location when available.

Direct validator calls are strict unless the caller explicitly opts into a
documented compatibility mode. A source filename ending in `.local.yaml` or
`.local.yml` is not enough to enable tolerance by itself.

## Local sibling tolerance

Layer 4 is the only automatic local override layer. The loader identifies it by
deriving gitignored siblings from already-selected Layer 2 and Layer 3 sources:

- top-level `config.yaml` -> top-level `config.local.yaml`
- module `<module>/config.yaml` -> module `<module>/config.local.yaml`

Only files discovered through that sibling path may automatically tolerate
nested unknown keys. When enabled, a nested unknown key under a schema root this
reader owns is dropped from the validated output instead of crashing the daemon.
Unknown top-level keys still fail unless they are covered by the separate
foreign-reader top-level exception below.

This tolerance applies to both top-level local siblings and module local
siblings, but only while they are loaded as Layer 4. A caller that points
`topPath` directly at `config.local.yaml`, passes `mod.local.yaml` directly as a
module path, or calls `validateSchema(..., { source: "/tmp/config.local.yaml" })`
gets strict validation unless it deliberately passes the explicit
`tolerateNestedUnknownLocalKeys` validator option.

The compatibility mode exists for rolling cross-language schema deployments:
operator-edited local override files may contain a newly-added nested key before
every daemon's loader has been upgraded. Dropping that unknown nested key makes
the old reader behave as though the future key were unset; it must not expose
the unknown key as a resolved value.

## Foreign top-level local sections

Top-level `config.local.yaml` is shared by multiple CFG readers. A loader may
ignore only root sections it explicitly allowlists as foreign to that reader
because those sections are owned by another reader sharing the same local file.

This exception does not apply to checked-in `config.yaml`, checked-in module
files, direct standalone validator calls, module-local direct loads,
unallowlisted root keys, or nested keys.

## `worker_pool` partial Node mirror

The adversarial-review Node loader treats `worker_pool` as a known partial
schema root, not as a foreign top-level local section. Python remains canonical
for the worker-pool schema, but the Node loader mirrors
`worker_pool.dag.autowalk.deep_reconcile` so the shared checked-in
`config.yaml` can carry that cross-reader knob without crash-looping the
adversarial-review watcher.

Checked-in `config.yaml` accepts only the mirrored
`worker_pool.dag.autowalk.deep_reconcile` subtree. Any other checked-in
`worker_pool.*` key is an unknown nested key under a known strict root and must
fail loud.

Layer-4 `config.local.yaml` siblings may drop other nested `worker_pool.*` keys
only when nested-local tolerance is enabled by the local-sibling layer or by an
explicit `tolerateNestedUnknownLocalKeys` validator option. Those tolerated
unknown nested keys are omitted from resolved values and provenance. The
mirrored `worker_pool.dag.autowalk.deep_reconcile` key is validated and exposed
normally when present.

Direct `validateSchema` callers do not get this local tolerance from the
filename alone. A direct call with `source: "/tmp/config.local.yaml"` remains
strict unless it explicitly opts into `tolerateNestedUnknownLocalKeys`; enabling
foreign top-level tolerance does not make `worker_pool` foreign again.

## `main_catchup` Node mirror

The adversarial-review Node loader treats `main_catchup` as a known schema root,
not as a foreign top-level local section. Python remains canonical for the
main-catchup daemon schema, but the Node loader mirrors the checked-in daemon
control surface that appears in the shared `config.yaml`:

- `main_catchup.poll_interval_seconds` (default `300`)
- `main_catchup.drain_timeout` (default `5m`)
- `main_catchup.stale_drain_reap_seconds` (default `600`)
- `main_catchup.submodule_update_timeout_seconds` (default `120`)
- `main_catchup.recovery_max_attempts` (default `5`, range `1..50`)
- `main_catchup.bounce_throttle_interval_seconds` (default `300`)
- `main_catchup.adversarial_review_drain_timeout_seconds` (default `180`,
  matching Python's 3-minute adversarial-review drain timeout)
- `main_catchup.adversarial_watcher_drain_bounce_slack_seconds` (default `120`,
  matching Python's 2-minute watcher bounce slack)

Checked-in `config.yaml` accepts only those mirrored `main_catchup` keys. Any
other checked-in `main_catchup.*` key is an unknown nested key under a known
strict root and must fail loud.

Layer-4 `config.local.yaml` siblings may drop other nested `main_catchup.*`
keys only when nested-local tolerance is enabled by the local-sibling layer or
by an explicit `tolerateNestedUnknownLocalKeys` validator option. Those
tolerated unknown nested keys are omitted from resolved values and provenance.
The mirrored daemon keys are validated and exposed normally when present.

Direct `validateSchema` callers do not get this local tolerance from the
filename alone. A direct call with `source: "/tmp/config.local.yaml"` remains
strict unless it explicitly opts into `tolerateNestedUnknownLocalKeys`; enabling
foreign top-level tolerance does not make `main_catchup` foreign.

## `op` Node mirror

The adversarial-review Node loader treats `op` as a known schema root, not as a
foreign top-level local section. Python remains canonical for the global
1Password schema, but the Node loader mirrors `op.vault` so shared checked-in
`config.yaml` files can carry the vault used in `op://<vault>/...` references
without crash-looping the adversarial-review watcher.

Checked-in `config.yaml` accepts only `op.vault`, which defaults to
`Cliovault`. Any other checked-in `op.*` key is an unknown nested key under a
known strict root and must fail loud.

Layer-4 `config.local.yaml` siblings may drop other nested `op.*` keys only
when nested-local tolerance is enabled by the local-sibling layer or by an
explicit `tolerateNestedUnknownLocalKeys` validator option. Those tolerated
unknown nested keys are omitted from resolved values and provenance. The
mirrored `op.vault` key is validated and exposed normally when present.

Direct `validateSchema` callers do not get this local tolerance from the
filename alone. A direct call with `source: "/tmp/config.local.yaml"` remains
strict unless it explicitly opts into `tolerateNestedUnknownLocalKeys`; enabling
foreign top-level tolerance does not make `op` foreign.

## Env-materialized app entries

`apps` is a keyed map. The key after `apps.` is an app id, not dotted path
syntax; quoted YAML ids such as `"foo.bar"` and `"foo.__proto__"` must remain a
single app id when loaders validate, default, and expose the resolved map.

Environment variables in the `AGENT_OS_APPS_<id>_<leaf>` family may materialize
an app entry even when no file layer declared that app id. The supported leaf
suffixes are `MODE`, `SUBSCRIBES`, and `CONTRACT_VERSION`; the app id segment is
lowercased and `_` is normalized to `-` before it is inserted under `apps`.

An env-materialized app entry receives the same schema defaults as a YAML
entry. For example, `AGENT_OS_APPS_FOO_MODE=standalone` resolves
`apps.foo` with `mode: standalone`, `subscribes: []`, and
`contract_version: "1.0"`. Defaults that are backfilled only because the app was
materialized by env expose provenance source
`code-default (env-registered app)`; file-declared app default provenance remains
`code-default`, even when env aliases later override or fill sibling leaves on
that file-declared app entry.

Loaders must not re-parse keyed-map ids as dotted paths while applying these
defaults. They must mutate the already-resolved map entry, or use path helpers
that treat the app id as one segment, and path helpers must not traverse
prototype-bearing segments such as `__proto__`, `prototype`, or `constructor`.

## Conformance expectations

Python, Node, and shell CFG loaders must agree on this surface:

- checked-in config files reject unknown keys at every strict section
- checked-in `worker_pool` accepts only
  `worker_pool.dag.autowalk.deep_reconcile`; all other checked-in
  `worker_pool.*` keys fail as nested unknown keys
- checked-in `main_catchup` accepts only the mirrored daemon keys; all other
  checked-in `main_catchup.*` keys fail as nested unknown keys
- checked-in `op` accepts only `op.vault`; all other checked-in `op.*` keys
  fail as nested unknown keys
- direct validator calls remain strict even when `source` names a `.local.yaml`
  file
- Layer-4 local siblings may drop nested unknown keys under owned roots
- Layer-4 local siblings may drop non-mirrored nested `worker_pool.*` keys only
  through nested-local tolerance, while preserving the mirrored
  `worker_pool.dag.autowalk.deep_reconcile` value
- Layer-4 local siblings may drop non-mirrored nested `main_catchup.*` keys only
  through nested-local tolerance, while preserving the mirrored daemon keys
- Layer-4 local siblings may drop non-mirrored nested `op.*` keys only through
  nested-local tolerance, while preserving the mirrored `op.vault` value
- Layer-4 local siblings still reject arbitrary unknown top-level typo roots
- tolerated unknown keys are omitted from resolved values and provenance
- env-materialized `apps.<id>` entries receive the same schema defaults as
  file-declared app entries, with env-registered default provenance as described
  above
- keyed-map ids are not split on dots or allowed to traverse object prototypes
  during default backfill

Any loader that infers nested-key tolerance from filename alone is out of
contract; the tolerance must be scoped to the actual local-sibling layer or an
explicit validator option used by a caller that is deliberately reproducing that
layer.

## Role enums

`roles.remediator` is a shared CFG role pin. All CFG loaders must accept the
same values for this key:

- `adversarial` - default sentinel; select the remediation worker from the
  reviewed PR's builder tag
- `claude-code`
- `codex`
- `gemini`

The canonical environment override is `AGENT_OS_ROLES_REMEDIATOR`. The
adversarial-review legacy alias is `ADVERSARIAL_REVIEW_DEFAULT_REMEDIATOR`.
When both environment names are set to different values, startup must fail loud
with both env names in the diagnostic; when both are set to the same value, the
canonical env source wins provenance.
