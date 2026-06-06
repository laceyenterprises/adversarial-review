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
REPO_ROOT="${AGENT_OS_ROOT:-${WATCHER_DIR%/tools/adversarial-review}}"
if [[ -f "$REPO_ROOT/modules/worker-pool/lib/agent-os-config-loader.sh" ]]; then
  source "$REPO_ROOT/modules/worker-pool/lib/agent-os-config-loader.sh"
  export AGENT_OS_CFG_MODULES="$REPO_ROOT/tools/adversarial-review/config.yaml${AGENT_OS_CFG_MODULES:+:$AGENT_OS_CFG_MODULES}"
  eval "$(agent_os_config_export)"
fi

# OPH-01: route `op read` through the repo-local shared helper so a
# 1Password account-level quota exhaustion sleeps before exit instead
# of tight-looping launchd respawns. Fail closed if the helper cannot
# be sourced; semantic skew across duplicated cooldown wrappers caused
# the original respawn-loop regression.
_OP_RATE_LIMIT_HELPER="$WATCHER_DIR/scripts/lib/op-resolve-with-rate-limit-backoff.sh"
fail_op_helper_load() {
  echo "[adversarial-watcher] ERROR: $1" >&2
  echo "[adversarial-watcher] sleeping 3600s to suppress launchd respawn storm; restore the OPH-01 helper and bootout the agent to recover sooner." >&2
  sleep 3600
  exit 78
}
if [[ ! -r "$_OP_RATE_LIMIT_HELPER" ]]; then
  fail_op_helper_load "OPH-01 helper missing at $_OP_RATE_LIMIT_HELPER; refusing to start without the shared cooldown primitive."
fi
if ! source "$_OP_RATE_LIMIT_HELPER"; then
  fail_op_helper_load "OPH-01 helper failed to load from $_OP_RATE_LIMIT_HELPER; refusing to start without the shared cooldown primitive."
fi
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

ALERT_TO_OP_REF="${ADVERSARIAL_REVIEW_ALERT_TO_OP_REF:-${ALERT_TO_OP_REF:-}}"
ALERT_TO_REF_LABEL="${ALERT_TO_OP_REF:-ADVERSARIAL_REVIEW_ALERT_TO_OP_REF/ALERT_TO_OP_REF}"
ALLOW_MISSING_ALERT_TO="${ADVERSARIAL_REVIEW_ALLOW_MISSING_ALERT_TO:-${AGENT_OS_CFG_FEATURE_FLAGS_ALLOW_MISSING_ALERT_TO:-}}"

allow_missing_alert_to_enabled() {
  [[ "$ALLOW_MISSING_ALERT_TO" == "1" || "$ALLOW_MISSING_ALERT_TO" == "true" ]]
}

resolve_op_bin() {
  local op_bin
  op_bin="${ADVERSARIAL_REVIEW_OP_CLI:-${OP_CLI_PATH:-}}"
  if [[ -n "$op_bin" ]]; then
    if [[ -x "$op_bin" ]]; then
      printf '%s' "$op_bin"
      return 0
    fi
    echo "[adversarial-watcher] WARN: configured 1Password CLI '$op_bin' is not executable; falling back to PATH/Homebrew discovery." >&2
  fi
  if op_bin="$(command -v op 2>/dev/null)" && [[ -n "$op_bin" && -x "$op_bin" ]]; then
    printf '%s' "$op_bin"
    return 0
  fi
  for op_bin in /opt/homebrew/bin/op /usr/local/bin/op; do
    if [[ -x "$op_bin" ]]; then
      printf '%s' "$op_bin"
      return 0
    fi
  done
  return 1
}

if ! OP_BIN="$(resolve_op_bin)"; then
  echo "[adversarial-watcher] ERROR: 1Password CLI 'op' not found on PATH and not present at /opt/homebrew/bin/op or /usr/local/bin/op." >&2
  echo "[adversarial-watcher] sleeping 3600s to suppress launchd respawn storm; install op or set ADVERSARIAL_REVIEW_OP_CLI/OP_CLI_PATH to an executable." >&2
  sleep 3600
  exit 1
fi

# Resolve only the 1Password-backed secrets needed by watcher.mjs + reviewer.mjs.
# `--cache=false` was dropped on 2026-05-01: forcing a fresh auth on every
# call turned a transient watcher crash-loop (Node ABI mismatch) into a
# 1Password popup storm. The service-account token in the env makes these
# calls non-interactive; the cache only memoizes the resolution and does
# not change auth strength.
resolve_required_op_secret() {
  local name="$1"
  local ref="$2"
  local stdout_path
  local stderr_path
  local value
  local rc
  stdout_path="${TMPDIR:-/tmp}/adversarial-watcher-${name}.${UID}.$$.$RANDOM.value"
  stderr_path="${TMPDIR:-/tmp}/adversarial-watcher-${name}.${UID}.$$.$RANDOM.err"
  if op_resolve_with_rate_limit_backoff "$OP_BIN" read "$ref" >"$stdout_path" 2>"$stderr_path"; then
    value="$(<"$stdout_path")"
    if [[ -n "${value//[[:space:]]/}" ]]; then
      rm -f "$stdout_path" "$stderr_path"
      printf '%s' "$value"
      return 0
    fi
    echo "[adversarial-watcher] ERROR: $name at $ref resolved to an empty value." >&2
    rm -f "$stdout_path" "$stderr_path"
    echo "[adversarial-watcher] sleeping 3600s to suppress launchd respawn storm; fix the secret-source and bootout the agent to recover sooner." >&2
    sleep 3600
    return 1
  else
    rc=$?
  fi
  sed 's/^/  /' "$stderr_path" >&2
  if op_rate_limit_stderr_indicates_rate_limit "$stderr_path"; then
    rm -f "$stdout_path" "$stderr_path"
    return 5
  fi
  rm -f "$stdout_path" "$stderr_path"
  echo "[adversarial-watcher] ERROR: failed to resolve $name from 1Password" >&2
  echo "[adversarial-watcher] sleeping 3600s to suppress launchd respawn storm; fix the secret-source and bootout the agent to recover sooner." >&2
  sleep 3600
  return "$rc"
}

resolve_and_export_required_op_secret() {
  local name="$1"
  local ref="$2"
  local stdout_path
  local value
  local secret_status
  stdout_path="${TMPDIR:-/tmp}/adversarial-watcher-${name}.${UID}.$$.$RANDOM.out"
  set +e
  resolve_required_op_secret "$name" "$ref" >"$stdout_path"
  secret_status=$?
  set -e
  if [[ $secret_status -eq 0 ]]; then
    value="$(<"$stdout_path")"
    rm -f "$stdout_path"
    export "$name=$value"
    return 0
  fi
  rm -f "$stdout_path"
  if [[ $secret_status -eq 5 ]]; then
    echo "[adversarial-watcher] ERROR: $name resolution hit the 1Password rate-limit path; the helper already performed OPH-01 backoff, so exiting without an additional launcher sleep." >&2
  fi
  exit 1
}

# OPH-01: route through op_resolve_with_rate_limit_backoff so a
# 1Password rate-limit gets a 15-min sleep before exit (vs. the
# previous fail-open path that turned into a 30-second respawn storm
# under launchd KeepAlive+ThrottleInterval=30). Non-rate-limit failures
# get the same explicit launchd backoff here instead of relying on
# `set -e` to abort during command substitution.
resolve_and_export_required_op_secret LINEAR_API_KEY 'op://mem423y7ewrymvxv4ibh34zdk4/zcblkukakjcadmws2vnjeqlswa/credential'
resolve_and_export_required_op_secret GH_CLAUDE_REVIEWER_TOKEN 'op://mem423y7ewrymvxv4ibh34zdk4/jgyyk2upwnul4u7djztxhngygy/credential'
resolve_and_export_required_op_secret GH_CODEX_REVIEWER_TOKEN 'op://mem423y7ewrymvxv4ibh34zdk4/sdtrfnz53an6dbv47yymktpzb4/credential'

resolve_alert_to_optional() {
  local attempt=1
  local max_attempts=3
  local stderr_path
  local alert_to_value
  if [[ -z "${ALERT_TO_OP_REF:-}" ]]; then
    echo "[adversarial-watcher] ERROR: ALERT_TO 1Password ref is not configured; set ADVERSARIAL_REVIEW_ALERT_TO_OP_REF or ALERT_TO_OP_REF." >&2
    return 3
  fi
  stderr_path="${TMPDIR:-/tmp}/adversarial-watcher-alert-to.${UID}.$$.$RANDOM.err"
  while (( attempt <= max_attempts )); do
    if alert_to_value=$(op_resolve_with_rate_limit_backoff "$OP_BIN" read "$ALERT_TO_OP_REF" 2>"$stderr_path"); then
      if [[ -z "${alert_to_value//[[:space:]]/}" ]]; then
        echo "[adversarial-watcher] ERROR: ALERT_TO at $ALERT_TO_OP_REF resolved to an empty value." >&2
        rm -f "$stderr_path"
        return 3
      fi
      rm -f "$stderr_path"
      printf '%s' "$alert_to_value"
      return 0
    fi
    if grep -Eiq "not found|does not exist|isn't an item|unknown object type|no item|no field" "$stderr_path"; then
      rm -f "$stderr_path"
      return 3
    fi
    if op_rate_limit_stderr_indicates_rate_limit "$stderr_path"; then
      rm -f "$stderr_path"
      return 5
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

if [[ -n "${ALERT_TO:-}" && -z "${ALERT_TO//[[:space:]]/}" ]]; then
  unset ALERT_TO
fi
if [[ -z "${ALERT_TO:-}" ]]; then
  if alert_to_value="$(resolve_alert_to_optional)"; then
    export ALERT_TO="$alert_to_value"
  else
    alert_to_status=$?
    if [[ $alert_to_status -eq 3 ]]; then
      if allow_missing_alert_to_enabled; then
        echo "[adversarial-watcher] WARN: ALERT_TO is unset by explicit operator override (ADVERSARIAL_REVIEW_ALLOW_MISSING_ALERT_TO=1 or feature_flags.allow_missing_alert_to: true). Watcher-health and proactive-stuck-scan alerts will not page until $ALERT_TO_REF_LABEL is provisioned." >&2
      else
        echo "[adversarial-watcher] ERROR: ALERT_TO is not provisioned at $ALERT_TO_REF_LABEL and degraded startup is not enabled via ADVERSARIAL_REVIEW_ALLOW_MISSING_ALERT_TO=1 or feature_flags.allow_missing_alert_to: true." >&2
        echo "[adversarial-watcher] sleeping 3600s to suppress launchd respawn storm; set ALERT_TO directly, configure ADVERSARIAL_REVIEW_ALERT_TO_OP_REF, set ADVERSARIAL_REVIEW_ALLOW_MISSING_ALERT_TO=1, or enable feature_flags.allow_missing_alert_to: true in tools/adversarial-review/config.yaml for explicit degraded bring-up." >&2
        sleep 3600
        exit 1
      fi
    elif [[ $alert_to_status -eq 4 ]]; then
      if allow_missing_alert_to_enabled; then
        echo "[adversarial-watcher] WARN: ALERT_TO cannot be resolved because 1Password CLI 'op' is unavailable, but degraded startup is explicitly enabled via ADVERSARIAL_REVIEW_ALLOW_MISSING_ALERT_TO=1 or feature_flags.allow_missing_alert_to: true." >&2
      else
        echo "[adversarial-watcher] ERROR: ALERT_TO cannot be resolved because 1Password CLI 'op' is unavailable and degraded startup is not enabled via ADVERSARIAL_REVIEW_ALLOW_MISSING_ALERT_TO=1 or feature_flags.allow_missing_alert_to: true." >&2
        echo "[adversarial-watcher] sleeping 3600s to suppress launchd respawn storm; install op, set ALERT_TO directly, set ADVERSARIAL_REVIEW_ALLOW_MISSING_ALERT_TO=1, or enable feature_flags.allow_missing_alert_to: true in tools/adversarial-review/config.yaml for explicit degraded bring-up." >&2
        sleep 3600
        exit 1
      fi
    elif [[ $alert_to_status -eq 5 ]]; then
      echo "[adversarial-watcher] ERROR: ALERT_TO resolution hit the 1Password rate-limit path; the helper already performed OPH-01 backoff, so exiting without extra ALERT_TO retries or an additional launcher sleep." >&2
      exit 1
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
