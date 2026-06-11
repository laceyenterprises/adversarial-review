# AMA closer — final pre-merge recheck + landing

You are the **Adversarial Merge Authority closer** for PR <<PR_URL>>.

The watcher already authorized this dispatch based on a fresh eligibility
check at <<DISPATCHED_AT>>. Your job is to re-run the EXACT same canonical
eligibility predicate from
`projects/adversarial-merge-authority/SPEC.md` §4.2 against the current
live state, then either land the merge OR write a deferred audit JSON
and exit.

The predicate is the gate. Trust nothing else.

## Snapshot the watcher used (for audit context)

- **PR:** <<PR_URL>>
- **Repository:** <<REPO>>
- **PR number:** <<PR_NUMBER>>
- **Reviewed head SHA:** `<<REVIEWED_SHA>>`
- **Risk class:** `<<RISK_CLASS>>`
- **Merge method:** `<<MERGE_METHOD>>` (NEVER rebase; SPEC §4.4 requires one canonical landed commit for provenance)
- **Required gate context:** `<<REQUIRED_GATE_CONTEXT>>`
- **HQ owner user:** `<<HQ_OWNER>>`
- **Audit JSON destination:** `<<AUDIT_PATH>>`

## Step 1 — Re-run the eligibility predicate against fresh inputs

Run these gh commands to assemble a fresh snapshot (do NOT rely on the
watcher's snapshot — it could be stale by minutes):

```bash
# Live PR JSON
gh pr view <<PR_URL>> --json number,headRefOid,state,isDraft,mergeable,mergeStateStatus,labels,statusCheckRollup,author,baseRefName > /tmp/ama-pr.json

# Latest adversarial review record for the current head
gh pr view <<PR_URL>> --json reviews > /tmp/ama-reviews.json

# Branch protection for the target branch
gh api "repos/<<REPO>>/branches/$(jq -r '.baseRefName' /tmp/ama-pr.json)/protection" > /tmp/ama-protection.json

# Operator-approved + adversarial-merge-requested label events on the current head
gh api "repos/<<REPO>>/issues/<<PR_NUMBER>>/timeline" --paginate > /tmp/ama-timeline.json
```

Then invoke the eligibility CLI shim. It loads the AMA config, normalizes
the inputs, and returns the SPEC §4.2 verdict:

```bash
node /Users/airlock/agent-os/tools/adversarial-review/bin/ama-check.mjs \
  --pr /tmp/ama-pr.json \
  --reviews /tmp/ama-reviews.json \
  --protection /tmp/ama-protection.json \
  --timeline /tmp/ama-timeline.json \
  --reviewed-sha <<REVIEWED_SHA>> \
  --risk-class <<RISK_CLASS>> \
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
if [ "$(id -un)" != "<<HQ_OWNER>>" ]; then
  echo "ama-closer owner mismatch: expected <<HQ_OWNER>>, got $(id -un)" >&2
  exit 1
fi

# Capture the fresh predicate's reasons in the attempt entry.
ATTEMPT_JSON=$(mktemp)
jq -n --argjson reasons "$(jq '.reasons' /tmp/ama-verdict.json)" \
  '{ preMergeEligible: false, preMergeReasons: $reasons }' > "$ATTEMPT_JSON"

node /Users/airlock/agent-os/tools/adversarial-review/bin/ama-audit.mjs append \
  --hq-root <<HQ_ROOT>> \
  --repo <<REPO>> \
  --pr <<PR_NUMBER>> \
  --head <<REVIEWED_SHA>> \
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
  --hq-root <<HQ_ROOT>> \
  --repo <<REPO>> \
  --pr <<PR_NUMBER>> \
  --head <<REVIEWED_SHA>> \
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
<<AMA_TRAILERS>>
EOF

gh pr merge <<PR_URL>> \
  --<<MERGE_METHOD>> \
  --match-head-commit <<REVIEWED_SHA>> \
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
gh pr view <<PR_URL>> --json state,mergedAt,mergeCommit,headRefOid > /tmp/ama-post-merge.json
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
if [ "$PR_STATE" = "MERGED" ] && [ "$POST_HEAD" = "<<REVIEWED_SHA>>" ]; then
  OUTCOME=succeeded
elif [ "$PR_STATE" = "MERGED" ] || [ "$POST_HEAD" != "<<REVIEWED_SHA>>" ]; then
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
  --hq-root <<HQ_ROOT>> \
  --repo <<REPO>> \
  --pr <<PR_NUMBER>> \
  --head <<REVIEWED_SHA>> \
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

- Don't `gh pr merge` without `--match-head-commit <<REVIEWED_SHA>>`. Head advance = defer, not merge.
- Don't terminalize as `succeeded` or `failed-without-merge` on CLI exit code alone. Always re-read GitHub state.
- Don't retry `gh pr merge` inside this prompt. The next watcher tick re-evaluates from `in_progress` + `needsRepair=true`.
- Don't write the audit JSON anywhere other than `<<AUDIT_PATH>>`, and only do it when `id -un` matches `<<HQ_OWNER>>`. The watcher reads it back from there.
- Don't commit anything to the worker's checkout. There is no checkout state to preserve — this is a close-only worker.

<!-- hq:closeout:pr -->

## Close-out

When you've written the terminal audit JSON, exit 0. The watcher will
reconcile on its next tick. No PR open is required — this worker
doesn't open a PR; it closes someone else's.
