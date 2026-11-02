#!/usr/bin/env bash
# GitHub credentials refresh inside metered-gh immediately before each call.
export HAM_ROOT_DIR='<<ROOT_DIR>>'
# HAMMERTRIM-01: rendered by bin/hammer-procedure.mjs with trusted dispatch values.
ham_gh() { "${HAM_NODE_BIN:-node}" <<ROOT_DIR>>/bin/metered-gh.mjs exec-hammer "$@"; }
ham_pr() { "${HAM_NODE_BIN:-node}" <<ROOT_DIR>>/bin/hammer-pr-read.mjs <<REPO>> <<PR_NUMBER>> "$@"; }

ham_verify_head_phase() {
HAM_PHASE_OUTCOME=verify-head-pr-read-failed
export POST_REMEDIATION_SHA HAM_PRODUCED_HEAD HAM_PUSHED_HEAD HAM_PUSHED_FROM_HEAD
ham_pr --json number,headRefOid,state,isDraft,mergeable,mergeStateStatus,labels,statusCheckRollup,author,baseRefName > "<<RUN_DIR>>/pr-after.json" || return $?
POST_REMEDIATION_SHA=$(jq -er '.headRefOid | select(type == "string") | select(test("^[0-9a-fA-F]{40}$"))' "<<RUN_DIR>>/pr-after.json") || { HAM_PHASE_OUTCOME=missing-pr-state; return 1; }
# A capacity outage ends this round before the merge lease or any decision.
# Context also applies this rule; recheck here after edits/pushes or CI changes.
"${HAM_NODE_BIN:-node}" <<ROOT_DIR>>/bin/hammer-ci-stop.mjs "<<RUN_DIR>>/pr-after.json" || {
  ham_ci_stop_exit=$?
  HAM_PHASE_OUTCOME=ci-infrastructure-evidence-unavailable
  if [ "$ham_ci_stop_exit" -eq 20 ]; then HAM_PHASE_OUTCOME=ci-infrastructure; fi
  if declare -F ham_release_merge_lease >/dev/null; then ham_release_merge_lease || return 1; fi
  return "$ham_ci_stop_exit"
}
# Wait only for read-after-push lag. A third head retains the ordinary race path.
HAM_HEAD_WAITED_SECONDS="${HAM_HEAD_WAITED_SECONDS:-0}"
HAM_REQUIRED_CHECKS_WAITED_SECONDS="${HAM_REQUIRED_CHECKS_WAITED_SECONDS:-0}"
export HAM_HEAD_WAITED_SECONDS HAM_REQUIRED_CHECKS_WAITED_SECONDS
ham_wait_for_published_head() {
  local started deadline now remaining poll_interval=2 probe_timeout probe_dir probe_exit probe_head
  started=$(date +%s)
  deadline=$((started + 300))
  while [ -n "${HAM_PUSHED_HEAD:-}" ] && [ "$POST_REMEDIATION_SHA" != "$HAM_PUSHED_HEAD" ] \
    && [ "$POST_REMEDIATION_SHA" = "${HAM_PUSHED_FROM_HEAD:-}" ]; do
    now=$(date +%s)
    HAM_HEAD_WAITED_SECONDS=$((now - started))
    if [ "$now" -ge "$deadline" ]; then
      HAM_NO_MERGE_NOTE="HAM closing status — no merge. Waited ${HAM_HEAD_WAITED_SECONDS}s for the published head and ${HAM_REQUIRED_CHECKS_WAITED_SECONDS}s for required checks on that exact head (checks wait could not start before the head appeared)."
      echo "$HAM_NO_MERGE_NOTE" >&2
      HAM_PHASE_OUTCOME=published-head-timeout
      if declare -F ham_release_merge_lease >/dev/null; then ham_release_merge_lease || return 1; fi
      return 20
    fi
    remaining=$((deadline - now))
    if [ "$remaining" -gt "$poll_interval" ]; then remaining="$poll_interval"; fi
    sleep "$remaining"
    poll_interval=15
    remaining=$((deadline - $(date +%s)))
    if [ "$remaining" -le 0 ]; then continue; fi
    probe_timeout="$remaining"
    if [ "$probe_timeout" -gt 30 ]; then probe_timeout=30; fi
    HAM_PHASE_OUTCOME=published-head-probe-directory-failed
    probe_dir=$(mktemp -d "<<RUN_DIR>>/head-probe.XXXXXX") || return 1
    if /usr/bin/perl -e 'alarm shift; exec @ARGV' "$probe_timeout" "${HAM_NODE_BIN:-node}" <<ROOT_DIR>>/bin/hammer-pr-read.mjs <<REPO>> <<PR_NUMBER>> \
      --json number,headRefOid,state,isDraft,mergeable,mergeStateStatus,labels,author,baseRefName \
      > "$probe_dir/pr.json" 2> "$probe_dir/stderr"; then
      if ! probe_head=$(jq -er '.headRefOid | select(type == "string") | select(test("^[0-9a-fA-F]{40}$"))' "$probe_dir/pr.json"); then
        rm -rf "$probe_dir"
        HAM_PHASE_OUTCOME=published-head-probe-invalid
        return 1
      fi
      mv "$probe_dir/pr.json" "<<RUN_DIR>>/pr-after.json" || { rm -rf "$probe_dir"; HAM_PHASE_OUTCOME=published-head-snapshot-write-failed; return 1; }
      POST_REMEDIATION_SHA="$probe_head"
      rm -rf "$probe_dir"
    else
      probe_exit=$?
      cat "$probe_dir/stderr" >&2
      # Keep the last valid read; transport failures consume the visibility budget.
      if [ "$probe_exit" -eq 142 ] || sed '/^\[load-aware-timeout\]/d' "$probe_dir/stderr" | grep -Eiq 'Something went wrong while executing your query|"type"[[:space:]]*:[[:space:]]*"INTERNAL"|HTTP[^[:space:]]*[[:space:]]+5[0-9][0-9]|"status"[[:space:]]*:[[:space:]]*5[0-9][0-9]|timed? out|timeout|TLS|connection (reset|refused|aborted)|temporar(y|ily)|resource temporarily unavailable|rate limit|HTTP[ /]5[0-9][0-9]([^0-9]|$)|(^|[^0-9])50[234] (Bad Gateway|Service Unavailable|Gateway Timeout)|bad gateway|service unavailable|gateway timeout'; then
        rm -rf "$probe_dir"
        continue
      fi
      rm -rf "$probe_dir"
      HAM_PHASE_OUTCOME=published-head-probe-failed
      return "$probe_exit"
    fi
    HAM_HEAD_WAITED_SECONDS=$(( $(date +%s) - started ))
  done
}
ham_wait_for_published_head || return $?
BASE_BRANCH=$(jq -r '.baseRefName' "<<RUN_DIR>>/pr-after.json")
HAM_VALIDATION_BASE_SHA="${HAM_VALIDATION_BASE_SHA:-}"
HAM_FORCE_REVALIDATION=0
HAM_REBASE_ATTEMPTS="${HAM_REBASE_ATTEMPTS:-0}"
HAM_REBASE_ATTEMPT_CAP="${HAM_REBASE_ATTEMPT_CAP:-3}"
HAM_UPDATE_BRANCH_RETRY_CAP="${HAM_UPDATE_BRANCH_RETRY_CAP:-3}"
HAM_MERGE_LEASE_WAIT_SECONDS="${HAM_MERGE_LEASE_WAIT_SECONDS:-900}"
HAM_MERGE_LEASE_RELEASE_RETRY_CAP="${HAM_MERGE_LEASE_RELEASE_RETRY_CAP:-3}"
HAM_MERGE_LEASE_ID="${HAM_MERGE_LEASE_ID:-}"
HAM_MERGE_LEASE_HELD="${HAM_MERGE_LEASE_HELD:-0}"
HAM_MERGE_LEASE_RETRYABLE_ABORT="${HAM_MERGE_LEASE_RETRYABLE_ABORT:-0}"
HAM_MERGE_LEASE_RETRYABLE_ABORT_REASON="${HAM_MERGE_LEASE_RETRYABLE_ABORT_REASON:-}"
if [ "$HAM_MERGE_LEASE_HELD" -eq 1 ] && [ -z "$HAM_MERGE_LEASE_ID" ]; then
  HAM_PHASE_OUTCOME=merge-lease-id-missing
  echo 'HAM hard-blocker: held merge lease has no id' >&2
  return 1
fi
HAM_NODE_BIN="${HAM_NODE_BIN:-$(command -v node 2>/dev/null || true)}"
if [ -z "$HAM_NODE_BIN" ] && [ -x /opt/homebrew/bin/node ]; then
  HAM_NODE_BIN="/opt/homebrew/bin/node"
fi
if [ -z "$HAM_NODE_BIN" ] && [ -x /usr/local/bin/node ]; then
  HAM_NODE_BIN="/usr/local/bin/node"
fi
if [ -z "$HAM_NODE_BIN" ]; then
  HAM_PHASE_OUTCOME=node-runtime-unavailable
  echo "HAM hard-blocker: node runtime not found; cannot run AMA lease, predicate, or audit helpers" >&2
  return 1
fi

ham_mark_merge_lease_retryable_abort() {
  HAM_MERGE_LEASE_RETRYABLE_ABORT=1
  HAM_MERGE_LEASE_RETRYABLE_ABORT_REASON="${1:-retryable-abort}"
}

ham_release_merge_lease() {
  # During cancellation only the outer controller can establish group drain.
  # Keep the acquisition receipt for its generation-fenced fallback release.
  if [ -n "${HAM_CONTROLLER_RECORD:-}" ]; then
    if [ "${HAM_CONTROLLER_CANCELLED:-0}" -eq 1 ]; then HAM_PHASE_OUTCOME=controller-cancelled; return 125; fi
    "$HAM_NODE_BIN" "<<ROOT_DIR>>/bin/hammer-controller.mjs" assert-owner || {
      local ham_owner_status=$?
      if [ "$ham_owner_status" -eq 75 ]; then HAM_PHASE_OUTCOME=controller-observation-unavailable
      else HAM_PHASE_OUTCOME=controller-owner-lost; fi
      return 125
    }
  fi
  if [ "${HAM_MERGE_LEASE_HELD:-0}" -eq 1 ] && [ -n "${HAM_MERGE_LEASE_ID:-}" ]; then
    local ham_release_retryable_args=()
    if [ "${HAM_POST_STATE:-}" = "MERGED" ] && [ "${HAM_POST_HEAD:-}" = "${POST_REMEDIATION_SHA:-}" ] && [ -n "${POST_REMEDIATION_SHA:-}" ]; then
      ham_release_retryable_args=(--merged --reason merged)
    elif [ "${HAM_MERGE_LEASE_RETRYABLE_ABORT:-0}" -eq 1 ]; then
      ham_release_retryable_args=(--retryable-abort "${HAM_MERGE_LEASE_RETRYABLE_ABORT_REASON:-retryable-abort}")
    elif [ "${1:-}" = "--yield" ]; then
      ham_release_retryable_args=(--yield --reason "${2:-required-checks-wait}")
    else
      ham_release_retryable_args=(--reason "${HAM_PHASE_OUTCOME:-holder-release}")
    fi
    ham_release_attempt=1
    while [ "$ham_release_attempt" -le "$HAM_MERGE_LEASE_RELEASE_RETRY_CAP" ]; do
      if "$HAM_NODE_BIN" <<ROOT_DIR>>/bin/merge-lease.mjs release \
        --repo <<REPO>> \
        --base "$BASE_BRANCH" \
        --pr <<PR_NUMBER>> \
        --lease-id "$HAM_MERGE_LEASE_ID" \
        "${ham_release_retryable_args[@]+"${ham_release_retryable_args[@]}"}" \
        > "<<RUN_DIR>>/merge-lease-release.json"; then
        HAM_MERGE_LEASE_HELD=0
        HAM_MERGE_LEASE_ID=""
        HAM_MERGE_LEASE_RETRYABLE_ABORT=0
        HAM_MERGE_LEASE_RETRYABLE_ABORT_REASON=""
        trap - EXIT
        return 0
      else
        HAM_MERGE_LEASE_RELEASE_EXIT=$?
      fi
      echo "AMG-04 warning: merge lease release attempt ${ham_release_attempt}/${HAM_MERGE_LEASE_RELEASE_RETRY_CAP} failed for lease ${HAM_MERGE_LEASE_ID} (exit ${HAM_MERGE_LEASE_RELEASE_EXIT}); keeping EXIT trap armed" >&2
      cat "<<RUN_DIR>>/merge-lease-release.json" >&2 || true
      if [ "$ham_release_attempt" -ge "$HAM_MERGE_LEASE_RELEASE_RETRY_CAP" ]; then
        echo "AMG-04 hard-blocker: merge lease release failed after ${HAM_MERGE_LEASE_RELEASE_RETRY_CAP} attempts; do not continue while the lease is unconfirmed" >&2
        HAM_PHASE_OUTCOME=merge-lease-release-unconfirmed
        return "$HAM_MERGE_LEASE_RELEASE_EXIT"
      fi
      sleep $((ham_release_attempt * 2))
      ham_release_attempt=$((ham_release_attempt + 1))
    done
    HAM_PHASE_OUTCOME=merge-lease-release-unconfirmed
    return 1
  fi
}

# Read the full stderr on each bounded attempt; permanent failures stay fatal.
ham_lease_pr_view() {
  local attempt=1 err rc
  HAM_LEASE_PROBE_TRANSIENT=0
  err=$(mktemp "${TMPDIR:-/tmp}/ham-lease-probe.XXXXXX") || { HAM_PHASE_OUTCOME=merge-lease-probe-directory-failed; return 1; }
  while true; do
    if ham_pr "$@" 2>"$err"; then
      HAM_LEASE_PROBE_TRANSIENT=0
      rm -f "$err"
      return 0
    else
      rc=$?
    fi
    cat "$err" >&2
    if [ "$rc" -eq 142 ] || sed '/^\[load-aware-timeout\]/d' "$err" | grep -Eiq 'Something went wrong while executing your query|"type"[[:space:]]*:[[:space:]]*"INTERNAL"|HTTP[^[:space:]]*[[:space:]]+5[0-9][0-9]|"status"[[:space:]]*:[[:space:]]*5[0-9][0-9]|timed? out|timeout|TLS|connection (reset|refused|aborted)|temporar(y|ily)|resource temporarily unavailable|rate limit|HTTP[ /]5[0-9][0-9]([^0-9]|$)|(^|[^0-9])50[234] (Bad Gateway|Service Unavailable|Gateway Timeout)|bad gateway|service unavailable|gateway timeout'; then
      HAM_LEASE_PROBE_TRANSIENT=1
    else
      HAM_LEASE_PROBE_TRANSIENT=0
      rm -f "$err"
      HAM_PHASE_OUTCOME=merge-lease-probe-failed
      return "$rc"
    fi
    if [ "$attempt" -ge 3 ]; then
      rm -f "$err"
      HAM_LEASE_PROBE_TRANSIENT=0
      HAM_PHASE_OUTCOME=merge-lease-probe-failed
      return "$rc"
    fi
    sleep "$attempt"
    attempt=$((attempt + 1))
  done
}

ham_acquire_merge_lease() {
  HAM_PHASE_OUTCOME=merge-lease-admission-failed
  # HQ cancellation only owns the recorded worker group. Dispatched closers
  # must enter the versioned, launch-bound controller before taking a lease,
  # and take it only on a fresh permitted launch read.
  if [ -n "${HQ_LAUNCH_REQUEST_ID:-${AGENT_OS_WORKER_LRQ_ID:-${LAUNCH_REQUEST_ID:-}}}" ]; then
    "$HAM_NODE_BIN" "<<ROOT_DIR>>/bin/hammer-controller.mjs" assert-launch || return 125
  fi
  local ham_lease_wait_retry=${1:-0}
  if ! [[ "$POST_REMEDIATION_SHA" =~ ^[0-9a-fA-F]{40}$ ]]; then
    echo "AMG-04 hard-blocker: merge lease head is not a full SHA" >&2
    return 1
  fi
  local ham_required_checks_green_args=()
  ham_lease_pr_view --json body,headRefOid,state,isDraft,labels,statusCheckRollup \
    > "<<RUN_DIR>>/pre-acquire-checks.json" || return 1
  # Live holds/terminal state fence the lane. Historical stops were already
  # evaluated (and, on changed inputs, released) by the closer before dispatch.
  local ham_admission_reason ham_admission_outcome ham_admission_audit ham_admission_audit_exit
  ham_admission_reason=$(HAM_ADMISSION_ROOT=<<ROOT_DIR>> "$HAM_NODE_BIN" --input-type=module - "$POST_REMEDIATION_SHA" "<<RUN_DIR>>/pre-acquire-checks.json" <<'NODE'
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const { mergeLeaseAdmissionReason } = await import(pathToFileURL(`${process.env.HAM_ADMISSION_ROOT}/src/ama/merge-lease-admission.mjs`));
const pr = JSON.parse(readFileSync(process.argv[3], 'utf8'));
console.log(mergeLeaseAdmissionReason(pr, process.argv[2]) || '');
NODE
  ) || return 1
  if [ -n "$ham_admission_reason" ]; then
    if [ "$ham_admission_reason" = pr-merged ]; then
      HAM_PHASE_OUTCOME=already-merged
      return 20
    fi
    echo "HAM lease admission refused: $ham_admission_reason" >&2
    # Live closure gates are not terminal hammer judgements. Removing a hold or
    # leaving draft must not require an unrelated base/check change to resume.
    ham_admission_outcome=failed-without-merge
    case "$ham_admission_reason" in
      operator-hold|pr-is-draft) ham_admission_outcome=deferred ;;
      head-changed) ham_admission_outcome=superseded ;;
    esac
    ham_admission_audit=$(mktemp "${TMPDIR:-/tmp}/ham-admission-audit.XXXXXX") || return 1
    jq -n --arg reason "merge-lease-admission:$ham_admission_reason" \
      --arg reviewedHead "<<REVIEWED_SHA>>" --arg validatedHead "$POST_REMEDIATION_SHA" \
      '{reason: $reason, reviewedHead: $reviewedHead, validatedHead: $validatedHead,
        attemptPhase: "hammer-lease-admission"}' > "$ham_admission_audit" || { rm -f "$ham_admission_audit"; return 1; }
    if "$HAM_NODE_BIN" <<ROOT_DIR>>/bin/ama-audit.mjs append \
      --hq-root <<HQ_ROOT>> --repo <<REPO>> --pr <<PR_NUMBER>> \
      --head "$POST_REMEDIATION_SHA" --outcome "$ham_admission_outcome" \
      --closure-authority ham-terminal-remediation \
      --reviewer <<REVIEWER>> --risk-class <<RISK_CLASS>> \
      --attempt-json "$ham_admission_audit"; then
      ham_admission_audit_exit=0
    else
      ham_admission_audit_exit=$?
    fi
    rm -f "$ham_admission_audit"
    if [ "$ham_admission_audit_exit" -eq 65 ]; then
      # A sticky success may have won after the admission read.
      [ "$(ham_lease_pr_view --json state --jq '.state')" = MERGED ] || return 1
      HAM_PHASE_OUTCOME=already-merged
      return 20
    fi
    [ "$ham_admission_audit_exit" -eq 0 ] || return "$ham_admission_audit_exit"
    HAM_PHASE_OUTCOME=merge-lease-admission-refused
    return 20
  fi
  ham_lease_snapshot_green() {
    HAM_CHECKS_ROOT=<<ROOT_DIR>> "$HAM_NODE_BIN" --input-type=module - "$POST_REMEDIATION_SHA" "<<RUN_DIR>>/pre-acquire-checks.json" <<'NODE'
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const { summarizeChecksConclusion } = await import(pathToFileURL(`${process.env.HAM_CHECKS_ROOT}/src/checks-summary.mjs`));
const pr = JSON.parse(readFileSync(process.argv[3], 'utf8'));
process.exit(pr.state === 'OPEN' && pr.headRefOid === process.argv[2]
  && summarizeChecksConclusion(pr.statusCheckRollup) === 'SUCCESS' ? 0 : 1);
NODE
  }
  if ham_lease_snapshot_green; then
    ham_required_checks_green_args=(--required-checks-green)
  fi
  # The procedure wrapper preserves live stderr on descriptor 3. Direct
  # callers without that descriptor still receive progress on stderr.
  local ham_lease_progress_fd=2
  if ( : >&3 ) 2>/dev/null; then ham_lease_progress_fd=3; fi
  HAM_PHASE_OUTCOME=merge-lease-base-read-failed
  ham_capture_current_base_sha || return 1
  if "$HAM_NODE_BIN" <<ROOT_DIR>>/bin/merge-lease.mjs acquire \
    --repo <<REPO>> \
    --base "$BASE_BRANCH" \
    --base-sha "$HAM_CAPTURED_BASE_SHA" \
    --pr <<PR_NUMBER>> \
    --head "$POST_REMEDIATION_SHA" \
    --pr-state-file "<<RUN_DIR>>/pre-acquire-checks.json" \
    --owner-pid "$$" \
    --wait "$HAM_MERGE_LEASE_WAIT_SECONDS" --wait-for-holder-deadline --wait-by-progress \
    "${ham_required_checks_green_args[@]+"${ham_required_checks_green_args[@]}"}" \
    > "<<RUN_DIR>>/merge-lease-acquire.json" 2>&"$ham_lease_progress_fd"; then
    HAM_MERGE_LEASE_ACQUIRE_EXIT=0
  else
    HAM_MERGE_LEASE_ACQUIRE_EXIT=$?
  fi
  HAM_PHASE_OUTCOME=merge-lease-response-invalid
  if [ "$HAM_MERGE_LEASE_ACQUIRE_EXIT" -eq 70 ] \
    && [ "$(jq -r '.parked // false' "<<RUN_DIR>>/merge-lease-acquire.json")" = "true" ]; then
    HAM_PARK_REASON=$(jq -r '.reason // "merge-lease-parked"' "<<RUN_DIR>>/merge-lease-acquire.json")
    HAM_GATE_CAP_CLOSING_STATUS=$(jq -r '.closingStatus // empty' "<<RUN_DIR>>/merge-lease-acquire.json")
    if [ -z "$HAM_GATE_CAP_CLOSING_STATUS" ]; then
      echo "AMG-04 hard-blocker: parked lease response omitted closingStatus" >&2
      return 1
    fi
    echo "AMG-04 parked: merge lease acquisition parked PR <<PR_NUMBER>> ($HAM_PARK_REASON)" >&2
    echo "$HAM_GATE_CAP_CLOSING_STATUS" >&2
    ham_gate_cap_attempt_json=$(mktemp "${TMPDIR:-/tmp}/ham-gate-cap-audit.XXXXXX") || return 1
    jq -n --arg reason "$HAM_PARK_REASON" --arg closingStatus "$HAM_GATE_CAP_CLOSING_STATUS" \
      '{reason: $reason, closingStatus: $closingStatus, attemptPhase: "hammer-gate-attempt-cap"}' \
      > "$ham_gate_cap_attempt_json"
    if "$HAM_NODE_BIN" <<ROOT_DIR>>/bin/ama-audit.mjs append \
      --hq-root <<HQ_ROOT>> --repo <<REPO>> --pr <<PR_NUMBER>> \
      --head "$POST_REMEDIATION_SHA" --outcome failed-without-merge \
      --closure-authority ham-terminal-remediation \
      --reviewer <<REVIEWER>> --risk-class <<RISK_CLASS>> \
      --attempt-json "$ham_gate_cap_attempt_json"; then
      HAM_GATE_CAP_AUDIT_EXIT=0
    else
      HAM_GATE_CAP_AUDIT_EXIT=$?
    fi
    rm -f "$ham_gate_cap_attempt_json"
    if [ "$HAM_GATE_CAP_AUDIT_EXIT" -eq 65 ]; then
      # Sticky succeeded means a prior merge won. Confirm live state before
      # suppressing a no-merge status for this head.
      HAM_GATE_CAP_LIVE_STATE=$(ham_pr --json state --jq '.state') || return 1
      [ "$HAM_GATE_CAP_LIVE_STATE" = "MERGED" ] || return 1
      HAM_PHASE_OUTCOME=already-merged
      return 20
    fi
    [ "$HAM_GATE_CAP_AUDIT_EXIT" -eq 0 ] || return "$HAM_GATE_CAP_AUDIT_EXIT"
    # Refresh before selecting recovery. The page path is durable and deduped;
    # a conflicting current head returns to the existing conflict procedure.
    ham_lease_pr_view --json body,headRefOid,state,isDraft,labels,mergeable,mergeStateStatus \
      > "<<RUN_DIR>>/gate-cap-pr.json" || return 1
    "$HAM_NODE_BIN" <<ROOT_DIR>>/bin/merge-lease.mjs recover-cap \
      --repo <<REPO>> --pr <<PR_NUMBER>> --head "$POST_REMEDIATION_SHA" \
      --pr-state-file "<<RUN_DIR>>/gate-cap-pr.json" \
      > "<<RUN_DIR>>/gate-cap-recovery.json" || return 1
    if [ -z "${HAMMER_LACEY_GH_TOKEN:-${HAMMER_LACEY_GH_TOKEN_REFRESH_COMMAND:-${MERGE_AGENT_GH_TOKEN:-${MERGE_AGENT_GH_TOKEN_REFRESH_COMMAND:-${HQ_ENTITLEMENT_GH_TOKEN_REFRESH_COMMAND:-}}}}}" ]; then
      echo "HAM hard-blocker: no entitled hammer token for gate-cap closing status" >&2
      return 1
    fi
    HAM_GATE_CAP_MARKER="<!-- hq:ham-gate-attempt-cap:$POST_REMEDIATION_SHA -->"
    HAM_GATE_CAP_COMMENT="$HAM_GATE_CAP_MARKER
HAM closing status — no merge. The lease admission cap ($HAM_PARK_REASON) stopped this head before lease acquisition; no merge lease is held or needs release. $HAM_GATE_CAP_CLOSING_STATUS"
    ham_gate_cap_gh_transient() {
      sed '/^\[load-aware-timeout\]/d' "$1" | grep -Eiq 'Something went wrong while executing your query|"type"[[:space:]]*:[[:space:]]*"INTERNAL"|HTTP[^[:space:]]*[[:space:]]+5[0-9][0-9]|"status"[[:space:]]*:[[:space:]]*5[0-9][0-9]|timeout|timed out|TLS|connection reset|connection refused|temporar(y|ily)|try again|rate limit|secondary rate limit|HTTP 5[0-9][0-9]|502|503|504|service unavailable|gateway'
    }
    # All comment operations share the same bounded retry and transient test.
    ham_gate_cap_gh() {
      local ham_out="$1" ham_err="$2"
      shift 2
      local ham_attempt=1
      while [ "$ham_attempt" -le 3 ]; do
        if ham_gh "$@" > "$ham_out" 2> "$ham_err"; then
          return 0
        fi
        if [ "$ham_attempt" -ge 3 ] || ! ham_gate_cap_gh_transient "$ham_err"; then
          cat "$ham_err" >&2
          return 1
        fi
        sleep $((ham_attempt * 2))
        ham_attempt=$((ham_attempt + 1))
      done
    }
    HAM_GATE_CAP_OUT=$(mktemp "${TMPDIR:-/tmp}/ham-gate-cap-out.XXXXXX") || return 1
    HAM_GATE_CAP_ERR=$(mktemp "${TMPDIR:-/tmp}/ham-gate-cap-err.XXXXXX") || return 1
    ham_gate_cap_gh "$HAM_GATE_CAP_OUT" "$HAM_GATE_CAP_ERR" api --paginate \
      "repos/<<REPO>>/issues/<<PR_NUMBER>>/comments" \
      -q '.[] | {id: .id, body: .body}' || { rm -f "$HAM_GATE_CAP_OUT" "$HAM_GATE_CAP_ERR"; return 1; }
    HAM_GATE_CAP_COMMENT_RECORD=$(jq -sc --arg marker "$HAM_GATE_CAP_MARKER" --arg head "$POST_REMEDIATION_SHA" '
      map(select((.body // "") as $body |
        ($body | contains($marker)) or
        (($body | contains("<!-- hq:ham-terminal-remediation:audit -->")) and
         ($body | contains("HAM-Terminal-Remediation-Head: " + $head))))) | first // empty
    ' "$HAM_GATE_CAP_OUT")
    HAM_GATE_CAP_COMMENT_ID=$(printf '%s' "$HAM_GATE_CAP_COMMENT_RECORD" | jq -r '.id // empty')
    if [ -n "$HAM_GATE_CAP_COMMENT_ID" ]; then
      HAM_GATE_CAP_EXISTING_BODY=$(printf '%s' "$HAM_GATE_CAP_COMMENT_RECORD" | jq -r '.body // ""')
      if [[ "$HAM_GATE_CAP_EXISTING_BODY" == *'<!-- hq:ham-terminal-remediation:audit -->'* ]]; then
        # Keep the machine-parsed audit and append the closing status once.
        HAM_GATE_CAP_COMMENT="$HAM_GATE_CAP_EXISTING_BODY

$HAM_GATE_CAP_COMMENT"
      fi
      HAM_GATE_CAP_COMMENT=$(printf '%s' "$HAM_GATE_CAP_COMMENT" |
        "$HAM_NODE_BIN" <<ROOT_DIR>>/bin/github-outbound-body.mjs <<REPO>> "$POST_REMEDIATION_SHA" <<ROOT_DIR>>) || HAM_GATE_CAP_COMMENT='<local>'
      ham_gate_cap_gh "$HAM_GATE_CAP_OUT" "$HAM_GATE_CAP_ERR" api --method PATCH \
        "repos/<<REPO>>/issues/comments/$HAM_GATE_CAP_COMMENT_ID" \
        -f body="$HAM_GATE_CAP_COMMENT" || { rm -f "$HAM_GATE_CAP_OUT" "$HAM_GATE_CAP_ERR"; return 1; }
    else
      HAM_GATE_CAP_COMMENT=$(printf '%s' "$HAM_GATE_CAP_COMMENT" |
        "$HAM_NODE_BIN" <<ROOT_DIR>>/bin/github-outbound-body.mjs <<REPO>> "$POST_REMEDIATION_SHA" <<ROOT_DIR>>) || HAM_GATE_CAP_COMMENT='<local>'
      ham_gate_cap_gh "$HAM_GATE_CAP_OUT" "$HAM_GATE_CAP_ERR" pr comment <<PR_URL>> \
        --body "$HAM_GATE_CAP_COMMENT" || { rm -f "$HAM_GATE_CAP_OUT" "$HAM_GATE_CAP_ERR"; return 1; }
    fi
    rm -f "$HAM_GATE_CAP_OUT" "$HAM_GATE_CAP_ERR"
    if [ "$(jq -r '.action' "<<RUN_DIR>>/gate-cap-recovery.json")" = resolve-conflict ]; then
      HAM_PHASE_OUTCOME=rebase-conflict
      return 21
    fi
    HAM_PHASE_OUTCOME="parked:${HAM_PARK_REASON}"
    return 20
  fi
  if [ "$HAM_MERGE_LEASE_ACQUIRE_EXIT" -eq 75 ] \
    && [ "$(jq -r '.timedOut // false' "<<RUN_DIR>>/merge-lease-acquire.json")" = "true" ]; then
    HAM_PARK_WAITED=$(jq -c '.waited_s // null' "<<RUN_DIR>>/merge-lease-acquire.json")
    local ham_lease_wait_green=false ham_lease_wait_retrying=false
    if ham_lease_pr_view --json body,headRefOid,state,isDraft,labels,statusCheckRollup \
      > "<<RUN_DIR>>/pre-acquire-checks.json" && ham_lease_snapshot_green; then
      ham_lease_wait_green=true
      if [ "$ham_lease_wait_retry" -lt 2 ]; then ham_lease_wait_retrying=true; fi
    fi
    echo "AMG-04 deferred: $(jq -r '.closingStatus // "lease wait exhausted behind unknown holders"' "<<RUN_DIR>>/merge-lease-acquire.json"); waited ${HAM_PARK_WAITED}s; in-run retry=${ham_lease_wait_retrying}" >&2
    HAM_PHASE_OUTCOME=merge-lease-deferral-audit-failed
    cp "<<RUN_DIR>>/merge-lease-acquire.json" "<<RUN_DIR>>/merge-lease-wait-${ham_lease_wait_retry}.json" || return 1
    ham_park_json=$(mktemp "${TMPDIR:-/tmp}/ham-lease-park.XXXXXX") || return 1
    jq --argjson waited_s "$HAM_PARK_WAITED" --argjson configured_s "$HAM_MERGE_LEASE_WAIT_SECONDS" \
      --argjson green "$ham_lease_wait_green" --argjson retrying "$ham_lease_wait_retrying" \
      '{outcome:"deferred",reason:"merge-lease-timeout",waited_s:$waited_s,configured_s:$configured_s,
        leaseWaitExhausted:$green,inRunRetry:$retrying,holders:(.holders // []),
        waitReason:.reason,closingStatus:.closingStatus}' "<<RUN_DIR>>/merge-lease-acquire.json" > "$ham_park_json"
    if "$HAM_NODE_BIN" <<ROOT_DIR>>/bin/ama-audit.mjs append --hq-root <<HQ_ROOT>> \
      --root-dir <<ROOT_DIR>> --lease-head <<TARGET_REMEDIATION_SHA>> \
      --repo <<REPO>> --pr <<PR_NUMBER>> --head "$POST_REMEDIATION_SHA" \
      --outcome deferred --closure-authority ham-terminal-remediation \
      --reviewer <<REVIEWER>> --risk-class <<RISK_CLASS>> --attempt-json "$ham_park_json"; then
      HAM_PARK_AUDIT_EXIT=0
    else
      HAM_PARK_AUDIT_EXIT=$?
    fi
    rm -f "$ham_park_json"
    if [ "$HAM_PARK_AUDIT_EXIT" -eq 65 ]; then
      HAM_PARK_LIVE_STATE=$(ham_lease_pr_view --json state --jq '.state') || return 1
      [ "$HAM_PARK_LIVE_STATE" = "MERGED" ] || return 1
      HAM_PHASE_OUTCOME=already-merged
      return 20
    elif [ "$HAM_PARK_AUDIT_EXIT" -ne 0 ]; then
      echo "AMG-04 warning: lease-timeout park audit failed (exit ${HAM_PARK_AUDIT_EXIT}); retaining contention outcome" >&2
    fi
    if [ "$ham_lease_wait_retrying" = true ]; then
      # Re-enter admission and the live exact-head CI snapshot for each retry.
      # The acquisition cap refunded contention; no failed merge was attempted.
      ham_acquire_merge_lease "$((ham_lease_wait_retry + 1))"
      return $?
    fi
    HAM_PHASE_OUTCOME=parked:merge-lease-timeout
    return 20
  fi
  if [ "$HAM_MERGE_LEASE_ACQUIRE_EXIT" -ne 0 ]; then
    cat "<<RUN_DIR>>/merge-lease-acquire.json" >&2
    HAM_PHASE_OUTCOME=merge-lease-acquire-failed
    return "$HAM_MERGE_LEASE_ACQUIRE_EXIT"
  fi
  HAM_MERGE_LEASE_ID=$(jq -r '.leaseId // empty' "<<RUN_DIR>>/merge-lease-acquire.json")
  if [ -z "$HAM_MERGE_LEASE_ID" ]; then
    echo "AMG-04 hard-blocker: merge lease acquired without leaseId" >&2
    HAM_PHASE_OUTCOME=merge-lease-id-missing
    return 1
  fi
  HAM_MERGE_LEASE_HELD=1
  # Retryable-abort state belongs to the released acquisition, never its successor.
  HAM_MERGE_LEASE_RETRYABLE_ABORT=0
  HAM_MERGE_LEASE_RETRYABLE_ABORT_REASON=""
  trap ham_release_merge_lease EXIT
}

ham_update_branch_conflict() {
  grep -Eiq 'conflict|cannot be rebased|resolve conflicts' "$1"
}

ham_update_branch_transient() {
  sed '/^\[load-aware-timeout\]/d' "$1" | grep -Eiq 'Something went wrong while executing your query|"type"[[:space:]]*:[[:space:]]*"INTERNAL"|HTTP[^[:space:]]*[[:space:]]+5[0-9][0-9]|"status"[[:space:]]*:[[:space:]]*5[0-9][0-9]|timeout|timed out|TLS|connection reset|connection refused|temporar(y|ily)|try again|rate limit|secondary rate limit|HTTP 5[0-9][0-9]|502|503|504|service unavailable|gateway'
}

ham_is_full_sha() {
  printf '%s' "$1" | grep -Eiq '^[0-9a-f]{40}$'
}

HAM_GIT_SYNC_NOMINAL_SECONDS="${HAM_GIT_SYNC_NOMINAL_SECONDS:-120}"
ham_bounded_git_sync() {
  ham_git_sync_attempt=1
  while [ "$ham_git_sync_attempt" -le 2 ]; do
    ham_git_sync_timeout=$("$HAM_NODE_BIN" <<ROOT_DIR>>/bin/load-aware-timeout.mjs "$HAM_GIT_SYNC_NOMINAL_SECONDS" 2>/dev/null || true)
    case "$ham_git_sync_timeout" in
      ''|*[!0-9]*|0) ham_git_sync_timeout="$HAM_GIT_SYNC_NOMINAL_SECONDS" ;;
    esac
    ham_git_sync_stderr=$(mktemp "${TMPDIR:-/tmp}/ham-git-sync-<<PR_NUMBER>>.XXXXXX") || return 1
    if /usr/bin/perl -e '
      use Errno qw(EINTR);
      my $seconds = shift;
      my $child = fork();
      die "git fetch fork failed: $!" unless defined $child;
      if ($child == 0) { exec @ARGV or die "git fetch exec failed: $!"; }
      my $timed_out = 0;
      $SIG{ALRM} = sub {
        $timed_out = 1;
        kill "TERM", $child;
        alarm 5;
        $SIG{ALRM} = sub { kill "KILL", $child; };
      };
      alarm $seconds;
      my $waited;
      do { $waited = waitpid($child, 0); } while ($waited == -1 && $! == EINTR);
      my $status = $?;
      alarm 0;
      exit($timed_out ? 124 : ($status & 127 ? 128 + ($status & 127) : $status >> 8));
    ' "$ham_git_sync_timeout" git fetch --prune origin "$@" 2>"$ham_git_sync_stderr"; then
      rm -f "$ham_git_sync_stderr"
      return 0
    else
      ham_git_sync_exit=$?
    fi
    cat "$ham_git_sync_stderr" >&2
    if [ "$ham_git_sync_exit" -eq 124 ]; then
      echo "git fetch timed out after ${ham_git_sync_timeout}s; SIGTERM cleanup completed" >&2
    elif ! ham_update_branch_transient "$ham_git_sync_stderr"; then
      rm -f "$ham_git_sync_stderr"
      return 1
    fi
    rm -f "$ham_git_sync_stderr"
    if [ "$ham_git_sync_attempt" -ge 2 ]; then
      return 1
    fi
    sleep 5
    ham_git_sync_attempt=$((ham_git_sync_attempt + 1))
  done
  return 1
}

ham_fetch_base_with_retries() {
  ham_bounded_git_sync "$BASE_BRANCH" \
    > "<<RUN_DIR>>/fetch-base.stdout" \
    2> "<<RUN_DIR>>/fetch-base.stderr"
}

ham_capture_current_base_sha() {
  if ! ham_fetch_base_with_retries; then
    return 1
  fi
  HAM_CAPTURED_BASE_SHA=$(git rev-parse FETCH_HEAD 2>"<<RUN_DIR>>/rev-parse-base.stderr" || true)
  ham_is_full_sha "$HAM_CAPTURED_BASE_SHA"
}

ham_update_branch_with_retries() {
  local ham_update_pr_id
  ham_update_attempt=1
  while [ "$ham_update_attempt" -le "$HAM_UPDATE_BRANCH_RETRY_CAP" ]; do
    if ham_update_pr_id=$(ham_pr --json id --jq '.id' 2> "<<RUN_DIR>>/update-branch.stderr"); then
      [ -n "$ham_update_pr_id" ] && [ "$ham_update_pr_id" != null ] || return 1
      if [ -n "${ham_rebase_ci_deadline:-}" ] && [ "$(date +%s)" -ge "$ham_rebase_ci_deadline" ]; then
        return 3
      fi
      # Bind provenance to the mutation result, never a later mutable branch tip.
      # https://docs.github.com/en/graphql/reference/pulls#updatepullrequestbranch
      if ham_gh api graphql \
        -f 'query=mutation($id: ID!, $head: GitObjectID!) { updatePullRequestBranch(input: {pullRequestId: $id, expectedHeadOid: $head, updateMethod: REBASE}) { pullRequest { headRefOid } } }' \
        -f id="$ham_update_pr_id" -f head="$POST_REMEDIATION_SHA" \
        > "<<RUN_DIR>>/update-branch.stdout" 2> "<<RUN_DIR>>/update-branch.stderr"; then
        HAM_REBASE_PUBLISHED_HEAD=$(jq -er '.data.updatePullRequestBranch.pullRequest.headRefOid |
          select(type == "string" and test("^[a-f0-9]{40}$"))' "<<RUN_DIR>>/update-branch.stdout") || return 1
        return 0
      fi
    fi
    if ham_update_branch_conflict "<<RUN_DIR>>/update-branch.stderr"; then
      return 2
    fi
    if ! ham_update_branch_transient "<<RUN_DIR>>/update-branch.stderr"; then
      return 1
    fi
    if [ "$ham_update_attempt" -ge "$HAM_UPDATE_BRANCH_RETRY_CAP" ]; then
      return 1
    fi
    sleep $((ham_update_attempt * 5))
    ham_update_attempt=$((ham_update_attempt + 1))
  done
  return 1
}

# A successful mutation is issued only once. Poll its visibility, never repeat
# the mutation merely because its acknowledgement/snapshot still has the old SHA.
# A later SHA is not publication authority unless the old-SHA acknowledgement
# can be bound to an exact full-tree replay onto our pre-mutation base.
ham_settle_rebase_snapshot() {
  local from="$1" base="$2" async_result="$3" attempt=1 snapshot_head
  while true; do
    if ham_pr --json number,headRefOid,state,isDraft,mergeable,mergeStateStatus,labels,statusCheckRollup,author,baseRefName \
      > "<<RUN_DIR>>/pr-after.snapshot.json" 2> "<<RUN_DIR>>/update-branch.stderr"; then
      if ! jq -e --arg base "$BASE_BRANCH" '.state == "OPEN" and .baseRefName == $base' \
        "<<RUN_DIR>>/pr-after.snapshot.json" >/dev/null; then
        HAM_PHASE_OUTCOME=rebase-target-changed
        ham_release_merge_lease || return 1
        return 20
      fi
      snapshot_head=$(jq -er '.headRefOid | select(type == "string" and test("^[a-f0-9]{40}$"))' \
        "<<RUN_DIR>>/pr-after.snapshot.json") || snapshot_head=""
      if ham_is_full_sha "$snapshot_head" && [ "$snapshot_head" != "$from" ]; then
        if [ "$async_result" -eq 1 ]; then
          if ! ham_bounded_git_sync "$snapshot_head" \
            || ! /usr/bin/perl -e 'alarm shift; exec @ARGV' 90 "$HAM_NODE_BIN" "<<ROOT_DIR>>/bin/hammer-rebase-result.mjs" \
              "$from" "$snapshot_head" "$base" > "<<RUN_DIR>>/rebase-result-proof.json"; then
            HAM_PHASE_OUTCOME=rebase-result-unproven
            ham_release_merge_lease || return 1
            return 20
          fi
          HAM_REBASE_PUBLISHED_HEAD="$snapshot_head"
          POST_REMEDIATION_SHA="$snapshot_head"
        elif [ "$snapshot_head" != "$POST_REMEDIATION_SHA" ]; then
          HAM_PHASE_OUTCOME=head-changed
          ham_release_merge_lease || return 1
          return 20
        fi
        mv "<<RUN_DIR>>/pr-after.snapshot.json" "<<RUN_DIR>>/pr-after.json" || {
          HAM_PHASE_OUTCOME=rebase-snapshot-write-failed
          ham_release_merge_lease || return 1
          return 1
        }
        return 0
      fi
      # A stale BEHIND read can trigger an already-up-to-date no-op. Accept
      # the unchanged head only with complete captured-base containment.
      if [ "$async_result" -eq 1 ] && [ "$snapshot_head" = "$from" ] \
        && git merge-base --is-ancestor "$base" "$from"; then
        mv "<<RUN_DIR>>/pr-after.snapshot.json" "<<RUN_DIR>>/pr-after.json" || {
          HAM_PHASE_OUTCOME=rebase-snapshot-write-failed
          ham_release_merge_lease || return 1
          return 1
        }
        return 0
      fi
      # Only the exact old head is a visibility lag. Malformed replies fail closed.
      if [ "$snapshot_head" != "$from" ]; then
        HAM_PHASE_OUTCOME=pr-refresh-failed
        ham_release_merge_lease || return 1
        return 1
      fi
      HAM_PHASE_OUTCOME=rebase-head-timeout
    else
      HAM_PHASE_OUTCOME=pr-refresh-failed
      if ! ham_update_branch_transient "<<RUN_DIR>>/update-branch.stderr"; then
        cat "<<RUN_DIR>>/update-branch.stderr" >&2
        rm -f "<<RUN_DIR>>/pr-after.snapshot.json"
        ham_release_merge_lease || return 1
        return 1
      fi
    fi
    if [ "$attempt" -ge "$HAM_UPDATE_BRANCH_RETRY_CAP" ]; then
      cat "<<RUN_DIR>>/update-branch.stderr" >&2
      rm -f "<<RUN_DIR>>/pr-after.snapshot.json"
      ham_release_merge_lease || return 1
      return 1
    fi
    sleep $((5 * (1 << (attempt - 1))))
    attempt=$((attempt + 1))
  done
}

ham_base_touches_pr_files() {
  # HAMRESUMEOWED-01: GitHub mergeability owns the rebase decision. Main
  # touching the same file is not a conflict. Retain a CLEAN/mergeable exact
  # head and its CI; only a conflict or a policy-blocked BEHIND needs a rewrite.
  [ "${2:-}" != CONFLICTING ] || return 0
  [ "${3:-}" = BEHIND ] || return 1
  [ "${HAM_REQUIRES_UP_TO_DATE:-1}" -ne 0 ] || return 1
  # Ignore a lagging BEHIND once containment is proved. Unknown containment
  # under strict/unknown protection remains a rebase requirement.
  ham_bounded_git_sync "$BASE_BRANCH" >/dev/null 2>&1 || return 0
  local current_base_sha comparison_base
  current_base_sha=$(git rev-parse FETCH_HEAD 2>/dev/null) || return 0
  ham_is_full_sha "$current_base_sha" || return 0
  HAM_CURRENT_BASE_SHA="$current_base_sha"
  ham_is_full_sha "$POST_REMEDIATION_SHA" || return 0
  comparison_base=$(git merge-base "$POST_REMEDIATION_SHA" "$current_base_sha" 2>/dev/null) || return 0
  [ "$comparison_base" != "$current_base_sha" ]
}

# Shared by initial verification and the single in-run CI retry. GitHub publishes
# the rebased head atomically; fetch that exact result into the scratch checkout.
ham_rebase_head() {
  local ham_rebase_from="$POST_REMEDIATION_SHA" ham_rebase_base ham_async_result=0 ham_rebase_ci_deadline=""
  if [ "${1:-}" = --ci-retry ]; then ham_rebase_ci_deadline="${HAM_REMOTE_CI_DEADLINE:-}"; fi
  if ! ham_capture_current_base_sha; then
    HAM_PHASE_OUTCOME=rebase-base-unavailable
    ham_release_merge_lease || return 1
    return 1
  fi
  ham_rebase_base="$HAM_CAPTURED_BASE_SHA"
  HAM_REBASED_ONTO_BASE_SHA="$ham_rebase_base"
  if [ -n "$ham_rebase_ci_deadline" ] && [ "$(date +%s)" -ge "$ham_rebase_ci_deadline" ]; then
    export HAM_REMOTE_CI_STATUS=remote-ci-timeout
    HAM_PHASE_OUTCOME=github-gate-timeout
    ham_release_merge_lease || return 1
    return 20
  fi
  if [ "$HAM_REBASE_ATTEMPTS" -ge "$HAM_REBASE_ATTEMPT_CAP" ] && [ "${1:-}" != --ci-retry ]; then
    echo "HAM-03 hard-blocker: rebase attempt cap exceeded ($HAM_REBASE_ATTEMPTS/$HAM_REBASE_ATTEMPT_CAP)" >&2
    ham_release_merge_lease
    HAM_PHASE_OUTCOME=rebase-attempt-cap-exceeded
    return 20
  fi
  HAM_REBASE_ATTEMPTS=$((HAM_REBASE_ATTEMPTS + 1))
  ham_update_branch_with_retries
  HAM_UPDATE_BRANCH_EXIT=$?
  if [ "$HAM_UPDATE_BRANCH_EXIT" -eq 3 ]; then
    export HAM_REMOTE_CI_STATUS=remote-ci-timeout
    HAM_PHASE_OUTCOME=github-gate-timeout
    ham_release_merge_lease || return 1
    return 20
  fi
  if [ "$HAM_UPDATE_BRANCH_EXIT" -eq 2 ]; then
    # The hammer OWNS merge-conflict resolution, but NEVER while holding the
    # merge lease. Release the lease immediately, step out to the conflict
    # procedure below, resolve locally, force-push with lease, re-run the FULL
    # suite + required checks in the parallel phase, then return here and
    # re-acquire before the next rebase/merge attempt.
    echo "HAM-03 conflict: releasing merge lease before local conflict resolution" >&2
    ham_mark_merge_lease_retryable_abort server-rebase-conflict
    if ! ham_release_merge_lease; then
      echo "HAM-03 hard-blocker: cannot resolve conflict while merge lease release is unconfirmed" >&2
      HAM_PHASE_OUTCOME=merge-lease-release-unconfirmed
      return 1
    fi
    HAM_PHASE_OUTCOME=rebase-conflict
    HAM_VALIDATION_BASE_SHA=""
    return 21
  fi
  if [ "$HAM_UPDATE_BRANCH_EXIT" -ne 0 ]; then
    cat "<<RUN_DIR>>/update-branch.stderr" >&2
    ham_release_merge_lease
    HAM_PHASE_OUTCOME=update-branch-failed
    return 1
  fi
  POST_REMEDIATION_SHA="$HAM_REBASE_PUBLISHED_HEAD"
  if [ "$POST_REMEDIATION_SHA" = "$ham_rebase_from" ]; then
    ham_async_result=1
    ham_settle_rebase_snapshot "$ham_rebase_from" "$ham_rebase_base" 1 || return $?
  fi
  # A server-side rebase publishes a head too. Record its edge before scratch
  # synchronization or exact-head CI can fail, using the same App publisher.
  if ham_is_full_sha "$POST_REMEDIATION_SHA" && [ "$ham_rebase_from" != "$POST_REMEDIATION_SHA" ]; then
    HAM_PUSHED_FROM_HEAD="$ham_rebase_from"
    HAM_PUSHED_HEAD="$POST_REMEDIATION_SHA"
    export HAM_PUSHED_FROM_HEAD HAM_PUSHED_HEAD
    "$HAM_NODE_BIN" "<<ROOT_DIR>>/bin/hammer-progress.mjs" remediation-pushed || true
    if ! /usr/bin/perl -e 'alarm shift; exec @ARGV' 90 "$HAM_NODE_BIN" <<ROOT_DIR>>/bin/hammer-pushed-attestation.mjs \
      <<REPO>> <<PR_NUMBER>> "$HAM_PUSHED_FROM_HEAD" "$HAM_PUSHED_HEAD"; then
      HAM_PHASE_OUTCOME=pushed-attestation-unavailable
      printf -v HAM_NO_MERGE_NOTE '%s\nHAM-Base-Head: %s\nHAM-Pushed-Head: %s\nHAM-CI-Validated: false' \
        'HAM closing status — no merge. Rebase provenance delivery failed; retry this audit through the hammer App.' \
        "$HAM_PUSHED_FROM_HEAD" "$HAM_PUSHED_HEAD"
      echo "$HAM_NO_MERGE_NOTE" >&2
      ham_release_merge_lease || return 1
      return 1
    fi
  fi
  if [ "$ham_async_result" -eq 0 ]; then
    ham_settle_rebase_snapshot "$ham_rebase_from" "$ham_rebase_base" 0 || return $?
  fi
  # Fetch the exact result, never a branch tip that a later author push could
  # move. Refuse dirty tracked files rather than carrying them onto that head.
  if ! ham_is_full_sha "$POST_REMEDIATION_SHA" \
    || ! git diff --quiet || ! git diff --cached --quiet \
    || ! ham_bounded_git_sync "$POST_REMEDIATION_SHA" \
    || ! git checkout --detach "$POST_REMEDIATION_SHA" \
    || ! /usr/bin/perl -e 'alarm shift; exec @ARGV' 120 git submodule update --recursive \
    || [ "$(git rev-parse HEAD)" != "$POST_REMEDIATION_SHA" ]; then
    echo "HAM hard-blocker: cannot sync scratch checkout to the server-rebased head" >&2
    HAM_PHASE_OUTCOME=rebased-head-sync-failed
    ham_release_merge_lease || return 1
    return 1
  fi
  HAM_PRODUCED_HEAD="$POST_REMEDIATION_SHA"
  return 0
}

# Resolve whether the target branch REQUIRES the PR to be up to date before merge
# (GitHub required_status_checks.strict). This decides whether a BEHIND head must
# be chased with a rebase or may merge as-is. FAIL CLOSED: any error, or an
# undetermined result, keeps the historical always-rebase-until-not-BEHIND
# behavior (=1). Where no strict rule exists, a BEHIND that arises only because
# OTHER PRs merged is NOT a merge blocker (GitHub squash-merges a BEHIND-but-
# MERGEABLE PR), so chasing it with a rebase would only re-run the full required
# check suite on identical code (agent-os#5464).
ham_resolve_base_strictness() {
HAM_REQUIRES_UP_TO_DATE=1
ham_rsc_json="<<RUN_DIR>>/required-status-checks.json"
ham_rsc_err="<<RUN_DIR>>/required-status-checks.stderr"
ham_base_enc_early=$(printf '%s' "$BASE_BRANCH" | jq -sRr @uri)
if ham_gh api \
    "repos/<<REPO>>/branches/$ham_base_enc_early/protection/required_status_checks" \
    > "$ham_rsc_json" 2> "$ham_rsc_err"; then
  # jq's // treats false as absent; preserve an explicit non-strict rule.
  if jq -e '.strict == false' "$ham_rsc_json" >/dev/null 2>&1; then
    HAM_REQUIRES_UP_TO_DATE=0
  fi
else
  # Apps can read branch metadata while the administration-only protection
  # endpoint returns 403, even on an unprotected branch. An error is no proof
  # of strictness or its absence. Require an authoritative, identity-bound
  # unprotected branch response; protected/unknown/malformed stays fail-closed.
  # A classic required-checks-disabled 404 cannot exclude strict rulesets.
  if ham_gh api "repos/<<REPO>>/branches/$ham_base_enc_early" \
      > "<<RUN_DIR>>/base-protection.json" 2> "<<RUN_DIR>>/base-protection.stderr" \
    && jq -e --arg base "$BASE_BRANCH" '.name == $base and .protected == false and
      (.commit.sha | type == "string" and test("^[a-fA-F0-9]{40}$"))' \
      "<<RUN_DIR>>/base-protection.json" >/dev/null; then
    HAM_REQUIRES_UP_TO_DATE=0
  fi
fi
echo "HAM: requiresUpToDate=$HAM_REQUIRES_UP_TO_DATE base=$BASE_BRANCH" >&2
}
ham_resolve_base_strictness

# Keep this identity across verify/publish/merge in the persistent shell. Only
# our successful publication or server-side rebase may replace it.
HAM_PHASE_OUTCOME=produced-head-read-failed
HAM_PRODUCED_HEAD=$(git rev-parse HEAD) || return 1
export HAM_PRODUCED_HEAD
while [ "$(jq -r '.mergeStateStatus // ""' "<<RUN_DIR>>/pr-after.json")" = "BEHIND" ]; do
  if [ "$POST_REMEDIATION_SHA" != "$HAM_PRODUCED_HEAD" ]; then
    HAM_PHASE_OUTCOME=head-changed
    HAM_NO_MERGE_NOTE="HAM closing status — no merge. The live head differs from the hammer-produced head; released for the next hammer pass."
    ham_mark_merge_lease_retryable_abort "$HAM_PHASE_OUTCOME"
    ham_release_merge_lease || return 1
    return 20
  fi
  # Retain the produced head when the base policy permits it, including the
  # first pass. This also handles a strict already-up-to-date head with
  # a lagging BEHIND snapshot; the final live gate must still settle green.
  if [ "$(jq -r '.mergeable // ""' "<<RUN_DIR>>/pr-after.json")" = "MERGEABLE" ] \
     && ! ham_base_touches_pr_files validated-head MERGEABLE BEHIND; then
    echo "HAM: produced head covers the base policy; avoiding a redundant rebase." >&2
    break
  fi
  if [ "${HAM_MERGE_LEASE_HELD:-0}" -ne 1 ]; then
    ham_acquire_merge_lease || {
      ham_acquire_exit=$?
      if [ "${HAM_LEASE_PROBE_TRANSIENT:-0}" -eq 1 ]; then
        HAM_PHASE_OUTCOME=parked:merge-lease-timeout
        return 20
      fi
      return "$ham_acquire_exit"
    }
  fi
  ham_rebase_head || return $?
done

if [ "${HAM_MERGE_LEASE_HELD:-0}" -ne 1 ]; then
  ham_acquire_merge_lease || {
    ham_acquire_exit=$?
    if [ "${HAM_LEASE_PROBE_TRANSIENT:-0}" -eq 1 ]; then
      HAM_PHASE_OUTCOME=parked:merge-lease-timeout
      return 20
    fi
    return "$ham_acquire_exit"
  }
fi

# A successful outside-lease validation may supersede the parallel-phase base
# only for its exact tested head. Keep the original validation evidence intact.
HAM_EFFECTIVE_VALIDATION_BASE_SHA="$HAM_VALIDATION_BASE_SHA"
if ham_is_full_sha "${HAM_LOCALLY_VALIDATED_HEAD:-}" \
  && [ "$HAM_LOCALLY_VALIDATED_HEAD" = "$HAM_PRODUCED_HEAD" ] \
  && ham_is_full_sha "${HAM_LOCALLY_VALIDATED_BASE_SHA:-}"; then
  HAM_EFFECTIVE_VALIDATION_BASE_SHA="$HAM_LOCALLY_VALIDATED_BASE_SHA"
fi
if ! ham_is_full_sha "$HAM_EFFECTIVE_VALIDATION_BASE_SHA"; then
  HAM_FORCE_REVALIDATION=1
fi
if ham_capture_current_base_sha; then
  HAM_CURRENT_BASE_SHA="$HAM_CAPTURED_BASE_SHA"
  # Queue service may advance the base after first-pass retention. Report
  # containment only when it is proved; a captured tip is not rebase provenance.
  HAM_REBASED_ONTO_BASE_SHA=""
  if git merge-base --is-ancestor "$HAM_CAPTURED_BASE_SHA" "$POST_REMEDIATION_SHA"; then
    HAM_REBASED_ONTO_BASE_SHA="$HAM_CAPTURED_BASE_SHA"
  fi
else
  HAM_CURRENT_BASE_SHA=""
  HAM_REBASED_ONTO_BASE_SHA=""
  HAM_FORCE_REVALIDATION=1
fi
if [ "$HAM_FORCE_REVALIDATION" -eq 1 ]; then
  printf '{"needsRevalidation":true,"reason":"validation-base-unavailable"}\n' > "<<RUN_DIR>>/merge-lease-revalidation.json"
  HAM_NEEDS_REVALIDATION=true
else
  if "$HAM_NODE_BIN" <<ROOT_DIR>>/bin/merge-lease.mjs needs-revalidation \
    --repo-path . \
    --base "$BASE_BRANCH" \
    --validation-base "$HAM_EFFECTIVE_VALIDATION_BASE_SHA" \
    --current-base "$HAM_CURRENT_BASE_SHA" \
    --changed-files-from "$POST_REMEDIATION_SHA" \
    > "<<RUN_DIR>>/merge-lease-revalidation.json"; then
    # Preserve JSON false exactly. Never use `.needsRevalidation // true` here:
    # jq's alternative operator treats false like null and would force a spurious
    # revalidation blocker on a clean `needsRevalidation:false` decision.
    HAM_NEEDS_REVALIDATION=$(jq -er 'if (.needsRevalidation | type) == "boolean" then .needsRevalidation else true end' "<<RUN_DIR>>/merge-lease-revalidation.json" 2> "<<RUN_DIR>>/merge-lease-revalidation-jq.stderr" || true)
    if [ "$HAM_NEEDS_REVALIDATION" != "true" ] && [ "$HAM_NEEDS_REVALIDATION" != "false" ]; then
      printf '{"needsRevalidation":true,"reason":"needs-revalidation-output-invalid"}\n' > "<<RUN_DIR>>/merge-lease-revalidation.json"
      HAM_NEEDS_REVALIDATION=true
    fi
  else
    HAM_NEEDS_REVALIDATION_EXIT=$?
    printf '{"needsRevalidation":true,"reason":"needs-revalidation-tool-failed","exitCode":%s}\n' "$HAM_NEEDS_REVALIDATION_EXIT" > "<<RUN_DIR>>/merge-lease-revalidation.json"
    HAM_NEEDS_REVALIDATION=true
  fi
fi

# CONFIRM THE REBASE HOLDS: the head satisfies the GitHub conflict/strict-BEHIND policy. If
# HAM_NEEDS_REVALIDATION is true, re-run the changed-surface tests (mandate step
# 2b) outside the lease against THIS rebased $POST_REMEDIATION_SHA and fix anything
# the rebase newly broke. Record the tested head/base before re-entry.
# If HAM_NEEDS_REVALIDATION is false, trust the parallel-phase validation or
# successful exact-head local validation for this head/base relationship. GitHub required checks are the sole CI authority;
# the hammer runs no local battery or pre-push CI mirror as a merge gate. A rebase
# that turns changed-surface tests or required checks red must be fixed (and
# re-committed, which moves the head and re-enters this validation), never merged.
# Do not proceed past this point with a red applicable suite, a red required
# check, or a still-BEHIND mergeStateStatus under strict/unknown protection.
HAM_PHASE_OUTCOME=verified
"$HAM_NODE_BIN" "<<ROOT_DIR>>/bin/hammer-progress.mjs" verify-head || true
return 0
}
ham_verify_head_phase
