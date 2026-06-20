# AMA closer — final pre-merge recheck + landing

You are the **Adversarial Merge Authority closer** for PR <<PR_URL>>.

The watcher already authorized this dispatch based on a fresh eligibility
check at <<DISPATCHED_AT>>. Your job is to re-run the EXACT same canonical
eligibility predicate from
`projects/adversarial-merge-authority/SPEC.md` §4.2 against the current
live state, then either land the merge OR write exactly one hard-blocker or
deferred audit JSON and exit. A stale reviewed head or
`mergeStateStatus=BEHIND` is not by itself a reason to surrender: first use the
HAM-03 bounded rebase authority below.

The predicate is the gate. Trust nothing else.

## Snapshot the watcher used (for audit context)

- **PR:** <<PR_URL>>
- **Repository:** <<REPO>>
- **PR number:** <<PR_NUMBER>>
- **Reviewed head SHA:** `<<REVIEWED_SHA>>`
- **Risk class:** `<<RISK_CLASS>>`
- **Merge method:** `<<MERGE_METHOD>>` (squash/merge remains the canonical landed commit; HAM-03 may update/rebase the PR branch before the final merge)
<!-- Do NOT print the raw <<REQUIRED_GATE_CONTEXT>> value here as an inline
     token: it is a CI check-context name whose "<org-slash-name>" shape is
     misread by the WBH prompt-scope cross-repo path detector as an
     out-of-workspace reference, which fail-closes the closer dispatch
     (policy_denied) for any non-agent-os PR. The value still appears in the
     fenced audit-JSON example below (fenced blocks are ignored by the detector)
     and the closer reads it from its own config, not this line. -->
- **Required gate context:** the adversarial-review gate check for this PR (see the `requiredGateContexts` field in the audit-JSON shape below).
- **HQ owner user:** `<<HQ_OWNER>>`
- **Audit JSON destination:** `<<AUDIT_PATH>>`

## Step 1 — Re-run the eligibility predicate against fresh inputs

Run these gh commands to assemble a fresh snapshot (do NOT rely on the
watcher's snapshot — it could be stale by minutes):

```bash
AMA_TMP_DIR=$(mktemp -d -t ama-closer.XXXXXX)
trap 'rm -rf "$AMA_TMP_DIR"' EXIT

# Live PR JSON
gh pr view <<PR_URL>> --json number,headRefOid,state,isDraft,mergeable,mergeStateStatus,labels,statusCheckRollup,author,baseRefName > "$AMA_TMP_DIR/ama-pr.json"

# Latest adversarial review record for the current head
gh pr view <<PR_URL>> --json reviews > "$AMA_TMP_DIR/ama-reviews.json"

# Branch protection for the target branch. GitHub returns a known 403
# upgrade/forbidden response on plans without branch protection; preserve
# that unavailable-plan evidence (the structured sentinel below is one
# accepted shape) so ama-check can honor branch_protection.required=false.
# Retry recognized transient gh/GitHub failures briefly; any non-transient
# or exhausted failure is a hard stop.
base_enc=$(printf '%s' "$(jq -r '.baseRefName' "$AMA_TMP_DIR/ama-pr.json")" | jq -sRr @uri)
protection_err="$AMA_TMP_DIR/ama-protection.stderr"
protection_plan_unavailable_re='branch protection.*(not available|upgrade|plan)|upgrade.*branch protection|protected branches.*(not available|upgrade|plan)'
protection_transient_re='timed? out|timeout|TLS handshake timeout|connection (reset|refused|aborted)|temporary failure|network is unreachable|rate limit|secondary rate limit|HTTP[ /]5[0-9][0-9]|(^|[^0-9])(500|502|503|504)([^0-9]|$)|bad gateway|service unavailable|gateway timeout|server error'
protection_attempt=1
protection_max_attempts=3
while true; do
  : > "$protection_err"
  if gh api "repos/<<REPO>>/branches/$base_enc/protection" > "$AMA_TMP_DIR/ama-protection.json" 2> "$protection_err"; then
    break
  fi
  if grep -Eiq "$protection_plan_unavailable_re" "$protection_err"; then
    jq -n '{ branchProtectionUnavailable: true, reason: "github_plan" }' > "$AMA_TMP_DIR/ama-protection.json"
    break
  fi
  if [ "$protection_attempt" -lt "$protection_max_attempts" ] && grep -Eiq "$protection_transient_re" "$protection_err"; then
    echo "branch protection fetch transient failure (attempt $protection_attempt/$protection_max_attempts); retrying" >&2
    cat "$protection_err" >&2
    sleep "$protection_attempt"
    protection_attempt=$((protection_attempt + 1))
    continue
  fi
  cat "$protection_err" >&2
  rm -f "$protection_err"
  exit 1
done
rm -f "$protection_err"

# Operator-approved + adversarial-merge-requested label events on the current head
gh api "repos/<<REPO>>/issues/<<PR_NUMBER>>/timeline" --paginate > "$AMA_TMP_DIR/ama-timeline.json"
```

Then invoke the eligibility CLI shim. It loads the AMA config, normalizes
the inputs, and returns the SPEC §4.2 verdict:

```bash
node /Users/airlock/agent-os/tools/adversarial-review/bin/ama-check.mjs \
  --pr "$AMA_TMP_DIR/ama-pr.json" \
  --reviews "$AMA_TMP_DIR/ama-reviews.json" \
  --protection "$AMA_TMP_DIR/ama-protection.json" \
  --timeline "$AMA_TMP_DIR/ama-timeline.json" \
  --repo <<REPO>> \
  --root-dir <<ROOT_DIR>> \
  --reviewed-sha <<REVIEWED_SHA>> \
  --reviewer <<REVIEWER>> \
  --risk-class <<RISK_CLASS>> \
  --review-cycle-exhausted <<REVIEW_CYCLE_EXHAUSTED>> \
  > "$AMA_TMP_DIR/ama-verdict.json"
```

The CLI emits a JSON object: `{ eligible: bool, reasons: string[], trace: {...} }`.

## Step 2 — HAM-03 stale-head / behind recovery

If `$AMA_TMP_DIR/ama-verdict.json` has `eligible:false` ONLY because of
`stale-review-head`, or the live PR has `mergeStateStatus=BEHIND` / base-behind
evidence, do not defer yet. Rebase/update the PR branch onto the current base,
prove that the reviewed content is still covered, re-run `ama-check` on the
new head, and then merge with `--match-head-commit <new-head>`.

Bound this recovery with `AMA_REBASE_ATTEMPT_CAP` (default `3`). Each pass must
record the attempt count and the final merge body must include:

```text
Rebase-Attempts: <n>
```

Recommended live flow:

```bash
AMA_REBASE_ATTEMPT_CAP="${AMA_REBASE_ATTEMPT_CAP:-3}"
REBASE_ATTEMPTS=$(
  jq '[.attempts[]?.rebaseAttempts // 0] | max // 0' "<<AUDIT_PATH>>" 2>/dev/null \
    || printf '0'
)
REBASE_UPDATE_BRANCH_RETRY_CAP="${REBASE_UPDATE_BRANCH_RETRY_CAP:-3}"
VALIDATED_HEAD="<<REVIEWED_SHA>>"
HEAD_MATCH_EVIDENCE="head_sha_matches_review"
REBASE_ASSESSED_HEAD=""
HARD_BLOCKER_REASON=""
AMA_REBASE_AUTHORITY_BIN="/Users/airlock/agent-os/tools/adversarial-review/bin/ama-rebase-authority.mjs"
AMA_MERGE_LEASE_BIN="/Users/airlock/agent-os/tools/adversarial-review/bin/merge-lease.mjs"
BASE_BRANCH=$(jq -r '.baseRefName' "$AMA_TMP_DIR/ama-pr.json")
MERGE_LEASE_ID=""
MERGE_LEASE_WAIT_SECONDS="${MERGE_LEASE_WAIT_SECONDS:-600}"
MERGE_VALIDATION_BASE=""

fetch_current_base_sha() {
  if ! git -C "<<ROOT_DIR>>" fetch origin "$BASE_BRANCH" >/dev/null; then
    echo "merge-lease base fetch failed for origin/$BASE_BRANCH" >&2
    return 1
  fi
  git -C "<<ROOT_DIR>>" rev-parse "origin/$BASE_BRANCH"
}

release_merge_lease_if_held() {
  if [ -n "$MERGE_LEASE_ID" ]; then
    node "$AMA_MERGE_LEASE_BIN" release \
      --repo <<REPO>> \
      --base "$BASE_BRANCH" \
      --pr <<PR_NUMBER>> \
      --lease-id "$MERGE_LEASE_ID" \
      --root-dir <<ROOT_DIR>> \
      > "$AMA_TMP_DIR/ama-merge-lease-release.json" \
      2> "$AMA_TMP_DIR/ama-merge-lease-release.stderr" || {
        cat "$AMA_TMP_DIR/ama-merge-lease-release.stderr" >&2
        return 1
      }
    MERGE_LEASE_ID=""
  fi
  return 0
}

is_merge_lease_revalidation_transient() {
  grep -Eiq 'timeout|timed out|TLS|connection reset|connection refused|connection aborted|temporary failure|network is unreachable|try again|rate limit|secondary rate limit|HTTP[ /]5[0-9][0-9]|bad gateway|service unavailable|gateway timeout|unable to access|fatal: unable to access' "$1"
}

run_revalidation_snapshot_command() {
  label="$1"
  out_path="$2"
  shift 2
  err_path="$AMA_TMP_DIR/${label}.stderr"
  tmp_path="$AMA_TMP_DIR/${label}.tmp"
  attempt=1
  max_attempts=3
  while true; do
    rm -f "$tmp_path"
    : > "$err_path"
    if "$@" > "$tmp_path" 2> "$err_path"; then
      mv "$tmp_path" "$out_path"
      rm -f "$err_path"
      return 0
    fi
    if [ "$attempt" -lt "$max_attempts" ] && is_merge_lease_revalidation_transient "$err_path"; then
      echo "merge-lease revalidation $label transient failure (attempt $attempt/$max_attempts); retrying" >&2
      cat "$err_path" >&2
      sleep "$attempt"
      attempt=$((attempt + 1))
      continue
    fi
    cat "$err_path" >&2
    rm -f "$tmp_path"
    return 1
  done
}

append_merge_lease_revalidation_deferred_attempt_and_exit() {
  defer_reason="$1"
  if [ "$(id -un)" != "<<HQ_OWNER>>" ]; then
    echo "ama-closer owner mismatch: expected <<HQ_OWNER>>, got $(id -un)" >&2
    exit 1
  fi
  echo "AMG merge gate deferred PR <<PR_NUMBER>> during lease revalidation: $defer_reason" >&2
  REVALIDATION_ATTEMPT_JSON="$AMA_TMP_DIR/ama-merge-lease-revalidation-deferred-attempt.json"
  jq -n \
    --arg reason "$defer_reason" \
    '{ preMergeEligible: false, preMergeReasons: [$reason], mergeLeaseRevalidationFailure: true }' \
    > "$REVALIDATION_ATTEMPT_JSON"
  node /Users/airlock/agent-os/tools/adversarial-review/bin/ama-audit.mjs append \
    --hq-root <<HQ_ROOT>> \
    --repo <<REPO>> \
    --pr <<PR_NUMBER>> \
    --head "$VALIDATED_HEAD" \
    --outcome deferred \
    --attempt-json "$REVALIDATION_ATTEMPT_JSON" \
    --now "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  APPEND_EXIT=$?
  rm -f "$REVALIDATION_ATTEMPT_JSON"
  if [ $APPEND_EXIT -eq 65 ]; then
    echo "audit append refused by sticky-succeeded guard after merge-lease revalidation failure; treating as no-op" >&2
    exit 0
  fi
  exit $APPEND_EXIT
}

append_merge_lease_parked_attempt_and_exit() {
  parked_reason=$(jq -r '.reason // "merge-lease-parked"' "$AMA_TMP_DIR/ama-merge-lease-acquire.json")
  echo "AMG merge gate parked PR <<PR_NUMBER>>: $parked_reason" >&2
  PARKED_ATTEMPT_JSON="$AMA_TMP_DIR/ama-merge-lease-parked-attempt.json"
  jq -n \
    --arg reason "$parked_reason" \
    '{ preMergeEligible: false, hardBlocker: true, hardBlockerReason: "merge-lease-parked", mergeLeaseParkedReason: $reason }' \
    > "$PARKED_ATTEMPT_JSON"
  node /Users/airlock/agent-os/tools/adversarial-review/bin/ama-audit.mjs append \
    --hq-root <<HQ_ROOT>> \
    --repo <<REPO>> \
    --pr <<PR_NUMBER>> \
    --head "$VALIDATED_HEAD" \
    --outcome failed-without-merge \
    --attempt-json "$PARKED_ATTEMPT_JSON" \
    --now "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  APPEND_EXIT=$?
  rm -f "$PARKED_ATTEMPT_JSON"
  if [ $APPEND_EXIT -eq 65 ]; then
    echo "audit append refused by sticky-succeeded guard after merge-lease park; treating as no-op" >&2
    exit 0
  fi
  exit $APPEND_EXIT
}

append_merge_lease_timeout_deferred_attempt_and_exit() {
  echo "AMG merge gate deferred PR <<PR_NUMBER>> while waiting for merge lease" >&2
  TIMEOUT_ATTEMPT_JSON="$AMA_TMP_DIR/ama-merge-lease-timeout-attempt.json"
  jq -n \
    '{ preMergeEligible: false, preMergeReasons: ["merge-lease-timeout"], mergeLeaseTimeout: true }' \
    > "$TIMEOUT_ATTEMPT_JSON"
  node /Users/airlock/agent-os/tools/adversarial-review/bin/ama-audit.mjs append \
    --hq-root <<HQ_ROOT>> \
    --repo <<REPO>> \
    --pr <<PR_NUMBER>> \
    --head "$VALIDATED_HEAD" \
    --outcome deferred \
    --attempt-json "$TIMEOUT_ATTEMPT_JSON" \
    --now "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  APPEND_EXIT=$?
  rm -f "$TIMEOUT_ATTEMPT_JSON"
  if [ $APPEND_EXIT -eq 65 ]; then
    echo "audit append refused by sticky-succeeded guard after merge-lease timeout; treating as no-op" >&2
    exit 0
  fi
  exit $APPEND_EXIT
}

acquire_merge_lease() {
  if ! MERGE_VALIDATION_BASE=$(fetch_current_base_sha); then
    exit 1
  fi
  MERGE_LEASE_OWNER_PGID="$(ps -o pgid= -p $$ | tr -d ' ')"
  MERGE_LEASE_OWNER_PGID_ARGS=()
  if [ -n "$MERGE_LEASE_OWNER_PGID" ]; then
    MERGE_LEASE_OWNER_PGID_ARGS=(--owner-pgid "$MERGE_LEASE_OWNER_PGID")
  fi
  node "$AMA_MERGE_LEASE_BIN" acquire \
    --repo <<REPO>> \
    --base "$BASE_BRANCH" \
    --pr <<PR_NUMBER>> \
    --head "$VALIDATED_HEAD" \
    --owner-pid "$$" \
    "${MERGE_LEASE_OWNER_PGID_ARGS[@]}" \
    --wait "$MERGE_LEASE_WAIT_SECONDS" \
    --root-dir <<ROOT_DIR>> \
    > "$AMA_TMP_DIR/ama-merge-lease-acquire.json" \
    2> "$AMA_TMP_DIR/ama-merge-lease-acquire.stderr"
  ACQUIRE_EXIT=$?
  if [ "$ACQUIRE_EXIT" -eq 75 ] && jq -e '.timedOut == true' "$AMA_TMP_DIR/ama-merge-lease-acquire.json" >/dev/null; then
    append_merge_lease_timeout_deferred_attempt_and_exit
  fi
  if [ "$ACQUIRE_EXIT" -eq 70 ] && jq -e '.parked == true' "$AMA_TMP_DIR/ama-merge-lease-acquire.json" >/dev/null; then
    append_merge_lease_parked_attempt_and_exit
  fi
  if [ "$ACQUIRE_EXIT" -ne 0 ]; then
    cat "$AMA_TMP_DIR/ama-merge-lease-acquire.stderr" >&2
    exit "$ACQUIRE_EXIT"
  fi
  MERGE_LEASE_ID=$(jq -r '.leaseId' "$AMA_TMP_DIR/ama-merge-lease-acquire.json")
}

run_merge_lease_base_revalidation() {
  if ! CURRENT_BASE_SHA=$(fetch_current_base_sha); then
    append_merge_lease_revalidation_deferred_attempt_and_exit merge-lease-base-fetch-failure
  fi
  if ! run_revalidation_snapshot_command ama-merge-lease-revalidation "$AMA_TMP_DIR/ama-merge-lease-revalidation.json" \
    node "$AMA_MERGE_LEASE_BIN" needs-revalidation \
    --repo-path <<ROOT_DIR>> \
    --base "$BASE_BRANCH" \
    --validation-base "$MERGE_VALIDATION_BASE" \
    --current-base "$CURRENT_BASE_SHA" \
    --changed-files-from "$VALIDATED_HEAD"; then
    append_merge_lease_revalidation_deferred_attempt_and_exit merge-lease-needs-revalidation-failure
  fi
  if jq -e '.needsRevalidation == true' "$AMA_TMP_DIR/ama-merge-lease-revalidation.json" >/dev/null; then
    if ! run_revalidation_snapshot_command ama-pr "$AMA_TMP_DIR/ama-pr.json" \
      gh pr view <<PR_URL>> --json number,headRefOid,state,isDraft,mergeable,mergeStateStatus,labels,statusCheckRollup,author,baseRefName; then
      append_merge_lease_revalidation_deferred_attempt_and_exit merge-lease-pr-snapshot-failure
    fi
    VALIDATED_HEAD=$(jq -r '.headRefOid' "$AMA_TMP_DIR/ama-pr.json")
    BASE_BRANCH=$(jq -r '.baseRefName' "$AMA_TMP_DIR/ama-pr.json")
    if ! run_revalidation_snapshot_command ama-reviews "$AMA_TMP_DIR/ama-reviews.json" \
      gh pr view <<PR_URL>> --json reviews; then
      append_merge_lease_revalidation_deferred_attempt_and_exit merge-lease-review-snapshot-failure
    fi
    if ! run_revalidation_snapshot_command ama-timeline "$AMA_TMP_DIR/ama-timeline.json" \
      gh api "repos/<<REPO>>/issues/<<PR_NUMBER>>/timeline" --paginate; then
      append_merge_lease_revalidation_deferred_attempt_and_exit merge-lease-timeline-snapshot-failure
    fi
    if [ -s "$AMA_TMP_DIR/ama-rebase-assessment.json" ] && [ "${REBASE_ASSESSED_HEAD:-}" = "$VALIDATED_HEAD" ]; then
      if ! run_revalidation_snapshot_command ama-verdict "$AMA_TMP_DIR/ama-verdict.json" \
        node /Users/airlock/agent-os/tools/adversarial-review/bin/ama-check.mjs \
          --pr "$AMA_TMP_DIR/ama-pr.json" \
          --reviews "$AMA_TMP_DIR/ama-reviews.json" \
          --protection "$AMA_TMP_DIR/ama-protection.json" \
          --timeline "$AMA_TMP_DIR/ama-timeline.json" \
          --repo <<REPO>> \
          --root-dir <<ROOT_DIR>> \
          --reviewed-sha <<REVIEWED_SHA>> \
          --reviewer <<REVIEWER>> \
          --risk-class <<RISK_CLASS>> \
          --rebase-assessment "$AMA_TMP_DIR/ama-rebase-assessment.json" \
          --review-cycle-exhausted <<REVIEW_CYCLE_EXHAUSTED>>; then
        append_merge_lease_revalidation_deferred_attempt_and_exit merge-lease-ama-check-failure
      fi
    else
      if ! run_revalidation_snapshot_command ama-verdict "$AMA_TMP_DIR/ama-verdict.json" \
        node /Users/airlock/agent-os/tools/adversarial-review/bin/ama-check.mjs \
          --pr "$AMA_TMP_DIR/ama-pr.json" \
          --reviews "$AMA_TMP_DIR/ama-reviews.json" \
          --protection "$AMA_TMP_DIR/ama-protection.json" \
          --timeline "$AMA_TMP_DIR/ama-timeline.json" \
          --repo <<REPO>> \
          --root-dir <<ROOT_DIR>> \
          --reviewed-sha <<REVIEWED_SHA>> \
          --reviewer <<REVIEWER>> \
          --risk-class <<RISK_CLASS>> \
          --review-cycle-exhausted <<REVIEW_CYCLE_EXHAUSTED>>; then
        append_merge_lease_revalidation_deferred_attempt_and_exit merge-lease-ama-check-failure
      fi
    fi
    MERGE_VALIDATION_BASE="$CURRENT_BASE_SHA"
  fi
}

is_update_branch_conflict() {
  grep -Eiq 'conflict|cannot be rebased|resolve conflicts' "$1"
}

is_update_branch_transient() {
  grep -Eiq 'timeout|timed out|TLS|connection reset|connection refused|temporar(y|ily)|try again|rate limit|secondary rate limit|HTTP 5[0-9][0-9]|502|503|504|service unavailable|gateway' "$1"
}

run_update_branch_with_retries() {
  update_attempt=1
  while [ "$update_attempt" -le "$REBASE_UPDATE_BRANCH_RETRY_CAP" ]; do
    if gh pr update-branch <<PR_URL>> --rebase > "$AMA_TMP_DIR/ama-update-branch.stdout" 2> "$AMA_TMP_DIR/ama-update-branch.stderr"; then
      return 0
    fi
    if is_update_branch_conflict "$AMA_TMP_DIR/ama-update-branch.stderr"; then
      return 2
    fi
    if ! is_update_branch_transient "$AMA_TMP_DIR/ama-update-branch.stderr"; then
      return 1
    fi
    if [ "$update_attempt" -ge "$REBASE_UPDATE_BRANCH_RETRY_CAP" ]; then
      return 1
    fi
    sleep $((update_attempt * 5))
    update_attempt=$((update_attempt + 1))
  done
  return 1
}

needs_rebase_recovery() {
  node "$AMA_REBASE_AUTHORITY_BIN" needs-recovery \
    --pr "$AMA_TMP_DIR/ama-pr.json" \
    --verdict "$AMA_TMP_DIR/ama-verdict.json" \
    --reviewed-sha "$VALIDATED_HEAD" \
    | jq -e '.needed == true' >/dev/null
}

assess_rebase_equivalence() {
  node "$AMA_REBASE_AUTHORITY_BIN" assess \
    --pr "$AMA_TMP_DIR/ama-pr.json" \
    --verdict "$AMA_TMP_DIR/ama-verdict.json" \
    --reviewed-sha "<<REVIEWED_SHA>>" \
    --current-head "$VALIDATED_HEAD" \
    --attempts "$REBASE_ATTEMPTS" \
    --cap "$AMA_REBASE_ATTEMPT_CAP" \
    --reviewed-patchids "$AMA_TMP_DIR/ama-reviewed.patchids" \
    --rebased-patchids "$AMA_TMP_DIR/ama-rebased.patchids" \
    --reverify-eligible true \
    > "$AMA_TMP_DIR/ama-rebase-assessment.json"
}

write_non_empty_patch_ids() {
  patch_id_label="$1"
  diff_path="$2"
  out_path="$3"
  if ! (set -o pipefail; git patch-id --stable < "$diff_path" | awk '{print $1}' | sort > "$out_path"); then
    echo "HAM-03 hard-blocker: failed to derive $patch_id_label patch-id evidence" >&2
    return 1
  fi
  if [ ! -s "$out_path" ]; then
    echo "HAM-03 hard-blocker: empty $patch_id_label patch-id evidence; exact-head validation is required" >&2
    return 1
  fi
  return 0
}

acquire_merge_lease
trap 'release_merge_lease_if_held || true; rm -rf "$AMA_TMP_DIR"' EXIT

if needs_rebase_recovery; then
  reviewed_base_enc=$(printf '%s' "$(jq -r '.baseRefName' "$AMA_TMP_DIR/ama-pr.json")" | jq -sRr @uri)
  if ! gh api \
    -H 'Accept: application/vnd.github.v3.diff' \
    "repos/<<REPO>>/compare/$reviewed_base_enc...<<REVIEWED_SHA>>" \
    > "$AMA_TMP_DIR/ama-reviewed.diff"; then
    HARD_BLOCKER_REASON=reviewed-diff-fetch-failure
  fi
  if [ -z "$HARD_BLOCKER_REASON" ] && ! write_non_empty_patch_ids reviewed "$AMA_TMP_DIR/ama-reviewed.diff" "$AMA_TMP_DIR/ama-reviewed.patchids"; then
    HARD_BLOCKER_REASON=reviewed-patch-id-evidence-unavailable
  fi
fi

while [ -z "$HARD_BLOCKER_REASON" ] && needs_rebase_recovery; do
  if [ "$REBASE_ATTEMPTS" -ge "$AMA_REBASE_ATTEMPT_CAP" ]; then
    echo "HAM-03 hard-blocker: rebase attempt cap exceeded ($REBASE_ATTEMPTS/$AMA_REBASE_ATTEMPT_CAP)" >&2
    HARD_BLOCKER_REASON=rebase-attempt-cap-exceeded
    break
  fi
  REBASE_ATTEMPTS=$((REBASE_ATTEMPTS + 1))

  BEFORE_HEAD=$(jq -r '.headRefOid' "$AMA_TMP_DIR/ama-pr.json")

  run_update_branch_with_retries
  UPDATE_BRANCH_EXIT=$?
  if [ "$UPDATE_BRANCH_EXIT" -eq 2 ]; then
    echo "HAM-03 hard-blocker: unresolvable rebase conflict" >&2
    HARD_BLOCKER_REASON=unresolvable-rebase-conflict
    break
  fi
  if [ "$UPDATE_BRANCH_EXIT" -ne 0 ]; then
    cat "$AMA_TMP_DIR/ama-update-branch.stderr" >&2
    HARD_BLOCKER_REASON=update-branch-failure
    break
  fi

  gh pr view <<PR_URL>> --json number,headRefOid,state,isDraft,mergeable,mergeStateStatus,labels,statusCheckRollup,author,baseRefName > "$AMA_TMP_DIR/ama-pr.json"
  VALIDATED_HEAD=$(jq -r '.headRefOid' "$AMA_TMP_DIR/ama-pr.json")
  if ! gh pr diff <<PR_URL>> --patch > "$AMA_TMP_DIR/ama-rebased.diff"; then
    HARD_BLOCKER_REASON=rebased-diff-fetch-failure
    break
  fi
  if ! write_non_empty_patch_ids rebased "$AMA_TMP_DIR/ama-rebased.diff" "$AMA_TMP_DIR/ama-rebased.patchids"; then
    HARD_BLOCKER_REASON=rebased-patch-id-evidence-unavailable
    break
  fi

  assess_rebase_equivalence
  if jq -e '.action == "exact-head-validation-required" and .reason == "rebased-content-not-review-equivalent"' "$AMA_TMP_DIR/ama-rebase-assessment.json" >/dev/null; then
    echo "HAM-03 hard-blocker: rebased diff is not review-equivalent; exact-head validation is required" >&2
    HARD_BLOCKER_REASON=rebased-content-not-review-equivalent
    break
  fi
  if [ "$VALIDATED_HEAD" = "$BEFORE_HEAD" ]; then
    echo "HAM-03 hard-blocker: update-branch did not advance the stale/behind head" >&2
    HARD_BLOCKER_REASON=rebase-did-not-advance-head
    break
  fi

  gh pr view <<PR_URL>> --json reviews > "$AMA_TMP_DIR/ama-reviews.json"
  gh api "repos/<<REPO>>/issues/<<PR_NUMBER>>/timeline" --paginate > "$AMA_TMP_DIR/ama-timeline.json"
  node /Users/airlock/agent-os/tools/adversarial-review/bin/ama-check.mjs \
    --pr "$AMA_TMP_DIR/ama-pr.json" \
    --reviews "$AMA_TMP_DIR/ama-reviews.json" \
    --protection "$AMA_TMP_DIR/ama-protection.json" \
    --timeline "$AMA_TMP_DIR/ama-timeline.json" \
    --repo <<REPO>> \
    --root-dir <<ROOT_DIR>> \
    --reviewed-sha <<REVIEWED_SHA>> \
    --reviewer <<REVIEWER>> \
    --risk-class <<RISK_CLASS>> \
    --rebase-assessment "$AMA_TMP_DIR/ama-rebase-assessment.json" \
    --review-cycle-exhausted <<REVIEW_CYCLE_EXHAUSTED>> \
    > "$AMA_TMP_DIR/ama-verdict.json"
  HEAD_MATCH_EVIDENCE="content_equivalent_rebased_head"
  REBASE_ASSESSED_HEAD="$VALIDATED_HEAD"
done

if [ -z "$HARD_BLOCKER_REASON" ]; then
  run_merge_lease_base_revalidation
fi

if [ -n "$HARD_BLOCKER_REASON" ]; then
  HARD_BLOCKER_ATTEMPT_JSON="$AMA_TMP_DIR/ama-hard-blocker-attempt.json"
  jq -n \
    --arg reason "$HARD_BLOCKER_REASON" \
    --arg headMatchEvidence "${HEAD_MATCH_EVIDENCE:-head_sha_matches_review}" \
    --argjson rebaseAttempts ${REBASE_ATTEMPTS:-0} \
    '{
      preMergeEligible: false,
      hardBlocker: true,
      hardBlockerReason: $reason,
      headMatchEvidence: $headMatchEvidence,
      rebaseAttempts: $rebaseAttempts
    }' > "$HARD_BLOCKER_ATTEMPT_JSON"
  node /Users/airlock/agent-os/tools/adversarial-review/bin/ama-audit.mjs append \
    --hq-root <<HQ_ROOT>> \
    --repo <<REPO>> \
    --pr <<PR_NUMBER>> \
    --head "$VALIDATED_HEAD" \
    --outcome failed-without-merge \
    --attempt-json "$HARD_BLOCKER_ATTEMPT_JSON" \
    --now "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  APPEND_EXIT=$?
  rm -f "$HARD_BLOCKER_ATTEMPT_JSON"
  if [ $APPEND_EXIT -eq 65 ]; then
    echo "audit append refused by sticky-succeeded guard after HAM-03 hard-blocker; treating as no-op" >&2
    exit 0
  fi
  exit $APPEND_EXIT
fi
```

If the new head contains a HAM remediation commit, do not rewrite the stored
reviewed SHA to pretend the old `reviewedSha === head` contract passed. Route
through HAM terminal-remediation mode instead: prove the reviewed parent,
HAM provenance trailers, PR audit comment, live-head checks, and non-waived
gates; require `ham_terminal_remediation_validated`; then set
`VALIDATED_HEAD` to that HAM commit SHA and merge with
`--match-head-commit "$VALIDATED_HEAD"`.

If `HARD_BLOCKER_REASON` is set, append one `failed-without-merge` audit
attempt containing the reason, `rebaseAttempts`, and any content-equivalence
diagnostics, then exit 0. Do not loop, force-merge, or ask for another review.

## Step 3 — Branch on the verdict

### If `eligible === false`

This is a **defer** only after the HAM-03 recovery path above has either not
applied or has produced exactly one hard-blocker report. Append a `deferred`
attempt to the watcher-owned audit
record via the AMA-04 audit shim — the writer handles atomic
tmp+rename, mode 0640, and SPEC §4.4 state-machine derivation:

```bash
if [ "$(id -un)" != "<<HQ_OWNER>>" ]; then
  echo "ama-closer owner mismatch: expected <<HQ_OWNER>>, got $(id -un)" >&2
  exit 1
fi

# Capture the fresh predicate's reasons in the attempt entry.
ATTEMPT_JSON="$AMA_TMP_DIR/ama-deferred-attempt.json"
jq -n --argjson reasons "$(jq '.reasons' "$AMA_TMP_DIR/ama-verdict.json")" \
  '{ preMergeEligible: false, preMergeReasons: $reasons }' > "$ATTEMPT_JSON"

node /Users/airlock/agent-os/tools/adversarial-review/bin/ama-audit.mjs append \
  --hq-root <<HQ_ROOT>> \
  --repo <<REPO>> \
  --pr <<PR_NUMBER>> \
  --head "$VALIDATED_HEAD" \
  --outcome deferred \
  --attempt-json "$ATTEMPT_JSON" \
  --now "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
rm -f "$ATTEMPT_JSON"
exit 0
```

Exit 0 — deferral is a legitimate terminal-for-this-head outcome.

### If `eligible === true`

Record the closer attempt BEFORE `gh pr merge`, then issue the merge
with `--match-head-commit` against the validated head. GitHub will
refuse if the head has advanced; treat that refusal as a normal defer
or superseded outcome, not a force-merge opportunity.

```bash
PRE_MERGE_ATTEMPT_JSON="$AMA_TMP_DIR/ama-pre-merge-attempt.json"
jq -n \
  --arg headMatchEvidence "${HEAD_MATCH_EVIDENCE:-head_sha_matches_review}" \
  --argjson rebaseAttempts ${REBASE_ATTEMPTS:-0} \
  '{ preMergeEligible: true, attemptPhase: "before-gh-pr-merge", headMatchEvidence: $headMatchEvidence, rebaseAttempts: $rebaseAttempts }' \
  > "$PRE_MERGE_ATTEMPT_JSON"

node /Users/airlock/agent-os/tools/adversarial-review/bin/ama-audit.mjs append \
  --hq-root <<HQ_ROOT>> \
  --repo <<REPO>> \
  --pr <<PR_NUMBER>> \
  --head "$VALIDATED_HEAD" \
  --outcome in_progress \
  --attempt-json "$PRE_MERGE_ATTEMPT_JSON" \
  --now "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
PRE_APPEND_EXIT=$?
rm -f "$PRE_MERGE_ATTEMPT_JSON"
if [ $PRE_APPEND_EXIT -eq 65 ]; then
  echo "audit append refused by sticky-succeeded guard before merge; treating as no-op" >&2
  exit 0
fi
if [ $PRE_APPEND_EXIT -ne 0 ]; then
  exit $PRE_APPEND_EXIT
fi

TRAILERS_FILE="$AMA_TMP_DIR/ama-merge-body.txt"
cat <<EOF > "$TRAILERS_FILE"
<<AMA_TRAILERS>>
Rebase-Attempts: ${REBASE_ATTEMPTS:-0}
EOF

gh pr merge <<PR_URL>> \
  --<<MERGE_METHOD>> \
  --match-head-commit "$VALIDATED_HEAD" \
  --body-file "$TRAILERS_FILE" \
  > "$AMA_TMP_DIR/ama-merge.stdout" \
  2> "$AMA_TMP_DIR/ama-merge.stderr"
MERGE_EXIT=$?
rm -f "$TRAILERS_FILE"
```

## Step 4 — Re-read GitHub state (CLI exit code is NON-AUTHORITATIVE)

SPEC §7 risk row 4: `gh pr merge` can succeed server-side and exit
non-zero on transport noise. Always re-read GitHub before terminalizing.

```bash
sleep 2  # GitHub propagation
gh pr view <<PR_URL>> --json state,mergedAt,mergeCommit,headRefOid > "$AMA_TMP_DIR/ama-post-merge.json"
PR_STATE=$(jq -r '.state' "$AMA_TMP_DIR/ama-post-merge.json")
MERGED_AT=$(jq -r '.mergedAt' "$AMA_TMP_DIR/ama-post-merge.json")
MERGE_COMMIT=$(jq -r '.mergeCommit.oid // empty' "$AMA_TMP_DIR/ama-post-merge.json")
POST_HEAD=$(jq -r '.headRefOid' "$AMA_TMP_DIR/ama-post-merge.json")
```

## Step 5 — Terminalize the audit JSON

Decision matrix:

| Post-read state | Outcome |
|---|---|
| `PR_STATE == MERGED && POST_HEAD == VALIDATED_HEAD` | `succeeded` |
| `PR_STATE == MERGED && POST_HEAD != VALIDATED_HEAD` | `superseded` (someone else landed a different head) |
| `PR_STATE == OPEN && POST_HEAD != VALIDATED_HEAD` | `superseded` (head advanced; defer) |
| `PR_STATE == OPEN && POST_HEAD == VALIDATED_HEAD && MERGE_EXIT != 0` | `failed-without-merge` |
| `PR_STATE == OPEN && POST_HEAD == VALIDATED_HEAD && MERGE_EXIT == 0` | `in_progress` + `reconciliation.needsRepair = true` (the next watcher tick reconciles) |

Compute the outcome, then append the post-merge reconciliation attempt
via the AMA-04 audit shim. The pre-merge append above records that this
closer invocation reached the merge step; this second write records the
observed terminal or repair-needed state. The writer derives the
surface `status` per SPEC §4.4 (incl. sticky-succeeded), projects the
top-level `reconciliation` fields from the appended attempt, and
refuses to demote a terminal `succeeded`. Exit code `65` is reserved
for that explicit sticky-succeeded refusal; any other
writer/data/filesystem failure exits non-zero and must not be treated
as success:

```bash
if [ "$PR_STATE" = "MERGED" ] && [ "$POST_HEAD" = "$VALIDATED_HEAD" ]; then
  OUTCOME=succeeded
elif [ "$PR_STATE" = "MERGED" ] || [ "$POST_HEAD" != "$VALIDATED_HEAD" ]; then
  OUTCOME=superseded
elif [ "$MERGE_EXIT" != "0" ]; then
  OUTCOME=failed-without-merge
else
  OUTCOME=in_progress
fi

ATTEMPT_JSON="$AMA_TMP_DIR/ama-terminal-attempt.json"
jq -n \
  --arg outcome "$OUTCOME" \
  --arg mergeCommit "${MERGE_COMMIT:-}" \
  --arg mergedAt "${MERGED_AT:-}" \
  --argjson cliExit ${MERGE_EXIT:-0} \
  '{
    cliExitCode: $cliExit,
    mergeCommitSha: $mergeCommit,
    mergedAt: $mergedAt,
    needsRepair: ($outcome == "in_progress")
  }' > "$ATTEMPT_JSON"

node /Users/airlock/agent-os/tools/adversarial-review/bin/ama-audit.mjs append \
  --hq-root <<HQ_ROOT>> \
  --repo <<REPO>> \
  --pr <<PR_NUMBER>> \
  --head "$VALIDATED_HEAD" \
  --outcome "$OUTCOME" \
  --attempt-json "$ATTEMPT_JSON" \
  --now "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
APPEND_EXIT=$?
rm -f "$ATTEMPT_JSON"
if [ $APPEND_EXIT -eq 65 ]; then
  echo "audit append refused by sticky-succeeded guard; treating as no-op" >&2
  exit 0
fi
exit $APPEND_EXIT
```

The audit doc shape the writer produces (managed by AMA-04; do NOT
hand-roll the fields here):

```json
{
  "schemaVersion": 1,
  "repo": "<<REPO>>",
  "prNumber": <<PR_NUMBER>>,
  "headSha": "<<REVIEWED_SHA>>",
  "createdAt": "<ISO>",
  "updatedAt": "<ISO>",
  "status": "<in_progress|deferred|superseded|succeeded|failed-without-merge>",
  "reviewedBy": "<reviewer login>",
  "reviewSha": "<<REVIEWED_SHA>>",
  "riskClass": "<<RISK_CLASS>>",
  "requiredGateContexts": ["<<REQUIRED_GATE_CONTEXT>>"],
  "eligibilityReasons": ["<watcher eligibility reason>", "<...>"],
  "mergeMethod": "<<MERGE_METHOD>>",
  "reconciliation": {
    "needsRepair": false,
    "lastVerifiedAt": "<ISO>"
  },
  "attempts": [{
    "attemptNumber": 1,
    "startedAt": "<ISO>",
    "outcome": "<...>",
    /* + any per-attempt fields from --attempt-json */
  }]
}
```

## Don'ts

- Don't `gh pr merge` without `--match-head-commit "$VALIDATED_HEAD"`. Head advance = defer, not merge.
- Don't defer solely for `stale-review-head` or `mergeStateStatus=BEHIND`; first run the bounded HAM-03 rebase/update-branch recovery.
- Don't treat a rebased head as reviewed unless stable patch-id/tree-diff equivalence proves only base movement, or HAM terminal-remediation exact-head validation proves the replacement head.
- Don't terminalize as `succeeded` or `failed-without-merge` on CLI exit code alone. Always re-read GitHub state.
- Don't retry `gh pr merge` inside this prompt. The next watcher tick re-evaluates from `in_progress` + `needsRepair=true`.
- Don't write the audit JSON anywhere other than `<<AUDIT_PATH>>`, and only do it when `id -un` matches `<<HQ_OWNER>>`. The watcher reads it back from there.
- Don't commit anything to the worker's checkout. There is no checkout state to preserve — this is a close-only worker.

<!-- hq:closeout:pr -->

## Close-out

When you've written the terminal audit JSON, exit 0. The watcher will
reconcile on its next tick. No PR open is required — this worker
doesn't open a PR; it closes someone else's.
