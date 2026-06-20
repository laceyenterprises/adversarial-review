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

declare -a REPOS=()
if [[ "${1:-}" == "--all" ]]; then
  while IFS= read -r repo; do
    [[ -n "$repo" ]] && REPOS+=("$repo")
  done < <(gh repo list "$ORG" --limit 1000 --json nameWithOwner,isArchived \
            --jq '.[] | select(.isArchived == false) | .nameWithOwner')
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
  if out=$(gh api -X PATCH "repos/$repo" \
        -F allow_squash_merge=true \
        -F allow_merge_commit=false \
        -F allow_rebase_merge=false \
        --jq '"squash=\(.allow_squash_merge) merge_commit=\(.allow_merge_commit) rebase=\(.allow_rebase_merge)"' 2>&1); then
    echo "ok    $repo  $out"
  else
    echo "FAIL  $repo  $out" >&2
    rc=1
  fi
done
exit "$rc"
