#!/usr/bin/env bash
# Enforce the canonical merge method (SQUASH-ONLY) on one or more org repos.
#
# The whole fleet treats one PR as one logical ticket, and the worker-pool /
# adversarial-review automation already merges via `gh pr merge --squash`. Leaving
# `allow_merge_commit`/`allow_rebase_merge` enabled lets manual UI/CLI merges
# create merge-commits (and rebase merges), producing the mixed history observed
# 2026-06-19. Disabling them forces every merge — automated OR manual — to squash,
# so history stays linear (one squash commit per PR) and the build-completion
# ledger's PR↔mergeCommit correlation has a single shape to reason about.
#
# This is part of the new-repo standup runbook — see
# docs/RUNBOOK-new-repo-standup.md. Idempotent (a PATCH to the same values).
#
# Usage:
#   scripts/init-repo-merge-settings.sh <repo> [<repo> ...]   # short name(s)
#   scripts/init-repo-merge-settings.sh --all                 # every non-archived org repo
#   ADVERSARIAL_LABEL_ORG=laceyenterprises scripts/init-repo-merge-settings.sh foundry podium
set -euo pipefail

ORG="${ADVERSARIAL_LABEL_ORG:-laceyenterprises}"  # cfg-allowlist: shell default org for the repo-init tool
GH_RETRY_ATTEMPTS="${GH_RETRY_ATTEMPTS:-3}"
GH_RETRY_BASE_SLEEP_SECONDS="${GH_RETRY_BASE_SLEEP_SECONDS:-1}"

is_transient_gh_failure() {
  local text
  text="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')"
  [[ "$text" == *"timeout"* ]] \
    || [[ "$text" == *"timed out"* ]] \
    || [[ "$text" == *"tls handshake timeout"* ]] \
    || [[ "$text" == *"connection reset"* ]] \
    || [[ "$text" == *"connection refused"* ]] \
    || [[ "$text" == *"socket hang up"* ]] \
    || [[ "$text" == *"network is unreachable"* ]] \
    || [[ "$text" == *"temporary unavailable"* ]] \
    || [[ "$text" == *"temporarily unavailable"* ]] \
    || [[ "$text" == *"secondary rate limit"* ]] \
    || [[ "$text" == *"rate limit"* ]] \
    || [[ "$text" == *"http 500"* ]] \
    || [[ "$text" == *"http 502"* ]] \
    || [[ "$text" == *"http 503"* ]] \
    || [[ "$text" == *"http 504"* ]] \
    || [[ "$text" == *" 500 "* ]] \
    || [[ "$text" == *" 502 "* ]] \
    || [[ "$text" == *" 503 "* ]] \
    || [[ "$text" == *" 504 "* ]]
}

retry_gh() {
  local attempt=1
  local stdout_file stderr_file combined delay
  stdout_file="$(mktemp -t init-repo-merge-settings-gh-out.XXXXXX)" || return 1
  stderr_file="$(mktemp -t init-repo-merge-settings-gh-err.XXXXXX)" || {
    rm -f "$stdout_file"
    return 1
  }

  while :; do
    : >"$stdout_file"
    : >"$stderr_file"
    if "$@" >"$stdout_file" 2>"$stderr_file"; then
      cat "$stdout_file"
      if [[ -s "$stderr_file" ]]; then
        cat "$stderr_file" >&2
      fi
      rm -f "$stdout_file" "$stderr_file"
      return 0
    fi

    combined="$(cat "$stdout_file" "$stderr_file")"
    if (( attempt >= GH_RETRY_ATTEMPTS )) || ! is_transient_gh_failure "$combined"; then
      cat "$stdout_file"
      cat "$stderr_file" >&2
      rm -f "$stdout_file" "$stderr_file"
      return 1
    fi

    echo "retry gh ($attempt/$GH_RETRY_ATTEMPTS): transient failure: ${combined//$'\n'/ }" >&2
    delay=$(( GH_RETRY_BASE_SLEEP_SECONDS * attempt ))
    sleep "$delay"
    attempt=$(( attempt + 1 ))
  done
}

declare -a REPOS=()
if [[ "${1:-}" == "--all" ]]; then
  repo_list="$(retry_gh gh repo list "$ORG" --limit 1000 --json nameWithOwner,isArchived \
    --jq '.[] | select(.isArchived == false) | .nameWithOwner')" || exit 1
  while IFS= read -r repo; do
    [[ -n "$repo" ]] && REPOS+=("$repo")
  done <<<"$repo_list"
elif [[ $# -gt 0 ]]; then
  for arg in "$@"; do
    [[ "$arg" == */* ]] && REPOS+=("$arg") || REPOS+=("$ORG/$arg")
  done
else
  echo "usage: $0 <repo> [<repo> ...] | --all" >&2
  exit 64
fi

rc=0
for repo in "${REPOS[@]}"; do
  err_file="$(mktemp -t init-repo-merge-settings-patch-err.XXXXXX)" || exit 1
  if out=$(retry_gh gh api -X PATCH "repos/$repo" \
        -F allow_squash_merge=true \
        -F allow_merge_commit=false \
        -F allow_rebase_merge=false \
        --jq '"squash=\(.allow_squash_merge) merge_commit=\(.allow_merge_commit) rebase=\(.allow_rebase_merge)"' 2>"$err_file"); then
    if [[ -s "$err_file" ]]; then
      cat "$err_file" >&2
    fi
    echo "ok    $repo  $out"
  else
    err="$(cat "$err_file")"
    if [[ -n "$err" ]]; then
      if [[ -n "$out" ]]; then
        out="${out}"$'\n'"${err}"
      else
        out="$err"
      fi
    fi
    echo "FAIL  $repo  $out" >&2
    rc=1
  fi
  rm -f "$err_file"
done
exit "$rc"
