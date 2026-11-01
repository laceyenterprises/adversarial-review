#!/usr/bin/env bash
# GitHub credentials refresh inside metered-gh immediately before each call.
export POST_REMEDIATION_SHA HAM_PRODUCED_HEAD HAM_PUSHED_HEAD HAM_PUSHED_FROM_HEAD
export HAM_AUDIT_COMMENT_BODY
export HAM_ROOT_DIR='<<ROOT_DIR>>'
# HAMMERTRIM-01: rendered by bin/hammer-procedure.mjs with trusted dispatch values.
ham_gh() { "${HAM_NODE_BIN:-node}" <<ROOT_DIR>>/bin/metered-gh.mjs exec-hammer "$@"; }
ham_git() { "${HAM_NODE_BIN:-node}" <<ROOT_DIR>>/bin/metered-gh.mjs exec-git "$@"; }
ham_pr() { "${HAM_NODE_BIN:-node}" <<ROOT_DIR>>/bin/hammer-pr-read.mjs <<REPO>> <<PR_NUMBER>> "$@"; }

ham_entitled_gh() { ham_gh "$@"; }

ham_publish_phase() {
HAM_PHASE_OUTCOME=hammer-publish-error
HAM_PUBLISHED_AUDIT_HEAD=""
# agent-os#4090: the terminal-remediation audit is written HERE — under the
# merge lease, at the settled post-rebase head, immediately before the
# ama-check predicate. Writing it before the rebase window let each re-entry
# post a fresh audit at a new head (a single hammer read as several). Refuse
# to write the audit unless the merge lease is currently held.
if [ "${HAM_MERGE_LEASE_HELD:-0}" -ne 1 ]; then
  echo "HAM hard-blocker: terminal-remediation audit must be written while holding the merge lease (after the rebase settles, before the merge predicate)" >&2
  return 1
fi
ham_publish_abort() {
  ham_audit_cleanup_tmp_files
  ham_release_merge_lease
  return "${1:-1}"
}
ham_audit_comment_transient() {
  grep -Eiq 'Something went wrong while executing your query|"type"[[:space:]]*:[[:space:]]*"INTERNAL"|HTTP[^[:space:]]*[[:space:]]+5[0-9][0-9]|"status"[[:space:]]*:[[:space:]]*5[0-9][0-9]|timeout|timed out|TLS|connection reset|connection refused|temporar(y|ily)|try again|rate limit|secondary rate limit|HTTP 5[0-9][0-9]|502|503|504|service unavailable|gateway' "$1"
}

# Fixed publication budget; these are procedure constants, not configuration.
HAM_AUDIT_MAX_ATTEMPTS=5
HAM_AUDIT_BACKOFF_SECONDS=2
ham_audit_lease_current() {
  [ "${HAM_MERGE_LEASE_HELD:-0}" -eq 1 ] && [ -n "${HAM_MERGE_LEASE_ID:-}" ] || return 1
  "$HAM_NODE_BIN" <<ROOT_DIR>>/bin/merge-lease.mjs status --repo <<REPO>> --base "$BASE_BRANCH" \
    > "<<RUN_DIR>>/audit-lease.json" || return 1
  jq -e --arg id "$HAM_MERGE_LEASE_ID" --argjson pr <<PR_NUMBER>> '
    .holder.leaseId == $id and .holder.holderPr == $pr and
    .holder.pastDeadline == false and .holder.holderPidLive != false and
    (.holder.ageSeconds | type == "number")' "<<RUN_DIR>>/audit-lease.json" >/dev/null
}
# Every network attempt (including recovery) rechecks the actual lease file.
ham_audit_retry() {
  local out="$1" err="$2" attempt=1
  shift 2
  HAM_AUDIT_FAILURE_KIND=permanent
  while [ "$attempt" -le "$HAM_AUDIT_MAX_ATTEMPTS" ]; do
    if ! ham_audit_lease_current; then
      HAM_AUDIT_FAILURE_KIND=lease-lost
      echo "hammer audit stopped: merge lease lost" >&2
      return 1
    fi
    if "$@" > "$out" 2> "$err"; then return 0; fi
    if ! ham_audit_lease_current; then
      HAM_AUDIT_FAILURE_KIND=lease-lost
      return 1
    fi
    if ham_audit_comment_transient "$err" || ham_audit_comment_transient "$out"; then
      HAM_AUDIT_FAILURE_KIND=transient
    else
      HAM_AUDIT_FAILURE_KIND=permanent
      echo "hammer audit failed on attempt $attempt/$HAM_AUDIT_MAX_ATTEMPTS; not retrying" >&2
      return 1
    fi
    if [ "$attempt" -ge "$HAM_AUDIT_MAX_ATTEMPTS" ]; then return 1; fi
    echo "hammer audit failed transiently on attempt $attempt/$HAM_AUDIT_MAX_ATTEMPTS; retrying" >&2
    sleep $((HAM_AUDIT_BACKOFF_SECONDS << (attempt - 1)))
    attempt=$((attempt + 1))
  done
  return 1
}

ham_audit_cleanup_tmp_files() {
  if [ -n "${HAM_AUDIT_PR_VIEW_STDERR:-}" ]; then
    rm -f "$HAM_AUDIT_PR_VIEW_STDERR"
  fi
  if [ -n "${HAM_AUDIT_COMMENT_LOOKUP_STDERR:-}" ]; then
    rm -f "$HAM_AUDIT_COMMENT_LOOKUP_STDERR"
  fi
  if [ -n "${HAM_AUDIT_COMMENT_POST_STDERR:-}" ]; then
    rm -f "$HAM_AUDIT_COMMENT_POST_STDERR"
  fi
}
HAM_AUDIT_PR_VIEW_STDERR=$(mktemp "${TMPDIR:-/tmp}/ham-audit-pr-view.XXXXXX") || { ham_publish_abort 1; return 1; }
HAM_AUDIT_COMMENT_LOOKUP_STDERR=$(mktemp "${TMPDIR:-/tmp}/ham-audit-comment-lookup.XXXXXX") || {
  ham_audit_cleanup_tmp_files
  ham_publish_abort 1; return 1
}
HAM_AUDIT_COMMENT_POST_STDERR=$(mktemp "${TMPDIR:-/tmp}/ham-audit-comment-post.XXXXXX") || {
  ham_audit_cleanup_tmp_files
  ham_publish_abort 1; return 1
}

if [ -z "${HAMMER_LACEY_GH_TOKEN:-${HAMMER_LACEY_GH_TOKEN_REFRESH_COMMAND:-${MERGE_AGENT_GH_TOKEN:-${MERGE_AGENT_GH_TOKEN_REFRESH_COMMAND:-${HQ_ENTITLEMENT_GH_TOKEN_REFRESH_COMMAND:-}}}}}" ]; then
  echo "HAM hard-blocker: no entitled hammer token present for audit comment identity" >&2
  ham_publish_abort 1; return 1
fi
if ! ham_audit_retry "<<RUN_DIR>>/audit-head" "$HAM_AUDIT_PR_VIEW_STDERR" \
  ham_pr --json headRefOid --jq '.headRefOid'; then
  ham_publish_abort 1; return 1
fi
POST_REMEDIATION_SHA=$(cat "<<RUN_DIR>>/audit-head")
if ! ham_is_full_sha "$POST_REMEDIATION_SHA"; then
  echo "HAM hard-blocker: unable to resolve post-remediation head before audit comment" >&2
  ham_publish_abort 1; return 1
fi
HAM_BUILT_HEAD=$(git rev-parse HEAD) || { ham_publish_abort 1; return 1; }
HAM_PRODUCED_HEAD="${HAM_PRODUCED_HEAD:-$HAM_BUILT_HEAD}"
if [ "$HAM_BUILT_HEAD" != "$HAM_PRODUCED_HEAD" ]; then
  echo "HAM hard-blocker: local checkout differs from the hammer-produced head; revalidate before publishing" >&2
  ham_publish_abort 1; return 1
fi
if [ "$POST_REMEDIATION_SHA" != "$HAM_PRODUCED_HEAD" ]; then
  HAM_PHASE_OUTCOME=head-changed
  HAM_NO_MERGE_NOTE="HAM closing status — no merge. The live head differs from the hammer-produced head; released for the next hammer pass."
  ham_mark_merge_lease_retryable_abort "$HAM_PHASE_OUTCOME"
  ham_publish_abort 20; return 20
fi
if ! ham_audit_retry "<<RUN_DIR>>/audit-identity.json" "$HAM_AUDIT_PR_VIEW_STDERR" \
  ham_entitled_gh api graphql -f 'query={ viewer { login databaseId } }' --jq '.data.viewer'; then
  ham_publish_abort 1; return 1
fi
# Deliver a previous run's exact edge before evaluating starting-base provenance.
if ! HAM_RECOVERED_BODY=$("$HAM_NODE_BIN" <<ROOT_DIR>>/bin/hammer-pending-attestation.mjs read \
  <<HQ_ROOT>> <<REPO>> <<PR_NUMBER>> <<REVIEWED_SHA>> "$POST_REMEDIATION_SHA" "<<RUN_DIR>>/audit-identity.json"); then
  HAM_PHASE_OUTCOME=pending-attestation-unavailable
  HAM_NO_MERGE_NOTE="HAM closing status — no merge. Pending head-bound attestation could not be read or authenticated; released for the next hammer pass."
  ham_mark_merge_lease_retryable_abort "$HAM_PHASE_OUTCOME"
  ham_publish_abort 20; return 20
fi
if [ -n "$HAM_RECOVERED_BODY" ]; then
  HAM_RECOVERED_BODY=$(printf '%s' "$HAM_RECOVERED_BODY" |
    "$HAM_NODE_BIN" <<ROOT_DIR>>/bin/github-outbound-body.mjs <<REPO>> "$POST_REMEDIATION_SHA" <<ROOT_DIR>>) || { ham_publish_abort 1; return 1; }
  HAM_RECOVERY_HEAD_CHANGED=0
  ham_recover_edge() {
    local current comments existing
    comments=$(ham_entitled_gh api --paginate --slurp "repos/<<REPO>>/issues/<<PR_NUMBER>>/comments") || return 1
    existing=$(printf '%s\n' "$comments" | "$HAM_NODE_BIN" <<ROOT_DIR>>/bin/hammer-audit-comment-id.mjs \
      <<REVIEWED_SHA>> "$POST_REMEDIATION_SHA" '<!-- hq:ham-recovered-attestation -->') || return 1
    [ -z "$existing" ] || return 0
    current=$(ham_pr --json headRefOid --jq '.headRefOid') || return 1
    [ "$current" = "$HAM_PRODUCED_HEAD" ] || {
      HAM_RECOVERY_HEAD_CHANGED=1
      echo "pending attestation head changed; releasing for the next hammer pass" >&2
      return 1
    }
    ham_audit_lease_current || { echo "merge lease lost before recovered audit post" >&2; return 1; }
    ham_entitled_gh pr comment <<PR_URL>> --body "$HAM_RECOVERED_BODY"
  }
  if ! ham_audit_retry "<<RUN_DIR>>/audit-recovery.out" "$HAM_AUDIT_COMMENT_POST_STDERR" \
    ham_recover_edge; then
    if [ "$HAM_RECOVERY_HEAD_CHANGED" -eq 1 ]; then
      HAM_PHASE_OUTCOME=head-changed
      HAM_NO_MERGE_NOTE="HAM closing status — no merge. The live head changed; released for the next hammer pass to validate the new head."
      ham_mark_merge_lease_retryable_abort "$HAM_PHASE_OUTCOME"
      ham_publish_abort 20; return 20
    fi
    HAM_PHASE_OUTCOME=audit-comment-unavailable
    HAM_NO_MERGE_NOTE="HAM closing status — no merge. Audit comment delivery failed; the pending validated edge remains durable for the next hammer to recover under its lease."
    echo "$HAM_NO_MERGE_NOTE" >&2
    if declare -F ham_mark_merge_lease_retryable_abort >/dev/null; then
      ham_mark_merge_lease_retryable_abort audit-comment-unavailable
    fi
    ham_publish_abort 1; return 1
  fi
fi
# HAMNOREREVIEW-01: validation covers the whole built head. A missing round
# record widens responsibility to the review's own proven head, never review.
ham_prove_audit_range() {
  /usr/bin/perl -e 'alarm shift; exec @ARGV' 90 "${HAM_NODE_BIN:-node}" <<ROOT_DIR>>/bin/hammer-head-context.mjs \
    <<REPO>> <<REVIEWED_SHA>> "$POST_REMEDIATION_SHA" --pr <<PR_URL>> \
    > "<<RUN_DIR>>/range.json"
}
if ! ham_is_full_sha "${HAM_BASE_HEAD:-}" || ! ham_prove_audit_range; then
  if ! ham_is_full_sha "<<REVIEWED_SHA>>"; then
    HAM_PHASE_OUTCOME=reviewed-head-unavailable
    HAM_NO_MERGE_NOTE="HAM closing status — no merge. Reviewed starting base SHA was invalid or unavailable; released for the next hammer pass."
    ham_mark_merge_lease_retryable_abort "$HAM_PHASE_OUTCOME"
    ham_publish_abort 20; return 20
  fi
  export HAM_BASE_HEAD=<<REVIEWED_SHA>>
  echo "hammer assumes responsibility for the full reviewed-to-built range: $HAM_BASE_HEAD -> $HAM_BUILT_HEAD" >&2
  # The reviewed-starting-base path needs no remediation ledger or history read.
  ham_prove_audit_range || { ham_publish_abort 1; return 1; }
fi
# REBASEPROV-01: persist the independently proven R -> current edge so daemon
# reconstruction remains valid after the hammer exits. Keep HAM_BASE_HEAD for CAS.
ham_resolve_audit_base_head() {
  local base range_dir="${HAM_RUN_DIR:-<<RUN_DIR>>}"
  base=$(jq -er --arg base "$HAM_BASE_HEAD" '
    if .proof == "reviewed-rebase-patch-equivalence" then
      if .verified == true and .reviewedHead == .rebaseCoverage.reviewedHead then
        .reviewedHead
      else error("invalid reviewed rebase coverage") end
    else $base end' "$range_dir/range.json") || return 1
  ham_is_full_sha "$base" || return 1
  printf '%s' "$base"
}
HAM_AUDIT_BASE_HEAD=$(ham_resolve_audit_base_head) || { ham_publish_abort 1; return 1; }
HAM_AUDIT_COMMENT_MARKER='<!-- hq:ham-terminal-remediation:audit -->'
# Counts and finding bullets are supplied by the caller before rendering.
ham_audit_is_nonnegative_int() {
  [[ "$1" =~ ^(0|[1-9][0-9]*)$ ]]
}
if ! ham_audit_is_nonnegative_int "${HAM_AUDIT_REMEDIATED_TOTAL:-}" ||
  ! ham_audit_is_nonnegative_int "${HAM_AUDIT_REMEDIATED_BLOCKING:-}" ||
  ! ham_audit_is_nonnegative_int "${HAM_AUDIT_REMEDIATED_NON_BLOCKING:-}" ||
  [ "$HAM_AUDIT_REMEDIATED_TOTAL" -ne "$((HAM_AUDIT_REMEDIATED_BLOCKING + HAM_AUDIT_REMEDIATED_NON_BLOCKING))" ] ||
  [ ! -f "${HAM_AUDIT_DETAILS_FILE:-}" ] ||
  [ ! -s "$HAM_AUDIT_DETAILS_FILE" ] ||
  [ -z "${HAM_FAILING_TESTS_FIXED:-}" ] ||
  grep -Eq '<finding title>|<blocking\|non-blocking>|<files changed' "$HAM_AUDIT_DETAILS_FILE"; then
  echo "HAM hard-blocker: provide valid audit counts, findings file and failing-tests summary" >&2
  ham_publish_abort 1; return 1
fi
# Render the parser's vocabulary here rather than asking the agent to type it.
# The reason names the covered files and, when applicable, the updated docs.
case "${HAM_DOC_CURRENCY:-}" in
  'not applicable') HAM_DOC_CURRENCY_LINE='Doc-currency: not applicable' ;;
  applicable) HAM_DOC_CURRENCY_LINE='Doc-currency: updated' ;;
  'skipped superproject-doc obligation') HAM_DOC_CURRENCY_LINE='Doc-currency: skipped superproject-doc obligation' ;;
  *)
    echo "HAM hammer-publish: supply HAM_DOC_CURRENCY (applicable, not applicable, or skipped superproject-doc obligation) and HAM_DOC_CURRENCY_REASON before publication" >&2
    ham_publish_abort 1; return 1 ;;
esac
HAM_DOC_CURRENCY_REASON="${HAM_DOC_CURRENCY_REASON:-}"
if [ -z "${HAM_DOC_CURRENCY_REASON//[[:space:]]/}" ] ||
  [[ "$HAM_DOC_CURRENCY_REASON" == *$'\n'* || "$HAM_DOC_CURRENCY_REASON" == *$'\r'* ]]; then
  echo "HAM hammer-publish: supply a single-line HAM_DOC_CURRENCY_REASON naming the covered files before publication" >&2
  ham_publish_abort 1; return 1
fi
HAM_DOC_CURRENCY_LINE="$HAM_DOC_CURRENCY_LINE; $HAM_DOC_CURRENCY_REASON"
# HSC-01: the findings bullets are MACHINE-PARSED (the closer matches each
# finding title against the review's standing findings to decide whether the
# non-blocking waiver holds). Keep one bullet per finding on ONE line, and use
# the finding's title VERBATIM from the review so the identity match lands.
HAM_AUDIT_COMMENT_DETAILS="$(sed -E -e '/\*\*/b' -e '/\((blocking|non-blocking)\)/b' -e '/^[[:space:]]*(-[[:space:]]+)?[Dd][Oo][Cc]-[Cc][Uu][Rr][Rr][Ee][Nn][Cc][Yy][[:space:]]*:/d' "$HAM_AUDIT_DETAILS_FILE")" || { ham_publish_abort 1; return 1; }
HAM_AUDIT_COMMENT_BODY=$(printf '%s\n\n%s\n\n%s\n\n<sub>\nHAM-Terminal-Remediation-Head: %s\nHAM-Base-Head: %s\nHAM-Validated-Head: %s\nRemediated-Findings: %s addressed (%s blocking, %s non-blocking)\nClosed-By: hammer (adversarial-pipe-mode)\n</sub>' \
  "$HAM_AUDIT_COMMENT_MARKER" \
  "$HAM_AUDIT_COMMENT_DETAILS" \
  "$HAM_DOC_CURRENCY_LINE" \
  "$POST_REMEDIATION_SHA" \
  "$HAM_AUDIT_BASE_HEAD" \
  "$POST_REMEDIATION_SHA" \
  "$HAM_AUDIT_REMEDIATED_TOTAL" \
  "$HAM_AUDIT_REMEDIATED_BLOCKING" \
  "$HAM_AUDIT_REMEDIATED_NON_BLOCKING")
HAM_AUDIT_COMMENT_BODY=$(printf '%s' "$HAM_AUDIT_COMMENT_BODY" |
  "$HAM_NODE_BIN" <<ROOT_DIR>>/bin/github-outbound-body.mjs <<REPO>> "$POST_REMEDIATION_SHA" <<ROOT_DIR>>) || HAM_AUDIT_COMMENT_BODY='<local>'
# The shared metered helper selects and refreshes the entitled audit identity.
ham_existing_terminal_audit_comment_id() {
  # Slurp pagination into one JSON value; gh's --slurp cannot be combined
  # with --jq. The selector reads the complete array of comment pages.
  HAM_AUDIT_COMMENTS_JSON=$(ham_gh api \
    --paginate --slurp \
    "repos/<<REPO>>/issues/<<PR_NUMBER>>/comments" 2> "$HAM_AUDIT_COMMENT_LOOKUP_STDERR") || {
      printf '%s\n' "$HAM_AUDIT_COMMENTS_JSON" >&2
      return 1
    }
  # Preserve earlier runs' base/head edges. Repeating publication of this exact
  # edge is idempotent, and only an entitled App author's comment can be edited.
  printf '%s\n' "$HAM_AUDIT_COMMENTS_JSON" |
    "$HAM_NODE_BIN" <<ROOT_DIR>>/bin/hammer-audit-comment-id.mjs \
      "$HAM_AUDIT_BASE_HEAD" "$POST_REMEDIATION_SHA" "$HAM_AUDIT_COMMENT_MARKER"

}
if [ -z "${HAMMER_LACEY_GH_TOKEN:-${HAMMER_LACEY_GH_TOKEN_REFRESH_COMMAND:-${MERGE_AGENT_GH_TOKEN:-${MERGE_AGENT_GH_TOKEN_REFRESH_COMMAND:-${HQ_ENTITLEMENT_GH_TOKEN_REFRESH_COMMAND:-}}}}}" ]; then
  echo "HAM hard-blocker: no entitled hammer token (HAMMER_LACEY_GH_TOKEN, or legacy MERGE_AGENT_GH_TOKEN) present for hammer audit comment identity" >&2
  ham_publish_abort 1; return 1
fi
ham_audit_deliver() {
  local existing
  existing=$(ham_existing_terminal_audit_comment_id) || {
    cat "$HAM_AUDIT_COMMENT_LOOKUP_STDERR" >&2
    return 1
  }
  ham_audit_lease_current || { echo "merge lease lost before audit post" >&2; return 1; }
  if [ -n "$existing" ]; then
    ham_entitled_gh api --method PATCH "repos/<<REPO>>/issues/comments/$existing" -f body="$HAM_AUDIT_COMMENT_BODY" || return 1
    echo "hammer audit comment refreshed in place ($existing) → $POST_REMEDIATION_SHA" >&2
  else
    ham_entitled_gh pr comment <<PR_URL>> --body "$HAM_AUDIT_COMMENT_BODY"
  fi
}
if ! ham_audit_retry "<<RUN_DIR>>/audit-post.out" "$HAM_AUDIT_COMMENT_POST_STDERR" ham_audit_deliver; then
  # Persist only after this run proved the full reviewed -> validated range.
  # Audit state outlives scratch cleanup and uses the existing atomic writer.
  if "$HAM_NODE_BIN" <<ROOT_DIR>>/bin/hammer-pending-attestation.mjs record \
    <<HQ_ROOT>> <<REPO>> <<PR_NUMBER>> <<REVIEWED_SHA>> "$POST_REMEDIATION_SHA" \
    "<<RUN_DIR>>/audit-identity.json" "<<RUN_DIR>>/range.json" \
    "$HAM_AUDIT_REMEDIATED_TOTAL" "$HAM_AUDIT_REMEDIATED_BLOCKING" "$HAM_AUDIT_REMEDIATED_NON_BLOCKING"; then
    HAM_PHASE_OUTCOME=audit-comment-unavailable
    HAM_NO_MERGE_NOTE="HAM closing status — no merge. Audit comment failed ($HAM_AUDIT_FAILURE_KIND); the next hammer will recover the durable validated edge under its lease if head, reviewed base and App identity still match."
    if [ "$HAM_AUDIT_FAILURE_KIND" = transient ]; then
      HAM_NO_MERGE_NOTE="HAM closing status — no merge. Audit comment failed transiently after $HAM_AUDIT_MAX_ATTEMPTS attempts; the next hammer will recover the durable validated edge under its lease if head, reviewed base and App identity still match."
    fi
    if declare -F ham_mark_merge_lease_retryable_abort >/dev/null; then
      ham_mark_merge_lease_retryable_abort audit-comment-unavailable
    fi
  else
    HAM_PHASE_OUTCOME=audit-attestation-record-failed
    HAM_NO_MERGE_NOTE="HAM closing status — no merge. Audit comment delivery and durable edge recording failed; provenance recovery remains unproven."
  fi
  echo "$HAM_NO_MERGE_NOTE" >&2
  ham_publish_abort 1; return 1
fi
ham_audit_cleanup_tmp_files
HAM_PUBLISHED_AUDIT_HEAD="$POST_REMEDIATION_SHA"
HAM_PHASE_OUTCOME=published
return 0
}
# Called before the hammer's ordinary git publication. The audit phase remains
# separate, under the merge lease, after remote CI validates the published SHA.
if [ "${HAM_COMMIT_PUBLICATION_ONLY:-0}" = "1" ]; then
  HAM_PUBLICATION_PREVIOUS_HEAD="${POST_REMEDIATION_SHA:-${HAM_BASE_HEAD:-}}"
  HAM_API_PUBLISH_RESULT=$(/usr/bin/perl -e 'alarm shift; exec @ARGV' 120 "${HAM_NODE_BIN:-node}" <<ROOT_DIR>>/bin/hammer-api-publish.mjs <<REPO>> <<PR_URL>>) || HAM_API_PUBLISH_RESULT='{"route":"re-review","reason":"API publication timed out"}'
  printf '%s\n' "$HAM_API_PUBLISH_RESULT"
  HAM_PUSHED_FROM_HEAD=$(printf '%s' "$HAM_API_PUBLISH_RESULT" | jq -r '.previousHead // empty')
  if [ -z "$HAM_PUSHED_FROM_HEAD" ]; then HAM_PUSHED_FROM_HEAD="$HAM_PUBLICATION_PREVIOUS_HEAD"; fi
  HAM_PUSHED_HEAD=""

  # A verified API commit can already be live when scratch fetch/reset fails.
  # Attest that exact result, then stop: local HEAD is not synchronized and
  # must never overwrite the known remote commit through the git fallback.
  HAM_API_KNOWN_PUSHED_HEAD=$(printf '%s' "$HAM_API_PUBLISH_RESULT" | jq -r '.pushedHead // empty')
  if [ -n "$HAM_API_KNOWN_PUSHED_HEAD" ] && [ "$HAM_API_KNOWN_PUSHED_HEAD" != "$HAM_PUSHED_FROM_HEAD" ]; then
    "$HAM_NODE_BIN" "<<ROOT_DIR>>/bin/hammer-progress.mjs" remediation-pushed || true
  fi
  if [ -n "$HAM_API_KNOWN_PUSHED_HEAD" ]; then
    if ! /usr/bin/perl -e 'alarm shift; exec @ARGV' 90 "$HAM_NODE_BIN" <<ROOT_DIR>>/bin/hammer-pushed-attestation.mjs \
      <<REPO>> <<PR_NUMBER>> "$HAM_PUSHED_FROM_HEAD" "$HAM_API_KNOWN_PUSHED_HEAD"; then
      HAM_PHASE_OUTCOME=pushed-attestation-unavailable
      printf -v HAM_NO_MERGE_NOTE '%s\nHAM-Base-Head: %s\nHAM-Pushed-Head: %s\nHAM-CI-Validated: false' \
        'HAM closing status — no merge. API publication succeeded before scratch sync failed; retry this provenance through the hammer App.' \
        "$HAM_PUSHED_FROM_HEAD" "$HAM_API_KNOWN_PUSHED_HEAD"
      echo "$HAM_NO_MERGE_NOTE" >&2
      if declare -F ham_release_merge_lease >/dev/null; then ham_release_merge_lease; fi
      return 1
    fi
    HAM_PHASE_OUTCOME=published-head-sync-failed
    HAM_PUSHED_HEAD="$HAM_API_KNOWN_PUSHED_HEAD"
    export HAM_PUSHED_FROM_HEAD HAM_PUSHED_HEAD
    printf -v HAM_NO_MERGE_NOTE '%s\nHAM-Base-Head: %s\nHAM-Pushed-Head: %s\nHAM-CI-Validated: false' \
      'HAM closing status — no merge. API publication and provenance succeeded, but scratch synchronization failed; preserve the remote head. Stop this run without another push or source review.' \
      "$HAM_PUSHED_FROM_HEAD" "$HAM_PUSHED_HEAD"
    if declare -F ham_release_merge_lease >/dev/null; then ham_release_merge_lease || return 1; fi
    return 1
  fi

  if [ "$(printf '%s' "$HAM_API_PUBLISH_RESULT" | jq -r '.route')" = re-review ]; then
    # Preserve the existing lease-protected git route. Validation and the audit
    # cover the full reviewed-to-built range when starting-base proof is absent.
    HAM_API_PUBLISH_FALLBACK=1
    export HAM_API_PUBLISH_FALLBACK
    HAM_API_FALLBACK_HEAD=$(printf '%s' "$HAM_API_PUBLISH_RESULT" | jq -r '.fallbackHead // empty')
    HAM_API_FALLBACK_BRANCH=$(printf '%s' "$HAM_API_PUBLISH_RESULT" | jq -r '.branch // empty')
    if [ -n "$HAM_API_FALLBACK_HEAD" ] && [ -n "$HAM_API_FALLBACK_BRANCH" ]; then
      ham_git push origin "HEAD:refs/heads/$HAM_API_FALLBACK_BRANCH" --force-with-lease="refs/heads/$HAM_API_FALLBACK_BRANCH:$HAM_API_FALLBACK_HEAD" || {
        if declare -F ham_release_merge_lease > /dev/null; then ham_release_merge_lease; fi
        return 1
      }
    else
      ham_git push --force-with-lease || {
        if declare -F ham_release_merge_lease > /dev/null; then ham_release_merge_lease; fi
        return 1
      }
    fi
    HAM_PUSHED_HEAD=$(git rev-parse HEAD) || return 1
  elif [ "$(printf '%s' "$HAM_API_PUBLISH_RESULT" | jq -r '.route')" = published ]; then
    HAM_PUSHED_HEAD=$(printf '%s' "$HAM_API_PUBLISH_RESULT" | jq -r '.head')
  fi
  HAM_PRODUCED_HEAD="$HAM_PUSHED_HEAD"
  export HAM_PRODUCED_HEAD
  unset HAM_REMOTE_CI_STARTED_AT
  HAM_NO_MERGE_NOTE=""
  HAM_HEAD_WAITED_SECONDS=0
  HAM_REQUIRED_CHECKS_WAITED_SECONDS=0
  export HAM_PUSHED_HEAD HAM_PUSHED_FROM_HEAD HAM_HEAD_WAITED_SECONDS HAM_REQUIRED_CHECKS_WAITED_SECONDS
  # Provenance belongs to publication, before any CI/credential/lease stop.
  # This grants no CI validation or merge authority.
  if [ -n "$HAM_PUSHED_HEAD" ] && [ "$HAM_PUSHED_HEAD" != "$HAM_PUSHED_FROM_HEAD" ]; then
    "$HAM_NODE_BIN" "<<ROOT_DIR>>/bin/hammer-progress.mjs" remediation-pushed || true
    if ! /usr/bin/perl -e 'alarm shift; exec @ARGV' 90 "$HAM_NODE_BIN" <<ROOT_DIR>>/bin/hammer-pushed-attestation.mjs \
      <<REPO>> <<PR_NUMBER>> "$HAM_PUSHED_FROM_HEAD" "$HAM_PUSHED_HEAD"; then
      HAM_PHASE_OUTCOME=pushed-attestation-unavailable
      printf -v HAM_NO_MERGE_NOTE '%s\nHAM-Base-Head: %s\nHAM-Pushed-Head: %s\nHAM-CI-Validated: false' \
        'HAM closing status — no merge. Pushed provenance delivery failed; retry this audit through the hammer App.' \
        "$HAM_PUSHED_FROM_HEAD" "$HAM_PUSHED_HEAD"
      echo "$HAM_NO_MERGE_NOTE" >&2
      if declare -F ham_release_merge_lease >/dev/null; then ham_release_merge_lease; fi
      return 1
    fi
  fi
else
  ham_publish_phase
fi
