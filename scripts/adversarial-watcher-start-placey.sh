#!/bin/zsh
# adversarial-watcher-start-placey.sh
# LaunchAgent wrapper for running the adversarial review watcher as the placey user.
# This keeps Codex, HOME, OAuth, and runtime state aligned under one principal.

set -euo pipefail

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export HOME="/Users/placey"
export CODEX_AUTH_PATH="/Users/placey/.codex/auth.json"

# Load 1Password service account token
source /Users/airlock/agent-os/agents/clio/credentials/local/op-service-account.env
export OP_SERVICE_ACCOUNT_TOKEN="${OP_SERVICE_ACCOUNT_TOKEN:-}"
if [[ -z "${OP_SERVICE_ACCOUNT_TOKEN:-}" ]]; then
  echo "[adversarial-watcher] ERROR: OP_SERVICE_ACCOUNT_TOKEN not loaded" >&2
  exit 1
fi

# Resolve GitHub token from gh CLI keychain
export GITHUB_TOKEN=$(/opt/homebrew/bin/gh auth token 2>/dev/null)
if [[ -z "${GITHUB_TOKEN:-}" ]]; then
  echo "[adversarial-watcher] ERROR: could not resolve GITHUB_TOKEN from gh keychain" >&2
  exit 1
fi

# Scrub direct-provider API keys — reviewers must use OAuth only
unset ANTHROPIC_API_KEY
unset OPENAI_API_KEY

exec /opt/homebrew/bin/op run \
  --env-file=/Users/airlock/agent-os/agents/clio/config/openclaw/op.env \
  -- \
  /bin/zsh -c 'unset ANTHROPIC_API_KEY OPENAI_API_KEY && cd /Users/airlock/agent-os/tools/adversarial-review && exec /opt/homebrew/bin/node /Users/airlock/agent-os/tools/adversarial-review/src/watcher.mjs'
