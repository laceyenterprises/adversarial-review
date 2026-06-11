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
next tick. Write the deferred audit JSON:

```bash
if [ "$(id -un)" != "unknown" ]; then
  echo "ama-closer owner mismatch: expected unknown, got $(id -un)" >&2
  exit 1
fi
mkdir -p "$(dirname "/tmp/ama-test-hqroot/dispatch/audit/adversarial-merge-authority/acme-myrepo-pr-1234-abc12345abc12345abc12345abc12345abc12345.json")"
cat > /tmp/ama-test-hqroot/dispatch/audit/adversarial-merge-authority/acme-myrepo-pr-1234-abc12345abc12345abc12345abc12345abc12345.json <<EOF
{
  "prNumber": 1234,
  "headSha": "abc12345abc12345abc12345abc12345abc12345",
  "status": "deferred",
  "attempts": [{
    "attemptId": "$(date -u +%Y-%m-%dT%H:%M:%SZ)-ama-closer",
    "startedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
    "preMergeEligible": false,
    "preMergeReasons": $(jq '.reasons' /tmp/ama-verdict.json)
  }],
  "attemptedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "mergeMethod": "squash",
  "reconciliation": { "needsRepair": false, "lastVerifiedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)" }
}
EOF
exit 0
```

Exit 0 — deferral is a legitimate terminal-for-this-head outcome.

### If `eligible === true`

Issue the merge with `--match-head-commit` against the reviewed SHA.
GitHub will refuse if the head has advanced; treat that refusal as a
normal defer, not a failure.

```bash
gh pr merge https://github.com/acme/myrepo/pull/1234 \
  --squash \
  --match-head-commit abc12345abc12345abc12345abc12345abc12345 \
  > /tmp/ama-merge.stdout \
  2> /tmp/ama-merge.stderr
MERGE_EXIT=$?
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

| Post-read state | Audit `status` |
|---|---|
| `PR_STATE == MERGED && POST_HEAD == REVIEWED_SHA` | `succeeded` |
| `PR_STATE == MERGED && POST_HEAD != REVIEWED_SHA` | `superseded` (someone else landed a different head) |
| `PR_STATE == OPEN && POST_HEAD != REVIEWED_SHA` | `superseded` (head advanced; defer) |
| `PR_STATE == OPEN && POST_HEAD == REVIEWED_SHA && MERGE_EXIT != 0` | `failed-without-merge` |
| `PR_STATE == OPEN && POST_HEAD == REVIEWED_SHA && MERGE_EXIT == 0` | `in_progress` + `reconciliation.needsRepair = true` (the next watcher tick reconciles) |

Write the terminal audit JSON to `/tmp/ama-test-hqroot/dispatch/audit/adversarial-merge-authority/acme-myrepo-pr-1234-abc12345abc12345abc12345abc12345abc12345.json`. Required fields per
SPEC §4.4:

```json
{
  "prNumber": 1234,
  "headSha": "abc12345abc12345abc12345abc12345abc12345",
  "status": "<succeeded|deferred|superseded|failed-without-merge|in_progress>",
  "attempts": [...],
  "attemptedAt": "<ISO>",
  "mergedAt": "<ISO or null>",
  "mergedBy": "ama-closer",
  "reviewedBy": "claude-reviewer-lacey",
  "reviewSha": "abc12345abc12345abc12345abc12345abc12345",
  "riskClass": "low",
  "requiredGateContexts": ["agent-os/adversarial-gate"],
  "eligibilityReasons": [...],
  "preMergeCheckLatencyMs": <N>,
  "mergeMethod": "squash",
  "reconciliation": { "needsRepair": <bool>, "lastVerifiedAt": "<ISO>" }
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
