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
export AGENT_OS_ROOT="/Users/airlock/agent-os"
export CODEX_AUTH_PATH="/Users/placey/.codex/auth.json"

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

# OPH-01: prefer the shared Agent OS helper, but keep a vendored fallback so
# this maintained legacy wrapper does not silently fall back to raw `op read`
# during partial deploys.
OP_RATE_LIMIT_SIGNATURE="Too many requests. Your client has been rate-limited"
_OP_RATE_LIMIT_DEFAULT_BACKOFF_S=900
_op_rate_limit_resolve_backoff_seconds() {
  local raw="${OP_RATE_LIMIT_BACKOFF_S-}"
  if [[ -z "$raw" ]]; then
    printf '%s\n' "$_OP_RATE_LIMIT_DEFAULT_BACKOFF_S"
    return 0
  fi
  case "$raw" in
    (*[!0-9]*)
      echo "op-rate-limit: OP_RATE_LIMIT_BACKOFF_S=${raw} is not a non-negative integer; using default ${_OP_RATE_LIMIT_DEFAULT_BACKOFF_S}s" >&2
      printf '%s\n' "$_OP_RATE_LIMIT_DEFAULT_BACKOFF_S"
      ;;
    (*)
      printf '%s\n' "$raw"
      ;;
  esac
}
op_resolve_with_rate_limit_backoff() {
  local tmp_dir stderr_file stderr_fifo rc child_pid tee_pid interrupted_signal
  tmp_dir="$(mktemp -d -t op-rate-limit.XXXXXX)" || return 1
  stderr_file="${tmp_dir}/stderr"
  stderr_fifo="${tmp_dir}/stderr.fifo"
  : > "$stderr_file" || {
    rm -rf "$tmp_dir"
    return 1
  }
  mkfifo "$stderr_fifo" || {
    rm -rf "$tmp_dir"
    return 1
  }
  rc=0
  child_pid=""
  tee_pid=""
  interrupted_signal=""

  _op_rate_limit_descendant_pids() {
    local parent="$1"
    local child
    pgrep -P "$parent" 2>/dev/null | while IFS= read -r child; do
      [[ -z "$child" ]] && continue
      printf '%s\n' "$child"
      _op_rate_limit_descendant_pids "$child"
    done
  }

  _op_rate_limit_forward_signal() {
    local sig="$1"
    local pid
    local -a pids
    interrupted_signal="$sig"
    if [[ -n "$child_pid" ]] && kill -0 "$child_pid" 2>/dev/null; then
      pids=("$child_pid")
      while IFS= read -r pid; do
        [[ -z "$pid" ]] && continue
        pids+=("$pid")
      done < <(_op_rate_limit_descendant_pids "$child_pid")
      for pid in "${pids[@]}"; do
        kill "-$sig" "$pid" 2>/dev/null || true
      done
    fi
  }

  trap '_op_rate_limit_forward_signal TERM' TERM
  trap '_op_rate_limit_forward_signal INT' INT
  tee -a "$stderr_file" < "$stderr_fifo" >&2 &
  tee_pid=$!
  "$@" 2> "$stderr_fifo" &
  child_pid=$!
  wait "$child_pid" || rc=$?
  if [[ -n "$interrupted_signal" ]]; then
    wait "$child_pid" 2>/dev/null || true
  fi
  wait "$tee_pid" 2>/dev/null || true
  trap - TERM INT
  if [[ "$interrupted_signal" == "TERM" ]]; then
    rm -rf "$tmp_dir"
    return 143
  fi
  if [[ "$interrupted_signal" == "INT" ]]; then
    rm -rf "$tmp_dir"
    return 130
  fi
  if (( rc == 0 )); then
    rm -rf "$tmp_dir"
    return 0
  fi
  if ! grep -qF "$OP_RATE_LIMIT_SIGNATURE" "$stderr_file" 2>/dev/null; then
    rm -rf "$tmp_dir"
    return "$rc"
  fi
  local backoff_s
  backoff_s="$(_op_rate_limit_resolve_backoff_seconds)"
  rm -rf "$tmp_dir"
  if (( backoff_s == 0 )); then
    echo "op-rate-limit: rate-limit detected; OP_RATE_LIMIT_BACKOFF_S=0, exiting immediately (test/escape hatch)" >&2
    return "$rc"
  fi
  echo "op-rate-limit: 1Password account-level rate-limit detected; sleeping ${backoff_s}s before exit so launchd KeepAlive cannot tight-loop into another op call against the exhausted quota" >&2
  sleep "$backoff_s"
  return "$rc"
}
if [[ -r "$REPO_ROOT/scripts/lib/op-resolve-with-rate-limit-backoff.sh" ]]; then
  source "$REPO_ROOT/scripts/lib/op-resolve-with-rate-limit-backoff.sh"
else
  echo "[adversarial-watcher] WARN: OPH-01 helper missing at $REPO_ROOT/scripts/lib/op-resolve-with-rate-limit-backoff.sh; using vendored fallback." >&2
fi

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
# resolution"), including the legacy agents/clio/credentials/local
# op-service-account.env compatibility file. See the airlock wrapper for
# the full rationale. Fail-once shape: a single detailed diagnostic from
# the resolver, then sleep 3600 to absorb the launchd respawn storm.
OP_SERVICE_ACCOUNT_TOKEN=$(env ADV_OP_TOKEN_TAG="adversarial-watcher" /opt/homebrew/bin/node "$WATCHER_DIR/src/secret-source/resolve-op-token-cli.mjs") || {
    echo "[adversarial-watcher] sleeping 3600s to suppress launchd respawn storm; fix the secret-source above and bootout the agent to recover sooner." >&2
    sleep 3600
    exit 78
  }
export OP_SERVICE_ACCOUNT_TOKEN

# Resolve GitHub token from gh CLI keychain
export GITHUB_TOKEN=$(/opt/homebrew/bin/gh auth token 2>/dev/null)
if [[ -z "${GITHUB_TOKEN:-}" ]]; then
  echo "[adversarial-watcher] ERROR: could not resolve GITHUB_TOKEN from gh keychain" >&2
  exit 1
fi

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
export LINEAR_API_KEY=$(op_resolve_with_rate_limit_backoff "$OP_BIN" read 'op://mem423y7ewrymvxv4ibh34zdk4/zcblkukakjcadmws2vnjeqlswa/credential')
export GH_CLAUDE_REVIEWER_TOKEN=$(op_resolve_with_rate_limit_backoff "$OP_BIN" read 'op://mem423y7ewrymvxv4ibh34zdk4/jgyyk2upwnul4u7djztxhngygy/credential')
export GH_CODEX_REVIEWER_TOKEN=$(op_resolve_with_rate_limit_backoff "$OP_BIN" read 'op://mem423y7ewrymvxv4ibh34zdk4/sdtrfnz53an6dbv47yymktpzb4/credential')

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

cd /Users/airlock/agent-os/tools/adversarial-review
if command -v setsid >/dev/null 2>&1; then
  exec setsid /opt/homebrew/bin/node /Users/airlock/agent-os/tools/adversarial-review/src/watcher.mjs
fi

exec /opt/homebrew/bin/node /Users/airlock/agent-os/tools/adversarial-review/src/watcher.mjs
