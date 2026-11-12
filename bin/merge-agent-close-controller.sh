#!/usr/bin/env bash
# HAMCONTROLLERSCRIPT-01: the merge-agent's shipped rebase/validation/merge
# controller. The prompt used to make the model transcribe this sequence; now
# it only runs:
#
#   node <root>/bin/hammer-controller.mjs run <root>/bin/merge-agent-close-controller.sh \
#     --repo OWNER/REPO --base BRANCH --pr N --commands "$HAM_RUN_DIR/close-commands.json"
#
# Parameterized only by data: the arguments above and the commands file
# (bin/close-commands.mjs). It never reads a terminal or stdin. Safety
# semantics are unchanged: the blocking merge lease is acquired for this
# shell's pid and released by the EXIT trap on every path after acquisition;
# protective predecessors and the CI-cost check refuse merge; the merge is
# `--match-head-commit` on the validated head and never `--admin`.
set -euo pipefail
exec 0</dev/null

MERGE_CLOSE_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
# shellcheck disable=SC1091
source "$MERGE_CLOSE_ROOT/bin/hammer-node-runtime.sh"
MERGE_NODE="$HAM_NODE_BIN"
CONTROLLER_HELPER="$MERGE_CLOSE_ROOT/bin/hammer-controller.mjs"
MERGE_LEASE_HELPER="$MERGE_CLOSE_ROOT/bin/merge-lease.mjs"
VALIDATION_HELPER="$MERGE_CLOSE_ROOT/bin/hammer-validate.mjs"
CI_COST_CHECKER="$MERGE_CLOSE_ROOT/bin/ci-cost-check.mjs"

merge_close_usage() {
  echo 'usage: merge-agent-close-controller.sh --repo OWNER/REPO --base BRANCH --pr N --commands FILE' >&2
  exit 64
}
MERGE_REPO='' MERGE_BASE='' MERGE_PR='' MERGE_COMMANDS_FILE=''
while [ "$#" -gt 0 ]; do
  [ "$#" -ge 2 ] || merge_close_usage
  case "$1" in
    --repo) MERGE_REPO="$2" ;;
    --base) MERGE_BASE="$2" ;;
    --pr) MERGE_PR="$2" ;;
    --commands) MERGE_COMMANDS_FILE="$2" ;;
    *) merge_close_usage ;;
  esac
  shift 2
done
[[ "$MERGE_REPO" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || merge_close_usage
[[ "$MERGE_PR" =~ ^[1-9][0-9]*$ ]] || merge_close_usage
[ -n "$MERGE_BASE" ] && [ -n "$MERGE_COMMANDS_FILE" ] || merge_close_usage
[ -n "${HAM_RUN_DIR:-}" ] && [ -d "$HAM_RUN_DIR" ] || { echo 'merge close: export HAM_RUN_DIR first' >&2; exit 64; }
# Validate the commands data before any lease side effect.
MERGE_VALIDATIONS=$("$MERGE_NODE" "$MERGE_CLOSE_ROOT/bin/close-commands.mjs" "$MERGE_COMMANDS_FILE")

MERGE_PR_STATE_JSON=$(mktemp "$HAM_RUN_DIR/merge-pr-state.XXXXXX")
gh pr view "$MERGE_PR" --repo "$MERGE_REPO" --json headRefName,body > "$MERGE_PR_STATE_JSON"
MERGE_HEAD_REF=$(jq -r '.headRefName' "$MERGE_PR_STATE_JSON")
POST_REMEDIATION_SHA=$(git rev-parse HEAD)
MERGE_GATE_ATTEMPT_HEAD="$POST_REMEDIATION_SHA"
MERGE_LEASE_JSON="$HAM_RUN_DIR/merge-lease-acquire.json"
MERGE_REVALIDATION_JSON=$(mktemp "$HAM_RUN_DIR/merge-revalidation.XXXXXX")
MERGE_LEASE_ID=""
cleanup_merge_lease() {
  status=$?
  if [ -n "${MERGE_LEASE_ID:-}" ] && [ "${HAM_CONTROLLER_CANCELLED:-0}" -eq 0 ] && "$MERGE_NODE" "$CONTROLLER_HELPER" assert-owner; then
    "$MERGE_NODE" "$MERGE_LEASE_HELPER" release --repo "$MERGE_REPO" --base "$MERGE_BASE" --pr "$MERGE_PR" --lease-id "$MERGE_LEASE_ID" || true
  fi
  rm -f "$MERGE_REVALIDATION_JSON" "$MERGE_PR_STATE_JSON"
  exit "$status"
}
trap cleanup_merge_lease EXIT

set +e
"$MERGE_NODE" "$CONTROLLER_HELPER" assert-owner || exit 125
"$MERGE_NODE" "$MERGE_LEASE_HELPER" acquire --repo "$MERGE_REPO" --base "$MERGE_BASE" --pr "$MERGE_PR" --head "$MERGE_GATE_ATTEMPT_HEAD" --pr-state-file "$MERGE_PR_STATE_JSON" --owner-pid "$$" --wait 300 > "$MERGE_LEASE_JSON"
MERGE_LEASE_EXIT=$?
set -e
if [ "$MERGE_LEASE_EXIT" -eq 70 ] && jq -e '.parked == true' "$MERGE_LEASE_JSON" >/dev/null; then
  PARK_REASON=$(jq -r '.reason // "merge-gate-parked"' "$MERGE_LEASE_JSON")
  echo "merge gate parked PR: $PARK_REASON" >&2
  # Stop merge attempts and park/escalate with the emitted reason.
  exit 70
fi
if [ "$MERGE_LEASE_EXIT" -ne 0 ]; then
  exit "$MERGE_LEASE_EXIT"
fi
MERGE_LEASE_ID=$(jq -r '.leaseId' "$MERGE_LEASE_JSON")

# While holding the lease, rebase onto the latest base and validate the exact rebased head.
# If rebase or validation fails, exit non-zero here; the EXIT trap releases the lease.
git fetch --prune origin "$MERGE_BASE" "$MERGE_HEAD_REF"
VALIDATION_BASE=$(git rev-parse --verify "origin/$MERGE_BASE^{commit}")
# GENCONFLICT-01: registered committed outputs are regenerated per replayed commit.
# Failure aborts the rebase and removes this worktree; stop on nonzero status.
hq generated-conflicts rebase --worktree "$PWD" --onto "$VALIDATION_BASE"
# The project validation for this PR, from the commands file, against the
# rebased head. Each validator is a direct child of this shell; any timeout,
# cancellation or failure exits nonzero through the lease-release trap.
while IFS= read -r merge_validation; do
  [ -n "$merge_validation" ] || continue
  eval "set -- $merge_validation"
  "$MERGE_NODE" "$VALIDATION_HELPER" "$@"
done <<EOF_MERGE_VALIDATIONS
$MERGE_VALIDATIONS
EOF_MERGE_VALIDATIONS
git fetch --prune origin "$MERGE_BASE"
CURRENT_BASE=$(git rev-parse --verify "origin/$MERGE_BASE^{commit}")
POST_REMEDIATION_SHA=$(git rev-parse HEAD)
git push --force-with-lease origin "HEAD:$MERGE_HEAD_REF"

set +e
"$MERGE_NODE" "$MERGE_LEASE_HELPER" needs-revalidation --repo-path "$PWD" --base "$MERGE_BASE" --validation-base "$VALIDATION_BASE" --current-base "$CURRENT_BASE" --changed-files-from "$POST_REMEDIATION_SHA" > "$MERGE_REVALIDATION_JSON"
MERGE_REVALIDATION_EXIT=$?
set -e
if [ "$MERGE_REVALIDATION_EXIT" -ne 0 ]; then
  echo "merge revalidation failed; escalate instead of retrying the same invocation" >&2
  exit "$MERGE_REVALIDATION_EXIT"
fi
if ! jq -e '.needsRevalidation == false' "$MERGE_REVALIDATION_JSON" >/dev/null; then
  if ! jq -e '.needsRevalidation == true' "$MERGE_REVALIDATION_JSON" >/dev/null; then
    echo "merge revalidation returned an unrecognized decision; escalate" >&2
    exit 64
  fi
  # Base moved with overlapping risk; restart rebase/validation under a fresh lease.
  exit 75
fi

if ! PROTECTIVE_PREDECESSORS=$(gh pr view "$MERGE_PR" --repo "$MERGE_REPO" --json body --jq '.body // ""' | awk '/^[[:space:]]*Protects-Against-Unsafe-Merge-Until-PR[[:space:]]*:/ {print $0}'); then
  echo "protective predecessor body read failed; refusing merge" >&2
  exit 75
fi
if [ -n "$PROTECTIVE_PREDECESSORS" ]; then
  while IFS= read -r predecessor_line; do
    PROTECTOR_PR=$(printf "%s" "$predecessor_line" | sed -nE 's/^[[:space:]]*Protects-Against-Unsafe-Merge-Until-PR[[:space:]]*:[[:space:]]*#?([1-9][0-9]*)[[:space:]]*$/\1/p')
    if [ -z "$PROTECTOR_PR" ]; then
      echo "malformed protective predecessor trailer; refusing merge" >&2
      exit 75
    fi
    if [ "$PROTECTOR_PR" = "$MERGE_PR" ]; then
      echo "protective predecessor declaration points at this PR; ignoring malformed self-reference" >&2
      continue
    fi
    if ! PROTECTOR_STATE=$(gh pr view "$PROTECTOR_PR" --repo "$MERGE_REPO" --json state --jq '.state // ""'); then
      echo "protective predecessor state unreadable for PR #$PROTECTOR_PR; refusing merge" >&2
      exit 75
    fi
    if [ -z "$PROTECTOR_STATE" ]; then
      echo "protective predecessor state unreadable for PR #$PROTECTOR_PR; refusing merge" >&2
      exit 75
    fi
    if [ "$PROTECTOR_STATE" = "OPEN" ]; then
      echo "protective predecessor PR #$PROTECTOR_PR is still open; refusing merge" >&2
      exit 75
    fi
  done <<EOF_PROTECTIVE_PREDECESSORS
$PROTECTIVE_PREDECESSORS
EOF_PROTECTIVE_PREDECESSORS
fi

"$MERGE_NODE" "$CI_COST_CHECKER" "$MERGE_REPO" "$MERGE_PR" "$POST_REMEDIATION_SHA" && gh pr merge "$MERGE_PR" --repo "$MERGE_REPO" --squash --auto --match-head-commit "$POST_REMEDIATION_SHA"
