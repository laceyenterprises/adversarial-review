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
acquire/status/release output exits `0`; an unmet acquire deadline exits `75`
with `acquired:false` and is retryable. Live `mutation-lock-busy` contention
during waiter registration, pruning, or timeout cleanup is a transient acquire
condition: the CLI must retry inside the caller's wait window and, if the
deadline expires, return `75` rather than reclassifying contention as usage.
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
