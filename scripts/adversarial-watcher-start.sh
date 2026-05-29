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
WATCHER_NATIVE_CHECK_ERR="${TMPDIR:-/tmp}/adversarial-watcher-native-check.${UID}.err"
if ! ( cd "$WATCHER_DIR" && /opt/homebrew/bin/node -e "const Database=require('better-sqlite3'); new Database(':memory:').close();" ) >"$WATCHER_NATIVE_CHECK_ERR" 2>&1; then
  echo "[adversarial-watcher] ERROR: better-sqlite3 failed to load — likely Node ABI mismatch after a node upgrade." >&2
  echo "[adversarial-watcher] details:" >&2
  sed 's/^/  /' "$WATCHER_NATIVE_CHECK_ERR" >&2
  echo "[adversarial-watcher] fix: cd $WATCHER_DIR && npm rebuild better-sqlite3" >&2
  echo "[adversarial-watcher] sleeping 3600s to suppress launchd respawn storm; bootout the agent and rebuild to recover sooner." >&2
  sleep 3600
  exit 1
fi

# Load 1Password service account token via the canonical secret-source
# contract (tools/adversarial-review/DEPS.md §"OP_SERVICE_ACCOUNT_TOKEN
# resolution"). The resolver checks, in order: process env, ADV_OP_TOKEN_FILE,
# ADV_OP_TOKEN_ENV_FILE, the legacy agents/clio/credentials/local
# op-service-account.env compatibility file, $ADV_SECRETS_ROOT/
# op-service-account.token, then $HOME/.config/adversarial-review/
# secrets/op-service-account.token. On failure it prints a single
# detailed diagnostic with every source it checked plus concrete
# remediation, and exits non-zero. We then sleep 3600 to absorb the
# launchd KeepAlive+ThrottleInterval=30 respawn storm — same fail-once
# shape as the better-sqlite3 ABI gate above.
OP_SERVICE_ACCOUNT_TOKEN=$(env ADV_OP_TOKEN_TAG="adversarial-watcher" /opt/homebrew/bin/node "$WATCHER_DIR/src/secret-source/resolve-op-token-cli.mjs") || {
    echo "[adversarial-watcher] sleeping 3600s to suppress launchd respawn storm; fix the secret-source above and bootout the agent to recover sooner." >&2
    sleep 3600
    exit 78
  }
export OP_SERVICE_ACCOUNT_TOKEN

# Resolve GitHub token from gh CLI keychain.
# Failure here MUST sleep before exit. Without the sleep, launchd's
# KeepAlive=true + ThrottleInterval=30 turns a missing `gh auth token`
# (expired credential, locked keychain window, gh upgrade transient,
# etc.) into a 30-second respawn storm. Same fail-once shape as the
# 1Password sleep guards added in #139 (op-read failures); the gh path
# was missed in that pass and produces an identical respawn-storm shape.
export GITHUB_TOKEN=$(/opt/homebrew/bin/gh auth token 2>/dev/null)
if [[ -z "${GITHUB_TOKEN:-}" ]]; then
  echo "[adversarial-watcher] ERROR: could not resolve GITHUB_TOKEN from gh keychain" >&2
  echo "[adversarial-watcher] sleeping 3600s to suppress launchd respawn storm; fix the gh credential and bootout the agent to recover sooner." >&2
  sleep 3600
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
ALERT_TO_OP_REF='op://Cliovault/adversarial-watcher-alert-to/credential'
ALLOW_MISSING_ALERT_TO="${ADVERSARIAL_REVIEW_ALLOW_MISSING_ALERT_TO:-}"

resolve_alert_to_optional() {
  local attempt=1
  local max_attempts=3
  local stderr_path
  local alert_to_value
  stderr_path="${TMPDIR:-/tmp}/adversarial-watcher-alert-to.${UID}.$$.$RANDOM.err"
  while (( attempt <= max_attempts )); do
    if alert_to_value=$(/opt/homebrew/bin/op read "$ALERT_TO_OP_REF" 2>"$stderr_path"); then
      rm -f "$stderr_path"
      printf '%s' "$alert_to_value"
      return 0
    fi
    if grep -Eiq "not found|does not exist|isn't an item|unknown object type|no item|no field" "$stderr_path"; then
      rm -f "$stderr_path"
      return 3
    fi
    if (( attempt < max_attempts )); then
      echo "[adversarial-watcher] WARN: failed to resolve ALERT_TO from 1Password (attempt $attempt/$max_attempts); retrying in 5s." >&2
      sed 's/^/  /' "$stderr_path" >&2
      attempt=$((attempt + 1))
      sleep 5
      continue
    fi
    echo "[adversarial-watcher] ERROR: failed to resolve ALERT_TO from 1Password after $max_attempts attempts." >&2
    sed 's/^/  /' "$stderr_path" >&2
    rm -f "$stderr_path"
    return 2
  done
}

# Secret-resolution failures (most commonly: 1Password CLI rate-limit "Too
# many requests") MUST sleep before exit. Without the sleep, launchd
# KeepAlive+ThrottleInterval=30 turns a single failed `op read` into a
# 30-second respawn storm that hammers 1Password and *prolongs* the
# rate-limit instead of clearing it. The 2026-05-19 incident produced
# 1349 watcher restarts in 8h (~21s cadence, ~4000 op calls) and froze
# the review pipeline for the operator's full workday.
# Same fail-once shape as the better-sqlite3 ABI gate and the
# OP_SERVICE_ACCOUNT_TOKEN secret-source resolver above.
if [[ -z "${LINEAR_API_KEY:-}" ]]; then
  echo "[adversarial-watcher] ERROR: failed to resolve LINEAR_API_KEY from 1Password" >&2
  echo "[adversarial-watcher] sleeping 3600s to suppress launchd respawn storm; fix the secret-source and bootout the agent to recover sooner." >&2
  sleep 3600
  exit 1
fi
if [[ -z "${GH_CLAUDE_REVIEWER_TOKEN:-}" ]]; then
  echo "[adversarial-watcher] ERROR: failed to resolve GH_CLAUDE_REVIEWER_TOKEN from 1Password" >&2
  echo "[adversarial-watcher] sleeping 3600s to suppress launchd respawn storm; fix the secret-source and bootout the agent to recover sooner." >&2
  sleep 3600
  exit 1
fi
if [[ -z "${GH_CODEX_REVIEWER_TOKEN:-}" ]]; then
  echo "[adversarial-watcher] ERROR: failed to resolve GH_CODEX_REVIEWER_TOKEN from 1Password" >&2
  echo "[adversarial-watcher] sleeping 3600s to suppress launchd respawn storm; fix the secret-source and bootout the agent to recover sooner." >&2
  sleep 3600
  exit 1
fi
if [[ -z "${ALERT_TO:-}" ]]; then
  if alert_to_value="$(resolve_alert_to_optional)"; then
    export ALERT_TO="$alert_to_value"
  else
    status=$?
    if [[ $status -eq 3 ]]; then
      if [[ "$ALLOW_MISSING_ALERT_TO" == "1" ]]; then
        echo "[adversarial-watcher] WARN: ALERT_TO is unset by explicit operator override (ADVERSARIAL_REVIEW_ALLOW_MISSING_ALERT_TO=1). Watcher-health and proactive-stuck-scan alerts will not page until $ALERT_TO_OP_REF is provisioned." >&2
      else
        echo "[adversarial-watcher] ERROR: ALERT_TO is not provisioned at $ALERT_TO_OP_REF and ADVERSARIAL_REVIEW_ALLOW_MISSING_ALERT_TO is not set to 1." >&2
        echo "[adversarial-watcher] sleeping 3600s to suppress launchd respawn storm; provision ALERT_TO or set ADVERSARIAL_REVIEW_ALLOW_MISSING_ALERT_TO=1 for an explicit degraded bring-up." >&2
        sleep 3600
        exit 1
      fi
    else
      echo "[adversarial-watcher] sleeping 3600s to suppress launchd respawn storm; fix the ALERT_TO secret-source and bootout the agent to recover sooner." >&2
      sleep 3600
      exit 1
    fi
  fi
fi

# Scrub direct-provider API/provider fallbacks — reviewers must use OAuth only.
unset ANTHROPIC_API_KEY
unset ANTHROPIC_BASE_URL
unset OPENAI_API_KEY
unset GOOGLE_API_KEY
unset GEMINI_API_KEY
unset CLAUDE_CODE_USE_BEDROCK
unset CLAUDE_CODE_USE_VERTEX
unset AWS_BEARER_TOKEN_BEDROCK
# Preserve ANTHROPIC_AUTH_TOKEN: it may be the OAuth bearer.

if command -v setsid >/dev/null 2>&1; then
  exec setsid /opt/homebrew/bin/node /Users/airlock/agent-os/tools/adversarial-review/src/watcher.mjs
fi

exec /opt/homebrew/bin/node /Users/airlock/agent-os/tools/adversarial-review/src/watcher.mjs
