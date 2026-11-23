#!/usr/bin/env bash
# HAMCONFLICTSYNC-01: the hammer's shipped conflict repair (prompt Appendix D).
#
#   /bin/bash <deployed-root>/bin/hammer-conflict-repair.sh <run-dir>/inputs.sh [--continue]
#
# The closer used to transcribe this procedure into its own shell, which after
# HAMCONTROLLERSCRIPT-01 no longer had the helpers it called. This script
# sources the run's inputs.sh itself, so every helper it calls is defined here.
# It runs in the PR worktree (the current directory), outside the merge lease,
# and never reads a terminal or standard input.
#
# Without --continue: read the live base/head branches, fetch both, detach at
# the exact fetched head, and rebase it onto the fetched base. A clean rebase
# continues to the proof and submodule sync below. When the rebase stops on
# conflicts, the script exits 22 (`conflict-markers-pending`) with the rebase
# still in progress. The closer resolves and stages hand-written sources, then
# reruns with --continue, which selects the applicable installed policy and
# finishes the replay or hands back the next source conflict.
#
# HAMCONFLICTCUSTODY-01: the PR branch is never checked out by name. This
# worktree can share its git directory with a builder's linked worktree that
# still holds the branch, and git refuses a second checkout of it. The repair
# runs on a detached HEAD and records the captured source in
# conflict-repair-publish.env; publication pushes HEAD:refs/heads/<branch> with
# that source as the exact-head lease, so the branch's checkout slot is never
# needed and a concurrent update of the branch refuses the push.
#
# Exit codes: 0 rebased head ready to publish; 22 hand-written conflicts to
# resolve, then --continue; 76 git-credential-refresh-failed (retryable); any
# other nonzero stops with the printed reason.
exec 0</dev/null

ham_conflict_usage() {
  echo 'usage: /bin/bash <deployed-root>/bin/hammer-conflict-repair.sh <run-dir>/inputs.sh [--continue]' >&2
  exit 64
}
ham_conflict_stop() {
  local status="$1" reason="$2"
  echo "HAM conflict repair: $reason" >&2
  exit "$status"
}
[ "$#" -ge 1 ] && [ "$#" -le 2 ] && [ -n "$1" ] || ham_conflict_usage
ham_conflict_continue=0
if [ "$#" -eq 2 ]; then
  [ "$2" = --continue ] || ham_conflict_usage
  ham_conflict_continue=1
fi
HAM_CONFLICT_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P) || exit 1
HAM_CONFLICT_RUN_DIR=$(cd "$(dirname "$1")" 2>/dev/null && pwd -P) \
  || ham_conflict_stop 1 'dispatch-inputs-missing: the run directory does not exist'
[ "$(basename "$1")" = inputs.sh ] && [ -f "$HAM_CONFLICT_RUN_DIR/inputs.sh" ] \
  || ham_conflict_stop 1 'dispatch-inputs-missing: initialize inputs.sh (Appendix A) first'
# shellcheck disable=SC1091
source "$HAM_CONFLICT_RUN_DIR/inputs.sh" || ham_conflict_stop 1 dispatch-inputs-missing
# Every helper resolves from this checkout by absolute path, never from PATH.
if [ "$(cd "${HAM_ROOT_DIR:-/nonexistent}" 2>/dev/null && pwd -P)" != "$HAM_CONFLICT_ROOT" ] \
  || [ "$(cd "${HAM_RUN_DIR:-/nonexistent}" 2>/dev/null && pwd -P)" != "$HAM_CONFLICT_RUN_DIR" ]; then
  ham_conflict_stop 1 'dispatch-inputs-missing: inputs.sh names another checkout or run directory'
fi
"$HAM_NODE_BIN" "$HAM_CONFLICT_ROOT/bin/hammer-validate.mjs" --check-custody || exit $?
for ham_conflict_helper in ham_pr ham_step ham_read ham_bounded_git_sync; do
  declare -F "$ham_conflict_helper" >/dev/null \
    || ham_conflict_stop 1 "conflict-repair-helper-missing: $ham_conflict_helper"
done
HAM_CONFLICT_STATE="$HAM_RUN_DIR/conflict-repair.env"
# Read by bin/hammer-api-publish.mjs; binds the repaired head to its source.
HAM_CONFLICT_PUBLISH="$HAM_RUN_DIR/conflict-repair-publish.env"
ham_conflict_automatic=0

# Git's default '#' comment marker would strip headings and issue references
# on rebase --continue. Use the same marker for the rebase and its resolver.
ham_conflict_comment_char() {
  local count=${GIT_CONFIG_COUNT:-0}
  export "GIT_CONFIG_KEY_${count}=core.commentChar"
  export "GIT_CONFIG_VALUE_${count}=;"
  export GIT_CONFIG_COUNT=$((count + 1))
}

ham_conflict_rebasing() {
  [ -d "$(git rev-parse --git-path rebase-merge)" ] || [ -d "$(git rev-parse --git-path rebase-apply)" ]
}

if [ "$ham_conflict_continue" -eq 0 ]; then
  export HAM_PROCEDURE_STEP=conflict-sync
  if [ -n "${HAM_FINAL_CONFLICT_HEAD:-}" ]; then
    ham_conflict_automatic=1
    ham_conflict_pr=$(ham_pr --json state,isDraft,headRefOid,baseRefName,headRefName) \
      || ham_conflict_stop 1 conflict-pr-read-failed
    jq -e --arg head "$HAM_FINAL_CONFLICT_HEAD" '.state == "OPEN" and .isDraft == false and .headRefOid == $head' \
      <<< "$ham_conflict_pr" >/dev/null || ham_conflict_stop 20 head-changed
    BASE_BRANCH=$(jq -er '.baseRefName | strings | select(length > 0)' <<< "$ham_conflict_pr") \
      && HEAD_BRANCH=$(jq -er '.headRefName | strings | select(length > 0)' <<< "$ham_conflict_pr") \
      || ham_conflict_stop 1 conflict-pr-read-failed
  else
    BASE_BRANCH=$(ham_pr --json baseRefName --jq '.baseRefName') && [ -n "$BASE_BRANCH" ] \
      || ham_conflict_stop 1 conflict-pr-read-failed
    HEAD_BRANCH=$(ham_pr --json headRefName --jq '.headRefName') && [ -n "$HEAD_BRANCH" ] \
      || ham_conflict_stop 1 conflict-pr-read-failed
  fi
  ham_bounded_git_sync "$BASE_BRANCH" "$HEAD_BRANCH" || {
    ham_conflict_sync_status=$?
    [ "$ham_conflict_sync_status" -eq 76 ] && ham_conflict_stop 76 git-credential-refresh-failed
    ham_conflict_stop 1 conflict-sync-failed
  }
  rm -f "$HAM_CONFLICT_PUBLISH" || ham_conflict_stop 1 conflict-state-unwritable
  git check-ref-format "refs/heads/$HEAD_BRANCH" || ham_conflict_stop 1 conflict-pr-read-failed
  HAM_CONFLICT_FETCHED=$(git rev-parse --verify "refs/remotes/origin/$HEAD_BRANCH^{commit}") \
    || ham_conflict_stop 1 conflict-source-unavailable
  if [ -n "${HAM_FINAL_CONFLICT_HEAD:-}" ] && [ "$HAM_CONFLICT_FETCHED" != "$HAM_FINAL_CONFLICT_HEAD" ]; then
    ham_conflict_stop 20 head-changed
  fi
  # Never orphan work: this worktree's HEAD must already be part of the PR head.
  HAM_CONFLICT_LOCAL=$(git rev-parse --verify 'HEAD^{commit}') || ham_conflict_stop 1 conflict-source-unavailable
  git merge-base --is-ancestor "$HAM_CONFLICT_LOCAL" "$HAM_CONFLICT_FETCHED" \
    || ham_conflict_stop 1 'conflict-source-not-fetched-head: this worktree has commits the PR head does not'
  # HAMCONFLICTCUSTODY-01: detach at the fetched head; never take the branch's
  # checkout slot, which a builder worktree sharing this git dir may hold.
  ham_step mutation:report checkout 90 540 git checkout --detach "$HAM_CONFLICT_FETCHED" \
    || ham_conflict_stop 1 conflict-checkout-failed
  # HAMEMPTYPRIMARY-01: capture the fetched source before replay. For a
  # conflict-only repair of the reviewed head, retain author messages/identity;
  # never squash or amend the author change into a HAM-classified commit.
  HAM_CONFLICT_SOURCE=$(git rev-parse HEAD) || ham_conflict_stop 1 conflict-source-unavailable
  HAM_CONFLICT_BASE=$(git rev-parse "origin/$BASE_BRANCH") || ham_conflict_stop 1 conflict-base-unavailable
  HAM_CONFLICT_BRANCH="$HEAD_BRANCH"
  # Exact head: the checkout must be the head just fetched from the PR.
  [ "$HAM_CONFLICT_SOURCE" = "$HAM_CONFLICT_FETCHED" ] \
    && [ "$HAM_CONFLICT_SOURCE" = "$(git rev-parse "origin/$HEAD_BRANCH")" ] \
    || ham_conflict_stop 1 conflict-source-not-fetched-head
  printf 'HAM_CONFLICT_SOURCE=%s\nHAM_CONFLICT_BASE=%s\nHAM_CONFLICT_BRANCH=%s\nHAM_CONFLICT_AUTOMATIC=%s\n' \
    "$HAM_CONFLICT_SOURCE" "$HAM_CONFLICT_BASE" "$HAM_CONFLICT_BRANCH" "$ham_conflict_automatic" \
    > "$HAM_CONFLICT_STATE" || ham_conflict_stop 1 conflict-state-unwritable
  if ! ( ham_conflict_comment_char; git rebase "origin/$BASE_BRANCH" ); then
    ham_conflict_rebasing || ham_conflict_stop 1 conflict-rebase-failed
    git diff --name-only --diff-filter=U >&2 || true
    echo 'HAM next: merge and stage the hand-written sources listed above, preserving both sides (Appendix D); leave registered generated outputs to the resolver; then rerun with --continue.' >&2
    ham_conflict_stop 22 conflict-markers-pending
  fi
else
  # Resume only the replay this script captured.
  [ -f "$HAM_CONFLICT_STATE" ] || ham_conflict_stop 1 'conflict-state-missing: run without --continue first'
  HAM_CONFLICT_SOURCE=$(sed -n 's/^HAM_CONFLICT_SOURCE=\([0-9a-fA-F]\{40\}\)$/\1/p' "$HAM_CONFLICT_STATE")
  HAM_CONFLICT_BASE=$(sed -n 's/^HAM_CONFLICT_BASE=\([0-9a-fA-F]\{40\}\)$/\1/p' "$HAM_CONFLICT_STATE")
  HAM_CONFLICT_BRANCH=$(sed -n 's/^HAM_CONFLICT_BRANCH=//p' "$HAM_CONFLICT_STATE")
  if grep -qx 'HAM_CONFLICT_AUTOMATIC=1' "$HAM_CONFLICT_STATE"; then ham_conflict_automatic=1; fi
  if [ -z "$HAM_CONFLICT_SOURCE" ] || [ -z "$HAM_CONFLICT_BASE" ] || [ -z "$HAM_CONFLICT_BRANCH" ] \
    || ! git check-ref-format "refs/heads/$HAM_CONFLICT_BRANCH"; then
    ham_conflict_stop 1 'conflict-state-missing: the captured source/base/branch are unreadable'
  fi
  if ham_conflict_rebasing; then
    # Merge and stage hand-written sources first, preserving both sides' intent.
    # The installed resolver owns generated outputs for its own repository.
    HAM_CONFLICT_PYTHON="${HQ_PYTHON3:-${AGENT_OS_PY:-${AGENT_OS_DEPLOY_CHECKOUT:+$AGENT_OS_DEPLOY_CHECKOUT/runtime/python/bin/python3}}}"
    [ -n "$HAM_CONFLICT_PYTHON" ] \
      || ham_conflict_stop 1 'conflict-resolver-failed: configure HQ_PYTHON3, AGENT_OS_PY or the deploy runtime Python (>= 3.11)'
    # The resolver reads AGENT_OS_DEPLOY_CHECKOUT. HAM_HQ_ROOT is dispatch state.
    ( ham_conflict_comment_char
      "$HAM_CONFLICT_PYTHON" -IB "$HAM_CONFLICT_ROOT/bin/hammer-conflict-resume.py" "$HAM_REPO" "$PWD"
    ) || {
      [ "$?" -eq 22 ] && ham_conflict_stop 22 conflict-markers-pending
      ham_conflict_stop 1 conflict-resolver-failed
    }
  fi
  ham_conflict_rebasing && ham_conflict_stop 1 conflict-rebase-unfinished
  git merge-base --is-ancestor "$HAM_CONFLICT_BASE" HEAD || ham_conflict_stop 1 conflict-rebase-unfinished
fi

# Only the conflict-only reviewed-head replay uses this proof. Remediation
# heads retain their existing full-range findings/preservation validation.
if [ "$HAM_CONFLICT_SOURCE" = "$HAM_REVIEWED_SHA" ]; then
  ham_read conflict-primary "$HAM_NODE_BIN" "$HAM_ROOT_DIR/bin/hammer-conflict-primary.mjs" \
    "$HAM_REVIEWED_SHA" "$HAM_CONFLICT_SOURCE" "$HAM_CONFLICT_BASE" \
    > "$HAM_RUN_DIR/conflict-primary.json" || {
      HAM_CONFLICT_PROOF_STATUS=$?
      case $HAM_CONFLICT_PROOF_STATUS in 1) HAM_CONFLICT_PROOF_REASON=conflict-primary-unproven;;
        124|142) HAM_CONFLICT_PROOF_REASON=conflict-primary-timeout;; *) HAM_CONFLICT_PROOF_REASON=conflict-primary-failed;; esac
      "$HAM_NODE_BIN" "$HAM_ROOT_DIR/bin/hammer-terminal-audit.mjs" "$HAM_CONFLICT_PROOF_REASON"
      ham_conflict_stop 1 "$HAM_CONFLICT_PROOF_REASON"
    }
fi
# SUBSYNC-01: the rebase moved gitlinks but not submodule checkouts.
HAM_CONFLICT_SUBMODULE_SYNC_CAP="${HAM_UPDATE_BRANCH_RETRY_CAP:-3}"
HAM_CONFLICT_SUBMODULE_SYNC_ATTEMPT=1
while true; do
  if ham_step mutation submodule-sync 120 720 git submodule update --recursive; then
    break
  fi
  if [ "$HAM_CONFLICT_SUBMODULE_SYNC_ATTEMPT" -ge "$HAM_CONFLICT_SUBMODULE_SYNC_CAP" ]; then
    echo "HAM hard-blocker: submodule update failed after conflict rebase; refusing force-push with stale submodule checkout" >&2
    ham_conflict_stop 1 conflict-submodule-sync-failed
  fi
  echo "HAM: submodule update failed after conflict rebase; retrying ${HAM_CONFLICT_SUBMODULE_SYNC_ATTEMPT}/${HAM_CONFLICT_SUBMODULE_SYNC_CAP}" >&2
  sleep $((HAM_CONFLICT_SUBMODULE_SYNC_ATTEMPT * 2))
  HAM_CONFLICT_SUBMODULE_SYNC_ATTEMPT=$((HAM_CONFLICT_SUBMODULE_SYNC_ATTEMPT + 1))
done
# The close command publishes HEAD:refs/heads/<branch> only while the branch
# still names this captured source (the exact-head lease).
HAM_CONFLICT_HEAD=$(git rev-parse --verify 'HEAD^{commit}') || ham_conflict_stop 1 conflict-rebase-unfinished
if [ "$ham_conflict_automatic" -eq 1 ] && [ "$HAM_CONFLICT_HEAD" != "$HAM_CONFLICT_SOURCE" ]; then
  ham_replay_proof=$(ham_read conflict-primary "$HAM_NODE_BIN" "$HAM_ROOT_DIR/bin/hammer-conflict-primary.mjs" \
    --replay-equivalence "$HAM_CONFLICT_SOURCE" "$HAM_CONFLICT_BASE") || ham_conflict_stop 1 conflict-primary-failed
  case "$ham_replay_proof" in
    equivalent) ;;
    review-required) printf '%s\n' "$HAM_CONFLICT_HEAD" > "$HAM_RUN_DIR/final-gate-review-head" \
      || ham_conflict_stop 1 conflict-state-unwritable ;;
    *) ham_conflict_stop 1 conflict-primary-failed ;;
  esac
fi
printf 'source=%s\nhead=%s\nbranch=%s\n' "$HAM_CONFLICT_SOURCE" "$HAM_CONFLICT_HEAD" "$HAM_CONFLICT_BRANCH" \
  > "$HAM_CONFLICT_PUBLISH" || ham_conflict_stop 1 conflict-state-unwritable
rm -f "$HAM_CONFLICT_STATE"
echo "HAM conflict repair: rebased $HAM_CONFLICT_SOURCE onto $HAM_CONFLICT_BASE as $(git rev-parse HEAD)" >&2
echo 'HAM next: rerun the close command; it publishes this head, then re-enters verify-head.' >&2
exit 0
