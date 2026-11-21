# ONS-07 — Generated Node config reader (first slice)

Spec: `one-schema@6ab5e7ac02db` (agent-os `projects/one-schema/SPEC.md`, ONS-07).

## Summary

The Node config reader no longer carries a hand-written mirror of the CFG
schema. `src/config-schema.mjs` builds the loader's schema from the CFG JSON
Schema that agent-os generates from the Python `schema_v1` (ONS-02), vendored
as `src/generated/config.schema.json`. The 3,550-line `schemaV1()` literal, the
packaged MES, OSG and Python-module mirrors and four schema helper modules are
deleted. Leaf checks, unknown-key handling, defaults and the empty-env rule now
follow `agent_os_config.validation` and `loaders.py`, so the two readers accept
and reject the same documents.

What stays hand-written is listed in `src/config-node-keys.mjs`:

- 32 Node-only keys this service reads that CFG does not declare (reviewer
  timeouts, watcher pool knobs, some merge-authority knobs, `remediation`,
  `roles.registry`, `roles.routing`). Unread Node-only keys were deleted.
- 3 Node-only enum members (`gemini` remediator, `hammer-claude` merge worker,
  the `codex-corp` fallback alias).
- Repairs for annotations the ONS-02 projection drops: `__strict_always`, and
  the typed extra keys of search operation limits and public-hygiene identities.

The builder throws at import if CFG starts declaring any of them, so moving a
key into CFG forces its deletion here.

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
  `osgArmFields`, `CFG_JSON_SCHEMA`), `src/config-node-keys.mjs`,
  `scripts/sync-cfg-schema.mjs <agent-os> [--check]`,
  `scripts/record-cfg-parity-cases.py`.
- Removed: `src/config-module-schema.mjs`, `src/config-google-tokens.mjs`,
  `src/cloud-access-config-schema.mjs`, `grokSchema()` and the grok bound
  constants in `src/config-grok.mjs`, and the `*-schema.v1.json` mirrors.
- After a CFG schema change, run `node scripts/sync-cfg-schema.mjs <agent-os>`
  and commit `src/generated/config.schema.json`.

## Remaining for the final ONS-07 PR

- The env alias table (about 1,000 lines) is still hand-written. Generating it
  needs the ONS-02 generator to emit CFG's env aliases.
- The cascade engine is about 2,100 lines. The target is under 800.
- The Node-only keys and enum members need to move into CFG `schema_v1`, with
  `config.yaml` and shell parity. That is agent-os work for ONS-14 or an
  ONS-17+ ticket. The projection repairs belong in the ONS-02 generator.

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
