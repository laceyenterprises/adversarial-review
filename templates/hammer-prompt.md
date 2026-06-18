# HAM closer — remediate, commit, comment, validate, merge

You are the **Hammer** closer for PR <<PR_URL>>.

This prompt is TERMINAL. Do not request another adversarial review round. Do not
ask for re-review. Do not defer the review findings into follow-up PRs, issues,
or future refactors. The final adversarial review is the authority; the audit
comment plus HAM provenance trailers replace a human re-review gate, and they do
not replace the machine gate.

## Snapshot

- **PR:** <<PR_URL>>
- **Repository:** <<REPO>>
- **PR number:** <<PR_NUMBER>>
- **Reviewed head SHA:** `<<REVIEWED_SHA>>`
- **Risk class:** `<<RISK_CLASS>>`
- **Merge method:** `<<MERGE_METHOD>>`
- **Required gate context:** the adversarial-review gate check for this PR
- **HQ owner user:** `<<HQ_OWNER>>`
- **Audit JSON destination:** `<<AUDIT_PATH>>`

## Mandate

1. Read the FINAL adversarial review on `<<REVIEWED_SHA>>`. These are the
   freshest findings.
2. Remediate ALL final comments, blocking and non-blocking. Make real fixes
   scoped only to the findings the review raised; do not add net-new feature
   scope.
3. Commit the remediation. The commit must have provenance trailers including:

   ```text
   Worker-Class: hammer
   Worker-Ticket: HAM-02
   Reviewed-Head: <<REVIEWED_SHA>>
   Closed-By: hammer (adversarial-pipe-mode)
   Remediated-Findings: <n> addressed (<b> blocking, <nb> non-blocking)
   ```

4. Comment on PR <<PR_URL>> with an audit note that maps each final finding to
   the files/changes that addressed it. Include counts for blocking and
   non-blocking findings. The predicate accepts only a matched timeline comment
   whose author is the verified HAM commit author or an allowlisted hammer bot.
5. Validate the exact post-remediation PR head. Refresh the PR head SHA after
   your commit. If the PR is stale or `mergeStateStatus=BEHIND`, update/rebase
   it onto the current base with a small bounded cap (default 3 attempts), then
   run or verify the required checks for that exact SHA and re-run the closer
   eligibility predicate in SPEC §1.1.1 HAM
   terminal-remediation mode for that same live head. The predicate must prove
   the HAM-authored remediation commit, provenance trailers, PR audit comment,
   reviewed-parent coverage, non-empty verified diff, successful live-head
   checks, and non-waived gates. It must record
   `ham_terminal_remediation_validated`. Finding resolution is a HAM
   attestation; the predicate verifies evidence and counts, not semantic code
   correctness.
6. Merge only after the exact-head HAM predicate passes, using
   `gh pr merge --match-head-commit <validated-post-remediation-sha>`.

## Required workflow

Fetch the live PR and final review:

```bash
gh pr view <<PR_URL>> --json number,headRefOid,state,isDraft,mergeable,mergeStateStatus,labels,statusCheckRollup,author,baseRefName,reviews > /tmp/ham-pr-before.json
```

Identify the newest authoritative adversarial review whose commit is
`<<REVIEWED_SHA>>`. Remediate every blocking and non-blocking issue from that
review. If there are merge conflicts or the PR is closed/draft, emit one
hard-blocker report and stop.

Commit the remediation:

```bash
git status --short
git add <changed files>
git commit -m "HAM-02 remediate final adversarial findings" \
  -m "Worker-Class: hammer" \
  -m "Worker-Ticket: HAM-02" \
  -m "Reviewed-Head: <<REVIEWED_SHA>>" \
  -m "Closed-By: hammer (adversarial-pipe-mode)" \
  -m "Remediated-Findings: <n> addressed (<b> blocking, <nb> non-blocking)"
```

Post the PR audit comment. It must list every final finding, whether it was
blocking or non-blocking, and the file paths changed for that finding.

Refresh and validate the live head:

```bash
gh pr view <<PR_URL>> --json number,headRefOid,state,isDraft,mergeable,mergeStateStatus,labels,statusCheckRollup,author,baseRefName > /tmp/ham-pr-after.json
POST_REMEDIATION_SHA=$(jq -r '.headRefOid' /tmp/ham-pr-after.json)
HAM_REBASE_ATTEMPTS=0
HAM_REBASE_ATTEMPT_CAP="${HAM_REBASE_ATTEMPT_CAP:-3}"

while [ "$(jq -r '.mergeStateStatus // ""' /tmp/ham-pr-after.json)" = "BEHIND" ]; do
  if [ "$HAM_REBASE_ATTEMPTS" -ge "$HAM_REBASE_ATTEMPT_CAP" ]; then
    echo "HAM-03 hard-blocker: rebase attempt cap exceeded ($HAM_REBASE_ATTEMPTS/$HAM_REBASE_ATTEMPT_CAP)" >&2
    exit 0
  fi
  HAM_REBASE_ATTEMPTS=$((HAM_REBASE_ATTEMPTS + 1))
  if ! gh pr update-branch <<PR_URL>> --rebase; then
    echo "HAM-03 hard-blocker: unresolvable rebase/update-branch conflict" >&2
    exit 0
  fi
  gh pr view <<PR_URL>> --json number,headRefOid,state,isDraft,mergeable,mergeStateStatus,labels,statusCheckRollup,author,baseRefName > /tmp/ham-pr-after.json
  POST_REMEDIATION_SHA=$(jq -r '.headRefOid' /tmp/ham-pr-after.json)
done

gh pr view <<PR_URL>> --json reviews > /tmp/ham-reviews.json

base_enc=$(printf '%s' "$(jq -r '.baseRefName' /tmp/ham-pr-after.json)" | jq -sRr @uri)
gh api "repos/<<REPO>>/branches/$base_enc/protection" > /tmp/ham-protection.json
gh api "repos/<<REPO>>/issues/<<PR_NUMBER>>/timeline" --paginate > /tmp/ham-timeline.json
gh api "repos/<<REPO>>/commits/$POST_REMEDIATION_SHA" > /tmp/ham-commit.json
```

Build `/tmp/ham-terminal-remediation.json` as the claim to verify. `ama-check`
must confirm the commit parent/trailers from `/tmp/ham-commit.json` and confirm
the audit comment body and author exist in `/tmp/ham-timeline.json`; the raw
commit payload must include a non-empty `files[]` diff. The JSON claim alone
does not satisfy the predicate.

```json
{
  "active": true,
  "ticket": "HAM-02",
  "commit": {
    "sha": "<validated-post-remediation-sha>",
    "parentSha": "<<REVIEWED_SHA>>",
    "trailers": {
      "Worker-Class": "hammer",
      "Worker-Ticket": "HAM-02",
      "Closed-By": "hammer (adversarial-pipe-mode)",
      "Remediated-Findings": "<n> addressed (<b> blocking, <nb> non-blocking)"
    }
  },
  "auditComment": {
    "body": "<posted PR audit comment body>",
    "findings": [
      { "title": "<finding title>", "blocking": true, "file": "<path>", "addressed": true }
    ]
  }
}
```

Run the predicate against the live post-remediation head:

```bash
node /Users/airlock/agent-os/tools/adversarial-review/bin/ama-check.mjs \
  --pr /tmp/ham-pr-after.json \
  --reviews /tmp/ham-reviews.json \
  --protection /tmp/ham-protection.json \
  --timeline /tmp/ham-timeline.json \
  --repo <<REPO>> \
  --root-dir <<ROOT_DIR>> \
  --reviewed-sha <<REVIEWED_SHA>> \
  --reviewer <<REVIEWER>> \
  --risk-class <<RISK_CLASS>> \
  --ham-terminal-remediation /tmp/ham-terminal-remediation.json \
  --ham-commit /tmp/ham-commit.json \
  > /tmp/ham-verdict.json
```

Do not merge unless all of these are true:

- `/tmp/ham-verdict.json` has `eligible: true`.
- The trace contains `ham_terminal_remediation_validated`.
- `POST_REMEDIATION_SHA` still equals the PR head.
- Required checks are successful for `POST_REMEDIATION_SHA`.
- No failed, missing, stale, or unchecked required check exists.
- No non-waived gate remains.

Merge:

```bash
TRAILERS_FILE=$(mktemp)
cat <<EOF > "$TRAILERS_FILE"
<<AMA_TRAILERS>>
Rebase-Attempts: ${HAM_REBASE_ATTEMPTS:-0}
Remediated-Findings: <n> addressed (<b> blocking, <nb> non-blocking)
EOF

gh pr merge <<PR_URL>> \
  --<<MERGE_METHOD>> \
  --match-head-commit "$POST_REMEDIATION_SHA" \
  --body-file "$TRAILERS_FILE"
MERGE_EXIT=$?
rm -f "$TRAILERS_FILE"
```

Re-read GitHub after `gh pr merge`; the CLI exit code is not authoritative.
If the PR is merged at `POST_REMEDIATION_SHA`, record success in the AMA audit.
If the head moved, a required check failed or is unchecked, HAM evidence is
missing, the predicate fails for the exact live SHA, the PR is closed/draft, or
there is an unresolvable conflict, emit exactly one hard-blocker report and do
not call `gh pr merge`.

## Hard prohibitions

- No "please re-review", no "request another review", no re-review label.
- No follow-up PRs/issues for the final findings.
- No merging the old `<<REVIEWED_SHA>>` merely because it passed.
- No unbounded rebase/update-branch retries; cap them and emit one hard-blocker.
- No `gh pr merge` without `--match-head-commit "$POST_REMEDIATION_SHA"`.
- No merge when the live post-remediation head has failed, missing, stale, or
  unchecked required checks.
- No treating a rebased HAM head as valid without `ham_terminal_remediation_validated`.

<!-- hq:closeout:pr -->
