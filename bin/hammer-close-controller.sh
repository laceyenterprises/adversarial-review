#!/usr/bin/env bash
# HAMCONTROLLERSCRIPT-01: the shipped hammer close controller. Run only by
# bin/hammer-close.sh through `hammer-controller.mjs run`, which registers the
# owning shell, keeps FD 4 for launch/validation gates and releases an owned
# lease after drain. Its only inputs are data: the run's inputs.sh (written by
# Appendix A) and the plan path in $1. It never reads a terminal or stdin.
#
# Sequence: validate a completed local conflict repair, publish a new local
# commit, verify-head (lease, rebase, bounded
# outside-lease revalidation), publish the audit, exact-head CI wait, predicate
# inputs, claim, predicate, merge. Terminal stops write close-result.json and
# keep the phase's exit code. The named stop outcome determines retryability.
exec 0</dev/null

HAM_CLOSE_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P) || exit 1
HAM_CLOSE_PLAN=${1:-}
HAM_CLOSE_STAGE=setup
ham_close_validation_receipts=()

ham_close_finish() {
  local status="$1" outcome="${2:-${HAM_PHASE_OUTCOME:-procedure-step-failed}}"
  rm -f "${HAM_VERDICT_FILE:-}" "${HAM_PRIMARY_CHANGE_FILE:-}"
  HAM_VERDICT_READY_FILE=""
  # The owning shell's cleanup releases a still-held lease on every stop.
  if [ "${HAM_MERGE_LEASE_HELD:-0}" -eq 1 ] && declare -F ham_release_merge_lease >/dev/null; then
    ham_release_merge_lease || true
  fi
  local validation
  validation=$(jq -sc '.' "${ham_close_validation_receipts[@]}" </dev/null 2>/dev/null) || validation='[]'
  printf '%s\n' "$validation" | jq --argjson status "$status" --arg outcome "$outcome" --arg stage "$HAM_CLOSE_STAGE" \
    --arg head "${POST_REMEDIATION_SHA:-}" --arg leaseHeld "${HAM_MERGE_LEASE_HELD:-0}" \
    --arg note "${HAM_NO_MERGE_NOTE:-}" \
    '{schemaVersion: 1, status: $status, outcome: $outcome, stage: $stage,
      postRemediationSha: $head, leaseHeld: ($leaseHeld == "1"), noMergeNote: $note,
      localValidation: .}' \
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
unset HAM_CLOSE_REBASE_HEAD
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

ham_close_validate() {
  local head="$1" base="$2" remote_head="$3" file changed_paths receipt status=0
  local files=("${HAM_CLOSE_VALIDATION_FILES[@]}")
  HAM_CLOSE_STAGE=local-validation
  export HAM_PROCEDURE_STEP=local-validation
  HAM_PHASE_OUTCOME=targeted-validation-failed
  HAM_CLOSE_VALIDATION_OUTCOME=
  if [ "${#files[@]}" -eq 0 ]; then
    changed_paths=$(mktemp "$HAM_RUN_DIR/validation-files.XXXXXX") || return 1
    if ! git diff -z --name-only --diff-filter=d "$HAM_REVIEWED_SHA" "$head" -- > "$changed_paths"; then
      rm -f "$changed_paths"
      return 1
    fi
    while IFS= read -r -d '' file; do
      [ -n "$file" ] && files+=("$file")
    done < "$changed_paths"
    rm -f "$changed_paths"
  fi
  [ "${#files[@]}" -gt 0 ] || return 0
  receipt=$(mktemp "$HAM_RUN_DIR/local-validation.XXXXXX") || receipt=
  HAM_CLOSE_VALIDATION_HEAD="$head" HAM_CLOSE_VALIDATION_RECEIPT="$receipt" \
    HAM_CLOSE_VALIDATION_BASE="$base" HAM_CLOSE_VALIDATION_REMOTE_HEAD="$remote_head" \
    "$HAM_NODE_BIN" "$HAM_CLOSE_ROOT/bin/hammer-validate.mjs" --canonical -- "${files[@]}" || status=$?
  if [ -s "$receipt" ]; then
    ham_close_validation_receipts+=("$receipt")
    HAM_CLOSE_VALIDATION_OUTCOME=$(jq -r --arg head "$head" \
      'select(.head == $head and .status == 75) | .outcome // empty' "$receipt" 2>/dev/null) \
      || HAM_CLOSE_VALIDATION_OUTCOME=
  elif [ -n "$receipt" ]; then
    rm -f "$receipt"
  fi
  return "$status"
}

ham_close_validation_stop() {
  local status="$1" head="$2"
  HAM_CLOSE_STAGE=local-validation
  if [ "$status" -eq 75 ] && [ "${HAM_CLOSE_VALIDATION_OUTCOME:-}" = harness-fault:socket-path ]; then
    ham_close_finish 75 harness-fault:socket-path
  elif [ -f "$HAM_RUN_DIR/validation-deferred-$head.json" ]; then
    ham_close_finish "$status" canonical-validation-deferred
  elif [ "$status" -eq 78 ]; then
    ham_close_finish 78 validation-environment-failed
  else
    ham_close_finish "$status" targeted-validation-failed
  fi
}

# Retry from source publication so the new head gets local validation before
# its fenced push, then fresh CI, review, primary-change and merge evidence.
while :; do
# 1. Publish a local remediation or conflict-repair commit the PR does not have.
HAM_CLOSE_STAGE=live-head-read
export HAM_PROCEDURE_STEP=live-head-read
HAM_PHASE_OUTCOME=starting-pr-state-unavailable
ham_close_read close-live-head "$HAM_CLOSE_ROOT/bin/hammer-pr-read.mjs" "$HAM_REPO" "$HAM_PR_NUMBER" \
  --json headRefOid > "$HAM_RUN_DIR/close-live-head.json" || ham_close_finish $? starting-pr-state-unavailable
ham_close_live_head=$(jq -er '.headRefOid | select(type == "string") | select(test("^[0-9a-fA-F]{40}$"))' \
  "$HAM_RUN_DIR/close-live-head.json") || ham_close_finish 1 starting-pr-state-unavailable
ham_close_local_head=$(git rev-parse --verify 'HEAD^{commit}') || ham_close_finish 1 reviewed-head-unavailable
ham_close_rebase_state=none
ham_close_prevalidated_head=
if [ -f "$HAM_RUN_DIR/conflict-repair-publish.env" ]; then
  ham_close_rebase_state=$("$HAM_NODE_BIN" "$HAM_CLOSE_ROOT/bin/hammer-validate.mjs" --check-rebase-publication) \
    || ham_close_finish 1 source-publication-refused
  [ "$ham_close_rebase_state" != blocked ] || ham_close_finish 1 source-publication-refused
fi
if [ "$ham_close_local_head" != "$ham_close_live_head" ] \
  && ! { git cat-file -e "$ham_close_live_head^{commit}" 2>/dev/null \
    && git merge-base --is-ancestor "$ham_close_local_head" "$ham_close_live_head"; }; then
  if [ "$ham_close_rebase_state" = validate ]; then
    ham_close_validation_exit=0
    ham_close_validate "$ham_close_local_head" "${HAM_BASE_HEAD:-}" "$ham_close_live_head" || ham_close_validation_exit=$?
    [ "$(git rev-parse HEAD)" = "$ham_close_local_head" ] || ham_close_finish 20 head-changed
    ham_close_rebase_state=$("$HAM_NODE_BIN" "$HAM_CLOSE_ROOT/bin/hammer-validate.mjs" --check-rebase-publication) \
      || ham_close_finish 1 source-publication-refused
    case "$ham_close_rebase_state" in
      draining)
        # The supervisor owns this round's drain. Leave the outer close free
        # to check its final registration and start one fresh round.
        case "$ham_close_validation_exit" in
          75|124|137|143) exit "$ham_close_validation_exit" ;;
        esac
        [ "$ham_close_validation_exit" -ne 0 ] || ham_close_validation_exit=75
        ham_close_validation_stop "$ham_close_validation_exit" "$ham_close_local_head" ;;
      ci|redrive)
        case "$ham_close_validation_exit" in
          0|75|124|137|143) ;;
          *) ham_close_validation_stop "$ham_close_validation_exit" "$ham_close_local_head" ;;
        esac ;;
      validate)
        [ "$ham_close_validation_exit" -eq 0 ] || ham_close_validation_stop "$ham_close_validation_exit" "$ham_close_local_head"
        ham_close_prevalidated_head="$ham_close_local_head" ;;
      blocked) ham_close_finish 1 source-publication-refused ;;
      *)
        if [ "$ham_close_validation_exit" -eq 0 ]; then ham_close_validation_exit=75; fi
        ham_close_validation_stop "$ham_close_validation_exit" "$ham_close_local_head" ;;
    esac
  elif [[ "$ham_close_rebase_state" != none && "$ham_close_rebase_state" != ci && "$ham_close_rebase_state" != redrive ]]; then
    ham_close_validation_stop 75 "$ham_close_local_head"
  fi
  export HAM_COMMIT_PUBLICATION_ONLY=1
  if [ "$ham_close_rebase_state" != none ]; then export HAM_CLOSE_REBASE_HEAD="$ham_close_local_head"; fi
  if ! ham_close_phase hammer-publish; then
    # The push may be live even if the subsequent provenance write failed.
    if [[ "$ham_close_rebase_state" = ci || "$ham_close_rebase_state" = redrive ]] \
      && [ "${HAM_PUSHED_HEAD:-}" = "$ham_close_local_head" ]; then
      export POST_REMEDIATION_SHA="$ham_close_local_head"
      "$HAM_NODE_BIN" "$HAM_CLOSE_ROOT/bin/hammer-terminal-audit.mjs" "$HAM_PHASE_OUTCOME" "$POST_REMEDIATION_SHA" \
        || ham_close_finish $? procedure-step-failed
    fi
    ham_close_finish "$HAM_PHASE_STATUS" "$HAM_PHASE_OUTCOME"
  fi
  unset HAM_COMMIT_PUBLICATION_ONLY HAM_CLOSE_REBASE_HEAD
fi

# A replay whose patch changed gets an independent review after publication.
if [ -f "$HAM_RUN_DIR/final-gate-review-head" ] \
  && [ "$(cat "$HAM_RUN_DIR/final-gate-review-head")" = "$ham_close_local_head" ]; then
  HAM_CLOSE_STAGE=review-handoff
  export POST_REMEDIATION_SHA="$ham_close_local_head"
  "$HAM_NODE_BIN" "$HAM_CLOSE_ROOT/bin/hammer-review-handoff.mjs" \
    "$HAM_CLOSE_ROOT" "$HAM_REPO" "$HAM_PR_NUMBER" "$ham_close_local_head" --exact-head \
    || ham_close_finish 75 review-handoff-unconfirmed
  ham_close_finish 20 exact-head-review-required
fi

# Without a usable required-check declaration we can still unblock the PR
# branch and start CI. Persist the watcher continuation on the published head.
# Settle source custody only after the exact repaired head is live.
if [[ "$ham_close_rebase_state" = ci || "$ham_close_rebase_state" = redrive ]]; then
  [ "${HAM_PUSHED_HEAD:-$ham_close_live_head}" = "$ham_close_local_head" ] || ham_close_finish 20 head-changed
  ham_close_completion_status=1
  for ham_close_completion_attempt in 1 2 3; do
    ham_close_completion_status=0
    "$HAM_NODE_BIN" "$HAM_CLOSE_ROOT/bin/hammer-validate.mjs" --complete-rebase-publication "$ham_close_local_head" \
      || ham_close_completion_status=$?
    [ "$ham_close_completion_status" -ne 0 ] || break
    [ "$ham_close_completion_attempt" -eq 3 ] || sleep 0.1
  done
  [ "$ham_close_completion_status" -eq 0 ] || ham_close_finish "$ham_close_completion_status" canonical-validation-deferred
fi
if [ "$ham_close_rebase_state" = redrive ]; then
  export POST_REMEDIATION_SHA="$ham_close_local_head" HAM_PROCEDURE_STEP=local-validation
  HAM_CLOSE_STAGE=local-validation
  "$HAM_NODE_BIN" "$HAM_CLOSE_ROOT/bin/hammer-terminal-audit.mjs" canonical-validation-deferred "$POST_REMEDIATION_SHA" \
    || ham_close_finish $? procedure-step-failed
  HAM_NO_MERGE_NOTE="Published the conflict repair. Validation lacks complete CI-authoritative evidence and the watcher will retry $POST_REMEDIATION_SHA."
  ham_close_finish 75 canonical-validation-deferred
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
  if { [ "$ham_close_rebase_state" != ci ] && [ "$ham_close_saved_head" != "$ham_close_prevalidated_head" ]; } \
    || [ "$ham_close_saved_head" != "$ham_close_local_head" ] \
    || [ "$ham_close_saved_head" != "${HAM_PUSHED_HEAD:-$ham_close_live_head}" ]; then
    ham_close_validate "$ham_close_saved_head" "$ham_close_saved_base" "$POST_REMEDIATION_SHA" \
      || ham_close_validation_stop "$?" "$ham_close_saved_head"
  fi
  [ "$(git rev-parse HEAD)" = "$ham_close_saved_head" ] || ham_close_finish 20 head-changed
  export HAM_LOCALLY_VALIDATED_HEAD="$ham_close_saved_head"
  export HAM_LOCALLY_VALIDATED_BASE_SHA="$ham_close_saved_base"
done

# 3. Publish the validation audit under the lease.
ham_close_phase_or_stop hammer-publish

# MRQ-21: a queue-v2 lane ends here, at the published, exact-head-attested
# head. The queue executor owns the CI wait, the merge predicate and the merge;
# this run hands the head off and never reaches them. Legacy lanes skip this.
if [ "${HAM_FINALIZATION_EXECUTOR:-}" = queue-v2 ]; then
  HAM_CLOSE_STAGE=queue-handoff
  export HAM_PROCEDURE_STEP=queue-handoff
  HAM_PHASE_OUTCOME=queue-handoff-unadmitted
  rm -f "$HAM_RUN_DIR/queue-handoff.json"
  ham_close_queue_status=0
  "$HAM_NODE_BIN" "$HAM_CLOSE_ROOT/bin/hammer-queue-handoff.mjs" || ham_close_queue_status=$?
  ham_close_queue_outcome=$(jq -er '.outcome | strings | select(test("^[a-z][a-z0-9-]*$"))' \
    "$HAM_RUN_DIR/queue-handoff.json" 2>/dev/null) || ham_close_queue_outcome=queue-handoff-unadmitted
  if [ "$ham_close_queue_status" -eq 0 ] && [ "$ham_close_queue_outcome" != queue-handoff-admitted ]; then
    ham_close_queue_status=75
  fi
  ham_close_finish "$ham_close_queue_status" "$ham_close_queue_outcome"
fi

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
"$HAM_NODE_BIN" "$HAM_CLOSE_ROOT/bin/hammer-helper-step.mjs" read:report primary-change-context 90 540 \
  "$HAM_NODE_BIN" "$HAM_CLOSE_ROOT/bin/primary-change-context.mjs" "$HAM_REPO" "$HAM_PR_NUMBER" "$POST_REMEDIATION_SHA" \
  > "$HAM_PRIMARY_CHANGE_FILE" || {
    ham_history_status=$?
    # Read by the sourced `hammer-merge --history-read-abort` phase.
    # shellcheck disable=SC2034
    if HAM_HISTORY_READ_ERROR=$(jq -er 'select(.historyReadFailed == true) | .reason | strings' "$HAM_PRIMARY_CHANGE_FILE"); then
      ham_close_phase hammer-merge --history-read-abort
      ham_close_finish "$ham_history_status" "$HAM_PHASE_OUTCOME"
    fi
    ham_close_finish "$ham_history_status" primary-change-context-failed
  }
HAM_VERDICT_FILE=$(mktemp "$HAM_RUN_DIR/ham-verdict.XXXXXX") || ham_close_finish 1
chmod 600 "$HAM_VERDICT_FILE"
export HAM_VERDICT_FILE
# HAMVERDICTREADY-01: hammer-merge.sh merges only when this marker names the
# verdict file. It stays empty until ama-check has written this run's verdict.
HAM_VERDICT_READY_FILE=""
export HAM_VERDICT_READY_FILE
ham_tenure_review_args=()
if [ "${HAM_TENURE_REVIEW_REQUIRED:-0}" = 1 ]; then ham_tenure_review_args=(--tenure-review); fi
"$HAM_NODE_BIN" "$HAM_CLOSE_ROOT/bin/ama-check.mjs" \
  "${ham_tenure_review_args[@]}" \
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
HAM_VERDICT_READY_FILE="$HAM_VERDICT_FILE"
# Kept for diagnosis (Appendix E1); the owned verdict file is removed after merge.
cp "$HAM_VERDICT_FILE" "$HAM_RUN_DIR/predicate-verdict.json" 2>/dev/null || true

# 8. In-lease merge with every existing fence (exact head, never --admin).
ham_close_phase hammer-merge
ham_close_merge_status=$HAM_PHASE_STATUS
rm -f "$HAM_VERDICT_FILE" "$HAM_PRIMARY_CHANGE_FILE"
HAM_VERDICT_READY_FILE=""
[ "$HAM_PHASE_OUTCOME" = retry-final-gate-conflict ] || ham_close_finish "$ham_close_merge_status" "$HAM_PHASE_OUTCOME"

ham_close_conflict_count=0
ham_close_conflict_budget="$HAM_RUN_DIR/final-gate-rebases"
if [ -f "$ham_close_conflict_budget" ]; then
  read -r ham_close_conflict_count < "$ham_close_conflict_budget" || ham_close_finish 1 conflict-state-unwritable
fi
case "$ham_close_conflict_count" in
  0|1) ;;
  2) ham_append_terminal_audit deferred needs-rebase-repair || ham_close_finish 1 procedure-step-failed
     ham_close_finish 20 needs-rebase-repair ;;
  *) ham_close_finish 1 conflict-state-unwritable ;;
esac
printf '%s\n' "$((ham_close_conflict_count + 1))" > "$ham_close_conflict_budget" \
  || ham_close_finish 1 conflict-state-unwritable
ham_close_conflict_status=0
HAM_FINAL_CONFLICT_HEAD="$POST_REMEDIATION_SHA" /bin/bash "$HAM_CLOSE_ROOT/bin/hammer-conflict-repair.sh" \
  "$HAM_RUN_DIR/inputs.sh" || ham_close_conflict_status=$?
case "$ham_close_conflict_status" in
  0) ;;
  22) ham_append_terminal_audit deferred needs-rebase-repair || ham_close_finish 1 procedure-step-failed
      ham_close_finish 21 needs-rebase-repair ;;
  20) ham_close_finish 20 head-changed ;;
  75) ham_append_terminal_audit deferred canonical-validation-deferred || ham_close_finish 1 procedure-step-failed
      ham_close_finish 75 canonical-validation-deferred ;;
  76) ham_close_finish 76 git-credential-refresh-failed ;;
  *) ham_close_finish "$ham_close_conflict_status" conflict-rebase-failed ;;
esac
done
