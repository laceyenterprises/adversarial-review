#!/usr/bin/env bash
# Resolve reviewer credentials through the Agent OS GitHub adapter.

_reviewer_broker_indirect() {
    local varname="$1"
    eval "printf '%s' \"\${${varname}:-}\""
}

reviewer_broker_mode_enabled() {
    local role="$1"
    local role_upper
    role_upper="$(printf '%s' "$role" | tr '[:lower:]-' '[:upper:]_')"
    local flag_name="${role_upper}_AUTH_VIA_BROKER"
    local flag_value
    flag_value="$(_reviewer_broker_indirect "$flag_name")"
    [[ "$flag_value" == "true" ]]
}

reviewer_broker_service_repo() {
    jq -er '(if .org then .org + "/adversarial-review" else .repos[0] end) | strings | select(length > 0)' "$1/config.json"
}

reviewer_broker_service_repo_or_empty() {
    local repo
    if repo="$(reviewer_broker_service_repo "$1")"; then
        printf '%s' "$repo"
    else
        echo "[watcher] WARN: service repository unavailable; runtime identity check owns credential recovery" >&2
        return 0
    fi
}

# Broker-only optional lane: a failed seed must not stop either daemon or
# preserve a stale inherited credential. The Node helper uses the CFG reader.
seed_grok_reviewer_token() {
    local watcher_dir="${1:-$PWD}" repo="${2:-}"
    unset GH_GROK_REVIEWER_TOKEN
    if ! node "$watcher_dir/bin/grok-reviewer-lane-enabled.mjs"; then
        echo "[reviewer-broker] grok-reviewer-lane-disabled; skipping Grok token seed" >&2
        return 0
    fi
    if reviewer_broker_mode_enabled grok-reviewer; then
        if ! resolve_reviewer_token_via_broker GH_GROK_REVIEWER_TOKEN grok-reviewer "$repo"; then
            unset GH_GROK_REVIEWER_TOKEN
            echo "[reviewer-broker] WARN: GH_GROK_REVIEWER_TOKEN not resolved; continuing without Grok posting authority" >&2
        fi
    else
        echo "[reviewer-broker] WARN: Grok reviewer broker mode disabled; continuing without Grok posting authority" >&2
    fi
    return 0
}

resolve_reviewer_token_via_broker() {
    local target_env="$1" role="$2" repo="$3"
    local adapter response token name value timeout_ms adapter_rc reason perl_bin
    local -a adapter_env
    adapter="${GHA_ADAPTER_BIN:-${AGENT_OS_GITHUB_ADAPTER_BIN:-${AGENT_OS_ROOT:-${WATCHER_DIR}/../..}/modules/github-adapter/bin/github-adapter}}"
    [[ "$target_env" =~ ^[A-Z][A-Z0-9_]*$ && -n "$role" && -n "$repo" ]] || return 1
    unset "$target_env"
    adapter_env=("PATH=$PATH" "HOME=$HOME")
    for name in HQ_PYTHON3 AGENT_OS_CONFIG_PATH OAUTH_BROKER_URL OAUTH_BROKER_URL_FALLBACK \
      OAUTH_BROKER_SHARED_SECRET_FILE AGENT_OS_GITHUB_ADAPTER_BROKER_URL \
      AGENT_OS_GITHUB_ADAPTER_BROKER_URL_FALLBACK AGENT_OS_GITHUB_ADAPTER_BROKER_SECRET_FILE \
      AGENT_OS_GITHUB_ADAPTER_TOKEN_CACHE_DIR; do
        value="$(_reviewer_broker_indirect "$name")"
        if [[ -n "$value" ]]; then adapter_env+=("$name=$value"); fi
    done
    timeout_ms="${REVIEWER_TOKEN_FETCH_TIMEOUT_MS:-5000}"
    [[ "$timeout_ms" =~ ^[1-9][0-9]*$ ]] || timeout_ms=5000
    perl_bin="$(command -v perl)" || perl_bin=/usr/bin/perl
    # shellcheck disable=SC2016 # Perl owns the variables in this program.
    if response="$("$perl_bin" -MTime::HiRes=alarm -e 'my $ms = shift @ARGV; alarm($ms / 1000); exec @ARGV or exit 127' \
        "$timeout_ms" /usr/bin/env -i "${adapter_env[@]}" "$adapter" token --role "$role" --repo "$repo" 2>/dev/null)"; then
        if ! token="$(jq -er 'select(.ok == true) | .access_token | strings | select(length > 0)' <<<"$response" 2>/dev/null)"; then
            echo "[reviewer-broker] malformed adapter response for role=$role repo=$repo" >&2
            return 1
        fi
    else
        adapter_rc=$?
        reason="$(jq -er '.code | strings' <<<"$response" 2>/dev/null)" || reason=
        case "$reason" in
            broker-unreachable|github-app-token-unavailable|github-app-owner-not-configured|\
            github-app-id-not-configured|github-app-id-mismatch|github-installation-owner-mismatch|\
            github-installation-id-mismatch) ;;
            *) reason="adapter-token-refused" ;;
        esac
        if [[ "$adapter_rc" == 142 ]]; then reason="adapter-token-timeout"; fi
        echo "[reviewer-broker] $reason for role=$role repo=$repo (exit=$adapter_rc)" >&2
        return 1
    fi
    export "$target_env=$token"
}
