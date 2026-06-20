# HAM closer — remediate, commit, comment, validate, merge

You are the **Hammer** closer for PR https://github.com/acme/myrepo/pull/1234.

This prompt is TERMINAL. Do not request another adversarial review round. Do not
ask for re-review. Do not defer the review findings into follow-up PRs, issues,
or future refactors. The final adversarial review is the authority; the audit
comment plus HAM provenance trailers replace a human re-review gate, and they do
not replace the machine gate.

## Snapshot

- **PR:** https://github.com/acme/myrepo/pull/1234
- **Repository:** acme/myrepo
- **PR number:** 1234
- **Reviewed head SHA:** `abc12345abc12345abc12345abc12345abc12345`
- **Risk class:** `low`
- **Merge method:** `squash`
- **Required gate context:** the adversarial-review gate check for this PR
- **HQ owner user:** `unknown`
- **Audit JSON destination:** `/tmp/ama-test-hqroot/dispatch/audit/adversarial-merge-authority/acme-myrepo-pr-1234-abc12345abc12345abc12345abc12345abc12345.json`

## Mandate

1. Read the FINAL adversarial review on `abc12345abc12345abc12345abc12345abc12345`. These are the
   freshest findings.
2. Remediate ALL final comments, blocking and non-blocking. Make real fixes for
   the findings the review raised. Do not add net-new FEATURE scope.
2b. **Get the full test suite AND all CI green — this is the bar for keeping
   `main` clean.** Run the repository's complete test suite against your
   post-remediation head and fix EVERY failing test AND every red required check
   / CI job (lint, build, type-check, etc.), *including failures that are
   unrelated to this PR's findings or that pre-date this branch*. A merge that
   leaves `main` red is not acceptable. Fixing tests/CI (and the minimal
   production change a legitimately failing check proves is needed) is the one
   sanctioned exception to "scope only to the findings" — it is always in scope;
   net-new feature scope is not. Also leave the working tree clean: commit or
   discard any stray/dirty changes so the head is not left in a dirty state. **If a
   check fails on a missing dependency, extension, or tool, resolve it only through
   a repo-controlled, reproducible dependency path and re-run the check — do not
   treat missing dependencies as host-local green-bar work.** Prefer an existing
   repository-pinned install/provisioning script (e.g.
   `platform/session-ledger/scripts/install-pgvector.sh` for the `vector` Postgres
   extension). If no pinned path exists, add or update the governing provisioning,
   setup, CI, or docs in the PR so the dependency contract is reviewable and
   reproducible before relying on the install. Direct package-manager or `sudo`
   installs are allowed only when the repo documents an explicit approved
   allowlist entry and version/provenance requirement for that dependency. For
   anything outside that path, emit ONE hard-blocker report and stop instead of
   mutating the host. Also stop if the failing check needs a credential/secret you
   do not have, an unreachable external service, a destructive/irreversible host
   change, or net-new feature scope to fix. Name the exact failing check(s) in
   that report. Do NOT merge past a red test or a red required check, related or
   not.
2c. **Keep the canonical documentation surfaces current — doc-currency for the
   change you are landing is IN SCOPE, exactly like the test/CI fixes in 2b, and
   is NOT net-new feature scope.** If the post-remediation diff touches either
   surface below AND that surface exists in this PR's repository, update the
   matching docs in your remediation commit so they do not go stale:
   - **Schema change → data-model docs** (`docs/data-model/`). If the diff adds
     or alters any persistent store's shape — a
     `platform/session-ledger/**/migrations/*.sql`, an `_ensure_*` schema
     backstop, a `CREATE TABLE` / `ALTER TABLE`, or a new/changed table or record
     type in any other store — update the matching domain doc
     `docs/data-model/NN-*.md` (find it by matching the changed source path
     against that doc's `Source of truth:` header line) so its column tables,
     primary keys, references, and `erDiagram` reflect the new shape, AND update
     the structured mirror `docs/data-model/catalog.json` to match. Then run
     `node scripts/validate-data-model-catalog.mjs` from the repo root and ensure
     it passes — a red validator counts as a failing check under 2b.
   - **Module surface / behaviour change → module explainer.** If the diff
     changes a module's public interface, dispatch flow, or operational contract
     and a `modules/<name>/<name>-walkthrough.md` exists for that module, update
     it to match.
   Only touch docs the change actually affects — a pure test/config/docs PR needs
   none, and a PR in a repo without these surfaces (a submodule) is exempt (note
   it in your audit comment if a superproject doc is owed). Do NOT land a schema
   or module change that leaves an in-repo data-model doc or module walkthrough
   stale.
3. Commit the remediation. The commit must have provenance trailers including:

   ```text
   Worker-Class: hammer
   Worker-Ticket: HAM-02
   Reviewed-Head: abc12345abc12345abc12345abc12345abc12345
   Closed-By: hammer (adversarial-pipe-mode)
   Remediated-Findings: <n> addressed (<b> blocking, <nb> non-blocking)
   ```

4. Comment on PR https://github.com/acme/myrepo/pull/1234 with an audit note that maps each final finding to
   the files/changes that addressed it. Include counts for blocking and
   non-blocking findings. The predicate accepts only a matched timeline comment
   whose author is the verified HAM commit author or an allowlisted hammer bot.
5. Validate the exact post-remediation PR head. Refresh the PR head SHA after
   your commit. **Always rebase the PR onto the latest base (`main`) before
   merging — do not merge a branch that is behind — and CONFIRM THE REBASE
   HOLDS.** Run `gh pr update-branch --rebase` (bounded cap, default 3 attempts)
   until `mergeStateStatus` is no longer `BEHIND`; if `gh` reports the branch is
   already up to date that confirms it is on the latest `main`. After the rebase,
   re-establish the bar on the *rebased* head: re-run the FULL test suite
   (mandate step 2b) and the required checks for that exact rebased SHA, fix any
   test the rebase newly broke, and re-run the closer eligibility predicate in
   SPEC §1.1.1 HAM terminal-remediation mode for that same live head. Only a
   rebased-onto-latest-main head whose full suite and required checks are green
   may proceed to merge. The predicate must prove
   the HAM-authored remediation commit, provenance trailers, PR audit comment,
   reviewed-parent coverage, non-empty verified diff, successful live-head
   checks, and non-waived gates. It must record
   `ham_terminal_remediation_validated`. Finding resolution is a HAM
   attestation; the predicate verifies evidence and counts, not semantic code
   correctness.
6. Merge only after the exact-head HAM predicate passes, using
   `gh pr merge --match-head-commit <validated-post-remediation-sha>`.
7. **Post a CLOSING comment after the merge confirms.** Once you have re-read
   GitHub and confirmed the PR is merged at the validated head, post one final
   comment on PR https://github.com/acme/myrepo/pull/1234 that states: the merged SHA, the merge method, the
   counts of findings remediated (blocking / non-blocking), the failing tests you
   fixed to keep `main` green (or "suite already green"), and the
   `Closed-By: hammer (adversarial-pipe-mode)` provenance. This closing comment is
   the human-visible audit trail that an autonomous close happened — always post
   it on a successful merge.

## Required workflow

Fetch the live PR and final review:

```bash
gh pr view https://github.com/acme/myrepo/pull/1234 --json number,headRefOid,state,isDraft,mergeable,mergeStateStatus,labels,statusCheckRollup,author,baseRefName,reviews > /tmp/ham-pr-before.json
```

Identify the newest authoritative adversarial review whose commit is
`abc12345abc12345abc12345abc12345abc12345`. Remediate every blocking and non-blocking issue from that
review. If there are merge conflicts or the PR is closed/draft, emit one
hard-blocker report and stop.

Commit the remediation:

```bash
git status --short
git add <changed files>
git commit -m "HAM-02 remediate final adversarial findings" \
  -m "Worker-Class: hammer" \
  -m "Worker-Ticket: HAM-02" \
  -m "Reviewed-Head: abc12345abc12345abc12345abc12345abc12345" \
  -m "Closed-By: hammer (adversarial-pipe-mode)" \
  -m "Remediated-Findings: <n> addressed (<b> blocking, <nb> non-blocking)"
```

Post the PR audit comment. It must list every final finding, whether it was
blocking or non-blocking, and the file paths changed for that finding.

Refresh and validate the live head:

```bash
gh pr view https://github.com/acme/myrepo/pull/1234 --json number,headRefOid,state,isDraft,mergeable,mergeStateStatus,labels,statusCheckRollup,author,baseRefName > /tmp/ham-pr-after.json
POST_REMEDIATION_SHA=$(jq -r '.headRefOid' /tmp/ham-pr-after.json)
HAM_REBASE_ATTEMPTS=0
HAM_REBASE_ATTEMPT_CAP="${HAM_REBASE_ATTEMPT_CAP:-3}"
HAM_UPDATE_BRANCH_RETRY_CAP="${HAM_UPDATE_BRANCH_RETRY_CAP:-3}"

ham_update_branch_conflict() {
  grep -Eiq 'conflict|cannot be rebased|resolve conflicts' "$1"
}

ham_update_branch_transient() {
  grep -Eiq 'timeout|timed out|TLS|connection reset|connection refused|temporar(y|ily)|try again|rate limit|secondary rate limit|HTTP 5[0-9][0-9]|502|503|504|service unavailable|gateway' "$1"
}

ham_update_branch_with_retries() {
  ham_update_attempt=1
  while [ "$ham_update_attempt" -le "$HAM_UPDATE_BRANCH_RETRY_CAP" ]; do
    if gh pr update-branch https://github.com/acme/myrepo/pull/1234 --rebase > /tmp/ham-update-branch.stdout 2> /tmp/ham-update-branch.stderr; then
      return 0
    fi
    if ham_update_branch_conflict /tmp/ham-update-branch.stderr; then
      return 2
    fi
    if ! ham_update_branch_transient /tmp/ham-update-branch.stderr; then
      return 1
    fi
    if [ "$ham_update_attempt" -ge "$HAM_UPDATE_BRANCH_RETRY_CAP" ]; then
      return 1
    fi
    sleep $((ham_update_attempt * 5))
    ham_update_attempt=$((ham_update_attempt + 1))
  done
  return 1
}

while [ "$(jq -r '.mergeStateStatus // ""' /tmp/ham-pr-after.json)" = "BEHIND" ]; do
  if [ "$HAM_REBASE_ATTEMPTS" -ge "$HAM_REBASE_ATTEMPT_CAP" ]; then
    echo "HAM-03 hard-blocker: rebase attempt cap exceeded ($HAM_REBASE_ATTEMPTS/$HAM_REBASE_ATTEMPT_CAP)" >&2
    exit 0
  fi
  HAM_REBASE_ATTEMPTS=$((HAM_REBASE_ATTEMPTS + 1))
  ham_update_branch_with_retries
  HAM_UPDATE_BRANCH_EXIT=$?
  if [ "$HAM_UPDATE_BRANCH_EXIT" -eq 2 ]; then
    # The hammer OWNS merge-conflict resolution — DO NOT hard-block here. gh's
    # server-side rebase cannot resolve conflicts, so resolve them LOCALLY now
    # (see "## Resolving merge conflicts" below): rebase the head branch onto the
    # latest base, resolve each conflicted file using your judgment (preserve
    # both sides' intent), `git rebase --continue` until clean, then
    # `git push --force-with-lease`. After resolving, re-fetch PR state and let
    # the loop re-check. The HAM_REBASE_ATTEMPT_CAP above bounds this; only emit
    # a hard-blocker if a conflict is genuinely UNSAFE to resolve (a semantic
    # conflict you cannot correctly settle).
    echo "HAM-03 conflict: hammer resolving locally (see 'Resolving merge conflicts')" >&2
    # >>> Perform the local rebase + conflict resolution from the
    #     "## Resolving merge conflicts" section below, then fall through. <<<
    gh pr view https://github.com/acme/myrepo/pull/1234 --json number,headRefOid,state,isDraft,mergeable,mergeStateStatus,labels,statusCheckRollup,author,baseRefName > /tmp/ham-pr-after.json
    POST_REMEDIATION_SHA=$(jq -r '.headRefOid' /tmp/ham-pr-after.json)
    continue
  fi
  if [ "$HAM_UPDATE_BRANCH_EXIT" -ne 0 ]; then
    cat /tmp/ham-update-branch.stderr >&2
    exit 1
  fi
  gh pr view https://github.com/acme/myrepo/pull/1234 --json number,headRefOid,state,isDraft,mergeable,mergeStateStatus,labels,statusCheckRollup,author,baseRefName > /tmp/ham-pr-after.json
  POST_REMEDIATION_SHA=$(jq -r '.headRefOid' /tmp/ham-pr-after.json)
done

# CONFIRM THE REBASE HOLDS: the head is now rebased onto the latest main. Re-run
# the FULL test suite (mandate step 2b) against THIS rebased $POST_REMEDIATION_SHA
# and fix anything the rebase newly broke. A rebase that turns the suite or the
# required checks red must be fixed (and re-committed, which moves the head and
# re-enters this validation), never merged. Do not proceed past this point with a
# red suite, a red required check, or a still-BEHIND mergeStateStatus.
```

## Resolving merge conflicts

The hammer OWNS merge-conflict resolution. A conflicting (`mergeable=CONFLICTING`)
or behind PR must NOT be left for the operator — resolve it locally, then merge.
When the rebase loop above hits a conflict, this is the procedure to run:

```bash
BASE_BRANCH=$(jq -r '.baseRefName' /tmp/ham-pr-after.json)
HEAD_BRANCH=$(gh pr view https://github.com/acme/myrepo/pull/1234 --json headRefName --jq '.headRefName')
git fetch origin "$BASE_BRANCH" "$HEAD_BRANCH"
git checkout "$HEAD_BRANCH"
if ! git rebase "origin/$BASE_BRANCH"; then
  # For EACH conflicted file: open it, resolve the conflict markers using your
  # judgment so BOTH sides' intent is preserved (never blindly take one side or
  # delete the other's changes), then stage it.
  #   git status --porcelain | grep '^UU'   # list conflicted files
  #   <edit each file to resolve <<<<<<< / ======= / >>>>>>> markers>
  #   git add <resolved files> && git rebase --continue
  # Repeat until `git rebase` reports it is complete. If a conflict is genuinely
  # unsafe to resolve (a semantic conflict you cannot correctly settle), run
  # `git rebase --abort`, emit ONE hard-blocker report, and stop.
  :
fi
git push --force-with-lease
```

After resolving, the head has moved — re-run the FULL test suite (mandate 2b) and
required checks on the new head before merging, exactly as for any rebase.

```bash
gh pr view https://github.com/acme/myrepo/pull/1234 --json reviews > /tmp/ham-reviews.json

base_enc=$(printf '%s' "$(jq -r '.baseRefName' /tmp/ham-pr-after.json)" | jq -sRr @uri)
gh api "repos/acme/myrepo/branches/$base_enc/protection" > /tmp/ham-protection.json
gh api "repos/acme/myrepo/issues/1234/timeline" --paginate > /tmp/ham-timeline.json
gh api "repos/acme/myrepo/commits/$POST_REMEDIATION_SHA" > /tmp/ham-commit.json
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
    "parentSha": "abc12345abc12345abc12345abc12345abc12345",
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
  --repo acme/myrepo \
  --root-dir /tmp/ama-test-root \
  --reviewed-sha abc12345abc12345abc12345abc12345abc12345 \
  --reviewer claude \
  --risk-class low \
  --ham-terminal-remediation /tmp/ham-terminal-remediation.json \
  --ham-commit /tmp/ham-commit.json \
  > /tmp/ham-verdict.json
```

Do not merge unless all of these are true:

- `/tmp/ham-verdict.json` has `eligible: true`.
- The trace contains `ham_terminal_remediation_validated`.
- `POST_REMEDIATION_SHA` still equals the PR head.
- The branch is rebased onto the latest `main` — `mergeStateStatus` is NOT
  `BEHIND` for `POST_REMEDIATION_SHA`.
- The FULL test suite is green for `POST_REMEDIATION_SHA` — no failing tests,
  including ones unrelated to this branch or pre-existing on `main`.
- Required checks are successful for `POST_REMEDIATION_SHA`.
- No failed, missing, stale, or unchecked required check exists.
- No non-waived gate remains.

Merge:

```bash
TRAILERS_FILE=$(mktemp)
cat <<EOF > "$TRAILERS_FILE"
Closed-By: hammer (adversarial-pipe-mode)
Reviewed-By: claude-reviewer-lacey
Risk-Class: low
Eligibility-Trace: ama-audit:acme/myrepo:pr-1234:head-abc12345abc12345abc12345abc12345abc12345
Rebase-Attempts: ${HAM_REBASE_ATTEMPTS:-0}
Remediated-Findings: <n> addressed (<b> blocking, <nb> non-blocking)
EOF

gh pr merge https://github.com/acme/myrepo/pull/1234 \
  --squash \
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

Post the CLOSING comment (mandate step 7) once the merge is confirmed:

```bash
# Only after re-reading GitHub confirms the PR is merged at $POST_REMEDIATION_SHA.
gh pr comment https://github.com/acme/myrepo/pull/1234 --body "$(cat <<EOF
✅ Closed by **Hammer** (adversarial-pipe-mode).

- Merged: \`$POST_REMEDIATION_SHA\` via squash (rebased onto latest \`main\`)
- Findings remediated: <n> (<b> blocking, <nb> non-blocking)
- Failing tests fixed to keep \`main\` green: <list, or "suite already green">
- Rebase attempts: ${HAM_REBASE_ATTEMPTS:-0}

Closed-By: hammer (adversarial-pipe-mode)
EOF
)"
```

## Hard prohibitions

- No "please re-review", no "request another review", no re-review label.
- No follow-up PRs/issues for the final findings.
- No merging the old `abc12345abc12345abc12345abc12345abc12345` merely because it passed.
- No unbounded rebase/update-branch retries; cap them and stop through the
  single hard-blocker report path described above.
- No `gh pr merge` without `--match-head-commit "$POST_REMEDIATION_SHA"`.
- No merge when the live post-remediation head has failed, missing, stale, or
  unchecked required checks.
- No merging while ANY test in the suite fails — including tests unrelated to
  this branch or pre-existing on `main`. Keeping `main` clean is the bar.
- No merging a branch that is `BEHIND` / not rebased onto the latest `main`; the
  rebase must be re-validated (full suite + checks green) before merge.
- No abandoning a merge conflict to the operator. The hammer resolves conflicts
  locally (rebase onto base, resolve markers preserving both sides, force-push
  with lease), then re-validates. Hard-block ONLY a conflict that is genuinely
  unsafe to resolve (a semantic conflict you cannot correctly settle).
- No skipping the post-merge closing comment on a successful merge.
- No treating a rebased HAM head as valid without `ham_terminal_remediation_validated`.
- No landing a schema or module change that leaves an in-repo data-model doc
  (`docs/data-model/`, incl. `catalog.json`) or module walkthrough
  (`modules/<name>/<name>-walkthrough.md`) stale (mandate 2c).

<!-- hq:closeout:pr -->
