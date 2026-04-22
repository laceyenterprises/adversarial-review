#!/bin/zsh
# adversarial-watcher-start-placey.sh
# LaunchAgent wrapper for running the adversarial review watcher as the placey user.
# This keeps Codex, HOME, OAuth, and runtime state aligned under one principal.
#
# Secret policy:
# - Do not keep a long-lived `op run` process around the watcher.
# - Resolve only the small set of secrets the watcher/reviewer path actually needs,
#   then launch node directly so the watcher stays headless.

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

cd /Users/airlock/agent-os/tools/adversarial-review
exec /opt/homebrew/bin/node /Users/airlock/agent-os/tools/adversarial-review/src/watcher.mjs
