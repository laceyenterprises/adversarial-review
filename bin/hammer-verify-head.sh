#!/usr/bin/env bash
# HAMMERTRIM-01: rendered by bin/hammer-procedure.mjs with trusted dispatch values.
ham_verify_head_phase() {
HAM_PHASE_OUTCOME=verify-head-error
gh pr view <<PR_URL>> --json number,headRefOid,state,isDraft,mergeable,mergeStateStatus,labels,statusCheckRollup,author,baseRefName > /tmp/ham-<<PR_NUMBER>>-pr-after.json
POST_REMEDIATION_SHA=$(jq -r '.headRefOid' /tmp/ham-<<PR_NUMBER>>-pr-after.json)
BASE_BRANCH=$(jq -r '.baseRefName' /tmp/ham-<<PR_NUMBER>>-pr-after.json)
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
  echo "HAM hard-blocker: node runtime not found; cannot run AMA lease, predicate, or audit helpers" >&2
  return 1
fi

ham_mark_merge_lease_retryable_abort() {
  HAM_MERGE_LEASE_RETRYABLE_ABORT=1
  HAM_MERGE_LEASE_RETRYABLE_ABORT_REASON="${1:-retryable-abort}"
}

ham_release_merge_lease() {
  if [ "${HAM_MERGE_LEASE_HELD:-0}" -eq 1 ] && [ -n "${HAM_MERGE_LEASE_ID:-}" ]; then
    local ham_release_retryable_args=()
    if [ "${HAM_MERGE_LEASE_RETRYABLE_ABORT:-0}" -eq 1 ]; then
      ham_release_retryable_args=(--retryable-abort "${HAM_MERGE_LEASE_RETRYABLE_ABORT_REASON:-retryable-abort}")
    fi
    ham_release_attempt=1
    while [ "$ham_release_attempt" -le "$HAM_MERGE_LEASE_RELEASE_RETRY_CAP" ]; do
      if "$HAM_NODE_BIN" <<ROOT_DIR>>/bin/merge-lease.mjs release \
        --repo <<REPO>> \
        --base "$BASE_BRANCH" \
        --pr <<PR_NUMBER>> \
        --lease-id "$HAM_MERGE_LEASE_ID" \
        "${ham_release_retryable_args[@]+"${ham_release_retryable_args[@]}"}" \
        > /tmp/ham-<<PR_NUMBER>>-merge-lease-release.json; then
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
      cat /tmp/ham-<<PR_NUMBER>>-merge-lease-release.json >&2 || true
      if [ "$ham_release_attempt" -ge "$HAM_MERGE_LEASE_RELEASE_RETRY_CAP" ]; then
        echo "AMG-04 hard-blocker: merge lease release failed after ${HAM_MERGE_LEASE_RELEASE_RETRY_CAP} attempts; do not continue while the lease is unconfirmed" >&2
        return "$HAM_MERGE_LEASE_RELEASE_EXIT"
      fi
      sleep $((ham_release_attempt * 2))
      ham_release_attempt=$((ham_release_attempt + 1))
    done
    return 1
  fi
}

ham_acquire_merge_lease() {
  if "$HAM_NODE_BIN" <<ROOT_DIR>>/bin/merge-lease.mjs acquire \
    --repo <<REPO>> \
    --base "$BASE_BRANCH" \
    --pr <<PR_NUMBER>> \
    --head "$POST_REMEDIATION_SHA" \
    --owner-pid "$$" \
    --wait "$HAM_MERGE_LEASE_WAIT_SECONDS" \
    > /tmp/ham-<<PR_NUMBER>>-merge-lease-acquire.json; then
    HAM_MERGE_LEASE_ACQUIRE_EXIT=0
  else
    HAM_MERGE_LEASE_ACQUIRE_EXIT=$?
  fi
  if [ "$HAM_MERGE_LEASE_ACQUIRE_EXIT" -eq 70 ] \
    && [ "$(jq -r '.parked // false' /tmp/ham-<<PR_NUMBER>>-merge-lease-acquire.json)" = "true" ]; then
    HAM_PARK_REASON=$(jq -r '.reason // "merge-lease-parked"' /tmp/ham-<<PR_NUMBER>>-merge-lease-acquire.json)
    echo "AMG-04 parked: merge lease acquisition parked PR <<PR_NUMBER>> ($HAM_PARK_REASON)" >&2
    HAM_PHASE_OUTCOME="parked:${HAM_PARK_REASON}"
    return 20
  fi
  if [ "$HAM_MERGE_LEASE_ACQUIRE_EXIT" -eq 75 ] \
    && [ "$(jq -r '.timedOut // false' /tmp/ham-<<PR_NUMBER>>-merge-lease-acquire.json)" = "true" ]; then
    HAM_PARK_WAITED=$(jq -r '.waited_s // "unknown"' /tmp/ham-<<PR_NUMBER>>-merge-lease-acquire.json)
    echo "AMG-04 parked: merge lease acquisition timed out for PR <<PR_NUMBER>> after ${HAM_PARK_WAITED}s" >&2
    HAM_PHASE_OUTCOME=parked:merge-lease-timeout
    return 20
  fi
  if [ "$HAM_MERGE_LEASE_ACQUIRE_EXIT" -ne 0 ]; then
    cat /tmp/ham-<<PR_NUMBER>>-merge-lease-acquire.json >&2
    HAM_PHASE_OUTCOME=merge-lease-acquire-failed
    return "$HAM_MERGE_LEASE_ACQUIRE_EXIT"
  fi
  HAM_MERGE_LEASE_ID=$(jq -r '.leaseId // empty' /tmp/ham-<<PR_NUMBER>>-merge-lease-acquire.json)
  if [ -z "$HAM_MERGE_LEASE_ID" ]; then
    echo "AMG-04 hard-blocker: merge lease acquired without leaseId" >&2
    HAM_PHASE_OUTCOME=merge-lease-id-missing
    return 1
  fi
  HAM_MERGE_LEASE_HELD=1
  trap ham_release_merge_lease EXIT
}

ham_update_branch_conflict() {
  grep -Eiq 'conflict|cannot be rebased|resolve conflicts' "$1"
}

ham_update_branch_transient() {
  grep -Eiq 'timeout|timed out|TLS|connection reset|connection refused|temporar(y|ily)|try again|rate limit|secondary rate limit|HTTP 5[0-9][0-9]|502|503|504|service unavailable|gateway' "$1"
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
    > /tmp/ham-<<PR_NUMBER>>-fetch-base.stdout \
    2> /tmp/ham-<<PR_NUMBER>>-fetch-base.stderr
}

ham_capture_current_base_sha() {
  if ! ham_fetch_base_with_retries; then
    return 1
  fi
  HAM_CAPTURED_BASE_SHA=$(git rev-parse FETCH_HEAD 2>/tmp/ham-<<PR_NUMBER>>-rev-parse-base.stderr || true)
  ham_is_full_sha "$HAM_CAPTURED_BASE_SHA"
}

ham_update_branch_with_retries() {
  ham_update_attempt=1
  while [ "$ham_update_attempt" -le "$HAM_UPDATE_BRANCH_RETRY_CAP" ]; do
    if gh pr update-branch <<PR_URL>> --rebase > /tmp/ham-<<PR_NUMBER>>-update-branch.stdout 2> /tmp/ham-<<PR_NUMBER>>-update-branch.stderr; then
      return 0
    fi
    if ham_update_branch_conflict /tmp/ham-<<PR_NUMBER>>-update-branch.stderr; then
      return 2
    fi
    if ! ham_update_branch_transient /tmp/ham-<<PR_NUMBER>>-update-branch.stderr; then
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

ham_base_touches_pr_files() {
  # Returns 0 (overlap → a rebase+revalidation is still required) when any file
  # this PR changes is also touched by base commits that landed SINCE the base we
  # last validated against; returns 1 (disjoint → the validated head is safe to
  # merge without another rebase). Fail closed to 0 (overlap) on any fetch/diff
  # error so an undeterminable diff never lets us skip a rebase semantics needs.
  ham_bounded_git_sync "$BASE_BRANCH" >/dev/null 2>&1 || return 0
  [ -n "$HAM_VALIDATION_BASE_SHA" ] || return 0
  local current_base_sha pr_files base_files
  current_base_sha=$(git rev-parse FETCH_HEAD 2>/dev/null) || return 0
  ham_is_full_sha "$current_base_sha" || return 0
  pr_files=$(git diff --name-only "$current_base_sha...HEAD" 2>/dev/null) || return 0
  base_files=$(git diff --name-only "$HAM_VALIDATION_BASE_SHA..$current_base_sha" 2>/dev/null) || return 0
  [ -n "$pr_files" ] || return 1
  [ -n "$base_files" ] || return 1
  comm -12 <(printf '%s\n' "$pr_files" | sort -u) <(printf '%s\n' "$base_files" | sort -u) 2>/dev/null | grep -q .
}

# Resolve whether the target branch REQUIRES the PR to be up to date before merge
# (GitHub required_status_checks.strict). This decides whether a BEHIND head must
# be chased with a rebase or may merge as-is. FAIL CLOSED: any error, or an
# undetermined result, keeps the historical always-rebase-until-not-BEHIND
# behavior (=1). Where no strict rule exists, a BEHIND that arises only because
# OTHER PRs merged is NOT a merge blocker (GitHub squash-merges a BEHIND-but-
# MERGEABLE PR), so chasing it with a rebase would only re-run the full required
# check suite on identical code (agent-os#5464).
HAM_REQUIRES_UP_TO_DATE=1
ham_rsc_json=/tmp/ham-<<PR_NUMBER>>-required-status-checks.json
ham_rsc_err=/tmp/ham-<<PR_NUMBER>>-required-status-checks.stderr
ham_base_enc_early=$(printf '%s' "$BASE_BRANCH" | jq -sRr @uri)
if /usr/bin/perl -e 'alarm shift; exec @ARGV' 30 gh api \
    "repos/<<REPO>>/branches/$ham_base_enc_early/protection/required_status_checks" \
    > "$ham_rsc_json" 2> "$ham_rsc_err"; then
  if [ "$(jq -r '.strict // empty' "$ham_rsc_json" 2>/dev/null)" = "false" ]; then
    HAM_REQUIRES_UP_TO_DATE=0
  fi
elif grep -Eiq 'HTTP 404|Not Found|not protected|Branch not protected|Required status checks.*not' "$ham_rsc_err"; then
  # No branch protection / no required-status-checks object → no strict rule.
  HAM_REQUIRES_UP_TO_DATE=0
fi
echo "HAM: requiresUpToDate=$HAM_REQUIRES_UP_TO_DATE base=$BASE_BRANCH" >&2

while [ "$(jq -r '.mergeStateStatus // ""' /tmp/ham-<<PR_NUMBER>>-pr-after.json)" = "BEHIND" ]; do
  # STOP CHASING A MOVING BASE (agent-os#5464). Once we have rebased onto a recent
  # base at least once (HAM_REBASE_ATTEMPTS>=1) and (a) the base has no strict
  # up-to-date rule, (b) the PR is MERGEABLE, and (c) the newer base does not touch
  # any file this PR changes, merge the VALIDATED head as-is: GitHub incorporates
  # the newer base in the squash-merge commit, and re-rebasing to chase a base that
  # advanced only because OTHER PRs merged would re-run the full required-check
  # suite on identical code. Keep chasing when the base REQUIRES up-to-date, on a
  # genuine conflict, or on changed-file overlap (all fall through to the rebase).
  if [ "$HAM_REQUIRES_UP_TO_DATE" -ne 1 ] \
     && [ "$(jq -r '.mergeable // ""' /tmp/ham-<<PR_NUMBER>>-pr-after.json)" = "MERGEABLE" ] \
     && [ "${HAM_REBASE_ATTEMPTS:-0}" -ge 1 ] \
     && ! ham_base_touches_pr_files; then
    echo "HAM: base BEHIND only because other PRs merged (no strict up-to-date rule, PR MERGEABLE, no changed-file overlap) — merging the validated head without a re-rebase to avoid CI churn on identical code." >&2
    break
  fi
  if [ "${HAM_MERGE_LEASE_HELD:-0}" -ne 1 ]; then
    ham_acquire_merge_lease || return $?
  fi
  if [ "$HAM_REBASE_ATTEMPTS" -ge "$HAM_REBASE_ATTEMPT_CAP" ]; then
    echo "HAM-03 hard-blocker: rebase attempt cap exceeded ($HAM_REBASE_ATTEMPTS/$HAM_REBASE_ATTEMPT_CAP)" >&2
    ham_release_merge_lease
    HAM_PHASE_OUTCOME=rebase-attempt-cap-exceeded
    return 20
  fi
  HAM_REBASE_ATTEMPTS=$((HAM_REBASE_ATTEMPTS + 1))
  ham_update_branch_with_retries
  HAM_UPDATE_BRANCH_EXIT=$?
  if [ "$HAM_UPDATE_BRANCH_EXIT" -eq 2 ]; then
    # The hammer OWNS merge-conflict resolution, but NEVER while holding the
    # merge lease. Release the lease immediately, step out to the conflict
    # procedure below, resolve locally, force-push with lease, re-run the FULL
    # suite + required checks in the parallel phase, then return here and
    # re-acquire before the next rebase/merge attempt.
    echo "HAM-03 conflict: releasing merge lease before local conflict resolution" >&2
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
    cat /tmp/ham-<<PR_NUMBER>>-update-branch.stderr >&2
    ham_release_merge_lease
    HAM_PHASE_OUTCOME=update-branch-failed
    return 1
  fi
  gh pr view <<PR_URL>> --json number,headRefOid,state,isDraft,mergeable,mergeStateStatus,labels,statusCheckRollup,author,baseRefName > /tmp/ham-<<PR_NUMBER>>-pr-after.json
  POST_REMEDIATION_SHA=$(jq -r '.headRefOid' /tmp/ham-<<PR_NUMBER>>-pr-after.json)
done

if [ "${HAM_MERGE_LEASE_HELD:-0}" -ne 1 ]; then
  ham_acquire_merge_lease || return $?
fi

if ! ham_is_full_sha "$HAM_VALIDATION_BASE_SHA"; then
  HAM_FORCE_REVALIDATION=1
fi
if ham_capture_current_base_sha; then
  HAM_CURRENT_BASE_SHA="$HAM_CAPTURED_BASE_SHA"
  HAM_REBASED_ONTO_BASE_SHA="$HAM_CAPTURED_BASE_SHA"
else
  HAM_CURRENT_BASE_SHA=""
  HAM_REBASED_ONTO_BASE_SHA=""
  HAM_FORCE_REVALIDATION=1
fi
if [ "$HAM_FORCE_REVALIDATION" -eq 1 ]; then
  printf '{"needsRevalidation":true,"reason":"validation-base-unavailable"}\n' > /tmp/ham-<<PR_NUMBER>>-merge-lease-revalidation.json
  HAM_NEEDS_REVALIDATION=true
else
  if "$HAM_NODE_BIN" <<ROOT_DIR>>/bin/merge-lease.mjs needs-revalidation \
    --repo-path . \
    --base "$BASE_BRANCH" \
    --validation-base "$HAM_VALIDATION_BASE_SHA" \
    --current-base "$HAM_CURRENT_BASE_SHA" \
    --changed-files-from "$POST_REMEDIATION_SHA" \
    > /tmp/ham-<<PR_NUMBER>>-merge-lease-revalidation.json; then
    # Preserve JSON false exactly. Never use `.needsRevalidation // true` here:
    # jq's alternative operator treats false like null and would force a spurious
    # revalidation blocker on a clean `needsRevalidation:false` decision.
    HAM_NEEDS_REVALIDATION=$(jq -er 'if (.needsRevalidation | type) == "boolean" then .needsRevalidation else true end' /tmp/ham-<<PR_NUMBER>>-merge-lease-revalidation.json 2> /tmp/ham-<<PR_NUMBER>>-merge-lease-revalidation-jq.stderr || true)
    if [ "$HAM_NEEDS_REVALIDATION" != "true" ] && [ "$HAM_NEEDS_REVALIDATION" != "false" ]; then
      printf '{"needsRevalidation":true,"reason":"needs-revalidation-output-invalid"}\n' > /tmp/ham-<<PR_NUMBER>>-merge-lease-revalidation.json
      HAM_NEEDS_REVALIDATION=true
    fi
  else
    HAM_NEEDS_REVALIDATION_EXIT=$?
    printf '{"needsRevalidation":true,"reason":"needs-revalidation-tool-failed","exitCode":%s}\n' "$HAM_NEEDS_REVALIDATION_EXIT" > /tmp/ham-<<PR_NUMBER>>-merge-lease-revalidation.json
    HAM_NEEDS_REVALIDATION=true
  fi
fi

# CONFIRM THE REBASE HOLDS: the head is now rebased onto the latest main. If
# HAM_NEEDS_REVALIDATION is true, re-run the changed-surface tests (mandate step
# 2b) and required checks against THIS rebased $POST_REMEDIATION_SHA and fix anything
# the rebase newly broke. If HAM_NEEDS_REVALIDATION is false, trust the
# parallel-phase validation already performed for this head/base relationship
# only for that parallel phase. GitHub required checks are the sole CI authority;
# the hammer runs no local battery or pre-push CI mirror as a merge gate. A rebase
# that turns changed-surface tests or required checks red must be fixed (and
# re-committed, which moves the head and re-enters this validation), never merged.
# Do not proceed past this point with a red applicable suite, a red required
# check, or a still-BEHIND mergeStateStatus.
HAM_PHASE_OUTCOME=verified
return 0
}
ham_verify_head_phase
