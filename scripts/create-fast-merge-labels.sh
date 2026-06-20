#!/usr/bin/env bash
set -euo pipefail

ORG=${FAST_MERGE_LABEL_ORG:-laceyenterprises}

declare -a REPOS=()
if [[ $# -gt 0 ]]; then
  REPOS=("$@")
else
  while IFS= read -r repo; do
    [[ -n "$repo" ]] && REPOS+=("$repo")
  done < <(gh repo list "$ORG" --limit 1000 --json nameWithOwner,isArchived --jq '.[] | select(.isArchived == false) | .nameWithOwner')
fi

if [[ ${#REPOS[@]} -eq 0 ]]; then
  echo "No repositories found for adversarial-review label initialization." >&2
  exit 1
fi

declare -a LABELS=(
  "fast-merge:spec-hash-rebind|Spec-hash rebind PR (no code diff).|0E8A16"
  "fast-merge:docs|Documentation-only changes.|0E8A16"
  "fast-merge:test-fixtures|Additive test fixture data only.|0E8A16"
  "fast-merge:submodule-bump|Submodule pointer bump.|0E8A16"
  "fast-merge-veto|Operator override: forces normal adversarial review.|D93F0B"
  "ticket-pipeline-paused|Pause adversarial-review Linear ticket pipeline sync.|F9D0C4"
  "no-merge-hold|Operator hold: block merge-agent and adversarial gate.|D93F0B"
)

for repo in "${REPOS[@]}"; do
  echo "Initializing adversarial-review labels in $repo"
  for entry in "${LABELS[@]}"; do
    IFS='|' read -r name desc color <<< "$entry"
    gh label create "$name" --repo "$repo" --description "$desc" --color "$color" 2>/dev/null \
      || gh label edit "$name" --repo "$repo" --description "$desc" --color "$color"
  done
done
