#!/usr/bin/env bash
# Initialize the canonical adversarial-review GitHub labels on one or more repos.
#
# These labels are LOAD-BEARING for the pipeline, not cosmetic: the watcher,
# merge-agent, AMA closer, fast-merge lane, and operator label surfaces
# apply/read them. A repo that the watcher auto-discovers but is missing these
# labels fails mid-pipeline — observed 2026-06-19 when foundry#15's
# merge-agent dispatch errored `'merge-agent-dispatched' not found`, and again
# on 2026-06-20 when app repos had the older adversarial subset but lacked
# `retrigger-review`.
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

# Canonical set: PR-control labels + AMA operator controls + fast-merge.
# Keep this list aligned with agent-os/scripts/init-pr-control-labels.sh.
declare -a LABELS=(
  "retrigger-remediation|Operator requests one more adversarial remediation/re-review cycle.|D4C5F9"
  "retrigger-review|Watcher signal: re-run adversarial review on current HEAD (applied by merge-agent post-push).|C5E1F9"
  "merge-agent-requested|Operator requests merge-agent clean/rebase/validate/merge.|5319E7"
  "merge-agent-dispatched|Watcher marker: merge-agent in flight. Label-add and cancel-on-merge retries are durable.|BFD4F2"
  "merge-agent-recovery-in-flight|Merge-agent marker: failure-recovery worker in flight. Suppresses phantom-handoff grace.|C2E0F4"
  "operator-approved|Operator accepts latest review; merge-agent may run if hard gates pass.|0E8A16"
  "adversarial-merge-requested|AMA: request adversarial-merge closure (risk-class bypass)|0E8A16"
  "adversarial-merge-blocked|AMA: block adversarial-merge closure unconditionally|D93F0B"
  "merge-on-comment-only|Operator escape valve: Comment-only reviews may merge even with non-blocking findings.|6F42C1"
  "address-all-findings|Operator strict-mode request: Comment-only reviews with non-blocking findings must remediate.|0052CC"
  "merge-agent-skip|Block merge-agent auto-dispatch for this PR.|E55300"
  "do-not-merge|Hard block for merge and merge-agent automation.|B60205"
  "no-auto-merge|Block auto-merge daemon; other PR automation may continue.|FBCA04"
  "no-merge-hold|Operator hold: block merge-agent and adversarial gate.|D93F0B"
  "merge-agent-stuck|Merge-agent output: operator attention required before retry.|D93F0B"
  "stale-drift|PR drift helper flagged stale branch; refresh before more review.|C5DEF5"
  "pr-class: additive-only|Initial PR diff was additive-only; scope expansion requires approval.|B7E4C7"
  "operator-approved: scope-expand|Current-head approval for additive-only PR scope expansion.|0E8A16"
  "reviewer-cycle-cap-reached|Reviewer cycle cap reached; operator must approve, merge-agent, or redesign.|F9D0C4"
  "paused-for-redesign|Operator paused the PR for redesign after cycle-cap escalation.|8B949E"
  "operator-approved: advisory-only-review|Current-head approval for advisory-only review without remediation dispatch.|0E8A16"
  "ticket-pipeline-paused|Pause adversarial-review Linear ticket pipeline sync.|F9D0C4"
  "fast-merge-veto|Operator override: forces normal adversarial review.|D93F0B"
  "fast-merge:docs|Documentation-only changes.|0E8A16"
  "fast-merge:spec-hash-rebind|Spec-hash rebind PR (no code diff).|0E8A16"
  "fast-merge:test-fixtures|Additive test fixture data only.|0E8A16"
  "fast-merge:submodule-bump|Submodule pointer bump.|0E8A16"
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
