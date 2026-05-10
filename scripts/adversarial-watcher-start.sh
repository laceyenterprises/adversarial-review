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

# Sanity gate: better-sqlite3 is a native module and breaks across Node ABI
# bumps (NODE_MODULE_VERSION mismatch). If the watcher will fail to load
# anyway, sleep instead of crash-looping — KeepAlive=true + ThrottleInterval=30
# in the LaunchAgent plist would otherwise turn an ABI mismatch into a
# 1Password popup storm (every spawn triggers `op read` calls). Keep this
# gate BEFORE any 1Password resolution so a broken native module produces
# zero popups.
WATCHER_DIR="/Users/airlock/agent-os/tools/adversarial-review"
# Per-user err-file path. The original `/tmp/adversarial-watcher-native-check.err`
# was a single shared path across users, which silently broke the airlock-side
# launch when an old placey-owned file existed (cross-user redirect denied,
# masking a healthy ABI as a false "ABI mismatch" failure). UID-suffixed paths
# give every user their own scratch file with no cleanup coupling.
WATCHER_NATIVE_CHECK_ERR="/tmp/adversarial-watcher-native-check.${UID}.err"
if ! ( cd "$WATCHER_DIR" && /opt/homebrew/bin/node -e "const Database=require('better-sqlite3'); new Database(':memory:').close();" ) >"$WATCHER_NATIVE_CHECK_ERR" 2>&1; then
  echo "[adversarial-watcher] ERROR: better-sqlite3 failed to load — likely Node ABI mismatch after a node upgrade." >&2
  echo "[adversarial-watcher] details:" >&2
  sed 's/^/  /' "$WATCHER_NATIVE_CHECK_ERR" >&2
  echo "[adversarial-watcher] fix: cd $WATCHER_DIR && npm rebuild better-sqlite3" >&2
  echo "[adversarial-watcher] sleeping 3600s to suppress launchd respawn storm; bootout the agent and rebuild to recover sooner." >&2
  sleep 3600
  exit 1
fi

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
# `--cache=false` was dropped on 2026-05-01: forcing a fresh auth on every
# call turned a transient watcher crash-loop (Node ABI mismatch) into a
# 1Password popup storm. The service-account token in the env makes these
# calls non-interactive; the cache only memoizes the resolution and does
# not change auth strength.
export LINEAR_API_KEY=$(/opt/homebrew/bin/op read 'op://mem423y7ewrymvxv4ibh34zdk4/zcblkukakjcadmws2vnjeqlswa/credential')
export GH_CLAUDE_REVIEWER_TOKEN=$(/opt/homebrew/bin/op read 'op://mem423y7ewrymvxv4ibh34zdk4/jgyyk2upwnul4u7djztxhngygy/credential')
export GH_CODEX_REVIEWER_TOKEN=$(/opt/homebrew/bin/op read 'op://mem423y7ewrymvxv4ibh34zdk4/sdtrfnz53an6dbv47yymktpzb4/credential')

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
