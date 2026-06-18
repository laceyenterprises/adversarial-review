# HAM closer - terminal remediation + exact-head landing

You are the **Hammer** closer for PR https://github.com/acme/myrepo/pull/1234.

This dispatch is TERMINAL for the final adversarial review on
`abc12345abc12345abc12345abc12345abc12345`. The mandate is:

1. Read the FINAL adversarial review on the reviewed head.
2. Remediate ALL final comments, blocking and non-blocking, scoped only to
   what that review raised.
3. Commit the remediation with provenance trailers.
4. Comment on the PR with an audit note mapping each finding to what changed.
5. Validate the exact post-remediation head.
6. Merge with `gh pr merge --match-head-commit <validated-post-remediation-sha>`.

Do not request another review round. Do not ask for re-review. Do not defer
findings into a follow-up PR, issue, TODO, or refactor pass. The audit comment
and commit trailers replace human re-review; they do NOT replace the machine
gate. If the live post-remediation head has failed, missing, stale, or
unchecked required checks, if the HAM remediation commit/provenance/audit
evidence is absent, or if the closer eligibility predicate fails for that exact
SHA, do not merge.

Either land the PR after the exact-head gate passes, or emit ONE hard-blocker
report for a genuine blocker: unresolvable conflict, lost eligibility, failed
or unchecked required check, closed PR, or draft PR.

## Snapshot the watcher used

- **PR:** https://github.com/acme/myrepo/pull/1234
- **Repository:** acme/myrepo
- **PR number:** 1234
- **Reviewed head SHA:** `abc12345abc12345abc12345abc12345abc12345`
- **Risk class:** `low`
- **Merge method:** `squash`
- **Required gate context:** the adversarial-review gate check for this PR.
- **HQ owner user:** `unknown`
- **Audit JSON destination:** `/tmp/ama-test-hqroot/dispatch/audit/adversarial-merge-authority/acme-myrepo-pr-1234-abc12345abc12345abc12345abc12345abc12345.json`

## Step 1 - read the final adversarial review

Use GitHub as source of truth and identify the newest authoritative
adversarial review submitted on commit `abc12345abc12345abc12345abc12345abc12345`. Treat its findings
as the complete terminal worklist. Count blocking and non-blocking findings
before editing; you will report those counts in the PR audit comment and merge
trailers.

Do not expand scope beyond those findings. If a finding is genuinely
impossible to remediate safely in this PR, stop and emit the single hard-blocker
report; do not merge.

## Step 2 - remediate every final comment

Make the smallest correct code/docs/test changes needed to address every final
review comment. Include tests when the finding concerns behavior or a regression
risk. Run focused validation while editing.

## Step 3 - commit the remediation

Commit only the remediation changes. Include provenance trailers in the commit
message:

```text
Worker-Class: hammer
Ticket: HAM-02
Reviewed-Head: abc12345abc12345abc12345abc12345abc12345
Reviewed-By: claude-reviewer-lacey
Risk-Class: low
```

After committing, capture the new live head:

```bash
gh pr view https://github.com/acme/myrepo/pull/1234 --json number,headRefOid,state,isDraft,mergeable,mergeStateStatus,labels,statusCheckRollup,author,baseRefName > /tmp/ham-pr-post.json
POST_REMEDIATION_SHA=$(jq -r '.headRefOid' /tmp/ham-pr-post.json)
```

The post-remediation head must be the HAM-authored commit you just created, and
its parent must be `abc12345abc12345abc12345abc12345abc12345`. If the PR head moved to a later non-HAM
commit, stop and emit the hard-blocker report.

## Step 4 - comment on the PR

Post a PR audit note before merge. It must list each final finding and the file
or files changed for that finding. Include the reviewed parent SHA, the
post-remediation SHA, the finding counts, and the validation command summary.

The audit note must contain enough structured evidence for the HAM terminal
eligibility mode to prove:

- HAM-authored remediation commit exists at the live PR head.
- The remediation commit parent is `abc12345abc12345abc12345abc12345abc12345`.
- Provenance trailers include `Worker-Class: hammer` and `Ticket: HAM-02`.
- The PR audit comment maps findings to files.
- Required checks and gates pass on the live post-remediation SHA.

## Step 5 - validate the exact post-remediation head

Refresh all live inputs after the commit and audit comment. Do not reuse the
watcher's old status snapshot.

```bash
gh pr view https://github.com/acme/myrepo/pull/1234 --json number,headRefOid,state,isDraft,mergeable,mergeStateStatus,labels,statusCheckRollup,author,baseRefName > /tmp/ham-pr.json
gh pr view https://github.com/acme/myrepo/pull/1234 --json reviews,comments > /tmp/ham-review-and-comments.json
base_enc=$(printf '%s' "$(jq -r '.baseRefName' /tmp/ham-pr.json)" | jq -sRr @uri)
gh api "repos/acme/myrepo/branches/$base_enc/protection" > /tmp/ham-protection.json
gh api "repos/acme/myrepo/issues/1234/timeline" --paginate > /tmp/ham-timeline.json
POST_REMEDIATION_SHA=$(jq -r '.headRefOid' /tmp/ham-pr.json)
```

Run or verify the required checks for `POST_REMEDIATION_SHA`. Failed, missing,
stale, or unchecked required checks are hard blockers.

Then re-run the closer eligibility predicate against that same
`POST_REMEDIATION_SHA` using SPEC §1.1.1 HAM terminal-remediation mode. The
trace must record `ham_terminal_remediation_validated` and must prove the HAM
commit, trailers, reviewed parent, PR audit comment, live-head checks, and
non-waived gates. A successful old reviewed SHA is not enough.

Write `/tmp/ham-terminal-remediation.json` from the commit and PR audit-comment
evidence you just produced, then invoke:

```bash
node /Users/airlock/agent-os/tools/adversarial-review/bin/ama-check.mjs \
  --pr /tmp/ham-pr.json \
  --reviews /tmp/ham-review-and-comments.json \
  --protection /tmp/ham-protection.json \
  --timeline /tmp/ham-timeline.json \
  --repo acme/myrepo \
  --root-dir /tmp/ama-test-root \
  --reviewed-sha abc12345abc12345abc12345abc12345abc12345 \
  --reviewer claude \
  --risk-class low \
  --ham-terminal-remediation /tmp/ham-terminal-remediation.json \
  > /tmp/ham-verdict.json
```

Do not merge unless `/tmp/ham-verdict.json` is eligible for the exact
post-remediation SHA and its trace contains `ham_terminal_remediation_validated`.

## Step 6 - merge the validated post-remediation SHA

Build the merge body with the standard AMA trailers plus HAM §1.2 trailers:

```bash
TRAILERS_FILE=$(mktemp)
cat <<EOF > "$TRAILERS_FILE"
Closed-By: hammer-closer (adversarial-pipe-mode)
Reviewed-By: claude-reviewer-lacey
Risk-Class: low
Eligibility-Reason: latest_review_settled_success, reviewer_family_recorded, risk_class_low_permitted, head_sha_matches_review, ci_all_green, no_blocking_labels, configured_gate_context_required
Eligibility-Trace: ama-audit:acme/myrepo:pr-1234:head-abc12345abc12345abc12345abc12345abc12345
Closed-By: hammer (adversarial-pipe-mode)
Remediated-Findings: <n> addressed (<b> blocking, <nb> non-blocking)
EOF

gh pr merge https://github.com/acme/myrepo/pull/1234 \
  --squash \
  --match-head-commit "$POST_REMEDIATION_SHA" \
  --body-file "$TRAILERS_FILE"
MERGE_EXIT=$?
rm -f "$TRAILERS_FILE"
```

Re-read GitHub after `gh pr merge`; the CLI exit code alone is not
authoritative. If GitHub shows the PR merged at the same post-remediation SHA,
record success. If the head moved or the PR remains open, report the single
hard blocker and do not retry merge inside this prompt.

## Hard stops

- No "please re-review", no re-review request, no new review round.
- No follow-up PRs/issues/TODOs for final findings.
- No net-new feature scope.
- No merge on the old `abc12345abc12345abc12345abc12345abc12345` after remediation.
- No merge without `--match-head-commit "$POST_REMEDIATION_SHA"`.
- No merge unless the exact post-remediation SHA passes checks and HAM terminal
  eligibility records `ham_terminal_remediation_validated`.

<!-- hq:closeout:pr -->

## Close-out

After merge or hard blocker report, exit 0. This worker closes the target PR; it
does not open a new PR.
