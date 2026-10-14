#!/usr/bin/env bash
# HAMMERTRIM-01: rendered by bin/hammer-procedure.mjs with trusted dispatch values.
ham_gh() { "${HAM_NODE_BIN:-node}" <<ROOT_DIR>>/bin/metered-gh.mjs exec "$@"; }
ham_pr() { "${HAM_NODE_BIN:-node}" <<ROOT_DIR>>/bin/hammer-pr-read.mjs <<REPO>> <<PR_NUMBER>> "$@"; }

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
  grep -Eiq 'timeout|timed out|TLS|connection reset|connection refused|temporar(y|ily)|try again|rate limit|secondary rate limit|HTTP 5[0-9][0-9]|502|503|504|service unavailable|gateway' "$1"
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

POST_REMEDIATION_SHA=""
for HAM_AUDIT_SHA_ATTEMPT in 1 2 3; do
  if POST_REMEDIATION_SHA=$(ham_pr --json headRefOid --jq '.headRefOid' 2> "$HAM_AUDIT_PR_VIEW_STDERR") &&
    ham_is_full_sha "$POST_REMEDIATION_SHA"; then
    break
  fi
  if [ "$HAM_AUDIT_SHA_ATTEMPT" -ge 3 ] || ! ham_audit_comment_transient "$HAM_AUDIT_PR_VIEW_STDERR"; then
    break
  fi
  echo "hammer audit head lookup failed on attempt $HAM_AUDIT_SHA_ATTEMPT/3; retrying" >&2
  sleep $((HAM_AUDIT_SHA_ATTEMPT * 2))
done
if ! ham_is_full_sha "$POST_REMEDIATION_SHA"; then
  echo "HAM hard-blocker: unable to resolve post-remediation head before audit comment" >&2
  ham_publish_abort 1; return 1
fi
# Never publish a validation claim before the independent range proof. A
# failed proof releases ownership; LEASEDEFER-01 recovers the unvalidated head
# through bounded exact-head review without an ambient-credential label.
if ! ham_is_full_sha "${HAM_BASE_HEAD:-}"; then
  HAM_PHASE_OUTCOME=exact-head-review-required
  ham_publish_abort 20; return 20
fi
HAM_BUILT_HEAD=$(git rev-parse HEAD) || { ham_publish_abort 1; return 1; }
if [ "$POST_REMEDIATION_SHA" != "$HAM_BUILT_HEAD" ] ||
  ! /usr/bin/perl -e 'alarm shift; exec @ARGV' 90 "${HAM_NODE_BIN:-node}" <<ROOT_DIR>>/bin/hammer-head-context.mjs \
    <<REPO>> <<REVIEWED_SHA>> "$POST_REMEDIATION_SHA" --pr <<PR_URL>> \
    > /tmp/ham-<<PR_NUMBER>>-range.json; then
  HAM_PHASE_OUTCOME=exact-head-review-required
  ham_publish_abort 20; return 20
fi
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
  *)
    echo "HAM hammer-publish: supply HAM_DOC_CURRENCY (applicable or not applicable) and HAM_DOC_CURRENCY_REASON before publication" >&2
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
HAM_AUDIT_COMMENT_DETAILS="$(sed '/[Dd][Oo][Cc]-[Cc][Uu][Rr][Rr][Ee][Nn][Cc][Yy][[:space:]]*:/d' "$HAM_AUDIT_DETAILS_FILE")" || { ham_publish_abort 1; return 1; }
HAM_AUDIT_COMMENT_BODY=$(printf '%s\n\n%s\n\n%s\n\n<sub>\nHAM-Terminal-Remediation-Head: %s\nHAM-Base-Head: %s\nHAM-Validated-Head: %s\nRemediated-Findings: %s addressed (%s blocking, %s non-blocking)\nClosed-By: hammer (adversarial-pipe-mode)\n</sub>' \
  "$HAM_AUDIT_COMMENT_MARKER" \
  "$HAM_AUDIT_COMMENT_DETAILS" \
  "$HAM_DOC_CURRENCY_LINE" \
  "$POST_REMEDIATION_SHA" \
  "$HAM_BASE_HEAD" \
  "$POST_REMEDIATION_SHA" \
  "$HAM_AUDIT_REMEDIATED_TOTAL" \
  "$HAM_AUDIT_REMEDIATED_BLOCKING" \
  "$HAM_AUDIT_REMEDIATED_NON_BLOCKING")
HAM_AUDIT_COMMENT_BODY=$(printf '%s' "$HAM_AUDIT_COMMENT_BODY" |
  "$HAM_NODE_BIN" <<ROOT_DIR>>/bin/github-outbound-body.mjs <<REPO>> "$POST_REMEDIATION_SHA" <<ROOT_DIR>>) || HAM_AUDIT_COMMENT_BODY='<local>'
# The worker-pool exports the hammer's entitled token as HAMMER_LACEY_GH_TOKEN
# (entitlement the-hammer-lacey). agent-os#4762 split it from the merge-agent's
# MERGE_AGENT_GH_TOKEN so the hammer stops inheriting the merge-agent[bot]
# identity (that collision failed hammer spawn with auth-identity-mismatch).
# Prefer the dedicated var; fall back to MERGE_AGENT_GH_TOKEN only for
# pre-rename / rolled-back hosts. The downstream identity check still verifies
# the resolved login is the-hammer-lacey[bot], so a stale fallback fails loudly
# rather than silently posting as the wrong bot.
HAM_GH_TOKEN="${HAMMER_LACEY_GH_TOKEN:-${MERGE_AGENT_GH_TOKEN:-}}"
ham_existing_terminal_audit_comment_id() {
  # Slurp pagination into one JSON value; gh's --slurp cannot be combined
  # with --jq. The selector reads the complete array of comment pages.
  HAM_AUDIT_COMMENTS_JSON=$(GH_TOKEN="$HAM_GH_TOKEN" ham_gh api \
    --paginate --slurp \
    "repos/<<REPO>>/issues/<<PR_NUMBER>>/comments" 2> "$HAM_AUDIT_COMMENT_LOOKUP_STDERR") || return 1
  # Preserve earlier runs' base/head edges. Repeating publication of this exact
  # edge is idempotent, and only an entitled App author's comment can be edited.
  printf '%s\n' "$HAM_AUDIT_COMMENTS_JSON" |
    "$HAM_NODE_BIN" <<ROOT_DIR>>/bin/hammer-audit-comment-id.mjs \
      "$HAM_BASE_HEAD" "$POST_REMEDIATION_SHA" "$HAM_AUDIT_COMMENT_MARKER"

}
if [ -z "${HAM_GH_TOKEN:-}" ]; then
  echo "HAM hard-blocker: no entitled hammer token (HAMMER_LACEY_GH_TOKEN, or legacy MERGE_AGENT_GH_TOKEN) present for hammer audit comment identity" >&2
  ham_publish_abort 1; return 1
fi
HAM_AUDIT_COMMENT_POSTED=0
for HAM_AUDIT_COMMENT_ATTEMPT in 1 2 3; do
  if ! HAM_EXISTING_AUDIT_COMMENT_ID=$(ham_existing_terminal_audit_comment_id); then
    if [ "$HAM_AUDIT_COMMENT_ATTEMPT" -ge 3 ] || ! ham_audit_comment_transient "$HAM_AUDIT_COMMENT_LOOKUP_STDERR"; then
      echo "hammer audit comment lookup failed on attempt $HAM_AUDIT_COMMENT_ATTEMPT/3" >&2
      break
    fi
    echo "hammer audit comment lookup failed on attempt $HAM_AUDIT_COMMENT_ATTEMPT/3; retrying" >&2
    sleep $((HAM_AUDIT_COMMENT_ATTEMPT * 2))
    continue
  fi
  if [ -n "$HAM_EXISTING_AUDIT_COMMENT_ID" ]; then
    # A terminal-remediation audit from an earlier rebase attempt already exists.
    # REFRESH it in place (new head trailer / findings) instead of skipping or
    # duplicating, so the single audit tracks the merged head and a hammer's
    # rebases never read as several hammers (agent-os#4090).
    if GH_TOKEN="$HAM_GH_TOKEN" ham_gh api --method PATCH \
      "repos/<<REPO>>/issues/comments/$HAM_EXISTING_AUDIT_COMMENT_ID" \
      -f body="$HAM_AUDIT_COMMENT_BODY" > /dev/null 2> "$HAM_AUDIT_COMMENT_POST_STDERR"; then
      HAM_AUDIT_COMMENT_POSTED=1
      echo "hammer audit comment refreshed in place ($HAM_EXISTING_AUDIT_COMMENT_ID) → $POST_REMEDIATION_SHA" >&2
      break
    fi
    HAM_AUDIT_COMMENT_POST_EXIT=1
    if [ "$HAM_AUDIT_COMMENT_ATTEMPT" -ge 3 ] || ! ham_audit_comment_transient "$HAM_AUDIT_COMMENT_POST_STDERR"; then
      cat "$HAM_AUDIT_COMMENT_POST_STDERR" >&2 || true
      echo "hammer audit comment edit failed on attempt $HAM_AUDIT_COMMENT_ATTEMPT/3; not retrying" >&2
      ham_publish_abort "$HAM_AUDIT_COMMENT_POST_EXIT"; return "$HAM_AUDIT_COMMENT_POST_EXIT"
    fi
    cat "$HAM_AUDIT_COMMENT_POST_STDERR" >&2 || true
    echo "hammer audit comment edit failed on attempt $HAM_AUDIT_COMMENT_ATTEMPT/3; retrying" >&2
    sleep $((HAM_AUDIT_COMMENT_ATTEMPT * 2))
    continue
  fi
  if GH_TOKEN="$HAM_GH_TOKEN" ham_gh pr comment <<PR_URL>> --body "$HAM_AUDIT_COMMENT_BODY" 2> "$HAM_AUDIT_COMMENT_POST_STDERR"; then
    HAM_AUDIT_COMMENT_POSTED=1
    break
  fi
  HAM_AUDIT_COMMENT_POST_EXIT=1
  if [ "$HAM_AUDIT_COMMENT_ATTEMPT" -ge 3 ] || ! ham_audit_comment_transient "$HAM_AUDIT_COMMENT_POST_STDERR"; then
    cat "$HAM_AUDIT_COMMENT_POST_STDERR" >&2 || true
    echo "hammer audit comment post failed on attempt $HAM_AUDIT_COMMENT_ATTEMPT/3; not retrying" >&2
    ham_publish_abort "$HAM_AUDIT_COMMENT_POST_EXIT"; return "$HAM_AUDIT_COMMENT_POST_EXIT"
  fi
  cat "$HAM_AUDIT_COMMENT_POST_STDERR" >&2 || true
  echo "hammer audit comment post failed on attempt $HAM_AUDIT_COMMENT_ATTEMPT/3; retrying" >&2
  sleep $((HAM_AUDIT_COMMENT_ATTEMPT * 2))
done
if [ "$HAM_AUDIT_COMMENT_POSTED" -ne 1 ]; then
  echo "HAM hard-blocker: hammer audit comment post failed after 3 attempts" >&2
  ham_publish_abort 1; return 1
fi
ham_audit_cleanup_tmp_files
HAM_PUBLISHED_AUDIT_HEAD="$POST_REMEDIATION_SHA"
HAM_PHASE_OUTCOME=published
return 0
}
# Called before the hammer's ordinary git publication. The audit phase remains
# separate, under the merge lease, after remote CI validates the published SHA.
if [ "${HAM_COMMIT_PUBLICATION_ONLY:-0}" -eq 1 ]; then
  HAM_PUBLICATION_PREVIOUS_HEAD="${POST_REMEDIATION_SHA:-${HAM_BASE_HEAD:-}}"
  HAM_API_PUBLISH_RESULT=$(/usr/bin/perl -e 'alarm shift; exec @ARGV' 120 "${HAM_NODE_BIN:-node}" <<ROOT_DIR>>/bin/hammer-api-publish.mjs <<REPO>> <<PR_URL>>) || HAM_API_PUBLISH_RESULT='{"route":"re-review","reason":"API publication timed out"}'
  printf '%s\n' "$HAM_API_PUBLISH_RESULT"
  HAM_PUSHED_FROM_HEAD=$(printf '%s' "$HAM_API_PUBLISH_RESULT" | jq -r '.previousHead // empty')
  if [ -z "$HAM_PUSHED_FROM_HEAD" ]; then HAM_PUSHED_FROM_HEAD="$HAM_PUBLICATION_PREVIOUS_HEAD"; fi
  HAM_PUSHED_HEAD=""

  if [ "$(printf '%s' "$HAM_API_PUBLISH_RESULT" | jq -r '.route')" = re-review ]; then
    # Preserve the existing lease-protected git route. Range proof below will
    # request one exact-head review, rather than turning this into an escalation.
    HAM_API_PUBLISH_FALLBACK=1
    export HAM_API_PUBLISH_FALLBACK
    HAM_API_FALLBACK_HEAD=$(printf '%s' "$HAM_API_PUBLISH_RESULT" | jq -r '.fallbackHead // empty')
    HAM_API_FALLBACK_BRANCH=$(printf '%s' "$HAM_API_PUBLISH_RESULT" | jq -r '.branch // empty')
    if [ -n "$HAM_API_FALLBACK_HEAD" ] && [ -n "$HAM_API_FALLBACK_BRANCH" ]; then
      git push origin "HEAD:refs/heads/$HAM_API_FALLBACK_BRANCH" --force-with-lease="refs/heads/$HAM_API_FALLBACK_BRANCH:$HAM_API_FALLBACK_HEAD" || {
        if declare -F ham_release_merge_lease > /dev/null; then ham_release_merge_lease; fi
        return 1
      }
    else
      git push --force-with-lease || {
        if declare -F ham_release_merge_lease > /dev/null; then ham_release_merge_lease; fi
        return 1
      }
    fi
    HAM_PUSHED_HEAD=$(git rev-parse HEAD) || return 1
  elif [ "$(printf '%s' "$HAM_API_PUBLISH_RESULT" | jq -r '.route')" = published ]; then
    HAM_PUSHED_HEAD=$(printf '%s' "$HAM_API_PUBLISH_RESULT" | jq -r '.head')
  fi
  unset HAM_REMOTE_CI_STARTED_AT
  HAM_NO_MERGE_NOTE=""
  HAM_HEAD_WAITED_SECONDS=0
  HAM_REQUIRED_CHECKS_WAITED_SECONDS=0
  export HAM_PUSHED_HEAD HAM_PUSHED_FROM_HEAD HAM_HEAD_WAITED_SECONDS HAM_REQUIRED_CHECKS_WAITED_SECONDS
else
  ham_publish_phase
fi
