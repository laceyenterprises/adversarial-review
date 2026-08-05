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
WATCHER_DIR="/Users/airlock/agent-os/tools/adversarial-review"  # cfg-allowlist(account-airlock): oss-readiness-apply-reviewed
REPO_ROOT="${AGENT_OS_ROOT:-${WATCHER_DIR%/tools/adversarial-review}}"
if [[ -f "$REPO_ROOT/modules/worker-pool/lib/agent-os-config-loader.sh" ]]; then
  source "$REPO_ROOT/modules/worker-pool/lib/agent-os-config-loader.sh"
  export AGENT_OS_CFG_MODULES="$REPO_ROOT/tools/adversarial-review/config.yaml${AGENT_OS_CFG_MODULES:+:$AGENT_OS_CFG_MODULES}"
  eval "$(agent_os_config_export)"
fi

# Headless daemon attribution. A system launchd daemon has no GUI harness
# session, but hq mutating verbs still require an authenticated actor label for
# audit/reconciliation. Pin a stable service identity before any subprocess can
# invoke hq.
export HQ_OPERATOR_PRINCIPAL="${HQ_OPERATOR_PRINCIPAL:-operator:adversarial-watcher}"
export HQ_PARENT_SESSION="${HQ_PARENT_SESSION:-session:adversarial-review:watcher}"

codex_auth_path_mode() {
  local auth_path="$1"
  local auth_mode
  auth_mode="$(stat -f '%Lp' "$auth_path" 2>/dev/null || true)"
  if [[ "$auth_mode" == <-> ]]; then
    echo "$auth_mode"
    return 0
  fi
  stat -c '%a' "$auth_path" 2>/dev/null || true
}

validate_codex_auth_path() {
  local auth_path="$1"
  local auth_mode
  if [[ -z "$auth_path" ]]; then
    echo "[adversarial-watcher] ERROR: CODEX_AUTH_PATH resolved empty; set CODEX_AUTH_PATH or HOME for the daemon user." >&2
    return 1
  fi
  if [[ ! -e "$auth_path" ]]; then
    echo "[adversarial-watcher] ERROR: missing Codex credentials at CODEX_AUTH_PATH='$auth_path'. Provision this daemon-owned auth.json before starting; refusing to copy GUI-user credentials." >&2
    return 1
  fi
  if [[ ! -f "$auth_path" ]]; then
    echo "[adversarial-watcher] ERROR: CODEX_AUTH_PATH='$auth_path' is not a regular file; refusing to start auth-broken daemon." >&2
    return 1
  fi
  if [[ ! -O "$auth_path" ]]; then
    echo "[adversarial-watcher] ERROR: CODEX_AUTH_PATH='$auth_path' is not owned by daemon user $(id -un); refusing to use cross-user credentials." >&2
    return 1
  fi
  if [[ ! -r "$auth_path" ]]; then
    echo "[adversarial-watcher] ERROR: CODEX_AUTH_PATH='$auth_path' is not readable by daemon user $(id -un); refusing to start auth-broken daemon." >&2
    return 1
  fi
  auth_mode="$(codex_auth_path_mode "$auth_path")"
  if [[ -z "$auth_mode" ]]; then
    echo "[adversarial-watcher] ERROR: unable to stat CODEX_AUTH_PATH='$auth_path' permissions; refusing to start." >&2
    return 1
  fi
  if (( ( 8#$auth_mode & 8#077 ) != 0 )); then
    echo "[adversarial-watcher] ERROR: CODEX_AUTH_PATH='$auth_path' mode $auth_mode is too broad; expected no group/other permissions." >&2
    return 1
  fi
}

CODEX_AUTH_PATH="${CODEX_AUTH_PATH:-${ADVERSARIAL_WATCHER_CODEX_AUTH_PATH:-}}"
if [[ -z "$CODEX_AUTH_PATH" && -n "${CODEX_HOME:-}" ]]; then
  CODEX_AUTH_PATH="${CODEX_HOME%/}/auth.json"
elif [[ -z "$CODEX_AUTH_PATH" && -n "${HOME:-}" ]]; then
  CODEX_AUTH_PATH="${HOME%/}/.codex/auth.json"
fi
export CODEX_AUTH_PATH
if ! validate_codex_auth_path "$CODEX_AUTH_PATH"; then
  echo "[adversarial-watcher] sleeping 3600s to suppress launchd respawn storm; provision daemon-owned Codex credentials and bootout the agent to recover sooner." >&2
  sleep 3600
  exit 1
fi

# LHA head-attestation HMAC key: reviewers sign live-head attestations at their
# HCP closeout via `hq attest sign`, which requires AGENT_OS_HEAD_ATTESTATION_HMAC_KEY_V1
# (>=32 bytes, read directly as the value by cwp_dispatch/hcp_worker_tokens.py).
# Resolve it from a host-local secret file, generating one if absent, so a watcher
# bounce or fresh host never restarts keyless — a keyless restart fails EVERY
# reviewer pass at attest-sign, which silently freezes the review->remediate
# pipeline (verdicts never record, remediation never enqueues; 2026-07-13 SEV).
_LHA_HMAC_KEY_FILE="${AGENT_OS_HEAD_ATTESTATION_HMAC_KEY_FILE:-$REPO_ROOT/.secrets/local/head-attestation-hmac-key-v1}"
lha_hmac_key_mode() {
  local key_file="$1"
  local key_mode
  key_mode="$(stat -f '%Lp' "$key_file" 2>/dev/null || true)"
  if [[ "$key_mode" == <-> ]]; then
    echo "$key_mode"
    return 0
  fi
  stat -c '%a' "$key_file" 2>/dev/null || true
}

lha_hmac_key_is_private() {
  local key_file="$1"
  local key_mode
  key_mode="$(lha_hmac_key_mode "$key_file")"
  [[ -n "$key_mode" ]] || return 1
  (( ( 8#$key_mode & 8#077 ) == 0 ))
}

lha_hmac_key_tighten_if_owned() {
  local key_file="$1"
  lha_hmac_key_is_private "$key_file" && return 0
  if [[ -O "$key_file" ]] && chmod 600 "$key_file" 2>/dev/null; then
    lha_hmac_key_is_private "$key_file"
    return $?
  fi
  return 1
}

lha_hmac_key_read_if_private() {
  local key_file="$1"
  if lha_hmac_key_tighten_if_owned "$key_file"; then
    tr -d '\r\n' < "$key_file" 2>/dev/null || true
  else
    echo "[adversarial-watcher] ERROR: head-attestation HMAC key permissions are too broad ($key_file); refusing to load" >&2
    return 1
  fi
}

if [[ -z "${AGENT_OS_HEAD_ATTESTATION_HMAC_KEY_V1:-}" ]]; then
  _LHA_HMAC_KEY=""
  if [[ -r "$_LHA_HMAC_KEY_FILE" ]]; then
    _LHA_HMAC_KEY="$(lha_hmac_key_read_if_private "$_LHA_HMAC_KEY_FILE" || true)"
  fi
  if (( ${#_LHA_HMAC_KEY} < 32 )); then
    _LHA_HMAC_KEY_DIR="$(dirname "$_LHA_HMAC_KEY_FILE")"
    _LHA_HMAC_KEY_TMP=""
    mkdir -m 700 -p "$_LHA_HMAC_KEY_DIR" 2>/dev/null || true
    if _LHA_HMAC_KEY_TMP="$(mktemp "$_LHA_HMAC_KEY_DIR/.head-attestation-hmac-key-v1.tmp.XXXXXX" 2>/dev/null)" \
      && ( umask 077; openssl rand -hex 32 > "$_LHA_HMAC_KEY_TMP" ) 2>/dev/null \
      && chmod 600 "$_LHA_HMAC_KEY_TMP" 2>/dev/null \
      && mv -f "$_LHA_HMAC_KEY_TMP" "$_LHA_HMAC_KEY_FILE" 2>/dev/null; then
      _LHA_HMAC_KEY_TMP=""
      echo "[adversarial-watcher] generated head-attestation HMAC key at $_LHA_HMAC_KEY_FILE" >&2
    fi
    [[ -z "$_LHA_HMAC_KEY_TMP" ]] || rm -f "$_LHA_HMAC_KEY_TMP" 2>/dev/null || true
    if [[ -r "$_LHA_HMAC_KEY_FILE" ]]; then
      _LHA_HMAC_KEY="$(lha_hmac_key_read_if_private "$_LHA_HMAC_KEY_FILE" || true)"
    fi
  fi
  if (( ${#_LHA_HMAC_KEY} >= 32 )); then
    AGENT_OS_HEAD_ATTESTATION_HMAC_KEY_V1="$_LHA_HMAC_KEY"
    export AGENT_OS_HEAD_ATTESTATION_HMAC_KEY_V1
  else
    echo "[adversarial-watcher] ERROR: head-attestation HMAC key unresolved or shorter than 32 bytes ($_LHA_HMAC_KEY_FILE); refusing to start" >&2
    exit 1
  fi
fi
if (( ${#AGENT_OS_HEAD_ATTESTATION_HMAC_KEY_V1} < 32 )); then
  echo "[adversarial-watcher] ERROR: AGENT_OS_HEAD_ATTESTATION_HMAC_KEY_V1 is shorter than 32 bytes; refusing to start" >&2
  exit 1
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
# Reviewer-token broker helper (2026-06-07). When
# <ROLE>_AUTH_VIA_BROKER=true is set, the watcher fetches reviewer
# installation tokens from the OAuth broker (GAB-01 / GAB-02) instead
# of the operator's shared PAT. Each role gets its own 15K/hr
# installation-token bucket. Sourcing this helper is mandatory but the
# broker path itself is default-off.
_REVIEWER_BROKER_HELPER="$WATCHER_DIR/scripts/lib/reviewer-broker.sh"
if [[ ! -r "$_REVIEWER_BROKER_HELPER" ]]; then
  fail_op_helper_load "reviewer-broker helper missing at $_REVIEWER_BROKER_HELPER; refusing to start without the broker primitive."
fi
if ! source "$_REVIEWER_BROKER_HELPER"; then
  fail_op_helper_load "reviewer-broker helper failed to load from $_REVIEWER_BROKER_HELPER; refusing to start without the broker primitive."
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

resolve_gh_bin() {
  local configured_gh_bin gh_bin
  configured_gh_bin="${ADVERSARIAL_REVIEW_GH_CLI:-${GH_BIN:-}}"
  if [[ -n "$configured_gh_bin" ]]; then
    if [[ -x "$configured_gh_bin" ]]; then
      printf '%s' "$configured_gh_bin"
      return 0
    fi
    echo "[adversarial-watcher] WARN: configured gh CLI '$configured_gh_bin' is not executable; falling back to PATH/signed-release discovery." >&2
  fi
  if gh_bin="$(command -v gh 2>/dev/null)" && [[ -n "$gh_bin" && -x "$gh_bin" ]]; then
    printf '%s' "$gh_bin"
    return 0
  fi
  for gh_bin in /usr/local/bin/gh /opt/homebrew/bin/gh; do
    if [[ -x "$gh_bin" ]]; then
      printf '%s' "$gh_bin"
      return 0
    fi
  done
  return 1
}

# Prefer a broker-backed GitHub App installation token for the watcher's OWN
# GitHub calls (poll-loop octokit + AMA-eligibility `gh` calls). The App token
# has its own ~15000/hr budget, isolated from the operator PAT — the prior
# keychain PAT path shared clio-airlock's single 5000/hr REST budget, which
# exhausts under PR surge and cannot run from a no-GUI system daemon. Default-ON
# via the flag; fail closed if the broker/file path cannot produce a token.
# Per-tick refresh (refreshWatcherGithubToken) keeps both GITHUB_TOKEN and
# GH_TOKEN fresh.
: "${WATCHER_GH_AUTH_VIA_BROKER:=true}"
export WATCHER_GH_AUTH_VIA_BROKER
WATCHER_GH_BROKER_ROLE="${WATCHER_GH_BROKER_ROLE:-merge-agent}"
export WATCHER_GH_BROKER_ROLE
export GITHUB_TOKEN=""
# Gate ONLY on our own flag (not a per-reviewer-role flag) and call the broker
# resolver directly; resolve_reviewer_token_via_broker validates the provider +
# secret itself and returns non-zero on any problem.
if [[ "${WATCHER_GH_AUTH_VIA_BROKER}" == "true" ]] \
  && resolve_reviewer_token_via_broker GITHUB_TOKEN "${WATCHER_GH_BROKER_ROLE}"; then
  export GH_TOKEN="$GITHUB_TOKEN"
  echo "[adversarial-watcher] GITHUB_TOKEN resolved via OAuth broker (role=${WATCHER_GH_BROKER_ROLE} App installation token; isolated rate-limit budget)" >&2
fi
if [[ -z "${GITHUB_TOKEN:-}" ]]; then
  echo "[adversarial-watcher] ERROR: could not resolve GITHUB_TOKEN via OAuth broker role ${WATCHER_GH_BROKER_ROLE}; refusing GUI keychain fallback." >&2
  echo "[adversarial-watcher] sleeping 3600s to suppress launchd respawn storm; fix the broker/file token source and bootout the agent to recover sooner." >&2
  sleep 3600
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

load_local_linear_api_key() {
  local linear_env_file
  local linear_value
  for linear_env_file in \
    "$REPO_ROOT/.secrets/local/linear.env" \
    "$REPO_ROOT/agents/clio/credentials/local/linear.env"; do
    [[ -r "$linear_env_file" ]] || continue
    linear_value="$(awk '
      /^[[:space:]]*(export[[:space:]]+)?LINEAR_API_KEY=/ {
        sub(/^[[:space:]]*(export[[:space:]]+)?LINEAR_API_KEY=/, "")
        gsub(/^[[:space:]]+|[[:space:]]+$/, "")
        if (($0 ~ /^".*"$/) || ($0 ~ /^'\''.*'\''$/)) {
          $0 = substr($0, 2, length($0) - 2)
        } else {
          sub(/[[:space:]]+#.*$/, "")
          gsub(/^[[:space:]]+|[[:space:]]+$/, "")
        }
        print
        exit
      }
    ' "$linear_env_file")"
    if [[ -n "${linear_value//[[:space:]]/}" ]]; then
      export LINEAR_API_KEY="$linear_value"
      return 0
    fi
  done
  return 1
}

if [[ -n "${LINEAR_API_KEY:-}" && -z "${LINEAR_API_KEY//[[:space:]]/}" ]]; then
  unset LINEAR_API_KEY
fi
if [[ -z "${LINEAR_API_KEY:-}" ]]; then
  load_local_linear_api_key || true
fi
if [[ -z "${LINEAR_API_KEY:-}" ]]; then
  # OPH-01: route through op_resolve_with_rate_limit_backoff so a
  # 1Password rate-limit gets a 15-min sleep before exit (vs. the
  # previous fail-open path that turned into a 30-second respawn storm
  # under launchd KeepAlive=true + ThrottleInterval=30).
  resolve_and_export_required_op_secret LINEAR_API_KEY 'op://mem423y7ewrymvxv4ibh34zdk4/zcblkukakjcadmws2vnjeqlswa/credential'
fi

# Reviewer tokens: try the OAuth broker path FIRST when the per-role
# flag is set, fall back to op-read otherwise. Broker mode fails closed
# (no silent op-read fallback) so a misconfigured broker is loud
# instead of silently regressing to the shared-identity cascade. To
# roll back: `unset CLAUDE_REVIEWER_AUTH_VIA_BROKER` /
# `unset CODEX_REVIEWER_AUTH_VIA_BROKER` and bounce the watcher.
broker_fail_closed_exit() {
  local flag_name="$1"
  echo "[adversarial-watcher] ERROR: ${flag_name}=true but broker fetch failed; refusing to fall back to op-read PAT path. Unset the flag to roll back." >&2
  echo "[adversarial-watcher] sleeping 3600s to suppress launchd respawn storm; fix the OAuth broker or unset ${flag_name} and bootout the agent to recover sooner." >&2
  sleep 3600
  exit 1
}

# Save the watcher's primary OP_SERVICE_ACCOUNT_TOKEN (resolved above via
# resolve-op-token-cli.mjs) and keep the legacy reviewer-PAT fallback helper in
# top-level scope so partial broker rollback works for any reviewer role.
_WATCHER_PRIMARY_OP_SA_TOKEN="${OP_SERVICE_ACCOUNT_TOKEN:-}"
_try_resolve_reviewer_pat() {
  local target_env="$1"
  local op_ref="$2"
  if resolve_and_export_required_op_secret "$target_env" "$op_ref"; then
    return 0
  fi
  if [[ -r /Users/airlock/agent-os/.secrets/local/op-service-account.env ]]; then  # cfg-allowlist(account-airlock): oss-readiness-apply-reviewed
    echo "[adversarial-watcher] retrying ${target_env} read under canonical SA env file (watcher SA may lack Cliovault access)" >&2
    local _fallback_token
    # shellcheck disable=SC1091
    _fallback_token="$(. /Users/airlock/agent-os/.secrets/local/op-service-account.env >/dev/null 2>&1; printf '%s' "${OP_SERVICE_ACCOUNT_TOKEN:-}")"  # cfg-allowlist(account-airlock): oss-readiness-apply-reviewed
    if [[ -n "$_fallback_token" ]]; then
      OP_SERVICE_ACCOUNT_TOKEN="$_fallback_token" \
        resolve_and_export_required_op_secret "$target_env" "$op_ref" && return 0
    fi
  fi
  return 1
}

if reviewer_broker_mode_enabled "claude-reviewer"; then
  if ! resolve_reviewer_token_via_broker GH_CLAUDE_REVIEWER_TOKEN claude-reviewer; then
    broker_fail_closed_exit "CLAUDE_REVIEWER_AUTH_VIA_BROKER"
  fi
else
  if ! _try_resolve_reviewer_pat GH_CLAUDE_REVIEWER_TOKEN 'op://Cliovault/claude-reviewer-pat/credential'; then
    echo "[adversarial-watcher] ERROR: failed to resolve GH_CLAUDE_REVIEWER_TOKEN from Cliovault under both watcher SA and canonical SA. Grant Cliovault read to the watcher SA, OR move claude-reviewer-pat into a vault the watcher can read." >&2
    exit 1
  fi
  # Restore primary SA for downstream audit attribution.
  OP_SERVICE_ACCOUNT_TOKEN="$_WATCHER_PRIMARY_OP_SA_TOKEN"
  export OP_SERVICE_ACCOUNT_TOKEN
fi
if reviewer_broker_mode_enabled "codex-reviewer"; then
  if ! resolve_reviewer_token_via_broker GH_CODEX_REVIEWER_TOKEN codex-reviewer; then
    broker_fail_closed_exit "CODEX_REVIEWER_AUTH_VIA_BROKER"
  fi
else
  if ! _try_resolve_reviewer_pat GH_CODEX_REVIEWER_TOKEN 'op://Cliovault/codex-reviewer-pat/credential'; then
    echo "[adversarial-watcher] ERROR: failed to resolve GH_CODEX_REVIEWER_TOKEN from Cliovault under both watcher SA and canonical SA." >&2
    exit 1
  fi
  OP_SERVICE_ACCOUNT_TOKEN="$_WATCHER_PRIMARY_OP_SA_TOKEN"
  export OP_SERVICE_ACCOUNT_TOKEN
fi
# GMW-06: gemini-reviewer wiring. adversarial-review consumes the gemini token
# from GH_GEMINI_REVIEWER_TOKEN ONLY; the 1Password item is named
# GEMINI_REVIEWER_GH_TOKEN (mapped in config/watcher-op.env as
# op://Cliovault/GEMINI_REVIEWER_GH_TOKEN/token). If the legacy item-named env
# var leaked into the runtime, recover locally by unsetting it before resolving
# the canonical GH_GEMINI_REVIEWER_TOKEN value. See
# docs/RUNBOOK-gemini-reviewer-app.md.
if [[ -n "${GEMINI_REVIEWER_GH_TOKEN:-}" ]]; then
  echo "[adversarial-watcher] WARNING: legacy GEMINI_REVIEWER_GH_TOKEN env var is present — adversarial-review consumes GH_GEMINI_REVIEWER_TOKEN only; unsetting GEMINI_REVIEWER_GH_TOKEN and continuing canonical token resolution (see docs/RUNBOOK-gemini-reviewer-app.md)." >&2
  unset GEMINI_REVIEWER_GH_TOKEN
fi
if reviewer_broker_mode_enabled "gemini-reviewer"; then
  if ! resolve_reviewer_token_via_broker GH_GEMINI_REVIEWER_TOKEN gemini-reviewer; then
    broker_fail_closed_exit "GEMINI_REVIEWER_AUTH_VIA_BROKER"
  fi
else
  if ! _try_resolve_reviewer_pat GH_GEMINI_REVIEWER_TOKEN 'op://Cliovault/GEMINI_REVIEWER_GH_TOKEN/token'; then
    echo "[adversarial-watcher] ERROR: failed to resolve GH_GEMINI_REVIEWER_TOKEN from Cliovault under both watcher SA and canonical SA." >&2
    exit 1
  fi
  OP_SERVICE_ACCOUNT_TOKEN="$_WATCHER_PRIMARY_OP_SA_TOKEN"
  export OP_SERVICE_ACCOUNT_TOKEN
fi
# Preflight safety net (GMW-06): never proceed to start the watcher with an
# unresolved gemini token — a downstream gemini review would otherwise post
# under another identity's token. Mirror the node preflight's exact message.
if [[ -z "${GH_GEMINI_REVIEWER_TOKEN:-}" ]]; then
  echo "[adversarial-watcher] ERROR: gemini reviewer selected but GH_GEMINI_REVIEWER_TOKEN unresolved — check the op.env mapping for GEMINI_REVIEWER_GH_TOKEN (see docs/RUNBOOK-gemini-reviewer-app.md)" >&2
  echo "[adversarial-watcher] sleeping 3600s to suppress launchd respawn storm; fix the GH_GEMINI_REVIEWER_TOKEN mapping and bootout the agent to recover sooner." >&2
  sleep 3600
  exit 1
fi

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

load_local_alert_to() {
  local alert_to_file
  local alert_to_value
  for alert_to_file in \
    "$REPO_ROOT/.secrets/local/adversarial-watcher-alert-to" \
    "$REPO_ROOT/agents/clio/credentials/local/adversarial-watcher-alert-to"; do
    [[ -r "$alert_to_file" ]] || continue
    alert_to_value="$(awk '
      {
        value = $0
        gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
        if (value != "") {
          print value
          exit
        }
      }
    ' "$alert_to_file")"
    if [[ -n "${alert_to_value//[[:space:]]/}" ]]; then
      export ALERT_TO="$alert_to_value"
      return 0
    fi
  done
  return 1
}

if [[ -n "${ALERT_TO:-}" && -z "${ALERT_TO//[[:space:]]/}" ]]; then
  unset ALERT_TO
fi
if [[ -z "${ALERT_TO:-}" ]]; then
  load_local_alert_to || true
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
  exec setsid /opt/homebrew/bin/node /Users/airlock/agent-os/tools/adversarial-review/src/watcher.mjs  # cfg-allowlist(account-airlock): oss-readiness-apply-reviewed
fi

exec /opt/homebrew/bin/node /Users/airlock/agent-os/tools/adversarial-review/src/watcher.mjs  # cfg-allowlist(account-airlock): oss-readiness-apply-reviewed
