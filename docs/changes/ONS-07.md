# ONS-07 — Generated Node config reader (first slice)

Spec: `one-schema@42801d619b37` (agent-os `projects/one-schema/SPEC.md`, ONS-07).

## Summary

The Node config reader no longer carries a hand-written mirror of the CFG
schema. `src/config-schema.mjs` builds the loader's schema from the CFG JSON
Schema that agent-os generates from the Python `schema_v1` (ONS-02), vendored
as `src/generated/config.schema.json`. The 3,550-line `schemaV1()` literal, the
packaged MES, OSG and Python-module mirrors and four schema helper modules are
deleted. Leaf checks, unknown-key handling, defaults and the empty-env rule now
follow `agent_os_config.validation` and `loaders.py`, so the two readers accept
and reject the same documents.

Nothing is hand-written any more. The Node-only keys, enum members and projection
repairs that earlier slices kept in `src/config-node-keys.mjs` now live in CFG
(agent-os `schema_v1`) and the generator, so that file is deleted and the Node-only
inventory is 0. The env alias table is generated the same way (below).

## Behaviour changes

- `loadConfig` refuses an unknown key in a checked-in file (it used to drop
  it). Local overlays and the runtime and cached loaders used by the daemons
  still drop unknown keys, so a lagging pin cannot crash-loop a daemon.
- `__`-prefixed metadata keys are skipped, and children of an open CFG section
  that has no typed extra schema are dropped, both as in Python.
- An empty env value is treated as absent (it used to coerce to `false`, `0` or
  `[]`). To turn off the remediator fallback, set `roles.remediator_fallback: []`
  in config instead of exporting an empty variable.
- Defaults, enums and bounds are CFG's. Python's advisory maxima are no longer
  enforced. Unset host values now default to CFG's OSS placeholders: for
  example `linear.issue_prefix` defaults to `EXA` and `github.org` to
  `example-org`. The reference-host profile overlay still pins the live
  values. The cap re-head path treats CFG's `plan` builder default as "no
  default" and keeps `codex`.
- Worker vault policies get Python's merged check (vault plus a full `op://`
  reference).

## Interface changes

- New: `src/config-schema.mjs` (`schemaV1`, `buildSchema`, `fromJsonSchema`,
  `osgArmFields`, `CFG_JSON_SCHEMA`), `src/config-env-aliases.mjs`,
  `scripts/sync-cfg-schema.mjs <agent-os> [--check]`,
  `scripts/record-cfg-parity-cases.py`. (`src/config-node-keys.mjs`, added by the
  first slice, is deleted by the final one.)
- Removed: `src/config-module-schema.mjs`, `src/config-google-tokens.mjs`,
  `src/cloud-access-config-schema.mjs`, `grokSchema()` and the grok bound
  constants in `src/config-grok.mjs`, and the `*-schema.v1.json` mirrors.
- After a CFG schema change, run `node scripts/sync-cfg-schema.mjs <agent-os>`
  and commit `src/generated/config.schema.json` and `src/generated/config.env.json`.

## Final slice: generated env aliases, empty Node-only inventory, split reader

Companion agent-os PR 11430 (ONS-07, the first half) carries the
CFG side: the generator emits `config.env.json` (CFG's env alias table, positional
and process-env rows marked), the 37 review-service leaves moved into `schema_v1`
with their code defaults, three enum members, the `__strict_always` annotation and
typed extra keys of search operation limits and public-hygiene identities.

- `src/config-env-aliases.mjs` builds `ENV_ALIASES` from the vendored
  `src/generated/config.env.json`. The 560-line hand-written `ENV_ROWS`, the
  entitlement and Grok alias loops and `grokEnvAliases()` are deleted. The table
  grows from 348 to 1,141 rows: every alias CFG declares is honored, including
  the Python-only legacy names. CFG gained 16 rows and one legacy name that only this reader honored,
  so no env name it honored is lost. The one loss: the six
  `AGENT_OS_ENTITLEMENTS_SENTINEL_TALK_*` rows, because `sentinel-talk` is not a CFG
  entitlement (an unseeded id has no Python alias either). Not applied here by
  design: `profile` (chosen before the cascade; blank means unset) and the
  positional `OAUTH_BROKER_URL` row (consumed from `process.env`).
- `src/config-node-keys.mjs` is deleted; `config-schema.mjs` no longer overlays
  anything and reads `x-cfg-strict-always` directly.
- `scripts/sync-cfg-schema.mjs` vendors both generated files (`--check` compares both).
- `src/config-loader.mjs` is a 44-line facade. The former 2,107-line module is
  split by responsibility into `config-base`, `-checks`, `-policies`, `-paths`,
  `-env-layer`, `-module-doc`, `-profile`, `-class`, `-cascade` (the cascade,
  324 lines) and `-cache`. This is a move, not a deletion: the pure move is
  reported separately in the PR body. Importers are unchanged.
- Behavior: one deliberate change. `roles.adversarial.merge_authority.hammer_lifetime_ceiling`
  no longer also reads `AGENT_OS_ROLES_ADVERSARIAL_MERGE_AUTHORITY_HAMMER_LIFETIME_DISPATCH_CEILING`,
  the canonical name of the different `hammer_lifetime_dispatch_ceiling` key (CFG
  refuses one env name shared by two keys). `loadConfig` costs about 1 ms more per
  call (5.4 to 6.4 ms) for the larger alias table.
- Tests: `test/config-cfg-parity.test.mjs` asserts the Node schema equals CFG with
  no Node-only path or enum member, the env table equals the vendored table (minus
  the two named rows), the intended unread-sibling difference (Python strict input
  refuses an ordinary unknown sibling; the Node runtime reader drops it and reports
  it; strict-always declarations refuse in both), and 13 new Python-recorded cases
  for the moved keys, legacy env names, enum members, the atomic identity map and
  typed search-limit and hygiene keys.

### Deferred checked-in `config.yaml` defaults (CFGREADERORDER-01)

No checked-in default is published by this ticket; every moved key keeps the code
default below, equal to what this reader always used. Owner: the One Schema pack
operator, in a follow-up source PR after the adversarial-review pin floats and the
installed reader is verified (this PR's merge is the required reader revision; the
agent-os schema PR is the required schema). No live activation happens here.

`review_cycle_cap` 5; `review_cycle_window_hours` 24; `remediation.max_concurrent_jobs` 1;
`remediation.max_concurrent_jobs_ceiling` 8; `remediation.git_identity_repo_overrides` {}
(atomic map); `adversarial.reviewer.load_aware.enabled` true, `.max_multiplier` 6.0;
`feature_flags.dismiss_stale_request_changes_on_resolved` true; `roles.registry` (no
default; typed entries), `roles.routing.never-review-own-builder-class` true;
`roles.adversarial.operator_logins` [], `.operator_label_actor_enforcement` observe;
`roles.adversarial.merge_authority.strict_non_blocking_remediation` true,
`.cap_rehead_enabled` true, `.cap_rehead_lifetime_cap` 2, `.hammer_lifetime_dispatch_ceiling`
null, `.dispatch_timeout_ms` 600000, `.closer_inconclusive_retry.surface_after_attempts` 3,
`.backoff_base_ms` 300000, `.backoff_max_ms` 3600000; `reviewer.quota_check_enabled` true,
`.quota_status_dir` null, `.timeout_ms` 1200000, `.first_output_timeout_ms` 0,
`.no_progress_timeout_ms` 900000, `.running_pass_timeout_seconds` 3600,
`.idle_timeout_seconds` 600, `.ceiling_base_seconds` 1800, `.ceiling_max_seconds` 10800;
`watcher.ama_closer_max_concurrent_launches` 3, `.max_drain_wait_ms` 3600000,
`.pending_draft_review_respawn_age_seconds` 900, `.stuck_dispatch_alert_debounce_ms` 21600000,
`.first_pass_reviewer_pool_max_concurrent_reviewers` null,
`.first_pass_review_queue_depth_failover_threshold` null,
`.rereview_queue_depth_failover_threshold` null, `.ama_hammer_dispatch_mode` inline.

## Final comment-only remediation

Search cross-field validation tolerates missing or non-object projections and
provider entries; the schema validator still rejects explicit null search and
provider declarations in checked-in files and local overlays with
`AgentOSConfigError`. Public-hygiene validation uses local collection defaults
without changing caller objects, including sealed and frozen policies.
Schema leaf lookup returns null for missing traversal nodes. Leaf flattening
uses declared property schemas before typed additional-property schemas, matching
schema lookup and path validation.

No public interface, persistent store, lifecycle or smoke promise changes.
Verification: 605 targeted tests passed with
`node --test test/config-paths.test.mjs test/config-search.test.mjs test/config-public-hygiene.test.mjs test/config-cfg-parity.test.mjs test/config-ons07-rescue.test.mjs test/config-loader.test.mjs`.
`npm run lint` passed with zero errors (147 existing warnings);
`npm run typecheck:contracts` and
`bash demo/research-finding-walkthrough.sh` passed. Commands ran through
`bin/run-bounded.sh` with a 60-second limit; the full suite remains PR-head CI's
merge gate.

## Verification

- `test/config-cfg-parity.test.mjs` replays 55 cases recorded from the Python
  loader. The cases cover cascade order (code, module, top, local, module-local
  and env), unknown keys per layer, leaf annotations, env coercion and merged
  checks. One more test asserts that every CFG key is in the Node schema and
  that every extra key is inventoried.
- The 79 config-touching test files gave 3,616 tests, 0 failed.
- The remaining 848 files ran in 120-file chunks with 0 failures, except
  `test/hamconflictsync-01.test.mjs`: 15 subprocess-timeout failures (exit
  status `null` after about 60 s). Run alone, that file hung for more than
  11 minutes on an untouched `origin/main` archive too.
- `npm run lint` (0 errors), `npm run typecheck:contracts` and
  `bash demo/research-finding-walkthrough.sh` all passed.

## Rescue review closeout

Unknown-key tolerance and its warning context propagate into list records and typed extra keys; strict readers and consumed strict policies continue to refuse unknown keys. Vault opt-ins are normalized for explicit null and type-checked before iteration. Default-policy diagnostics identify the actual default policy, even if a worker class happens to be named `fallback`. Required atomic declaration fields retain the Python CFG check: the generated required paths are version, array records and keyed security declarations. Sparse vault overlays already merge successfully; delaying those required checks would change the canonical CFG contract and weaken completeness checks.

Nullable JSON Schema branches are order independent. An undeclared required property raises an explicit unsupported-schema diagnostic rather than an accidental TypeError or silently dropping the requirement. Remediation concurrency must be at least one. Closure reads the configured builder once. Schema synchronization accepts `--check` in either argument order and rejects unknown switches; Python recording and Node replay both create nested fixture directories. Fallback tests always clean up their temporary directory.

The hosted Node 22 result on the original head timed out after 900 seconds with 392 files still queued and no assertion failure located. This is tracked by LAC-2182; that unchanged full-suite timeout is not rerun or waived as validation for this repair.


Final review closeout preserves compatibility exports, maps the failure-recovery
fallback environment alias to its canonical underscored key, and reports null
normalizer inputs and vault policy source paths consistently. Allow-zero schema
branches and parity traversal are order independent. The vendored schema is
readable JSON and includes the current canonical work-items, DAG closeout and
terminal teardown settings. Parity recording closes UTF-8 files explicitly.

The unbound integer-list environment case is named as an ignored override;
there is no declared integer-list environment alias in CFG. A separate recorded
YAML case verifies the active list contract. Search cross-field constants remain
used by validation. The audit-context test explicitly writes its local file
baseline. Schema loading remains eager and fail-fast: the public schema object
and compatibility enum exports are consumed during config-loader import.


Final hardening covers missing recorder arguments, nullable fixture collections,
normalized sync paths, cached leaf patterns without mutating frozen schema nodes,
post-normalization rejection diagnostics, and standalone vault trace defaults.
Nullable numeric projections may combine null, zero and a positive floor; only
informational null-branch metadata is ignored. Unknown assertion keywords still
fail closed. Timeout CPU-busy overrides corroborate excess runqueue load and do
not override the at-capacity fast path. The idle-overlay fixture already owns
cleanup through its shared per-test temporary-directory teardown.

### Current-main integration

Preserve the merged RDXREMIDENTITY-02 repository-specific remediation identity
contract through the inventoried Node-only `remediation` section, including its
identity-field validation and atomic keyed-map handling for dotted repository
names. This keeps the generated CFG reader and all earlier final-review fixes
while integrating current main; no old hand-written schema literal is restored.


### Final rescue integration — 2026-11-21

Integrates reviewed main through `fdf7d82eca6fcf1e161c25ebfe2ff1cd7d97a296`,
including LAC-2182 atomic review database bootstrap, without restoring the
retired hand-maintained configuration schema. The Node-owned remediation
repository identity overrides from main remain in the declared Node section.
Independent integrated validation passes 235 cases across configuration rescue,
Node/Python parity, review-state, repository identity and GitHub API lifecycle.
The required new-head Node22/26 runs remain the merge gate; no unchanged failed
run was retriggered and the 900-second deadline is unchanged.
