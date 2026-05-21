#!/usr/bin/env bash
set -euo pipefail

REPO=${1:-laceyenterprises/agent-os}

declare -a LABELS=(
  "fast-merge:spec-hash-rebind|Spec-hash rebind PR (no code diff)|0e8a16"
  "fast-merge:docs|Documentation-only changes|0e8a16"
  "fast-merge:test-fixtures|Additive test fixture data only|0e8a16"
  "fast-merge:submodule-bump|Submodule pointer bump|0e8a16"
  "fast-merge-veto|Operator override: forces normal adversarial review|d93f0b"
)

for entry in "${LABELS[@]}"; do
  IFS='|' read -r name desc color <<< "$entry"
  gh label create "$name" --repo "$REPO" --description "$desc" --color "$color" 2>/dev/null \
    || gh label edit "$name" --repo "$REPO" --description "$desc" --color "$color"
done
