# GRK-09

The Node CFG reader mirrors the Agent OS `grok` root (`src/config-grok.mjs`,
wired into `src/config-loader.mjs`): `grok.enabled`, `grok.model` (default
`grok-build`), nullable `grok.cli_path` (null = the managed pinned executable),
bounded `first_output_timeout_seconds` (60, 10–900) and `stall_timeout_seconds`
(300, 30–3300), and `grok.{reviewer,remediator,hammer,native_resume}.enabled`.
Every enable flag defaults false. Each key has one canonical `AGENT_OS_GROK_*`
env name.

The role enums recognize `roles.reviewer: grok`, `roles.remediator:
remediator-grok` and `roles.merge_agent_worker_class: hammer-grok`, but a pin
naming a Grok lane is refused at load unless `grok.enabled` and that lane's
flag are both true. The refusal names only the pinned key and the flag to set.
`roles.remediator_fallback` is unchanged, so existing configs load.

Parse-only (CFGREADERSCOPE-01): nothing here selects, dispatches or runs a Grok
lane, and the closure path is untouched. Unknown keys keep the existing
tolerance. `test/fixtures/grok-config-parity.v1.json` is an identical copy of
the Agent OS parity contract; all values are synthetic.
