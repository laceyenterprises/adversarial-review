#!/usr/bin/env bash
# HAMMERTRIM-01: rendered by bin/hammer-procedure.mjs with trusted dispatch values.
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
  if POST_REMEDIATION_SHA=$(gh pr view <<PR_URL>> --json headRefOid --jq '.headRefOid' 2> "$HAM_AUDIT_PR_VIEW_STDERR") &&
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
# When filling in the comment body below, optionally add one bullet each for
# applicable test evidence and doc currency, using the same bulleted style.
# HSC-01: the findings bullets are MACHINE-PARSED (the closer matches each
# finding title against the review's standing findings to decide whether the
# non-blocking waiver holds). Keep one bullet per finding on ONE line, and use
# the finding's title VERBATIM from the review so the identity match lands.
HAM_AUDIT_COMMENT_DETAILS="$(cat "$HAM_AUDIT_DETAILS_FILE")" || { ham_publish_abort 1; return 1; }
HAM_AUDIT_COMMENT_BODY=$(printf '%s\n\n%s\n\n<sub>\nHAM-Terminal-Remediation-Head: %s\nRemediated-Findings: %s addressed (%s blocking, %s non-blocking)\nClosed-By: hammer (adversarial-pipe-mode)\n</sub>' \
  "$HAM_AUDIT_COMMENT_MARKER" \
  "$HAM_AUDIT_COMMENT_DETAILS" \
  "$POST_REMEDIATION_SHA" \
  "$HAM_AUDIT_REMEDIATED_TOTAL" \
  "$HAM_AUDIT_REMEDIATED_BLOCKING" \
  "$HAM_AUDIT_REMEDIATED_NON_BLOCKING")
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
  HAM_AUDIT_COMMENTS_JSON=$(GH_TOKEN="$HAM_GH_TOKEN" gh api \
    --paginate \
    "repos/<<REPO>>/issues/<<PR_NUMBER>>/comments" \
    -q '.[] | {id: .id, body: .body}' 2> "$HAM_AUDIT_COMMENT_LOOKUP_STDERR") || return 1
  # Dedup on the STABLE marker alone, NOT the per-rebase head sha. A hammer that
  # rebases the same terminal remediation onto an advancing `main` several times
  # before the merge window holds must refresh ONE audit — keying on the head sha
  # made every rebase miss the prior audit and post a look-alike, so a single
  # hammer's rebases read as several hammers (agent-os#4090).
  printf '%s\n' "$HAM_AUDIT_COMMENTS_JSON" |
    jq -r --arg marker "$HAM_AUDIT_COMMENT_MARKER" \
      'select((.body // "") | contains($marker)) | .id' |
    head -n 1
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
    if GH_TOKEN="$HAM_GH_TOKEN" gh api --method PATCH \
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
  if GH_TOKEN="$HAM_GH_TOKEN" gh pr comment <<PR_URL>> --body "$HAM_AUDIT_COMMENT_BODY" 2> "$HAM_AUDIT_COMMENT_POST_STDERR"; then
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
ham_publish_phase
