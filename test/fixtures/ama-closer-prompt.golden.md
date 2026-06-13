# AMA closer — final pre-merge recheck + landing

You are the **Adversarial Merge Authority closer** for PR https://github.com/acme/myrepo/pull/1234.

The watcher already authorized this dispatch based on a fresh eligibility
check at 2026-06-11T20:00:00Z. Your job is to re-run the EXACT same canonical
eligibility predicate from
`projects/adversarial-merge-authority/SPEC.md` §4.2 against the current
live state, then either land the merge OR write a deferred audit JSON
and exit.

The predicate is the gate. Trust nothing else.

## Snapshot the watcher used (for audit context)

- **PR:** https://github.com/acme/myrepo/pull/1234
- **Repository:** acme/myrepo
- **PR number:** 1234
- **Reviewed head SHA:** `abc12345abc12345abc12345abc12345abc12345`
- **Risk class:** `low`
- **Merge method:** `squash` (NEVER rebase; SPEC §4.4 requires one canonical landed commit for provenance)
- **Required gate context:** `agent-os/adversarial-gate`
- **HQ owner user:** `unknown`
- **Audit JSON destination:** `/tmp/ama-test-hqroot/dispatch/audit/adversarial-merge-authority/acme-myrepo-pr-1234-abc12345abc12345abc12345abc12345abc12345.json`

## Step 1 — Re-run the eligibility predicate against fresh inputs

Run these gh commands to assemble a fresh snapshot (do NOT rely on the
watcher's snapshot — it could be stale by minutes):

```bash
# Live PR JSON
gh pr view https://github.com/acme/myrepo/pull/1234 --json number,headRefOid,state,isDraft,mergeable,mergeStateStatus,labels,statusCheckRollup,author,baseRefName > /tmp/ama-pr.json

# Latest adversarial review record for the current head
gh pr view https://github.com/acme/myrepo/pull/1234 --json reviews > /tmp/ama-reviews.json

# Branch protection for the target branch. GitHub returns a known 403
# upgrade/forbidden response on plans without branch protection; represent
# only that case with a structured sentinel so ama-check can apply
# branch_protection.required=false. Retry recognized transient gh/GitHub
# failures briefly; any non-transient or exhausted failure is a hard stop.
base_enc=$(printf '%s' "$(jq -r '.baseRefName' /tmp/ama-pr.json)" | jq -sRr @uri)
protection_err=$(mktemp)
protection_plan_unavailable_re='branch protection.*(not available|upgrade|plan)|upgrade.*branch protection|protected branches.*(not available|upgrade|plan)'
protection_transient_re='timed? out|timeout|TLS handshake timeout|connection (reset|refused|aborted)|temporary failure|network is unreachable|rate limit|secondary rate limit|HTTP[ /]5[0-9][0-9]|(^|[^0-9])(500|502|503|504)([^0-9]|$)|bad gateway|service unavailable|gateway timeout|server error'
protection_attempt=1
protection_max_attempts=3
while true; do
  : > "$protection_err"
  if gh api "repos/acme/myrepo/branches/$base_enc/protection" > /tmp/ama-protection.json 2> "$protection_err"; then
    break
  fi
  if grep -Eiq "$protection_plan_unavailable_re" "$protection_err"; then
    jq -n '{ branchProtectionUnavailable: true, reason: "github_plan" }' > /tmp/ama-protection.json
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
gh api "repos/acme/myrepo/issues/1234/timeline" --paginate > /tmp/ama-timeline.json
```

Then invoke the eligibility CLI shim. It loads the AMA config, normalizes
the inputs, and returns the SPEC §4.2 verdict:

```bash
node /Users/airlock/agent-os/tools/adversarial-review/bin/ama-check.mjs \
  --pr /tmp/ama-pr.json \
  --reviews /tmp/ama-reviews.json \
  --protection /tmp/ama-protection.json \
  --timeline /tmp/ama-timeline.json \
  --reviewed-sha abc12345abc12345abc12345abc12345abc12345 \
  --risk-class low \
  > /tmp/ama-verdict.json
```

The CLI emits a JSON object: `{ eligible: bool, reasons: string[], trace: {...} }`.

## Step 2 — Branch on the verdict

### If `eligible === false`

This is a **defer**, NOT a failure. The watcher will reconsider on its
next tick. Append a `deferred` attempt to the watcher-owned audit
record via the AMA-04 audit shim — the writer handles atomic
tmp+rename, mode 0640, and SPEC §4.4 state-machine derivation:

```bash
if [ "$(id -un)" != "unknown" ]; then
  echo "ama-closer owner mismatch: expected unknown, got $(id -un)" >&2
  exit 1
fi

# Capture the fresh predicate's reasons in the attempt entry.
ATTEMPT_JSON=$(mktemp)
jq -n --argjson reasons "$(jq '.reasons' /tmp/ama-verdict.json)" \
  '{ preMergeEligible: false, preMergeReasons: $reasons }' > "$ATTEMPT_JSON"

node /Users/airlock/agent-os/tools/adversarial-review/bin/ama-audit.mjs append \
  --hq-root /tmp/ama-test-hqroot \
  --repo acme/myrepo \
  --pr 1234 \
  --head abc12345abc12345abc12345abc12345abc12345 \
  --outcome deferred \
  --attempt-json "$ATTEMPT_JSON" \
  --now "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
rm -f "$ATTEMPT_JSON"
exit 0
```

Exit 0 — deferral is a legitimate terminal-for-this-head outcome.

### If `eligible === true`

Record the closer attempt BEFORE `gh pr merge`, then issue the merge
with `--match-head-commit` against the reviewed SHA. GitHub will
refuse if the head has advanced; treat that refusal as a normal defer,
not a failure.

```bash
PRE_MERGE_ATTEMPT_JSON=$(mktemp)
jq -n '{ preMergeEligible: true, attemptPhase: "before-gh-pr-merge" }' > "$PRE_MERGE_ATTEMPT_JSON"

node /Users/airlock/agent-os/tools/adversarial-review/bin/ama-audit.mjs append \
  --hq-root /tmp/ama-test-hqroot \
  --repo acme/myrepo \
  --pr 1234 \
  --head abc12345abc12345abc12345abc12345abc12345 \
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

TRAILERS_FILE=$(mktemp)
cat <<'EOF' > "$TRAILERS_FILE"
Closed-By: codex-closer (adversarial-pipe-mode)
Reviewed-By: claude-reviewer-lacey
Risk-Class: low
Eligibility-Reason: latest_review_settled_success, reviewer_family_recorded, risk_class_low_permitted, head_sha_matches_review, ci_all_green, no_blocking_labels, configured_gate_context_required
Eligibility-Trace: ama-audit:acme/myrepo:pr-1234:head-abc12345abc12345abc12345abc12345abc12345
EOF

gh pr merge https://github.com/acme/myrepo/pull/1234 \
  --squash \
  --match-head-commit abc12345abc12345abc12345abc12345abc12345 \
  --body-file "$TRAILERS_FILE" \
  > /tmp/ama-merge.stdout \
  2> /tmp/ama-merge.stderr
MERGE_EXIT=$?
rm -f "$TRAILERS_FILE"
```

## Step 3 — Re-read GitHub state (CLI exit code is NON-AUTHORITATIVE)

SPEC §7 risk row 4: `gh pr merge` can succeed server-side and exit
non-zero on transport noise. Always re-read GitHub before terminalizing.

```bash
sleep 2  # GitHub propagation
gh pr view https://github.com/acme/myrepo/pull/1234 --json state,mergedAt,mergeCommit,headRefOid > /tmp/ama-post-merge.json
PR_STATE=$(jq -r '.state' /tmp/ama-post-merge.json)
MERGED_AT=$(jq -r '.mergedAt' /tmp/ama-post-merge.json)
MERGE_COMMIT=$(jq -r '.mergeCommit.oid // empty' /tmp/ama-post-merge.json)
POST_HEAD=$(jq -r '.headRefOid' /tmp/ama-post-merge.json)
```

## Step 4 — Terminalize the audit JSON

Decision matrix:

| Post-read state | Outcome |
|---|---|
| `PR_STATE == MERGED && POST_HEAD == REVIEWED_SHA` | `succeeded` |
| `PR_STATE == MERGED && POST_HEAD != REVIEWED_SHA` | `superseded` (someone else landed a different head) |
| `PR_STATE == OPEN && POST_HEAD != REVIEWED_SHA` | `superseded` (head advanced; defer) |
| `PR_STATE == OPEN && POST_HEAD == REVIEWED_SHA && MERGE_EXIT != 0` | `failed-without-merge` |
| `PR_STATE == OPEN && POST_HEAD == REVIEWED_SHA && MERGE_EXIT == 0` | `in_progress` + `reconciliation.needsRepair = true` (the next watcher tick reconciles) |

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
if [ "$PR_STATE" = "MERGED" ] && [ "$POST_HEAD" = "abc12345abc12345abc12345abc12345abc12345" ]; then
  OUTCOME=succeeded
elif [ "$PR_STATE" = "MERGED" ] || [ "$POST_HEAD" != "abc12345abc12345abc12345abc12345abc12345" ]; then
  OUTCOME=superseded
elif [ "$MERGE_EXIT" != "0" ]; then
  OUTCOME=failed-without-merge
else
  OUTCOME=in_progress
fi

ATTEMPT_JSON=$(mktemp)
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
  --hq-root /tmp/ama-test-hqroot \
  --repo acme/myrepo \
  --pr 1234 \
  --head abc12345abc12345abc12345abc12345abc12345 \
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
  "repo": "acme/myrepo",
  "prNumber": 1234,
  "headSha": "abc12345abc12345abc12345abc12345abc12345",
  "createdAt": "<ISO>",
  "updatedAt": "<ISO>",
  "status": "<in_progress|deferred|superseded|succeeded|failed-without-merge>",
  "reviewedBy": "<reviewer login>",
  "reviewSha": "abc12345abc12345abc12345abc12345abc12345",
  "riskClass": "low",
  "requiredGateContexts": ["agent-os/adversarial-gate"],
  "eligibilityReasons": ["<watcher eligibility reason>", "<...>"],
  "mergeMethod": "squash",
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

- Don't `gh pr merge` without `--match-head-commit abc12345abc12345abc12345abc12345abc12345`. Head advance = defer, not merge.
- Don't terminalize as `succeeded` or `failed-without-merge` on CLI exit code alone. Always re-read GitHub state.
- Don't retry `gh pr merge` inside this prompt. The next watcher tick re-evaluates from `in_progress` + `needsRepair=true`.
- Don't write the audit JSON anywhere other than `/tmp/ama-test-hqroot/dispatch/audit/adversarial-merge-authority/acme-myrepo-pr-1234-abc12345abc12345abc12345abc12345abc12345.json`, and only do it when `id -un` matches `unknown`. The watcher reads it back from there.
- Don't commit anything to the worker's checkout. There is no checkout state to preserve — this is a close-only worker.

<!-- hq:closeout:pr -->

## Close-out

When you've written the terminal audit JSON, exit 0. The watcher will
reconcile on its next tick. No PR open is required — this worker
doesn't open a PR; it closes someone else's.
