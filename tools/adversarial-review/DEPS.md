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
    is only selected by install tooling with `--prefer-local-acpx`.

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
    then `$HOME/.config/adversarial-review/secrets`.

## Secret Sources

- Default source: `src/secret-source/env.mjs`, reading process env.
- 1Password source: `src/secret-source/op.mjs`, using `op read` or `op run`.
- Dotenv source: `src/secret-source/dotenv.mjs`, reading a gitignored `.env`.
- All injection paths scrub OAuth fallback env vars before reviewer/worker
  spawn.

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

- `CODEX_SOURCE_HOME`
  - Optional watcher override for the Codex OAuth source dir used when spawning
    first-pass Codex reviewers.
  - Default: `$HOME/.codex`.

- `CODEX_AUTH_PATH`, `CODEX_HOME`, `HOME`
  - Define the Codex OAuth file and owner home contract for spawned Codex
    reviewer/remediation workers.

## Supervisor Contracts

- macOS launchd template:
  `tools/adversarial-review/deploy/launchd/ai.laceyenterprises.adversarial-review.plist.template`
- Linux systemd template:
  `tools/adversarial-review/deploy/systemd/adversarial-review.service.template`
- Generated env file:
  `tools/adversarial-review/adversarial-review.env`
- Bounce helper:
  `tools/adversarial-review/bounce.sh`

Use `bounce.sh` for operator restarts. It stops the supervisor, waits for
recorded reviewer process groups to drain, then starts the supervisor again.
