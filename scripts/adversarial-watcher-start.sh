#!/bin/zsh
# adversarial-watcher-start.sh
# Canonical LaunchAgent wrapper for the adversarial review watcher.
# Resolves secrets from 1Password (op run) and gh keychain, then starts node.
#
# Auth policy:
# - Reviewer CLIs must use OAuth credentials only.
# - ANTHROPIC_API_KEY and OPENAI_API_KEY are explicitly unset before exec.
# - If OAuth is unavailable, reviewer.mjs should fail loudly rather than billing via API keys.

set -euo pipefail

# Load 1Password service account token (not present in LaunchAgent env by default)
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

# Launch watcher via op run to inject remaining secrets from 1Password
exec /opt/homebrew/bin/op run \
  --env-file=/Users/airlock/agent-os/agents/clio/config/openclaw/op.env \
  -- \
  /bin/zsh -c 'unset ANTHROPIC_API_KEY OPENAI_API_KEY && exec /opt/homebrew/bin/node /Users/airlock/agent-os/tools/adversarial-review/src/watcher.mjs'
