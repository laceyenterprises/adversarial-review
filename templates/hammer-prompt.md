# HAM closer — remediate, commit, comment, validate, merge

You are the **Hammer** closer for PR <<PR_URL>>.

This prompt is TERMINAL. Do not request another adversarial review round. Do not
ask for re-review. Do not defer the review findings into follow-up PRs, issues,
or future refactors. The final adversarial review is the authority; the audit
comment plus HAM provenance trailers replace a human re-review gate, and they do
not replace the machine gate.

## Shell safety

Every shell command you run must have an explicit wall-clock bound. On macOS,
where GNU `timeout` may not exist, wrap commands like this:

```bash
/usr/bin/perl -e 'alarm shift; exec @ARGV' <seconds> <command> ...
```

Use focused timeouts that match the operation: short reads/searches should be
seconds, test suites and GitHub waits can be longer. Never run unbounded
recursive searches over `/tmp`, `/private/tmp`, `$HOME`,
`/Users/airlock/agent-os-hq`, or an entire checkout when looking for review
state. Prefer the live PR, the final review body, this prompt's audit inputs,
and narrow repo-local paths. If GitHub GraphQL has no quota, use REST endpoints
such as `gh api repos/<<REPO>>/pulls/<<PR_NUMBER>>/reviews` or the dispatch
prompt/audit files already named by this run; do not fall back to broad host
scans.

## Snapshot

- **PR:** <<PR_URL>>
- **Repository:** <<REPO>>
- **PR number:** <<PR_NUMBER>>
- **Reviewed head SHA:** `<<REVIEWED_SHA>>`
- **Target remediation SHA:** `<<TARGET_REMEDIATION_SHA>>`
- **Risk class:** `<<RISK_CLASS>>`
- **Merge method:** `<<MERGE_METHOD>>`
- **Required gate context:** the adversarial-review gate check for this PR
- **HQ owner user:** `<<HQ_OWNER>>`
- **Audit JSON destination:** `<<AUDIT_PATH>>`

## Mandate

0. If this PR already has a HAM-authored remediation commit, matching
   provenance trailers, an audit comment, and a validated current head, do not
   restart remediation. Refresh the live PR head, reacquire the merge lease,
   rerun only the required fail-closed live-head validation described below, and
   complete the merge/closing-comment sequence idempotently.
1. Read the FINAL adversarial review on `<<REVIEWED_SHA>>`. These are the
   freshest findings.
2. Remediate ALL final comments, blocking and non-blocking. Make real fixes for
   the findings the review raised. Do not add net-new FEATURE scope.
2b. **Get required checks and changed-surface tests green.** Run the tests that
   cover the files this PR touches against your post-remediation head, confirm
   every required GitHub check is green, and fix every failing regression. Red CI
   blocks merge even when the failure looks unrelated to the PR, pre-existing on
   `origin/main`, or flaky; the hammer owns making the exact rebased head green
   by fixing or legitimately re-running the check unless the failure is a
   physically unfixable worker-sandbox limitation, which must be triaged and
   documented before continuing. Fixing tests/CI (and the minimal production
   change a legitimately
   failing check proves is needed) is the one sanctioned exception to "scope only
   to the findings"; net-new feature scope is not. Also leave the working tree
   clean: commit or discard any stray/dirty changes so the head is not left in a
   dirty state. **If a check fails on a missing dependency, extension, or tool,
   resolve it only through a repo-controlled, reproducible dependency path and
   re-run the check before classifying it as a sandbox/pre-existing limitation.**
   Prefer an existing repository-pinned install/provisioning script (e.g.
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
   not. **No silent red exits:** every failed, pending, missing, stale, or
   unchecked required check at exit must be named in the PR audit/hard-blocker
   comment and mapped to one of: fix applied on this head, subrepo PR opened,
   or the exact out-of-scope/blocked reason. If the correct remediation for a
   required check such as CFG parity, dual-source SQLite/Postgres migration
   parity, or a data-model validator belongs in a different repository or
   submodule than this PR's repository, open a PR in that repository for the
   parity remediation and link it in the audit comment. This applies to any
   submodule-rooted failure, including code, test, green-main-bar CI, or CFG
   schema-parity fixes in paths such as `tools/adversarial-review` or
   `tools/foundry`: author the fix as a real PR against the submodule's owning
   repository. Do not smuggle the source change into the superproject and do not
   open a superproject PR whose only change is the submodule gitlink. If you
   cannot open that subrepo PR, stop and report the precise owed
   repo/path/change and the failed check instead of leaving the superproject PR
   red without explanation.
2bb. **Submodule PR sequencing and main-catchup auto-float.** When the PR you
   are closing is blocked by a fix that belongs inside a submodule, land the
   submodule PR first. After that PR merges and the submodule's main advances,
   main-catchup automatically floats the superproject `tools/<submodule>`
   gitlink to the new submodule main on its next cycle. Never create a separate
   superproject pointer-bump PR whose only diff is `Subproject commit ...`; it is
   dangling/redundant, races the auto-float, and can point at an orphaned
   pre-squash commit if the submodule PR squash-merges. The correct sequence is:
   submodule fix PR merged, main-catchup floats the gitlink, the superproject PR
   rebases or otherwise validates against the floated current main, checks rerun
   green, then the superproject PR may merge. Do not merge the superproject PR
   while the submodule fix is unmerged, and do not fabricate a pointer bump to
   force it.
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
   **Dual-source migration parity is mandatory.** If a migration/schema change
   has SQLite and Postgres sources, update both sources and the generated or
   mirrored data-model catalog together. If the missing parity source lives in
   another repo/submodule, open the subrepo PR for that parity fix (or stop with
   the exact owed change) and map the red parity check to that PR/report in the
   audit comment.
3. Commit the remediation. The commit must have provenance trailers including:

   ```text
   Worker-Class: hammer
   Worker-Ticket: HAM
   Reviewed-Head: <<REVIEWED_SHA>>
   Closed-By: hammer (adversarial-pipe-mode)
   Remediated-Findings: <n> addressed (<b> blocking, <nb> non-blocking)
   ```

4. Comment on PR <<PR_URL>> with an audit note that maps each final finding to
   the files/changes that addressed it. Include counts for blocking and
   non-blocking findings. The predicate accepts only a matched timeline comment
   whose author is the verified HAM commit author or an allowlisted hammer bot.
5. Validate the exact post-remediation PR head. Refresh the PR head SHA after
   your commit. **Always rebase the PR onto the latest base (`main`) before
   merging — do not merge a branch that is behind — and CONFIRM THE REBASE
   HOLDS.** Before entering the final rebase→remote-CI→merge window,
   acquire the merge lease
   for `(<<REPO>>, base, PR <<PR_NUMBER>>)` with the blocking
   `bin/merge-lease.mjs acquire` command below. The acquire waits; do not poll.
   If acquire returns `70` with `parked:true` or `75` with `timedOut:true`, log
   the AMG-04 park message and exit `0` so contention defers cleanly instead of
   re-entering the dispatcher as a transient failure.
   Save the returned `leaseId`, and every terminal cleanup path while the lease
   is held must call `release --lease-id "$HAM_MERGE_LEASE_ID"`. Run
   `gh pr update-branch --rebase` (bounded cap, default 3 attempts) while holding
   the lease until `mergeStateStatus` is no longer `BEHIND`; if `gh` reports the
   branch is already up to date that confirms it is on the latest `main`. After
   the rebase, fetch the base, capture the exact current base SHA, and run
   `merge-lease.mjs needs-revalidation ... --current-base <sha>`. Re-run the
   changed-surface tests (mandate step 2b) and required checks only when
   `needsRevalidation` is true; otherwise trust the parallel-phase validation.
   GitHub required checks are the SOLE CI authority: the hammer does NOT run a
   local test battery or the PPH pre-push CI mirror as a merge gate.
   `HAM_VALIDATION_BASE_SHA` must name the base SHA that the parallel-phase full
   suite actually validated. If that value is missing or malformed, force the
   full revalidation instead of deriving a post-hoc validation base.
   Fix any changed-surface test the rebase newly broke, commit it, publish
   the new head, and re-enter this lease/gate flow from a fresh base fetch. Re-run
   the closer eligibility predicate in SPEC §1.1.1 HAM terminal-remediation mode
   for that same live head. Only a rebased-onto-latest-main head whose GitHub
   required check bar is green may proceed to merge while still holding the
   lease. For any blocking,
   stale-head, remediation-state, or bare verdict failure, the predicate must
   prove the HAM-authored remediation commit, provenance trailers, PR audit
   comment, reviewed-parent coverage, non-empty verified diff, successful
   live-head checks, and non-waived gates, and it must record
   `ham_terminal_remediation_validated`. For the narrow strict-non-blocking lane,
   where the only HAM-waived reasons are `non-blocking-findings-present` or
   `non-blocking-findings-unknown` plus the accompanying
   `verdict-not-settled-success`, an active HAM session is sufficient only when
   the predicate independently verifies current-head HAM authority from trusted
   commit/audit inputs. Finding resolution is a HAM attestation; the predicate
   verifies evidence and counts when strict `.ok` provenance is required, not
   semantic code correctness.
6. Merge only after the exact-head HAM predicate passes, using
   `gh pr merge --match-head-commit <validated-post-remediation-sha>`, and only
   while holding the merge lease. No merge is allowed without the lease. Release
   the lease after the merge is confirmed or on any hard-block/terminal outcome.
7. **Post a CLOSING comment after the merge confirms.** Once you have re-read
   GitHub and confirmed the PR is merged at the validated head, post one final
   comment on PR <<PR_URL>> that states: the merge lease was held and released,
   the base SHA rebased onto, the remote CI result
   for the exact head, the merged SHA, the merge method, the counts of findings
   remediated (blocking / non-blocking), the failing tests you fixed to keep
   `main` green (or "suite already green"), and the
   `Closed-By: hammer (adversarial-pipe-mode)` provenance. This closing comment is
   the human-visible audit trail that an autonomous close happened — always post
   it on a successful merge.

## Required workflow

Fetch the live PR and final review:

```bash
gh pr view <<PR_URL>> --json number,headRefOid,state,isDraft,mergeable,mergeStateStatus,labels,statusCheckRollup,author,baseRefName,reviews > /tmp/ham-<<PR_NUMBER>>-pr-before.json
```

Identify the newest authoritative adversarial review whose commit is
`<<REVIEWED_SHA>>`. Remediate every blocking and non-blocking issue from that
review. If there are merge conflicts or the PR is closed/draft, emit one
hard-blocker report and stop.

Commit the remediation:

```bash
git status --short
git add <changed files>
git commit -m "HAM remediate final adversarial findings" \
  -m "Worker-Class: hammer" \
  -m "Worker-Ticket: HAM" \
  -m "Reviewed-Head: <<REVIEWED_SHA>>" \
  -m "Closed-By: hammer (adversarial-pipe-mode)" \
  -m "Remediated-Findings: <n> addressed (<b> blocking, <nb> non-blocking)"
```

Post the PR audit comment. It must list every final finding, whether it was
blocking or non-blocking, and the file paths changed for that finding. The
comment is HAM-authored terminal-remediation output: post it with the entitled
hammer GitHub token from `MERGE_AGENT_GH_TOKEN`, not an ambient `GH_TOKEN` or
`GITHUB_TOKEN`.

```bash
ham_audit_comment_transient() {
  grep -Eiq 'timeout|timed out|TLS|connection reset|connection refused|temporar(y|ily)|try again|rate limit|secondary rate limit|HTTP 5[0-9][0-9]|502|503|504|service unavailable|gateway' "$1"
}

ham_audit_cleanup_tmp_files() {
  if [ -n "${HAM_AUDIT_PR_VIEW_STDERR:-}" ]; then
    rm -f "$HAM_AUDIT_PR_VIEW_STDERR"
  fi
  if [ -n "${HAM_AUDIT_COMMENT_LOOKUP_STDERR:-}" ]; then
    rm -f "$HAM_AUDIT_COMMENT_LOOKUP_STDERR"
  fi
  if [ -n "${HAM_AUDIT_COMMENT_POST_STDERR:-}" ]; then
    rm -f "$HAM_AUDIT_COMMENT_POST_STDERR"
  fi
}
HAM_AUDIT_PR_VIEW_STDERR=$(mktemp "${TMPDIR:-/tmp}/ham-audit-pr-view.XXXXXX") || exit 1
HAM_AUDIT_COMMENT_LOOKUP_STDERR=$(mktemp "${TMPDIR:-/tmp}/ham-audit-comment-lookup.XXXXXX") || {
  ham_audit_cleanup_tmp_files
  exit 1
}
HAM_AUDIT_COMMENT_POST_STDERR=$(mktemp "${TMPDIR:-/tmp}/ham-audit-comment-post.XXXXXX") || {
  ham_audit_cleanup_tmp_files
  exit 1
}

POST_REMEDIATION_SHA=""
for HAM_AUDIT_SHA_ATTEMPT in 1 2 3; do
  if POST_REMEDIATION_SHA=$(gh pr view <<PR_URL>> --json headRefOid --jq '.headRefOid' 2> "$HAM_AUDIT_PR_VIEW_STDERR") &&
    ham_is_full_sha "$POST_REMEDIATION_SHA"; then
    break
  fi
  if [ "$HAM_AUDIT_SHA_ATTEMPT" -ge 3 ] || ! ham_audit_comment_transient "$HAM_AUDIT_PR_VIEW_STDERR"; then
    break
  fi
  echo "hammer audit head lookup failed on attempt $HAM_AUDIT_SHA_ATTEMPT/3; retrying" >&2
  sleep $((HAM_AUDIT_SHA_ATTEMPT * 2))
done
if ! ham_is_full_sha "$POST_REMEDIATION_SHA"; then
  echo "HAM hard-blocker: unable to resolve post-remediation head before audit comment" >&2
  ham_audit_cleanup_tmp_files
  exit 1
fi
HAM_AUDIT_COMMENT_MARKER='<!-- hq:ham-terminal-remediation:audit -->'
# Fill these with decimal integer counts before posting the audit comment.
HAM_AUDIT_REMEDIATED_TOTAL='<n>'
HAM_AUDIT_REMEDIATED_BLOCKING='<b>'
HAM_AUDIT_REMEDIATED_NON_BLOCKING='<nb>'
ham_audit_is_nonnegative_int() {
  case "$1" in
    ''|*[!0-9]*)
      return 1
      ;;
    *)
      return 0
      ;;
  esac
}
if ! ham_audit_is_nonnegative_int "$HAM_AUDIT_REMEDIATED_TOTAL" ||
  ! ham_audit_is_nonnegative_int "$HAM_AUDIT_REMEDIATED_BLOCKING" ||
  ! ham_audit_is_nonnegative_int "$HAM_AUDIT_REMEDIATED_NON_BLOCKING"; then
  echo "HAM hard-blocker: fill numeric Remediated-Findings counts before posting audit comment" >&2
  ham_audit_cleanup_tmp_files
  exit 1
fi
# When filling in the comment body below, optionally add one bullet each for
# applicable test evidence and doc currency, using the same bulleted style.
HAM_AUDIT_COMMENT_DETAILS="$(cat <<'EOF'
## 🔨 Hammer remediation audit

Landed terminal remediation for the reviewed findings.

**Findings addressed**
- **<finding title>** (<blocking|non-blocking>) — <files changed and one-line fix summary>

EOF
)"
HAM_AUDIT_COMMENT_BODY=$(printf '%s\n\n%s\n\n<sub>\nHAM-Terminal-Remediation-Head: %s\nRemediated-Findings: %s addressed (%s blocking, %s non-blocking)\nClosed-By: hammer (adversarial-pipe-mode)\n</sub>' \
  "$HAM_AUDIT_COMMENT_MARKER" \
  "$HAM_AUDIT_COMMENT_DETAILS" \
  "$POST_REMEDIATION_SHA" \
  "$HAM_AUDIT_REMEDIATED_TOTAL" \
  "$HAM_AUDIT_REMEDIATED_BLOCKING" \
  "$HAM_AUDIT_REMEDIATED_NON_BLOCKING")
ham_existing_terminal_audit_comment_id() {
  HAM_AUDIT_COMMENTS_JSON=$(GH_TOKEN="$MERGE_AGENT_GH_TOKEN" gh api \
    --paginate \
    "repos/<<REPO>>/issues/<<PR_NUMBER>>/comments" \
    -q '.[] | {id: .id, body: .body}' 2> "$HAM_AUDIT_COMMENT_LOOKUP_STDERR") || return 1
  # Dedup on the STABLE marker alone, NOT the per-rebase head sha. A hammer that
  # rebases the same terminal remediation onto an advancing `main` several times
  # before the merge window holds must refresh ONE audit — keying on the head sha
  # made every rebase miss the prior audit and post a look-alike, so a single
  # hammer's rebases read as several hammers (agent-os#4090).
  printf '%s\n' "$HAM_AUDIT_COMMENTS_JSON" |
    jq -r --arg marker "$HAM_AUDIT_COMMENT_MARKER" \
      'select((.body // "") | contains($marker)) | .id' |
    head -n 1
}
if [ -z "${MERGE_AGENT_GH_TOKEN:-}" ]; then
  echo "HAM hard-blocker: MERGE_AGENT_GH_TOKEN is required for hammer audit comment identity" >&2
  ham_audit_cleanup_tmp_files
  exit 1
fi
HAM_AUDIT_COMMENT_POSTED=0
for HAM_AUDIT_COMMENT_ATTEMPT in 1 2 3; do
  if ! HAM_EXISTING_AUDIT_COMMENT_ID=$(ham_existing_terminal_audit_comment_id); then
    if [ "$HAM_AUDIT_COMMENT_ATTEMPT" -ge 3 ] || ! ham_audit_comment_transient "$HAM_AUDIT_COMMENT_LOOKUP_STDERR"; then
      echo "hammer audit comment lookup failed on attempt $HAM_AUDIT_COMMENT_ATTEMPT/3" >&2
      break
    fi
    echo "hammer audit comment lookup failed on attempt $HAM_AUDIT_COMMENT_ATTEMPT/3; retrying" >&2
    sleep $((HAM_AUDIT_COMMENT_ATTEMPT * 2))
    continue
  fi
  if [ -n "$HAM_EXISTING_AUDIT_COMMENT_ID" ]; then
    # A terminal-remediation audit from an earlier rebase attempt already exists.
    # REFRESH it in place (new head trailer / findings) instead of skipping or
    # duplicating, so the single audit tracks the merged head and a hammer's
    # rebases never read as several hammers (agent-os#4090).
    if GH_TOKEN="$MERGE_AGENT_GH_TOKEN" gh api --method PATCH \
      "repos/<<REPO>>/issues/comments/$HAM_EXISTING_AUDIT_COMMENT_ID" \
      -f body="$HAM_AUDIT_COMMENT_BODY" > /dev/null 2> "$HAM_AUDIT_COMMENT_POST_STDERR"; then
      HAM_AUDIT_COMMENT_POSTED=1
      echo "hammer audit comment refreshed in place ($HAM_EXISTING_AUDIT_COMMENT_ID) → $POST_REMEDIATION_SHA" >&2
      break
    fi
    HAM_AUDIT_COMMENT_POST_EXIT=$?
    if [ "$HAM_AUDIT_COMMENT_ATTEMPT" -ge 3 ] || ! ham_audit_comment_transient "$HAM_AUDIT_COMMENT_POST_STDERR"; then
      cat "$HAM_AUDIT_COMMENT_POST_STDERR" >&2 || true
      echo "hammer audit comment edit failed on attempt $HAM_AUDIT_COMMENT_ATTEMPT/3; not retrying" >&2
      ham_audit_cleanup_tmp_files
      exit "$HAM_AUDIT_COMMENT_POST_EXIT"
    fi
    cat "$HAM_AUDIT_COMMENT_POST_STDERR" >&2 || true
    echo "hammer audit comment edit failed on attempt $HAM_AUDIT_COMMENT_ATTEMPT/3; retrying" >&2
    sleep $((HAM_AUDIT_COMMENT_ATTEMPT * 2))
    continue
  fi
  if GH_TOKEN="$MERGE_AGENT_GH_TOKEN" gh pr comment <<PR_URL>> --body "$HAM_AUDIT_COMMENT_BODY" 2> "$HAM_AUDIT_COMMENT_POST_STDERR"; then
    HAM_AUDIT_COMMENT_POSTED=1
    break
  fi
  HAM_AUDIT_COMMENT_POST_EXIT=$?
  if [ "$HAM_AUDIT_COMMENT_ATTEMPT" -ge 3 ] || ! ham_audit_comment_transient "$HAM_AUDIT_COMMENT_POST_STDERR"; then
    cat "$HAM_AUDIT_COMMENT_POST_STDERR" >&2 || true
    echo "hammer audit comment post failed on attempt $HAM_AUDIT_COMMENT_ATTEMPT/3; not retrying" >&2
    ham_audit_cleanup_tmp_files
    exit "$HAM_AUDIT_COMMENT_POST_EXIT"
  fi
  cat "$HAM_AUDIT_COMMENT_POST_STDERR" >&2 || true
  echo "hammer audit comment post failed on attempt $HAM_AUDIT_COMMENT_ATTEMPT/3; retrying" >&2
  sleep $((HAM_AUDIT_COMMENT_ATTEMPT * 2))
done
if [ "$HAM_AUDIT_COMMENT_POSTED" -ne 1 ]; then
  echo "HAM hard-blocker: hammer audit comment post failed after 3 attempts" >&2
  ham_audit_cleanup_tmp_files
  exit 1
fi
ham_audit_cleanup_tmp_files
```

Refresh and validate the live head:

```bash
gh pr view <<PR_URL>> --json number,headRefOid,state,isDraft,mergeable,mergeStateStatus,labels,statusCheckRollup,author,baseRefName > /tmp/ham-<<PR_NUMBER>>-pr-after.json
POST_REMEDIATION_SHA=$(jq -r '.headRefOid' /tmp/ham-<<PR_NUMBER>>-pr-after.json)
BASE_BRANCH=$(jq -r '.baseRefName' /tmp/ham-<<PR_NUMBER>>-pr-after.json)
HAM_VALIDATION_BASE_SHA="${HAM_VALIDATION_BASE_SHA:-}"
HAM_FORCE_REVALIDATION=0
HAM_REBASE_ATTEMPTS=0
HAM_REBASE_ATTEMPT_CAP="${HAM_REBASE_ATTEMPT_CAP:-3}"
HAM_UPDATE_BRANCH_RETRY_CAP="${HAM_UPDATE_BRANCH_RETRY_CAP:-3}"
HAM_MERGE_LEASE_WAIT_SECONDS="${HAM_MERGE_LEASE_WAIT_SECONDS:-900}"
HAM_MERGE_LEASE_RELEASE_RETRY_CAP="${HAM_MERGE_LEASE_RELEASE_RETRY_CAP:-3}"
HAM_MERGE_LEASE_ID=""
HAM_MERGE_LEASE_HELD=0

ham_release_merge_lease() {
  if [ "${HAM_MERGE_LEASE_HELD:-0}" -eq 1 ] && [ -n "${HAM_MERGE_LEASE_ID:-}" ]; then
    ham_release_attempt=1
    while [ "$ham_release_attempt" -le "$HAM_MERGE_LEASE_RELEASE_RETRY_CAP" ]; do
      if node <<ROOT_DIR>>/bin/merge-lease.mjs release \
        --repo <<REPO>> \
        --base "$BASE_BRANCH" \
        --pr <<PR_NUMBER>> \
        --lease-id "$HAM_MERGE_LEASE_ID" \
        > /tmp/ham-<<PR_NUMBER>>-merge-lease-release.json; then
        HAM_MERGE_LEASE_HELD=0
        HAM_MERGE_LEASE_ID=""
        trap - EXIT
        return 0
      else
        HAM_MERGE_LEASE_RELEASE_EXIT=$?
      fi
      echo "AMG-04 warning: merge lease release attempt ${ham_release_attempt}/${HAM_MERGE_LEASE_RELEASE_RETRY_CAP} failed for lease ${HAM_MERGE_LEASE_ID} (exit ${HAM_MERGE_LEASE_RELEASE_EXIT}); keeping EXIT trap armed" >&2
      cat /tmp/ham-<<PR_NUMBER>>-merge-lease-release.json >&2 || true
      if [ "$ham_release_attempt" -ge "$HAM_MERGE_LEASE_RELEASE_RETRY_CAP" ]; then
        echo "AMG-04 hard-blocker: merge lease release failed after ${HAM_MERGE_LEASE_RELEASE_RETRY_CAP} attempts; do not continue while the lease is unconfirmed" >&2
        return "$HAM_MERGE_LEASE_RELEASE_EXIT"
      fi
      sleep $((ham_release_attempt * 2))
      ham_release_attempt=$((ham_release_attempt + 1))
    done
    return 1
  fi
}

ham_acquire_merge_lease() {
  if node <<ROOT_DIR>>/bin/merge-lease.mjs acquire \
    --repo <<REPO>> \
    --base "$BASE_BRANCH" \
    --pr <<PR_NUMBER>> \
    --head "$POST_REMEDIATION_SHA" \
    --owner-pid "$$" \
    --wait "$HAM_MERGE_LEASE_WAIT_SECONDS" \
    > /tmp/ham-<<PR_NUMBER>>-merge-lease-acquire.json; then
    HAM_MERGE_LEASE_ACQUIRE_EXIT=0
  else
    HAM_MERGE_LEASE_ACQUIRE_EXIT=$?
  fi
  if [ "$HAM_MERGE_LEASE_ACQUIRE_EXIT" -eq 70 ] \
    && [ "$(jq -r '.parked // false' /tmp/ham-<<PR_NUMBER>>-merge-lease-acquire.json)" = "true" ]; then
    HAM_PARK_REASON=$(jq -r '.reason // "merge-lease-parked"' /tmp/ham-<<PR_NUMBER>>-merge-lease-acquire.json)
    echo "AMG-04 parked: merge lease acquisition parked PR <<PR_NUMBER>> ($HAM_PARK_REASON)" >&2
    exit 0
  fi
  if [ "$HAM_MERGE_LEASE_ACQUIRE_EXIT" -eq 75 ] \
    && [ "$(jq -r '.timedOut // false' /tmp/ham-<<PR_NUMBER>>-merge-lease-acquire.json)" = "true" ]; then
    HAM_PARK_WAITED=$(jq -r '.waited_s // "unknown"' /tmp/ham-<<PR_NUMBER>>-merge-lease-acquire.json)
    echo "AMG-04 parked: merge lease acquisition timed out for PR <<PR_NUMBER>> after ${HAM_PARK_WAITED}s" >&2
    exit 0
  fi
  if [ "$HAM_MERGE_LEASE_ACQUIRE_EXIT" -ne 0 ]; then
    cat /tmp/ham-<<PR_NUMBER>>-merge-lease-acquire.json >&2
    exit "$HAM_MERGE_LEASE_ACQUIRE_EXIT"
  fi
  HAM_MERGE_LEASE_ID=$(jq -r '.leaseId // empty' /tmp/ham-<<PR_NUMBER>>-merge-lease-acquire.json)
  if [ -z "$HAM_MERGE_LEASE_ID" ]; then
    echo "AMG-04 hard-blocker: merge lease acquired without leaseId" >&2
    exit 1
  fi
  HAM_MERGE_LEASE_HELD=1
  trap ham_release_merge_lease EXIT
}

ham_update_branch_conflict() {
  grep -Eiq 'conflict|cannot be rebased|resolve conflicts' "$1"
}

ham_update_branch_transient() {
  grep -Eiq 'timeout|timed out|TLS|connection reset|connection refused|temporar(y|ily)|try again|rate limit|secondary rate limit|HTTP 5[0-9][0-9]|502|503|504|service unavailable|gateway' "$1"
}

ham_is_full_sha() {
  printf '%s' "$1" | grep -Eiq '^[0-9a-f]{40}$'
}

ham_fetch_base_with_retries() {
  ham_fetch_attempt=1
  while [ "$ham_fetch_attempt" -le "$HAM_UPDATE_BRANCH_RETRY_CAP" ]; do
    if git fetch origin "$BASE_BRANCH" > /tmp/ham-<<PR_NUMBER>>-fetch-base.stdout 2> /tmp/ham-<<PR_NUMBER>>-fetch-base.stderr; then
      return 0
    fi
    if ! ham_update_branch_transient /tmp/ham-<<PR_NUMBER>>-fetch-base.stderr; then
      return 1
    fi
    if [ "$ham_fetch_attempt" -ge "$HAM_UPDATE_BRANCH_RETRY_CAP" ]; then
      return 1
    fi
    sleep $((ham_fetch_attempt * 5))
    ham_fetch_attempt=$((ham_fetch_attempt + 1))
  done
  return 1
}

ham_capture_current_base_sha() {
  if ! ham_fetch_base_with_retries; then
    return 1
  fi
  HAM_CAPTURED_BASE_SHA=$(git rev-parse "origin/$BASE_BRANCH" 2>/tmp/ham-<<PR_NUMBER>>-rev-parse-base.stderr || true)
  ham_is_full_sha "$HAM_CAPTURED_BASE_SHA"
}

ham_update_branch_with_retries() {
  ham_update_attempt=1
  while [ "$ham_update_attempt" -le "$HAM_UPDATE_BRANCH_RETRY_CAP" ]; do
    if gh pr update-branch <<PR_URL>> --rebase > /tmp/ham-<<PR_NUMBER>>-update-branch.stdout 2> /tmp/ham-<<PR_NUMBER>>-update-branch.stderr; then
      return 0
    fi
    if ham_update_branch_conflict /tmp/ham-<<PR_NUMBER>>-update-branch.stderr; then
      return 2
    fi
    if ! ham_update_branch_transient /tmp/ham-<<PR_NUMBER>>-update-branch.stderr; then
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

while [ "$(jq -r '.mergeStateStatus // ""' /tmp/ham-<<PR_NUMBER>>-pr-after.json)" = "BEHIND" ]; do
  if [ "${HAM_MERGE_LEASE_HELD:-0}" -ne 1 ]; then
    ham_acquire_merge_lease
  fi
  if [ "$HAM_REBASE_ATTEMPTS" -ge "$HAM_REBASE_ATTEMPT_CAP" ]; then
    echo "HAM-03 hard-blocker: rebase attempt cap exceeded ($HAM_REBASE_ATTEMPTS/$HAM_REBASE_ATTEMPT_CAP)" >&2
    ham_release_merge_lease
    exit 0
  fi
  HAM_REBASE_ATTEMPTS=$((HAM_REBASE_ATTEMPTS + 1))
  ham_update_branch_with_retries
  HAM_UPDATE_BRANCH_EXIT=$?
  if [ "$HAM_UPDATE_BRANCH_EXIT" -eq 2 ]; then
    # The hammer OWNS merge-conflict resolution, but NEVER while holding the
    # merge lease. Release the lease immediately, step out to the conflict
    # procedure below, resolve locally, force-push with lease, re-run the FULL
    # suite + required checks in the parallel phase, then return here and
    # re-acquire before the next rebase/merge attempt.
    echo "HAM-03 conflict: releasing merge lease before local conflict resolution" >&2
    if ! ham_release_merge_lease; then
      echo "HAM-03 hard-blocker: cannot resolve conflict while merge lease release is unconfirmed" >&2
      exit 1
    fi
    # >>> Perform the local rebase + conflict resolution from the
    #     "## Resolving merge conflicts" section below, re-validate, then fall through. <<<
    gh pr view <<PR_URL>> --json number,headRefOid,state,isDraft,mergeable,mergeStateStatus,labels,statusCheckRollup,author,baseRefName > /tmp/ham-<<PR_NUMBER>>-pr-after.json
    POST_REMEDIATION_SHA=$(jq -r '.headRefOid' /tmp/ham-<<PR_NUMBER>>-pr-after.json)
    BASE_BRANCH=$(jq -r '.baseRefName' /tmp/ham-<<PR_NUMBER>>-pr-after.json)
    if ham_capture_current_base_sha; then
      HAM_VALIDATION_BASE_SHA="$HAM_CAPTURED_BASE_SHA"
    else
      HAM_VALIDATION_BASE_SHA=""
      HAM_FORCE_REVALIDATION=1
    fi
    continue
  fi
  if [ "$HAM_UPDATE_BRANCH_EXIT" -ne 0 ]; then
    cat /tmp/ham-<<PR_NUMBER>>-update-branch.stderr >&2
    ham_release_merge_lease
    exit 1
  fi
  gh pr view <<PR_URL>> --json number,headRefOid,state,isDraft,mergeable,mergeStateStatus,labels,statusCheckRollup,author,baseRefName > /tmp/ham-<<PR_NUMBER>>-pr-after.json
  POST_REMEDIATION_SHA=$(jq -r '.headRefOid' /tmp/ham-<<PR_NUMBER>>-pr-after.json)
done

if [ "${HAM_MERGE_LEASE_HELD:-0}" -ne 1 ]; then
  ham_acquire_merge_lease
fi

if ! ham_is_full_sha "$HAM_VALIDATION_BASE_SHA"; then
  HAM_FORCE_REVALIDATION=1
fi
if ham_capture_current_base_sha; then
  HAM_CURRENT_BASE_SHA="$HAM_CAPTURED_BASE_SHA"
  HAM_REBASED_ONTO_BASE_SHA="$HAM_CAPTURED_BASE_SHA"
else
  HAM_CURRENT_BASE_SHA=""
  HAM_REBASED_ONTO_BASE_SHA=""
  HAM_FORCE_REVALIDATION=1
fi
if [ "$HAM_FORCE_REVALIDATION" -eq 1 ]; then
  printf '{"needsRevalidation":true,"reason":"validation-base-unavailable"}\n' > /tmp/ham-<<PR_NUMBER>>-merge-lease-revalidation.json
  HAM_NEEDS_REVALIDATION=true
else
  if node <<ROOT_DIR>>/bin/merge-lease.mjs needs-revalidation \
    --repo-path . \
    --base "$BASE_BRANCH" \
    --validation-base "$HAM_VALIDATION_BASE_SHA" \
    --current-base "$HAM_CURRENT_BASE_SHA" \
    --changed-files-from "$POST_REMEDIATION_SHA" \
    > /tmp/ham-<<PR_NUMBER>>-merge-lease-revalidation.json; then
    HAM_NEEDS_REVALIDATION=$(jq -er 'if (.needsRevalidation | type) == "boolean" then .needsRevalidation else true end' /tmp/ham-<<PR_NUMBER>>-merge-lease-revalidation.json 2> /tmp/ham-<<PR_NUMBER>>-merge-lease-revalidation-jq.stderr || true)
    if [ "$HAM_NEEDS_REVALIDATION" != "true" ] && [ "$HAM_NEEDS_REVALIDATION" != "false" ]; then
      printf '{"needsRevalidation":true,"reason":"needs-revalidation-output-invalid"}\n' > /tmp/ham-<<PR_NUMBER>>-merge-lease-revalidation.json
      HAM_NEEDS_REVALIDATION=true
    fi
  else
    HAM_NEEDS_REVALIDATION_EXIT=$?
    printf '{"needsRevalidation":true,"reason":"needs-revalidation-tool-failed","exitCode":%s}\n' "$HAM_NEEDS_REVALIDATION_EXIT" > /tmp/ham-<<PR_NUMBER>>-merge-lease-revalidation.json
    HAM_NEEDS_REVALIDATION=true
  fi
fi

# CONFIRM THE REBASE HOLDS: the head is now rebased onto the latest main. If
# HAM_NEEDS_REVALIDATION is true, re-run the changed-surface tests (mandate step
# 2b) and required checks against THIS rebased $POST_REMEDIATION_SHA and fix anything
# the rebase newly broke. If HAM_NEEDS_REVALIDATION is false, trust the
# parallel-phase validation already performed for this head/base relationship
# only for that parallel phase. GitHub required checks are the sole CI authority;
# the hammer runs no local battery or pre-push CI mirror as a merge gate. A rebase
# that turns changed-surface tests or required checks red must be fixed (and
# re-committed, which moves the head and re-enters this validation), never merged.
# Do not proceed past this point with a red applicable suite, a red required
# check, or a still-BEHIND mergeStateStatus.
```

## Resolving merge conflicts

The hammer OWNS merge-conflict resolution. A conflicting (`mergeable=CONFLICTING`)
or behind PR must NOT be left for the operator, but the merge lease must be
released BEFORE conflict resolution starts. Never hold the lease while opening
files, resolving markers, running changed-surface tests, or force-pushing the conflict
resolution. After the conflict is resolved and re-validated in the parallel
phase, re-enter the merge step and re-acquire the lease before rebasing/merging.
When the rebase loop above hits a conflict, this is the procedure to run only
after `ham_release_merge_lease` has completed:

```bash
BASE_BRANCH=$(jq -r '.baseRefName' /tmp/ham-<<PR_NUMBER>>-pr-after.json)
HEAD_BRANCH=$(gh pr view <<PR_URL>> --json headRefName --jq '.headRefName')
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

After resolving, the head has moved — re-run changed-surface tests (mandate 2b)
and required checks on the new head before re-acquiring the merge lease and
merging, exactly as for any parallel-phase validation.

```bash
gh pr view <<PR_URL>> --json reviews > /tmp/ham-<<PR_NUMBER>>-reviews.json

base_enc=$(printf '%s' "$(jq -r '.baseRefName' /tmp/ham-<<PR_NUMBER>>-pr-after.json)" | jq -sRr @uri)
gh api "repos/<<REPO>>/branches/$base_enc/protection" > /tmp/ham-<<PR_NUMBER>>-protection.json
gh api "repos/<<REPO>>/issues/<<PR_NUMBER>>/timeline" --paginate > /tmp/ham-<<PR_NUMBER>>-timeline.json
gh api "repos/<<REPO>>/commits/$POST_REMEDIATION_SHA" > /tmp/ham-<<PR_NUMBER>>-commit.json
```

Build `/tmp/ham-<<PR_NUMBER>>-terminal-remediation.json` as the claim to verify. `ama-check`
must confirm the commit parent/trailers from `/tmp/ham-<<PR_NUMBER>>-commit.json` and confirm
the audit comment body and author exist in `/tmp/ham-<<PR_NUMBER>>-timeline.json`; the raw
commit payload must include a non-empty `files[]` diff. If the mandatory rebase
rewrites the commit parent, the verified `Reviewed-Head` trailer must still
match `<<REVIEWED_SHA>>`. The JSON claim alone does not satisfy the predicate.

```json
{
  "active": true,
  "ticket": "HAM",
  "commit": {
    "sha": "<validated-post-remediation-sha>",
    "parentSha": "<<REVIEWED_SHA>>",
    "trailers": {
      "Worker-Class": "hammer",
      "Worker-Ticket": "HAM",
      "Closed-By": "hammer (adversarial-pipe-mode)",
      "Remediated-Findings": "<n> addressed (<b> blocking, <nb> non-blocking)"
    }
  },
  "auditComment": {
    "body": "<posted PR audit comment body>",
    "docCurrency": {
      "status": "updated | skipped_superproject | not_applicable",
      "changedFiles": ["<every path from the verified commit files[]>"],
      "docsUpdated": ["<doc paths changed in this commit, when status is updated>"],
      "skippedSuperprojectDocs": ["<owed superproject docs, when status is skipped_superproject>"]
    },
    "findings": [
      { "title": "<finding title>", "blocking": true, "file": "<path>", "addressed": true }
    ]
  }
}
```

Run the predicate against the live post-remediation head:

```bash
node /Users/airlock/agent-os/tools/adversarial-review/bin/ama-check.mjs \
  --pr /tmp/ham-<<PR_NUMBER>>-pr-after.json \
  --reviews /tmp/ham-<<PR_NUMBER>>-reviews.json \
  --protection /tmp/ham-<<PR_NUMBER>>-protection.json \
  --timeline /tmp/ham-<<PR_NUMBER>>-timeline.json \
  --repo <<REPO>> \
  --root-dir <<ROOT_DIR>> \
  --reviewed-sha <<REVIEWED_SHA>> \
  --reviewer <<REVIEWER>> \
  --risk-class <<RISK_CLASS>> \
  --ham-terminal-remediation /tmp/ham-<<PR_NUMBER>>-terminal-remediation.json \
  --ham-commit /tmp/ham-<<PR_NUMBER>>-commit.json \
  > /tmp/ham-<<PR_NUMBER>>-verdict.json
```

Do not merge unless all of these are true:

- `HAM_MERGE_LEASE_HELD=1` and `HAM_MERGE_LEASE_ID` is non-empty.
- `/tmp/ham-<<PR_NUMBER>>-verdict.json` has `eligible: true`. (For any BLOCKING finding the
  predicate still requires validated terminal-remediation provenance —
  `ham_terminal_remediation_validated` — to reach `eligible: true`; for a
  non-blocking-only close the entitled hammer is trusted and `eligible: true`
  alone is sufficient.)
- `POST_REMEDIATION_SHA` still equals the PR head.
- The branch is rebased onto the latest `main` — `mergeStateStatus` is NOT
  `BEHIND` for `POST_REMEDIATION_SHA`.
- GitHub's required checks are successful for `POST_REMEDIATION_SHA`, as read
  from `statusCheckRollup` through the existing `src/github-api.mjs` adapter, and
  no failed, missing, stale, pending, or unchecked required check exists.
  You remain mandated to FIX or HARDEN every failing regression you can —
  including ones unrelated to this branch, pre-existing on `origin/main`, flaky,
  or purely worker-sandbox-environment limited (missing host dependency, blocked
  `ps`/process introspection, etc.). If the failure is fixable from this PR,
  it blocks the merge until the hammer fixes it or legitimately re-runs it green.
  If it is purely worker-sandbox-environment limited and physically unfixable
  from this workspace, triage it, document the host limitation in the closing
  audit comment, and continue only when every repo-fixable regression is green.
- No failed, missing, stale, or unchecked required check exists.
- No non-waived gate remains.

In-lease merge:

```bash
if [ "${HAM_MERGE_LEASE_HELD:-0}" -ne 1 ] || [ -z "${HAM_MERGE_LEASE_ID:-}" ]; then
  echo "AMG-04 hard-blocker: no hammer merge without holding the merge lease" >&2
  exit 1
fi

HAM_REMOTE_CI_WAIT_SECONDS="${HAM_REMOTE_CI_WAIT_SECONDS:-900}"
HAM_REMOTE_CI_POLL_SECONDS="${HAM_REMOTE_CI_POLL_SECONDS:-15}"
HAM_REMOTE_CI_GATE_READ_FAILURE_LIMIT="${HAM_REMOTE_CI_GATE_READ_FAILURE_LIMIT:-3}"
HAM_MERGE_RETRY_CAP="${HAM_MERGE_RETRY_CAP:-4}"
HAM_MERGE_BACKOFF_BASE_SECONDS="${HAM_MERGE_BACKOFF_BASE_SECONDS:-2}"
HAM_MERGE_TMP_PREFIX="${TMPDIR:-/tmp}/ham-<<PR_NUMBER>>-${HAM_MERGE_LEASE_ID:-no-lease}-$$"
HAM_MERGE_STDOUT=$(mktemp "${HAM_MERGE_TMP_PREFIX}.gh-pr-merge.stdout.XXXXXX") || exit 1
HAM_MERGE_STDERR=$(mktemp "${HAM_MERGE_TMP_PREFIX}.gh-pr-merge.stderr.XXXXXX") || exit 1
HAM_GATE_JSON=$(mktemp "${HAM_MERGE_TMP_PREFIX}.github-gate.XXXXXX") || exit 1
HAM_POST_MERGE_JSON=$(mktemp "${HAM_MERGE_TMP_PREFIX}.post-merge.XXXXXX") || exit 1
HAM_POST_MERGE_STDERR=$(mktemp "${HAM_MERGE_TMP_PREFIX}.post-merge.stderr.XXXXXX") || exit 1
HAM_PRE_MERGE_ELIGIBLE=0

ham_append_terminal_audit() {
  ham_audit_outcome="$1"
  ham_audit_reason="$2"
  ham_audit_attempt_json=$(mktemp "${HAM_MERGE_TMP_PREFIX}.terminal-audit-attempt.XXXXXX") || return 1
  jq -n \
    --arg outcome "$ham_audit_outcome" \
    --arg reason "$ham_audit_reason" \
    --arg reviewedHead "<<REVIEWED_SHA>>" \
    --arg validatedHead "$POST_REMEDIATION_SHA" \
    --arg mergeMethod "<<MERGE_METHOD>>" \
    --arg rebasedOntoBase "${HAM_REBASED_ONTO_BASE_SHA:-}" \
    --arg localCiStatus "${HAM_LOCAL_CI_STATUS:-unknown}" \
    --arg remoteCiStatus "${HAM_REMOTE_CI_STATUS:-unknown}" \
    --arg remediatedFindings "<n> addressed (<b> blocking, <nb> non-blocking)" \
    --arg failingTestsFixed "<list, or 'suite already green'>" \
    --arg mergeCommit "${HAM_MERGE_COMMIT:-}" \
    --arg mergedAt "${HAM_MERGED_AT:-}" \
    --argjson mergeAttempts "${HAM_MERGE_ATTEMPTS:-0}" \
    --argjson rebaseAttempts "${HAM_REBASE_ATTEMPTS:-0}" \
    --argjson preMergeEligible "${HAM_PRE_MERGE_ELIGIBLE:-0}" \
    --argjson eligibilityTrace "$(cat /tmp/ham-<<PR_NUMBER>>-verdict.json)" \
    --argjson githubGate "$([ -s "$HAM_GATE_JSON" ] && cat "$HAM_GATE_JSON" || printf '{}')" \
    '{
      preMergeEligible: ($preMergeEligible == 1),
      attemptPhase: "hammer-gh-pr-merge",
      headMatchEvidence: "ham_terminal_remediation_validated",
      reviewedHead: $reviewedHead,
      validatedHead: $validatedHead,
      mergeMethod: $mergeMethod,
      rebasedOntoBase: $rebasedOntoBase,
      localCiStatus: $localCiStatus,
      remoteCiStatus: $remoteCiStatus,
      remediatedFindings: $remediatedFindings,
      failingTestsFixed: $failingTestsFixed,
      rebaseAttempts: $rebaseAttempts,
      mergeAttempts: $mergeAttempts,
      mergeCommitSha: $mergeCommit,
      mergedAt: $mergedAt,
      reason: $reason,
      eligibilityTrace: $eligibilityTrace,
      githubGate: $githubGate
    }' > "$ham_audit_attempt_json"
  node /Users/airlock/agent-os/tools/adversarial-review/bin/ama-audit.mjs append \
    --hq-root <<HQ_ROOT>> \
    --repo <<REPO>> \
    --pr <<PR_NUMBER>> \
    --head "$POST_REMEDIATION_SHA" \
    --outcome "$ham_audit_outcome" \
    --attempt-json "$ham_audit_attempt_json" \
    --now "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  ham_audit_append_exit=$?
  rm -f "$ham_audit_attempt_json"
  if [ "$ham_audit_append_exit" -eq 65 ]; then
    echo "audit append refused by sticky-succeeded guard; treating as no-op" >&2
    return 0
  fi
  return "$ham_audit_append_exit"
}

ham_emit_git_merge_signal() {
  [ -n "${HAM_MERGE_COMMIT:-}" ] || return 1
  HAM_AGENT_OS_ROOT="${AGENT_OS_ROOT:-/Users/airlock/agent-os}"
  [ -d "$HAM_AGENT_OS_ROOT/modules/worker-pool/lib/python" ] || return 1
  [ -d "$HAM_AGENT_OS_ROOT/platform/session-ledger/src" ] || return 1
  HAM_SIGNAL_ATTEMPTS=0
  while [ "$HAM_SIGNAL_ATTEMPTS" -lt "$HAM_MERGE_RETRY_CAP" ]; do
    HAM_SIGNAL_ATTEMPTS=$((HAM_SIGNAL_ATTEMPTS + 1))
    if PYTHONPATH="$HAM_AGENT_OS_ROOT/modules/worker-pool/lib/python:$HAM_AGENT_OS_ROOT/platform/session-ledger/src${PYTHONPATH:+:$PYTHONPATH}" \
      /usr/bin/perl -e 'alarm shift; exec @ARGV' 15 python3 - "<<HQ_ROOT>>" "<<PR_NUMBER>>" "$HAM_MERGE_COMMIT" "<<MERGE_METHOD>>" <<'PYEOF' >/dev/null 2>&1
import sys

from cwp_dispatch.git_signal import EVENT_MERGE_SIGNAL, emit_git_event_best_effort, workspace_context

hq_root, pr_number, merge_commit_sha, mode = sys.argv[1:]
ctx = workspace_context()
emit_git_event_best_effort(
    hq_root=hq_root,
    event_type=EVENT_MERGE_SIGNAL,
    worker_run_id=ctx.worker_run_id,
    launch_request_id=ctx.launch_request_id,
    ticket_ref=ctx.ticket_ref,
    pr_number=int(pr_number),
    merge_commit_sha=merge_commit_sha,
    merged_by=ctx.worker_class or "hammer",
    mode=mode,
)
PYEOF
    then
      return 0
    fi
    if [ "$HAM_SIGNAL_ATTEMPTS" -ge "$HAM_MERGE_RETRY_CAP" ]; then
      return 1
    fi
    HAM_SIGNAL_BACKOFF_MULTIPLIER=$((1 << (HAM_SIGNAL_ATTEMPTS - 1)))
    HAM_SIGNAL_JITTER=$(awk 'BEGIN{srand(); print int(rand()*3)}')
    HAM_SIGNAL_SLEEP=$((HAM_MERGE_BACKOFF_BASE_SECONDS * HAM_SIGNAL_BACKOFF_MULTIPLIER + HAM_SIGNAL_JITTER))
    echo "HAM merge signal transient failure; retrying ${HAM_SIGNAL_ATTEMPTS}/${HAM_MERGE_RETRY_CAP} after ${HAM_SIGNAL_SLEEP}s" >&2
    sleep "$HAM_SIGNAL_SLEEP"
  done
  return 1
}

ham_mark_ama_closer_lease_succeeded() {
  POST_REMEDIATION_SHA="$POST_REMEDIATION_SHA" node --input-type=module <<'NODE'
import {
  AMA_CLOSER_LEASE_STATUS,
  readAmaCloserLease,
  updateAmaCloserLease,
} from '<<ROOT_DIR>>/src/ama/closer-lease.mjs';

const rootDir = '<<ROOT_DIR>>';
const identity = {
  repo: '<<REPO>>',
  prNumber: Number('<<PR_NUMBER>>'),
  headSha: process.env.POST_REMEDIATION_SHA,
};
const existing = readAmaCloserLease(rootDir, identity);
if (existing?.status === AMA_CLOSER_LEASE_STATUS.TERMINAL) {
  if (existing.terminalOutcome === 'succeeded') process.exit(0);
  throw new Error(
    `AMA closer lease is already terminal with outcome ${existing.terminalOutcome}`,
  );
}
updateAmaCloserLease({
  rootDir,
  ...identity,
  status: AMA_CLOSER_LEASE_STATUS.TERMINAL,
  terminalOutcome: 'succeeded',
});
NODE
}

ham_refresh_github_gate_once() {
  POST_REMEDIATION_SHA="$POST_REMEDIATION_SHA" node --input-type=module <<'NODE' > "$HAM_GATE_JSON"
import { fetchPullRequestRollup } from '<<ROOT_DIR>>/src/github-api.mjs';
import { evaluateMergeEligibility } from '<<ROOT_DIR>>/src/ama/merge-eligibility.mjs';

const repo = '<<REPO>>';
const prNumber = Number('<<PR_NUMBER>>');
const expectedHead = process.env.POST_REMEDIATION_SHA;
const rollup = await fetchPullRequestRollup(repo, prNumber);
const checks = Array.isArray(rollup.statusCheckRollup) ? rollup.statusCheckRollup : [];
const badChecks = checks.filter((check) => {
  const status = String(check.status || check.state || '').toUpperCase();
  const conclusion = String(check.conclusion || '').toUpperCase();
  if (check.__typename === 'StatusContext') return !['SUCCESS'].includes(status);
  if (status && !['COMPLETED'].includes(status)) return true;
  return !['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(conclusion);
});
const headMatches = String(rollup.headSha || rollup.headRefOid || '') === expectedHead;
const mergeable = String(rollup.mergeable || '').toUpperCase() === 'MERGEABLE';
const notBehind = String(rollup.mergeStateStatus || '').toUpperCase() !== 'BEHIND';
const state = String(rollup.state || '').toUpperCase();
const open = state === 'OPEN';
// MSM-02: the GitHub-side gate (required checks green + mergeable + head-match)
// is the shared merge-eligibility predicate. Verdict and lease are gated upstream
// for this call site — ama-check emits the verdict into /tmp verdict.json and the
// shell hard-checks HAM_MERGE_LEASE_HELD before reaching here — so they are passed
// as already-satisfied; `ok` stays exactly the pre-MSM-02 GitHub gate.
const ok = evaluateMergeEligibility({
  verdict: 'settled-success',
  leaseHeld: true,
  requiredChecks: checks,
  mergeable: rollup.mergeable,
  mergeStateStatus: rollup.mergeStateStatus,
  prState: state,
  candidateHead: rollup.headSha || rollup.headRefOid || '',
  validatedHead: expectedHead,
}).eligible;
console.log(JSON.stringify({
  ok,
  state,
  open,
  headMatches,
  expectedHead,
  liveHead: rollup.headSha || rollup.headRefOid || null,
  mergeable: rollup.mergeable || null,
  mergeStateStatus: rollup.mergeStateStatus || null,
  checksCount: checks.length,
  badChecks,
}, null, 2));
NODE
}

ham_refresh_github_gate() {
  HAM_GATE_ATTEMPTS=0
  while [ "$HAM_GATE_ATTEMPTS" -lt "$HAM_MERGE_RETRY_CAP" ]; do
    HAM_GATE_ATTEMPTS=$((HAM_GATE_ATTEMPTS + 1))
    if ham_refresh_github_gate_once; then
      return 0
    fi
    if [ "$HAM_GATE_ATTEMPTS" -ge "$HAM_MERGE_RETRY_CAP" ]; then
      return 1
    fi
    HAM_GATE_BACKOFF_MULTIPLIER=$((1 << (HAM_GATE_ATTEMPTS - 1)))
    HAM_GATE_JITTER=$(awk 'BEGIN{srand(); print int(rand()*3)}')
    HAM_GATE_SLEEP=$((HAM_MERGE_BACKOFF_BASE_SECONDS * HAM_GATE_BACKOFF_MULTIPLIER + HAM_GATE_JITTER))
    echo "HAM GitHub gate read transient failure; retrying ${HAM_GATE_ATTEMPTS}/${HAM_MERGE_RETRY_CAP} after ${HAM_GATE_SLEEP}s" >&2
    sleep "$HAM_GATE_SLEEP"
  done
  return 1
}

ham_required_gate_ok() {
  jq -e '.ok == true' "$HAM_GATE_JSON" >/dev/null
}

ham_required_gate_red() {
  jq -e '
    (.badChecks // []) | any(
      ((.conclusion // "") | ascii_upcase) as $conclusion |
      ((.status // .state // "") | ascii_upcase) as $status |
      ((["FAILURE", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED"] | index($conclusion)) != null) or
      (.__typename == "StatusContext" and ((["ERROR", "FAILURE"] | index($status)) != null))
    )
  ' "$HAM_GATE_JSON" >/dev/null
}

ham_live_head_moved() {
  jq -e '.headMatches == false' "$HAM_GATE_JSON" >/dev/null
}

ham_already_merged_validated_head() {
  jq -e '.state == "MERGED" and .liveHead == .expectedHead' "$HAM_GATE_JSON" >/dev/null
}

ham_merge_error_retryable() {
  grep -Eiq 'connection reset|ECONNRESET|TLS handshake timeout|timeout|timed out|ETIMEDOUT|DNS|ENOTFOUND|EAI_AGAIN|socket|HTTP 5[0-9][0-9]|502|503|504|rate limit|secondary rate limit|Retry-After|temporar(y|ily)|try again|service unavailable|gateway' "$1"
}

ham_merge_error_already_merged() {
  grep -Eiq 'already merged' "$1"
}

ham_merge_error_permanent() {
  grep -Eiq 'match-head-commit|head.*(mismatch|changed|does not match)|not authorized|permission|authentication|forbidden|HTTP 401|HTTP 403|branch protection|ruleset|required check|status checks? (not|have not)|not mergeable|merge conflict|closed|pull request.*not open|draft' "$1"
}

# The hammer does NOT run a local test battery or the PPH pre-push CI mirror as a
# merge gate. GitHub required checks are the SOLE CI authority: the poll loop
# below waits (bounded) for the required gate to go green on this exact head and
# never merges a red or not-yet-green gate. Set the audit status once so the
# localCiStatus audit-JSON sites populate an honest value.
HAM_LOCAL_CI_STATUS=local-battery-skipped-github-required-gate-authoritative

HAM_REMOTE_CI_STATUS=waiting
HAM_REMOTE_CI_DEADLINE=$(( $(date +%s) + HAM_REMOTE_CI_WAIT_SECONDS ))
HAM_REMOTE_CI_GATE_READ_FAILURES=0
HAM_ALREADY_MERGED_VALIDATED_HEAD=0
while :; do
  if ! ham_refresh_github_gate; then
    HAM_REMOTE_CI_GATE_READ_FAILURES=$((HAM_REMOTE_CI_GATE_READ_FAILURES + 1))
    HAM_REMOTE_CI_STATUS=gate-read-transient-failure
    if [ "$HAM_REMOTE_CI_GATE_READ_FAILURES" -ge "$HAM_REMOTE_CI_GATE_READ_FAILURE_LIMIT" ] || [ "$(date +%s)" -ge "$HAM_REMOTE_CI_DEADLINE" ]; then
      echo "HAM hard-blocker: unable to read GitHub gate through src/github-api.mjs adapter after ${HAM_REMOTE_CI_GATE_READ_FAILURES} consecutive failures" >&2
      ham_append_terminal_audit failed-without-merge github-gate-read-failed || true
      ham_release_merge_lease
      exit 1
    fi
    echo "HAM remote CI: transient GitHub gate read failure ${HAM_REMOTE_CI_GATE_READ_FAILURES}/${HAM_REMOTE_CI_GATE_READ_FAILURE_LIMIT}; retrying within remote CI wait window" >&2
    sleep "$HAM_REMOTE_CI_POLL_SECONDS"
    continue
  fi
  HAM_REMOTE_CI_GATE_READ_FAILURES=0
  if ham_already_merged_validated_head; then
    echo "HAM preflight: PR is already merged at validated head; proceeding to post-merge validation" >&2
    HAM_REMOTE_CI_STATUS=already-merged-at-validated-head
    HAM_ALREADY_MERGED_VALIDATED_HEAD=1
    HAM_PRE_MERGE_ELIGIBLE=1
    break
  fi
  if ham_live_head_moved; then
    echo "HAM race: live PR head moved off validated head; releasing lease without merge or re-dispatch" >&2
    HAM_REMOTE_CI_STATUS=live-head-moved
    ham_append_terminal_audit superseded live-head-moved-before-merge || true
    ham_release_merge_lease
    exit 0
  fi
  if ham_required_gate_ok; then
    HAM_REMOTE_CI_STATUS=remote-ci-green
    break
  fi
  if ham_required_gate_red; then
    echo "HAM hard-blocker: GitHub required gate is red for validated head" >&2
    cat "$HAM_GATE_JSON" >&2
    HAM_REMOTE_CI_STATUS=remote-ci-red
    ham_append_terminal_audit failed-without-merge github-gate-red || true
    ham_release_merge_lease
    exit 0
  fi
  if [ "$(date +%s)" -ge "$HAM_REMOTE_CI_DEADLINE" ]; then
    echo "HAM hard-blocker: timed out waiting for GitHub required gate to become green for validated head" >&2
    cat "$HAM_GATE_JSON" >&2
    HAM_REMOTE_CI_STATUS=remote-ci-timeout
    ham_append_terminal_audit failed-without-merge github-gate-timeout || true
    ham_release_merge_lease
    exit 0
  fi
  echo "HAM remote CI: waiting for required checks on ${POST_REMEDIATION_SHA}" >&2
  sleep "$HAM_REMOTE_CI_POLL_SECONDS"
done
HAM_PRE_MERGE_ELIGIBLE=1

HAM_MERGE_ATTEMPTS=0
HAM_MERGE_EXIT=1
if [ "$HAM_ALREADY_MERGED_VALIDATED_HEAD" -eq 1 ]; then
  HAM_MERGE_EXIT=0
else
  HAM_PRE_MERGE_ATTEMPT_FILE=$(mktemp "${HAM_MERGE_TMP_PREFIX}.pre-merge-attempt.XXXXXX") || exit 1
  jq -n \
    --arg reviewedHead "<<REVIEWED_SHA>>" \
    --arg validatedHead "$POST_REMEDIATION_SHA" \
    --arg mergeMethod "<<MERGE_METHOD>>" \
    --arg rebasedOntoBase "${HAM_REBASED_ONTO_BASE_SHA:-}" \
    --arg localCiStatus "${HAM_LOCAL_CI_STATUS:-unknown}" \
    --arg remoteCiStatus "${HAM_REMOTE_CI_STATUS:-unknown}" \
    --arg remediatedFindings "<n> addressed (<b> blocking, <nb> non-blocking)" \
    --arg failingTestsFixed "<list, or 'suite already green'>" \
    --argjson rebaseAttempts "${HAM_REBASE_ATTEMPTS:-0}" \
    --argjson eligibilityTrace "$(cat /tmp/ham-<<PR_NUMBER>>-verdict.json)" \
    --argjson githubGate "$(cat "$HAM_GATE_JSON")" \
    '{
      preMergeEligible: true,
      attemptPhase: "before-hammer-gh-pr-merge",
      headMatchEvidence: "ham_terminal_remediation_validated",
      reviewedHead: $reviewedHead,
      validatedHead: $validatedHead,
      mergeMethod: $mergeMethod,
      rebasedOntoBase: $rebasedOntoBase,
      localCiStatus: $localCiStatus,
      remoteCiStatus: $remoteCiStatus,
      remediatedFindings: $remediatedFindings,
      failingTestsFixed: $failingTestsFixed,
      rebaseAttempts: $rebaseAttempts,
      eligibilityTrace: $eligibilityTrace,
      githubGate: $githubGate
    }' > "$HAM_PRE_MERGE_ATTEMPT_FILE"
  node /Users/airlock/agent-os/tools/adversarial-review/bin/ama-audit.mjs append \
    --hq-root <<HQ_ROOT>> \
    --repo <<REPO>> \
    --pr <<PR_NUMBER>> \
    --head "$POST_REMEDIATION_SHA" \
    --outcome in_progress \
    --attempt-json "$HAM_PRE_MERGE_ATTEMPT_FILE" || exit 1
  rm -f "$HAM_PRE_MERGE_ATTEMPT_FILE"
fi
while [ "$HAM_ALREADY_MERGED_VALIDATED_HEAD" -ne 1 ] && [ "$HAM_MERGE_ATTEMPTS" -lt "$HAM_MERGE_RETRY_CAP" ]; do
  HAM_MERGE_ATTEMPTS=$((HAM_MERGE_ATTEMPTS + 1))
  if ! ham_refresh_github_gate; then
    echo "HAM merge retry ${HAM_MERGE_ATTEMPTS}/${HAM_MERGE_RETRY_CAP}: gate read failed after bounded retries" >&2
    ham_append_terminal_audit failed-without-merge github-gate-read-failed || true
    ham_release_merge_lease
    exit 1
  fi
  if ham_already_merged_validated_head; then
    echo "HAM merge retry ${HAM_MERGE_ATTEMPTS}/${HAM_MERGE_RETRY_CAP}: PR is already merged at validated head; proceeding to post-merge validation" >&2
    HAM_MERGE_EXIT=0
    break
  fi
  if ham_live_head_moved; then
    echo "HAM race: live PR head moved off validated head before merge retry; releasing lease without merge or re-dispatch" >&2
    ham_append_terminal_audit superseded live-head-moved-before-merge || true
    ham_release_merge_lease
    exit 0
  fi
  if ! ham_required_gate_ok; then
    echo "HAM hard-blocker: GitHub required gate stopped being green before merge" >&2
    cat "$HAM_GATE_JSON" >&2
    ham_append_terminal_audit failed-without-merge github-gate-not-green || true
    ham_release_merge_lease
    exit 0
  fi

  gh pr merge <<PR_URL>> \
    --<<MERGE_METHOD>> \
    --match-head-commit "$POST_REMEDIATION_SHA" \
    > "$HAM_MERGE_STDOUT" \
    2> "$HAM_MERGE_STDERR"
  HAM_MERGE_EXIT=$?
  if [ "$HAM_MERGE_EXIT" -eq 0 ]; then
    break
  fi
  if ham_merge_error_already_merged "$HAM_MERGE_STDERR"; then
    cat "$HAM_MERGE_STDERR" >&2 || true
    echo "HAM merge response says PR is already merged; proceeding to post-merge validation" >&2
    HAM_MERGE_EXIT=0
    break
  fi
  if ham_merge_error_permanent "$HAM_MERGE_STDERR"; then
    cat "$HAM_MERGE_STDERR" >&2 || true
    echo "HAM hard-blocker: permanent gh pr merge rejection; not retrying" >&2
    ham_append_terminal_audit failed-without-merge permanent-merge-rejection || true
    ham_release_merge_lease
    exit 0
  fi
  if ! ham_merge_error_retryable "$HAM_MERGE_STDERR"; then
    cat "$HAM_MERGE_STDERR" >&2 || true
    echo "HAM hard-blocker: unclassified gh pr merge failure; fail closed without retry" >&2
    ham_append_terminal_audit failed-without-merge unclassified-merge-failure || true
    ham_release_merge_lease
    exit 1
  fi
  if [ "$HAM_MERGE_ATTEMPTS" -ge "$HAM_MERGE_RETRY_CAP" ]; then
    cat "$HAM_MERGE_STDERR" >&2 || true
    echo "HAM hard-blocker: retryable gh pr merge failures exhausted bounded budget" >&2
    ham_append_terminal_audit failed-without-merge merge-retry-budget-exhausted || true
    ham_release_merge_lease
    exit 1
  fi
  HAM_MERGE_BACKOFF_MULTIPLIER=$((1 << (HAM_MERGE_ATTEMPTS - 1)))
  HAM_MERGE_JITTER=$(awk 'BEGIN{srand(); print int(rand()*3)}')
  HAM_MERGE_SLEEP=$((HAM_MERGE_BACKOFF_BASE_SECONDS * HAM_MERGE_BACKOFF_MULTIPLIER + HAM_MERGE_JITTER))
  echo "HAM merge transient failure; retrying ${HAM_MERGE_ATTEMPTS}/${HAM_MERGE_RETRY_CAP} after ${HAM_MERGE_SLEEP}s" >&2
  sleep "$HAM_MERGE_SLEEP"
done

sleep 2
HAM_POST_VIEW_ATTEMPTS=0
HAM_POST_VIEW_EXIT=1
while [ "$HAM_POST_VIEW_ATTEMPTS" -lt "$HAM_MERGE_RETRY_CAP" ]; do
  HAM_POST_VIEW_ATTEMPTS=$((HAM_POST_VIEW_ATTEMPTS + 1))
  gh pr view <<PR_URL>> --json state,mergedAt,mergeCommit,headRefOid \
    > "$HAM_POST_MERGE_JSON" \
    2> "$HAM_POST_MERGE_STDERR"
  HAM_POST_VIEW_EXIT=$?
  if [ "$HAM_POST_VIEW_EXIT" -eq 0 ]; then
    break
  fi
  if ! ham_merge_error_retryable "$HAM_POST_MERGE_STDERR"; then
    cat "$HAM_POST_MERGE_STDERR" >&2 || true
    echo "HAM hard-blocker: unclassified gh pr view confirmation failure; fail closed without retry" >&2
    if [ "$HAM_MERGE_EXIT" -eq 0 ]; then
      ham_append_terminal_audit deferred merge-confirmation-read-failed-after-merge-accepted || true
    else
      ham_append_terminal_audit failed-without-merge merge-confirmation-read-failed || true
    fi
    ham_release_merge_lease
    exit 1
  fi
  if [ "$HAM_POST_VIEW_ATTEMPTS" -ge "$HAM_MERGE_RETRY_CAP" ]; then
    cat "$HAM_POST_MERGE_STDERR" >&2 || true
    echo "HAM hard-blocker: retryable gh pr view confirmation failures exhausted bounded budget" >&2
    if [ "$HAM_MERGE_EXIT" -eq 0 ]; then
      ham_append_terminal_audit deferred merge-confirmation-read-failed-after-merge-accepted || true
    else
      ham_append_terminal_audit failed-without-merge merge-confirmation-read-failed || true
    fi
    ham_release_merge_lease
    exit 1
  fi
  HAM_POST_VIEW_BACKOFF_MULTIPLIER=$((1 << (HAM_POST_VIEW_ATTEMPTS - 1)))
  HAM_POST_VIEW_JITTER=$(awk 'BEGIN{srand(); print int(rand()*3)}')
  HAM_POST_VIEW_SLEEP=$((HAM_MERGE_BACKOFF_BASE_SECONDS * HAM_POST_VIEW_BACKOFF_MULTIPLIER + HAM_POST_VIEW_JITTER))
  echo "HAM post-merge confirmation transient failure; retrying ${HAM_POST_VIEW_ATTEMPTS}/${HAM_MERGE_RETRY_CAP} after ${HAM_POST_VIEW_SLEEP}s" >&2
  sleep "$HAM_POST_VIEW_SLEEP"
done
HAM_POST_STATE=$(jq -r '.state // ""' "$HAM_POST_MERGE_JSON")
HAM_MERGED_AT=$(jq -r '.mergedAt // ""' "$HAM_POST_MERGE_JSON")
HAM_MERGE_COMMIT=$(jq -r '.mergeCommit?.oid // ""' "$HAM_POST_MERGE_JSON")
HAM_POST_HEAD=$(jq -r '.headRefOid // ""' "$HAM_POST_MERGE_JSON")
if [ "$HAM_POST_STATE" = "MERGED" ] && [ "$HAM_POST_HEAD" = "$POST_REMEDIATION_SHA" ]; then
  ham_append_terminal_audit succeeded merged
  HAM_MERGED_AUDIT_APPEND_EXIT=$?
  if [ "$HAM_MERGED_AUDIT_APPEND_EXIT" -ne 0 ]; then
    ham_release_merge_lease
    exit "$HAM_MERGED_AUDIT_APPEND_EXIT"
  fi
  if ! ham_emit_git_merge_signal; then
    echo "HAM hard-blocker: merge signal emission failed after confirmed merge; AMA closer lease remains retryable" >&2
    exit 1
  fi
  if ! ham_mark_ama_closer_lease_succeeded; then
    echo "HAM hard-blocker: failed to mark AMA closer lease succeeded after confirmed merge signal" >&2
    exit 1
  fi
  trap - EXIT
  ham_release_merge_lease
else
  echo "HAM hard-blocker: gh pr merge did not confirm merged validated head" >&2
  cat "$HAM_POST_MERGE_JSON" >&2
  ham_append_terminal_audit failed-without-merge merge-not-confirmed || true
  ham_release_merge_lease
  exit 1
fi
```

After the merged audit append succeeds, emit the merge signal and then release
the lease before posting the CLOSING comment described above. If `gh pr merge` or the post-merge `gh pr view`
confirmation returns a retryable transport, TLS, DNS/socket, HTTP 5xx, or
rate-limit/secondary-rate-limit failure, retry only inside the bounded budget
above while holding the same lease. The merge retry loop must re-read the live
head before each attempt; if that pre-flight observes the PR already `MERGED` at
`POST_REMEDIATION_SHA`, proceed to the post-merge validation instead of
recording a failed gate. Permanent head/protection/auth/check/closed or
unmergeable failures fail closed immediately with a non-merged audit reason.

If the head moved, a required check failed or is unchecked, HAM evidence is
missing, the predicate fails for the exact live SHA, the PR is closed/draft, or
there is an unresolvable conflict, release the lease, emit exactly one
hard-blocker report, and do not re-dispatch.

## Hard prohibitions

- No "please re-review", no "request another review", no re-review label.
- No follow-up PRs/issues for the final findings.
- No merging the old `<<REVIEWED_SHA>>` merely because it passed.
- No unbounded rebase/update-branch retries; cap them and stop through the
  single hard-blocker report path described above.
- No `gh pr merge` without `--<<MERGE_METHOD>> --match-head-commit "$POST_REMEDIATION_SHA"`
  while holding the merge lease.
- No merge when the live post-remediation head has failed, missing, stale, or
  unchecked required checks.
- No merging while required checks or changed-surface tests fail on this head.
  Repo-fixable failures proven pre-existing on `origin/main`, unrelated, or
  flaky still block until fixed or legitimately re-run green. Purely
  worker-sandbox-limited failures that are physically unfixable from this
  workspace must be triaged and documented in the closing audit comment instead
  of being treated as a permanent hard-stop.
- No silent red required-check exits. A red required check whose correct fix
  lives in another repo/submodule must have a linked subrepo PR, or the
  hard-blocker/audit comment must name the exact owed repo/path/change and why
  the subrepo PR could not be opened.
- No superproject pointer-bump PRs for submodule fixes. Main-catchup auto-floats
  submodule gitlinks after the submodule PR merges; wait for or rebase onto the
  floated current main instead of creating a gitlink-only PR.
- No merging a superproject PR that is still blocked on an unmerged submodule
  fix PR.
- No merging a branch that is `BEHIND` / not rebased onto the latest `main`; the
  rebase must be re-validated (required checks + changed-surface tests green)
  before merge.
- No hammer merge without holding the merge lease for `(<<REPO>>, base, PR <<PR_NUMBER>>)`
  and saving its `leaseId`; no cleanup path may release without
  `--lease-id "$HAM_MERGE_LEASE_ID"`.
- No abandoning a merge conflict to the operator. The hammer resolves conflicts
  locally only after releasing the merge lease (rebase onto base, resolve markers
  preserving both sides, force-push with lease), then re-validates and
  re-acquires. Hard-block ONLY a conflict that is genuinely unsafe to resolve (a
  semantic conflict you cannot correctly settle).
- No daemon handoff. The hammer owns the in-lease merge and writes the merged
  audit/closeout after GitHub confirms the validated head merged.
- No treating a rebased HAM head as valid without `ham_terminal_remediation_validated`
  except for the narrow strict-non-blocking `.active` lane described above.
- No landing a schema or module change that leaves an in-repo data-model doc
  (`docs/data-model/`, incl. `catalog.json`) or module walkthrough
  (`modules/<name>/<name>-walkthrough.md`) stale (mandate 2c).

<!-- hq:closeout:pr -->
