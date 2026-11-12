#!/usr/bin/env bash
# HAMCONTROLLERSCRIPT-01: the shipped hammer close controller. Run only by
# bin/hammer-close.sh through `hammer-controller.mjs run`, which registers the
# owning shell, keeps FD 4 for launch/validation gates and releases an owned
# lease after drain. Its only inputs are data: the run's inputs.sh (written by
# Appendix A) and the plan path in $1. It never reads a terminal or stdin.
#
# Sequence: publish a new local commit, verify-head (lease, rebase, bounded
# outside-lease revalidation), publish the audit, exact-head CI wait, predicate
# inputs, claim, predicate, merge. Every stop writes close-result.json and keeps
# the phase's own exit code (20 stop, 21 conflict repair, 75 retryable deferral).
exec 0</dev/null

HAM_CLOSE_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P) || exit 1
HAM_CLOSE_PLAN=${1:-}
HAM_CLOSE_STAGE=setup

ham_close_finish() {
  local status="$1" outcome="${2:-${HAM_PHASE_OUTCOME:-procedure-step-failed}}"
  rm -f "${HAM_VERDICT_FILE:-}" "${HAM_PRIMARY_CHANGE_FILE:-}"
  # The owning shell's cleanup releases a still-held lease on every stop.
  if [ "${HAM_MERGE_LEASE_HELD:-0}" -eq 1 ] && declare -F ham_release_merge_lease >/dev/null; then
    ham_release_merge_lease || true
  fi
  jq -n --argjson status "$status" --arg outcome "$outcome" --arg stage "$HAM_CLOSE_STAGE" \
    --arg head "${POST_REMEDIATION_SHA:-}" --arg leaseHeld "${HAM_MERGE_LEASE_HELD:-0}" \
    --arg note "${HAM_NO_MERGE_NOTE:-}" \
    '{schemaVersion: 1, status: $status, outcome: $outcome, stage: $stage,
      postRemediationSha: $head, leaseHeld: ($leaseHeld == "1"), noMergeNote: $note}' \
    > "$HAM_RUN_DIR/close-result.json" 2>/dev/null || true
  printf '\nHAM close: stage=%s status=%s outcome=%s\n' "$HAM_CLOSE_STAGE" "$status" "$outcome" >&2
  exit "$status"
}

if [ -z "${HAM_RUN_DIR:-}" ] || [ ! -f "$HAM_RUN_DIR/inputs.sh" ]; then
  echo 'hammer-close-controller: run through bin/hammer-close.sh' >&2
  exit 64
fi
# Functions are not inherited across the controller boundary; source again.
# shellcheck disable=SC1091
source "$HAM_RUN_DIR/inputs.sh" || ham_close_finish 1 dispatch-inputs-missing
"$HAM_NODE_BIN" "$HAM_CLOSE_ROOT/bin/hammer-controller.mjs" assert-owner || ham_close_finish 125 controller-setup-failed
ham_close_exports=$("$HAM_NODE_BIN" "$HAM_CLOSE_ROOT/bin/hammer-close-plan.mjs" exports "$HAM_CLOSE_PLAN") \
  || ham_close_finish 65 close-plan-invalid
eval "$ham_close_exports"
for ham_close_phase_name in hammer-verify-head hammer-publish hammer-merge; do
  [ -f "$HAM_RUN_DIR/$ham_close_phase_name.sh" ] || ham_close_finish 1 dispatch-phase-scripts-missing
done

# Appendix A's status-capturing wrapper, as shipped code.
ham_close_phase() {
  PHASE="$1"; shift
  HAM_CLOSE_STAGE="$PHASE${1:+ $1}"
  HAM_PHASE_SCRIPT="$HAM_RUN_DIR/$PHASE.sh"
  HAM_PHASE_LOG=$(mktemp "$HAM_RUN_DIR/phase-log.XXXXXX") || return 1
  # A phase that fails before naming its outcome keeps the registered default.
  HAM_PHASE_OUTCOME="$PHASE-failed"
  # Descriptor 3 streams lease-wait progress; buffer diagnostics.
  # shellcheck disable=SC1090
  if source "$HAM_PHASE_SCRIPT" "$@" 3>&2 > "$HAM_PHASE_LOG" 2>&1; then
    HAM_PHASE_STATUS=0
  else
    HAM_PHASE_STATUS=$?
  fi
  tail -c 4096 "$HAM_PHASE_LOG"
  rm -f "$HAM_PHASE_LOG"
  printf '\nHAM phase %s: status=%s outcome=%s lease-held=%s\n' \
    "$PHASE" "$HAM_PHASE_STATUS" "$HAM_PHASE_OUTCOME" "${HAM_MERGE_LEASE_HELD:-0}"
  return "$HAM_PHASE_STATUS"
}
# Bounded reads run the helper under HAM_NODE_BIN by absolute path, never
# through a PATH lookup of `node`.
ham_close_read() {
  "$HAM_NODE_BIN" "$HAM_CLOSE_ROOT/bin/hammer-helper-step.mjs" read:report "$1" 90 540 "$HAM_NODE_BIN" "${@:2}"
}
ham_close_phase_or_stop() { ham_close_phase "$@" || ham_close_finish "$HAM_PHASE_STATUS" "$HAM_PHASE_OUTCOME"; }

# 1. Publish a local remediation or conflict-repair commit the PR does not have.
HAM_CLOSE_STAGE=live-head-read
export HAM_PROCEDURE_STEP=live-head-read
HAM_PHASE_OUTCOME=starting-pr-state-unavailable
ham_close_read close-live-head "$HAM_CLOSE_ROOT/bin/hammer-pr-read.mjs" "$HAM_REPO" "$HAM_PR_NUMBER" \
  --json headRefOid > "$HAM_RUN_DIR/close-live-head.json" || ham_close_finish $? starting-pr-state-unavailable
ham_close_live_head=$(jq -er '.headRefOid | select(type == "string") | select(test("^[0-9a-fA-F]{40}$"))' \
  "$HAM_RUN_DIR/close-live-head.json") || ham_close_finish 1 starting-pr-state-unavailable
ham_close_local_head=$(git rev-parse --verify 'HEAD^{commit}') || ham_close_finish 1 reviewed-head-unavailable
if [ "$ham_close_local_head" != "$ham_close_live_head" ] \
  && ! { git cat-file -e "$ham_close_live_head^{commit}" 2>/dev/null \
    && git merge-base --is-ancestor "$ham_close_local_head" "$ham_close_live_head"; }; then
  export HAM_COMMIT_PUBLICATION_ONLY=1
  ham_close_phase_or_stop hammer-publish
  unset HAM_COMMIT_PUBLICATION_ONLY
fi

# 2. Verify the head under the lease; revalidate outside it when required.
ham_close_revalidations=0
while :; do
  ham_close_phase_or_stop hammer-verify-head
  [ "${HAM_NEEDS_REVALIDATION:-false}" = true ] || break
  ham_close_revalidations=$((ham_close_revalidations + 1))
  if [ "$ham_close_revalidations" -gt "${HAM_REBASE_ATTEMPT_CAP:-3}" ]; then
    ham_close_finish 20 rebase-attempt-cap-exceeded
  fi
  HAM_CLOSE_STAGE=local-validation
  ham_close_saved_head="$HAM_PRODUCED_HEAD"
  ham_close_saved_base="${HAM_CURRENT_BASE_SHA:-}"
  ham_release_merge_lease --yield local-validation || ham_close_finish 125 "${HAM_PHASE_OUTCOME:-controller-owner-lost}"
  ham_close_files=("${HAM_CLOSE_VALIDATION_FILES[@]}")
  if [ "${#ham_close_files[@]}" -eq 0 ]; then
    while IFS= read -r ham_close_file; do
      [ -n "$ham_close_file" ] && ham_close_files+=("$ham_close_file")
    done < <(git diff --name-only --diff-filter=d "$HAM_REVIEWED_SHA" HEAD --)
  fi
  export HAM_PROCEDURE_STEP=local-validation
  HAM_PHASE_OUTCOME=targeted-validation-failed
  if [ "${#ham_close_files[@]}" -gt 0 ]; then
    "$HAM_NODE_BIN" "$HAM_CLOSE_ROOT/bin/hammer-validate.mjs" --canonical -- "${ham_close_files[@]}" \
      || ham_close_finish $? targeted-validation-failed
  fi
  [ "$(git rev-parse HEAD)" = "$ham_close_saved_head" ] || ham_close_finish 20 head-changed
  export HAM_LOCALLY_VALIDATED_HEAD="$ham_close_saved_head"
  export HAM_LOCALLY_VALIDATED_BASE_SHA="$ham_close_saved_base"
done

# 3. Publish the validation audit under the lease.
ham_close_phase_or_stop hammer-publish

# 4. Bounded exact-head CI wait; a changed head republishes its audit.
ham_close_before_wait="${POST_REMEDIATION_SHA:-}"
ham_close_phase_or_stop hammer-merge --wait-ci
if [ "${POST_REMEDIATION_SHA:-}" != "$ham_close_before_wait" ]; then
  ham_close_phase_or_stop hammer-publish
fi

# 5. Exact-head predicate inputs.
HAM_CLOSE_STAGE=predicate-input-refresh
export HAM_PROCEDURE_STEP=predicate-input-refresh
HAM_PHASE_OUTCOME=predicate-input-refresh-failed
"$HAM_NODE_BIN" "$HAM_CLOSE_ROOT/bin/hammer-predicate-inputs.mjs" || ham_close_finish $? predicate-input-refresh-failed

# 6. Bind the closer's claim to the established head.
HAM_CLOSE_STAGE=claim-build
export HAM_PROCEDURE_STEP=claim-build
HAM_PHASE_OUTCOME=claim-build-failed
"$HAM_NODE_BIN" "$HAM_CLOSE_ROOT/bin/hammer-claim-head.mjs" "$HAM_RUN_DIR/terminal-remediation.json" \
  || ham_close_finish 1 claim-build-failed

# 7. The live predicate. Eligibility is judged by hammer-merge.sh, not here.
HAM_CLOSE_STAGE=predicate
export HAM_PROCEDURE_STEP=predicate
HAM_PHASE_OUTCOME=predicate-build-failed
HAM_PRIMARY_CHANGE_FILE=$(mktemp "$HAM_RUN_DIR/ham-primary-change.XXXXXX") || ham_close_finish 1
chmod 600 "$HAM_PRIMARY_CHANGE_FILE"
ham_close_read primary-change-context "$HAM_CLOSE_ROOT/bin/primary-change-context.mjs" "$HAM_REPO" "$HAM_PR_NUMBER" "$POST_REMEDIATION_SHA" \
  > "$HAM_PRIMARY_CHANGE_FILE" || ham_close_finish $? primary-change-context-failed
HAM_VERDICT_FILE=$(mktemp "$HAM_RUN_DIR/ham-verdict.XXXXXX") || ham_close_finish 1
chmod 600 "$HAM_VERDICT_FILE"
export HAM_VERDICT_FILE
"$HAM_NODE_BIN" "$HAM_CLOSE_ROOT/bin/ama-check.mjs" \
  --pr "$HAM_RUN_DIR/pr-after.json" \
  --reviews "$HAM_RUN_DIR/reviews.json" \
  --protection "$HAM_RUN_DIR/protection.json" \
  --timeline "$HAM_RUN_DIR/timeline.json" \
  --repo "$HAM_REPO" \
  --root-dir "$HAM_CLOSE_ROOT" \
  --reviewed-sha "$HAM_REVIEWED_SHA" \
  --reviewer "$HAM_REVIEWER" \
  --risk-class "$HAM_RISK_CLASS" \
  --ham-terminal-remediation "$HAM_RUN_DIR/terminal-remediation.json" \
  --ham-commit "$HAM_RUN_DIR/commit.json" \
  --ham-range "$HAM_RUN_DIR/range.json" \
  --primary-change "$HAM_PRIMARY_CHANGE_FILE" \
  > "$HAM_VERDICT_FILE" || ham_close_finish 1 predicate-build-failed
# Kept for diagnosis (Appendix E1); the owned verdict file is removed after merge.
cp "$HAM_VERDICT_FILE" "$HAM_RUN_DIR/predicate-verdict.json" 2>/dev/null || true

# 8. In-lease merge with every existing fence (exact head, never --admin).
ham_close_phase hammer-merge
ham_close_merge_status=$HAM_PHASE_STATUS
rm -f "$HAM_VERDICT_FILE" "$HAM_PRIMARY_CHANGE_FILE"
ham_close_finish "$ham_close_merge_status" "$HAM_PHASE_OUTCOME"
