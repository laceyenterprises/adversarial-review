#!/usr/bin/env bash
# Sourced by persisted inputs after dispatch values and the runtime are restored.
ham_gh() { "$HAM_NODE_BIN" "${HAM_ROOT_DIR}/bin/metered-gh.mjs" exec-hammer "$@"; }
ham_git() {
  local ham_git_exit=0
  "$HAM_NODE_BIN" "${HAM_ROOT_DIR}/bin/metered-gh.mjs" exec-git "$@" || ham_git_exit=$?
  # Consumed by the sourcing phase before it releases its lease.
  # shellcheck disable=SC2034
  if [ "$ham_git_exit" -eq 76 ]; then HAM_PHASE_OUTCOME=git-credential-refresh-failed; fi
  return "$ham_git_exit"
}
ham_pr() { "$HAM_NODE_BIN" "${HAM_ROOT_DIR}/bin/hammer-pr-read.mjs" "$HAM_REPO" "$HAM_PR_NUMBER" "$@"; }
