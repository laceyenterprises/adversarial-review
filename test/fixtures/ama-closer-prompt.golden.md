# AMA closer — final pre-merge recheck + landing

You are the **Adversarial Merge Authority closer** for PR https://github.com/acme/myrepo/pull/1234.

The watcher already authorized this dispatch based on a fresh eligibility
check at 2026-06-11T20:00:00Z. Your job is to re-run the EXACT same canonical
eligibility predicate from
`projects/adversarial-merge-authority/SPEC.md` §4.2 against the current
live state, then either land the merge OR write a deferred audit JSON
and exit.

The watcher already created or refreshed the watcher-owned `in_progress`
audit record for this exact `(repo, prNumber, headSha)` before launching
you. Every audit write in this prompt appends to that record; do not try
to create a second file.

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

# Branch protection for the target branch
gh api "repos/acme/myrepo/branches/$(jq -r '.baseRefName' /tmp/ama-pr.json)/protection" > /tmp/ama-protection.json

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
APPEND_EXIT=$?
rm -f "$ATTEMPT_JSON"
if [ $APPEND_EXIT -eq 66 ]; then
  echo "audit append refused (sticky succeeded already recorded; treating as no-op)" >&2
  exit 0
fi
exit $APPEND_EXIT
```

Exit 0 — deferral is a legitimate terminal-for-this-head outcome.

### If `eligible === true`

Record the merge attempt durably before invoking GitHub, then generate
the required provenance trailers and issue the merge with
`--match-head-commit` against the reviewed SHA. GitHub will refuse if
the head has advanced; treat that refusal as a normal defer, not a
failure.

```bash
ATTEMPT_ID="$(date -u +%Y%m%dT%H%M%SZ)-ama-closer"
ATTEMPT_JSON=$(mktemp)
jq -n \
  --arg attemptId "$ATTEMPT_ID" \
  --argjson reasons "$(jq '.reasons' /tmp/ama-verdict.json)" \
  '{
    attemptId: $attemptId,
    preMergeEligible: true,
    preMergeReasons: $reasons
  }' > "$ATTEMPT_JSON"
node /Users/airlock/agent-os/tools/adversarial-review/bin/ama-audit.mjs append \
  --hq-root /tmp/ama-test-hqroot \
  --repo acme/myrepo \
  --pr 1234 \
  --head abc12345abc12345abc12345abc12345abc12345 \
  --outcome in_progress \
  --attempt-json "$ATTEMPT_JSON" \
  --now "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
PREMERGE_APPEND_EXIT=$?
rm -f "$ATTEMPT_JSON"
if [ $PREMERGE_APPEND_EXIT -eq 66 ]; then
  echo "audit append refused (sticky succeeded already recorded; treating as no-op)" >&2
  exit 0
fi
if [ $PREMERGE_APPEND_EXIT -ne 0 ]; then
  exit $PREMERGE_APPEND_EXIT
fi

ELIGIBILITY_REASON=$(jq -r '.reasons | if length > 0 then join(", ") else "eligible on fresh AMA recheck" end' /tmp/ama-verdict.json)
TRAILERS_FILE=$(mktemp)
node /Users/airlock/agent-os/tools/adversarial-review/bin/ama-audit.mjs trailers \
  --worker-class codex \
  --reviewer claude-reviewer-lacey \
  --risk-class low \
  --reason "$ELIGIBILITY_REASON" \
  --audit-path "/tmp/ama-test-hqroot/dispatch/audit/adversarial-merge-authority/acme-myrepo-pr-1234-abc12345abc12345abc12345abc12345abc12345.json" \
  > "$TRAILERS_FILE"
TRAILERS_EXIT=$?
if [ $TRAILERS_EXIT -ne 0 ]; then
  rm -f "$TRAILERS_FILE"
  exit $TRAILERS_EXIT
fi

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

Compute the outcome, then append the attempt via the AMA-04 audit
shim. The writer derives the surface `status` per SPEC §4.4 (incl.
sticky-succeeded) and refuses to demote a terminal `succeeded` —
treat a refusal exit code (`66`) as a signal the watcher already
finalized a different head and exit 0:

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
  --arg attemptId "$ATTEMPT_ID" \
  --arg outcome "$OUTCOME" \
  --arg mergeCommit "${MERGE_COMMIT:-}" \
  --arg mergedAt "${MERGED_AT:-}" \
  --argjson cliExit ${MERGE_EXIT:-0} \
  '{
    attemptId: $attemptId,
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
if [ $APPEND_EXIT -eq 66 ]; then
  echo "audit append refused (sticky succeeded already recorded; treating as no-op)" >&2
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
  "reviewedBy": "claude-reviewer-lacey",
  "reviewSha": "abc12345abc12345abc12345abc12345abc12345",
  "requiredGateContexts": ["agent-os/adversarial-gate"],
  "riskClass": "low",
  "riskClassSource": "watcher-review-state",
  "eligibilityReasons": ["<watcher authorization reasons>"],
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
- Don't invoke `gh pr merge` before the `in_progress` attempt has been durably appended for this head.
- Don't retry `gh pr merge` inside this prompt. The next watcher tick re-evaluates from `in_progress` + `needsRepair=true`.
- Don't write the audit JSON anywhere other than `/tmp/ama-test-hqroot/dispatch/audit/adversarial-merge-authority/acme-myrepo-pr-1234-abc12345abc12345abc12345abc12345abc12345.json`, and only do it when `id -un` matches `unknown`. The watcher reads it back from there.
- Don't commit anything to the worker's checkout. There is no checkout state to preserve — this is a close-only worker.

<!-- hq:closeout:pr -->

## Close-out

When you've written the terminal audit JSON, exit 0. The watcher will
reconcile on its next tick. No PR open is required — this worker
doesn't open a PR; it closes someone else's.
