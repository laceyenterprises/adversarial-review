#!/bin/zsh
# adversarial-watcher-start.sh
# Canonical LaunchAgent wrapper for the adversarial review watcher.
# Resolves only the exact needed secrets from 1Password, then starts node directly.
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

# Force Codex CLI to use the shared OAuth auth file rather than airlock's default ~/.codex/auth.json
export CODEX_AUTH_PATH=/Users/placey/.codex/auth.json

# Resolve only the 1Password-backed secrets needed by watcher.mjs + reviewer.mjs.
export LINEAR_API_KEY=$(/opt/homebrew/bin/op read --cache=false 'op://mem423y7ewrymvxv4ibh34zdk4/zcblkukakjcadmws2vnjeqlswa/credential')
export GH_CLAUDE_REVIEWER_TOKEN=$(/opt/homebrew/bin/op read --cache=false 'op://mem423y7ewrymvxv4ibh34zdk4/jgyyk2upwnul4u7djztxhngygy/credential')
export GH_CODEX_REVIEWER_TOKEN=$(/opt/homebrew/bin/op read --cache=false 'op://mem423y7ewrymvxv4ibh34zdk4/sdtrfnz53an6dbv47yymktpzb4/credential')

if [[ -z "${LINEAR_API_KEY:-}" ]]; then
  echo "[adversarial-watcher] ERROR: failed to resolve LINEAR_API_KEY from 1Password" >&2
  exit 1
fi
if [[ -z "${GH_CLAUDE_REVIEWER_TOKEN:-}" ]]; then
  echo "[adversarial-watcher] ERROR: failed to resolve GH_CLAUDE_REVIEWER_TOKEN from 1Password" >&2
  exit 1
fi
if [[ -z "${GH_CODEX_REVIEWER_TOKEN:-}" ]]; then
  echo "[adversarial-watcher] ERROR: failed to resolve GH_CODEX_REVIEWER_TOKEN from 1Password" >&2
  exit 1
fi

# Scrub direct-provider API keys — reviewers must use OAuth only
unset ANTHROPIC_API_KEY
unset OPENAI_API_KEY

exec /opt/homebrew/bin/node /Users/airlock/agent-os/tools/adversarial-review/src/watcher.mjs
