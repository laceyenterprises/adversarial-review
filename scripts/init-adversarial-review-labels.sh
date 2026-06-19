#!/usr/bin/env bash
# Initialize the canonical adversarial-review GitHub labels on one or more repos.
#
# These labels are LOAD-BEARING for the pipeline, not cosmetic: the watcher +
# merge-agent + AMA closer apply/read them (e.g. `merge-agent-dispatched` is
# added on every merge-agent dispatch). A repo that the watcher auto-discovers
# but is missing these labels fails mid-pipeline — observed 2026-06-19 when
# foundry#15's merge-agent dispatch errored `'merge-agent-dispatched' not found`
# and podium had zero adversarial-review labels.
#
# This is part of the new-repo standup runbook — see
# docs/RUNBOOK-new-repo-standup.md. Idempotent (`gh label create --force`).
#
# Usage:
#   scripts/init-adversarial-review-labels.sh <repo> [<repo> ...]   # short name(s)
#   scripts/init-adversarial-review-labels.sh --all                 # every non-archived org repo
#   ADVERSARIAL_LABEL_ORG=laceyenterprises scripts/init-adversarial-review-labels.sh foundry podium
set -euo pipefail

ORG="${ADVERSARIAL_LABEL_ORG:-laceyenterprises}"  # cfg-allowlist: shell default org for the label-init tool

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

# Canonical set: merge-agent lifecycle + AMA operator controls + fast-merge.
declare -a LABELS=(
  "merge-agent-dispatched|merge-agent closer dispatched for this PR head|1d76db"
  "merge-agent-requested|Operator-fallback: invoke the merge-agent lane|1d76db"
  "merge-agent-recovery-in-flight|merge-agent recovery dispatch in flight|1d76db"
  "merge-agent-skip|Skip the merge-agent lane for this PR|c5def5"
  "merge-agent-stuck|merge-agent lane stuck; operator triage|d93f0b"
  "adversarial-merge-requested|AMA: request adversarial-merge closure (risk-class bypass)|0e8a16"
  "adversarial-merge-blocked|AMA: block adversarial-merge closure unconditionally|d93f0b"
  "operator-approved|Operator override: satisfy the AMA verdict gate|0e8a16"
  "no-merge-hold|Operator hold: block merge-agent and adversarial gate|d93f0b"
  "ticket-pipeline-paused|Pause adversarial-review Linear ticket pipeline sync|f9d0c4"
  "reviewer-cycle-cap-reached|Adversarial review/remediation cycle cap reached|fbca04"
  "paused-for-redesign|Adversarial review paused pending redesign|fbca04"
  "fast-merge-veto|Operator override: forces normal adversarial review|d93f0b"
  "fast-merge:docs|Documentation-only changes|0e8a16"
  "fast-merge:spec-hash-rebind|Spec-hash rebind PR (no code diff)|0e8a16"
  "fast-merge:test-fixtures|Additive test fixture data only|0e8a16"
  "fast-merge:submodule-bump|Submodule pointer bump|0e8a16"
)

rc=0
for repo in "${REPOS[@]}"; do
  ensured=0
  for spec in "${LABELS[@]}"; do
    IFS='|' read -r name desc color <<< "$spec"
    if gh label create "$name" --repo "$repo" --description "$desc" --color "$color" --force >/dev/null 2>&1; then
      ensured=$((ensured + 1))
    else
      echo "  WARN: failed to ensure label '$name' on $repo" >&2
      rc=1
    fi
  done
  echo "$repo: ensured $ensured/${#LABELS[@]} adversarial-review labels"
done
exit "$rc"
