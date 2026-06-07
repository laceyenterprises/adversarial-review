#!/usr/bin/env bash
# reviewer-broker.sh — fetch reviewer-bot GitHub App installation tokens
# via the OAuth broker shipped in agent-os GAB-01.
#
# Mirrors the GAB-02 merge-agent.sh broker branch
# (modules/worker-pool/lib/hq-gh.sh::_hq_resolve_merge_agent_broker_token)
# for the watcher's reviewer-token resolution path. Each reviewer role
# (claude-reviewer-lacey, codex-reviewer-lacey) gets its own broker
# provider (github-app-claude-reviewer, github-app-codex-reviewer) and
# its own 15K/hr installation-token bucket — so the watcher's review
# sessions stop funneling through the operator's single 5K/hr PAT
# bucket on clio-airlock.
#
# Contract:
#   resolve_reviewer_token_via_broker <env-var-name> <role>
#
#   where:
#     env-var-name is the destination env var (e.g. GH_CLAUDE_REVIEWER_TOKEN).
#     role is one of: claude-reviewer | codex-reviewer.
#
# Returns 0 (and exports <env-var-name>) on success.
# Returns 1 on any classifiable failure (missing config, curl failure,
# malformed response, metadata mismatch). The caller MAY fall back to
# an op-read path, OR fail closed depending on the broker-required flag.
#
# Env contract per role:
#   <ROLE>_AUTH_VIA_BROKER          # 'true' enables broker path
#   OAUTH_BROKER_URL                # default http://127.0.0.1:4099
#   OAUTH_BROKER_<ROLE>_PROVIDER    # default github-app-<role>
#   OAUTH_BROKER_<ROLE>_EXPECTED_APP_ID
#   OAUTH_BROKER_<ROLE>_EXPECTED_INSTALLATION_ID
#   OAUTH_BROKER_SHARED_SECRET_FILE # path to file containing the
#                                   # broker shared bearer secret
#
# The shared secret is read from OAUTH_BROKER_SHARED_SECRET_FILE
# immediately before the curl call and scrubbed after. Raw secret is
# never propagated through worker env; only the FILE PATH is
# referenced.
#
# To roll back: unset <ROLE>_AUTH_VIA_BROKER. The op-read fallback path
# is unchanged.

# Returns 0 iff broker-mode is requested for the given role.
reviewer_broker_mode_enabled() {
    local role="$1"
    local role_upper
    role_upper="$(printf '%s' "$role" | tr '[:lower:]-' '[:upper:]_')"
    local flag_name="${role_upper}_AUTH_VIA_BROKER"
    local flag_value="${!flag_name:-}"
    [[ "$flag_value" == "true" ]]
}

# Fetch + verify + export. Returns 0 on success, 1 on any failure.
# Stdout: nothing. Stderr: structured diagnostics on failure.
resolve_reviewer_token_via_broker() {
    local target_env="$1"
    local role="$2"

    if [[ -z "$target_env" || -z "$role" ]]; then
        echo "[reviewer-broker] usage: resolve_reviewer_token_via_broker <env-var> <role>" >&2
        return 1
    fi

    local role_upper
    role_upper="$(printf '%s' "$role" | tr '[:lower:]-' '[:upper:]_')"

    local broker_url="${OAUTH_BROKER_URL:-http://127.0.0.1:4099}"
    local provider_env="OAUTH_BROKER_${role_upper}_PROVIDER"
    local broker_provider="${!provider_env:-github-app-${role}}"
    local secret_file="${OAUTH_BROKER_SHARED_SECRET_FILE:-}"
    local expected_app_id_env="OAUTH_BROKER_${role_upper}_EXPECTED_APP_ID"
    local expected_app_id="${!expected_app_id_env:-}"
    local expected_installation_id_env="OAUTH_BROKER_${role_upper}_EXPECTED_INSTALLATION_ID"
    local expected_installation_id="${!expected_installation_id_env:-}"

    if [[ -z "$secret_file" ]]; then
        echo "[reviewer-broker] broker mode (${role}) requested but OAUTH_BROKER_SHARED_SECRET_FILE is empty" >&2
        return 1
    fi
    if [[ ! -r "$secret_file" ]]; then
        echo "[reviewer-broker] broker mode (${role}): OAUTH_BROKER_SHARED_SECRET_FILE='$secret_file' is unreadable" >&2
        return 1
    fi
    if ! command -v curl >/dev/null 2>&1; then
        echo "[reviewer-broker] broker mode (${role}): curl unavailable" >&2
        return 1
    fi
    if ! command -v jq >/dev/null 2>&1; then
        echo "[reviewer-broker] broker mode (${role}): jq unavailable (required to parse broker response)" >&2
        return 1
    fi

    local broker_secret=""
    broker_secret="$(cat "$secret_file" 2>/dev/null)"
    if [[ -z "$broker_secret" ]]; then
        echo "[reviewer-broker] broker mode (${role}): OAUTH_BROKER_SHARED_SECRET_FILE='$secret_file' is empty" >&2
        return 1
    fi

    local response_file curl_stderr_file http_code response_body="" curl_stderr=""
    response_file="$(mktemp -t reviewer-broker-resp.XXXXXX)"
    curl_stderr_file="$(mktemp -t reviewer-broker-curl.XXXXXX)"
    http_code="$(curl -sS --fail-with-body \
        -w '%{http_code}' \
        -o "$response_file" \
        -H "Authorization: Bearer $broker_secret" \
        -H "Accept: application/json" \
        "${broker_url%/}/token?provider=${broker_provider}" \
        2>"$curl_stderr_file" || true)"
    curl_stderr="$(tr '\n' ' ' <"$curl_stderr_file" 2>/dev/null | sed 's/[[:space:]]\+/ /g; s/^ //; s/ $//' || true)"
    rm -f "$curl_stderr_file"
    broker_secret=""
    unset broker_secret

    if [[ "$http_code" != "200" ]]; then
        response_body="$(head -c 256 "$response_file" 2>/dev/null || true)"
        rm -f "$response_file"
        echo "[reviewer-broker] broker mode (${role}): ${broker_url} returned HTTP ${http_code:-<no-code>}; stderr: ${curl_stderr:-<none>}; body[:256]: ${response_body:-<empty>}" >&2
        return 1
    fi

    local access_token actual_provider actual_app_id actual_installation_id
    access_token="$(jq -r '.access_token // empty' <"$response_file" 2>/dev/null)"
    actual_provider="$(jq -r '.provider // empty' <"$response_file" 2>/dev/null)"
    actual_app_id="$(jq -r '.metadata.app_id // empty' <"$response_file" 2>/dev/null)"
    actual_installation_id="$(jq -r '.metadata.installation_id // empty' <"$response_file" 2>/dev/null)"
    rm -f "$response_file"

    if [[ -z "$access_token" ]]; then
        echo "[reviewer-broker] broker mode (${role}): response missing access_token field" >&2
        return 1
    fi

    if [[ "$actual_provider" != "$broker_provider" ]]; then
        echo "[reviewer-broker] broker mode (${role}): response.provider='${actual_provider}' does not match expected '${broker_provider}'" >&2
        return 1
    fi
    if [[ -n "$expected_app_id" && "$actual_app_id" != "$expected_app_id" ]]; then
        echo "[reviewer-broker] broker mode (${role}): response.metadata.app_id='${actual_app_id}' does not match expected '${expected_app_id}' (${expected_app_id_env})" >&2
        return 1
    fi
    if [[ -n "$expected_installation_id" && "$actual_installation_id" != "$expected_installation_id" ]]; then
        echo "[reviewer-broker] broker mode (${role}): response.metadata.installation_id='${actual_installation_id}' does not match expected '${expected_installation_id}' (${expected_installation_id_env})" >&2
        return 1
    fi

    export "${target_env}=${access_token}"
    echo "[reviewer-broker] resolved ${target_env} via OAuth broker (role=${role} provider=${actual_provider} app_id=${actual_app_id} installation_id=${actual_installation_id})" >&2
    return 0
}

# Combined entry point. Calls broker if the role-flag is enabled; on
# success returns 0. On failure: returns 1 IF broker-required (caller
# should NOT fall back to op-read), or returns 2 IF broker was attempted
# but a fallback is permitted (broker-mode disabled OR not configured).
#
# Usage:
#   if reviewer_broker_mode_enabled "claude-reviewer"; then
#     if resolve_reviewer_token_via_broker GH_CLAUDE_REVIEWER_TOKEN claude-reviewer; then
#       :  # success
#     else
#       # broker-mode enabled but fetch failed: fail closed.
#       echo "[adversarial-watcher] ERROR: broker mode enabled for claude-reviewer but fetch failed" >&2
#       exit 1
#     fi
#   else
#     # broker mode disabled: fall back to op-read.
#     resolve_and_export_required_op_secret GH_CLAUDE_REVIEWER_TOKEN '<op-ref>'
#   fi
