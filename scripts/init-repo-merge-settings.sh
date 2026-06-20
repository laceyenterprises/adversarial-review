#!/usr/bin/env bash
set -euo pipefail

ORG=${APP_REPO_MERGE_SETTINGS_ORG:-laceyenterprises}

usage() {
  cat >&2 <<'EOF'
Usage: init-repo-merge-settings.sh <repo-or-app>

Examples:
  init-repo-merge-settings.sh foundry
  init-repo-merge-settings.sh laceyenterprises/foundry
EOF
}

if [[ $# -ne 1 || -z "${1:-}" ]]; then
  usage
  exit 2
fi

target=$1
if [[ "$target" == */* ]]; then
  repo=$target
else
  repo="$ORG/$target"
fi

if ! gh repo view "$repo" --json nameWithOwner --jq .nameWithOwner >/dev/null; then
  echo "Repository '$repo' was not found or is not accessible through gh auth." >&2
  exit 1
fi

if ! gh repo edit "$repo" \
  --enable-squash-merge \
  --enable-merge-commit=false \
  --enable-rebase-merge=false \
  --delete-branch-on-merge \
  --squash-merge-commit-message pr-title; then
  echo "Failed to update canonical squash-only merge settings for '$repo'." >&2
  exit 1
fi

echo "Canonical squash-only merge settings initialized for $repo"
