# Adversarial Review Dependencies

This service is portable when every required dependency below resolves by rule.
Prefer explicit override env vars in supervisor env files; otherwise the runtime
uses PATH and per-user defaults.

## Node And NPM

- Dependency: Node.js `>=20 <26`; pinned in `package.json` as `engines.node`.
- Discovery: `node` and `npm` on `PATH`.
- Override: supervisor `PATH`.
- Install: `npm ci`.
- Native ABI gate: `better-sqlite3` must be rebuilt after Node major/minor ABI
  moves, Homebrew Node upgrades, or fnm/asdf version switches.
- Rebuild: `npm rebuild better-sqlite3`.
- Probe: `node -e "new (require('better-sqlite3'))(':memory:').close()"`.

## CLIs

- `claude` CLI
  - Discovery: `CLAUDE_CLI_PATH`, `CLAUDE_CLI`, then `claude` on `PATH`.
  - OAuth state: Claude Code stores login state in the user account/keychain
    used by the CLI. Run `claude auth login` as the same OS user that owns the
    daemon.
  - Runtime policy: OAuth only; API-key/provider fallback vars are stripped.

- `codex` CLI
  - Discovery: `CODEX_CLI_PATH`, `CODEX_CLI`, then `codex` on `PATH`.
  - CLI OAuth state: `CODEX_AUTH_PATH`, else `$CODEX_HOME/auth.json`, else
    `$HOME/.codex/auth.json`. The file must be `auth_mode: "chatgpt"` and
    contain OAuth access and refresh tokens.
  - MCP OAuth state: Codex also has per-MCP-server rmcp OAuth. A failure like
    `TokenRefreshFailed ... rmcp::transport::worker` is not the CLI auth file;
    refresh that layer with `codex mcp login <name>` for the failing server.

- `gh` CLI
  - Discovery: `GH_CLI_PATH`, `GH_CLI`, then `gh` on `PATH`.
  - Token discovery: `GITHUB_TOKEN`, else `gh auth token`.

- `op` CLI, optional
  - Discovery: `OP_CLI_PATH`, `OP_CLI`, then `op` on `PATH`.
  - Used by `src/secret-source/op.mjs` for 1Password-backed secret injection.

- `acpx` CLI, optional
  - Discovery: `ACPX_CLI_PATH`, `ACPX_CLI`, then `acpx` on `PATH`.
  - Maintainer-local fallback `$HOME/.openclaw/tools/acpx/node_modules/.bin/acpx`
    is used by some maintainer-local wrappers but is not part of the
    portable installer's render path.

- `hq` CLI, optional Agent OS reviewer-runtime substrate
  - Discovery: `HQ_BIN`, then `hq` on `PATH`.
  - Runtime: only used by the `agent-os-hq` reviewer runtime adapter.
  - Requires `HQ_ROOT` to point at an initialized Agent OS HQ root whose
    `.hq/config.json.ownerUser` matches the watcher OS user, plus
    `HQ_PARENT_SESSION` and `HQ_PROJECT` for dispatch attribution. The
    adapter refuses cross-user dispatch instead of invoking `sudo -u`.
  - Dispatch shape: `hq dispatch --ticket <ref> --worker-class <codex|claude-code>
    --prompt <file> --completion-shape artifact --parent-session <session-ref>
    --project <project> --token-budget <tokens>`.
    The adapter also passes `--task-kind analysis` so reviewer runs use the
    artifact/scratch-dir path rather than opening worker PRs.

## GitHub And Service Tokens

- `GITHUB_TOKEN`
  - Required for watcher/reviewer GitHub API work.
  - Discovery: environment variable, then `gh auth token`.

- `GH_CLAUDE_REVIEWER_TOKEN`
  - Required for comments posted as the Claude reviewer identity.
  - Discovery: environment variable or secret-source injection.

- `GH_CODEX_REVIEWER_TOKEN`
  - Required for comments posted as the Codex reviewer identity.
  - Discovery: environment variable or secret-source injection.

- `LINEAR_API_KEY`, optional
  - Enables Linear issue updates.
  - Discovery: environment variable or secret-source injection. If absent,
    Linear updates are skipped.

- Telegram/OpenClaw alerts, optional
  - Relevant env vars: `ALERT_TO`, `ALERT_CHANNEL`, `ALERT_AGENT_ID`,
    `ALERT_NAME`, `OPENCLAW_AGENT_HOOKS_URL`, `OPENCLAW_HOOKS_TOKEN_FILE`,
    `HOOKS_TOKEN_FILE`, `GATEWAY_DELIVERY_TOKEN`, `OPENCLAW_GATEWAY_TOKEN`,
    `OPENCLAW_HOOKS_TOKEN`, `HOOKS_TOKEN`.
  - Secret root discovery: `ADV_SECRETS_ROOT`, then `LITELLM_SECRETS_ROOT`,
    then `$HOME/.config/adversarial-review/secrets`. Each root is only used if
    its `litellm-alert-bridge.token` file exists. If the new default token file
    is absent, the watcher still probes the legacy
    `/Users/airlock/agent-os/agents/clio/credentials/local` token location for
    compatibility with deployments that have not migrated their alert secrets.

## Secret Sources

- Default source: `src/secret-source/env.mjs`, reading process env.
- 1Password source: `src/secret-source/op.mjs`, using `op read` or `op run`.
- Dotenv source: `src/secret-source/dotenv.mjs`, reading a gitignored `.env`.
- All injection paths scrub OAuth fallback env vars before reviewer/worker
  spawn.

### `OP_SERVICE_ACCOUNT_TOKEN` resolution

The 1Password service-account token is resolved by
`src/secret-source/op.mjs::resolveOpToken()` (exposed to shell wrappers as
`src/secret-source/resolve-op-token-cli.mjs`) using the following
**declared precedence** (first match wins):

| # | Source | Notes |
|---|---|---|
| 1 | `OP_SERVICE_ACCOUNT_TOKEN` in process env | Used directly, no file IO. |
| 2 | `ADV_OP_TOKEN_FILE` | Path to a file containing the token. File content is trimmed. |
| 3 | `ADV_OP_TOKEN_ENV_FILE` | Path to a shell-style env file. The parser accepts `OP_SERVICE_ACCOUNT_TOKEN=...` and `export OP_SERVICE_ACCOUNT_TOKEN=...`. |
| 4 | Legacy compatibility env file | Checks `$AGENT_OS_ROOT/agents/clio/credentials/local/op-service-account.env` first when `AGENT_OS_ROOT` is set, then `$HOME/agent-os/agents/clio/credentials/local/op-service-account.env`. |
| 5 | `$ADV_SECRETS_ROOT/op-service-account.token` | Used when `ADV_SECRETS_ROOT` is set. |
| 6 | `$HOME/.config/adversarial-review/secrets/op-service-account.token` | Default token-file path. |

If every source above fails, the resolver emits a **single detailed
diagnostic** listing every source it checked, why each failed, and concrete
remediation for the most-recommended source, then exits with code `78`
(`EX_CONFIG`). The wrapper scripts sleep 3600 seconds before exit so
launchd `KeepAlive=true` + `ThrottleInterval=30` does not produce a respawn
storm — the same fail-once shape used by the `better-sqlite3` ABI gate.

`resolve-op-token-cli.mjs` prints the resolved token to stdout (exit 0)
or the diagnostic to stderr (exit 78). Wrappers shape:

```sh
OP_SERVICE_ACCOUNT_TOKEN=$(node "$REPO_ROOT/src/secret-source/resolve-op-token-cli.mjs") || {
  echo "[wrapper] sleeping 3600s to suppress launchd respawn storm" >&2
  sleep 3600
  exit 78
}
export OP_SERVICE_ACCOUNT_TOKEN
```

OAuth-only strip list:

- `ANTHROPIC_API_KEY`
- `ANTHROPIC_BASE_URL`
- `OPENAI_API_KEY`
- `GOOGLE_API_KEY`
- `GEMINI_API_KEY`
- `CLAUDE_CODE_USE_BEDROCK`
- `CLAUDE_CODE_USE_VERTEX`
- `AWS_BEARER_TOKEN_BEDROCK`

`ANTHROPIC_AUTH_TOKEN` is preserved because it may be the OAuth bearer the
Claude runtime is supposed to use.

## Runtime Paths

- `ADV_REPLIES_ROOT`
  - Local remediation replies root.
  - Default: `<repo>/data/replies`.

- `HQ_ROOT`
  - Agent OS HQ integration root.
  - Used only when `--with-hq-integration` sets `ADV_WITH_HQ_INTEGRATION=1`
    or when `HQ_ROOT` is explicitly present in the environment.
  - Without HQ integration, remediation replies remain local under
    `data/replies/`.
  - Required for `reviewerRuntime: "agent-os-hq"`. If absent, that runtime
    fails loudly with guidance to set `HQ_ROOT` or use `cli-direct`/`acpx`.

- `HQ_PARENT_SESSION`
  - Agent OS HQ dispatch attribution parent session.
  - Required for `reviewerRuntime: "agent-os-hq"`. If absent, that runtime
    fails loudly with guidance to export `HQ_PARENT_SESSION` before invoking
    the reviewer.

- `HQ_PROJECT`
  - Agent OS HQ dispatch attribution project name.
  - Required for `reviewerRuntime: "agent-os-hq"`. If absent, that runtime
    fails loudly with guidance to register/export `HQ_PROJECT` before
    invoking the reviewer.

- `CODEX_SOURCE_HOME`
  - Optional watcher override for the Codex OAuth source dir used when spawning
    first-pass Codex reviewers.
  - Default: `$HOME/.codex`.

- `CODEX_AUTH_PATH`, `CODEX_HOME`, `HOME`
  - Define the Codex OAuth file and owner home contract for spawned Codex
    reviewer/remediation workers.

## Supervisor Contracts

Portable macOS install path (the supported on-ramp for outside operators):

- Installer: `tools/adversarial-review/install.sh`
- Runbook: `tools/adversarial-review/DEPLOYMENT-FROM-FRESH-MAC.md`
- LaunchAgent plist templates:
  - `tools/adversarial-review/deploy/launchd/adversarial-watcher.plist.template`
  - `tools/adversarial-review/deploy/launchd/adversarial-follow-up.plist.template`
- Wrapper script templates rendered alongside the plists:
  - `tools/adversarial-review/deploy/launchd/adversarial-watcher-start.sh.template`
  - `tools/adversarial-review/deploy/launchd/adversarial-follow-up-tick.sh.template`
- Render helper used by the installer and tests:
  `tools/adversarial-review/lib/render-template.mjs`

The installer accepts `REPO_ROOT`, `OPERATOR_HOME`, `SECRETS_ROOT`,
`LOG_ROOT`, `REVIEWER_AUTH_ROOT`, and `WATCHER_USER_LABEL` as either
environment variables or interactive prompts, substitutes them into the
templates, writes the rendered plists into `~/Library/LaunchAgents/`
and the rendered wrappers into `<repo>/scripts/render/`, then runs a
postflight validator (Node engines range, `gh auth status`, working tree
clean, secret-source token discovery, optional reviewer-auth readability).
`--dry-run` renders to a temp directory and skips postflight.

Legacy Linux systemd template (single-file, env-file driven):

- `tools/adversarial-review/deploy/systemd/adversarial-review.service.template`

Bounce helper for operator restarts:

- `tools/adversarial-review/bounce.sh`

`bounce.sh` stops the supervisor, waits for recorded reviewer process
groups to drain, then starts the supervisor again. If the drain times
out, the helper still restarts the supervisor, exits non-zero, and
removes `data/watcher-drain.json` on exit so a manual recovery does
not leave the watcher idling behind a stale drain marker.
