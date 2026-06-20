# Adversarial Merge Authority (AMA) local contract mirror

This repository carries the adversarial-review implementation for AMA closure.
The full project spec lives in the parent Agent OS repository at this same path;
this local mirror records the config surface that the Node loader, closer
dispatch, and operator runbooks in this repo must keep aligned.

## AMG-01 merge lease

AMA serializes local merge execution through a durable file lease keyed by
`(repo, base)`, where the canonical key is `<owner>/<repo>::<base>`. The holder
file lives under `data/merge-leases/` with a sanitized slug derived from that key,
and the sibling `.waiters.json` file records FIFO contenders for the same base.

Only one holder may acquire a lease for a key. Acquisition writes the holder file
with the repo, base, generated `leaseId`, PR number, head SHA, process id, host,
optional process group, acquisition timestamp, deadline, and update timestamp.
The write must use the repo's atomic temp-file plus hard-link discipline with
`overwrite:false`; a contender that loses the link race must observe the existing
holder and return without merging.

Holder release and renewal are fenced by the stored holder identity:
`leaseId`, PR number, head SHA, and the current `acquiredAt` timestamp. A holder
may renew by rewriting `acquiredAt` and `updatedAt` under that fence, which
extends the deadline for legitimate long-running merge work. A stale holder
release or renewal whose fence no longer matches must not delete or update a
newer holder.

Release, renewal, and waiter mutations are serialized by a secondary mutation
lock at `<lease>.mutation.lock`. That lock is recoverable state, not a permanent
operator-only latch: contenders must break it when the lock's same-host process
is dead or when the lock has exceeded its short critical-section TTL. A busy live
mutation lock must be reported as `mutation-lock-busy`, not hidden behind an
identity-change reason.

The operator-facing `merge-lease` CLI exposes `acquire`, `release`, `status`,
and `list` subcommands over this lease state. `acquire` is the blocking command:
callers pass the target repo/base, PR, head SHA, owner PID, optional owner PGID,
and a wait deadline. Argument and validation failures exit `64`; successful
acquire/status/release output exits `0`; an unmet acquire deadline, persistent
release contention, or unexpected runtime/IO failure exits `75` and is
retryable. Live `mutation-lock-busy` contention during waiter registration,
pruning, release, or timeout cleanup is transient: the CLI must retry inside the
caller-visible wait window and, if the deadline expires, return `75` rather
than reclassifying contention as usage. Runtime errors must not print the usage
banner; `64` is reserved for bad arguments and validation failures. CLI `repo`
must be shaped `owner/name`, and CLI `base` must be a safe branch name with no
absolute path, traversal, backslash, or leading dash component before either
value is used to derive lease files. PID liveness treats `EPERM` from
`process.kill(pid, 0)` as "process exists" and only `ESRCH` as dead, so a
cross-user live holder is not reclaimed as dead.
If the holder file has already been written, post-acquire waiter cleanup is
best-effort: a busy waiter mutation lock must not make the caller report a
timeout while it already owns the lease.

Reclaim is allowed only when the holder can no longer be trusted to serialize
the merge lane:

- Same-host holders may be reclaimed when their stored process id is no longer
  live.
- Same-host holders must not be reclaimed solely because the deadline has passed
  while the stored process id is still live; live long-running merges are
  expected to renew the lease instead.
- Cross-host holders may be reclaimed after the deadline because local PID
  liveness is unknowable.

Acquisition must attempt that same reclaim path when it observes an existing
holder before it returns `acquired:false`. A live holder still refuses acquire,
but a dead same-host holder or expired cross-host holder should not require an
out-of-band caller to remember a separate reclaim-then-retry dance.

FIFO waiters are advisory ordering state, not merge authority. Each waiter entry
records the repo, base, PR number, head SHA, waiter id, owning process id, owning
host, arrival timestamp, update timestamp, attempt number, and deadline. Before
the head-of-queue check, acquisition must prune abandoned waiters whose same-host
process is dead or whose arrival timestamp is older than its deadline. A dead or
expired waiter must not permanently block later contenders for that `(repo, base)`
lane.

Waiter writes are still advisory, but their read-modify-write mutations must run
under the recoverable mutation lock so concurrent contenders do not silently drop
or reorder each other's entries through last-writer-wins file replacement.

## AMG-03 merge-lease base revalidation

The merge-lease library exposes
`assessMergeLeaseNeedsRevalidation({ repoPath, base, validationBase,
currentBase, changedFilesFrom })`, and `bin/merge-lease.mjs
needs-revalidation` exposes the same decision as JSON for shell callers. This
contract is a decision helper for AMA callers that already hold the `(repo,
base)` merge lease; the helper may fetch and update `refs/remotes/origin/<base>`
inside `repoPath`, so callers must not run it as an unlocked shared-checkout
probe.

Inputs:

- `repoPath`: local git checkout to inspect.
- `base`: target branch name. It must be a non-empty branch ref segment and must
  not start with `-`, contain `..`, or contain `\`.
- `validationBase`: full 40-character SHA that the prior adversarial validation
  used as its base.
- `currentBase`: full 40-character SHA the caller believes is the current
  `origin/<base>` tip.
- `changedFilesFrom`: PR ref used to compute PR-touched files. It defaults to
  `HEAD`.

Before comparing files, the helper must verify that `validationBase` resolves
to a commit, then repeatedly read `refs/remotes/origin/<base>` and run
`git fetch --no-tags origin <base>` until that remote-tracking ref resolves to
`currentBase` or the bounded fetch attempts are exhausted. If the helper cannot
prove the local remote-tracking ref equals `currentBase`, it fails closed.

When `validationBase === currentBase`, the base has not advanced and the helper
returns `needsRevalidation:false` without inspecting changed files. Otherwise it
computes:

- base drift files from `git diff --name-only <validationBase>..<currentBase>`;
- PR files from `git merge-base <currentBase> <changedFilesFrom>` followed by
  `git diff --name-only <merge-base>..<changedFilesFrom>`.

If those file sets overlap, AMA must treat the prior validation as stale and
request revalidation. If the PR file set is empty after the base advanced, the
helper must fail closed with `reason:"pr-diff-empty"` because that usually means
the caller inspected the base branch or another non-PR ref instead of the
reviewed head. Only a non-empty PR file set with no overlap may return
`needsRevalidation:false` for `reason:"no-overlapping-files"`.

The JSON output shape is stable:

```json
{
  "needsRevalidation": true,
  "reason": "overlapping-files",
  "currentBase": "2222222222222222222222222222222222222222",
  "mainAdvancedBy": 3,
  "overlappingFiles": ["src/example.mjs"]
}
```

`needsRevalidation` is the boolean decision. `reason` is a stable machine
reason code. `currentBase` is the normalized current-base SHA when available.
`mainAdvancedBy` is the number of commits in `<validationBase>..<currentBase>`
when computable, `0` for `base-not-advanced`, and `null` before the helper can
compute drift. `overlappingFiles` is a sorted unique list and is empty for
non-overlap and fail-closed cases that cannot prove overlap.

Stable reason codes:

- `base-not-advanced`: `validationBase` equals `currentBase`; revalidation is
  not needed.
- `no-overlapping-files`: base advanced, the PR file set was non-empty, and no
  base-drift file overlaps a PR file; revalidation is not needed.
- `overlapping-files`: at least one base-drift file overlaps a PR file;
  revalidation is required.
- `repo-path-required`: `repoPath` was missing.
- `malformed-base`: `base` failed branch-name normalization.
- `malformed-validation-base`: `validationBase` was not a full SHA.
- `malformed-current-base`: `currentBase` was not a full SHA.
- `unresolvable-validation-base`: `validationBase` did not resolve to a commit.
- `unverified-current-base`: bounded fetch/read attempts could not prove
  `refs/remotes/origin/<base>` equals `currentBase`.
- `unresolvable-base-drift`: the helper could not count
  `<validationBase>..<currentBase>`.
- `changed-files-unavailable`: git failed while computing base-drift or PR
  changed files.
- `pr-diff-empty`: base advanced, but the PR ref produced an empty changed-file
  set; revalidation is required because the caller may not be inspecting the PR
  head.

The CLI writes only this decision JSON to stdout on a rendered decision and
exits zero. Shell callers that want to branch on the decision must parse
`needsRevalidation`; non-zero exit remains reserved for argument usage failures
or unexpected process errors.

## 1.1.1 HAM terminal-remediation mode

HAM terminal remediation is a bounded final-review closer path for the
`hammer` worker class. It may be used only after the final adversarial review
for a PR has blocking or non-blocking findings that the HAM worker remediates
directly on top of the reviewed head. The mode does not request another review
round; instead, `ama-check --ham-terminal-remediation <claim.json>` validates
the post-remediation head immediately before merge.

The HAM remediation scope includes keeping canonical docs current for the
change it lands. If the remediation diff changes a persistent store shape and
the repository carries `docs/data-model/`, HAM must update the matching
`docs/data-model/NN-*.md` domain doc and `docs/data-model/catalog.json`, then
run `node scripts/validate-data-model-catalog.mjs`; a failing catalog validator
is treated as a red check. If the diff changes a module's public interface,
dispatch flow, or operational contract and that module has
`modules/<name>/<name>-walkthrough.md`, HAM must update that walkthrough. Repos
without these documentation surfaces, including submodules whose superproject
owns the docs, are exempt, but the HAM audit comment must record any skipped
superproject-doc obligation.

The evidence JSON is a claim, not authority. At closer runtime the predicate
must verify that claim against durable GitHub state:

- the live PR head SHA is the claimed HAM remediation commit;
- the live commit's first parent is exactly the reviewed head;
- the live commit has a non-empty verified GitHub diff;
- the live commit message trailers include `Worker-Class: hammer`,
  `Worker-Ticket: HAM-<n>`, `Closed-By: hammer (adversarial-pipe-mode)`, and a
  `Remediated-Findings: <n> addressed (<b> blocking, <nb> non-blocking)` count;
- the PR timeline contains the claimed audit comment body;
- the matched audit comment author is the verified commit author or an
  allowlisted hammer bot identity, and the eligibility trace records the
  comment `author`, `createdAt`, and `id`;
- the audit comment body names each claimed finding title and changed file;
- the audit comment reports any doc-currency remediation performed, and any
  skipped superproject-doc obligation when the touched schema/module docs live
  outside the PR repository;
- each claimed finding has `addressed: true`; and
- the claimed blocking-finding count matches the blocking-finding count from
  the authoritative final review state.

HAM attests that each mapped finding was resolved; the predicate verifies the
commit, trailers, audit mapping, counts, and non-empty diff, but it does not
semantically prove the code change fixes the reviewer's finding.

Only after those checks pass may the predicate record
`ham_terminal_remediation_validated`. That marker may waive
`stale-review-head`, `verdict-not-settled-success`, `remediation-pending`,
`remediation-state-unknown`, `blocking-findings-present`, and
`blocking-findings-unknown`, `non-blocking-findings-present`, and
`non-blocking-findings-unknown`. It must not waive AMA disabled state, PR lifecycle
or mergeability, CI, branch protection, hard-stop labels, unsupported
fast-merge state, or risk-class policy. When final-hammer cycle exhaustion is
also active, HAM and final-hammer waivers compose by filtering the remaining
reason set in sequence; one waiver path must not discard the other path's
accepted waivers.

## 4.2 Eligibility predicate

Direct AMA closure requires a current-head settled-success review (`Approved`
or `Comment only`), no pending remediation, known-zero structured blocking
findings, and, by default, known-zero structured non-blocking findings.
`roles.adversarial.merge_authority.strict_non_blocking_remediation` defaults to
`true`; setting it to `false` restores the legacy direct-close behavior where
non-blocking findings do not affect settled-success eligibility.

When strict non-blocking remediation is enabled, a settled-success review with
standing structured non-blocking findings is refused with
`non-blocking-findings-present`. A settled-success review whose non-blocking
classification is unavailable is refused with
`non-blocking-findings-unknown`. Current-head `operator-approved` evidence still
bypasses the verdict/finding gate, and validated HAM terminal remediation may
waive the non-blocking reasons after it verifies the HAM commit and audit
comment. Final-hammer review-cycle exhaustion may waive non-blocking reasons
only with current-head operator override, matching the existing verdict and
blocking-finding gate semantics.

## 4.4 Closure convergence predicate

The watcher must not treat `hq dispatch status=succeeded` or the AMA §4.4
audit JSON's `status:"succeeded"` as standalone proof that closure is complete.
Those surfaces are worker/audit observations. The authoritative completion
predicate is a readable session-ledger `build_completions` row for the same
`repo`, `pr_number`, and `signal_kind='merged'`.

If an existing closer dispatch reports a terminal-success state, but the
merged build-completion row is cleanly absent, the watcher records
`unverified-terminal-success`, releases the prior terminal hold, and may
re-dispatch the closer within the normal retry bound only when repo-level merged
producer evidence exists. If the merged-signal read is unknown rather than
cleanly absent — for example the ledger target cannot be resolved, the
`build_completions` surface is unavailable, the repo has no prior merged
producer evidence, or the query fails — the watcher retains the existing closer
hold for that tick. Unknown ledger state is a no-op, not authorization to launch
another closer.

The lookup is not current-head scoped. Agent OS merge capture currently records
the merge commit SHA in `build_completions.head_sha`, while AMA's
`--match-head-commit <reviewedSha>` guard uses the PR head SHA. The stored
producer SHA is exposed as diagnostic evidence, but equality with the reviewed
head is not required for the merged row to settle closer ownership.

The producer for this predicate is Agent OS merge observation after the PR is
seen merged: this repository records owed
`hq dag autowalk-on-merge --repo <repo> --pr <n>` work during watcher lifecycle
sync, and Agent OS owns the session-ledger `build_completions` write. Hosts
without a readable `build_completions` table keep the prior hold semantics
because the watcher cannot prove a clean negative. A readable table without
repo-level merged producer evidence also keeps the prior hold semantics so a
schema-only rollout cannot masquerade as a trustworthy clean negative.

## 4.7 CFG-01 schema

New section under `roles.adversarial.merge_authority`:

```yaml
roles:
  adversarial:
    merge_authority:
      # Master switch. Default off so this lands dark on hosts that
      # haven't been opted in.
      enabled: false
      # Which worker class does the closer dispatch use.
      worker_class: hammer  # enum: codex | claude-code | hammer | gemini
      # Which merge method to use. `rebase` is not supported because
      # AMA requires one canonical landed closing commit for provenance
      # and audit reconciliation; GitHub's rebase path does not produce one.
      merge_method: squash  # enum: squash | merge
      # Default true. Direct AMA close requires the authoritative settled review
      # to report known-zero non-blocking findings. Set false only to restore
      # legacy direct-close behavior.
      strict_non_blocking_remediation: true
      eligibility:
        # Risk classes that may close without operator intervention.
        risk_classes: ["low"]
        # Fast-merge labels remain a separate lane; AMA ignores them
        # unless it explicitly imports the FML head-scoped contract.
        fast_merge_labels:
          - "fast-merge:test-fixtures"
          - "fast-merge:docs"
        # Reviewer family is recorded for audit and defaults to the
        # existing cross-model routing contract, but AMA does not make
        # same-family review a new hard merge gate until the adversarial-
        # review gate docs and tests are updated in the same change.
        reviewer_family_policy: audit_existing_gate_contract
        # Green-CI uses the existing adversarial-review / merge-path
        # check classifier, including SUCCESS, COMPLETED, NEUTRAL,
        # SKIPPED, and the self-gate exclusion. This enum exists only
        # as a documentation mirror; implementations must not fork the
        # classifier into a narrower AMA-only list.
        ci_green_classifier: existingAdversarialMergeClassifier
      branch_protection:
        # Fail-closed branch-protection gate. Operators on GitHub plans
        # with no branch protection may set this false in config.local.yaml
        # to waive only the branch-protection predicate; all other AMA gates
        # still apply. Not env-overridable.
        required: true
        # AMA compares branch protection against the resolved gate
        # context(s) from the adversarial-review contract rather than
        # a hardcoded literal.
        required_gate_context_source: resolveGateStatusContext
```

Supported closer worker classes are `codex`, `claude-code`, `hammer`, and
`gemini`. Closer dispatch must pass the configured value to HQ as
`--worker-class <configured-worker-class>` with `--task-kind merge` and
`--completion-shape decision-only`; provenance must attribute the actual closer
class as `Closed-By: <configured-worker-class>-closer (adversarial-pipe-mode)`,
except HAM terminal-remediation commits, which use the exact
`Closed-By: hammer (adversarial-pipe-mode)` trailer from §1.1.1.
