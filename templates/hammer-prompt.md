# HAM closer — remediate, commit, comment, validate, merge

You are the **Hammer** closer for PR <<PR_URL>>.

This prompt is TERMINAL. Do not request another adversarial review round. Do not
ask for re-review. Do not defer the review findings into follow-up PRs, issues,
or future refactors. The final adversarial review is the authority; the PR audit
comment plus HAM provenance trailers replace a human re-review gate, and they do
not replace the machine gate.

Either land the PR after exact-head HAM validation passes, or emit ONE
hard-blocker report. Genuine hard blockers only: PR closed, PR draft,
unresolvable conflict, lost eligibility, failed/missing/stale/unchecked required
check, missing HAM provenance, missing PR audit evidence, or exact-head
predicate failure.

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
   freshest and authoritative findings.
2. Remediate ALL final comments, blocking and non-blocking. Make real fixes
   scoped to what the review raised. Do not add net-new feature scope.
3. Commit the remediation on top of the reviewed head with HAM provenance
   trailers:

   ```text
   Worker-Class: hammer
   Worker-Ticket: HAM-02
   Reviewed-Head: <<REVIEWED_SHA>>
   Closed-By: hammer (adversarial-pipe-mode)
   Remediated-Findings: <n> addressed (<b> blocking, <nb> non-blocking)
   ```

4. Comment on PR <<PR_URL>> with an audit note that lists exactly what was
   addressed per final finding. For each finding include the blocking/non-
   blocking classification and the file paths changed for that finding.
5. Validate the exact post-remediation PR head. Refresh the live PR head SHA
   after your commit. If the branch head moves for any reason after your
   remediation commit, stop as a hard blocker; HAM terminal remediation does not
   update or rebase the branch. Do not merge a stale or behind head merely
   because the old reviewed SHA passed.
6. Run or verify required checks for that exact post-remediation SHA. If checks
   are queued or in progress immediately after the HAM commit lands, poll the
   live PR for a bounded settle window before classifying them. Failed, missing,
   stale, or still-unchecked required checks after that settle window are hard
   blockers.
7. Re-run the closer eligibility predicate against that same exact SHA using
   SPEC §1.1.1 HAM terminal-remediation mode. The predicate must prove the
   HAM-authored remediation commit, provenance trailers, PR audit comment,
   reviewed-parent coverage, non-empty verified diff, successful live-head
   checks, and non-waived gates. It must record
   `ham_terminal_remediation_validated`.
8. Merge only after the exact-head HAM predicate passes, using
   `gh pr merge --match-head-commit <validated-post-remediation-sha>`.

## Required workflow

Fetch the live PR and final review:

```bash
HAM_TMP_DIR="${TMPDIR:-/tmp}/ham-closer-$(id -u)-<<PR_NUMBER>>-<<REVIEWED_SHA>>"
if [ -L "$HAM_TMP_DIR" ]; then
  echo "hard-blocker: HAM_TMP_DIR is a symlink: $HAM_TMP_DIR" >&2
  exit 1
fi
mkdir -p "$HAM_TMP_DIR"
HAM_TMP_OWNER=$(stat -f '%u' "$HAM_TMP_DIR" 2>/dev/null || stat -c '%u' "$HAM_TMP_DIR")
if [ "$HAM_TMP_OWNER" != "$(id -u)" ]; then
  echo "hard-blocker: HAM_TMP_DIR owned by uid $HAM_TMP_OWNER, expected $(id -u)" >&2
  exit 1
fi
chmod 700 "$HAM_TMP_DIR"
rm -f "$HAM_TMP_DIR"/ham-*.json

gh pr view <<PR_URL>> --json number,headRefOid,state,isDraft,mergeable,mergeStateStatus,labels,statusCheckRollup,author,baseRefName,reviews > "$HAM_TMP_DIR/ham-pr-before.json"
```

Identify the newest authoritative adversarial review whose commit is
`<<REVIEWED_SHA>>`. Remediate every blocking and non-blocking issue from that
review. If the PR is closed/draft, or if a conflict is genuinely unresolvable,
emit one hard-blocker report and stop.

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

Refresh the live head and collect exact-head evidence:

```bash
HAM_TMP_DIR="${TMPDIR:-/tmp}/ham-closer-$(id -u)-<<PR_NUMBER>>-<<REVIEWED_SHA>>"
if [ -L "$HAM_TMP_DIR" ]; then
  echo "hard-blocker: HAM_TMP_DIR is a symlink: $HAM_TMP_DIR" >&2
  exit 1
fi
mkdir -p "$HAM_TMP_DIR"
HAM_TMP_OWNER=$(stat -f '%u' "$HAM_TMP_DIR" 2>/dev/null || stat -c '%u' "$HAM_TMP_DIR")
if [ "$HAM_TMP_OWNER" != "$(id -u)" ]; then
  echo "hard-blocker: HAM_TMP_DIR owned by uid $HAM_TMP_OWNER, expected $(id -u)" >&2
  exit 1
fi
chmod 700 "$HAM_TMP_DIR"

gh pr view <<PR_URL>> --json number,headRefOid,state,isDraft,mergeable,mergeStateStatus,labels,statusCheckRollup,author,baseRefName > "$HAM_TMP_DIR/ham-pr-after.json"
POST_REMEDIATION_SHA=$(jq -r '.headRefOid' "$HAM_TMP_DIR/ham-pr-after.json")

gh pr view <<PR_URL>> --json reviews > "$HAM_TMP_DIR/ham-reviews.json"

base_enc=$(printf '%s' "$(jq -r '.baseRefName' "$HAM_TMP_DIR/ham-pr-after.json")" | jq -sRr @uri)
gh api "repos/<<REPO>>/branches/$base_enc/protection" > "$HAM_TMP_DIR/ham-protection.json"
gh api "repos/<<REPO>>/issues/<<PR_NUMBER>>/timeline" --paginate > "$HAM_TMP_DIR/ham-timeline.json"
gh api "repos/<<REPO>>/commits/$POST_REMEDIATION_SHA" > "$HAM_TMP_DIR/ham-commit.json"
```

Wait for required checks on `POST_REMEDIATION_SHA` to settle before evaluating
the hard-blocker list:

```bash
HAM_CHECK_SETTLE_SECONDS="${HAM_CHECK_SETTLE_SECONDS:-900}"
HAM_CHECK_POLL_SECONDS="${HAM_CHECK_POLL_SECONDS:-15}"
HAM_CHECK_DEADLINE=$((SECONDS + HAM_CHECK_SETTLE_SECONDS))

while true; do
  gh pr view <<PR_URL>> --json number,headRefOid,state,isDraft,mergeable,mergeStateStatus,labels,statusCheckRollup,author,baseRefName > "$HAM_TMP_DIR/ham-pr-after.json"
  LIVE_SHA=$(jq -r '.headRefOid' "$HAM_TMP_DIR/ham-pr-after.json")
  if [ "$LIVE_SHA" != "$POST_REMEDIATION_SHA" ]; then
    echo "hard-blocker: PR head moved from $POST_REMEDIATION_SHA to $LIVE_SHA" >&2
    exit 1
  fi
  HAM_UNSETTLED_CHECKS=$(jq '[.statusCheckRollup[]? | select((((.conclusion // .state // .status // .statusCheckRollup.state // "") | ascii_upcase) as $state | (["SUCCESS","NEUTRAL","SKIPPED"] | index($state) | not)))] | length' "$HAM_TMP_DIR/ham-pr-after.json")
  if [ "$HAM_UNSETTLED_CHECKS" = "0" ]; then
    break
  fi
  if [ "$SECONDS" -ge "$HAM_CHECK_DEADLINE" ]; then
    echo "hard-blocker: required checks did not settle for $POST_REMEDIATION_SHA" >&2
    jq '.statusCheckRollup' "$HAM_TMP_DIR/ham-pr-after.json" >&2
    exit 1
  fi
  sleep "$HAM_CHECK_POLL_SECONDS"
done
```

Only terminal success states accepted by the merge-path check classifier
(`SUCCESS`, `NEUTRAL`, `SKIPPED`) count as successful. If required checks remain
queued, in progress, pending, missing, stale, or otherwise unchecked at the
deadline, stop as a hard blocker.

Build `$HAM_TMP_DIR/ham-terminal-remediation.json` as the claim to verify.
`ama-check` must confirm the commit parent/trailers from
`$HAM_TMP_DIR/ham-commit.json` and confirm the audit comment body and author
exist in `$HAM_TMP_DIR/ham-timeline.json`; the raw commit payload must include a
non-empty `files[]` diff. The JSON claim alone does not satisfy the predicate.

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
HAM_TMP_DIR="${TMPDIR:-/tmp}/ham-closer-$(id -u)-<<PR_NUMBER>>-<<REVIEWED_SHA>>"
if [ -L "$HAM_TMP_DIR" ]; then
  echo "hard-blocker: HAM_TMP_DIR is a symlink: $HAM_TMP_DIR" >&2
  exit 1
fi
mkdir -p "$HAM_TMP_DIR"
HAM_TMP_OWNER=$(stat -f '%u' "$HAM_TMP_DIR" 2>/dev/null || stat -c '%u' "$HAM_TMP_DIR")
if [ "$HAM_TMP_OWNER" != "$(id -u)" ]; then
  echo "hard-blocker: HAM_TMP_DIR owned by uid $HAM_TMP_OWNER, expected $(id -u)" >&2
  exit 1
fi
chmod 700 "$HAM_TMP_DIR"

node /Users/airlock/agent-os/tools/adversarial-review/bin/ama-check.mjs \
  --pr "$HAM_TMP_DIR/ham-pr-after.json" \
  --reviews "$HAM_TMP_DIR/ham-reviews.json" \
  --protection "$HAM_TMP_DIR/ham-protection.json" \
  --timeline "$HAM_TMP_DIR/ham-timeline.json" \
  --repo <<REPO>> \
  --root-dir <<ROOT_DIR>> \
  --reviewed-sha <<REVIEWED_SHA>> \
  --reviewer <<REVIEWER>> \
  --risk-class <<RISK_CLASS>> \
  --ham-terminal-remediation "$HAM_TMP_DIR/ham-terminal-remediation.json" \
  --ham-commit "$HAM_TMP_DIR/ham-commit.json" \
  > "$HAM_TMP_DIR/ham-verdict.json"
```

Do not merge unless all of these are true:

- `$HAM_TMP_DIR/ham-verdict.json` has `eligible: true`.
- The trace contains `ham_terminal_remediation_validated`.
- `POST_REMEDIATION_SHA` still equals the live PR head.
- Required checks are successful for `POST_REMEDIATION_SHA`.
- No failed, missing, stale, or unchecked required check exists.
- No non-waived gate remains.

Merge:

```bash
HAM_TMP_DIR="${TMPDIR:-/tmp}/ham-closer-$(id -u)-<<PR_NUMBER>>-<<REVIEWED_SHA>>"
if [ -L "$HAM_TMP_DIR" ]; then
  echo "hard-blocker: HAM_TMP_DIR is a symlink: $HAM_TMP_DIR" >&2
  exit 1
fi
mkdir -p "$HAM_TMP_DIR"
HAM_TMP_OWNER=$(stat -f '%u' "$HAM_TMP_DIR" 2>/dev/null || stat -c '%u' "$HAM_TMP_DIR")
if [ "$HAM_TMP_OWNER" != "$(id -u)" ]; then
  echo "hard-blocker: HAM_TMP_DIR owned by uid $HAM_TMP_OWNER, expected $(id -u)" >&2
  exit 1
fi
chmod 700 "$HAM_TMP_DIR"
POST_REMEDIATION_SHA=$(jq -r '.headRefOid' "$HAM_TMP_DIR/ham-pr-after.json")

TRAILERS_FILE=$(mktemp)
cat <<EOF > "$TRAILERS_FILE"
<<AMA_TRAILERS>>
Remediated-Findings: <n> addressed (<b> blocking, <nb> non-blocking)
EOF

gh pr merge <<PR_URL>> \
  --<<MERGE_METHOD>> \
  --match-head-commit "$POST_REMEDIATION_SHA" \
  --body-file "$TRAILERS_FILE"
MERGE_EXIT=$?
rm -f "$TRAILERS_FILE"
```

Re-read GitHub after `gh pr merge`; the CLI exit code is not authoritative. If
the PR is merged at `POST_REMEDIATION_SHA`, record success in the AMA audit. If
the head moved, a required check failed or is unchecked, HAM evidence is missing,
the predicate fails for the exact live SHA, the PR is closed/draft, or there is
an unresolvable conflict, emit exactly one hard-blocker report and do not call
`gh pr merge`.

## Hard prohibitions

- No "please re-review", no "request another review", no re-review label.
- No follow-up PRs/issues for the final findings.
- No refactor-and-defer for final findings.
- No net-new feature scope beyond the final review findings.
- No merging the old `<<REVIEWED_SHA>>` merely because it passed.
- No `gh pr merge` without `--match-head-commit "$POST_REMEDIATION_SHA"`.
- No merge when the live post-remediation head has failed, missing, stale, or
  unchecked required checks.
- No treating HAM remediation as valid without `ham_terminal_remediation_validated`.

<!-- hq:closeout:pr -->
