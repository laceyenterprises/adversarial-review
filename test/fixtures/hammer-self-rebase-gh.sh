#!/bin/bash
set -euo pipefail

# Keep the executable boundary and argv audit. Stateful operations and reads
# that simulate errors or visibility changes still use the JavaScript fixture.
fallback() {
  exec "$REAL_NODE" "$FIXTURE_HELPER" gh "$@"
}

[ -n "${SCENARIO:-}" ] && [ -n "${FIXTURE_DIR:-}" ] || fallback "$@"

case "${1-}:${2-}" in
  pr:view)
    case "${SCENARIO:-}" in
      foreign-after-rebase|lease-probe-exhausted|prepredicate-probe-exhausted|snapshot-*|ci-snapshot-*|*old-reply*)
        fallback "$@" ;;
    esac
    case "${3-}:${4-}" in
      --json:body|--json:title|--json:reviews) ;;
      --json:body,headRefOid,state,isDraft,labels,statusCheckRollup|\
      --json:number,headRefOid,state,isDraft,mergeable,mergeStateStatus,labels,statusCheckRollup,author,baseRefName|\
      --json:state,mergedAt,mergeCommit,headRefOid,baseRefName|\
      --json:state,mergedAt,mergeCommit,headRefOid,baseRefName,mergeable|\
      --json:state,mergedAt,mergeCommit,headRefOid) ;;
      *) fallback "$@" ;;
    esac
    ;;
  api:graphql)
    [ "${3-}:${4-}" = '-f:query={ viewer { login databaseId } }' ] || fallback "$@"
    ;;
  api:repos/fixture/repo/branches/main/protection/required_status_checks|\
  api:repos/fixture/repo/pulls/42|api:repos/fixture/repo/pulls/42/reviews\?*|\
  api:--paginate|api:repos/fixture/repo/issues/42/timeline) ;;
  *) fallback "$@" ;;
esac

result=$(jq -cr --arg scenario "${SCENARIO:-}" --args '
  $ARGS.positional as $args |
  {kind: "gh", value: $args},
  (if $args[0] == "pr" then
    if $args[3] == "body" then "Synthetic change."
    elif $args[3] == "title" then "Repair synthetic surface"
    elif $args[3] == "reviews" then {reviews: []}
    else {
      number: 42, headRefOid: .head, baseRefName: "main",
      state: (if .merged then "MERGED"
        elif .checkReads and $scenario == "ci-closed" then "CLOSED" else "OPEN" end),
      isDraft: false,
      mergeable: (if $scenario == "initial-unknown" then "UNKNOWN"
        elif $scenario == "initial-absent-conflict" or
          ($scenario == "server-stable-conflict" and $args[3] == "state,mergedAt,mergeCommit,headRefOid,baseRefName,mergeable")
        then "CONFLICTING" else "MERGEABLE" end),
      mergeStateStatus: (if $scenario == "initial-unknown" or $scenario == "initial-absent-conflict"
        then "UNKNOWN" elif $scenario == "initial-dirty-conflict" then "DIRTY"
        elif .behind then "BEHIND" else "CLEAN" end),
      labels: (if .checkReads and ($scenario == "ci-canceled" or $scenario == "ci-absent-conflict-canceled")
        then [{name: "no-merge-hold"}] else [] end),
      statusCheckRollup: [], mergedAt: (if .merged then "2026-01-01T00:00:00Z" else null end),
      mergeCommit: {oid: .base}
    } end
  elif $args[1] == "graphql" then {login: "hammer-worker", databaseId: 77}
  elif $args[1] | endswith("required_status_checks") then {
    strict: ($scenario != "initial-disjoint" and $scenario != "ci-disjoint"
      and $scenario != "ci-disjoint-conflict" and $scenario != "ci-disjoint-lease-delay")
  }
  elif $args[1] == "repos/fixture/repo/pulls/42" then {state: "open", head: {sha: .head}}
  else [] end)
' -- "$@" < "${FIXTURE_DIR:-}/state.json")
printf '%s\n' "${result%%$'\n'*}" >> "${FIXTURE_DIR:-}/events.jsonl"
printf '%s\n' "${result#*$'\n'}"
